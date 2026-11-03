import assert from 'node:assert/strict';
import test from 'node:test';
import { addReasoningClaim, bindEntityByOperator, createReasoningState, reasoningContext, ReasoningError,
  recordEntityHypothesis, recordPredictionComparison, recordRecovery, recoveryInformationFingerprint,
  registerPrediction, resolveReasoningClaim, REASONING_LIMITS,
  type PredictionInput, type ReasoningEvidence, type ReasoningState, type ReasoningVersion } from '../src/camera/reasoning';

const version: ReasoningVersion = { runId: 'owned-run', sceneEpoch: 1, stepId: 'route', revision: 1, factsHash: 'a'.repeat(64), planVersion: 'plan:1' };
const evidence = (turnId = 'before', sha256 = 'b'.repeat(64)): ReasoningEvidence => ({ turnId, frameId: `frame:${turnId}`, sha256, observationIds: ['branch-a'] });
const prediction = (turnId = 'before', parentPredictionId: string | null = null): PredictionInput => ({ id: `prediction:${turnId}`, turnId,
  parentPredictionId, version, evidence: evidence(turnId), instruction: 'Inspect the branch A route.', expectedVisibleResult: 'Branch A reaches P1 through L.',
  stopCondition: 'Stop if A or P1 cannot be identified.', targetObservationIds: ['branch-a'] });
const root = () => registerPrediction(createReasoningState(), prediction());
const failed = (state = root(), turnId = 'after', sha256 = 'c'.repeat(64)) => recordPredictionComparison(state, {
  predictionId: state.activePredictionId!, status: 'contradicted', evidenceObservationIds: ['branch-a'], failedConditions: ['Branch A reaches P2.'], unknownConditions: [],
}, { ...version, revision: 2 }, evidence(turnId, sha256));
const recovery = (predictionId = 'prediction:before') => ({ predictionId, changedHypothesis: 'The branch crossing was assigned to the wrong port.',
  failedConditions: ['Branch A reaches P2.'], correction: 'Expose the crossing before a reversible reroute.', nextObservation: 'Show A and P1 together after the crossing is exposed.' });
function expectCode(run: () => unknown, code: ReasoningError['code']) {
  assert.throws(run, (error: unknown) => error instanceof ReasoningError && error.code === code);
}

test('immutable root and corrective child predictions keep exact lineage without historical replay restoring an old target', () => {
  const initial = root(), frozen = JSON.stringify(initial);
  const compared = failed(initial);
  const recovered = recordRecovery(compared, recovery(), { ...version, revision: 2 }, evidence('after', 'c'.repeat(64)));
  const childInput = { ...prediction('after', 'prediction:before'), version: { ...version, revision: 2 }, evidence: evidence('after', 'c'.repeat(64)),
    instruction: 'Expose the crossing.', expectedVisibleResult: 'Both A and P1 labels are simultaneously legible.' };
  const child = registerPrediction(recovered, childInput);
  assert.equal(child.activePredictionId, 'prediction:after');
  assert.equal(child.predictions[1].parentPredictionId, 'prediction:before');
  assert.equal(child.predictions[1].rootPredictionId, 'prediction:before');
  assert.equal(child.predictions[0].expectedVisibleResult, 'Branch A reaches P1 through L.');
  assert.equal(JSON.stringify(initial), frozen, 'The original state was never mutated.');
  assert.equal(registerPrediction(child, prediction()).activePredictionId, 'prediction:after');
  assert.equal(registerPrediction(child, childInput), child);
  expectCode(() => registerPrediction(child, { ...prediction(), expectedVisibleResult: 'A new target invented after seeing the result.' }), 'invalid_reasoning');
  expectCode(() => registerPrediction(compared, childInput), 'invalid_reasoning');
});

test('comparison uses exact active prediction and owned current observation references, with stale versions rejected', () => {
  const initial = root();
  const good = { predictionId: initial.activePredictionId!, status: 'supported_by_view' as const, evidenceObservationIds: ['branch-a'], failedConditions: [], unknownConditions: [] };
  const current = evidence('after');
  const result = recordPredictionComparison(initial, good, { ...version, revision: 2 }, current);
  assert.equal(result.comparisons[0].id, 'comparison:after');
  assert.deepEqual(result.comparisons[0].evidence, current);
  assert.deepEqual(result.comparisons[0].version, { ...version, revision: 2 });
  assert.equal(initial.comparisons.length, 0);
  for (const changed of [{ ...version, sceneEpoch: 2 }, { ...version, runId: 'foreign-run' }, { ...version, stepId: 'another-step' },
    { ...version, factsHash: 'd'.repeat(64) }, { ...version, planVersion: 'plan:2' }])
    expectCode(() => recordPredictionComparison(initial, good, changed, current), 'stale_reasoning');
  expectCode(() => recordPredictionComparison(initial, { ...good, predictionId: 'invented' }, version, current), 'invalid_reasoning');
  expectCode(() => recordPredictionComparison(initial, { ...good, evidenceObservationIds: ['foreign-observation'] }, version, current), 'invalid_reasoning');
});

test('a supported bounded action can continue within the phase without an artificial failure hypothesis', () => {
  const initial = root(), current = evidence('after', 'c'.repeat(64)), v = { ...version, revision: 2 };
  const compared = recordPredictionComparison(initial, { predictionId: initial.activePredictionId!, status: 'supported_by_view',
    evidenceObservationIds: ['branch-a'], failedConditions: [], unknownConditions: [] }, v, current);
  const childInput = { ...prediction('after', initial.activePredictionId), version: v, evidence: current,
    instruction: 'Inspect the next retention point.', expectedVisibleResult: 'The clip retains A without hiding its label.' };
  const child = registerPrediction(compared, childInput);
  assert.equal(child.predictions[1].rootPredictionId, initial.activePredictionId);
  assert.equal(child.recoveries.length, 0, 'Successful continuation is not fabricated into failed recovery.');
  const context = reasoningContext(child, v);
  assert.equal(context.activePrediction?.id, child.predictions[1].id);
  assert.equal(context.rootPrediction?.id, initial.predictions[0].id);
  assert.equal(context.rootPrediction?.expectedVisibleResult, initial.predictions[0].expectedVisibleResult,
    'A later physical anchor must not replace the original root condition in model context.');
  const next = recordPredictionComparison(child, { predictionId: child.activePredictionId!, status: 'unresolved', evidenceObservationIds: [],
    failedConditions: [], unknownConditions: ['The retained label is occluded.'] }, { ...version, revision: 3 }, evidence('after-child', 'd'.repeat(64)));
  assert.equal(next.comparisons[1].predictionId, child.predictions[1].id);
  assert.equal(next.predictions[0].expectedVisibleResult, initial.predictions[0].expectedVisibleResult);
  expectCode(() => recordPredictionComparison(child, { predictionId: initial.activePredictionId!, status: 'supported_by_view',
    evidenceObservationIds: ['branch-a'], failedConditions: [], unknownConditions: [] }, v, current), 'invalid_reasoning');
});

test('supported, contradicted and unresolved outputs cannot hide known failures or missing evidence', () => {
  const initial = root(), current = evidence('after');
  const good = { predictionId: initial.activePredictionId!, status: 'supported_by_view' as const, evidenceObservationIds: ['branch-a'], failedConditions: [], unknownConditions: [] };
  for (const candidate of [{ ...good, unknownConditions: ['The hidden crossing remains unseen.'] }, { ...good, failedConditions: ['Wrong port.'] }, { ...good, evidenceObservationIds: [] }])
    expectCode(() => recordPredictionComparison(initial, candidate, version, current), 'invalid_reasoning');
  expectCode(() => recordPredictionComparison(initial, good, version, current, ['reading:radius-failed']), 'invalid_reasoning');
  expectCode(() => recordPredictionComparison(initial, { ...good, status: 'contradicted' }, version, current), 'invalid_reasoning');
  const unresolved = { ...good, status: 'unresolved' as const, evidenceObservationIds: [], unknownConditions: ['The branch endpoint is not visible.'] };
  assert.equal(recordPredictionComparison(initial, unresolved, version, current).comparisons[0].status, 'unresolved');
  expectCode(() => recordPredictionComparison(initial, unresolved, version, current, ['known-failed-reading']), 'invalid_reasoning');
  const failedReading = recordPredictionComparison(initial, { ...good, status: 'contradicted', evidenceObservationIds: [],
    failedConditions: ['The actual reported radius is below its confirmed bound.'] }, version, { ...current, observationIds: [] }, ['reading:failed-radius']);
  assert.deepEqual(failedReading.comparisons[0].failedReadingIds, ['reading:failed-radius']);
  assert.equal(failedReading.comparisons[0].status, 'contradicted', 'An occluded image cannot erase an actual failed reading.');
});

test('recovery preserves failed conditions and requires the exact current comparison, not unsupported reformulation', () => {
  const compared = failed(), current = evidence('after', 'c'.repeat(64));
  expectCode(() => recordRecovery(root(), recovery(), version, current), 'invalid_reasoning');
  expectCode(() => recordRecovery(compared, { ...recovery(), failedConditions: [] }, { ...version, revision: 2 }, current), 'invalid_reasoning');
  expectCode(() => recordRecovery(compared, recovery(), { ...version, revision: 2 }, evidence('a-different-view', 'd'.repeat(64))), 'invalid_reasoning');
  expectCode(() => recordRecovery(compared, recovery(), version, current), 'stale_reasoning');
  const result = recordRecovery(compared, recovery(), { ...version, revision: 2 }, current);
  assert.equal(result.recoveries[0].comparisonId, 'comparison:after');
  assert.deepEqual(result.recoveries[0].failedConditions, ['Branch A reaches P2.']);
  assert.equal(recordRecovery(result, recovery(), { ...version, revision: 2 }, current), result, 'An exact in-flight replay is idempotent.');
});

test('unchanged pixel information cannot sustain recovery even with a new frame identity or rewritten hypothesis', () => {
  const initial = recordRecovery(failed(), recovery(), { ...version, revision: 2 }, evidence('after', 'c'.repeat(64)));
  const next = failed(initial, 'after-again', 'c'.repeat(64));
  expectCode(() => recordRecovery(next, { ...recovery(), changedHypothesis: 'A cosmetically rewritten account of the same evidence.' },
    { ...version, revision: 3 }, evidence('after-again', 'c'.repeat(64))), 'recovery_limit');
  assert.equal(recoveryInformationFingerprint(evidence('after', 'c'.repeat(64)), version),
    recoveryInformationFingerprint(evidence('after-again', 'c'.repeat(64)), { ...version, revision: 99 }));
});

test('new actual answer or reading receipts count as information while the root recovery allowance stays shared', () => {
  let state = recordRecovery(failed(), recovery(), { ...version, revision: 2 }, evidence('after', 'c'.repeat(64)));
  for (let index = 1; index < REASONING_LIMITS.recoveriesPerRoot; index++) {
    const turnId = `after-${index}`;
    state = failed(state, turnId, 'c'.repeat(64));
    state = recordRecovery(state, recovery(), { ...version, revision: index + 2 }, evidence(turnId, 'c'.repeat(64)), { readingIds: [`reading:${index}`] });
  }
  const final = failed(state, 'after-budget', 'd'.repeat(64));
  expectCode(() => recordRecovery(final, recovery(), { ...version, revision: 10 }, evidence('after-budget', 'd'.repeat(64)), { answerIds: ['genuinely-new-answer'] }), 'recovery_limit');
  assert.equal(state.recoveries.length, 3);
});

test('operator-bound entity identities persist while uncertain model matches cannot merge or rename them', () => {
  const binding = { id: 'entity:a', label: 'A', version, evidence: evidence(), observationId: 'branch-a', operatorConfirmed: true as const };
  const initial = createReasoningState(), bound = bindEntityByOperator(initial, binding);
  assert.equal(initial.entities.length, 0);
  const hypothesis = recordEntityHypothesis(bound, { id: 'hypothesis:after:a', observationId: 'branch-a', candidateEntityIds: ['entity:a'],
    detail: 'This may be the operator-bound branch A; the printed label is obscured.', version, evidence: evidence('after') });
  assert.deepEqual(hypothesis.entities, bound.entities);
  assert.equal(hypothesis.hypotheses[0].provenance, 'model_hypothesis');
  const seenAgain = bindEntityByOperator(hypothesis, { ...binding, version: { ...version, revision: 3 }, evidence: evidence('after') });
  assert.deepEqual(seenAgain.entities, bound.entities, 'A later confirmed sighting cannot rewrite the original identity record.');
  assert.equal(seenAgain.entityBindings.length, 2);
  assert.equal(seenAgain.entityBindings[1].entityId, 'entity:a');
  assert.equal(seenAgain.entityBindings[1].evidence.turnId, 'after');
  expectCode(() => bindEntityByOperator(bound, { ...binding, id: 'entity:b', label: 'a' }), 'invalid_reasoning');
  expectCode(() => bindEntityByOperator(bound, { ...binding, label: 'renamed by a model' }), 'invalid_reasoning');
  expectCode(() => bindEntityByOperator(bound, { ...binding, operatorConfirmed: false as unknown as true }), 'invalid_reasoning');
  expectCode(() => recordEntityHypothesis(bound, { ...hypothesis.hypotheses[0], candidateEntityIds: ['unowned-entity'] }), 'invalid_reasoning');
});

test('counterevidence remains visible beyond the last three reviews and keeps its old-facts provenance', () => {
  let state = addReasoningClaim(createReasoningState(), { id: 'claim:failed-radius', entityIds: [], statement: 'The operator reported a radius below the earlier bound.',
    status: 'reported', source: 'operator_report', version, evidence: evidence() });
  for (let index = 0; index < 20; index++) state = addReasoningClaim(state, { id: `claim:support:${index}`, entityIds: [], statement: `A newer model interpretation ${index}.`,
    status: 'supported_by_view', source: 'model_hypothesis', version, evidence: evidence(`later-${index}`) });
  const context = reasoningContext(state, { ...version, factsHash: 'e'.repeat(64), revision: 30 });
  assert.equal(context.counterevidence[0].id, 'claim:failed-radius');
  assert.equal(context.counterevidence[0].applicability, 'historical_versions_not_current_fact');
  assert.equal(context.supportingClaims.length, REASONING_LIMITS.supportingClaimsInContext);
  assert.equal(context.omittedSupportingClaimCount, 12);
  assert.equal(state.claims.length, 21, 'Packing newer support did not delete retained source claims.');
});

test('reasoning context exposes a detached prediction snapshot rather than mutable access to the ledger', () => {
  const state = root(), context = reasoningContext(state, version);
  context.activePrediction!.expectedVisibleResult = 'A rewritten target.';
  context.rootPrediction!.expectedVisibleResult = 'A rewritten original target.';
  assert.equal(state.predictions[0].expectedVisibleResult, 'Branch A reaches P1 through L.');
});

test('claim resolution requires explicit later operator review and preserves the original negative record', () => {
  const initial = addReasoningClaim(createReasoningState(), { id: 'claim:unseen', entityIds: [], statement: 'The branch endpoint was unseen.',
    status: 'unresolved', source: 'model_hypothesis', version, evidence: evidence() });
  const input = { claimId: 'claim:unseen', resolutionId: 'operator-review:after', version: { ...version, revision: 3 }, evidence: evidence('after'), operatorConfirmed: true as const };
  expectCode(() => resolveReasoningClaim(initial, { ...input, operatorConfirmed: false as unknown as true }), 'invalid_reasoning');
  expectCode(() => resolveReasoningClaim(initial, { ...input, version: { ...input.version, sceneEpoch: 2 } }), 'invalid_reasoning');
  const resolved = resolveReasoningClaim(initial, input);
  assert.equal(resolved.claims[0].statement, initial.claims[0].statement);
  assert.equal(resolved.claims[0].status, 'unresolved');
  assert.equal(resolved.claims[0].resolvedBy?.source, 'operator_review');
  assert.equal(reasoningContext(resolved, input.version).counterevidence.length, 0);
  assert.equal(reasoningContext(resolved, input.version).supportingClaims[0].resolvedBy?.id, input.resolutionId);
});

test('excess unresolved counterevidence fails closed instead of silently selecting a reassuring context', () => {
  let state: ReasoningState = createReasoningState();
  for (let index = 0; index <= REASONING_LIMITS.counterevidenceInContext; index++) state = addReasoningClaim(state, { id: `claim:unknown:${index}`, entityIds: [],
    statement: `Unresolved condition ${index}`, status: 'unresolved', source: 'model_hypothesis', version, evidence: evidence(`turn-${index}`) });
  expectCode(() => reasoningContext(state, version), 'reasoning_limit');
  assert.equal(state.claims.length, REASONING_LIMITS.counterevidenceInContext + 1);
});
