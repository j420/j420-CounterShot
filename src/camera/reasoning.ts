/** Serializable application reasoning records. Model interpretations remain hypotheses. */
export const REASONING_VERSION = 'camera-reasoning-v1';
export const REASONING_LIMITS = { predictions: 100, comparisons: 200, recoveriesPerRoot: 3, entities: 50,
  hypotheses: 200, claims: 200, counterevidenceInContext: 40, supportingClaimsInContext: 8 } as const;

export type ReasoningVersion = {
  runId: string; sceneEpoch: number; stepId: string; revision: number; factsHash: string; planVersion: string;
};
export type ReasoningEvidence = { turnId: string; frameId: string; sha256: string; observationIds: string[] };
export type Prediction = {
  id: string; turnId: string; parentPredictionId: string | null; rootPredictionId: string;
  version: ReasoningVersion; evidence: ReasoningEvidence; instruction: string;
  expectedVisibleResult: string; stopCondition: string; targetObservationIds: string[];
  targetObservations?: { id: string; label: string; detail: string;
    box: { x: number; y: number; width: number; height: number } | null }[];
};
export type PredictionInput = Omit<Prediction, 'parentPredictionId' | 'rootPredictionId'> & { parentPredictionId?: string | null };
export type PredictionComparisonInput = {
  predictionId: string; status: 'supported_by_view' | 'contradicted' | 'unresolved'; evidenceObservationIds: string[];
  failedConditions: string[]; unknownConditions: string[];
};
export type PredictionComparison = PredictionComparisonInput & {
  id: string; version: ReasoningVersion; evidence: ReasoningEvidence; failedReadingIds: string[];
};
export type RecoveryInput = { predictionId: string; changedHypothesis: string; failedConditions: string[];
  correction: string; nextObservation: string };
export type Recovery = RecoveryInput & {
  id: string; rootPredictionId: string; comparisonId: string; version: ReasoningVersion;
  evidence: ReasoningEvidence; informationFingerprint: string; answerIds: string[]; readingIds: string[];
};
export type PhysicalEntity = { id: string; label: string; version: ReasoningVersion; observationId: string;
  evidence: ReasoningEvidence; binding: 'operator_confirmed' };
export type EntityBinding = { id: string; entityId: string; observationId: string; version: ReasoningVersion;
  evidence: ReasoningEvidence; binding: 'operator_confirmed' };
export type EntityHypothesis = { id: string; observationId: string; candidateEntityIds: string[];
  detail: string; version: ReasoningVersion; evidence: ReasoningEvidence; provenance: 'model_hypothesis' };
export type ReasoningClaim = { id: string; entityIds: string[]; statement: string;
  status: 'supported_by_view' | 'contradicted' | 'unresolved' | 'reported'; source: 'model_hypothesis' | 'operator_report' | 'comparison';
  version: ReasoningVersion; evidence: ReasoningEvidence; resolvedBy: null | {
    id: string; version: ReasoningVersion; evidence: ReasoningEvidence; source: 'operator_review';
  } };
export type ReasoningState = { version: typeof REASONING_VERSION; activePredictionId: string | null;
  predictions: Prediction[]; comparisons: PredictionComparison[]; recoveries: Recovery[];
  entities: PhysicalEntity[]; entityBindings: EntityBinding[]; hypotheses: EntityHypothesis[]; claims: ReasoningClaim[] };

export class ReasoningError extends Error {
  constructor(public code: 'invalid_reasoning' | 'stale_reasoning' | 'recovery_limit' | 'reasoning_limit', message: string) {
    super(message); this.name = 'ReasoningError';
  }
}
function invalid(message: string): never { throw new ReasoningError('invalid_reasoning', message); }
function validateState(value: ReasoningState) {
  if (!value || value.version !== REASONING_VERSION || !['predictions', 'comparisons', 'recoveries', 'entities', 'entityBindings', 'hypotheses', 'claims']
    .every(key => Array.isArray(value[key as keyof ReasoningState]))) invalid('The saved reasoning state is unavailable or uses a different contract.');
}
function boundedText(value: string, name: string, maximum = 1000) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) invalid(`${name} must be recorded bounded text.`);
}
function ids(values: string[], name: string, maximum = 50) {
  if (!Array.isArray(values) || values.length > maximum || new Set(values).size !== values.length
    || values.some(value => typeof value !== 'string' || !value.trim() || value.length > 200)) invalid(`${name} need distinct recorded identities.`);
}
function validateVersion(value: ReasoningVersion) {
  if (!value || typeof value !== 'object') invalid('A recorded reasoning version is required.');
  boundedText(value.runId, 'Run identity', 200); boundedText(value.stepId, 'Step identity', 200);
  boundedText(value.planVersion, 'Plan version', 200);
  if (!Number.isSafeInteger(value.revision) || value.revision < 1 || !Number.isSafeInteger(value.sceneEpoch) || value.sceneEpoch < 1
    || typeof value.factsHash !== 'string' || !/^[a-f0-9]{64}$/i.test(value.factsHash)) invalid('Reasoning needs exact recorded state, scene and facts versions.');
}
function validateEvidence(value: ReasoningEvidence) {
  if (!value || typeof value !== 'object') invalid('Recorded evidence is required.');
  boundedText(value.turnId, 'Evidence turn', 200); boundedText(value.frameId, 'Evidence frame', 200);
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(value.sha256)) invalid('Reasoning evidence needs its exact canonical SHA-256.');
  ids(value.observationIds, 'Evidence observations', 5);
}
function sameScope(a: ReasoningVersion, b: ReasoningVersion) { return a.runId === b.runId && a.sceneEpoch === b.sceneEpoch && a.stepId === b.stepId; }
function sameVersions(a: ReasoningVersion, b: ReasoningVersion) {
  return sameScope(a, b) && a.factsHash === b.factsHash && a.planVersion === b.planVersion && b.revision >= a.revision;
}
function requireCurrent(previous: ReasoningVersion, current: ReasoningVersion) {
  validateVersion(current);
  if (!sameVersions(previous, current)) throw new ReasoningError('stale_reasoning', 'The prediction belongs to different facts, scene, phase or plan. Establish a new admitted prediction.');
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .filter(([, item]) => item !== undefined).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
function limit(length: number, maximum: number, name: string) {
  if (length >= maximum) throw new ReasoningError('reasoning_limit', `The bounded ${name} record is full. Start a deliberate new run or review the retained evidence; nothing was silently discarded.`);
}
function immutableAppend<T extends { id: string }>(values: T[], value: T, maximum: number, name: string): T[] {
  const existing = values.find(item => item.id === value.id);
  if (existing) {
    if (canonical(existing) !== canonical(value)) invalid(`The immutable ${name} identity already belongs to different inputs.`);
    return values;
  }
  limit(values.length, maximum, name);
  return [...values, structuredClone(value)];
}
function observationReferences(selected: string[], evidence: ReasoningEvidence, name: string, allowEmpty = false) {
  ids(selected, name, 5);
  if ((!allowEmpty && !selected.length) || selected.some(id => !evidence.observationIds.includes(id)))
    invalid(`${name} must refer to observations in the exact current evidence.`);
}
function conditions(values: string[], name: string) {
  if (!Array.isArray(values) || values.length > 5) invalid(`${name} must be a bounded list.`);
  values.forEach(value => boundedText(value, name));
}
function activePrediction(state: ReasoningState, predictionId: string, version: ReasoningVersion) {
  const prediction = state.predictions.find(item => item.id === predictionId);
  if (!prediction || state.activePredictionId !== predictionId) invalid('Compare or recover the exact active prediction, not a rewritten or historical target.');
  requireCurrent(prediction.version, version);
  return prediction;
}
export function createReasoningState(): ReasoningState {
  return { version: REASONING_VERSION, activePredictionId: null, predictions: [], comparisons: [], recoveries: [], entities: [], entityBindings: [], hypotheses: [], claims: [] };
}

/** Only the application calls this after its action gates admit a proposal. */
export function registerPrediction(state: ReasoningState, input: PredictionInput): ReasoningState {
  validateState(state);
  validateVersion(input.version); validateEvidence(input.evidence);
  if (input.id !== `prediction:${input.turnId}` || input.turnId !== input.evidence.turnId) invalid('Prediction identities derive from the admitted application turn.');
  boundedText(input.instruction, 'Predicted action'); boundedText(input.expectedVisibleResult, 'Expected visible result'); boundedText(input.stopCondition, 'Stop condition');
  observationReferences(input.targetObservationIds, input.evidence, 'Prediction targets');
  if (input.targetObservations) {
    observationReferences(input.targetObservations.map(item => item.id), input.evidence, 'Original prediction observations');
    if (input.targetObservations.some(item => !input.targetObservationIds.includes(item.id))) invalid('Original prediction observations must describe its exact selected targets.');
    input.targetObservations.forEach(item => { boundedText(item.label, 'Original target label'); boundedText(item.detail, 'Original target detail'); });
  }
  const existing = state.predictions.find(item => item.id === input.id);
  if (existing) {
    const supplied = { ...structuredClone(input), parentPredictionId: input.parentPredictionId || null,
      rootPredictionId: input.parentPredictionId ? state.predictions.find(item => item.id === input.parentPredictionId)?.rootPredictionId : input.id };
    if (canonical(existing) !== canonical(supplied)) invalid('The immutable prediction identity already belongs to different inputs.');
    return state; // Replaying a historical turn must not restore its active target.
  }
  const parent = input.parentPredictionId ? activePrediction(state, input.parentPredictionId, input.version) : null;
  if (parent) {
    const recovery = [...state.recoveries].reverse().find(item => item.predictionId === parent.id && item.evidence.turnId === input.turnId);
    const comparison = [...state.comparisons].reverse().find(item => item.predictionId === parent.id);
    const checkedContinuation = comparison?.status === 'supported_by_view' && comparison.evidence.turnId === input.turnId
      && comparison.evidence.frameId === input.evidence.frameId && comparison.evidence.sha256 === input.evidence.sha256
      && comparison.evidence.sha256 !== parent.evidence.sha256 && !comparison.failedReadingIds.length
      && !comparison.failedConditions.length && !comparison.unknownConditions.length && sameVersions(comparison.version, input.version);
    const checkedRecovery = recovery && recovery.evidence.frameId === input.evidence.frameId && recovery.evidence.sha256 === input.evidence.sha256
      && sameVersions(recovery.version, input.version);
    if (!checkedRecovery && !checkedContinuation) invalid('A child prediction needs checked recovery or a supported current-turn comparison before another bounded action.');
  }
  const value: Prediction = { ...structuredClone(input), parentPredictionId: parent?.id || null, rootPredictionId: parent?.rootPredictionId || input.id };
  return { ...state, predictions: immutableAppend(state.predictions, value, REASONING_LIMITS.predictions, 'prediction'), activePredictionId: value.id };
}

/** Stamp provider interpretations with application-owned evidence and version identities. */
export function recordPredictionComparison(state: ReasoningState, input: PredictionComparisonInput,
  version: ReasoningVersion, evidence: ReasoningEvidence, failedReadingIds: string[] = []): ReasoningState {
  validateState(state);
  activePrediction(state, input.predictionId, version); validateEvidence(evidence); ids(failedReadingIds, 'Failed readings');
  if (!['supported_by_view', 'contradicted', 'unresolved'].includes(input.status)) invalid('The prediction comparison status is unavailable.');
  conditions(input.failedConditions, 'Failed conditions'); conditions(input.unknownConditions, 'Unknown conditions');
  observationReferences(input.evidenceObservationIds, evidence, 'Comparison evidence', input.status === 'unresolved'
    || (input.status === 'contradicted' && failedReadingIds.length > 0));
  if (input.status === 'supported_by_view' && (input.failedConditions.length || input.unknownConditions.length || failedReadingIds.length))
    invalid('Supported comparisons cannot conceal failed readings or failed/unknown conditions.');
  if (input.status === 'contradicted' && !input.failedConditions.length) invalid('A contradicted comparison must name the failed predicted condition.');
  if (input.status === 'unresolved' && (!input.unknownConditions.length || input.failedConditions.length || failedReadingIds.length))
    invalid('Unresolved comparisons name unknown conditions; known failures must remain contradicted.');
  const value: PredictionComparison = { ...structuredClone(input), id: `comparison:${evidence.turnId}`, version: structuredClone(version),
    evidence: structuredClone(evidence), failedReadingIds: [...failedReadingIds] };
  const comparisons = immutableAppend(state.comparisons, value, REASONING_LIMITS.comparisons, 'comparison');
  return { ...state, comparisons };
}

/** Exact information identity, not a perceptual assertion that two images differ meaningfully. */
export function recoveryInformationFingerprint(evidence: ReasoningEvidence, version: ReasoningVersion,
  receipts: { answerIds?: string[]; readingIds?: string[] } = {}) {
  validateEvidence(evidence); validateVersion(version); ids(receipts.answerIds || [], 'Answered requests'); ids(receipts.readingIds || [], 'Reported readings');
  return canonical({ frameSha256: evidence.sha256.toLowerCase(), factsHash: version.factsHash, planVersion: version.planVersion,
    answerIds: [...(receipts.answerIds || [])].sort(), readingIds: [...(receipts.readingIds || [])].sort() });
}
export function recordRecovery(state: ReasoningState, input: RecoveryInput, version: ReasoningVersion, evidence: ReasoningEvidence,
  receipts: { answerIds?: string[]; readingIds?: string[] } = {}): ReasoningState {
  validateState(state);
  const prediction = activePrediction(state, input.predictionId, version); validateEvidence(evidence);
  boundedText(input.changedHypothesis, 'Changed hypothesis'); boundedText(input.correction, 'Proposed correction'); boundedText(input.nextObservation, 'Next discriminating observation');
  conditions(input.failedConditions, 'Recovery failed conditions');
  const comparison = [...state.comparisons].reverse().find(item => item.predictionId === prediction.id);
  if (!comparison || comparison.status === 'supported_by_view' || comparison.evidence.frameId !== evidence.frameId || comparison.evidence.sha256 !== evidence.sha256
    || comparison.evidence.turnId !== evidence.turnId) invalid('Recovery needs the exact current contradicted or unresolved comparison.');
  requireCurrent(comparison.version, version);
  if (comparison.failedConditions.some(condition => !input.failedConditions.includes(condition))) invalid('Recovery cannot erase the comparison failed conditions.');
  const fingerprint = recoveryInformationFingerprint(evidence, version, receipts);
  const previous = state.recoveries.filter(item => item.rootPredictionId === prediction.rootPredictionId);
  const value: Recovery = { ...structuredClone(input), id: `recovery:${evidence.turnId}`, rootPredictionId: prediction.rootPredictionId,
    comparisonId: comparison.id, version: structuredClone(version), evidence: structuredClone(evidence), informationFingerprint: fingerprint,
    answerIds: [...(receipts.answerIds || [])], readingIds: [...(receipts.readingIds || [])] };
  const existing = state.recoveries.find(item => item.id === value.id);
  if (existing && canonical(existing) === canonical(value)) return state;
  if (previous.length >= REASONING_LIMITS.recoveriesPerRoot || previous.some(item => item.informationFingerprint === fingerprint))
    throw new ReasoningError('recovery_limit', 'Recovery needs new evidence or a reported answer and has a three-attempt root-prediction limit. Request discriminating information or hold.');
  return { ...state, recoveries: immutableAppend(state.recoveries, value, REASONING_LIMITS.predictions * REASONING_LIMITS.recoveriesPerRoot, 'recovery') };
}

/** A proposed visual match never creates, renames or merges confirmed physical entities. */
export function recordEntityHypothesis(state: ReasoningState, input: Omit<EntityHypothesis, 'provenance'>): ReasoningState {
  validateState(state);
  validateVersion(input.version); validateEvidence(input.evidence); ids(input.candidateEntityIds, 'Candidate entities', 5);
  boundedText(input.id, 'Hypothesis identity', 200); boundedText(input.detail, 'Identity hypothesis');
  observationReferences([input.observationId], input.evidence, 'Hypothesis observation');
  if (input.candidateEntityIds.some(id => !state.entities.some(entity => entity.id === id && entity.version.runId === input.version.runId
    && entity.version.sceneEpoch === input.version.sceneEpoch))) invalid('Identity hypotheses may only refer to owned entities in this scene.');
  const value: EntityHypothesis = { ...structuredClone(input), provenance: 'model_hypothesis' };
  return { ...state, hypotheses: immutableAppend(state.hypotheses, value, REASONING_LIMITS.hypotheses, 'identity hypothesis') };
}
export function bindEntityByOperator(state: ReasoningState, input: Omit<PhysicalEntity, 'binding'> & { operatorConfirmed: true }): ReasoningState {
  validateState(state);
  if (input.operatorConfirmed !== true) invalid('Physical identity binding requires explicit operator confirmation.');
  validateVersion(input.version); validateEvidence(input.evidence); boundedText(input.id, 'Entity identity', 200); boundedText(input.label, 'Physical label', 200);
  observationReferences([input.observationId], input.evidence, 'Physical label observation');
  if (!input.id.startsWith('entity:')) invalid('Physical entity identities are application assigned.');
  const label = input.label.trim().toLocaleLowerCase('en-US');
  if (state.entities.some(entity => entity.id !== input.id && entity.version.runId === input.version.runId && entity.version.sceneEpoch === input.version.sceneEpoch
    && entity.label.trim().toLocaleLowerCase('en-US') === label)) invalid('A duplicate physical label needs disambiguation before binding another entity.');
  const { operatorConfirmed: _confirmed, ...record } = input;
  const value: PhysicalEntity = { ...structuredClone(record), binding: 'operator_confirmed' };
  const existing = state.entities.find(entity => entity.id === input.id);
  if (existing && (existing.label !== input.label || existing.version.runId !== input.version.runId
    || existing.version.sceneEpoch !== input.version.sceneEpoch || input.version.revision < existing.version.revision))
    invalid('An existing physical entity cannot be renamed, merged or rebound to another scene.');
  const sighting: EntityBinding = { id: `binding:${input.evidence.turnId}:${input.observationId}`, entityId: input.id,
    observationId: input.observationId, version: structuredClone(input.version), evidence: structuredClone(input.evidence), binding: 'operator_confirmed' };
  return { ...state, entities: existing ? state.entities : immutableAppend(state.entities, value, REASONING_LIMITS.entities, 'physical entity'),
    entityBindings: immutableAppend(state.entityBindings, sighting, REASONING_LIMITS.hypotheses, 'operator identity binding') };
}
export function addReasoningClaim(state: ReasoningState, input: Omit<ReasoningClaim, 'resolvedBy'>): ReasoningState {
  validateState(state);
  validateVersion(input.version); validateEvidence(input.evidence); boundedText(input.id, 'Claim identity', 200); boundedText(input.statement, 'Claim'); ids(input.entityIds, 'Claim entities', 5);
  if (!['supported_by_view', 'contradicted', 'unresolved', 'reported'].includes(input.status)
    || !['model_hypothesis', 'operator_report', 'comparison'].includes(input.source)) invalid('Claim provenance is unavailable.');
  if (input.source === 'operator_report' && input.status !== 'reported') invalid('Operator reports stay reports rather than model-verified facts.');
  if (input.entityIds.some(id => !state.entities.some(entity => entity.id === id && entity.version.runId === input.version.runId
    && entity.version.sceneEpoch === input.version.sceneEpoch))) invalid('Claim identities must belong to this scene.');
  const value: ReasoningClaim = { ...structuredClone(input), resolvedBy: null };
  return { ...state, claims: immutableAppend(state.claims, value, REASONING_LIMITS.claims, 'claim') };
}
export function resolveReasoningClaim(state: ReasoningState, input: { claimId: string; resolutionId: string;
  version: ReasoningVersion; evidence: ReasoningEvidence; operatorConfirmed: true }): ReasoningState {
  validateState(state);
  if (input.operatorConfirmed !== true) invalid('A retained failed/unknown claim requires explicit operator review before resolution.');
  validateVersion(input.version); validateEvidence(input.evidence); boundedText(input.resolutionId, 'Resolution review identity', 200);
  const claim = state.claims.find(item => item.id === input.claimId);
  if (!claim || !sameScope(claim.version, input.version) || input.version.revision < claim.version.revision) invalid('Resolve only an owned current-scene claim with a later review.');
  const resolution = { id: input.resolutionId, version: structuredClone(input.version), evidence: structuredClone(input.evidence), source: 'operator_review' as const };
  if (claim.resolvedBy && canonical(claim.resolvedBy) !== canonical(resolution)) invalid('The claim resolution already belongs to a different review.');
  return { ...state, claims: state.claims.map(item => item.id === claim.id ? { ...item, resolvedBy: resolution } : item) };
}

/** Never silently pack away unresolved counterevidence to make room for newer praise. */
export function reasoningContext(state: ReasoningState, version: ReasoningVersion) {
  validateState(state);
  validateVersion(version);
  const claims = state.claims.filter(claim => sameScope(claim.version, version));
  const counterevidence = claims.filter(claim => !claim.resolvedBy && ['contradicted', 'unresolved', 'reported'].includes(claim.status));
  if (counterevidence.length > REASONING_LIMITS.counterevidenceInContext)
    throw new ReasoningError('reasoning_limit', 'Unresolved counterevidence exceeds the bounded context. Review or retrieve those claims before further action; none was silently dropped.');
  const contextual = (claim: ReasoningClaim) => ({ ...structuredClone(claim), applicability: claim.version.factsHash === version.factsHash
    && claim.version.planVersion === version.planVersion ? 'current_versions' : 'historical_versions_not_current_fact' });
  const positive = claims.filter(claim => claim.resolvedBy || claim.status === 'supported_by_view');
  const active = state.predictions.find(item => item.id === state.activePredictionId && sameVersions(item.version, version)) || null;
  const root = active ? state.predictions.find(item => item.id === active.rootPredictionId) || null : null;
  return { version: REASONING_VERSION, activePrediction: structuredClone(active), rootPrediction: structuredClone(root),
    counterevidence: counterevidence.map(contextual), supportingClaims: positive.slice(-REASONING_LIMITS.supportingClaimsInContext).map(contextual),
    comparisons: state.comparisons.filter(item => sameScope(item.version, version)).slice(-20).map(item => structuredClone(item)),
    omittedSupportingClaimCount: Math.max(0, positive.length - REASONING_LIMITS.supportingClaimsInContext),
    entities: state.entities.filter(entity => entity.version.runId === version.runId && entity.version.sceneEpoch === version.sceneEpoch).map(entity => structuredClone(entity)),
    entityBindings: state.entityBindings.filter(binding => sameScope(binding.version, version)).slice(-20).map(binding => structuredClone(binding)),
    identityHypotheses: state.hypotheses.filter(hypothesis => sameScope(hypothesis.version, version)).slice(-10).map(hypothesis => structuredClone(hypothesis)),
    recoveryAttempts: state.recoveries.filter(recovery => sameScope(recovery.version, version)).map(recovery => structuredClone(recovery)),
  };
}
