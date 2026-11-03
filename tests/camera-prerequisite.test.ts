import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyCameraAssessment, answerCameraMeasurementRequest, CameraDomainError, confirmCameraPrerequisite,
  confirmCameraStep, createCameraSession, initializeCameraReasoning, openCameraEvidenceRequest,
  registerCameraEvidenceRequest,
} from '../src/camera/engine';
import { cameraContextHash } from '../src/camera/context';
import {
  CAMERA_ENGINE_VERSION, CAMERA_SCHEMA_VERSION, LegacyCameraAssessmentSchema, type CameraAssessment, type CameraFacts,
  type CameraSession, type CameraTurn, type LegacyCameraAssessment,
} from '../src/camera/schema';
import { cameraWorkflows, syntheticCameraFacts } from '../src/camera/workflows';
import {
  createExecutionBudget, DEFAULT_CAMERA_EXECUTION_LIMITS, recordInvocationResponse,
  remainingExecutionBudget, reserveInvocation,
} from '../src/meta/budget';
import { DEFAULT_META_MODEL } from '../src/meta/capabilities';

const workflow = cameraWorkflows[0];
const runId = 'offline-prerequisite-run';
type Confirmation = Parameters<typeof confirmCameraPrerequisite>[1];
const confirmed = (factKey: string, value: string | number | boolean, unit?: string | null): Confirmation =>
  ({ factKey, value, unit, operatorConfirmed: true });

function rejected(run: () => unknown, status: number) {
  assert.throws(run, error => error instanceof CameraDomainError && error.status === status);
}

/** Real domain transitions establish reviewed history; these fixtures make no physical claim. */
function fixture(unknown: string[] = [], overrides: CameraFacts = {}) {
  let tick = 0;
  const time = () => new Date(Date.parse('2026-11-03T00:00:00.000Z') + tick++ * 1000).toISOString();
  const initialize = (session: CameraSession) => initializeCameraReasoning(session, workflow,
    { runId, factsHash: cameraContextHash(session.facts) });
  const facts: CameraFacts = { ...structuredClone(syntheticCameraFacts[workflow.id]), ...overrides };
  for (const key of unknown) delete facts[key];
  const initial = initialize(createCameraSession(workflow, facts, time()));
  function observe(session: CameraSession, purpose: 'before' | 'after', changes: Partial<CameraAssessment> = {}) {
    const at = time(), turnId = `offline-prerequisite-turn-${tick}`;
    const assessment: CameraAssessment = {
      contractVersion: 'camera-decision-v3', summary: 'Synthetic domain evidence only.', frameQuality: 'clear',
      continuity: session.completedSteps.length || session.latestTurn ? 'same_scene' : 'first_view',
      observations: [{ id: 'shown-target', label: 'Synthetic labelled branch', detail: 'A declared visible relationship.',
        box: { x: 0.1, y: 0.1, width: 0.3, height: 0.3 } }],
      decisionKind: purpose === 'before' ? 'propose_action' : 'ready_for_operator_review',
      actionProposal: purpose === 'before' ? { kind: 'inspect', instruction: 'Inspect the shown declared label.',
        preconditions: ['The declared setup remains unchanged.'], expectedVisibleResult: 'The actual label remains legible.',
        stopCondition: 'Stop if the label or setup cannot be identified.', targetObservationIds: ['shown-target'] } : null,
      operatorReview: purpose === 'after' ? { instruction: 'Check the actual label and declared relationship.',
        expectedVisibleResult: 'The actual label remains legible.', stopCondition: 'Stop if the relationship is unresolved.',
        targetObservationIds: ['shown-target'] } : null,
      viewRequest: null, measurementRequest: null, hold: null,
      comparison: session.reasoning?.activePredictionId ? { predictionId: session.reasoning.activePredictionId,
        status: 'supported_by_view', evidenceObservationIds: ['shown-target'], failedConditions: [], unknownConditions: [] } : null,
      recovery: null, entityHypotheses: [], planChange: null, suggestedStepId: session.currentStepId,
      ...changes,
    };
    const turn: CameraTurn = { id: turnId, frameId: `frame:${turnId}`, purpose, capturedAt: at, receivedAt: at,
      source: 'camera', revision: session.revision, stepId: session.currentStepId!, assessment,
      frameSha256: tick.toString(16).padStart(64, '0') };
    return { state: applyCameraAssessment(initialize(session), turn, workflow, at), turn };
  }
  function progressed() {
    const before = observe(initial, 'before');
    const after = observe(before.state, 'after');
    const first = workflow.steps[0];
    const state = confirmCameraStep(after.state, { turnId: after.turn.id,
      confirmations: Object.fromEntries(first.requiredConfirmations.map(check => [check.id, true])),
      notes: 'Synthetic operator review of state transitions; no real physical outcome is asserted.' }, workflow, time());
    assert.equal(state.currentStepId, workflow.steps[1].id);
    assert.equal(state.completedSteps.length, 1);
    return { state, before: before.turn, after: after.turn, predictionId: before.state.reasoning!.activePredictionId! };
  }
  function request(session: CameraSession, kind: 'request_view' | 'request_measurement') {
    const result = observe(session, 'before', {
      decisionKind: kind, actionProposal: null, operatorReview: null,
      viewRequest: kind === 'request_view' ? { instruction: 'Show the real retaining clip close up.',
        whyNeeded: 'The retaining resource is not yet identified.', resolves: 'Which actual resource is available.', targetObservationIds: ['shown-target'] } : null,
      measurementRequest: kind === 'request_measurement' ? { factKey: 'minimum_bend_radius_mm', unit: 'mm',
        instruction: 'Read the actual cable specification.', whyNeeded: 'A photograph does not establish the limit.',
        resolves: 'The allowed minimum bend radius.', targetObservationIds: ['shown-target'] } : null,
    });
    return registerCameraEvidenceRequest(result.state, { turn: result.turn, sourceSceneEpoch: session.sceneEpoch,
      factsHash: cameraContextHash(session.facts), checksVersion: { schemaVersion: CAMERA_SCHEMA_VERSION,
        engineVersion: CAMERA_ENGINE_VERSION, workflowHash: cameraContextHash(workflow) } }, time());
  }
  return { initial, initialize, observe, progressed, request, time };
}

function spentBudget(at: string) {
  const started = Date.parse(at);
  const initial = createExecutionBudget(runId, { ...DEFAULT_CAMERA_EXECUTION_LIMITS, maxInvocations: 1 }, started);
  const reserved = reserveInvocation(initial, { invocationId: 'offline-recorded-request', parentInvocationId: null,
    role: 'camera_observe_decide', route: 'camera_reasoning', model: DEFAULT_META_MODEL, contextHash: 'a'.repeat(64),
    promptVersion: 'offline-prerequisite-test', schemaVersion: CAMERA_SCHEMA_VERSION, toolVersion: 'none',
    maxOutputTokens: 6000, inputBytes: 1000 }, started).state;
  return recordInvocationResponse(reserved, 'offline-recorded-request', 'offline-recorded-response', { total_tokens: 100 }, started);
}

test('a late-phase text prerequisite preserves actual reviewed history and the spent shared allowance', () => {
  const f = fixture(['retention_method']), prior = f.progressed();
  const held = f.observe(prior.state, 'before', { decisionKind: 'hold', actionProposal: null,
    hold: { reason: 'The real retaining resource is unknown.', resumeWhen: 'The operator confirms the available resource.' } }).state;
  held.executionBudget = spentBudget(held.createdAt);
  // A cached historical pointer must be cleared, not promoted into new guidance.
  held.beforeTurn = structuredClone(prior.before);
  held.reasoning!.activePredictionId = prior.predictionId;
  const original = structuredClone(held);
  const next = confirmCameraPrerequisite(held, confirmed('retention_method', '  Reversible labelled clip C1.  '), workflow, f.time());
  assert.deepEqual(held, original, 'Confirmation is a pure transition.');
  assert.equal(next.facts.retention_method, 'Reversible labelled clip C1.');
  assert.equal(next.currentStepId, held.currentStepId);
  assert.equal(next.sceneEpoch, held.sceneEpoch);
  assert.equal(next.createdAt, held.createdAt);
  assert.equal(next.revision, held.revision + 1);
  assert.deepEqual(next.completedSteps, held.completedSteps);
  assert.deepEqual(next.reviews, held.reviews);
  assert.equal(next.reviews![0].facts.retention_method, undefined, 'A new answer cannot rewrite an earlier review snapshot.');
  assert.deepEqual(next.executionBudget, held.executionBudget);
  assert.equal(remainingExecutionBudget(next.executionBudget!, Date.parse(next.updatedAt)).invocations, 0);
  assert.equal(next.beforeTurn, null);
  assert.equal(next.latestTurn, null);
  assert.equal(next.reasoning!.activePredictionId, null);
  assert.deepEqual(next.reasoning!.predictions, held.reasoning!.predictions);
  assert.equal(next.guidance.actionable, false);
  assert.equal(next.guidance.canConfirm, false);

  const rebound = f.initialize(next);
  assert.equal(rebound.plan!.current.version.factsHash, cameraContextHash(next.facts));
  assert.equal(rebound.plan!.current.version.stepId, workflow.steps[1].id);
  assert.equal(rebound.plan!.current.parentId, held.plan!.current.id);
  assert.notEqual(rebound.plan!.current.id, held.plan!.current.id);
  assert.deepEqual(rebound.plan!.history.at(-1), held.plan!.current);
  assert.deepEqual(rebound.completedSteps, held.completedSteps);
  assert.deepEqual(rebound.reviews, held.reviews);
  assert.deepEqual(rebound.executionBudget, held.executionBudget);
  assert.equal(rebound.reasoning!.activePredictionId, null);
});

test('numeric prerequisites need an explicit actual value in the declared unit and supported range', () => {
  const f = fixture(['minimum_bend_radius_mm']), state = f.progressed().state;
  const original = structuredClone(state);
  for (const input of [confirmed('minimum_bend_radius_mm', '25', 'mm'), confirmed('minimum_bend_radius_mm', NaN, 'mm'),
    confirmed('minimum_bend_radius_mm', Infinity, 'mm'), confirmed('minimum_bend_radius_mm', 0, 'mm'),
    confirmed('minimum_bend_radius_mm', 1001, 'mm'), confirmed('minimum_bend_radius_mm', 25, 'cm'),
    confirmed('minimum_bend_radius_mm', 25), confirmed('minimum_bend_radius_mm', 25, null)])
    rejected(() => confirmCameraPrerequisite(state, input, workflow, f.time()), 400);
  const next = f.initialize(confirmCameraPrerequisite(state, confirmed('minimum_bend_radius_mm', 25, 'mm'), workflow, f.time()));
  assert.equal(next.facts.minimum_bend_radius_mm, 25);
  assert.deepEqual(next.completedSteps, state.completedSteps);
  assert.deepEqual(state, original);
  assert.equal(next.latestTurn, null);
  assert.equal(next.guidance.canConfirm, false, 'A prerequisite answer is not an observed operating result.');
});

test('a photograph or suggested value cannot confirm a prerequisite without the operator declaration', () => {
  const f = fixture(['scope_confirmed']), numeric = fixture(['minimum_bend_radius_mm']);
  const numericState = numeric.progressed().state;
  for (const operatorConfirmed of [false, undefined, 'true', 1]) {
    const input = { factKey: 'scope_confirmed', value: true, operatorConfirmed } as unknown as Confirmation;
    rejected(() => confirmCameraPrerequisite(f.initial, input, workflow, f.time()), 400);
    const reading = { factKey: 'minimum_bend_radius_mm', value: 25, unit: 'mm', operatorConfirmed } as unknown as Confirmation;
    rejected(() => confirmCameraPrerequisite(numericState, reading, workflow, numeric.time()), 400);
  }
  const next = confirmCameraPrerequisite(f.initial, confirmed('scope_confirmed', true), workflow, f.time());
  assert.equal(next.facts.scope_confirmed, true);
  assert.equal(next.latestTurn, null);
  assert.equal(next.guidance.actionable, false, 'Operator scope confirmation still requires a checked view.');
});

test('negative scope remains recorded and cannot be flipped or re-confirmed as a new missing fact', () => {
  const f = fixture(['scope_confirmed']);
  const negative = confirmCameraPrerequisite(f.initial, confirmed('scope_confirmed', false), workflow, f.time());
  assert.equal(negative.facts.scope_confirmed, false);
  assert.equal(negative.guidance.actionable, false);
  assert.ok(negative.guidance.reasons.some(reason => /disconnected, unpowered/.test(reason)));
  for (const value of [true, false])
    rejected(() => confirmCameraPrerequisite(negative, confirmed('scope_confirmed', value), workflow, f.time()), 409);
});

test('known text and numeric values require reset even when a new confirmation repeats the same value', () => {
  const f = fixture(), first = f.initial, later = f.progressed().state;
  for (const value of [first.facts.branch_labels as string, 'A different actual label list'])
    rejected(() => confirmCameraPrerequisite(first, confirmed('branch_labels', value), workflow, f.time()), 409);
  for (const value of [later.facts.minimum_service_slack_mm as number, 0])
    rejected(() => confirmCameraPrerequisite(later, confirmed('minimum_service_slack_mm', value, 'mm'), workflow, f.time()), 409);
  const zero = fixture([], { minimum_service_slack_mm: 0 }), zeroState = zero.progressed().state;
  for (const value of [0, 1])
    rejected(() => confirmCameraPrerequisite(zeroState, confirmed('minimum_service_slack_mm', value, 'mm'), workflow, zero.time()), 409);
});

test('only an unknown prerequisite of the current workflow phase is eligible', () => {
  const f = fixture(['minimum_bend_radius_mm']);
  rejected(() => confirmCameraPrerequisite(f.initial, confirmed('minimum_bend_radius_mm', 25, 'mm'), workflow, f.time()), 400);
  rejected(() => confirmCameraPrerequisite(f.initial, confirmed('reference_pattern', 'Foreign workflow reference.'), workflow, f.time()), 400);
  rejected(() => confirmCameraPrerequisite(f.initial, confirmed('invented_fact', 'Unspecified model field.'), workflow, f.time()), 400);
  rejected(() => confirmCameraPrerequisite(f.initial, confirmed('reference_pattern', 'Foreign workflow reference.'), cameraWorkflows[1], f.time()), 409);
});

test('blank descriptions stay unknown and descriptive prerequisites cannot carry measurement units', () => {
  const f = fixture(['branch_labels']);
  for (const input of [confirmed('branch_labels', ''), confirmed('branch_labels', '   '), confirmed('branch_labels', true),
    confirmed('branch_labels', 'Actual labels A and B.', 'mm')])
    rejected(() => confirmCameraPrerequisite(f.initial, input, workflow, f.time()), 400);
  const empty = createCameraSession(workflow, { ...f.initial.facts, branch_labels: ' ' }, f.time());
  const next = confirmCameraPrerequisite(empty, confirmed('branch_labels', 'Actual labels A and B.', null), workflow, f.time());
  assert.equal(next.facts.branch_labels, 'Actual labels A and B.');
});

test('an open evidence request must be resolved before a different prerequisite is admitted', () => {
  for (const kind of ['request_view', 'request_measurement'] as const) {
    const f = fixture(['retention_method', 'minimum_bend_radius_mm']), state = f.request(f.progressed().state, kind);
    assert.equal(openCameraEvidenceRequest(state)?.kind, kind);
    const original = structuredClone(state);
    rejected(() => confirmCameraPrerequisite(state, confirmed('retention_method', 'Actual reversible clip C1.'), workflow, f.time()), 409);
    assert.deepEqual(state, original);
  }
});

test('new prerequisites stale answered evidence without erasing its confirmed answer or reviewed phases', () => {
  const f = fixture(['retention_method', 'minimum_bend_radius_mm']);
  const question = f.request(f.progressed().state, 'request_measurement'), request = openCameraEvidenceRequest(question)!;
  const answered = f.initialize(answerCameraMeasurementRequest(question,
    { requestId: request.id, value: 25, unit: 'mm', operationId: 'offline-actual-prerequisite-answer' }, workflow, f.time()));
  assert.equal(answered.evidenceRequests![0].status, 'answered');
  const originalAnswer = structuredClone(answered.evidenceRequests![0].answers);
  const next = confirmCameraPrerequisite(answered, confirmed('retention_method', 'Actual reversible clip C1.'), workflow, f.time());
  assert.equal(next.evidenceRequests![0].status, 'stale');
  assert.deepEqual(next.evidenceRequests![0].answers, originalAnswer);
  assert.equal(next.evidenceRequests![0].answers[0].status, 'accepted');
  assert.equal(next.facts.minimum_bend_radius_mm, 25);
  assert.deepEqual(next.completedSteps, answered.completedSteps);
  assert.equal(next.guidance.actionable, false);
});

test('inactive runs and historical decision contracts cannot be revived by confirming a new fact', () => {
  const f = fixture(['branch_labels']);
  for (const state of [{ ...f.initial, status: 'scene_changed' as const },
    { ...f.initial, status: 'operator_reviewed_complete' as const, currentStepId: null }])
    rejected(() => confirmCameraPrerequisite(state, confirmed('branch_labels', 'Actual A and B.'), workflow, f.time()), 409);
  const current = f.observe(f.initial, 'before', { decisionKind: 'hold', actionProposal: null,
    hold: { reason: 'Actual labels are unknown.', resumeWhen: 'A person confirms them.' } }).state;
  const legacy: LegacyCameraAssessment = {
    summary: 'Historical synthetic decision.', frameQuality: 'clear', continuity: 'same_scene',
    observations: [], suggestedStepId: current.currentStepId, stepStatus: 'needs_information', questions: ['Confirm labels.'],
    nextAction: { kind: 'inspect', instruction: 'Historical question.', expectedVisibleResult: 'Labels are stated.',
      stopCondition: 'The setup changes.', targetObservationIds: [] },
  };
  assert.ok(LegacyCameraAssessmentSchema.safeParse(legacy).success, 'The historical record is a valid earlier contract.');
  const historical = { ...current, latestTurn: { ...current.latestTurn!, assessment: legacy } };
  rejected(() => confirmCameraPrerequisite(historical, confirmed('branch_labels', 'Actual A and B.'), workflow, f.time()), 409);
  rejected(() => confirmCameraPrerequisite(f.initial, confirmed('branch_labels', 'Actual A and B.'), workflow, 'not-a-time'), 400);
});
