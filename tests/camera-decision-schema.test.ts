import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { CameraAssessmentSchema, CameraAssessmentWireSchema, cameraDecisionReferenceIssues,
  cameraTurnDecisionIds, type CameraAssessment } from '../src/camera/schema';
import { cameraWorkflows } from '../src/camera/workflows';

const workflow = cameraWorkflows[0];
const step = workflow.steps[0];
const action: CameraAssessment = {
  contractVersion: 'camera-decision-v3', summary: 'Synthetic contract fixture; no physical result.',
  comparison: null, recovery: null, entityHypotheses: [], planChange: null,
  frameQuality: 'clear', continuity: 'first_view',
  observations: [{ id: 'label-a', label: 'Label A', detail: 'Synthetic visible label.', box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }],
  suggestedStepId: step.id, decisionKind: 'propose_action', viewRequest: null, measurementRequest: null,
  actionProposal: { kind: 'inspect', instruction: 'Inspect the label without moving the part.', preconditions: ['The printed label remains visible.'],
    expectedVisibleResult: 'The operator can compare the declared label.', stopCondition: 'Pause if the label is ambiguous.', targetObservationIds: ['label-a'] },
  operatorReview: null, hold: null,
};

test('the provider contract stays closed and all decision fields are required while local validation rejects mixed intent', () => {
  const wire = z.toJSONSchema(CameraAssessmentWireSchema, { target: 'draft-7' }) as Record<string, any>;
  assert.equal(wire.type, 'object');
  assert.equal(wire.additionalProperties, false);
  assert.equal(wire.anyOf, undefined);
  assert.equal(wire.oneOf, undefined);
  assert.deepEqual(new Set(wire.required), new Set(Object.keys(wire.properties)));
  assert.equal(wire.properties.nextAction, undefined);
  assert.equal(wire.properties.questions, undefined);
  assert.equal(wire.properties.stepStatus, undefined);
  assert(CameraAssessmentSchema.safeParse(action).success);
  const mixed = { ...action, viewRequest: { instruction: 'Show the hidden side.', whyNeeded: 'The identity is unreadable.',
    resolves: 'Whether this is label A.', targetObservationIds: ['label-a'] } };
  assert(CameraAssessmentWireSchema.safeParse(mixed).success, 'The plain wire stays expressible without a union/refinement.');
  assert(!CameraAssessmentSchema.safeParse(mixed).success, 'A model response cannot authorize an action and request more evidence together.');
  for (const rejected of [
    { ...action, actionProposal: null },
    { ...mixed, decisionKind: 'request_view' },
    { ...action, questions: ['An unanswered question cannot accompany the action.'] },
    { ...action, decisionId: 'a-model-cannot-assign-this' },
    { ...action, actionProposal: { ...action.actionProposal!, expectedVisibleResult: '' } },
  ]) assert(!CameraAssessmentSchema.safeParse(rejected).success);
});

test('measurement decisions can refer only to numeric facts and their exact units required by this step', () => {
  const active = cameraWorkflows.flatMap(workflow => workflow.steps.map(step => ({ workflow, step })))
    .find(({ workflow, step }) => step.requiredFactIds.some(id => workflow.requiredFacts.find(fact => fact.id === id)?.kind === 'number'))!;
  const fact = active.workflow.requiredFacts.find(fact => fact.kind === 'number' && active.step.requiredFactIds.includes(fact.id))!;
  const measured: CameraAssessment = { ...action, suggestedStepId: active.step.id, decisionKind: 'request_measurement', actionProposal: null,
    measurementRequest: { factKey: fact.id, unit: fact.unit, instruction: 'Report the actual reading for this confirmed limit.',
      whyNeeded: 'The image cannot provide the measurement.', resolves: 'Whether the stated numeric prerequisite is known.', targetObservationIds: ['label-a'] } };
  assert(CameraAssessmentSchema.safeParse(measured).success);
  assert.deepEqual(cameraDecisionReferenceIssues(measured, active.workflow, active.step.id), []);
  for (const request of [{ ...measured.measurementRequest!, factKey: 'foreign-fact' }, { ...measured.measurementRequest!, unit: 'a-different-unit' }])
    assert(cameraDecisionReferenceIssues({ ...measured, measurementRequest: request }, active.workflow, active.step.id).length > 0);
  assert(cameraDecisionReferenceIssues({ ...action, actionProposal: { ...action.actionProposal!, targetObservationIds: ['unseen'] } }, workflow, step.id).length > 0);
  assert(cameraDecisionReferenceIssues({ ...action, suggestedStepId: 'another-step' }, workflow, step.id).length > 0);
});

test('decision, request and prediction identities derive from the application turn instead of model output', () => {
  assert.deepEqual(cameraTurnDecisionIds('saved-turn', action), { decisionId: 'decision:saved-turn', requestId: null, predictionId: 'prediction:saved-turn' });
  const request: CameraAssessment = { ...action, decisionKind: 'request_view', actionProposal: null,
    viewRequest: { instruction: 'Show the hidden side.', whyNeeded: 'The reference is obscured.', resolves: 'The label identity.', targetObservationIds: [] } };
  assert(CameraAssessmentSchema.safeParse(request).success);
  assert.deepEqual(cameraTurnDecisionIds('saved-turn', request), { decisionId: 'decision:saved-turn', requestId: 'request:saved-turn', predictionId: null });
  const held: CameraAssessment = { ...action, decisionKind: 'hold', actionProposal: null,
    hold: { reason: 'The setup identity is unresolved.', resumeWhen: 'A person re-establishes the reference.' } };
  assert(CameraAssessmentSchema.safeParse(held).success);
  assert.deepEqual(cameraTurnDecisionIds('saved-turn', held), { decisionId: 'decision:saved-turn', requestId: null, predictionId: null });
});
