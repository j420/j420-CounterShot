import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { NextRequest } from 'next/server';
import { mock } from 'node:test';
import OpenAI from 'openai';

assert.ok(process.env.DATA_ROOT?.startsWith(path.join(os.tmpdir(), 'countershot-camera-api-')));
assert.ok(realpathSync(process.env.DATA_ROOT!).startsWith(realpathSync(os.tmpdir()) + path.sep));
assert.equal(process.env.DATABASE_PATH, path.join(process.env.DATA_ROOT!, 'test.sqlite'));
assert.equal(process.env.ASSET_ROOT, path.join(process.env.DATA_ROOT!, 'assets'));
process.env.MODEL_API_KEY = 'offline-camera-fixture-key';
delete process.env.APP_ACCESS_CODE;
delete process.env.APP_PUBLIC_ORIGIN;
delete process.env.PUBLIC_API_ORIGIN;
const server = await import('../../src/camera/server');
const store = await import('../../src/storage/db');
const { cameraWorkflow, cameraSyntheticFacts, syntheticCameraMeasurements } = await import('../../src/camera/workflows');
const { MetaError } = await import('../../src/meta');
const { assessCameraFrame } = await import('../../src/camera/meta');
const { isCameraDecisionAssessment } = await import('../../src/camera/schema');
const { getCurrentReportedFailures } = await import('../../src/camera/engine');
const { GET: listRoute, POST: createRoute } = await import('../../app/api/camera/sessions/route');
const { GET: stateRoute, PATCH: patchRoute } = await import('../../app/api/camera/sessions/[id]/route');
const { POST: frameRoute } = await import('../../app/api/camera/sessions/[id]/frames/route');
const { GET: imageRoute } = await import('../../app/api/camera/sessions/[id]/frames/[frameId]/route');
import type { CameraAssessment, CameraSession } from '../../src/camera/schema';
import type { CameraAssessor, StoredCameraSession, StoredCameraTurn } from '../../src/camera/server';
import type { ModelTrace } from '../../src/meta';
import type { ExecutionBudget } from '../../src/meta/budget';
const { createExecutionBudget: createBudget, DEFAULT_CAMERA_EXECUTION_LIMITS: cameraBudgetLimits } = await import('../../src/meta/budget');

const run = promisify(execFile), root = process.env.DATA_ROOT!;
const owner = 'offline-camera-owner', stranger = 'offline-camera-stranger';
const workflow = cameraWorkflow('harness_routing')!;
const facts = cameraSyntheticFacts.harness_routing;
const scenario = process.argv[2];
const project = () => server.createOwnedCameraSession({ workflowId: workflow.id, facts }, owner);
const request = (sessionId: string, method = 'GET', body?: unknown, browser = owner, extra: Record<string, string> = {}) => new NextRequest(`http://localhost/api/camera/sessions/${sessionId}`, {
  method, headers: { cookie: `countershot_session=${browser}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...extra },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const context = (sessionId: string) => ({ params: Promise.resolve({ id: sessionId }) });
const newFrame = (sessionId: string, bytes: Uint8Array, operationId = randomUUID(), expectedRevision = 1, purpose: 'before' | 'after' = 'before',
  metadata: Record<string, string> = {}, browser = owner) => {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(bytes)], 'offline-frame.png', { type: 'application/octet-stream' }));
  form.set('operationId', operationId); form.set('expectedRevision', String(expectedRevision));
  form.set('purpose', purpose); form.set('source', 'upload'); form.set('capturedAt', ''); form.set('operatorNote', 'Synthetic offline API regression; not physical success evidence.');
  for (const [key, value] of Object.entries(metadata)) form.set(key, value);
  return new NextRequest(`http://localhost/api/camera/sessions/${sessionId}/frames`, { method: 'POST', headers: { cookie: `countershot_session=${browser}` }, body: form });
};
const status = (code: number) => (error: unknown) => !!error && typeof error === 'object' && 'status' in error && error.status === code;
const png = path.join(root, 'blue.png'), changed = path.join(root, 'red.png');
for (const [color, output] of [['blue', png], ['red', changed]]) await run('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', `color=c=${color}:s=32x32`, '-frames:v', '1', '-threads', '1', output], { timeout: 10_000 });
const image = await readFile(png), afterImage = await readFile(changed);
const trace: ModelTrace = { model: 'offline-camera-model', providerResponseId: 'resp_camera_offline', latencyMs: 1, usage: [{ total_tokens: 7 }], promptVersion: 'offline-fixture', responseIds: ['resp_camera_offline'] };
function assessment(stepId: string, purpose: 'before' | 'after', continuity: CameraAssessment['continuity'] = purpose === 'before' ? 'first_view' : 'same_scene', context?: CameraSession): CameraAssessment {
  const bounded = { instruction: 'Use only the synthetic fixture for this state transition.', targetObservationIds: ['label'],
    expectedVisibleResult: 'The selected view remains linked to this exact step.', stopCondition: 'Pause if actual facts differ from this synthetic fixture.' };
  context ||= store.list<StoredCameraSession>('camera_sessions').find(session => session.activeTurnId && session.currentStepId === stepId);
  return { contractVersion: 'camera-decision-v3', summary: 'Synthetic camera assessment fixture; no physical observation is claimed.', frameQuality: 'clear', continuity,
    comparison: context?.reasoning?.activePredictionId && continuity !== 'changed' ? { predictionId: context.reasoning.activePredictionId,
      status: 'supported_by_view', evidenceObservationIds: ['label'], failedConditions: [], unknownConditions: [] } : null,
    recovery: null, entityHypotheses: [], planChange: null,
    observations: [{ id: 'label', label: 'Offline labelled component', detail: 'Generated pixels used only for API state testing.', box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }],
    decisionKind: purpose === 'before' ? 'propose_action' : 'ready_for_operator_review',
    actionProposal: purpose === 'before' ? { ...bounded, kind: 'perform', preconditions: ['Confirmed synthetic test facts remain unchanged.'] } : null,
    operatorReview: purpose === 'after' ? bounded : null, viewRequest: null, measurementRequest: null, hold: null, suggestedStepId: stepId };
}
let calls = 0;
const assessor: CameraAssessor = async input => {
  calls++;
  assert.ok(input.runId); assert.ok(input.turnId);
  assert.equal(store.get<StoredCameraTurn>('camera_turns', input.turnId)!.projectId, input.runId);
  assert.equal('ownerHash' in input.session, false);
  assert.equal(input.frame.sha256, store.bytesHash(await readFile(input.framePath)));
  await input.onTrace?.(trace);
  return { assessment: assessment(input.frame.stepId, input.frame.purpose, input.previousFramePath ? 'same_scene' : 'first_view'), trace };
};
const evidenceAssessor = (kind: 'request_view' | 'request_measurement'): CameraAssessor => async input => {
  calls++; await input.onTrace?.(trace);
  const value = assessment(input.frame.stepId, input.frame.purpose, input.previousFramePath ? 'same_scene' : 'first_view');
  value.decisionKind = kind; value.actionProposal = null; value.operatorReview = null;
  if (kind === 'request_view') value.viewRequest = { instruction: 'Expose the unreadable synthetic branch label in a new view.',
    whyNeeded: 'Its identity remains unresolved.', resolves: 'The actual branch identity.', targetObservationIds: ['label'] };
  else value.measurementRequest = { factKey: 'minimum_bend_radius_mm', unit: 'mm', instruction: 'Confirm the cable specification minimum bend radius.',
    whyNeeded: 'A picture cannot establish the prerequisite.', resolves: 'The actual allowed cable bend radius.', targetObservationIds: ['label'] };
  return { assessment: value, trace };
};
const frameFiles = async () => (await readdir(path.join(store.assetRoot, 'camera')).catch(() => [])).sort();
const responseTiming = (body: { serverProcessingMs?: number; serverNow?: string }) => {
  assert.ok(Number.isFinite(body.serverProcessingMs) && body.serverProcessingMs! >= 0);
  assert.ok(Number.isFinite(Date.parse(body.serverNow!)));
  assert.ok(Math.abs(Date.now() - Date.parse(body.serverNow!)) < 2_000);
};

function sdkResponses(respond: (body: Record<string, any>) => unknown | Promise<unknown>) {
  return mock.method(OpenAI.prototype, 'post', ((_url: string, options: Record<string, unknown>) => {
    assert.equal(_url, '/responses', 'Only the fully mocked Responses endpoint is permitted.');
    const result = Promise.resolve(options).then(resolved => respond(resolved.body as Record<string, any>));
    return { _thenUnwrap: (transform: (value: unknown) => unknown) => result.then(transform) };
  }) as unknown as typeof OpenAI.prototype.post);
}
function durableReservation(sessionId: string) {
  const saved = store.get<StoredCameraSession>('camera_sessions', sessionId)!;
  const pending = store.get<StoredCameraTurn>('camera_turns', saved.activeTurnId!)!;
  const invocationId = pending.trace?.modelInvocationId;
  assert.ok(invocationId, 'The final trace fence must identify this actual request.');
  const invocation = saved.executionBudget!.invocations.find(item => item.invocationId === invocationId)!;
  assert.ok(invocation, 'The reservation must be visible in the durable database before SDK POST.');
  assert.equal(invocation.status, 'reserved'); assert.equal(invocation.responseId, null);
  assert.equal(saved.executionBudget!.runId, sessionId);
  return { saved, pending, invocation, budget: saved.executionBudget! };
}
function sdkFinal(sessionId: string, responseId: string, purpose: 'before' | 'after', usage = 17) {
  const saved = store.get<StoredCameraSession>('camera_sessions', sessionId)!;
  return { id: responseId, model: 'muse-spark-1.3', status: 'completed', usage: { input_tokens: usage - 3, output_tokens: 3, total_tokens: usage },
    output: [{ type: 'message', role: 'assistant', id: `message-${responseId}`, status: 'completed', content: [{ type: 'output_text',
      text: JSON.stringify(assessment(saved.currentStepId!, purpose, purpose === 'before' ? 'first_view' : 'same_scene', saved)) }] }] };
}
function sdkEvidence(frameId: string, responseId: string) {
  return { id: responseId, model: 'muse-spark-1.3', status: 'completed', usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
    output: [{ type: 'function_call', id: 'owned-evidence-function', status: 'completed', call_id: 'owned-evidence-call', name: 'read_owned_evidence',
      arguments: JSON.stringify({ frameId, region: { x: 0, y: 0, width: 0.5, height: 0.5 } }) }] };
}
async function archiveFixture() {
  const session = project();
  const before = await server.submitCameraFrame(newFrame(session.id, image), session.id, assessor);
  const after = await server.submitCameraFrame(newFrame(session.id, afterImage, randomUUID(), before.session.revision, 'after'), session.id, assessor);
  assert.equal(before.turn.status, 'completed'); assert.equal(after.turn.status, 'completed');
  const filename = path.join(root, 'durable-green.png');
  await run('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=green:s=32x32', '-frames:v', '1', '-threads', '1', filename], { timeout: 10_000 });
  return { session, before, after, thirdImage: await readFile(filename) };
}

try {
  if (scenario === 'ownership') {
    const session = project();
    const a = request(session.id), b = request(session.id, 'GET', undefined, stranger);
    const state = await stateRoute(a, context(session.id));
    assert.equal(state.status, 200); responseTiming(await state.json());
    const listed = await listRoute(request(''), {});
    assert.equal(listed.status, 200); responseTiming(await listed.json());
    const patched = await patchRoute(request(session.id, 'PATCH', { action: 'facts', expectedRevision: 1, facts }), context(session.id));
    assert.equal(patched.status, 200); responseTiming(await patched.json());
    assert.equal((await stateRoute(b, context(session.id))).status, 404);
    const own = server.cameraState(a, session.id);
    assert.equal('ownerHash' in own.session, false); assert.equal('projectId' in own.session, false);
    assert.equal(server.cameraSessions(b).sessions.length, 0);
    assert.equal(server.cameraSessions(a).workflows.length, 5);
    process.env.APP_ACCESS_CODE = 'offline-camera-access';
    assert.equal((await listRoute(request(''), {})).status, 401);
    assert.equal((await frameRoute(newFrame(session.id, image), context(session.id))).status, 401);
    const creation = new NextRequest('http://localhost/api/camera/sessions', { method: 'POST', headers: {
      'Content-Type': 'application/json', cookie: `countershot_access=${store.bytesHash('offline-camera-access')}` },
      body: JSON.stringify({ workflowId: workflow.id, facts }) });
    const response = await createRoute(creation, {});
    assert.equal(response.status, 201);
    const created = await response.json();
    responseTiming(created);
    assert.ok(response.headers.getSetCookie().some(cookie => cookie.startsWith('countershot_session=')));
    assert.equal(created.session.workflowId, workflow.id); assert.equal(created.turns.length, 0);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(store.list('projects').length, 0);
    assert.equal(calls, 0);
  } else if (scenario === 'request-decisions') {
    const session = project(), operation = randomUUID();
    const requested: CameraAssessor = async input => {
      calls++; await input.onTrace?.(trace);
      const value = assessment(input.frame.stepId, input.frame.purpose, input.previousFramePath ? 'same_scene' : 'first_view');
      value.decisionKind = 'request_view'; value.actionProposal = null; value.operatorReview = null;
      value.viewRequest = { instruction: 'Show the hidden branch label in a closer view.', whyNeeded: 'Its identity is unreadable.',
        resolves: 'Which declared branch is visible.', targetObservationIds: ['label'] };
      return { assessment: value, trace };
    };
    const waiting = await server.submitCameraFrame(newFrame(session.id, image, operation), session.id, requested);
    assert.equal(waiting.turn.status, 'completed'); assert.equal(waiting.session.activeTurnId, null);
    assert.equal(waiting.turn.decisionId, `decision:${waiting.turn.id}`);
    assert.equal(waiting.turn.requestId, `request:${waiting.turn.id}`); assert.equal(waiting.turn.predictionId, null);
    assert.equal(waiting.session.latestTurn?.requestId, waiting.turn.requestId);
    assert.equal(waiting.session.guidance.actionable, false); assert.equal(waiting.session.guidance.canConfirm, false);
    assert.equal(waiting.session.beforeTurn, null); assert.equal(waiting.session.completedSteps.length, 0);
    const replay = await server.submitCameraFrame(newFrame(session.id, image, operation), session.id, requested);
    assert.equal(replay.turn.requestId, waiting.turn.requestId); assert.equal(calls, 1, 'A saved request is complete, not a suspended or repeated provider call.');
    assert.equal(waiting.session.openRequest?.id, waiting.turn.requestId);
    const before = await server.submitCameraFrame(newFrame(session.id, afterImage, randomUUID(), waiting.session.revision, 'before', { requestId: waiting.turn.requestId! }), session.id, assessor);
    assert.equal(before.session.openRequest, null); assert.equal(before.session.evidenceRequests?.[0].status, 'answered');
    assert.equal(before.turn.answersRequestId, waiting.turn.requestId);
    const after = await server.submitCameraFrame(newFrame(session.id, image, randomUUID(), before.session.revision, 'after'), session.id, assessor);
    const completed = server.patchCameraSession(request(session.id), session.id, { action: 'confirm', expectedRevision: after.session.revision,
      turnId: after.turn.id, confirmations: Object.fromEntries(workflow.steps[0].requiredConfirmations.map(check => [check.id, true])),
      notes: 'Synthetic operator review only; evidence requests cannot complete this phase.' });
    const measured: CameraAssessor = async input => {
      calls++; await input.onTrace?.(trace);
      const value = assessment(input.frame.stepId, 'before', 'same_scene');
      value.decisionKind = 'request_measurement'; value.actionProposal = null;
      value.measurementRequest = { factKey: 'minimum_bend_radius_mm', unit: 'mm', instruction: 'Read the cable specification bend radius.',
        whyNeeded: 'The visible routing cannot establish this bound.', resolves: 'The required radius for this routing decision.', targetObservationIds: ['label'] };
      return { assessment: value, trace };
    };
    const measurement = await server.submitCameraFrame(newFrame(session.id, image, randomUUID(), completed.session.revision), session.id, measured);
    assert.equal(measurement.turn.status, 'completed'); assert.equal(measurement.turn.requestId, `request:${measurement.turn.id}`);
    assert.equal(measurement.session.guidance.actionable, false); assert.equal(measurement.session.guidance.canConfirm, false);
    assert.equal(measurement.session.completedSteps.length, 1); assert.deepEqual(measurement.session.facts, facts);
    const answered = server.patchCameraSession(request(session.id), session.id, { action: 'request_answer', requestId: measurement.turn.requestId,
      expectedRevision: measurement.session.revision, value: facts.minimum_bend_radius_mm, unit: 'mm', clientOperationId: randomUUID() });
    assert.equal(answered.session.openRequest, null); assert.equal(answered.session.sceneEpoch, measurement.session.sceneEpoch);
    assert.equal(answered.session.completedSteps.length, 1); assert.equal(calls, 4, 'A prerequisite answer cannot start inference.');
    const held = await server.submitCameraFrame(newFrame(session.id, afterImage, randomUUID(), answered.session.revision), session.id, async input => {
      calls++; const value = assessment(input.frame.stepId, 'before', 'same_scene');
      value.decisionKind = 'hold'; value.actionProposal = null; value.hold = { reason: 'The specification and physical label conflict.', resumeWhen: 'The operator resolves the actual cable identity.' };
      return { assessment: value, trace };
    });
    assert.equal(held.turn.status, 'completed'); assert.equal(held.turn.requestId, null); assert.equal(held.turn.predictionId, null);
    assert.equal(held.session.guidance.actionable, false); assert.equal(held.session.guidance.canConfirm, false);
    assert.equal(held.session.activeTurnId, null); assert.equal(held.session.completedSteps.length, 1); assert.deepEqual(held.session.facts, facts);
    assert.throws(() => server.patchCameraSession(request(session.id), session.id, { action: 'confirm', expectedRevision: held.session.revision,
      turnId: held.turn.id, confirmations: {}, notes: 'A held turn cannot authorize movement or completion.' }), status(409));
    assert.equal(calls, 5);
  } else if (scenario === 'numeric-answer') {
    const partialFacts = { ...facts }; delete partialFacts.minimum_bend_radius_mm;
    const session = server.createOwnedCameraSession({ workflowId: workflow.id, facts: partialFacts }, owner);
    const first = await server.submitCameraFrame(newFrame(session.id, image), session.id, assessor);
    const firstAfter = await server.submitCameraFrame(newFrame(session.id, afterImage, randomUUID(), first.session.revision, 'after'), session.id, assessor);
    const progressed = server.patchCameraSession(request(session.id), session.id, { action: 'confirm', expectedRevision: firstAfter.session.revision,
      turnId: firstAfter.turn.id, confirmations: Object.fromEntries(workflow.steps[0].requiredConfirmations.map(check => [check.id, true])), notes: 'Synthetic identity review.' });
    const question = await server.submitCameraFrame(newFrame(session.id, image, randomUUID(), progressed.session.revision), session.id, evidenceAssessor('request_measurement'));
    const open = question.session.openRequest!; assert.equal(open.measurement?.factKey, 'minimum_bend_radius_mm');
    const value = 25, operation = randomUUID();
    const input = { action: 'request_answer', requestId: open.id, expectedRevision: question.session.revision, value, unit: 'mm', clientOperationId: operation };
    await assert.rejects(server.submitCameraFrame(newFrame(session.id, afterImage, randomUUID(), question.session.revision), session.id, assessor), status(409));
    assert.throws(() => server.patchCameraSession(request(session.id), session.id, { ...input, unit: 'cm' }), status(400));
    assert.throws(() => server.patchCameraSession(request(session.id), session.id, { ...input, value: 10_000 }), status(400));
    assert.throws(() => server.patchCameraSession(request(session.id), session.id, { ...input, requestId: `request:${randomUUID()}` }), status(409));
    assert.throws(() => server.patchCameraSession(request(session.id, 'GET', undefined, stranger), session.id, input), status(404));
    const answered = server.patchCameraSession(request(session.id), session.id, input);
    assert.equal(calls, 3, 'A numeric prerequisite answer never starts an inference.');
    assert.equal(answered.session.sceneEpoch, question.session.sceneEpoch); assert.equal(answered.session.revision, question.session.revision + 1);
    assert.deepEqual(answered.session.completedSteps, progressed.session.completedSteps); assert.equal(answered.session.latestTurn, null);
    assert.equal(answered.session.facts.minimum_bend_radius_mm, value); assert.equal(answered.session.guidance.actionable, false);
    assert.equal(answered.session.evidenceRequests![0].answers[0].status, 'accepted');
    assert.equal(server.patchCameraSession(request(session.id), session.id, input).session.revision, answered.session.revision);
    assert.equal(server.cameraState(request(session.id), session.id).session.evidenceRequests![0].answers.length, 1);
    assert.throws(() => server.patchCameraSession(request(session.id), session.id, { ...input, value: value + 1 }), status(409));
    const before = await server.submitCameraFrame(newFrame(session.id, afterImage, randomUUID(), answered.session.revision), session.id, assessor);
    assert.equal(before.session.guidance.actionable, true); assert.equal(before.session.sceneEpoch, session.sceneEpoch);
    const afterQuestion = await server.submitCameraFrame(newFrame(session.id, image, randomUUID(), before.session.revision, 'after'), session.id, evidenceAssessor('request_measurement'));
    const same = server.patchCameraSession(request(session.id), session.id, { ...input, requestId: afterQuestion.session.openRequest!.id,
      expectedRevision: afterQuestion.session.revision, clientOperationId: randomUUID() });
    assert.equal(same.session.beforeTurn?.id, before.turn.id, 'A same-value prerequisite confirmation preserves the original admitted action.');
    const after = await server.submitCameraFrame(newFrame(session.id, image, randomUUID(), same.session.revision, 'after'), session.id, assessor);
    assert.equal(after.session.guidance.canConfirm, true);
    assert.throws(() => server.patchCameraSession(request(session.id), session.id, { action: 'confirm', expectedRevision: after.session.revision,
      turnId: after.turn.id, confirmations: Object.fromEntries(workflow.steps[1].requiredConfirmations.map(check => [check.id, true])), notes: 'A prerequisite answer is not an actual-result reading.' }), status(400));
    const changedQuestion = await server.submitCameraFrame(newFrame(session.id, image, randomUUID(), after.session.revision, 'after'), session.id, evidenceAssessor('request_measurement'));
    const changed = { ...input, requestId: changedQuestion.session.openRequest!.id, expectedRevision: changedQuestion.session.revision,
      value: value + 1, clientOperationId: randomUUID() };
    assert.throws(() => server.patchCameraSession(request(session.id), session.id, changed), status(409));
    const reset = server.patchCameraSession(request(session.id), session.id, { action: 'facts', expectedRevision: changedQuestion.session.revision,
      facts: { ...facts, minimum_bend_radius_mm: value + 1 } });
    assert.equal(reset.session.sceneEpoch, session.sceneEpoch + 1); assert.equal(reset.session.openRequest, null);
    assert.ok(reset.session.evidenceRequests!.every(record => record.status === 'stale'));
    assert.equal(reset.session.evidenceRequests![0].answers[0].kind, 'measurement');
    assert.throws(() => server.patchCameraSession(request(session.id), session.id, { ...changed, expectedRevision: reset.session.revision }), status(409));
    const restarted = await server.submitCameraFrame(newFrame(session.id, afterImage, randomUUID(), reset.session.revision), session.id, assessor);
    assert.equal(restarted.session.guidance.actionable, true, 'Preserved stale request history cannot block a deliberate new scene baseline.');
  } else if (scenario === 'view-answer-retry') {
    const session = project();
    const question = await server.submitCameraFrame(newFrame(session.id, image), session.id, evidenceAssessor('request_view'));
    const requestId = question.session.openRequest!.id, operation = randomUUID();
    await assert.rejects(server.submitCameraFrame(newFrame(session.id, image, randomUUID(), question.session.revision, 'before', { requestId }), session.id, assessor), status(409));
    await assert.rejects(server.submitCameraFrame(newFrame(session.id, afterImage, randomUUID(), question.session.revision), session.id, assessor), status(409));
    await assert.rejects(server.submitCameraFrame(newFrame(session.id, afterImage, randomUUID(), question.session.revision, 'after', { requestId }), session.id, assessor), status(400));
    const failedAssessor: CameraAssessor = async input => { calls++; await input.onTrace?.(trace); throw new MetaError('Synthetic failed view answer.', 'provider_error'); };
    const failed = await server.submitCameraFrame(newFrame(session.id, afterImage, operation, question.session.revision, 'before', { requestId }), session.id, failedAssessor);
    assert.equal(failed.turn.status, 'failed'); assert.equal(failed.session.openRequest?.id, requestId);
    assert.equal(failed.session.openRequest?.stateRevision, failed.session.revision);
    assert.equal(failed.session.evidenceRequests![0].answers[0].status, 'failed'); assert.equal(failed.session.sceneEpoch, question.session.sceneEpoch);
    const replay = await server.submitCameraFrame(newFrame(session.id, afterImage, operation, question.session.revision, 'before', { requestId }), session.id, failedAssessor);
    assert.equal(replay.turn.id, failed.turn.id); assert.equal(calls, 2);
    const answer = await server.submitCameraFrame(newFrame(session.id, afterImage, randomUUID(), failed.session.revision, 'before', { requestId }), session.id, assessor);
    assert.equal(answer.turn.status, 'completed'); assert.equal(answer.session.openRequest, null); assert.equal(answer.session.evidenceRequests![0].status, 'answered');
    assert.deepEqual(answer.session.evidenceRequests![0].answers.map(entry => entry.status), ['failed', 'accepted']);
    assert.equal(answer.session.sceneEpoch, question.session.sceneEpoch); assert.equal(answer.session.beforeTurn?.id, answer.turn.id);
    assert.equal(calls, 3);
    const changed = await server.submitCameraFrame(newFrame(session.id, image, randomUUID(), answer.session.revision, 'after'), session.id, async input => {
      calls++; const value = assessment(input.frame.stepId, 'after', 'changed'); value.decisionKind = 'hold'; value.operatorReview = null;
      value.hold = { reason: 'A different workpiece replaced the setup.', resumeWhen: 'Explicitly reset the actual scene.' }; return { assessment: value, trace };
    });
    assert.equal(changed.session.evidenceRequests![0].status, 'stale'); assert.equal(changed.session.sceneEpoch, session.sceneEpoch + 1);
    assert.deepEqual(changed.session.evidenceRequests![0].answers.map(entry => entry.status), ['failed', 'accepted']);
  } else if (scenario === 'request-cancel') {
    const session = project();
    const question = await server.submitCameraFrame(newFrame(session.id, image), session.id, evidenceAssessor('request_view'));
    const requestId = question.session.openRequest!.id;
    let release!: () => void, entered!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const work = server.submitCameraFrame(newFrame(session.id, afterImage, randomUUID(), question.session.revision, 'before', { requestId }), session.id, async input => {
      calls++; entered(); await wait; await input.onTrace?.(trace); return { assessment: assessment(input.frame.stepId, 'before', 'same_scene'), trace };
    });
    await started;
    const pending = server.cameraState(request(session.id), session.id); assert.equal(pending.session.openRequest?.answers[0].status, 'pending');
    const input = { action: 'request_cancel', requestId, expectedRevision: pending.session.revision, clientOperationId: randomUUID() };
    const cancelled = server.patchCameraSession(request(session.id), session.id, input);
    assert.equal(cancelled.session.openRequest, null); assert.equal(cancelled.session.activeTurnId, null);
    assert.equal(cancelled.session.evidenceRequests![0].status, 'cancelled'); assert.equal(cancelled.session.evidenceRequests![0].answers[0].status, 'superseded');
    assert.equal(server.patchCameraSession(request(session.id), session.id, input).session.revision, cancelled.session.revision);
    release(); const late = await work;
    assert.equal(late.turn.status, 'superseded'); assert.equal(late.turn.trace?.providerResponseId, trace.providerResponseId);
    assert.equal(late.session.evidenceRequests![0].status, 'cancelled'); assert.equal(late.session.latestTurn, null); assert.equal(late.session.guidance.actionable, false);
    await assert.rejects(server.submitCameraFrame(newFrame(session.id, afterImage, randomUUID(), late.session.revision, 'before', { requestId }), session.id, assessor), status(409));
    assert.equal(calls, 2);
    const fresh = await server.submitCameraFrame(newFrame(session.id, afterImage, randomUUID(), late.session.revision), session.id, assessor);
    assert.equal(fresh.session.guidance.actionable, true); assert.equal(fresh.session.sceneEpoch, session.sceneEpoch); assert.equal(calls, 3);
  } else if (scenario === 'reasoning-memory-api') {
    const session = project(), before = await server.submitCameraFrame(newFrame(session.id, image), session.id, assessor);
    const binding = { action: 'entity_bind', expectedRevision: before.session.revision, turnId: before.turn.id,
      observationId: 'label', label: 'Branch A', entityId: null, operatorConfirmed: true, clientOperationId: randomUUID() };
    const bound = server.patchCameraSession(request(session.id), session.id, binding), entity = bound.session.reasoning!.entities[0];
    assert.match(entity.id, /^entity:/); assert.equal(entity.label, 'Branch A'); assert.equal(bound.session.latestTurn, null);
    assert.equal(bound.session.beforeTurn!.id, before.turn.id); assert.equal(calls, 1);
    assert.equal(server.patchCameraSession(request(session.id), session.id, binding).session.revision, bound.session.revision);
    assert.equal(server.cameraState(request(session.id), session.id).session.reasoning!.entities.length, 1);
    const after = await server.submitCameraFrame(newFrame(session.id, afterImage, randomUUID(), bound.session.revision, 'after'), session.id, assessor);
    assert.throws(() => server.patchCameraSession(request(session.id), session.id, { ...binding, expectedRevision: after.session.revision, turnId: after.turn.id,
      clientOperationId: randomUUID(), entityId: 'entity:foreign' }), status(400));
    assert.throws(() => server.patchCameraSession(request(session.id), session.id, { ...binding, expectedRevision: after.session.revision, turnId: after.turn.id,
      clientOperationId: randomUUID(), label: 'branch a' }), status(409));
    const progressed = server.patchCameraSession(request(session.id), session.id, { action: 'confirm', expectedRevision: after.session.revision, turnId: after.turn.id,
      confirmations: Object.fromEntries(workflow.steps[0].requiredConfirmations.map(check => [check.id, true])), notes: 'Synthetic identity review, not a physical success claim.' });
    const routed = await server.submitCameraFrame(newFrame(session.id, image, randomUUID(), progressed.session.revision), session.id, assessor);
    const shown = await server.submitCameraFrame(newFrame(session.id, afterImage, randomUUID(), routed.session.revision, 'after'), session.id, assessor);
    const step = workflow.steps[1], good = syntheticCameraMeasurements(workflow.id, step.id), definition = step.measurements![0];
    const failed = server.patchCameraSession(request(session.id), session.id, { action: 'review', expectedRevision: shown.session.revision, turnId: shown.turn.id,
      outcome: 'failed', confirmations: {}, measurements: { ...good, [definition.id]: Number(facts[definition.factId]) - 1 },
      notes: 'The numeric radius failed and an independent support also slipped.' });
    const heldAssessor: CameraAssessor = async input => {
      calls++; const value = assessment(input.frame.stepId, 'before', 'same_scene', input.session);
      value.decisionKind = 'hold'; value.actionProposal = null;
      value.comparison = { predictionId: input.session.reasoning!.activePredictionId!, status: 'contradicted', evidenceObservationIds: ['label'], failedConditions: ['The actual radius and support failure need an operator recheck.'], unknownConditions: [] };
      value.hold = { reason: 'Record the actual recheck.', resumeWhen: 'Measured values and all required support conditions have been inspected.' }; return { assessment: value, trace };
    };
    const firstHeld = await server.submitCameraFrame(newFrame(session.id, image, randomUUID(), failed.session.revision), session.id, heldAssessor);
    const report = { action: 'reading_report', expectedRevision: firstHeld.session.revision, turnId: firstHeld.turn.id, measurements: good,
      confirmations: {}, notes: 'The numeric value now passes; the independent support condition remains unchecked.', operatorConfirmed: true, clientOperationId: randomUUID() };
    const partial = server.patchCameraSession(request(session.id), session.id, report);
    assert.equal(partial.session.readingReports!.length, 1); assert.equal(getCurrentReportedFailures(partial.session, workflow).knownFailure, true);
    assert.equal(getCurrentReportedFailures(partial.session, workflow).failedReadingIds.length, 0); assert.equal(partial.session.completedSteps.length, 1);
    const secondHeld = await server.submitCameraFrame(newFrame(session.id, afterImage, randomUUID(), partial.session.revision), session.id, heldAssessor);
    const complete = { ...report, expectedRevision: secondHeld.session.revision, turnId: secondHeld.turn.id,
      confirmations: Object.fromEntries(step.requiredConfirmations.map(check => [check.id, true])),
      notes: 'I explicitly rechecked all actual measurements and every independent support and operator condition.', clientOperationId: randomUUID() };
    const checked = server.patchCameraSession(request(session.id), session.id, complete);
    assert.equal(getCurrentReportedFailures(checked.session, workflow).knownFailure, false); assert.equal(checked.session.reviews!.at(-1)!.outcome, 'failed');
    assert.equal(checked.session.readingReports!.length, 2); assert.equal(checked.session.completedSteps.length, 1); assert.equal(checked.session.latestTurn, null);
    assert.equal(server.patchCameraSession(request(session.id), session.id, complete).session.revision, checked.session.revision);
    assert.throws(() => server.patchCameraSession(request(session.id), session.id, { ...complete, notes: 'A different report reused the operation.' }), status(409));
    const badEntity = await server.submitCameraFrame(newFrame(session.id, afterImage, randomUUID(), checked.session.revision), session.id, async input => {
      calls++; const value = assessment(input.frame.stepId, 'before', 'same_scene', input.session);
      value.entityHypotheses = [{ observationId: 'label', candidateEntityIds: ['entity:foreign'], detail: 'The model cannot invent an owned identity.' }]; return { assessment: value, trace };
    });
    assert.equal(badEntity.turn.status, 'failed'); assert.match(badEntity.turn.error!, /owned entities/); assert.equal(badEntity.session.reasoning!.entities.length, 1);
  } else if (scenario === 'plan-change-api') {
    const session = project(), first = await server.submitCameraFrame(newFrame(session.id, image), session.id, assessor);
    const after = await server.submitCameraFrame(newFrame(session.id, afterImage, randomUUID(), first.session.revision, 'after'), session.id, assessor);
    let state = server.patchCameraSession(request(session.id), session.id, { action: 'confirm', expectedRevision: after.session.revision, turnId: after.turn.id,
      confirmations: Object.fromEntries(workflow.steps[0].requiredConfirmations.map(check => [check.id, true])), notes: 'Synthetic phase confirmation.' });
    const routed = await server.submitCameraFrame(newFrame(session.id, image, randomUUID(), state.session.revision), session.id, assessor);
    const proposalAssessor = (kind: 'reopen_phase' | 'within_phase'): CameraAssessor => async input => {
      calls++; const value = assessment(input.frame.stepId, 'after', 'same_scene', input.session); value.decisionKind = 'propose_plan_change'; value.operatorReview = null;
      value.comparison = { predictionId: input.session.reasoning!.activePredictionId!, status: 'contradicted', evidenceObservationIds: ['label'], failedConditions: ['The declared route remains blocked.'], unknownConditions: [] };
      value.planChange = { parentPlanVersion: input.session.plan!.current.id, kind, reopenStepId: kind === 'reopen_phase' ? workflow.steps[0].id : null,
        substeps: kind === 'within_phase' ? [{ instruction: 'Inspect one labelled crossing before releasing its clip.', preconditions: ['The cable remains unpowered and supported.'], expectedVisibleResult: 'The crossing label and path are distinguishable.', stopCondition: 'Stop if support or identity becomes uncertain.' }] : [],
        counterevidenceIds: [`comparison:${input.turnId}`], rationale: 'Resolve the owned contradiction while preserving mandatory catalog checks.' }; return { assessment: value, trace };
    };
    const proposed = await server.submitCameraFrame(newFrame(session.id, afterImage, randomUUID(), routed.session.revision, 'after'), session.id, proposalAssessor('reopen_phase'));
    const proposal = proposed.session.plan!.proposals[0]; assert.equal(proposal.version.revision, proposed.session.revision);
    const accept = { action: 'plan_accept', expectedRevision: proposed.session.revision, proposalId: proposal.id, operatorConfirmed: true, clientOperationId: randomUUID() };
    assert.throws(() => server.patchCameraSession(request(session.id), session.id, { ...accept, proposalId: 'plan-change:foreign' }), status(409));
    const accepted = server.patchCameraSession(request(session.id), session.id, accept);
    assert.equal(accepted.session.currentStepId, workflow.steps[0].id); assert.equal(accepted.session.completedSteps.length, 0);
    assert.equal(accepted.session.beforeTurn, null); assert.equal(accepted.session.latestTurn, null); assert.equal(accepted.session.reasoning!.activePredictionId, null);
    assert.equal(accepted.session.plan!.history.length, 1); assert.equal(accepted.session.plan!.current.mandatoryObligations, proposed.session.plan!.current.mandatoryObligations);
    const fresh = await server.submitCameraFrame(newFrame(session.id, image, randomUUID(), accepted.session.revision), session.id, assessor);
    const freshAfter = await server.submitCameraFrame(newFrame(session.id, afterImage, randomUUID(), fresh.session.revision, 'after'), session.id, assessor);
    state = server.patchCameraSession(request(session.id), session.id, { action: 'confirm', expectedRevision: freshAfter.session.revision, turnId: freshAfter.turn.id,
      confirmations: Object.fromEntries(workflow.steps[0].requiredConfirmations.map(check => [check.id, true])), notes: 'An explicitly reopened phase needs new actual checks.' });
    assert.equal(state.session.currentStepId, workflow.steps[1].id);
    const replay = server.patchCameraSession(request(session.id), session.id, accept);
    assert.equal(replay.session.currentStepId, workflow.steps[1].id); assert.equal(replay.session.revision, state.session.revision, 'An uncertain approval retry cannot rewind the phase.');
    const routedAgain = await server.submitCameraFrame(newFrame(session.id, image, randomUUID(), state.session.revision), session.id, assessor);
    const within = await server.submitCameraFrame(newFrame(session.id, afterImage, randomUUID(), routedAgain.session.revision, 'after'), session.id, proposalAssessor('within_phase'));
    const currentProposal = within.session.plan!.proposals.at(-1)!;
    const changed = await server.submitCameraFrame(newFrame(session.id, afterImage, randomUUID(), within.session.revision, 'after'), session.id, async input => {
      calls++; const value = assessment(input.frame.stepId, 'after', 'same_scene', input.session); value.decisionKind = 'hold'; value.operatorReview = null;
      value.comparison = { predictionId: input.session.reasoning!.activePredictionId!, status: 'unresolved', evidenceObservationIds: ['label'], failedConditions: [], unknownConditions: ['The target needs another view.'] };
      value.hold = { reason: 'A newer view changed the available information.', resumeWhen: 'A fresh proposal addresses this exact view.' }; return { assessment: value, trace };
    });
    assert.throws(() => server.patchCameraSession(request(session.id), session.id, { ...accept, expectedRevision: changed.session.revision, proposalId: currentProposal.id, clientOperationId: randomUUID() }), status(409));
    assert.equal(changed.session.plan!.current.id, accepted.session.plan!.current.id);
  } else if (scenario === 'durable-owned-retrieval') {
    const { session, before, after, thirdImage } = await archiveFixture();
    const beforeBudget = store.get<StoredCameraSession>('camera_sessions', session.id)!.executionBudget!;
    assert.equal(beforeBudget.invocations.length, 0, 'Setup assessors are explicit software stubs, not model invocations.');
    const bodies: Record<string, any>[] = [], reservations: string[] = [];
    const sdk = sdkResponses(body => {
      const state = durableReservation(session.id);
      reservations.push(state.invocation.invocationId); bodies.push(body);
      if (bodies.length === 1) {
        assert.equal(state.budget.invocations.length, 1); assert.equal(state.invocation.parentInvocationId, null);
        const context = JSON.parse(body.input[0].content[0].text);
        assert.equal(context.evidenceCatalog.length, 1); assert.equal(context.evidenceCatalog[0].frameId, before.turn.frameId);
        assert.equal(context.previousTurn.frameId, after.turn.frameId);
        assert.notEqual(context.frame.id, before.turn.frameId); assert.notEqual(context.frame.id, after.turn.frameId);
        assert.equal(context.evidenceCatalog[0].captureTimeStatus, 'unknown_actual_capture_time');
        assert.equal(body.tools[0].name, 'read_owned_evidence');
        return sdkEvidence(before.turn.frameId, 'durable-read-response');
      }
      assert.equal(bodies.length, 2); assert.equal(state.budget.invocations.length, 2); assert.equal(state.budget.tools.length, 1);
      assert.equal(state.invocation.parentInvocationId, reservations[0]);
      assert.equal(body.previous_response_id, 'durable-read-response'); assert.deepEqual(body.tools, []); assert.equal(body.tool_choice, undefined);
      const result = body.input[0]; assert.equal(result.type, 'function_call_output'); assert.equal(result.call_id, 'owned-evidence-call');
      const manifest = JSON.parse(result.output).evidenceManifest;
      assert.equal(manifest.sourceFrameId, before.turn.frameId); assert.equal(manifest.sourceSha256, store.bytesHash(image));
      assert.equal(manifest.role, 'historical'); assert.equal(manifest.retrievedForTurnId, state.pending.id);
      assert.equal(manifest.captureTimeStatus, 'unknown_actual_capture_time'); assert.equal(manifest.capturedAt, null);
      assert.equal(manifest.freshness, 'historical_not_refreshed_by_retrieval');
      assert.equal(manifest.transformation, 'crop_png'); assert.deepEqual(manifest.derivedPixels, { width: 16, height: 16 });
      const derived = Buffer.from(body.input[1].content[1].image_url.split(',')[1], 'base64');
      assert.equal(store.bytesHash(derived), manifest.derivedSha256);
      return sdkFinal(session.id, 'durable-final-response', 'after');
    });
    try {
      const response = await frameRoute(newFrame(session.id, thirdImage, randomUUID(), after.session.revision, 'after'), context(session.id));
      assert.equal(response.status, 200); const result = await response.json();
      assert.equal(result.turn.status, 'completed'); assert.equal(bodies.length, 2);
      assert.equal(JSON.stringify(bodies).includes(store.assetRoot), false);
      assert.equal(result.session.currentStepId, workflow.steps[0].id); assert.equal(result.session.completedSteps.length, 0);
      assert.equal(result.session.guidance.canConfirm, true); assert.equal(result.session.beforeTurn.id, before.turn.id);
      const saved = store.get<StoredCameraSession>('camera_sessions', session.id)!;
      const budget = saved.executionBudget!;
      assert.equal(budget.createdAt, beforeBudget.createdAt); assert.equal(budget.deadlineAt, beforeBudget.deadlineAt);
      assert.deepEqual(budget.invocations.map(item => item.responseId), ['durable-read-response', 'durable-final-response']);
      assert.deepEqual(budget.invocations.map(item => item.status), ['responded', 'responded']);
      assert.equal(budget.tools.length, 1); assert.equal(budget.invocations.reduce((sum, item) => sum + (item.usage?.totalTokens || 0), 0), 28);
      assert.deepEqual(result.turn.trace.responseIds, ['durable-read-response', 'durable-final-response']);
      assert.equal(result.turn.trace.usage.length, 2); assert.equal(result.turn.trace.toolExecutions[0].result.status, 'completed');
      assert.equal(result.turn.trace.toolExecutions[0].result.manifest.sourceFrameId, before.turn.frameId);
      assert.equal(saved.reasoning!.activePredictionId, `prediction:${before.turn.id}`);
    } finally { sdk.mock.restore(); }
  } else if (scenario === 'durable-shared-budget') {
    for (const limit of ['calls', 'output', 'deadline'] as const) {
      const session = project();
      session.executionBudget = createBudget(session.id, { ...cameraBudgetLimits,
        ...(limit === 'calls' ? { maxInvocations: 1 } : limit === 'output' ? { maxOutputTokens: 6000 } : {}) });
      store.replace('camera_sessions', session);
      let posts = 0;
      const sdk = sdkResponses(() => { posts++; durableReservation(session.id); return sdkFinal(session.id, `initial-${limit}`, 'before'); });
      let clock: ReturnType<typeof mock.method<typeof Date, 'now'>> | undefined;
      try {
        const first = await frameRoute(newFrame(session.id, image), context(session.id)); assert.equal(first.status, 200);
        const body = await first.json(); assert.equal(body.turn.status, 'completed'); assert.equal(posts, 1);
        const used = structuredClone(store.get<StoredCameraSession>('camera_sessions', session.id)!.executionBudget!);
        if (limit === 'deadline') clock = mock.method(Date, 'now', () => used.deadlineAt);
        const files = await frameFiles();
        const blocked = await frameRoute(newFrame(session.id, afterImage, randomUUID(), body.session.revision, 'before'), context(session.id));
        assert.equal(blocked.status, 429); assert.equal(posts, 1);
        assert.equal(store.list('camera_turns', session.id).length, 1); assert.deepEqual(await frameFiles(), files);
        const resetResponse = await patchRoute(request(session.id, 'PATCH', { action: 'facts', expectedRevision: body.session.revision, facts }), context(session.id));
        assert.equal(resetResponse.status, 200); const reset = await resetResponse.json();
        assert.deepEqual(store.get<StoredCameraSession>('camera_sessions', session.id)!.executionBudget, used, 'Resetting facts cannot refill an already-used run budget.');
        const stillBlocked = await frameRoute(newFrame(session.id, afterImage, randomUUID(), reset.session.revision, 'before'), context(session.id));
        assert.equal(stillBlocked.status, 429); assert.equal(posts, 1); assert.equal(store.list('camera_turns', session.id).length, 1);
        assert.deepEqual(await frameFiles(), files);
      } finally { clock?.mock.restore(); sdk.mock.restore(); }
    }
  } else if (scenario === 'durable-retrieval-reset') {
    const { session, before, after, thirdImage } = await archiveFixture();
    let oldPosts = 0, oldContinuationPosts = 0, newerPosts = 0, resetDone = false;
    let newWork: ReturnType<typeof server.submitCameraFrame> | null = null, newerTurnId: string | null = null;
    let enteredNew!: () => void, releaseNew!: () => void;
    const newPosted = new Promise<void>(resolve => { enteredNew = resolve; });
    const newWait = new Promise<void>(resolve => { releaseNew = resolve; });
    const sdk = sdkResponses(async body => {
      const state = durableReservation(session.id);
      if (body.previous_response_id) { oldContinuationPosts++; throw new Error('The superseded second invocation must not reach SDK POST.'); }
      const current = JSON.parse(body.input[0].content[0].text);
      if (current.frame.purpose === 'after') { oldPosts++; return sdkEvidence(before.turn.frameId, 'old-read-response'); }
      newerPosts++; newerTurnId = state.pending.id;
      assert.equal(state.budget.invocations.length, 3, 'Both old reservations must precede the new capture reservation.');
      enteredNew(); await newWait;
      return sdkFinal(session.id, 'newer-current-response', 'before');
    });
    try {
      const interrupted: CameraAssessor = async input => {
        const binding = input.execution!;
        return assessCameraFrame({ ...input, execution: { ...binding, onBudget: async (incoming, checkpoint) => {
          const merged = await binding.onBudget?.(incoming, checkpoint);
          const current = incoming.invocations.find(item => item.invocationId === `${input.turnId}:camera:1`);
          if (!resetDone && checkpoint === 'reserve' && current?.status === 'reserved') {
            resetDone = true;
            const saved = store.get<StoredCameraSession>('camera_sessions', session.id)!;
            assert.equal(saved.executionBudget!.invocations.length, 2, 'The second reservation is durable before the reset.');
            const reset = server.patchCameraSession(request(session.id), session.id, { action: 'facts', expectedRevision: saved.revision, facts });
            newWork = server.submitCameraFrame(newFrame(session.id, image, randomUUID(), reset.session.revision), session.id);
            await Promise.race([newPosted, newWork.then(() => { throw new Error('The newer API check ended before its durable SDK reservation.'); })]);
          }
          return merged;
        } } });
      };
      const old = await server.submitCameraFrame(newFrame(session.id, thirdImage, randomUUID(), after.session.revision, 'after'), session.id, interrupted);
      assert.equal(resetDone, true); assert.equal(oldPosts, 1); assert.equal(oldContinuationPosts, 0); assert.equal(newerPosts, 1);
      assert.equal(old.turn.status, 'superseded'); assert.equal(old.turn.trace?.providerResponseId, 'old-read-response');
      assert.deepEqual(old.turn.trace?.responseIds, ['old-read-response']);
      assert.equal((old.turn.trace?.toolExecutions?.[0].result as { status: string }).status, 'completed');
      const during = store.get<StoredCameraSession>('camera_sessions', session.id)!;
      assert.equal(during.activeTurnId, newerTurnId); assert.equal(during.executionBudget!.invocations.length, 3);
      assert.equal(during.executionBudget!.invocations.find(item => item.invocationId === `${old.turn.id}:camera:1`)!.status, 'unknown');
      assert.equal(during.executionBudget!.invocations.find(item => item.invocationId === `${newerTurnId}:camera:0`)!.status, 'reserved');
      const originalDeadline = during.executionBudget!.deadlineAt;
      releaseNew(); assert.ok(newWork); const newer = await (newWork as ReturnType<typeof server.submitCameraFrame>);
      assert.equal(newer.turn.status, 'completed'); assert.equal(newer.session.latestTurn?.id, newerTurnId);
      const final = store.get<StoredCameraSession>('camera_sessions', session.id)!;
      assert.equal(final.executionBudget!.invocations.length, 3); assert.equal(final.executionBudget!.deadlineAt, originalDeadline);
      assert.equal(final.executionBudget!.invocations.find(item => item.invocationId === `${old.turn.id}:camera:1`)!.status, 'unknown');
      assert.equal(final.executionBudget!.invocations.find(item => item.invocationId === `${newerTurnId}:camera:0`)!.responseId, 'newer-current-response');
      assert.equal(final.executionBudget!.invocations.reduce((sum, item) => sum + (item.usage?.totalTokens || 0), 0), 28);
      assert.equal(oldContinuationPosts, 0);
    } finally { releaseNew?.(); sdk.mock.restore(); }
  } else if (scenario === 'reserved-continuation-reset') {
    const session = project(); let posts = 0;
    const sdk = mock.method(OpenAI.prototype, 'post', (() => { posts++; throw new Error('A replaced continuation must not reach the SDK.'); }) as unknown as typeof OpenAI.prototype.post);
    const { createExecutionBudget, DEFAULT_CAMERA_EXECUTION_LIMITS, reserveInvocation, recordInvocationResponse } = await import('../../src/meta/budget');
    try {
      const result = await server.submitCameraFrame(newFrame(session.id, image), session.id, async input => {
        const spec = { invocationId: 'invocation-first', parentInvocationId: null, role: 'camera_observe_decide', route: 'camera_reasoning' as const,
          model: 'muse-spark-1.3', contextHash: 'a'.repeat(64), promptVersion: 'offline-fixture', schemaVersion: '3.0.0', toolVersion: 'offline-fixture', maxOutputTokens: 6000, inputBytes: 100 };
        let budget = reserveInvocation(createExecutionBudget(input.runId, DEFAULT_CAMERA_EXECUTION_LIMITS), spec).state;
        budget = recordInvocationResponse(budget, spec.invocationId, trace.providerResponseId!, trace.usage);
        budget = reserveInvocation(budget, { ...spec, invocationId: 'invocation-continuation', parentInvocationId: spec.invocationId }).state;
        const reserved = { ...trace, executionBudget: budget, modelInvocationId: 'invocation-continuation' };
        await input.onTrace?.(reserved);
        server.patchCameraSession(request(session.id), session.id, { action: 'facts', expectedRevision: session.revision, facts });
        await input.onTrace?.(reserved);
        await new OpenAI({ apiKey: 'offline-never-post' }).responses.create({ model: 'muse-spark-1.3', input: 'This SDK continuation must be fenced.' });
        throw new Error('A replaced continuation was admitted.');
      });
      assert.equal(posts, 0); assert.equal(result.turn.status, 'superseded'); assert.equal(result.turn.trace?.providerResponseId, trace.providerResponseId);
      assert.equal(result.session.latestTurn, null); assert.equal(result.session.guidance.actionable, false);
    } finally { sdk.mock.restore(); }
  } else if (scenario === 'mixed-decision') {
    const session = project();
    const invalid: CameraAssessor = async input => {
      calls++; await input.onTrace?.(trace);
      const value = assessment(input.frame.stepId, 'before');
      value.viewRequest = { instruction: 'Ask for a closer view.', whyNeeded: 'The identity is uncertain.', resolves: 'The target identity.', targetObservationIds: ['label'] };
      return { assessment: value, trace };
    };
    const result = await server.submitCameraFrame(newFrame(session.id, image), session.id, invalid);
    assert.equal(result.turn.status, 'failed'); assert.equal(result.turn.trace?.providerResponseId, trace.providerResponseId);
    assert.deepEqual(result.turn.trace?.usage, trace.usage); assert.equal(result.session.latestTurn, null);
    assert.equal(result.session.beforeTurn, null); assert.equal(result.session.activeTurnId, null);
    assert.equal(result.session.guidance.actionable, false); assert.equal(result.session.completedSteps.length, 0); assert.equal(calls, 1);
  } else if (scenario === 'prediction-context') {
    const session = project();
    const thirdPath = path.join(root, 'green.png');
    await run('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=green:s=32x32', '-frames:v', '1', '-threads', '1', thirdPath], { timeout: 10_000 });
    const thirdImage = await readFile(thirdPath);
    const before = await server.submitCameraFrame(newFrame(session.id, image), session.id, assessor);
    const correction = await server.submitCameraFrame(newFrame(session.id, afterImage, randomUUID(), before.session.revision, 'after'), session.id, async input => {
      calls++; const value = assessment(input.frame.stepId, 'before', 'same_scene');
      value.actionProposal!.expectedVisibleResult = 'A later correction prediction must not replace the original prediction.';
      return { assessment: value, trace };
    });
    assert.equal(correction.session.beforeTurn?.id, before.turn.id);
    let posts = 0, sent: Record<string, any> | null = null;
    const sdk = mock.method(OpenAI.prototype, 'post', ((_url: string, options: Record<string, unknown>) => {
      posts++;
      const result = Promise.resolve(options).then(resolved => {
        const body = resolved.body as { input: { content: { type: string; text?: string }[] }[] };
        sent = JSON.parse(body.input[0].content.find(part => part.type === 'input_text')!.text!);
        return { id: 'resp_original_prediction_context', model: 'offline-camera-model', status: 'completed', usage: { total_tokens: 7 },
          output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(assessment(workflow.steps[0].id, 'after')) }] }] };
      });
      return { _thenUnwrap: (unwrap: (value: unknown) => unknown) => result.then(unwrap) };
    }) as unknown as typeof OpenAI.prototype.post);
    try {
      const after = await server.submitCameraFrame(newFrame(session.id, thirdImage, randomUUID(), correction.session.revision, 'after'), session.id);
      const context = sent as unknown as Record<string, any>;
      assert.equal(posts, 1); assert.equal(after.turn.status, 'completed', after.turn.error || '');
      assert.equal(context.identity.runId, session.id); assert.equal(context.identity.turnId, after.turn.id);
      assert.equal(context.previousTurn.id, correction.turn.id, 'The attached reference may be the latest after view.');
      assert.equal(context.originalPrediction.predictionId, `prediction:${before.turn.id}`);
      assert.equal(context.originalPrediction.actionTurnId, before.turn.id);
      assert.equal(context.originalPrediction.frameSha256, before.frames[0].sha256);
      assert.ok(isCameraDecisionAssessment(before.turn.assessment));
      assert.equal(context.originalPrediction.expectedVisibleResult, before.turn.assessment.actionProposal!.expectedVisibleResult);
      assert.notEqual(context.originalPrediction.expectedVisibleResult, 'A later correction prediction must not replace the original prediction.');
      assert.equal(after.session.beforeTurn?.id, before.turn.id);
    } finally { sdk.mock.restore(); }
  } else if (scenario === 'prediction-ownership') {
    const session = project();
    const before = await server.submitCameraFrame(newFrame(session.id, image), session.id, assessor);
    const after = await server.submitCameraFrame(newFrame(session.id, afterImage, randomUUID(), before.session.revision, 'after'), session.id, assessor);
    const changed = store.get<StoredCameraTurn>('camera_turns', before.turn.id)!;
    assert.ok(isCameraDecisionAssessment(changed.assessment));
    changed.assessment.actionProposal!.expectedVisibleResult = 'A substituted prediction cannot become the original action.';
    store.replace('camera_turns', changed);
    await assert.rejects(server.submitCameraFrame(newFrame(session.id, afterImage, randomUUID(), after.session.revision, 'after'), session.id, assessor), status(409));
    assert.equal(calls, 2, 'An owned latest comparison cannot hide a changed original action.');
    assert.equal(store.list('camera_turns', session.id).length, 2); assert.equal((await frameFiles()).length, 2);
  } else if (scenario === 'legacy-decision') {
    const session = project();
    const before = await server.submitCameraFrame(newFrame(session.id, image), session.id, assessor);
    const historical = store.get<StoredCameraSession>('camera_sessions', session.id)!;
    const legacyAssessment = { summary: 'Historical synthetic mixed intent; never converted to a v2 decision.', frameQuality: 'clear' as const, continuity: 'first_view' as const,
      observations: [{ id: 'label', label: 'Historical label', detail: 'Preserved synthetic earlier contract.', box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }],
      stepStatus: 'needs_information' as const, nextAction: { kind: 'perform' as const, instruction: 'Historical physical proposal.',
        expectedVisibleResult: 'Historical result.', stopCondition: 'Historical stop.', targetObservationIds: ['label'] },
      questions: ['Which branch is this?'], suggestedStepId: workflow.steps[0].id };
    historical.workflowSpec!.schemaVersion = '1.0.0'; historical.workflowSpec!.engineVersion = '1.2.0';
    historical.beforeTurn!.assessment = structuredClone(legacyAssessment); historical.latestTurn!.assessment = structuredClone(legacyAssessment);
    for (const saved of [historical.beforeTurn!, historical.latestTurn!]) { delete saved.decisionId; delete saved.requestId; delete saved.predictionId; }
    store.replace('camera_sessions', historical);
    const oldTurn = store.get<StoredCameraTurn>('camera_turns', before.turn.id)!;
    oldTurn.assessment = legacyAssessment; oldTurn.checksVersion!.schemaVersion = '1.0.0'; oldTurn.checksVersion!.engineVersion = '1.2.0';
    delete oldTurn.decisionId; delete oldTurn.requestId; delete oldTurn.predictionId; store.replace('camera_turns', oldTurn);
    const state = server.cameraState(request(session.id), session.id);
    assert.equal(state.session.requiresReconfirmation, true); assert.equal(state.session.guidance.actionable, false); assert.equal(state.session.guidance.canConfirm, false);
    assert.deepEqual(state.turns[0].assessment, legacyAssessment); assert.equal(state.turns[0].decisionId, undefined);
    assert.deepEqual(store.get('camera_sessions', session.id), historical, 'Reading old mixed intent cannot invent a current decision or revise history.');
    await assert.rejects(server.submitCameraFrame(newFrame(session.id, afterImage, randomUUID(), state.session.revision, 'after'), session.id, assessor), status(409));
    const reset = server.patchCameraSession(request(session.id), session.id, { action: 'facts', expectedRevision: state.session.revision, facts });
    assert.equal(reset.session.requiresReconfirmation, false); assert.equal(reset.session.beforeTurn, null); assert.equal(reset.session.latestTurn, null);
    assert.deepEqual(reset.turns[0].assessment, legacyAssessment); assert.equal(calls, 1);
  } else if (scenario === 'cycle') {
    const session = project(), operation = randomUUID();
    const before = await server.submitCameraFrame(newFrame(session.id, image, operation), session.id, assessor);
    assert.equal(calls, 1); assert.equal(before.session.revision, 2); assert.equal(before.session.completedSteps.length, 0);
    assert.equal(before.turn.status, 'completed'); assert.equal(before.session.guidance.actionable, true);
    const replay = await server.submitCameraFrame(newFrame(session.id, image, operation), session.id, assessor);
    assert.equal(replay.turn.id, before.turn.id); assert.equal(calls, 1);
    await assert.rejects(server.submitCameraFrame(newFrame(session.id, afterImage, operation), session.id, assessor), status(409));
    const frame = before.frames[0];
    assert.equal('storageKey' in frame, false); assert.equal('projectId' in frame, false);
    const retrieved = await imageRoute(request(session.id), { params: Promise.resolve({ id: session.id, frameId: frame.id }) });
    assert.equal(retrieved.status, 200); assert.deepEqual(Buffer.from(await retrieved.arrayBuffer()), image);
    assert.equal((await imageRoute(request(session.id, 'GET', undefined, stranger), { params: Promise.resolve({ id: session.id, frameId: frame.id }) })).status, 404);
    const after = await server.submitCameraFrame(newFrame(session.id, afterImage, randomUUID(), 2, 'after'), session.id, assessor);
    assert.equal(after.session.guidance.canConfirm, true); assert.equal(after.session.completedSteps.length, 0);
    const confirmations = Object.fromEntries(workflow.steps[0].requiredConfirmations.map(check => [check.id, true]));
    let release!: () => void, started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const newer = server.submitCameraFrame(newFrame(session.id, afterImage, randomUUID(), 3, 'after'), session.id, async input => { started(); await wait; return assessor(input); });
    await entered;
    assert.throws(() => server.patchCameraSession(request(session.id), session.id, { action: 'confirm', expectedRevision: 3,
      turnId: after.turn.id, confirmations, notes: 'Cannot confirm an old view while a newer one is being inspected.' }), status(409));
    release(); const fresh = await newer;
    const confirmed = server.patchCameraSession(request(session.id), session.id, { action: 'confirm', expectedRevision: 4, turnId: fresh.turn.id,
      confirmations, notes: 'Synthetic state regression only; no actual physical trial.' });
    assert.equal(confirmed.session.completedSteps.length, 1); assert.equal(confirmed.session.currentStepId, workflow.steps[1].id);
    assert.equal(confirmed.session.status, 'active'); assert.equal(confirmed.session.guidance.actionable, false);
    assert.equal(store.list('trials').length, 0);
    assert.equal(calls, 3);
    // Use the real adapter with an offline SDK boundary for the second step.
    // It must actually attach the prior reviewed frame, not force first_view.
    let providerFinishedAt = 0;
    const sdk = mock.method(OpenAI.prototype, 'post', ((requestPath: string, options: Record<string, unknown>) => {
      assert.equal(requestPath, '/responses');
      const response = { id: 'resp_offline_second_step', model: 'offline', status: 'completed', usage: { total_tokens: 8 },
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(assessment(workflow.steps[1].id, 'before', 'same_scene')) }] }] };
      const result = Promise.resolve(options).then(async resolved => {
        const body = resolved.body as { input: { content: { type: string }[] }[] };
        assert.equal(body.input[0].content.filter(item => item.type === 'input_image').length, 2);
        await new Promise(resolve => setTimeout(resolve, 40));
        providerFinishedAt = Date.now();
        return response;
      });
      return { _thenUnwrap: (unwrap: (value: unknown) => unknown) => result.then(unwrap) };
    }) as unknown as typeof OpenAI.prototype.post);
    try {
      const secondResponse = await frameRoute(newFrame(session.id, image, randomUUID(), confirmed.session.revision), context(session.id));
      assert.equal(secondResponse.status, 200);
      const secondStep = await secondResponse.json();
      responseTiming(secondStep);
      assert.ok(secondStep.serverProcessingMs >= 35, 'backend inference wait belongs to server processing time');
      assert.ok(Date.parse(secondStep.serverNow) >= providerFinishedAt, 'server clock must be captured after the inference');
      assert.equal(secondStep.turn.status, 'completed'); assert.equal(secondStep.session.guidance.actionable, true);
      assert.equal(secondStep.session.currentStepId, workflow.steps[1].id); assert.equal(secondStep.session.completedSteps.length, 1);
      assert.equal(sdk.mock.callCount(), 1);
    } finally { sdk.mock.restore(); }
  } else if (['before-request-reset', 'prepared-request-reset', 'before-request-expiry'].includes(scenario)) {
    const session = project();
    let posts = 0, release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const sdk = mock.method(OpenAI.prototype, 'post', (() => {
      posts++;
      throw new Error('A superseded or expired frame must never reach the provider.');
    }) as unknown as typeof OpenAI.prototype.post);
    const delayed: CameraAssessor = async input => {
      if (scenario !== 'prepared-request-reset') {
        entered(); await wait;
        return assessCameraFrame(input);
      }
      let checkpoints = 0;
      return assessCameraFrame({ ...input, onTrace: async value => {
        await input.onTrace?.(value);
        if (++checkpoints === 1) { entered(); await wait; }
      } });
    };
    try {
      const pending = server.submitCameraFrame(newFrame(session.id, image), session.id, delayed);
      await started;
      if (scenario === 'before-request-expiry') {
        const active = server.cameraState(request(session.id), session.id).session.activeTurnId!;
        const turn = store.get<StoredCameraTurn>('camera_turns', active)!;
        turn.createdAt = new Date(Date.now() - 6 * 60_000).toISOString(); store.replace('camera_turns', turn);
      } else {
        server.patchCameraSession(request(session.id), session.id, { action: 'facts', expectedRevision: 1,
          facts: { ...facts, minimum_bend_radius_mm: Number(facts.minimum_bend_radius_mm) + 1 } });
      }
      release();
      const result = await pending;
      assert.equal(posts, 0);
      assert.equal(result.turn.status, scenario === 'before-request-expiry' ? 'failed' : 'superseded');
      assert.equal(result.turn.trace?.providerResponseId, null);
      assert.equal(result.session.activeTurnId, null); assert.equal(result.session.latestTurn, null);
      assert.equal(result.session.revision, 2); assert.equal(result.session.completedSteps.length, 0);
    } finally { sdk.mock.restore(); }
  } else if (scenario === 'comparison-context' || scenario === 'comparison-hash') {
    const session = project();
    const before = await server.submitCameraFrame(newFrame(session.id, image), session.id, assessor);
    const failAfter: CameraAssessor = async () => { throw new MetaError('Synthetic after-view failure.', 'provider_error'); };
    const failed = await server.submitCameraFrame(newFrame(session.id, afterImage, randomUUID(), before.session.revision, 'after'), session.id, failAfter);
    assert.equal(failed.session.latestTurn, null); assert.equal(failed.session.beforeTurn?.id, before.turn.id);
    if (scenario === 'comparison-hash') {
      const descriptor = store.get<{ storageKey: string }>('camera_frames', before.turn.frameId)!;
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path.join(store.assetRoot, descriptor.storageKey), afterImage);
      const corrupted = await imageRoute(request(session.id), { params: Promise.resolve({ id: session.id, frameId: before.turn.frameId }) });
      assert.equal(corrupted.status, 409); assert.match(corrupted.headers.get('content-type')!, /application\/json/);
      assert.notDeepEqual(Buffer.from(await corrupted.arrayBuffer()), afterImage, 'a private GET cannot display changed pixels as the recorded evidence');
    }
    let posts = 0;
    let sentContent: { type: string; text?: string }[] = [];
    const sdk = mock.method(OpenAI.prototype, 'post', ((_url: string, options: Record<string, unknown>) => {
      posts++;
      if (scenario === 'comparison-hash') throw new Error('Corrupted comparison pixels must not reach the provider.');
      const response = { id: 'resp_camera_comparison_retry', model: 'offline-camera-model', status: 'completed', usage: { total_tokens: 7 },
        output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(assessment(workflow.steps[0].id, 'after')) }] }] };
      const result = Promise.resolve(options).then(resolved => {
        sentContent = (resolved.body as { input: { content: { type: string; text?: string }[] }[] }).input[0].content;
        return response;
      });
      return { _thenUnwrap: (unwrap: (value: unknown) => unknown) => result.then(unwrap) };
    }) as unknown as typeof OpenAI.prototype.post);
    try {
      const result = await server.submitCameraFrame(newFrame(session.id, afterImage, randomUUID(), failed.session.revision, 'after'), session.id);
      assert.equal(posts, scenario === 'comparison-hash' ? 0 : 1);
      if (scenario === 'comparison-context') {
        assert.equal(sentContent.filter(part => part.type === 'input_image').length, 2);
        const taskContext = sentContent.filter(part => part.type === 'input_text').map(part => part.text).join('\n');
        assert.ok(taskContext.includes(before.turn.id), 'the provider receives the actual retained comparison turn');
        assert.ok(taskContext.includes(before.frames[0].sha256), 'the provider receives that exact frame hash');
        assert.ok(isCameraDecisionAssessment(before.turn.assessment));
        assert.ok(taskContext.includes(before.turn.assessment.actionProposal!.expectedVisibleResult), 'the provider receives the prior expected result');
      }
      assert.equal(result.turn.status, scenario === 'comparison-hash' ? 'failed' : 'completed', JSON.stringify({ error: result.turn.error, trace: result.turn.trace }));
      assert.deepEqual(result.turn.comparison, { turnId: before.turn.id, frameId: before.turn.frameId,
        sha256: before.frames[0].sha256, stepId: workflow.steps[0].id, revision: 1, sceneEpoch: 1 });
      assert.equal(result.session.guidance.canConfirm, scenario === 'comparison-context');
    } finally { sdk.mock.restore(); }
  } else if (scenario === 'comparison-ownership') {
    const mutate = [
      (turn: StoredCameraTurn) => { turn.projectId = randomUUID(); },
      (turn: StoredCameraTurn) => { turn.sceneEpoch++; },
      (turn: StoredCameraTurn) => { turn.frameId = randomUUID(); },
      (turn: StoredCameraTurn) => { turn.revision++; },
      (turn: StoredCameraTurn) => { turn.stepId = workflow.steps[1].id; },
    ];
    for (const change of mutate) {
      const session = project();
      const before = await server.submitCameraFrame(newFrame(session.id, image), session.id, assessor);
      const saved = store.get<StoredCameraTurn>('camera_turns', before.turn.id)!; change(saved); store.replace('camera_turns', saved);
      const filesBefore = await frameFiles(), callsBefore = calls;
      await assert.rejects(server.submitCameraFrame(newFrame(session.id, afterImage, randomUUID(), before.session.revision, 'after'), session.id, assessor), status(409));
      assert.equal(calls, callsBefore); assert.equal(store.list('camera_frames', session.id).length, 1);
      assert.deepEqual(await frameFiles(), filesBefore);
    }
  } else if (scenario === 'workflow-upgrade') {
    const fragment = cameraWorkflow('fragment_dry_fit')!;
    const currentDefinition = structuredClone(fragment);
    const oldFacts = { ...cameraSyntheticFacts.fragment_dry_fit };
    delete oldFacts.maximum_outline_error_mm;
    try {
      // Build and complete a run under the actual earlier fragment criteria.
      fragment.requiredFacts = fragment.requiredFacts.filter(fact => fact.id !== 'maximum_outline_error_mm');
      for (const step of fragment.steps) {
        step.requiredFactIds = step.requiredFactIds.filter(fact => fact !== 'maximum_outline_error_mm');
        step.measurements = step.measurements?.filter(measurement => measurement.relation !== 'within_tolerance');
      }
      const created = server.createOwnedCameraSession({ workflowId: fragment.id, facts: oldFacts }, owner);
      let state = server.cameraState(request(created.id), created.id);
      for (const step of fragment.steps) {
        const before = await server.submitCameraFrame(newFrame(created.id, image, randomUUID(), state.session.revision), created.id, assessor);
        const after = await server.submitCameraFrame(newFrame(created.id, afterImage, randomUUID(), before.session.revision, 'after'), created.id, assessor);
        state = server.patchCameraSession(request(created.id), created.id, { action: 'confirm', expectedRevision: after.session.revision,
          turnId: after.turn.id, confirmations: Object.fromEntries(step.requiredConfirmations.map(check => [check.id, true])),
          measurements: syntheticCameraMeasurements(fragment.id, step.id), notes: 'Synthetic historical criteria regression, not physical evidence.' });
      }
      assert.equal(state.session.status, 'operator_reviewed_complete');
      const historical = store.get<StoredCameraSession>('camera_sessions', created.id)!;
      assert.notEqual(historical.workflowSpec!.definition, fragment);
      Object.assign(fragment, currentDefinition);
      const callsBefore = calls;
      const held = server.cameraState(request(created.id), created.id);
      assert.equal(held.session.requiresReconfirmation, true); assert.equal(held.session.status, 'operator_reviewed_complete');
      assert.equal(held.session.completedSteps.length, fragment.steps.length); assert.equal(held.session.guidance.canConfirm, false);
      assert.equal(held.session.guidance.actionable, false); assert.equal(held.session.facts.maximum_outline_error_mm, undefined);
      assert.equal(held.historicalWorkflow?.requiredFacts.some(fact => fact.id === 'maximum_outline_error_mm'), false);
      assert.equal(held.workflow.requiredFacts.some(fact => fact.id === 'maximum_outline_error_mm'), true);
      assert.deepEqual(store.get('camera_sessions', created.id), historical, 'reading an old run cannot relabel its criteria');
      const lastTurn = historical.completedSteps.at(-1)!.afterTurnId;
      for (const action of [
        { action: 'undo' },
        { action: 'confirm', turnId: lastTurn, confirmations: {}, notes: 'Old results must not advance under new criteria.' },
        { action: 'review', turnId: lastTurn, outcome: 'incomplete', confirmations: {}, notes: 'Old results must remain historical.' },
      ]) assert.throws(() => server.patchCameraSession(request(created.id), created.id, { ...action, expectedRevision: historical.revision }), status(409));
      await assert.rejects(server.submitCameraFrame(newFrame(created.id, image, randomUUID(), historical.revision), created.id, assessor), status(409));
      assert.equal(calls, callsBefore); assert.deepEqual(store.get('camera_sessions', created.id), historical);
      const reset = server.patchCameraSession(request(created.id), created.id, { action: 'facts', expectedRevision: historical.revision, facts: oldFacts });
      assert.equal(reset.session.requiresReconfirmation, false); assert.equal(reset.session.sceneEpoch, historical.sceneEpoch + 1);
      assert.equal(reset.session.completedSteps.length, 0); assert.equal(reset.session.facts.maximum_outline_error_mm, undefined);
      assert.deepEqual(reset.session.reviews, historical.reviews, 'reset preserves the original review snapshots');
      assert.notEqual(reset.session.checksVersion!.workflowHash, held.session.checksVersion!.workflowHash);
      state = server.patchCameraSession(request(created.id), created.id, { action: 'facts', expectedRevision: reset.session.revision,
        facts: cameraSyntheticFacts.fragment_dry_fit });
      for (const step of fragment.steps.slice(0, 3)) {
        const before = await server.submitCameraFrame(newFrame(created.id, image, randomUUID(), state.session.revision), created.id, assessor);
        const after = await server.submitCameraFrame(newFrame(created.id, afterImage, randomUUID(), before.session.revision, 'after'), created.id, assessor);
        const input = { action: 'confirm', expectedRevision: after.session.revision, turnId: after.turn.id,
          confirmations: Object.fromEntries(step.requiredConfirmations.map(check => [check.id, true])),
          notes: 'New outline readings cannot be inferred from historical review.' };
        if (step.id === 'resolve_reconstruction') {
          assert.throws(() => server.patchCameraSession(request(created.id), created.id, { ...input,
            measurements: { observed_worst_join_gap_mm: 0 } }), status(400));
          assert.equal(server.cameraState(request(created.id), created.id).session.completedSteps.length, 2);
          assert.equal(after.turn.checksVersion!.workflowHash, reset.session.checksVersion!.workflowHash);
        } else state = server.patchCameraSession(request(created.id), created.id, { ...input,
          measurements: syntheticCameraMeasurements(fragment.id, step.id) });
      }
    } finally { Object.assign(fragment, currentDefinition); }
  } else if (scenario === 'workflow-legacy') {
    const session = project();
    const before = await server.submitCameraFrame(newFrame(session.id, image), session.id, assessor);
    const legacy = store.get<StoredCameraSession>('camera_sessions', session.id)!;
    delete legacy.workflowSpec; store.replace('camera_sessions', legacy);
    const held = server.cameraState(request(session.id), session.id);
    assert.equal(held.session.requiresReconfirmation, true); assert.equal(held.session.checksVersion, null);
    assert.equal(held.historicalWorkflow, null); assert.equal(held.turns[0].id, before.turn.id);
    assert.equal(held.session.guidance.actionable, false); assert.deepEqual(store.get('camera_sessions', session.id), legacy);
    await assert.rejects(server.submitCameraFrame(newFrame(session.id, afterImage, randomUUID(), before.session.revision, 'after'), session.id, assessor), status(409));
    const reset = server.patchCameraSession(request(session.id), session.id, { action: 'facts', expectedRevision: legacy.revision, facts });
    assert.equal(reset.session.requiresReconfirmation, false); assert.ok(reset.session.checksVersion!.workflowHash);
    assert.equal(reset.session.sceneEpoch, legacy.sceneEpoch + 1); assert.equal(reset.turns.length, 1); assert.equal(calls, 1);
  } else if (scenario === 'workflow-pending-reset') {
    const session = project();
    let releaseOld!: () => void, oldEntered!: () => void;
    const oldStarted = new Promise<void>(resolve => { oldEntered = resolve; });
    const oldWait = new Promise<void>(resolve => { releaseOld = resolve; });
    const oldWork = server.submitCameraFrame(newFrame(session.id, image), session.id, async input => {
      calls++; await input.onTrace?.({ ...trace, providerResponseId: null }); oldEntered(); await oldWait;
      await input.onTrace?.(trace); return { assessment: assessment(input.frame.stepId, 'before'), trace };
    });
    await oldStarted;
    const legacy = store.get<StoredCameraSession>('camera_sessions', session.id)!;
    delete legacy.workflowSpec; store.replace('camera_sessions', legacy);
    const interrupted = store.get<StoredCameraTurn>('camera_turns', legacy.activeTurnId!)!;
    interrupted.createdAt = new Date(Date.now() - 6 * 60_000).toISOString(); store.replace('camera_turns', interrupted);
    const held = server.cameraState(request(session.id), session.id);
    assert.equal(held.session.requiresReconfirmation, true); assert.ok(held.session.activeTurnId);
    assert.deepEqual(store.get('camera_sessions', session.id), legacy, 'historical pending reads preserve the saved evidence');
    assert.throws(() => server.patchCameraSession(request(session.id), session.id, { action: 'facts', expectedRevision: legacy.revision,
      facts: { ...facts, minimum_bend_radius_mm: -1 } }), status(400));
    assert.deepEqual(store.get('camera_sessions', session.id), legacy, 'invalid reset facts cannot detach a live check');
    const reset = server.patchCameraSession(request(session.id), session.id, { action: 'facts', expectedRevision: legacy.revision, facts });
    assert.equal(reset.session.requiresReconfirmation, false); assert.equal(reset.session.activeTurnId, null);
    assert.equal(calls, 1, 'a facts reset never retries a provider request');
    assert.equal(reset.session.sceneEpoch, legacy.sceneEpoch + 1); assert.equal(reset.turns[0].status, 'superseded');
    let releaseNew!: () => void, newEntered!: () => void;
    const newStarted = new Promise<void>(resolve => { newEntered = resolve; });
    const newWait = new Promise<void>(resolve => { releaseNew = resolve; });
    const newWork = server.submitCameraFrame(newFrame(session.id, afterImage, randomUUID(), reset.session.revision), session.id, async input => {
      newEntered(); await newWait; return assessor(input);
    });
    await newStarted;
    const newPending = server.cameraState(request(session.id), session.id).session.activeTurnId;
    assert.ok(newPending); assert.notEqual(newPending, held.session.activeTurnId);
    releaseOld(); const late = await oldWork;
    assert.equal(late.turn.status, 'superseded'); assert.equal(late.turn.lateResult, true);
    assert.equal(late.turn.trace?.providerResponseId, trace.providerResponseId);
    assert.equal(late.session.activeTurnId, newPending); assert.equal(late.session.latestTurn, null);
    releaseNew(); const current = await newWork;
    assert.equal(current.turn.status, 'completed'); assert.equal(current.session.latestTurn?.id, current.turn.id);
    assert.equal(current.session.activeTurnId, null); assert.equal(current.session.guidance.actionable, true);
    assert.equal(calls, 2);
  } else if (scenario === 'prepared-workflow-upgrade' || scenario === 'paid-workflow-upgrade') {
    const original = structuredClone(workflow);
    const session = project();
    let release!: () => void, entered!: () => void, posts = 0;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const sdk = mock.method(OpenAI.prototype, 'post', ((_url: string, options: Record<string, unknown>) => {
      posts++;
      const response = { id: 'resp_offline_old_workflow', model: 'offline', status: 'completed', usage: { total_tokens: 7 },
        output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(assessment(workflow.steps[0].id, 'before')) }] }] };
      const result = Promise.resolve(options).then(async () => { entered(); await wait; return response; });
      return { _thenUnwrap: (unwrap: (value: unknown) => unknown) => result.then(unwrap) };
    }) as unknown as typeof OpenAI.prototype.post);
    const delayed: CameraAssessor = async input => {
      let checkpoints = 0;
      return assessCameraFrame({ ...input, onTrace: async value => {
        await input.onTrace?.(value);
        if (scenario === 'prepared-workflow-upgrade' && ++checkpoints === 1) { entered(); await wait; }
      } });
    };
    try {
      const pending = server.submitCameraFrame(newFrame(session.id, image), session.id, delayed);
      await started;
      workflow.completionChecks.push('New review criterion added while this request was in flight.');
      release(); const result = await pending;
      assert.equal(posts, scenario === 'paid-workflow-upgrade' ? 1 : 0);
      assert.equal(result.turn.status, 'superseded'); assert.equal(result.session.requiresReconfirmation, true);
      assert.equal(result.session.latestTurn, null); assert.equal(result.session.guidance.actionable, false);
      assert.equal(result.session.completedSteps.length, 0);
      assert.equal(result.turn.trace?.providerResponseId, scenario === 'paid-workflow-upgrade' ? 'resp_offline_old_workflow' : null);
    } finally { sdk.mock.restore(); Object.assign(workflow, original); }
  } else if (scenario === 'concurrent') {
    const session = project(), operation = randomUUID();
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const delayed: CameraAssessor = async input => { calls++; await wait; await input.onTrace?.(trace); return { assessment: assessment(input.frame.stepId, 'before'), trace }; };
    const first = server.submitCameraFrame(newFrame(session.id, image, operation), session.id, delayed);
    const second = server.submitCameraFrame(newFrame(session.id, image, operation), session.id, delayed);
    const replay = await Promise.race([first, second]);
    assert.equal(replay.pending, true); assert.equal(calls, 1);
    release(); const results = await Promise.all([first, second]);
    assert.equal(results[0].turn.id, results[1].turn.id);
    assert.equal(store.list('camera_frames', session.id).length, 1); assert.equal(store.list('camera_turns', session.id).length, 1);
    assert.equal((await frameFiles()).length, 1); assert.equal(calls, 1);
  } else if (scenario === 'stale' || scenario === 'expiry') {
    const session = project(), operation = randomUUID();
    let finish!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { finish = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const deferred: CameraAssessor = async input => { calls++; await input.onTrace?.({ ...trace, providerResponseId: null }); entered(); await waiting;
      await input.onTrace?.(trace); return { assessment: assessment(input.frame.stepId, 'before'), trace }; };
    const work = server.submitCameraFrame(newFrame(session.id, image, operation), session.id, deferred);
    await started;
    const duplicate = await server.submitCameraFrame(newFrame(session.id, image, operation), session.id, deferred);
    assert.equal(duplicate.pending, true); assert.equal(calls, 1);
    await assert.rejects(server.submitCameraFrame(newFrame(session.id, image), session.id, deferred), status(409));
    if (scenario === 'stale') {
      const revised = server.patchCameraSession(request(session.id), session.id, { action: 'facts', expectedRevision: 1,
        facts: { ...facts, target_port_map: 'Changed synthetic target map; new measurements required.' } });
      assert.equal(revised.session.revision, 2); assert.equal(revised.session.activeTurnId, null);
    } else {
      const saved = store.get<StoredCameraTurn>('camera_turns', duplicate.turn.id)!;
      saved.createdAt = new Date(Date.now() - 6 * 60_000).toISOString(); store.replace('camera_turns', saved);
      const expired = server.cameraState(request(session.id), session.id);
      assert.equal(expired.turns[0].status, 'failed'); assert.match(expired.turns[0].error!, /not be repeated automatically/);
      assert.equal(expired.session.activeTurnId, null);
      const replay = await server.submitCameraFrame(newFrame(session.id, image, operation), session.id, deferred);
      assert.equal(replay.turn.status, 'failed'); assert.equal(calls, 1);
    }
    finish(); const outcome = await work;
    assert.equal(outcome.session.latestTurn, null); assert.equal(outcome.session.completedSteps.length, 0);
    assert.equal(outcome.turn.trace?.providerResponseId, trace.providerResponseId);
    assert.equal(outcome.session.activeTurnId, null); assert.equal(calls, 1);
    if (scenario === 'stale') { assert.equal(outcome.turn.status, 'superseded'); assert.equal(outcome.session.revision, 2); }
    else { assert.equal(outcome.turn.status, 'failed'); assert.equal(outcome.turn.lateResult, true); assert.equal(outcome.session.revision, 2); }
  } else if (scenario === 'withdrawal-failure' || scenario === 'withdrawal-expiry') {
    const session = project();
    const before = await server.submitCameraFrame(newFrame(session.id, image), session.id, assessor);
    const ready = await server.submitCameraFrame(newFrame(session.id, afterImage, randomUUID(), 2, 'after'), session.id, assessor);
    assert.equal(ready.session.guidance.canConfirm, true);
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const deferred: CameraAssessor = async input => { calls++; entered(); await wait; await input.onTrace?.(trace);
      if (scenario === 'withdrawal-failure') { const error = new MetaError('Synthetic newer-view failure.', 'provider_error'); error.trace = trace; throw error; }
      return { assessment: assessment(input.frame.stepId, 'after'), trace }; };
    const pending = server.submitCameraFrame(newFrame(session.id, afterImage, randomUUID(), 3, 'after'), session.id, deferred);
    await started;
    const checking = server.cameraState(request(session.id), session.id);
    assert.equal(checking.session.guidance.actionable, false); assert.equal(checking.session.guidance.canConfirm, false);
    assert.equal(checking.session.latestTurn, null);
    if (scenario === 'withdrawal-expiry') {
      const current = store.get<StoredCameraTurn>('camera_turns', checking.session.activeTurnId!)!;
      current.createdAt = new Date(Date.now() - 6 * 60_000).toISOString(); store.replace('camera_turns', current);
      assert.equal(server.cameraState(request(session.id), session.id).session.revision, 4);
    }
    release(); const failed = await pending;
    assert.equal(failed.turn.status, 'failed'); assert.equal(failed.session.latestTurn, null);
    assert.equal(failed.session.guidance.canConfirm, false); assert.equal(failed.session.guidance.actionable, false);
    assert.equal(failed.session.revision, 4); assert.equal(failed.session.beforeTurn?.id, before.turn.id);
    const confirmations = Object.fromEntries(workflow.steps[0].requiredConfirmations.map(check => [check.id, true]));
    assert.throws(() => server.patchCameraSession(request(session.id), session.id, { action: 'confirm', expectedRevision: 4,
      turnId: ready.turn.id, confirmations, notes: 'An older view cannot confirm after a newer failed or unknown view.' }), status(409));
    const retry = await server.submitCameraFrame(newFrame(session.id, afterImage, randomUUID(), 4, 'after'), session.id, assessor);
    assert.equal(retry.session.guidance.canConfirm, true);
  } else if (scenario === 'validation') {
    const session = project();
    await assert.rejects(server.submitCameraFrame(newFrame(session.id, image, randomUUID(), 1, 'after'), session.id, assessor), status(409));
    await assert.rejects(server.submitCameraFrame(newFrame(session.id, image, randomUUID(), 2), session.id, assessor), status(409));
    await assert.rejects(server.submitCameraFrame(newFrame(session.id, image, randomUUID(), 1, 'before', { source: 'upload', capturedAt: new Date().toISOString() }), session.id, assessor), status(400));
    await assert.rejects(server.submitCameraFrame(newFrame(session.id, Buffer.alloc(301 * 1024)), session.id, assessor), status(413));
    const invalid = Buffer.from(image.subarray(0, image.indexOf(Buffer.from('IDAT')) + 4));
    await assert.rejects(server.submitCameraFrame(newFrame(session.id, invalid), session.id, assessor), status(415));
    const large = path.join(root, 'oversize.png');
    await run('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=blue:s=1700x32', '-frames:v', '1', '-threads', '1', large], { timeout: 10_000 });
    await assert.rejects(server.submitCameraFrame(newFrame(session.id, await readFile(large)), session.id, assessor), status(415));
    assert.equal(calls, 0); assert.equal(store.list('camera_frames', session.id).length, 0); assert.equal(store.list('camera_turns', session.id).length, 0);
    assert.deepEqual(await frameFiles(), []);
  } else if (scenario === 'failure') {
    const session = project();
    const failed: CameraAssessor = async input => { calls++; await input.onTrace?.(trace); const error = new MetaError('Synthetic offline provider refusal.', 'refusal'); error.trace = trace; throw error; };
    const result = await server.submitCameraFrame(newFrame(session.id, image), session.id, failed);
    assert.equal(result.turn.status, 'failed'); assert.equal(result.turn.trace?.providerResponseId, trace.providerResponseId);
    assert.equal(result.frames.length, 1); assert.equal(result.session.activeTurnId, null); assert.equal(result.session.latestTurn, null);
    const ok = await server.submitCameraFrame(newFrame(session.id, afterImage, randomUUID(), result.session.revision), session.id, assessor);
    const saved = store.get<StoredCameraSession>('camera_sessions', session.id)!;
    saved.latestTurn!.receivedAt = new Date(Date.now() - 130_000).toISOString(); store.replace('camera_sessions', saved);
    const stale = server.cameraState(request(session.id), session.id);
    assert.equal(stale.session.guidance.actionable, false); assert.ok(stale.session.guidance.reasons.some(reason => reason.includes('no longer current')));
    assert.equal(stale.session.revision, ok.session.revision); assert.equal(calls, 2);
  } else if (scenario === 'budgets') {
    const session = project();
    const base = { projectId: session.id, frameId: randomUUID(), requestHash: 'fixture', revision: 1, stepId: workflow.steps[0].id, sceneEpoch: 1,
      status: 'failed' as const, assessment: null, trace: null, error: 'Synthetic quota fixture', createdAt: store.now(), completedAt: store.now(), operatorNote: '' };
    for (let index = 0; index < 20; index++) store.insert('camera_turns', { ...base, id: randomUUID(), operationId: randomUUID() });
    await assert.rejects(server.submitCameraFrame(newFrame(session.id, image), session.id, assessor), status(429));
    const fourth = project();
    for (let index = 0; index < 3; index++) {
      const pending = project(), turnId = randomUUID();
      store.insert('camera_turns', { ...base, projectId: pending.id, id: turnId, operationId: randomUUID(), status: 'pending', completedAt: null });
      pending.activeTurnId = turnId; store.replace('camera_sessions', pending);
    }
    await assert.rejects(server.submitCameraFrame(newFrame(fourth.id, image), fourth.id, assessor), status(429));
    assert.equal(calls, 0); assert.deepEqual(await frameFiles(), []);
  } else if (scenario === 'rollback') {
    const session = project();
    store.db.exec("CREATE TRIGGER fail_camera_audit BEFORE INSERT ON records WHEN NEW.collection='camera_audit' BEGIN SELECT RAISE(ABORT,'fixture camera audit failure'); END;");
    await assert.rejects(server.submitCameraFrame(newFrame(session.id, image), session.id, assessor), /fixture camera audit failure/);
    assert.equal(store.get<StoredCameraSession>('camera_sessions', session.id)!.activeTurnId, null);
    assert.equal(store.list('camera_frames', session.id).length, 0); assert.equal(store.list('camera_turns', session.id).length, 0);
    assert.deepEqual(await frameFiles(), []); assert.equal(calls, 0);
    store.db.exec('DROP TRIGGER fail_camera_audit;');
  } else throw new Error('Unknown camera API fixture scenario.');
  console.log(`Camera server regression passed: ${scenario}`);
} finally {
  store.db.close(); delete (globalThis as { countershotDb?: unknown }).countershotDb;
}
