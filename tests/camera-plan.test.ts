import assert from 'node:assert/strict';
import test from 'node:test';
import { approveCameraPlanChange, CameraPlanError, createCameraPlan, proposeCameraPlanChange,
  type CameraPlanChangeInput, type CameraPlanCounterevidence } from '../src/camera/plan';
import type { ReasoningEvidence, ReasoningVersion } from '../src/camera/reasoning';
import { cameraWorkflows } from '../src/camera/workflows';

const workflow = cameraWorkflows[0], phase = workflow.steps[2].id;
const version: ReasoningVersion = { runId: 'owned-run', sceneEpoch: 1, stepId: phase, revision: 7, factsHash: 'a'.repeat(64), planVersion: 'plan:base' };
const evidence: ReasoningEvidence = { turnId: 'corrective-turn', frameId: 'current-frame', sha256: 'b'.repeat(64), observationIds: ['branch-a'] };
const counter: CameraPlanCounterevidence = { id: 'comparison:failure', version, frameId: evidence.frameId, sha256: evidence.sha256, status: 'contradicted' };
const change: CameraPlanChangeInput = { sourceTurnId: evidence.turnId, parentPlanVersion: version.planVersion, kind: 'within_phase', reopenStepId: null,
  substeps: [{ instruction: 'Inspect the declared clip beside A.', preconditions: ['A remains legible.'], expectedVisibleResult: 'A can be retained without concealing its label.', stopCondition: 'Pause if the clip is not identified.' }],
  counterevidenceIds: [counter.id], rationale: 'The currently shown retention point obscured the branch label.' };
const context = { version, evidence, workflow, ownedCounterevidence: [counter] };
const proposed = () => proposeCameraPlanChange(createCameraPlan(workflow, version), change, context);
const approval = { proposalId: 'plan-change:corrective-turn', clientOperationId: 'approval-operation', operatorConfirmed: true as const,
  version, workflow, completedStepIds: workflow.steps.slice(0, 2).map(step => step.id) };
function reject(run: () => unknown, code: CameraPlanError['code']) { assert.throws(run, (error: unknown) => error instanceof CameraPlanError && error.code === code); }

test('a checked within-phase adaptation preserves every catalog obligation and still requires fresh action views and physical review', () => {
  const initial = createCameraPlan(workflow, version), frozen = JSON.stringify(initial);
  const state = proposeCameraPlanChange(initial, change, context);
  assert.equal(state.current.id, initial.current.id, 'A model proposal cannot commit a new plan.');
  const result = approveCameraPlanChange(state, approval);
  assert.equal(result.replayed, false);
  if (result.replayed) return;
  assert.equal(result.state.current.parentId, initial.current.id);
  assert.equal(result.state.current.id, 'plan:corrective-turn');
  assert.equal(result.state.current.mandatoryObligations, initial.current.mandatoryObligations);
  assert.deepEqual(result.retainedCompletedStepIds, approval.completedStepIds);
  assert.deepEqual(result.invalidatedStepIds, []);
  assert.equal(result.currentStepId, phase);
  assert.equal(result.requiresFreshView, true);
  assert.equal(result.state.current.substepsByPhase[phase][0].id, 'substep:corrective-turn:1');
  assert.equal(result.state.proposals[0].status, 'accepted');
  assert.equal(JSON.stringify(initial), frozen, 'Approving cannot mutate earlier plan records.');
});

test('reopening an earlier phase invalidates its completion and every later completion while retaining prior history', () => {
  const reopen = { ...change, kind: 'reopen_phase' as const, reopenStepId: workflow.steps[1].id, substeps: [] };
  const state = proposeCameraPlanChange(createCameraPlan(workflow, version), reopen, context);
  const result = approveCameraPlanChange(state, approval);
  assert.equal(result.replayed, false);
  if (result.replayed) return;
  assert.equal(result.currentStepId, workflow.steps[1].id);
  assert.deepEqual(result.retainedCompletedStepIds, [workflow.steps[0].id]);
  assert.deepEqual(result.invalidatedStepIds, [workflow.steps[1].id]);
  assert.equal(result.state.history[0].id, version.planVersion);
  assert.equal(result.state.current.mandatoryObligations, state.current.mandatoryObligations);
});

test('plan proposals reject unowned, old-facts, old-scene or later evidence and never allow skipping phases', () => {
  const initial = createCameraPlan(workflow, version);
  for (const bad of [[], [{ ...counter, id: 'unowned-id' }], [{ ...counter, status: 'supported_by_view' }],
    [{ ...counter, version: { ...version, runId: 'foreign-run' } }], [{ ...counter, version: { ...version, sceneEpoch: 2 } }],
    [{ ...counter, version: { ...version, factsHash: 'c'.repeat(64) } }], [{ ...counter, version: { ...version, revision: 8 } }]])
    reject(() => proposeCameraPlanChange(initial, change, { ...context, ownedCounterevidence: bad as CameraPlanCounterevidence[] }), 'invalid_plan_change');
  for (const reopenStepId of [phase, workflow.steps[3].id, 'made-up-phase'])
    reject(() => proposeCameraPlanChange(initial, { ...change, kind: 'reopen_phase', reopenStepId, substeps: [] }, context), 'invalid_plan_change');
  reject(() => proposeCameraPlanChange(initial, { ...change, substeps: [] }, context), 'invalid_plan_change');
  reject(() => proposeCameraPlanChange(initial, { ...change, substeps: Array.from({ length: 5 }, () => change.substeps[0]) }, context), 'invalid_plan_change');
});

test('operator approval rejects stale state, changed parent and relaxed mandatory checks', () => {
  const state = proposed();
  reject(() => approveCameraPlanChange(state, { ...approval, operatorConfirmed: false as unknown as true }), 'invalid_plan_change');
  reject(() => approveCameraPlanChange(state, { ...approval, version: { ...version, revision: 8 } }), 'stale_plan_change');
  reject(() => approveCameraPlanChange(state, { ...approval, version: { ...version, factsHash: 'c'.repeat(64) } }), 'stale_plan_change');
  const relaxed = structuredClone(workflow); relaxed.steps[2].requiredConfirmations = [];
  reject(() => approveCameraPlanChange(state, { ...approval, workflow: relaxed }), 'stale_plan_change');
  const skipped = [...approval.completedStepIds, phase];
  reject(() => approveCameraPlanChange(state, { ...approval, completedStepIds: skipped }), 'invalid_plan_change');
});

test('approval receipt replay cannot restore the earlier parent or phase after the plan advanced', () => {
  const first = approveCameraPlanChange(proposed(), approval);
  assert.equal(first.replayed, false);
  if (first.replayed) return;
  const replay = approveCameraPlanChange(first.state, approval);
  assert.equal(replay.replayed, true);
  assert.equal(replay.state, first.state);
  assert.equal(replay.state.current.id, first.state.current.id);
  assert.equal('currentStepId' in replay, false, 'A replay has no transition the caller could accidentally reapply.');
  reject(() => approveCameraPlanChange(first.state, { ...approval, proposalId: 'a-different-proposal' }), 'invalid_plan_change');
});
