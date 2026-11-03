import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  applyCameraAssessment, CameraDomainError, confirmCameraStep, createCameraSession,
  recordCameraStepReview, refreshCameraGuidance, reviseCameraSession, undoLastCameraStep, validateCameraFacts,
  registerCameraEvidenceRequest, answerCameraMeasurementRequest, cancelCameraEvidenceRequest, openCameraEvidenceRequest,
  initializeCameraReasoning, getCurrentReportedFailures, recordCameraReadingReport,
  bindCameraEntity, acceptCameraPlanChange,
  cameraPlanCounterevidence,
} from '../src/camera/engine';
import { CAMERA_ENGINE_VERSION, CameraAssessmentSchema, isCameraDecisionAssessment,
  CAMERA_SCHEMA_VERSION,
  type CameraAssessment, type CameraSession, type CameraTurn, type LegacyCameraAssessment, type WorkflowDefinition } from '../src/camera/schema';
import { cameraWorkflows, syntheticCameraFacts, syntheticCameraMeasurements } from '../src/camera/workflows';

const start = '2026-11-02T12:00:00.000Z';
let sequence = 0;
const clock = () => new Date(Date.parse(start) + sequence * 1000).toISOString();
const workflow = cameraWorkflows[0];
const hashFacts = (facts: unknown) => createHash('sha256').update(JSON.stringify(facts)).digest('hex');
function initialized(state: CameraSession, w = workflow) { return initializeCameraReasoning(state, w, { runId: 'offline-domain-run', factsHash: hashFacts(state.facts) }); }
function session(w: WorkflowDefinition = workflow) { return initialized(createCameraSession(w, structuredClone(syntheticCameraFacts[w.id]), clock()), w); }
function assessment(s: CameraSession, purpose: 'before' | 'after', changes: Partial<CameraAssessment> = {}): CameraAssessment {
  return {
    contractVersion: 'camera-decision-v3', summary: 'Offline state-engine fixture; no physical result is claimed.', frameQuality: 'clear',
    comparison: s.reasoning?.activePredictionId ? { predictionId: s.reasoning.activePredictionId, status: 'supported_by_view', evidenceObservationIds: ['visible_target'], failedConditions: [], unknownConditions: [] } : null,
    recovery: null, entityHypotheses: [], planChange: null,
    continuity: !s.latestTurn && !s.completedSteps.length && purpose === 'before' ? 'first_view' : 'same_scene',
    observations: [{ id: 'visible_target', label: 'Labelled target', detail: 'Synthetic visible relationship for the active step.', box: { x: 0.2, y: 0.2, width: 0.3, height: 0.3 } }],
    decisionKind: purpose === 'before' ? 'propose_action' : 'ready_for_operator_review',
    viewRequest: null, measurementRequest: null, hold: null,
    actionProposal: purpose === 'before' ? { kind: 'perform', instruction: 'Inspect or reversibly place only the identified target.', preconditions: ['The target remains supported.'],
      expectedVisibleResult: 'The target remains identifiable at its declared relationship.', stopCondition: 'Stop if its identity or support is lost.', targetObservationIds: ['visible_target'] } : null,
    operatorReview: purpose === 'after' ? { instruction: 'Inspect the identified result and record actual operator checks.',
      expectedVisibleResult: 'The target remains identifiable at its declared relationship.', stopCondition: 'Stop if its identity or support is lost.', targetObservationIds: ['visible_target'] } : null,
    suggestedStepId: s.currentStepId, ...changes,
  };
}
function turn(s: CameraSession, purpose: 'before' | 'after', changes: Partial<CameraTurn> = {}): CameraTurn {
  sequence++;
  return { id: `turn-${sequence}`, frameId: `frame-${sequence}`, purpose, capturedAt: clock(), receivedAt: clock(), source: 'camera',
    revision: s.revision, stepId: s.currentStepId!, assessment: assessment(s, purpose), frameSha256: sequence.toString(16).padStart(64, '0'), ...changes };
}
function observe(s: CameraSession, purpose: 'before' | 'after', w: WorkflowDefinition = workflow, changes: Partial<CameraTurn> = {}) {
  s = initialized(s, w);
  const frame = turn(s, purpose, changes);
  return applyCameraAssessment(s, frame, w, clock());
}
function review(s: CameraSession, w: WorkflowDefinition = workflow) {
  const step = w.steps.find(value => value.id === s.currentStepId)!;
  return confirmCameraStep(s, { turnId: s.latestTurn!.id,
    confirmations: Object.fromEntries(step.requiredConfirmations.map(check => [check.id, true])),
    measurements: syntheticCameraMeasurements(w.id, step.id),
    notes: 'Synthetic fixture reviewer explicitly records this state-machine exercise, not a physical trial.' }, w, clock());
}
function ready(w: WorkflowDefinition = workflow) { return observe(observe(session(w), 'before', w), 'after', w); }
function expectDomain(fn: () => unknown, status: number, message?: string) { assert.throws(fn, error => error instanceof CameraDomainError && error.status === status, message); }

for (const w of cameraWorkflows) {
  test(`camera iteration ${w.iteration}: ${w.id} requires before, after and human checks for each distinct phase`, () => {
    let state = session(w);
    for (const step of w.steps) {
      assert.equal(state.currentStepId, step.id);
      const original = structuredClone(state);
      state = observe(state, 'before', w);
      assert.equal(state.guidance.actionable, true);
      assert.equal(state.guidance.canConfirm, false);
      assert.deepEqual(original.completedSteps, state.completedSteps, 'model guidance never advances the workflow');
      state = observe(state, 'after', w);
      assert.equal(state.guidance.canConfirm, true);
      assert.equal(state.currentStepId, step.id, 'even a clear ready assessment cannot advance itself');
      state = review(state, w);
    }
    assert.equal(state.status, 'operator_reviewed_complete');
    assert.equal(state.currentStepId, null);
    assert.equal(state.completedSteps.length, w.steps.length);
    assert.equal(state.guidance.actionable, false);
    assert.ok(state.guidance.reasons.some(reason => /not an independent physical verification/.test(reason)));
  });
}

test('an after view cannot replace its missing before view', () => {
  const state = observe(session(), 'after');
  assert.equal(state.guidance.canConfirm, false);
  expectDomain(() => review(state), 409);
});

function measurementQuestion(state: CameraSession, purpose: 'before' | 'after'): CameraSession {
  const frame = turn(state, purpose, { assessment: assessment(state, purpose, {
    decisionKind: 'request_measurement', actionProposal: null, operatorReview: null,
    measurementRequest: { factKey: 'minimum_bend_radius_mm', unit: 'mm', instruction: 'Read the actual specification minimum bend radius.',
      whyNeeded: 'The image cannot establish this prerequisite.', resolves: 'The radius bound for the next route.', targetObservationIds: ['visible_target'] },
  }) });
  const assessed = applyCameraAssessment(state, frame, workflow, clock());
  return refreshCameraGuidance(registerCameraEvidenceRequest(assessed, { turn: frame, sourceSceneEpoch: state.sceneEpoch,
    factsHash: 'f'.repeat(64), checksVersion: { schemaVersion: CAMERA_SCHEMA_VERSION, engineVersion: CAMERA_ENGINE_VERSION, workflowHash: 'a'.repeat(64) } }, clock()), workflow, clock());
}

test('a requested unknown prerequisite can be filled without resetting reviewed work or substituting a result reading', () => {
  const facts = structuredClone(syntheticCameraFacts.harness_routing); delete facts.minimum_bend_radius_mm;
  const initial = initialized(createCameraSession(workflow, facts, clock()));
  const progressed = review(observe(observe(initial, 'before'), 'after'));
  const question = measurementQuestion(progressed, 'before');
  const original = structuredClone(question), request = openCameraEvidenceRequest(question)!;
  const answered = answerCameraMeasurementRequest(question, { requestId: request.id, value: 25, unit: 'mm', operationId: 'offline-answer' }, workflow, clock());
  assert.deepEqual(question, original); assert.equal(answered.facts.minimum_bend_radius_mm, 25);
  assert.equal(answered.sceneEpoch, question.sceneEpoch); assert.deepEqual(answered.completedSteps, question.completedSteps);
  assert.deepEqual(answered.reviews, question.reviews); assert.equal(answered.latestTurn, null); assert.equal(openCameraEvidenceRequest(answered), null);
  assert.equal(answered.guidance.actionable, false); assert.equal(answered.guidance.canConfirm, false);
  assert.equal(answered.evidenceRequests![0].answers[0].kind, 'measurement');
  const readyAgain = observe(observe(answered, 'before'), 'after');
  expectDomain(() => confirmCameraStep(readyAgain, { turnId: readyAgain.latestTurn!.id,
    confirmations: Object.fromEntries(workflow.steps[1].requiredConfirmations.map(check => [check.id, true])),
    notes: 'A confirmed specification value cannot stand in for measured operating results.' }, workflow, clock()), 400);
});

test('same-value answers preserve the original prediction while changed bounds require an explicit scene reset', () => {
  const progressed = review(ready()), before = observe(progressed, 'before');
  const question = measurementQuestion(before, 'after'), request = openCameraEvidenceRequest(question)!;
  const value = question.facts.minimum_bend_radius_mm as number;
  expectDomain(() => answerCameraMeasurementRequest(question, { requestId: request.id, value, unit: 'cm', operationId: 'wrong-unit' }, workflow, clock()), 400);
  expectDomain(() => answerCameraMeasurementRequest(question, { requestId: request.id, value: value + 1, unit: 'mm', operationId: 'changed' }, workflow, clock()), 409);
  const answered = answerCameraMeasurementRequest(question, { requestId: request.id, value, unit: 'mm', operationId: 'same' }, workflow, clock());
  assert.deepEqual(answered.beforeTurn, before.beforeTurn); assert.equal(answered.sceneEpoch, before.sceneEpoch); assert.equal(answered.latestTurn, null);
  const reset = reviseCameraSession(answered, { ...answered.facts, minimum_bend_radius_mm: value + 1 }, workflow, clock());
  assert.equal(reset.evidenceRequests![0].status, 'stale'); assert.equal(reset.evidenceRequests![0].answers[0].status, 'accepted');
  assert.equal(reset.beforeTurn, null); assert.equal(reset.sceneEpoch, answered.sceneEpoch + 1);
  const cancelled = cancelCameraEvidenceRequest(question, request.id, workflow, clock());
  assert.equal(cancelled.evidenceRequests![0].status, 'cancelled'); assert.deepEqual(cancelled.beforeTurn, before.beforeTurn);
  assert.equal(cancelled.guidance.actionable, false); assert.equal(cancelled.guidance.canConfirm, false);
  expectDomain(() => answerCameraMeasurementRequest(cancelled, { requestId: request.id, value, unit: 'mm', operationId: 'late' }, workflow, clock()), 409);
});

test('an actual reading with an unknown prerequisite remains unclassified rather than a fabricated failure', () => {
  const facts = structuredClone(syntheticCameraFacts.harness_routing); delete facts.minimum_bend_radius_mm;
  const progressed = review(observe(observe(initialized(createCameraSession(workflow, facts, clock())), 'before'), 'after'));
  const held = observe(progressed, 'before', workflow, { assessment: assessment(progressed, 'before', { decisionKind: 'hold', actionProposal: null,
    hold: { reason: 'The declared minimum bend radius is unknown.', resumeWhen: 'The operator supplies that prerequisite.' } }) });
  const reported = recordCameraReadingReport(held, { turnId: held.latestTurn!.id, operationId: 'unknown-bound-report', operatorConfirmed: true,
    measurements: syntheticCameraMeasurements(workflow.id, workflow.steps[1].id), confirmations: {}, notes: 'Actual readings are recorded while the specification bound remains unknown.' }, workflow, clock());
  const findings = getCurrentReportedFailures(reported, workflow);
  assert.equal(findings.knownFailure, false); assert.equal(findings.knownIncomplete, true);
  assert.equal(findings.latestReadings.find(reading => reading.measurementId === 'observed_minimum_bend_radius_mm')!.withinBounds, null);
});

function correctiveAssessment(state: CameraSession, hypothesis = 'The visible crossing contradicts the original route.'): CameraAssessment {
  const action = { kind: 'perform' as const, instruction: 'Release the affected reversible clip and expose branch A.', preconditions: ['The harness remains unpowered.'],
    expectedVisibleResult: 'The labelled crossing is exposed without trapped cable.', stopCondition: 'Stop if support or identity becomes uncertain.', targetObservationIds: ['visible_target'] };
  return assessment(state, 'after', { decisionKind: 'propose_action', operatorReview: null, actionProposal: action,
    comparison: { predictionId: state.reasoning!.activePredictionId!, status: 'contradicted', evidenceObservationIds: ['visible_target'], failedConditions: ['The predicted branch route is not established.'], unknownConditions: [] },
    recovery: { predictionId: state.reasoning!.activePredictionId!, changedHypothesis: hypothesis, failedConditions: ['The predicted branch route is not established.'],
      correction: action.instruction, nextObservation: 'Show the exposed crossing and its label in a new view.' } });
}

test('comparison and recovery preserve immutable prediction lineage and stop unchanged-evidence reformulation', () => {
  const before = observe(session(), 'before'), rootId = before.reasoning!.activePredictionId!;
  const corrected = observe(before, 'after', workflow, { frameSha256: 'c'.repeat(64), assessment: correctiveAssessment(before) });
  assert.equal(corrected.beforeTurn!.id, before.beforeTurn!.id); assert.notEqual(corrected.reasoning!.activePredictionId, rootId);
  assert.equal(corrected.reasoning!.predictions.at(-1)!.parentPredictionId, rootId); assert.equal(corrected.reasoning!.predictions.at(-1)!.rootPredictionId, rootId);
  assert.equal(corrected.reasoning!.comparisons[0].predictionId, rootId); assert.equal(corrected.reasoning!.recoveries.length, 1);
  expectDomain(() => observe(corrected, 'after', workflow, { frameSha256: 'c'.repeat(64), assessment: correctiveAssessment(corrected, 'A cosmetic reformulation of the same pixels.') }), 409);
  const second = observe(corrected, 'after', workflow, { frameSha256: 'd'.repeat(64), assessment: correctiveAssessment(corrected) });
  const third = observe(second, 'after', workflow, { frameSha256: 'e'.repeat(64), assessment: correctiveAssessment(second) });
  expectDomain(() => observe(third, 'after', workflow, { frameSha256: 'f'.repeat(64), assessment: correctiveAssessment(third) }), 409);
  const reviewed = observe(corrected, 'after');
  assert.equal(reviewed.guidance.canConfirm, true); assert.equal(reviewed.completedSteps.length, 0);
  assert.equal(reviewed.reasoning!.predictions[0].expectedVisibleResult, before.reasoning!.predictions[0].expectedVisibleResult);
  expectDomain(() => observe(before, 'after', workflow, { assessment: assessment(before, 'after', { comparison: { predictionId: 'prediction:foreign',
    status: 'supported_by_view', evidenceObservationIds: ['visible_target'], failedConditions: [], unknownConditions: [] } }) }), 409);
});

test('failed actual readings and other human failures survive corrective children until an explicit complete recheck', () => {
  const progressed = review(ready()), before = observe(progressed, 'before'), after = observe(before, 'after');
  const step = workflow.steps[1], actual = syntheticCameraMeasurements(workflow.id, step.id), first = step.measurements![0];
  const failed = recordCameraStepReview(after, { turnId: after.latestTurn!.id, confirmations: {},
    measurements: { ...actual, [first.id]: Number(before.facts[first.factId]) - 1 }, outcome: 'failed', notes: 'The radius is too small and the independent support also slipped.' }, workflow, clock());
  assert.equal(failed.reasoning!.activePredictionId, before.reasoning!.activePredictionId);
  assert.equal(cameraPlanCounterevidence(failed).find(record => record.id.startsWith('claim:operator:'))!.status, 'reported_failure');
  expectDomain(() => observe(failed, 'before'), 409);
  const correction = observe(failed, 'before', workflow, { assessment: { ...correctiveAssessment(failed), continuity: 'same_scene' } });
  expectDomain(() => observe(correction, 'after'), 409, 'An untested corrective child cannot erase the failed reading.');
  const heldAssessment = (state: CameraSession) => assessment(state, 'after', { decisionKind: 'hold', operatorReview: null,
    comparison: { predictionId: state.reasoning!.activePredictionId!, status: 'contradicted', evidenceObservationIds: ['visible_target'], failedConditions: ['An actual failed reading or support condition still needs a recheck.'], unknownConditions: [] },
    hold: { reason: 'Record the actual operating recheck.', resumeWhen: 'Actual readings and support checks resolve the failure.' } });
  const held = observe(correction, 'after', workflow, { assessment: heldAssessment(correction) });
  const partial = recordCameraReadingReport(held, { turnId: held.latestTurn!.id, measurements: actual, confirmations: {}, notes: 'The numerical radius was remeasured; the support check is still unresolved.',
    operatorConfirmed: true, operationId: 'partial-recheck' }, workflow, clock());
  const remaining = getCurrentReportedFailures(partial, workflow);
  assert.equal(remaining.failedReadingIds.length, 0); assert.equal(remaining.knownFailure, true); assert.equal(remaining.failedReportIds.length, 1);
  assert.equal(cameraPlanCounterevidence(partial).find(record => record.id === 'claim:reading-report:partial-recheck')!.status, 'unresolved');
  const shown = observe(partial, 'after', workflow, { assessment: heldAssessment(partial) });
  const complete = recordCameraReadingReport(shown, { turnId: shown.latestTurn!.id, measurements: actual,
    confirmations: Object.fromEntries(step.requiredConfirmations.map(check => [check.id, true])), notes: 'I remeasured every required value and explicitly rechecked support and every mandatory operator condition.',
    operatorConfirmed: true, operationId: 'complete-recheck' }, workflow, clock());
  assert.equal(getCurrentReportedFailures(complete, workflow).knownFailure, false); assert.equal(complete.reviews!.at(-1)!.outcome, 'failed');
  assert.equal(complete.readingReports!.length, 2); assert.deepEqual(complete.beforeTurn, correction.beforeTurn);
  assert.equal(complete.completedSteps.length, 1); assert.equal(observe(complete, 'after').guidance.canConfirm, true);
});

test('physical identity is operator bound while model candidates cannot create or merge entities', () => {
  const before = observe(session(), 'before');
  const bound = bindCameraEntity(before, { turnId: before.latestTurn!.id, observationId: 'visible_target', entityId: 'entity:owned', label: 'Branch A', operatorConfirmed: true }, workflow, clock());
  assert.equal(bound.reasoning!.entities.length, 1); assert.equal(bound.latestTurn, null); assert.deepEqual(bound.beforeTurn, before.beforeTurn);
  const hypotheses = observe(bound, 'after', workflow, { assessment: assessment(bound, 'after', { entityHypotheses: [{ observationId: 'visible_target', candidateEntityIds: ['entity:owned'], detail: 'The label may identify Branch A; this remains a hypothesis.' }] }) });
  assert.equal(hypotheses.reasoning!.entities.length, 1); assert.equal(hypotheses.reasoning!.hypotheses.length, 1);
  expectDomain(() => observe(bound, 'after', workflow, { assessment: assessment(bound, 'after', { entityHypotheses: [{ observationId: 'visible_target', candidateEntityIds: ['entity:foreign'], detail: 'An unowned candidate.' }] }) }), 409);
  expectDomain(() => bindCameraEntity(hypotheses, { turnId: hypotheses.latestTurn!.id, observationId: 'visible_target', entityId: 'entity:second', label: 'branch a', operatorConfirmed: true }, workflow, clock()), 409);
});

test('multiple owned identity candidates hold manipulation and review while permitting a discriminating view or inspection', () => {
  const before = observe(session(), 'before');
  const first = bindCameraEntity(before, { turnId: before.latestTurn!.id, observationId: 'visible_target', entityId: 'entity:a', label: 'Branch A', operatorConfirmed: true }, workflow, clock());
  const otherView = observe(first, 'after');
  const second = bindCameraEntity(otherView, { turnId: otherView.latestTurn!.id, observationId: 'visible_target', entityId: 'entity:b', label: 'Branch B', operatorConfirmed: true }, workflow, clock());
  const ambiguous = [{ observationId: 'visible_target', candidateEntityIds: ['entity:a', 'entity:b'], detail: 'The visible target may be either labelled branch.' }];
  const perform = observe(second, 'after', workflow, { assessment: assessment(second, 'after', { decisionKind: 'propose_action', operatorReview: null,
    actionProposal: { kind: 'perform', instruction: 'Place this branch at the declared port.', preconditions: ['The branch stays supported.'], expectedVisibleResult: 'The selected branch reaches its declared port.',
      stopCondition: 'Stop if its identity is uncertain.', targetObservationIds: ['visible_target'] }, entityHypotheses: ambiguous }) });
  assert.equal(perform.guidance.actionable, false); assert.equal(perform.guidance.canConfirm, false);
  assert.match(perform.guidance.reasons.join(' '), /more than one physical entity/);
  assert.equal(perform.reasoning!.activePredictionId, second.reasoning!.activePredictionId, 'Ambiguity cannot admit another physical prediction.');
  const reviewHeld = observe(second, 'after', workflow, { assessment: assessment(second, 'after', { entityHypotheses: ambiguous }) });
  assert.equal(reviewHeld.guidance.canConfirm, false); expectDomain(() => review(reviewHeld), 409);
  const requested = observe(second, 'after', workflow, { assessment: assessment(second, 'after', { decisionKind: 'request_view', operatorReview: null,
    viewRequest: { instruction: 'Show the printed branch label in a closer view.', whyNeeded: 'Two known branches match this target.', resolves: 'Which owned branch occupies this frame region.', targetObservationIds: ['visible_target'] },
    entityHypotheses: ambiguous }) });
  const requestedAssessment = requested.latestTurn!.assessment; assert.ok(isCameraDecisionAssessment(requestedAssessment));
  assert.equal(requestedAssessment.decisionKind, 'request_view'); assert.equal(requested.guidance.actionable, false);
  const inspect = observe(second, 'after', workflow, { assessment: assessment(second, 'after', { decisionKind: 'propose_action', operatorReview: null,
    actionProposal: { kind: 'inspect', instruction: 'Read the printed labels while keeping both branches still.', preconditions: ['No part is moved.'], expectedVisibleResult: 'The printed identity becomes legible.',
      stopCondition: 'Stop if a part must be moved to expose the label.', targetObservationIds: ['visible_target'] }, entityHypotheses: ambiguous }) });
  assert.equal(inspect.guidance.actionable, true); assert.equal(inspect.guidance.canConfirm, false);
  const single = observe(inspect, 'after', workflow, { assessment: assessment(inspect, 'after', { entityHypotheses: [{ ...ambiguous[0], candidateEntityIds: ['entity:a'] }] }) });
  assert.equal(single.guidance.canConfirm, true); assert.equal(single.reasoning!.entities.length, 2);
  assert.equal(single.reasoning!.entityBindings.length, second.reasoning!.entityBindings.length, 'A model candidate never creates an operator identity binding or merges entities.');
});

test('plan changes require exact counterevidence and explicit acceptance without relaxing mandatory phases', () => {
  const progressed = review(ready()), before = observe(progressed, 'before'), frame = turn(before, 'after');
  frame.assessment = assessment(before, 'after', { decisionKind: 'propose_plan_change', operatorReview: null,
    comparison: { predictionId: before.reasoning!.activePredictionId!, status: 'contradicted', evidenceObservationIds: ['visible_target'], failedConditions: ['The current route remains blocked.'], unknownConditions: [] },
    planChange: { parentPlanVersion: before.plan!.current.id, kind: 'reopen_phase', reopenStepId: workflow.steps[0].id, substeps: [],
      counterevidenceIds: [`comparison:${frame.id}`], rationale: 'Recheck the mandatory identity phase before choosing the route.' } });
  const proposed = applyCameraAssessment(before, frame, workflow, clock());
  assert.equal(proposed.completedSteps.length, 1); assert.equal(proposed.plan!.current.id, before.plan!.current.id); assert.equal(proposed.guidance.canConfirm, false);
  const proposal = proposed.plan!.proposals[0]; assert.equal(proposal.version.revision, proposed.revision);
  const accepted = acceptCameraPlanChange(proposed, { proposalId: proposal.id, operatorConfirmed: true, clientOperationId: 'explicit-plan-accept' }, workflow, clock());
  assert.equal(accepted.currentStepId, workflow.steps[0].id); assert.equal(accepted.completedSteps.length, 0); assert.equal(accepted.latestTurn, null);
  assert.equal(accepted.beforeTurn, null); assert.equal(accepted.reasoning!.activePredictionId, null); assert.equal(accepted.plan!.history.length, 1);
  assert.equal(accepted.plan!.current.mandatoryObligations, before.plan!.current.mandatoryObligations);
  assert.equal(accepted.reviews!.length, proposed.reviews!.length);
  expectDomain(() => acceptCameraPlanChange({ ...proposed, revision: proposed.revision + 1 }, { proposalId: proposal.id, operatorConfirmed: true, clientOperationId: 'stale-approval' }, workflow, clock()), 409);
});

test('a quantitative phase cannot pass with missing or out-of-limit measured results despite checked boxes', () => {
  const initial = review(ready());
  const state = observe(observe(initial, 'before'), 'after');
  const step = workflow.steps.find(value => value.id === state.currentStepId)!;
  const checks = Object.fromEntries(step.requiredConfirmations.map(check => [check.id, true]));
  const good = syntheticCameraMeasurements(workflow.id, step.id);
  const first = step.measurements![0];
  const bad = { ...good, [first.id]: Number(state.facts[first.factId]) - 1 };
  for (const measurements of [undefined, {}, { ...good, [first.id]: null }, bad])
    expectDomain(() => confirmCameraStep(state, { turnId: state.latestTurn!.id, confirmations: checks, measurements, notes: 'Actual radius/slack reading must govern this result.' }, workflow, clock()), 400);
  assert.equal(state.completedSteps.length, 1);
});

test('out-of-limit actual results derive a failed review even if the user requests incomplete', () => {
  const initial = review(ready());
  const state = observe(observe(initial, 'before'), 'after');
  const step = workflow.steps.find(value => value.id === state.currentStepId)!;
  const measurements = syntheticCameraMeasurements(workflow.id, step.id);
  const definition = step.measurements![0];
  measurements[definition.id] = Number(state.facts[definition.factId]) - 1;
  const snapshot = structuredClone(state);
  const reviewed = recordCameraStepReview(state, { turnId: state.latestTurn!.id, confirmations: {}, measurements,
    notes: 'Measured radius is below the confirmed limit; no successful physical result is claimed.', outcome: 'incomplete' }, workflow, clock());
  assert.equal(reviewed.reviews!.at(-1)!.outcome, 'failed');
  assert.equal(reviewed.currentStepId, state.currentStepId);
  assert.equal(reviewed.completedSteps.length, state.completedSteps.length);
  assert.equal(reviewed.beforeTurn, null); assert.equal(reviewed.latestTurn, null);
  assert.equal(reviewed.guidance.actionable, false);
  assert.deepEqual(state, snapshot);
});

test('a human can retain incomplete or failed evidence without pretending an occluded view is ready', () => {
  const before = observe(session(), 'before');
  const state = observe(before, 'after', workflow, { assessment: assessment(before, 'after', { frameQuality: 'occluded', decisionKind: 'hold', operatorReview: null,
    hold: { reason: 'The target became hidden.', resumeWhen: 'A clear new view establishes the target.' } }) });
  assert.equal(state.guidance.canConfirm, false);
  for (const outcome of ['failed', 'incomplete'] as const) {
    const logged = recordCameraStepReview(state, { turnId: state.latestTurn!.id, confirmations: {}, notes: 'The target became hidden; recording the observed limitation.', outcome }, workflow, clock());
    assert.equal(logged.reviews!.at(-1)!.outcome, outcome);
    assert.equal(logged.completedSteps.length, 0);
    assert.equal(cameraPlanCounterevidence(logged).find(record => record.id.startsWith('claim:operator:'))!.status,
      outcome === 'failed' ? 'reported_failure' : 'unresolved');
  }
});

test('review history keeps the original facts and actual readings after facts reset or undo', () => {
  const initial = review(ready());
  const state = review(observe(observe(initial, 'before'), 'after'));
  const recorded = structuredClone(state.reviews!);
  assert.equal(recorded.at(-1)!.outcome, 'passed');
  assert.ok(Object.keys(recorded.at(-1)!.measurements).length > 0);
  const revised = reviseCameraSession(state, { ...state.facts, minimum_bend_radius_mm: 1 }, workflow, clock());
  assert.deepEqual(revised.reviews, recorded);
  assert.equal(revised.reviews!.at(-1)!.facts.minimum_bend_radius_mm, syntheticCameraFacts[workflow.id].minimum_bend_radius_mm);
  const undone = undoLastCameraStep(state, workflow, clock());
  assert.deepEqual(undone.reviews, recorded);
});

test('a saved review keeps its original criterion definition and engine version after catalog changes', () => {
  const w = structuredClone(cameraWorkflows.find(value => value.id === 'fragment_dry_fit')!);
  let state = session(w);
  for (let index = 0; index < 3; index++) state = review(observe(observe(state, 'before', w), 'after', w), w);
  const recorded = state.reviews!.at(-1)!;
  const snapshot = structuredClone(recorded.stepSnapshot);
  assert.equal(recorded.checksVersion, CAMERA_ENGINE_VERSION);
  assert.equal(recorded.stepSnapshot!.measurements![0].relation, 'within_tolerance');
  w.steps[2].title = 'A changed criterion title';
  w.steps[2].requiredConfirmations[0].label = 'Changed operator check';
  w.steps[2].measurements = [{ id: 'observed_outline_width_mm', label: 'Changed lower-bound measurement', unit: 'mm', factId: 'reference_width_mm', relation: 'gte' }];
  assert.deepEqual(recorded.stepSnapshot, snapshot);
  assert.notEqual(recorded.stepSnapshot!.title, w.steps[2].title);
  assert.equal(recorded.facts.maximum_outline_error_mm, .5);
});

test('reset and undo preserve legacy unversioned review history without inventing criterion snapshots', () => {
  const state = review(ready());
  delete state.reviews![0].checksVersion;
  delete state.reviews![0].stepSnapshot;
  const historical = structuredClone(state.reviews![0]);
  const reset = reviseCameraSession(state, structuredClone(state.facts), workflow, clock());
  const undone = undoLastCameraStep(state, workflow, clock());
  for (const preserved of [reset.reviews![0], undone.reviews![0]]) {
    assert.deepEqual(preserved, historical);
    assert.equal(Object.hasOwn(preserved, 'checksVersion'), false);
    assert.equal(Object.hasOwn(preserved, 'stepSnapshot'), false);
  }
});

test('measurements reject negative/nonfinite readings and foreign measurement identities', () => {
  const initial = review(ready());
  const state = observe(observe(initial, 'before'), 'after');
  const step = workflow.steps.find(value => value.id === state.currentStepId)!;
  const first = step.measurements![0];
  for (const measurements of [{ [first.id]: -1 }, { [first.id]: NaN }, { [first.id]: Infinity }, { invented: 10 }])
    expectDomain(() => recordCameraStepReview(state, { turnId: state.latestTurn!.id, confirmations: {}, measurements, notes: 'Invalid readings cannot become completion evidence.', outcome: 'incomplete' }, workflow, clock()), 400);
});

test('byte-identical or reused before/after frame identities cannot satisfy physical change review', () => {
  const before = observe(session(), 'before');
  for (const changes of [{ frameId: before.beforeTurn!.frameId }, { frameSha256: before.beforeTurn!.frameSha256 }]) {
    expectDomain(() => observe(before, 'after', workflow, changes), 409);
  }
});

test('server receipt age invalidates saved guidance without mutating its record or revision', () => {
  const state = ready(), original = structuredClone(state);
  const later = new Date(Date.parse(state.latestTurn!.receivedAt) + 120_001).toISOString();
  const refreshed = refreshCameraGuidance(state, workflow, later);
  assert.equal(refreshed.guidance.canConfirm, false);
  assert.equal(refreshed.revision, state.revision);
  assert.deepEqual(state, original);
  expectDomain(() => confirmCameraStep(state, { turnId: state.latestTurn!.id, confirmations: {}, notes: 'Late review' }, workflow, later), 409);
});

test('uploaded stills retain unknown capture time and use receipt-age gates', () => {
  const state = session();
  expectDomain(() => observe(state, 'before', workflow, { source: 'upload', capturedAt: start }), 400);
  const uploaded = observe(state, 'before', workflow, { source: 'upload', capturedAt: null });
  assert.equal(uploaded.guidance.actionable, true);
  assert.equal(uploaded.latestTurn!.capturedAt, null);
});

test('negative scope confirmations and missing facts cannot be supplied by a model assessment', () => {
  const state = createCameraSession(workflow, { ...syntheticCameraFacts[workflow.id], scope_confirmed: false }, clock());
  const checked = observe(state, 'before');
  assert.equal(checked.guidance.actionable, false);
  assert.equal(checked.facts.scope_confirmed, false);
  const missing = createCameraSession(workflow, {}, clock());
  assert.equal(observe(missing, 'before').guidance.actionable, false);
});

test('confirmed facts reject inferred numeric strings, nonfinite values, unknown identities and wrong boolean types', () => {
  for (const facts of [
    { ...syntheticCameraFacts[workflow.id], minimum_bend_radius_mm: '10' },
    { ...syntheticCameraFacts[workflow.id], minimum_bend_radius_mm: Infinity },
    { ...syntheticCameraFacts[workflow.id], minimum_bend_radius_mm: -1 },
    { ...syntheticCameraFacts[workflow.id], invented_measurement: 12 },
    { ...syntheticCameraFacts[workflow.id], scope_confirmed: 'true' },
  ]) expectDomain(() => validateCameraFacts(workflow, facts), 400);
});

test('changed setup clears previous confirmations and stays held until explicit facts/reset revision', () => {
  const completed = review(ready());
  const change = assessment(completed, 'before', { continuity: 'changed' });
  const held = observe(completed, 'before', workflow, { assessment: change });
  assert.equal(held.status, 'scene_changed');
  assert.equal(held.completedSteps.length, 0);
  assert.equal(held.beforeTurn, null);
  const laterClear = observe(held, 'before', workflow, { assessment: assessment(held, 'before', { continuity: 'same_scene' }) });
  assert.equal(laterClear.guidance.actionable, false);
  assert.equal(laterClear.status, 'scene_changed');
  const reset = reviseCameraSession(laterClear, structuredClone(syntheticCameraFacts[workflow.id]), workflow, clock());
  assert.equal(reset.status, 'active');
  assert.equal(reset.currentStepId, workflow.steps[0].id);
  assert.equal(reset.completedSteps.length, 0);
  assert.equal(reset.latestTurn, null);
  assert.ok(reset.sceneEpoch > completed.sceneEpoch);
});

test('uncertain or occluded after views can be retaken without inventing a completed phase', () => {
  const before = observe(session(), 'before');
  for (const changes of [{ continuity: 'uncertain' as const }, { frameQuality: 'occluded' as const }]) {
    const held = observe(before, 'after', workflow, { assessment: assessment(before, 'after', changes) });
    assert.equal(held.guidance.canConfirm, false);
    assert.equal(held.beforeTurn?.id, before.beforeTurn!.id);
    assert.equal(held.completedSteps.length, 0);
    assert.equal(observe(held, 'after').guidance.canConfirm, true);
  }
});

test('foreign targets, invalid image boxes, duplicated identities and substituted steps are rejected before publication', () => {
  const state = session(), good = assessment(state, 'before');
  for (const changes of [
    { actionProposal: { ...good.actionProposal!, targetObservationIds: ['missing'] } },
    { observations: [{ ...good.observations[0], box: { x: 0.8, y: 0.2, width: 0.3, height: 0.2 } }] },
    { observations: [good.observations[0], good.observations[0]] },
    { observations: [] },
    { suggestedStepId: workflow.steps[1].id },
  ]) expectDomain(() => observe(state, 'before', workflow, { assessment: { ...good, ...changes } }), 400);
  assert.equal(state.latestTurn, null);
});

test('action proposals and operator reviews cannot bypass the located-target requirement', () => {
  for (const kind of ['perform', 'inspect'] as const) {
    const state = session(), good = assessment(state, 'before');
    const noTargets = { ...good, actionProposal: { ...good.actionProposal!, kind, targetObservationIds: [] } };
    assert.equal(CameraAssessmentSchema.safeParse(noTargets).success, false);
    expectDomain(() => observe(state, 'before', workflow, { assessment: { ...good, actionProposal: { ...good.actionProposal!, kind, targetObservationIds: ['unseen'] } } }), 400);
    const held = observe(state, 'before', workflow, { assessment: { ...good,
      actionProposal: { ...good.actionProposal!, kind }, observations: [{ ...good.observations[0], box: null }] } });
    assert.equal(held.guidance.actionable, false, `${kind} requires a located observed target`);
    assert.equal(held.beforeTurn, null);
    assert.equal(held.guidance.canConfirm, false);
    const before = observe(state, 'before');
    const after = assessment(before, 'after');
    assert.equal(CameraAssessmentSchema.safeParse({ ...after, operatorReview: { ...after.operatorReview!, targetObservationIds: [] } }).success, false);
    const unlocated = observe(before, 'after', workflow, { assessment: { ...after, observations: [{ ...after.observations[0], box: null }] } });
    assert.equal(unlocated.guidance.canConfirm, false);
  }
});

test('a scene-change frame cannot attach an old phase review to the new scene epoch', () => {
  const reviewed = review(ready());
  const changed = observe(reviewed, 'before', workflow, { assessment: assessment(reviewed, 'before', {
    continuity: 'changed', decisionKind: 'hold', actionProposal: null,
    hold: { reason: 'The physical setup changed.', resumeWhen: 'Reconfirm the replaced workpiece and reset the run.' },
  }) });
  assert.notEqual(changed.currentStepId, changed.latestTurn!.stepId);
  const original = structuredClone(changed);
  for (const outcome of ['failed', 'incomplete'] as const)
    expectDomain(() => recordCameraStepReview(changed, { turnId: changed.latestTurn!.id, confirmations: {}, notes: 'A different setup is now in the frame.', outcome }, workflow, clock()), 409);
  assert.deepEqual(changed, original);
});

test('fragment outline dimensions must meet the confirmed reference and tolerance before advancement', () => {
  const w = cameraWorkflows.find(value => value.id === 'fragment_dry_fit')!;
  let initial = session(w);
  initial = review(observe(observe(initial, 'before', w), 'after', w), w);
  initial = review(observe(observe(initial, 'before', w), 'after', w), w);
  const state = observe(observe(initial, 'before', w), 'after', w);
  const step = w.steps.find(value => value.id === state.currentStepId)!;
  assert.equal(step.id, 'resolve_reconstruction');
  const checks = Object.fromEntries(step.requiredConfirmations.map(check => [check.id, true]));
  const good = syntheticCameraMeasurements(w.id, step.id);
  const bad = { ...good, observed_outline_width_mm: 381 };
  for (const measurements of [undefined, {}, { ...good, observed_outline_height_mm: null }, bad])
    expectDomain(() => confirmCameraStep(state, { turnId: state.latestTurn!.id, confirmations: checks, measurements, notes: 'Actual outline differs from the target.' }, w, clock()), 400);
  const recorded = recordCameraStepReview(state, { turnId: state.latestTurn!.id, confirmations: checks, measurements: bad,
    notes: 'The complete outline is 381 mm wide against the 180 mm target.', outcome: 'incomplete' }, w, clock());
  assert.equal(recorded.reviews!.at(-1)!.outcome, 'failed');
  assert.equal(recorded.reviews!.at(-1)!.measurements.observed_outline_width_mm, 381);
  assert.equal(recorded.reviews!.at(-1)!.facts.reference_width_mm, 180);
  assert.equal(recorded.reviews!.at(-1)!.facts.maximum_outline_error_mm, .5);
  assert.equal(recorded.currentStepId, step.id);
  assert.equal(recorded.completedSteps.length, 2);
  const reset = reviseCameraSession(recorded, { ...state.facts, reference_width_mm: 381, maximum_outline_error_mm: 2 }, w, clock());
  assert.equal(reset.reviews!.at(-1)!.facts.reference_width_mm, 180);
  assert.equal(reset.reviews!.at(-1)!.facts.maximum_outline_error_mm, .5);
});

test('fragment dimension checks include both tolerance boundaries and are repeated after transfer', () => {
  const w = cameraWorkflows.find(value => value.id === 'fragment_dry_fit')!;
  const facts = { ...syntheticCameraFacts[w.id], reference_width_mm: 180.2, maximum_outline_error_mm: .1 };
  let initial = createCameraSession(w, facts, clock());
  for (let index = 0; index < 2; index++) initial = review(observe(observe(initial, 'before', w), 'after', w), w);
  const state = observe(observe(initial, 'before', w), 'after', w);
  const step = w.steps[2];
  const checks = Object.fromEntries(step.requiredConfirmations.map(check => [check.id, true]));
  for (const width of [180.1, 180.3]) {
    const passed = confirmCameraStep(state, { turnId: state.latestTurn!.id, confirmations: checks,
      measurements: { observed_outline_width_mm: width, observed_outline_height_mm: 120 }, notes: 'Physical dimensions recorded at a confirmed tolerance boundary.' }, w, clock());
    assert.equal(passed.currentStepId, w.steps[3].id);
  }
  expectDomain(() => confirmCameraStep(state, { turnId: state.latestTurn!.id, confirmations: checks,
    measurements: { observed_outline_width_mm: 180.30001, observed_outline_height_mm: 120 }, notes: 'A reading outside the numerical tolerance must fail.' }, w, clock()), 400);
  const final = w.steps[3];
  assert.ok(final.measurements!.some(value => value.id === 'observed_outline_width_mm'));
  assert.ok(final.measurements!.some(value => value.id === 'observed_outline_height_mm'));
});

test('fragment outline tolerance remains an explicit positive operator fact', () => {
  const w = cameraWorkflows.find(value => value.id === 'fragment_dry_fit')!;
  for (const value of [0, -.1, 11, '0.5'])
    expectDomain(() => createCameraSession(w, { ...syntheticCameraFacts[w.id], maximum_outline_error_mm: value }, clock()), 400);
  expectDomain(() => createCameraSession(w, { ...syntheticCameraFacts[w.id], reference_width_mm: 1, maximum_outline_error_mm: 1 }, clock()), 400);
  const facts = { ...syntheticCameraFacts[w.id] }; delete facts.maximum_outline_error_mm;
  let state = createCameraSession(w, facts, clock());
  for (let index = 0; index < 2; index++) state = review(observe(observe(state, 'before', w), 'after', w), w);
  assert.equal(observe(state, 'before', w).guidance.actionable, false);
});

test('a response from an old revision or step cannot replace current guidance', () => {
  const state = session(), pending = turn(state, 'before');
  const revised = reviseCameraSession(state, structuredClone(state.facts), workflow, clock());
  expectDomain(() => applyCameraAssessment(revised, pending, workflow, clock()), 409);
  expectDomain(() => applyCameraAssessment(state, { ...pending, stepId: workflow.steps[1].id }, workflow, clock()), 409);
  assert.equal(state.latestTurn, null);
});

test('first_view is a baseline only and cannot establish an after or later phase continuity', () => {
  const before = observe(session(), 'before');
  expectDomain(() => observe(before, 'after', workflow, { assessment: assessment(before, 'after', { continuity: 'first_view' }) }), 409);
  const next = review(observe(before, 'after'));
  expectDomain(() => observe(next, 'before', workflow, { assessment: assessment(next, 'before', { continuity: 'first_view' }) }), 409);
});

test('after-frame server ordering is required independently of client-claimed capture time', () => {
  const before = observe(session(), 'before');
  const after = observe(before, 'after', workflow, { receivedAt: before.beforeTurn!.receivedAt });
  assert.equal(after.guidance.canConfirm, false);
  assert.ok(after.guidance.reasons.some(reason => /received after/.test(reason)));
});

test('a needed correction can be grounded in an after view without automatically completing the phase', () => {
  const before = observe(session(), 'before');
  const correction = assessment(before, 'after', { decisionKind: 'propose_action', operatorReview: null,
    actionProposal: { ...assessment(before, 'before').actionProposal!, instruction: 'Undo only the misrouted visible branch.' } });
  const checked = observe(before, 'after', workflow, { assessment: correction });
  assert.equal(checked.guidance.actionable, true);
  assert.equal(checked.guidance.canConfirm, false);
  assert.equal(checked.completedSteps.length, 0);
});

test('operator confirmation requires all exact checks and a description of the actual inspection', () => {
  const state = ready(), checks = workflow.steps[0].requiredConfirmations;
  const valid = Object.fromEntries(checks.map(check => [check.id, true]));
  for (const confirmations of [{}, { ...valid, [checks[0].id]: false }, { ...valid, irrelevant: true }])
    expectDomain(() => confirmCameraStep(state, { turnId: state.latestTurn!.id, confirmations, notes: 'Actual checks are required.' }, workflow, clock()), 400);
  expectDomain(() => confirmCameraStep(state, { turnId: state.latestTurn!.id, confirmations: valid, notes: ' ' }, workflow, clock()), 400);
  expectDomain(() => confirmCameraStep(state, { turnId: 'older-turn', confirmations: valid, notes: 'Stale assessment' }, workflow, clock()), 409);
});

test('operator review rejects simultaneous action, view, measurement and hold payloads', () => {
  const before = observe(session(), 'before'), good = assessment(before, 'after');
  for (const changes of [
    { actionProposal: assessment(before, 'before').actionProposal },
    { viewRequest: { instruction: 'Show the hidden label.', whyNeeded: 'Its identity remains unknown.', resolves: 'Which branch is present.', targetObservationIds: [] } },
    { measurementRequest: { factKey: 'minimum_bend_radius_mm', unit: 'mm', instruction: 'Report the actual radius.', whyNeeded: 'The bound is uncertain.', resolves: 'The radius bound.', targetObservationIds: [] } },
    { hold: { reason: 'The target is uncertain.', resumeWhen: 'The identity is established.' } },
  ]) {
    assert.equal(CameraAssessmentSchema.safeParse({ ...good, ...changes }).success, false);
    assert.throws(() => observe(before, 'after', workflow, { assessment: { ...good, ...changes } }));
  }
  assert.equal(before.latestTurn!.id, before.beforeTurn!.id);
});

test('undo reopens exactly the last reviewed phase and requires new before/after evidence', () => {
  let state = review(ready());
  state = review(observe(observe(state, 'before'), 'after'));
  const snapshot = structuredClone(state);
  const reopened = undoLastCameraStep(state, workflow, clock());
  assert.equal(reopened.currentStepId, workflow.steps[1].id);
  assert.equal(reopened.completedSteps.length, 1);
  assert.equal(reopened.beforeTurn, null);
  assert.equal(reopened.latestTurn, null);
  assert.equal(reopened.guidance.canConfirm, false);
  assert.deepEqual(state, snapshot);
});

test('session revisions and assessment application preserve immutable inputs and outer ownership fields', () => {
  const state = { ...session(), id: 'owned-session', ownerHash: 'server-only-owner' };
  const original = structuredClone(state), input = turn(state, 'before'), raw = structuredClone(input);
  const next = applyCameraAssessment(state, input, workflow, clock());
  assert.equal(next.id, state.id); assert.equal(next.ownerHash, state.ownerHash);
  assert.deepEqual(state, original); assert.deepEqual(input, raw);
  const updated = reviseCameraSession(next, { ...state.facts, branch_labels: 'New actual labels require new checks.' }, workflow, clock());
  assert.equal(updated.completedSteps.length, 0);
  assert.equal(updated.latestTurn, null);
  assert.equal(updated.createdAt, state.createdAt);
  assert.notEqual(updated.revision, next.revision);
});

test('the model schema cannot smuggle automatic completion, measurements or missing falsification fields', () => {
  const good = assessment(session(), 'before');
  assert.equal(CameraAssessmentSchema.safeParse({ ...good, physicalSuccess: true }).success, false);
  assert.equal(CameraAssessmentSchema.safeParse({ ...good, measuredRadiusMm: 20 }).success, false);
  assert.equal(CameraAssessmentSchema.safeParse({ ...good, actionProposal: { ...good.actionProposal!, expectedVisibleResult: undefined } }).success, false);
  assert.equal(CameraAssessmentSchema.safeParse({ ...good, actionProposal: { ...good.actionProposal!, stopCondition: '' } }).success, false);
});

test('missing, mismatched and multiple payloads cannot become a completed decision', () => {
  const good = assessment(session(), 'before');
  for (const invalid of [
    { ...good, actionProposal: null },
    { ...good, decisionKind: 'request_view' },
    { ...good, decisionKind: 'unsupported_decision' },
    { ...good, contractVersion: 'camera-decision-v1' },
    { ...good, viewRequest: { instruction: 'Show the hidden label.', whyNeeded: 'Identity is uncertain.', resolves: 'Which branch is present.', targetObservationIds: [] } },
  ]) assert.equal(CameraAssessmentSchema.safeParse(invalid).success, false);
});

function evidenceDecision(s: CameraSession, purpose: 'before' | 'after', decisionKind: 'request_view' | 'request_measurement' | 'hold'): CameraAssessment {
  return assessment(s, purpose, {
    decisionKind, actionProposal: null, operatorReview: null,
    viewRequest: decisionKind === 'request_view' ? { instruction: 'Show the hidden branch label from the other side.',
      whyNeeded: 'The current view does not identify the destination.', resolves: 'The labelled branch identity.', targetObservationIds: ['visible_target'] } : null,
    measurementRequest: decisionKind === 'request_measurement' ? { factKey: 'minimum_bend_radius_mm', unit: 'mm',
      instruction: 'Report the cable-specified minimum bend radius.', whyNeeded: 'The required limit needs reconfirmation.', resolves: 'The numeric bend bound.', targetObservationIds: ['visible_target'] } : null,
    hold: decisionKind === 'hold' ? { reason: 'The supported condition is uncertain.', resumeWhen: 'The required condition can be established.' } : null,
  });
}

test('view, measurement and hold decisions never authorize action, confirmation or a new before anchor', () => {
  // The second harness phase requires the named numeric fact used by the request.
  const state = review(ready());
  for (const kind of ['request_view', 'request_measurement', 'hold'] as const) {
    const original = structuredClone(state);
    const before = observe(state, 'before', workflow, { assessment: evidenceDecision(state, 'before', kind) });
    assert.equal(before.guidance.actionable, false);
    assert.equal(before.guidance.canConfirm, false);
    assert.equal(before.beforeTurn, null);
    assert.equal(before.currentStepId, state.currentStepId);
    assert.deepEqual(before.facts, state.facts, 'A request never writes a measured fact.');
    assert.equal(before.latestTurn!.decisionId, `decision:${before.latestTurn!.id}`);
    assert.equal(before.latestTurn!.requestId, kind === 'hold' ? null : `request:${before.latestTurn!.id}`);
    assert.equal(before.latestTurn!.predictionId, null);
    expectDomain(() => review(before), 409);
    assert.deepEqual(state, original);
  }
});

test('after-view requests and corrections retain the exact original action and prediction identity', () => {
  const before = observe(review(ready()), 'before');
  const original = structuredClone(before.beforeTurn!);
  assert(isCameraDecisionAssessment(original.assessment));
  assert.equal(original.predictionId, `prediction:${original.id}`);
  let state = before;
  for (const kind of ['request_view', 'request_measurement', 'hold'] as const) {
    state = observe(state, 'after', workflow, { assessment: evidenceDecision(state, 'after', kind) });
    assert.equal(state.guidance.actionable, false);
    assert.equal(state.guidance.canConfirm, false);
    assert.deepEqual(state.beforeTurn, original);
  }
  state = observe(state, 'after', workflow, { assessment: assessment(state, 'after', {
    decisionKind: 'propose_action', operatorReview: null,
    actionProposal: { ...original.assessment.actionProposal!, instruction: 'Correct only the visible branch conflict.',
      expectedVisibleResult: 'A new recovery condition which cannot rewrite the original prediction.' },
  }) });
  assert.equal(state.guidance.actionable, true);
  assert.equal(state.guidance.canConfirm, false);
  assert.deepEqual(state.beforeTurn, original);
  const readyAfter = observe(state, 'after');
  assert.equal(readyAfter.guidance.canConfirm, true);
  assert.deepEqual(readyAfter.beforeTurn, original);
});

test('a BEFORE operator-review decision cannot substitute for an admitted action prediction', () => {
  const initial = session();
  const reviewBefore = assessment(initial, 'after', { continuity: 'first_view' });
  const held = observe(initial, 'before', workflow, { assessment: reviewBefore });
  assert.equal(held.guidance.actionable, false);
  assert.equal(held.guidance.canConfirm, false);
  assert.equal(held.beforeTurn, null);
  const after = observe(held, 'after');
  assert.equal(after.guidance.canConfirm, false);
  expectDomain(() => review(after), 409);
});

test('measurement requests reject foreign, unrelated, nonnumeric facts, mismatched units and unseen targets', () => {
  const state = review(ready());
  const good = evidenceDecision(state, 'before', 'request_measurement');
  for (const changes of [
    { factKey: 'invented_measurement' }, { factKey: 'branch_labels' }, { factKey: 'scope_confirmed' },
    { unit: 'inches' }, { unit: null }, { targetObservationIds: ['foreign_frame_target'] },
  ]) expectDomain(() => observe(state, 'before', workflow, { assessment: {
    ...good, measurementRequest: { ...good.measurementRequest!, ...changes },
  } }), 400);
  const irrelevantPhase = session();
  expectDomain(() => observe(irrelevantPhase, 'before', workflow, { assessment: evidenceDecision(irrelevantPhase, 'before', 'request_measurement') }), 400);
  assert.equal(state.latestTurn, null);
});

test('the application assigns decision identities and does not accept model-supplied authority', () => {
  const state = session();
  const assessed = observe(state, 'before', workflow, { decisionId: 'forged-decision', requestId: 'forged-request', predictionId: 'forged-prediction' });
  assert.equal(assessed.latestTurn!.decisionId, `decision:${assessed.latestTurn!.id}`);
  assert.equal(assessed.latestTurn!.predictionId, `prediction:${assessed.latestTurn!.id}`);
  assert.equal(assessed.latestTurn!.requestId, null);
  const good = assessment(state, 'before');
  assert.equal(CameraAssessmentSchema.safeParse({ ...good, decisionId: 'model-selected' }).success, false);
});

test('stored legacy and malformed decisions remain readable but cannot regain action or confirmation without reset', () => {
  const current = ready();
  const legacy: LegacyCameraAssessment = {
    summary: 'Synthetic legacy compatibility fixture.', frameQuality: 'clear', continuity: 'same_scene',
    observations: structuredClone(assessment(session(), 'before').observations), suggestedStepId: current.currentStepId,
    stepStatus: 'ready_for_review', questions: [], nextAction: { kind: 'inspect', instruction: 'Historical inspection only.',
      expectedVisibleResult: 'Historical expected condition.', stopCondition: 'Historical stop condition.', targetObservationIds: ['visible_target'] },
  };
  const malformed = { ...assessment(current, 'after'), hold: { reason: 'Conflicting extra payload.', resumeWhen: 'A valid decision is returned.' } };
  for (const stored of [legacy, malformed]) {
    const state = { ...structuredClone(current), latestTurn: { ...structuredClone(current.latestTurn!), assessment: stored } };
    const original = structuredClone(state);
    const held = refreshCameraGuidance(state, workflow, clock());
    assert.equal(held.guidance.actionable, false);
    assert.equal(held.guidance.canConfirm, false);
    assert.deepEqual(state, original);
    expectDomain(() => review(state), 409);
    expectDomain(() => observe(state, 'after'), 409);
    expectDomain(() => recordCameraStepReview(state, { turnId: state.latestTurn!.id, confirmations: {}, notes: 'Historical decisions require a reset.', outcome: 'incomplete' }, workflow, clock()), 409);
    expectDomain(() => undoLastCameraStep(state, workflow, clock()), 409);
    const reset = reviseCameraSession(state, structuredClone(state.facts), workflow, clock());
    assert.equal(reset.latestTurn, null);
    assert.equal(reset.beforeTurn, null);
    assert.equal(observe(reset, 'before').guidance.actionable, true);
  }
});
