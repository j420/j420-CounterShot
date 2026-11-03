import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import OpenAI from 'openai';
import { NextRequest } from 'next/server';
import type { CameraAssessment, CameraSession } from '../../src/camera/schema';
import type { CameraAssessor, StoredCameraSession } from '../../src/camera/server';
import type { CameraIntakeResponse, CameraIntakeWire } from '../../src/camera/intake-contract';
import type { ModelTrace } from '../../src/meta';

assert.ok(process.env.DATA_ROOT?.startsWith(path.join(os.tmpdir(), 'countershot-camera-prerequisite-')));
assert.ok(realpathSync(process.env.DATA_ROOT!).startsWith(realpathSync(os.tmpdir()) + path.sep));
assert.equal(process.env.DATABASE_PATH, path.join(process.env.DATA_ROOT!, 'test.sqlite'));
assert.equal(process.env.ASSET_ROOT, path.join(process.env.DATA_ROOT!, 'assets'));
process.env.MODEL_API_KEY = 'offline-prerequisite-fixture-key';
delete process.env.APP_ACCESS_CODE;
delete process.env.APP_PUBLIC_ORIGIN;
delete process.env.PUBLIC_API_ORIGIN;

const store = await import('../../src/storage/db');
const camera = await import('../../src/camera/server');
const { cameraWorkflow } = await import('../../src/camera/workflows');
const { GET: listRoute, POST: createRoute } = await import('../../app/api/camera/sessions/route');
const { PATCH: patchRoute } = await import('../../app/api/camera/sessions/[id]/route');
const { POST: intakeRoute } = await import('../../app/api/camera/intakes/route');
type State = ReturnType<typeof camera.cameraState>;

const run = promisify(execFile), root = process.env.DATA_ROOT!;
const scenario = process.argv[2], stranger = 'offline-prerequisite-stranger';
let browser = 'offline-prerequisite-owner', providerCalls = 0, frameAssessments = 0;
const workflow = cameraWorkflow('harness_routing')!;
const blue = path.join(root, 'blue.png'), red = path.join(root, 'red.png');
for (const [color, output] of [['blue', blue], ['red', red]])
  await run('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', `color=c=${color}:s=32x32`, '-frames:v', '1', '-threads', '1', output], { timeout: 10_000 });
const image = await readFile(blue), afterImage = await readFile(red);

const result = (): CameraIntakeWire => ({
  summary: 'Synthetic camera-prerequisite integration scene.', frameQuality: 'clear', workflowId: workflow.id,
  workflowReason: 'The shown labels and visible written reference support this synthetic harness workflow.',
  workflowEvidenceObservationIds: ['labels'],
  observations: [{ id: 'labels', label: 'Synthetic visible labels', detail: 'The fixture contains declared labels A and B.',
    box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }],
  unknowns: ['Power isolation, actual cable limits and operator resources remain unconfirmed.'], viewRequest: null,
  factDrafts: [{ factKey: 'branch_labels', value: 'Trunk A; destination B', evidenceObservationIds: ['labels'] }],
});
const provider = mock.method(OpenAI.prototype, 'post', ((_url: string, options: Record<string, unknown>) => {
  assert.equal(_url, '/responses', 'All SDK work in this fixture must stay on the mocked Responses endpoint.');
  providerCalls++;
  const response = Promise.resolve(options).then(resolved => {
    const body = resolved.body as Record<string, any>;
    assert.equal(body.model, 'muse-spark-1.3');
    assert.equal(body.tools, undefined);
    const context = JSON.parse(body.input[0].content.find((item: { type: string }) => item.type === 'input_text').text);
    const durable = store.get<{ executionBudget: { invocations: { status: string }[] } }>('camera_intakes', context.runId);
    assert.ok(durable?.executionBudget.invocations.some(invocation => invocation.status === 'reserved'));
    return { id: `resp_prerequisite_${providerCalls}`, model: 'muse-spark-1.3', status: 'completed',
      usage: { input_tokens: 14, output_tokens: 3, total_tokens: 17 },
      output: [{ type: 'message', role: 'assistant', id: `message-${providerCalls}`, status: 'completed',
        content: [{ type: 'output_text', text: JSON.stringify(result()) }] }] };
  });
  return { _thenUnwrap: (transform: (value: unknown) => unknown) => response.then(transform) };
}) as unknown as typeof OpenAI.prototype.post);

function request(url: string, method = 'GET', body?: unknown, owner: string | null = browser) {
  return new NextRequest(`http://localhost${url}`, { method,
    headers: { ...(owner ? { cookie: `countershot_session=${owner}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
function capture(owner: string | null = browser) {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(image)], 'synthetic-scene.png', { type: 'image/png' }));
  form.set('operationId', randomUUID()); form.set('source', 'upload'); form.set('capturedAt', '');
  form.set('goal', 'Route the labelled synthetic harness.'); form.set('context', 'Software-only fixture; no physical outcome is claimed.');
  return new NextRequest('http://localhost/api/camera/intakes', { method: 'POST',
    headers: owner ? { cookie: `countershot_session=${owner}` } : {}, body: form });
}
async function adopt() {
  const response = await intakeRoute(capture(), {});
  const data = await response.json() as CameraIntakeResponse;
  assert.equal(response.status, 200, JSON.stringify(data)); assert.equal(data.intake.status, 'completed');
  const created = await createRoute(request('/api/camera/sessions', 'POST', {
    workflowId: workflow.id, facts: {}, intakeId: data.intake.id, intakeRevision: data.intake.revision,
  }), {});
  const state = await created.json() as State;
  assert.equal(created.status, 201, JSON.stringify(state));
  return { state, intake: data.intake, draft: data.intake.result!.factDrafts[0] };
}
function confirmation(state: State, factKey: string, value: string | number | boolean, extra: Record<string, unknown> = {}) {
  return { action: 'prerequisite', expectedRevision: state.session.revision, factKey, value, unit: null,
    operatorConfirmed: true, clientOperationId: randomUUID(), ...extra };
}
async function patch(id: string, payload: unknown, status = 200, owner = browser) {
  const response = await patchRoute(request(`/api/camera/sessions/${id}`, 'PATCH', payload, owner), params(id));
  const data = await response.json();
  assert.equal(response.status, status, JSON.stringify(data));
  return data as State;
}
const stateOf = (id: string) => camera.cameraState(request(`/api/camera/sessions/${id}`), id);

function frameRequest(state: State, bytes: Uint8Array, purpose: 'before' | 'after') {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(bytes)], 'synthetic-frame.png', { type: 'image/png' }));
  form.set('operationId', randomUUID()); form.set('expectedRevision', String(state.session.revision));
  form.set('purpose', purpose); form.set('source', 'upload'); form.set('capturedAt', '');
  form.set('operatorNote', 'Synthetic API transition fixture; not a physical success claim.');
  return new NextRequest(`http://localhost/api/camera/sessions/${state.session.id}/frames`, {
    method: 'POST', headers: { cookie: `countershot_session=${browser}` }, body: form });
}
function assessment(session: CameraSession, purpose: 'before' | 'after'): CameraAssessment {
  const bounded = { instruction: 'Inspect the declared synthetic label only.', expectedVisibleResult: 'The declared synthetic label remains legible.',
    stopCondition: 'Pause if the actual setup differs.', targetObservationIds: ['label'] };
  return { contractVersion: 'camera-decision-v3', summary: 'Synthetic state-transition evidence only.', frameQuality: 'clear',
    continuity: session.latestTurn ? 'same_scene' : 'first_view',
    observations: [{ id: 'label', label: 'Synthetic labelled branch', detail: 'A visible synthetic fixture target.',
      box: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 } }],
    decisionKind: purpose === 'before' ? 'propose_action' : 'ready_for_operator_review',
    actionProposal: purpose === 'before' ? { ...bounded, kind: 'inspect', preconditions: ['Confirmed synthetic setup.'] } : null,
    operatorReview: purpose === 'after' ? bounded : null, viewRequest: null, measurementRequest: null, hold: null,
    comparison: session.reasoning?.activePredictionId ? { predictionId: session.reasoning.activePredictionId, status: 'supported_by_view',
      evidenceObservationIds: ['label'], failedConditions: [], unknownConditions: [] } : null,
    recovery: null, entityHypotheses: [], planChange: null, suggestedStepId: session.currentStepId };
}
const trace: ModelTrace = { model: 'offline-frame-adapter', providerResponseId: 'offline-frame-response', responseIds: ['offline-frame-response'],
  promptVersion: 'offline-prerequisite-api', latencyMs: 1, usage: [{ total_tokens: 1 }] };
const assessor: CameraAssessor = async input => {
  frameAssessments++; await input.onTrace?.(trace);
  return { assessment: assessment(input.session, input.frame.purpose), trace };
};

try {
  if (scenario === 'bootstrap-adoption') {
    const unowned = await intakeRoute(capture(null), {});
    assert.equal(unowned.status, 400); assert.equal(providerCalls, 0);
    const listing = await listRoute(request('/api/camera/sessions', 'GET', undefined, null), {});
    assert.equal(listing.status, 200); assert.equal(listing.headers.get('cache-control'), 'private, no-store');
    const cookie = listing.headers.getSetCookie().find(value => value.startsWith('countershot_session='));
    assert.ok(cookie?.includes('HttpOnly'));
    browser = cookie!.match(/^countershot_session=([^;]+)/)![1];
    const first = await adopt(), id = first.state.session.id, budget = structuredClone(first.state.session.executionBudget);
    assert.equal(id, first.intake.id); assert.deepEqual(first.state.session.facts, {});
    assert.equal(first.state.session.beforeTurn, null); assert.equal(first.state.session.latestTurn, null);
    assert.equal(first.state.session.guidance.actionable, false); assert.equal(first.state.session.guidance.canConfirm, false);
    assert.deepEqual(budget, first.intake.executionBudget); assert.equal(budget!.invocations.length, 1);
    assert.equal(first.state.session.setupContext?.goal, 'Route the labelled synthetic harness.');
    const input = confirmation(first.state, first.draft.factKey, first.draft.value, { intakeDraftId: first.draft.id });
    const saved = await patch(id, input);
    assert.deepEqual(saved.session.facts, { branch_labels: first.draft.value });
    assert.deepEqual(saved.session.executionBudget, budget); assert.equal(providerCalls, 1); assert.equal(frameAssessments, 0);
    assert.equal(saved.session.guidance.actionable, false); assert.equal(saved.session.guidance.canConfirm, false);
    const receipt = store.get<any>('camera_state_receipts', `${id}:${input.clientOperationId}`)!;
    assert.equal(receipt.operatorConfirmed, true); assert.equal(receipt.provenance.kind, 'operator_confirmed_scene_draft');
    assert.equal(receipt.provenance.intakeId, first.intake.id); assert.equal(receipt.provenance.draftId, first.draft.id);
    assert.equal(receipt.provenance.frameId, first.intake.frame!.id); assert.equal(receipt.provenance.frameSha256, store.bytesHash(image));
    assert.deepEqual(receipt.provenance.evidenceObservationIds, ['labels']);
    assert.equal(store.list('camera_state_receipts', id).length, 1);
  } else if (scenario === 'late-phase-replay') {
    const first = await adopt(), id = first.state.session.id;
    let state = first.state;
    const oldInput = confirmation(state, 'branch_labels', first.draft.value, { intakeDraftId: first.draft.id });
    state = await patch(id, oldInput);
    for (const [key, value] of [['scope_confirmed', true], ['target_port_map', 'Branch A follows anchors X then Y to destination B.'],
      ['operator_constraints', 'Two hands; reversible routing on the unpowered synthetic bench only.']] as const)
      state = await patch(id, confirmation(state, key, value));
    const before = await camera.submitCameraFrame(frameRequest(state, image, 'before'), id, assessor);
    assert.equal(before.session.guidance.actionable, true);
    const after = await camera.submitCameraFrame(frameRequest(before, afterImage, 'after'), id, assessor);
    assert.equal(after.session.guidance.canConfirm, true);
    state = await patch(id, { action: 'confirm', expectedRevision: after.session.revision, turnId: after.turn.id,
      confirmations: Object.fromEntries(workflow.steps[0].requiredConfirmations.map(check => [check.id, true])),
      notes: 'Synthetic operator review for API state transitions only.' });
    assert.equal(state.session.currentStepId, workflow.steps[1].id); assert.equal(state.session.completedSteps.length, 1);
    const history = structuredClone(state.session.completedSteps), reviews = structuredClone(state.session.reviews);
    const budget = structuredClone(state.session.executionBudget), scene = state.session.sceneEpoch;
    state = await patch(id, confirmation(state, 'retention_method', 'Actual reversible synthetic clips C1 and C2.'));
    assert.equal(state.session.currentStepId, workflow.steps[1].id); assert.equal(state.session.sceneEpoch, scene);
    assert.deepEqual(state.session.completedSteps, history); assert.deepEqual(state.session.reviews, reviews);
    assert.deepEqual(state.session.executionBudget, budget);
    assert.equal(state.session.beforeTurn, null); assert.equal(state.session.latestTurn, null);
    assert.equal(state.session.reasoning!.activePredictionId, null);
    const revision = state.session.revision, receipts = store.list('camera_state_receipts', id).length;
    const replayed = await patch(id, oldInput);
    assert.equal(replayed.session.revision, revision); assert.equal(replayed.session.currentStepId, workflow.steps[1].id);
    assert.deepEqual(replayed.session.completedSteps, history); assert.equal(store.list('camera_state_receipts', id).length, receipts);
    await patch(id, { ...oldInput, value: 'Changed intent under an old operation.' }, 409);
    await patch(id, oldInput, 404, stranger);
    assert.equal(providerCalls, 1); assert.equal(frameAssessments, 2);
    const manual = store.list<any>('camera_state_receipts', id).find(record => record.factKey === 'retention_method')!;
    assert.deepEqual(manual.provenance, { kind: 'operator_entered_prerequisite' });
  } else if (scenario === 'draft-integrity') {
    const first = await adopt(), second = await adopt(), id = first.state.session.id;
    await patch(id, confirmation(first.state, first.draft.factKey, first.draft.value, { intakeDraftId: second.draft.id }), 409);
    await patch(id, confirmation(first.state, first.draft.factKey, 'Changed proposed labels.', { intakeDraftId: first.draft.id }), 409);
    await patch(id, confirmation(first.state, 'target_port_map', first.draft.value, { intakeDraftId: first.draft.id }), 409);
    assert.deepEqual(stateOf(id).session.facts, {}); assert.equal(store.list('camera_state_receipts', id).length, 0);
    const frame = store.get<{ storageKey: string }>('camera_intake_frames', first.intake.frame!.id)!;
    await writeFile(path.join(store.assetRoot, frame.storageKey), afterImage);
    await patch(id, confirmation(first.state, first.draft.factKey, first.draft.value, { intakeDraftId: first.draft.id }), 409);
    const manual = await patch(id, confirmation(first.state, 'branch_labels', 'Operator inspected labels A and B directly.'));
    assert.equal(manual.session.facts.branch_labels, 'Operator inspected labels A and B directly.');
    assert.equal(manual.session.guidance.actionable, false);
    const reset = await patch(second.state.session.id, { action: 'facts', expectedRevision: second.state.session.revision, facts: {} });
    assert.equal(reset.session.sceneEpoch, 2); assert.equal(reset.intake, null);
    await patch(second.state.session.id, confirmation(reset, second.draft.factKey, second.draft.value, { intakeDraftId: second.draft.id }), 409);
    assert.deepEqual(stateOf(second.state.session.id).session.facts, {}); assert.equal(providerCalls, 2);
  } else if (scenario === 'pending') {
    const first = await adopt(), id = first.state.session.id;
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const pending: CameraAssessor = async input => {
      frameAssessments++; entered(); await wait;
      const value = assessment(input.session, 'before');
      value.decisionKind = 'hold'; value.actionProposal = null;
      value.hold = { reason: 'The synthetic setup has unknown prerequisites.', resumeWhen: 'The operator confirms them.' };
      return { assessment: value, trace };
    };
    const running = camera.submitCameraFrame(frameRequest(first.state, image, 'before'), id, pending);
    await ready;
    try {
      const before = stateOf(id), budget = structuredClone(before.session.executionBudget);
      assert.ok(before.session.activeTurnId);
      await patch(id, confirmation(before, 'scope_confirmed', true), 409);
      const unchanged = stateOf(id);
      assert.equal(unchanged.session.revision, before.session.revision); assert.deepEqual(unchanged.session.facts, {});
      assert.deepEqual(unchanged.session.executionBudget, budget); assert.equal(store.list('camera_state_receipts', id).length, 0);
      assert.equal(providerCalls, 1); assert.equal(frameAssessments, 1);
    } finally { release(); await running; }
  } else if (scenario === 'invalid-input') {
    const first = await adopt(), id = first.state.session.id;
    const base = confirmation(first.state, 'scope_confirmed', true);
    for (const [payload, code] of [
      [{ ...base, operatorConfirmed: false }, 400], [{ ...base, operatorConfirmed: undefined }, 400],
      [{ ...base, expectedRevision: base.expectedRevision + 1 }, 409],
      [confirmation(first.state, 'minimum_bend_radius_mm', 25, { unit: 'mm' }), 400],
      [confirmation(first.state, 'branch_labels', 'A and B', { unit: 'mm' }), 400],
      [confirmation(first.state, 'scope_confirmed', 'true'), 400],
      [confirmation(first.state, 'unknown_model_field', 'Invented'), 400],
    ] as const) await patch(id, payload, code);
    assert.deepEqual(stateOf(id).session.facts, {}); assert.equal(store.list('camera_state_receipts', id).length, 0);
    const negative = await patch(id, { ...base, value: false });
    assert.equal(negative.session.facts.scope_confirmed, false); assert.equal(negative.session.guidance.actionable, false);
    await patch(id, confirmation(negative, 'scope_confirmed', true), 409);
    assert.equal(providerCalls, 1); assert.equal(frameAssessments, 0);
  } else assert.fail(`Unknown prerequisite API scenario: ${scenario}`);
} finally { provider.mock.restore(); store.db.close(); }
