import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_META_MODEL, ModelCapabilityError, resolveModelBinding, validateModelUse } from '../src/meta/capabilities';
import { assertExecutionCanContinue, cancelExecutionBudget, createExecutionBudget, ExecutionBudgetError,
  markInvocationUnknown, recordInvocationResponse, remainingExecutionBudget, reserveInvocation, reserveToolBatch,
  mergeExecutionBudgets,
  type ExecutionBudgetLimits, type InvocationSpec } from '../src/meta/budget';
import { createMetaClient, metaStatus, MetaError } from '../src/meta/client';
import { plan, observe, type GroundedMediaAsset, type ModelTrace } from '../src/meta';
import { demoFacts, demoObservation, demoProposal, workshopFacts } from '../src/domain/demo';
import { ModelExecution } from '../src/meta/execution';
import { assessCameraFrame } from '../src/camera/meta';
import { createCameraSession } from '../src/camera/engine';
import { cameraWorkflows, cameraSyntheticFacts } from '../src/camera/workflows';

const limits: ExecutionBudgetLimits = { maxInvocations: 3, maxOutputTokens: 12_000, maxKnownTotalTokens: 20_000,
  maxInputBytes: 100_000, maxToolExecutions: 3, maxToolsPerResponse: 2, maxDurationMs: 60_000 };
const invocation = (id: string, overrides: Partial<InvocationSpec> = {}): InvocationSpec => ({ invocationId: id,
  parentInvocationId: null, role: 'camera_observe_decide', route: 'camera_reasoning', model: DEFAULT_META_MODEL,
  contextHash: 'a'.repeat(64), promptVersion: 'offline-prompt-v1', schemaVersion: 'offline-schema-v1', toolVersion: 'none',
  maxOutputTokens: 6000, inputBytes: 1000, ...overrides });
const exhausted = (error: unknown) => error instanceof ExecutionBudgetError && error.code === 'execution_budget_exhausted';

test('only verified route/model/modalities/tools can inherit a Meta adapter contract', () => {
  const camera = resolveModelBinding('camera_reasoning');
  assert.equal(camera.model, DEFAULT_META_MODEL);
  assert.equal(camera.maxOutputTokens, 6000); assert.equal(camera.automaticRetries, 0);
  assert.equal(camera.timeoutMs, 90_000); assert.deepEqual(camera.toolNames, ['read_owned_evidence']);
  assert.equal(validateModelUse({ route: 'planning', modalities: ['text', 'image', 'video'], toolNames: ['check_task_plan'], maxOutputTokens: 20_000 }).model, DEFAULT_META_MODEL);
  for (const model of ['sam-3.1', 'muse-wonder-1.0', 'muse-voice-transcribe-1.0', 'muse-image-1.0', 'muse-spark-1.2', 'arbitrary-model'])
    for (const route of ['camera_reasoning', 'observation', 'planning'] as const)
      assert.throws(() => resolveModelBinding(route, model), error => error instanceof ModelCapabilityError);
  assert.throws(() => validateModelUse({ route: 'camera_reasoning', modalities: ['video'] }), error => error instanceof ModelCapabilityError);
  assert.throws(() => validateModelUse({ route: 'observation', toolNames: ['check_task_plan'] }), error => error instanceof ModelCapabilityError);
  assert.throws(() => validateModelUse({ route: 'planning', toolNames: ['overwrite_facts'] }), error => error instanceof ModelCapabilityError);
  assert.throws(() => validateModelUse({ route: 'camera_reasoning', maxOutputTokens: 6001 }), error => error instanceof ModelCapabilityError);
  assert(Object.isFrozen(camera) && Object.isFrozen(camera.inputModalities) && Object.isFrozen(camera.toolNames));
});

test('an actual POST reservation is durable and idempotent; trace callbacks cannot spend another allowance', () => {
  const original = createExecutionBudget('run', limits, 1000);
  const first = reserveInvocation(original, invocation('turn-1'), 1001);
  assert.equal(first.reserved, true); assert.equal(original.invocations.length, 0);
  const restored = JSON.parse(JSON.stringify(first.state));
  const repeated = reserveInvocation(restored, invocation('turn-1'), 1002);
  assert.equal(repeated.reserved, false, 'False means no repeat POST is permitted.');
  assert.equal(repeated.state.invocations.length, 1);
  assert.equal(remainingExecutionBudget(repeated.state, 1002).outputTokens, 6000);
  assert.throws(() => reserveInvocation(restored, invocation('turn-1', { contextHash: 'b'.repeat(64) }), 1002),
    error => error instanceof ExecutionBudgetError && error.code === 'invocation_conflict');
  assert.throws(() => reserveInvocation(restored, invocation('turn-1', { maxOutputTokens: 1000 }), 1002),
    error => error instanceof ExecutionBudgetError && error.code === 'invocation_conflict');
});

test('child roles and continuations consume the same call, output and input-byte allowances', () => {
  let state = createExecutionBudget('shared', limits, 0);
  state = reserveInvocation(state, invocation('parent'), 1).state;
  assert.throws(() => reserveInvocation(state, invocation('premature-child', { parentInvocationId: 'parent' }), 2),
    error => error instanceof ExecutionBudgetError && error.code === 'invalid_execution_budget');
  state = recordInvocationResponse(state, 'parent', 'response-parent', { total_tokens: 100 }, 2);
  state = reserveInvocation(state, invocation('child', { role: 'selective_critique', parentInvocationId: 'parent' }), 3).state;
  assert.equal(remainingExecutionBudget(state, 3).outputTokens, 0);
  assert.throws(() => reserveInvocation(state, invocation('child-fresh-budget', { parentInvocationId: 'parent', maxOutputTokens: 1 }), 4), exhausted);
  let calls = createExecutionBudget('calls', { ...limits, maxInvocations: 1 }, 0);
  calls = reserveInvocation(calls, invocation('one'), 1).state;
  assert.throws(() => reserveInvocation(calls, invocation('two', { maxOutputTokens: 1 }), 2), exhausted);
  const bytes = createExecutionBudget('bytes', { ...limits, maxInputBytes: 999 }, 0);
  assert.throws(() => reserveInvocation(bytes, invocation('oversized'), 1), exhausted);
  assert.equal(bytes.invocations.length, 0);
});

test('response accounting deduplicates usage by identity and preserves partial/late known tokens', () => {
  let state = reserveInvocation(createExecutionBudget('usage', limits, 0), invocation('one'), 1).state;
  state = recordInvocationResponse(state, 'one', 'response-one', { total_tokens: 120, credential: 'must-not-be-retained' }, 2);
  state = recordInvocationResponse(state, 'one', 'response-one', { input_tokens: 100, output_tokens: 20, total_tokens: 120 }, 3);
  state = recordInvocationResponse(state, 'one', 'response-one', undefined, 4);
  assert.equal(remainingExecutionBudget(state, 4).knownTotalTokens, limits.maxKnownTotalTokens - 120);
  assert.deepEqual(state.invocations[0].usage, { inputTokens: 100, outputTokens: 20, totalTokens: 120 });
  assert(!JSON.stringify(state).includes('credential'));
  assert.equal(state.invocations[0].completedAt, 2);
  assert.throws(() => recordInvocationResponse(state, 'one', 'another-response', { total_tokens: 1 }, 5),
    error => error instanceof ExecutionBudgetError && error.code === 'invocation_conflict');
  const two = reserveInvocation(state, invocation('two', { maxOutputTokens: 1 }), 5).state;
  assert.throws(() => recordInvocationResponse(two, 'two', 'response-one', { total_tokens: 120 }, 6),
    error => error instanceof ExecutionBudgetError && error.code === 'invocation_conflict');
  const cancelled = cancelExecutionBudget(two, 6);
  const late = recordInvocationResponse(cancelled, 'two', 'response-two', { total_tokens: 9 }, 90_000);
  assert.equal(late.cancelledAt, 6); assert.equal(late.invocations[1].responseId, 'response-two');
});

test('unknown interrupted calls retain reserved allowance and cannot be continued or blindly retried', () => {
  let state = reserveInvocation(createExecutionBudget('unknown', limits, 0), invocation('uncertain'), 1).state;
  state = markInvocationUnknown(state, 'uncertain', 'timeout', 2);
  assert.equal(state.invocations[0].unknownReason, 'timeout');
  assert.equal(remainingExecutionBudget(state, 2).unknownInvocations, 1);
  assert.equal(remainingExecutionBudget(state, 2).outputTokens, 6000);
  assert.equal(reserveInvocation(state, invocation('uncertain'), 3).reserved, false);
  assert.throws(() => reserveInvocation(state, invocation('retry-child', { parentInvocationId: 'uncertain' }), 3),
    error => error instanceof ExecutionBudgetError && error.code === 'invalid_execution_budget');
  state = recordInvocationResponse(state, 'uncertain', 'late-known-response', { total_tokens: 30 }, 70_000);
  assert.equal(state.invocations[0].status, 'responded'); assert.equal(state.invocations[0].unknownReason, 'timeout');
  assert.equal(remainingExecutionBudget(state, 70_000).unknownInvocations, 0);
});

test('deadline/cancellation/observed usage stop new calls while the paid over-limit response remains auditable', () => {
  const state = createExecutionBudget('stops', limits, 0);
  assert.throws(() => reserveInvocation(state, invocation('late'), 60_000), exhausted);
  const cancelled = cancelExecutionBudget(state, 1);
  assert.throws(() => reserveInvocation(cancelled, invocation('cancelled'), 2), error => error instanceof ExecutionBudgetError && error.code === 'execution_cancelled');
  let used = reserveInvocation(state, invocation('known-usage'), 1).state;
  used = recordInvocationResponse(used, 'known-usage', 'paid-over-limit', { total_tokens: 20_001 }, 2);
  assert.equal(used.invocations[0].responseId, 'paid-over-limit'); assert.equal(used.invocations[0].usage?.totalTokens, 20_001);
  assert.throws(() => reserveInvocation(used, invocation('after-limit', { maxOutputTokens: 1 }), 3), exhausted);
  assert.throws(() => assertExecutionCanContinue(used, 3), exhausted);
  let output = reserveInvocation(state, invocation('bad-output', { maxOutputTokens: 10 }), 1).state;
  output = recordInvocationResponse(output, 'bad-output', 'provider-over-output', { output_tokens: 11 }, 2);
  assert.throws(() => reserveInvocation(output, invocation('after-output'), 3), exhausted);
});

test('complete tool batches are admitted atomically with per-response and shared limits', () => {
  let state = createExecutionBudget('tools', limits, 0);
  const planning = invocation('planner', { route: 'planning', role: 'plan', toolVersion: 'checker-v1' });
  state = reserveInvocation(state, planning, 1).state;
  state = recordInvocationResponse(state, 'planner', 'planner-response', { total_tokens: 100 }, 2);
  const call = (callId: string) => ({ callId, toolName: 'check_task_plan', argumentsHash: 'c'.repeat(64) });
  assert.throws(() => reserveToolBatch(state, 'planner', 'planner-response', [call('a'), call('b'), call('c')], 3), exhausted);
  assert.equal(state.tools.length, 0, 'An excessive batch cannot partially execute.');
  const accepted = reserveToolBatch(state, 'planner', 'planner-response', [call('a'), call('b')], 3);
  assert.deepEqual(accepted.executableCallIds, ['a', 'b']);
  const duplicate = reserveToolBatch(accepted.state, 'planner', 'planner-response', [call('a'), call('b')], 4);
  assert.deepEqual(duplicate.executableCallIds, []);
  assert.equal(duplicate.state.tools.length, 2);
  assert.throws(() => reserveToolBatch(accepted.state, 'planner', 'planner-response', [{ ...call('a'), argumentsHash: 'd'.repeat(64) }], 4),
    error => error instanceof ExecutionBudgetError && error.code === 'tool_conflict');
  assert.throws(() => reserveToolBatch(state, 'planner', 'planner-response', [call('a'), call('a')], 3),
    error => error instanceof ExecutionBudgetError && error.code === 'tool_conflict');
  let continued = reserveInvocation(accepted.state, invocation('continuation', { ...planning, invocationId: 'continuation', parentInvocationId: 'planner' }), 4).state;
  continued = recordInvocationResponse(continued, 'continuation', 'second-response', { total_tokens: 100 }, 5);
  assert.throws(() => reserveToolBatch(continued, 'continuation', 'second-response', [call('c'), call('d')], 6), exhausted);
});

test('camera decisions cannot acquire planner tools and malformed restored state fails closed', () => {
  let camera = reserveInvocation(createExecutionBudget('camera', limits, 0), invocation('camera-turn'), 1).state;
  camera = recordInvocationResponse(camera, 'camera-turn', 'camera-response', { total_tokens: 5 }, 2);
  assert.throws(() => reserveToolBatch(camera, 'camera-turn', 'camera-response', [{ callId: 'bad', toolName: 'check_task_plan', argumentsHash: 'a'.repeat(64) }], 3),
    error => error instanceof ModelCapabilityError);
  for (const malformed of [
    { ...camera, version: 'unrecorded' },
    { ...camera, deadlineAt: 999_999_999 },
    { ...camera, invocations: [{ ...camera.invocations[0], inputBytes: -1 }] },
    { ...camera, invocations: [camera.invocations[0], camera.invocations[0]] },
  ]) assert.throws(() => remainingExecutionBudget(malformed as typeof camera, 3), error => error instanceof ExecutionBudgetError);
});

test('merging late snapshots preserves new reservations, known usage, tools and earliest cancellation', () => {
  const initial = createExecutionBudget('merge-run', limits, 0);
  let previous = reserveInvocation(initial, invocation('old'), 1).state;
  const stale = structuredClone(previous);
  previous = markInvocationUnknown(previous, 'old', 'interrupted', 2);
  previous = reserveInvocation(previous, invocation('new'), 3).state;
  previous = recordInvocationResponse(previous, 'new', 'response-new', { total_tokens: 50 }, 4);
  previous = cancelExecutionBudget(previous, 5);
  const late = recordInvocationResponse(stale, 'old', 'response-old', { input_tokens: 10, output_tokens: 2, total_tokens: 12 }, 6);
  const merged = mergeExecutionBudgets(previous, late);
  assert.equal(merged.invocations.length, 2); assert.equal(merged.cancelledAt, 5);
  assert.deepEqual(merged.invocations.map(item => [item.invocationId, item.responseId, item.status]), [
    ['old', 'response-old', 'responded'], ['new', 'response-new', 'responded'],
  ]);
  assert.equal(merged.invocations[0].unknownReason, 'interrupted');
  assert.equal(remainingExecutionBudget(merged, 6).knownTotalTokens, limits.maxKnownTotalTokens - 62);
  assert.deepEqual(mergeExecutionBudgets(merged, stale), merged, 'A stale callback cannot erase later outcomes.');
  assert.throws(() => mergeExecutionBudgets(merged, { ...late, runId: 'another-run' }), error => error instanceof ExecutionBudgetError && error.code === 'invocation_conflict');
  assert.throws(() => mergeExecutionBudgets(merged, { ...late, limits: { ...limits, maxOutputTokens: 12_001 } }), error => error instanceof ExecutionBudgetError && error.code === 'invocation_conflict');
  assert.throws(() => mergeExecutionBudgets(merged, recordInvocationResponse(stale, 'old', 'conflicting-response', {}, 6)), error => error instanceof ExecutionBudgetError && error.code === 'invocation_conflict');

  const planning = invocation('plan', { route: 'planning', role: 'plan', toolVersion: 'checks' });
  let toolBase = reserveInvocation(initial, planning, 1).state;
  toolBase = recordInvocationResponse(toolBase, 'plan', 'tool-response', { total_tokens: 5 }, 2);
  const call = (callId: string) => ({ callId, toolName: 'check_task_plan', argumentsHash: 'c'.repeat(64) });
  const a = reserveToolBatch(toolBase, 'plan', 'tool-response', [call('a')], 3).state;
  const b = reserveToolBatch(toolBase, 'plan', 'tool-response', [call('b')], 4).state;
  assert.deepEqual(mergeExecutionBudgets(a, b).tools.map(tool => tool.callId), ['a', 'b']);
});

test('merged stale reservations retain all started work even if oversubscribed and block every later reservation', () => {
  const initial = createExecutionBudget('overcommit', { ...limits, maxInvocations: 1, maxOutputTokens: 6000 }, 0);
  let first = reserveInvocation(initial, invocation('one'), 1).state;
  let second = reserveInvocation(initial, invocation('two'), 2).state;
  first = recordInvocationResponse(first, 'one', 'response-one', { total_tokens: 10 }, 3);
  second = recordInvocationResponse(second, 'two', 'response-two', { total_tokens: 20 }, 4);
  const merged = mergeExecutionBudgets(first, second);
  assert.equal(merged.invocations.length, 2, 'An already-paid response is not discarded to make a cap appear satisfied.');
  assert.equal(remainingExecutionBudget(merged, 4).knownTotalTokens, limits.maxKnownTotalTokens - 30);
  assert.throws(() => assertExecutionCanContinue(merged, 4), exhausted);
  assert.throws(() => reserveInvocation(merged, invocation('three'), 5), exhausted);
});

async function offlineProvider(run: (client: ReturnType<typeof createMetaClient>) => Promise<void>) {
  const previousKey = process.env.MODEL_API_KEY, previousModel = process.env.META_MODEL;
  process.env.MODEL_API_KEY = 'offline-execution-fixture-no-credential';
  delete process.env.META_MODEL;
  const client = createMetaClient();
  const create = mock.method(client.responses, 'create', (() => { throw new Error('Unexpected offline generation'); }) as typeof client.responses.create);
  try { await run(client); }
  finally {
    create.mock.restore();
    if (previousKey === undefined) delete process.env.MODEL_API_KEY; else process.env.MODEL_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.META_MODEL; else process.env.META_MODEL = previousModel;
  }
}
const finalReply = (output: unknown) => ({ id: 'execution-paid-response', model: DEFAULT_META_MODEL, status: 'completed', usage: { total_tokens: 5 },
  output: [{ type: 'message', role: 'assistant', id: 'execution-message', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] });
const toolReply = (count = 1) => ({ id: 'execution-paid-tools', model: DEFAULT_META_MODEL, status: 'completed', usage: { total_tokens: 5 },
  output: Array.from({ length: count }, (_, index) => ({ type: 'function_call', id: `execution-function-${index}`, call_id: `execution-call-${index}`,
    name: 'check_task_plan', arguments: JSON.stringify(demoProposal), status: 'completed' })) });
const planInput = { goal: 'Offline execution-bound model integration', facts: demoFacts, observation: null, parent: null, feedback: null };

test('the actual planner reserves and persists once per POST despite repeated trace checkpoints', async () => {
  await offlineProvider(async client => {
    const events: string[] = [], traces: ModelTrace[] = [];
    const generate = mock.method(client.responses, 'create', (async () => { events.push('post'); return finalReply(demoProposal); }) as unknown as typeof client.responses.create);
    try {
      const result = await plan({ ...planInput, execution: { budget: createExecutionBudget('job', limits),
        onBudget: async (state, checkpoint) => { events.push(checkpoint); assert.equal(state.invocations.length, checkpoint === 'preflight' ? 0 : 1); } },
        onTrace: async trace => { traces.push(trace); events.push('trace'); } });
      assert.equal(generate.mock.callCount(), 1);
      assert.equal(events.filter(event => event === 'reserve').length, 1);
      assert(events.indexOf('reserve') < events.indexOf('post'));
      assert.equal(events[events.indexOf('post') - 1], 'trace', 'The final state fence finishes after reservation and before POST.');
      assert(traces.length > 2);
      assert.equal(result.trace.executionBudget?.invocations.length, 1);
      assert.equal(result.trace.executionBudget?.invocations[0].responseId, 'execution-paid-response');
      assert.equal(result.trace.modelInvocationId, result.trace.executionBudget?.invocations[0].invocationId);
    } finally { generate.mock.restore(); }
  });
});

test('a planner continuation cannot silently acquire a fresh budget after its first paid response', async () => {
  await offlineProvider(async client => {
    const generate = mock.method(client.responses, 'create', (async () => toolReply()) as unknown as typeof client.responses.create);
    try {
      await assert.rejects(plan({ ...planInput, execution: { budget: createExecutionBudget('one-post-job', { ...limits, maxInvocations: 1 }) } }), (error: unknown) => {
        assert(error instanceof MetaError); assert.equal(error.code, 'execution_budget_exhausted');
        const trace = error.trace as ModelTrace;
        assert.deepEqual(trace.responseIds, ['execution-paid-tools']);
        assert.deepEqual(trace.usage, [{ total_tokens: 5 }]);
        assert.equal(trace.executionBudget?.invocations.length, 1);
        assert.equal(trace.toolExecutions?.length, 1);
        assert.equal(trace.modelInvocationId, trace.executionBudget?.invocations[0].invocationId);
        return true;
      });
      assert.equal(generate.mock.callCount(), 1);
    } finally { generate.mock.restore(); }
  });
});

test('an excessive provider tool batch is rejected before the first checker executes', async () => {
  await offlineProvider(async client => {
    const generate = mock.method(client.responses, 'create', (async () => toolReply(5)) as unknown as typeof client.responses.create);
    try {
      await assert.rejects(plan(planInput), (error: unknown) => {
        assert(error instanceof MetaError); assert.equal(error.code, 'execution_budget_exhausted');
        const trace = error.trace as ModelTrace;
        assert.equal(trace.toolExecutions?.length, 0); assert.equal(trace.plannerChecks?.toolChecks.length, 0);
        assert.equal(trace.executionBudget?.tools.length, 0); assert.deepEqual(trace.responseIds, ['execution-paid-tools']);
        return true;
      });
      assert.equal(generate.mock.callCount(), 1);
    } finally { generate.mock.restore(); }
  });
});

test('durable reservation cancellation prevents POST and a failed post-response sink retains paid identity and usage', async () => {
  await offlineProvider(async client => {
    const generate = mock.method(client.responses, 'create', (async () => finalReply(demoProposal)) as unknown as typeof client.responses.create);
    try {
      await assert.rejects(plan({ ...planInput, execution: { budget: createExecutionBudget('cancelled-job', limits),
        onBudget: async (state, checkpoint) => checkpoint === 'reserve' ? cancelExecutionBudget(state) : undefined } }),
      (error: unknown) => error instanceof MetaError && error.code === 'execution_cancelled');
      assert.equal(generate.mock.callCount(), 0);
      await assert.rejects(plan({ ...planInput, execution: { budget: createExecutionBudget('sink-failure-job', limits),
        onBudget: async (_state, checkpoint) => { if (checkpoint === 'response') throw new MetaError('Offline durable sink interrupted.', 'cancelled'); } } }), (error: unknown) => {
        assert(error instanceof MetaError); const trace = error.trace as ModelTrace;
        assert.equal(trace.providerResponseId, 'execution-paid-response'); assert.deepEqual(trace.usage, [{ total_tokens: 5 }]);
        assert.equal(trace.executionBudget?.invocations[0].status, 'responded');
        return true;
      });
      assert.equal(generate.mock.callCount(), 1);
    } finally { generate.mock.restore(); }
  });
});

test('the actual camera request shares its supplied budget and keeps rejected paid output auditable', async () => {
  await offlineProvider(async client => {
    const workflow = cameraWorkflows[0], now = new Date().toISOString();
    const session = createCameraSession(workflow, cameraSyntheticFacts[workflow.id], now);
    const filename = new URL('../docs/examples/camera-harness_routing.png', import.meta.url);
    const bytes = await readFile(filename);
    const generate = mock.method(client.responses, 'create', (async () => finalReply({ invalid: 'not a decision' })) as unknown as typeof client.responses.create);
    const checkpoints: string[] = [];
    try {
      await assert.rejects(assessCameraFrame({ runId: 'camera-run', turnId: 'camera-turn', workflow, session, framePath: filename.pathname,
        frame: { id: 'frame', sha256: createHash('sha256').update(bytes).digest('hex'), purpose: 'before', source: 'upload', capturedAt: null,
          receivedAt: now, stepId: session.currentStepId!, revision: session.revision }, operatorNote: '',
        execution: { budget: createExecutionBudget('camera-run', limits), onBudget: async (_state, checkpoint) => { checkpoints.push(checkpoint); } } }), (error: unknown) => {
        assert(error instanceof MetaError); assert.equal(error.code, 'invalid_output'); const trace = error.trace as ModelTrace;
        assert.equal(trace.providerResponseId, 'execution-paid-response'); assert.equal(trace.executionBudget?.runId, 'camera-run');
        assert.equal(trace.executionBudget?.invocations.length, 1); assert.equal(trace.executionBudget?.invocations[0].responseId, trace.providerResponseId);
        return true;
      });
      assert.deepEqual(checkpoints, ['reserve', 'response']); assert.equal(generate.mock.callCount(), 1);
    } finally { generate.mock.restore(); }
  });
});

test('incompatible configured models disable readiness and fail before a generation can start', async () => {
  await offlineProvider(async client => {
    const generate = mock.method(client.responses, 'create', (() => { throw new Error('No incompatible model may be called'); }) as typeof client.responses.create);
    process.env.META_MODEL = 'sam-3.1';
    try {
      const status = metaStatus(); assert.equal(status.configured, false); assert.match(status.configurationError!, /no validated/);
      await assert.rejects(plan(planInput), error => error instanceof MetaError && error.code === 'unsupported_model_binding');
      assert.equal(generate.mock.callCount(), 0);
    } finally { generate.mock.restore(); }
  });
});

test('a shorter configured timeout is honored and invalid timeout configuration fails before POST', async () => {
  const previous = process.env.JOB_TIMEOUT_MS;
  try {
    await offlineProvider(async client => {
      const timeouts: unknown[] = [];
      const generate = mock.method(client.responses, 'create', (async (_body: unknown, options: { timeout?: number } | undefined) => {
        timeouts.push(options?.timeout); return finalReply(demoProposal);
      }) as unknown as typeof client.responses.create);
      try {
        process.env.JOB_TIMEOUT_MS = '2500';
        await plan(planInput);
        assert.deepEqual(timeouts, [2500]);
        for (const value of ['0', '-1', 'NaN', '1.2']) {
          process.env.JOB_TIMEOUT_MS = value;
          await assert.rejects(plan(planInput), error => error instanceof MetaError && error.code === 'invalid_model_configuration');
        }
        assert.equal(generate.mock.callCount(), 1);
      } finally { generate.mock.restore(); }
    });
  } finally { if (previous === undefined) delete process.env.JOB_TIMEOUT_MS; else process.env.JOB_TIMEOUT_MS = previous; }
});

async function videoFixtures(run: (assets: GroundedMediaAsset[]) => Promise<void>) {
  const folder = await mkdtemp(path.join(tmpdir(), 'countershot-media-preflight-'));
  try {
    const assets: GroundedMediaAsset[] = [];
    for (const id of ['first', 'second']) {
      // Byte-identity fixture only. Runtime media decoding is tested at ingestion.
      const bytes = Buffer.from(`synthetic offline canonical video bytes: ${id}`), file = path.join(folder, `${id}.mp4`);
      await writeFile(file, bytes);
      assets.push({ id, path: file, mime: 'video/mp4', sha256: createHash('sha256').update(bytes).digest('hex'),
        byteLength: bytes.length, durationMs: 1000, createdAt: '2026-11-03T00:00:00.000Z' });
    }
    await run(assets);
  } finally { await rm(folder, { recursive: true, force: true }); }
}

test('planning and observation block expired, cancelled and exhausted allowances before any media upload', async () => {
  await videoFixtures(async assets => offlineProvider(async client => {
    let uploads = 0, generations = 0;
    const upload = mock.method(client.files, 'create', (async () => { uploads++; return { id: 'must-not-upload' }; }) as unknown as typeof client.files.create);
    const generate = mock.method(client.responses, 'create', (async () => { generations++; return finalReply(demoProposal); }) as unknown as typeof client.responses.create);
    try {
      for (const operation of ['plan', 'observe'] as const) for (const condition of ['expired', 'cancelled', 'calls', 'output', 'bytes', 'durable_cancel'] as const) {
        const now = Date.now(), options = { ...limits, maxOutputTokens: condition === 'output' ? 9999 : 20_000 };
        let budget = createExecutionBudget(`${operation}-${condition}`, options, condition === 'expired' ? now - options.maxDurationMs - 1 : now);
        if (condition === 'cancelled') budget = cancelExecutionBudget(budget, now);
        if (condition === 'calls') {
          budget = createExecutionBudget(`${operation}-${condition}`, { ...options, maxInvocations: 1 }, now);
          budget = reserveInvocation(budget, invocation('existing-call'), now).state;
        }
        if (condition === 'bytes') budget = reserveInvocation(budget, invocation('existing-bytes', { inputBytes: options.maxInputBytes }), now).state;
        const execution = { budget, onBudget: async (state: typeof budget, checkpoint: string) => condition === 'durable_cancel' && checkpoint === 'preflight' ? cancelExecutionBudget(state) : undefined };
        await assert.rejects(operation === 'plan'
          ? plan({ ...planInput, sourceAssets: assets, execution })
          : observe({ goal: 'Offline pre-upload budget fence', notes: '', assets, execution }),
        error => error instanceof MetaError && ['execution_budget_exhausted', 'execution_cancelled'].includes(error.code), `${operation}/${condition}`);
      }
      await assert.rejects(plan({ ...planInput, facts: workshopFacts, sourceAssets: assets,
        execution: { budget: createExecutionBudget('workshop-full-output-allowance', { ...limits, maxOutputTokens: 15_000 }) } }),
      error => error instanceof MetaError && error.code === 'execution_budget_exhausted');
      assert.equal(uploads, 0); assert.equal(generations, 0);
    } finally { upload.mock.restore(); generate.mock.restore(); }
  }));
});

test('expiry between video uploads retains the first file ID and shares the original default or durable deadline', async () => {
  await videoFixtures(async assets => offlineProvider(async client => {
    for (const operation of ['plan', 'observe'] as const) for (const supplied of [false, true]) {
      const start = 1_000_000; let clock = start, uploads = 0, generations = 0;
      const duration = supplied ? 10 : operation === 'plan' ? 8 * 60_000 : 2 * 60_000;
      const time = mock.method(Date, 'now', () => clock);
      const upload = mock.method(client.files, 'create', (async () => { uploads++; clock = start + duration + 1; return { id: 'first-upload-retained' }; }) as unknown as typeof client.files.create);
      const generate = mock.method(client.responses, 'create', (async () => { generations++; return finalReply(demoProposal); }) as unknown as typeof client.responses.create);
      try {
        const execution = supplied ? { budget: createExecutionBudget(`${operation}-shared`, { ...limits, maxOutputTokens: 20_000, maxDurationMs: duration }, start) } : undefined;
        await assert.rejects(operation === 'plan'
          ? plan({ ...planInput, sourceAssets: assets, execution })
          : observe({ goal: 'Offline partial upload deadline', notes: '', assets, execution }), (error: unknown) => {
          assert(error instanceof MetaError); assert.equal(error.code, 'execution_budget_exhausted');
          const trace = error.trace as ModelTrace;
          assert.deepEqual(trace.uploadedFileIds, ['first-upload-retained']);
          assert.equal(trace.executionBudget?.createdAt, start); assert.equal(trace.executionBudget?.deadlineAt, start + duration);
          assert.equal(trace.executionBudget?.invocations.length, 0, 'Media checkpoints did not reserve fake model invocations.');
          return true;
        });
        assert.equal(uploads, 1); assert.equal(generations, 0);
      } finally { upload.mock.restore(); generate.mock.restore(); time.mock.restore(); }
    }
  }));
});

test('crossing the deadline between the final assertion and timeout calculation never grants a one-millisecond POST', async () => {
  const budget = createExecutionBudget('deadline-edge', { ...limits, maxDurationMs: 10 }, 1000);
  const controller = new ModelExecution({ budget }, { runId: budget.runId, limits: budget.limits });
  let ticks = 0, posts = 0;
  const time = mock.method(Date, 'now', () => ++ticks === 1 ? 1001 : ticks === 2 ? 1009 : 1010);
  try {
    await assert.rejects(controller.request({ prefix: 'edge', role: 'camera_observe_decide', route: 'camera_reasoning',
      payload: { model: DEFAULT_META_MODEL, max_output_tokens: 1000, input: 'Offline deadline-edge fixture' },
      promptVersion: 'fixture', schemaVersion: 'fixture', toolVersion: 'none', beforePost: async () => {},
      send: async () => { posts++; throw new Error('No request may start after expiry'); } }),
    error => error instanceof MetaError && error.code === 'execution_budget_exhausted');
    assert.equal(posts, 0);
  } finally { time.mock.restore(); }
});

test('video upload SDK calls honor the shared remaining deadline, shorter configured timeout and zero retries', async () => {
  const previousTimeout = process.env.JOB_TIMEOUT_MS;
  try {
    await videoFixtures(async assets => offlineProvider(async client => {
      for (const operation of ['plan', 'observe_canonical', 'observe_raw'] as const) for (const configured of [5000, 250]) {
        const start = 10_000_000, duration = 1234;
        const time = mock.method(Date, 'now', () => start);
        process.env.JOB_TIMEOUT_MS = String(configured);
        let uploads = 0, generations = 0;
        const upload = mock.method(client.files, 'create', (async (body: { file: unknown }, options: { timeout?: number; maxRetries?: number } | undefined) => {
          uploads++; assert.equal(options?.timeout, Math.min(duration, configured)); assert.equal(options?.maxRetries, 0);
          const file = body.file as { arrayBuffer?: () => Promise<ArrayBuffer>; [Symbol.asyncIterator]?: () => AsyncIterator<Buffer> };
          let bytes: Buffer;
          if (file.arrayBuffer) bytes = Buffer.from(await file.arrayBuffer());
          else {
            const chunks: Buffer[] = [];
            for await (const chunk of file as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
            bytes = Buffer.concat(chunks);
          }
          assert.equal(createHash('sha256').update(bytes).digest('hex'), assets[0].sha256);
          return { id: `timed-upload-${operation}-${configured}` };
        }) as unknown as typeof client.files.create);
        const generate = mock.method(client.responses, 'create', (async () => { generations++; return finalReply(operation === 'plan' ? demoProposal : demoObservation); }) as unknown as typeof client.responses.create);
        try {
          const execution = { budget: createExecutionBudget(`timed-${operation}-${configured}`, { ...limits, maxOutputTokens: 20_000, maxDurationMs: duration }, start) };
          if (operation === 'plan') await plan({ ...planInput, sourceAssets: [assets[0]], execution });
          else await observe({ goal: 'Offline upload timeout integration', notes: '',
            assets: operation === 'observe_raw' ? [{ id: assets[0].id, path: assets[0].path, mime: assets[0].mime }] : [assets[0]], execution });
          assert.equal(uploads, 1); assert.equal(generations, 1);
        } finally { upload.mock.restore(); generate.mock.restore(); time.mock.restore(); }
      }
    }));
  } finally { if (previousTimeout === undefined) delete process.env.JOB_TIMEOUT_MS; else process.env.JOB_TIMEOUT_MS = previousTimeout; }
});

test('missing or invalid outbound output-token caps fail before reservation, final fence or SDK send', async () => {
  for (const maxOutputTokens of [undefined, null, 0, -1, 1.5]) {
    const budget = createExecutionBudget('explicit-output-limit', limits);
    const controller = new ModelExecution({ budget }, { runId: budget.runId, limits: budget.limits });
    let fences = 0, posts = 0;
    await assert.rejects(controller.request({ prefix: 'uncapped', role: 'camera_observe_decide', route: 'camera_reasoning',
      payload: { model: DEFAULT_META_MODEL, max_output_tokens: maxOutputTokens, input: 'Offline unbounded-output refusal fixture' },
      promptVersion: 'fixture', schemaVersion: 'fixture', toolVersion: 'none', beforePost: async () => { fences++; },
      send: async () => { posts++; throw new Error('An unbounded request must not be sent'); } }),
    error => error instanceof MetaError && error.code === 'invalid_execution_budget');
    assert.equal(controller.snapshot().invocations.length, 0); assert.equal(fences, 0); assert.equal(posts, 0);
  }
});
