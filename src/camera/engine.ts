import {
  CAMERA_ENGINE_VERSION, CAMERA_FRAME_FRESHNESS_MS, CameraAssessmentSchema, cameraDecisionReferenceIssues,
  cameraDecisionTargets, cameraTurnDecisionIds, isCameraDecisionAssessment, type CameraFacts, type CameraGuidance,
  type CameraSession, type CameraStepReview, type CameraTurn, type WorkflowDefinition, type WorkflowStepDefinition, type WorkflowMeasurementDefinition,
  type CameraEvidenceRequest, type CameraEvidenceAnswer, type CameraRequestChecksVersion,
  type CameraReadingReport,
} from './schema';
import { addReasoningClaim, bindEntityByOperator, createReasoningState, recordEntityHypothesis, recordPredictionComparison, recordRecovery, registerPrediction, resolveReasoningClaim,
  ReasoningError, type ReasoningEvidence, type ReasoningState, type ReasoningVersion } from './reasoning';
import { createCameraPlan, CAMERA_PLAN_LIMITS, CameraPlanError, proposeCameraPlanChange, approveCameraPlanChange, type CameraPlanCounterevidence } from './plan';

export class CameraDomainError extends Error {
  constructor(public status: 400 | 409, message: string) { super(message); this.name = 'CameraDomainError'; }
}
function reject(status: 400 | 409, message: string): never { throw new CameraDomainError(status, message); }
const timestamp = (value: string, label: string): number => {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) reject(400, `${label} must be a valid timestamp.`);
  return time;
};

function assertWorkflow(workflow: WorkflowDefinition) {
  if (!workflow.steps.length || new Set(workflow.steps.map(step => step.id)).size !== workflow.steps.length)
    reject(400, 'The workflow must contain distinct, ordered steps.');
  const facts = new Set(workflow.requiredFacts.map(fact => fact.id));
  if (facts.size !== workflow.requiredFacts.length) reject(400, 'The workflow fact identities must be distinct.');
  for (const step of workflow.steps) {
    if (step.requiredFactIds.some(id => !facts.has(id))) reject(400, 'A workflow step refers to an unknown fact.');
    if (!step.requiredConfirmations.length || new Set(step.requiredConfirmations.map(check => check.id)).size !== step.requiredConfirmations.length)
      reject(400, 'Each workflow step needs distinct operator checks.');
    const measurements = step.measurements || [];
    if (new Set(measurements.map(measurement => measurement.id)).size !== measurements.length || measurements.some(measurement =>
      !step.requiredFactIds.includes(measurement.factId) || workflow.requiredFacts.find(fact => fact.id === measurement.factId)?.kind !== 'number'
      || (measurement.relation === 'within_tolerance' && (!step.requiredFactIds.includes(measurement.toleranceFactId)
        || workflow.requiredFacts.find(fact => fact.id === measurement.toleranceFactId)?.kind !== 'number'))))
      reject(400, 'Workflow measurements need distinct identities and a confirmed numeric bound.');
  }
}

/** Facts can be incomplete, but no model-returned value can silently become one. */
export function validateCameraFacts(workflow: WorkflowDefinition, input: unknown): CameraFacts {
  assertWorkflow(workflow);
  if (!input || typeof input !== 'object' || Array.isArray(input)) reject(400, 'Confirm the workflow facts as named values.');
  const result: CameraFacts = {};
  for (const [id, value] of Object.entries(input)) {
    const fact = workflow.requiredFacts.find(candidate => candidate.id === id);
    if (!fact) reject(400, `Unknown fact: ${id}.`);
    if (fact.kind === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value) || (fact.min !== null && value < fact.min) || (fact.max !== null && value > fact.max))
        reject(400, `Enter an actual measured value within the supported range for ${fact.label}.`);
      result[id] = value;
    } else if (fact.kind === 'boolean') {
      if (typeof value !== 'boolean') reject(400, `Explicitly confirm ${fact.label}.`);
      result[id] = value;
    } else {
      if (typeof value !== 'string' || value.length > 4000) reject(400, `Enter the confirmed description for ${fact.label}.`);
      result[id] = value.trim();
    }
  }
  for (const step of workflow.steps) for (const measurement of step.measurements || []) {
    if (measurement.relation !== 'within_tolerance') continue;
    const target = result[measurement.factId], tolerance = result[measurement.toleranceFactId];
    if (typeof tolerance === 'number' && (tolerance <= 0 || (typeof target === 'number' && tolerance >= target)))
      reject(400, 'The confirmed outline tolerance must be positive and smaller than each reference dimension.');
  }
  return result;
}

function currentStep(session: CameraSession, workflow: WorkflowDefinition): WorkflowStepDefinition | null {
  if (session.workflowId !== workflow.id) reject(409, 'This session belongs to a different workflow.');
  return workflow.steps.find(step => step.id === session.currentStepId) || null;
}

/** The caller supplies the actual canonical facts hash; no model authors these versions. */
export function initializeCameraReasoning<T extends CameraSession>(session: T, workflow: WorkflowDefinition, input: { runId: string; factsHash: string }): T {
  if (!session.currentStepId) return { ...structuredClone(session), reasoning: { ...(session.reasoning || createReasoningState()), activePredictionId: null } };
  const prior = session.plan;
  const unchanged = prior && prior.current.version.runId === input.runId && prior.current.version.sceneEpoch === session.sceneEpoch
    && prior.current.version.factsHash === input.factsHash;
  if (unchanged) return { ...structuredClone(session), reasoning: structuredClone(session.reasoning || createReasoningState()) };
  if (prior && prior.history.length + 1 >= CAMERA_PLAN_LIMITS.versions) reject(409, 'The bounded plan history is full. Start a deliberate new run; earlier plans remain saved.');
  const planVersion = prior ? `plan:${input.runId}:scene:${session.sceneEpoch}:revision:${session.revision}` : `plan:${input.runId}:scene:${session.sceneEpoch}`;
  const plan = createCameraPlan(workflow, { runId: input.runId, factsHash: input.factsHash, sceneEpoch: session.sceneEpoch,
    stepId: session.currentStepId, revision: session.revision, planVersion });
  if (prior) {
    plan.current.parentId = prior.current.id; plan.history = [...structuredClone(prior.history), structuredClone(prior.current)];
    plan.proposals = structuredClone(prior.proposals); plan.approvals = structuredClone(prior.approvals);
  }
  return { ...structuredClone(session), plan, reasoning: { ...structuredClone(session.reasoning || createReasoningState()), activePredictionId: null },
    ...(prior ? { beforeTurn: null, latestTurn: null } : {}) };
}

export function cameraReasoningVersion(session: CameraSession, revision = session.revision): ReasoningVersion {
  if (!session.plan || !session.reasoning || !session.currentStepId) reject(409, 'This run has no current application reasoning and plan state. Explicitly reset its facts.');
  return { runId: session.plan.current.version.runId, factsHash: session.plan.current.version.factsHash,
    sceneEpoch: session.sceneEpoch, stepId: session.currentStepId, revision, planVersion: session.plan.current.id };
}
export function cameraTurnEvidence(turn: CameraTurn): ReasoningEvidence {
  if (!turn.frameSha256 || !/^[a-f0-9]{64}$/i.test(turn.frameSha256) || !isCameraDecisionAssessment(turn.assessment))
    reject(400, 'Reasoning requires the exact current frame hash and decision contract.');
  return { turnId: turn.id, frameId: turn.frameId, sha256: turn.frameSha256, observationIds: turn.assessment.observations.map(observation => observation.id) };
}
function reasoningCall<T>(operation: () => T): T {
  try { return operation(); }
  catch (error) { if (error instanceof ReasoningError || error instanceof CameraPlanError) reject(409, error.message); throw error; }
}

/** Latest actual operator reports remain counterevidence across untested corrective hypotheses. */
export function getCurrentReportedFailures(session: CameraSession, workflow: WorkflowDefinition) {
  const reviews = (session.reviews || []).filter(review => review.sceneEpoch === session.sceneEpoch && review.stepId === session.currentStepId);
  const reports = (session.readingReports || []).filter(report => report.sceneEpoch === session.sceneEpoch && report.stepId === session.currentStepId);
  const step = workflow.steps.find(candidate => candidate.id === session.currentStepId);
  const values = [
    ...reviews.map(review => ({ revision: review.sessionRevision, id: `review:${review.turnId}:${review.sessionRevision}`,
      measurements: review.measurements, facts: review.facts })),
    ...reports.map(report => ({ revision: report.revision, id: report.id, measurements: report.measurements, facts: report.facts })),
  ].sort((a, b) => a.revision - b.revision);
  const latestReadings = new Map<string, { id: string; measurementId: string; value: number; withinBounds: boolean | null; revision: number }>();
  for (const reading of values) for (const [key, value] of Object.entries(reading.measurements || {})) {
    const definition = step?.measurements?.find(measurement => measurement.id === key);
    const boundKnown = definition && typeof session.facts[definition.factId] === 'number'
      && (definition.relation !== 'within_tolerance' || typeof session.facts[definition.toleranceFactId] === 'number');
    if (value !== null && definition) latestReadings.set(key, { id: `${reading.id}:${key}`, measurementId: key, value,
      withinBounds: boundKnown ? cameraMeasurementWithinBounds(definition, value, session.facts) : null, revision: reading.revision });
  }
  const generalReports = reviews.filter(review => review.outcome === 'failed')
    .filter(review => !session.reasoning?.claims.find(claim => claim.id === `claim:operator:${review.turnId}:${review.sessionRevision}`)?.resolvedBy)
    .map(review => `review:${review.turnId}:${review.sessionRevision}`);
  const readings = [...latestReadings.values()];
  const failedReadingIds = readings.filter(reading => reading.withinBounds === false).map(reading => reading.id);
  return { ids: [...generalReports, ...failedReadingIds], failedReadingIds, failedReportIds: generalReports,
    knownFailure: !!(generalReports.length + failedReadingIds.length),
    knownIncomplete: !!(step?.measurements || []).some(definition => !latestReadings.has(definition.id) || latestReadings.get(definition.id)!.withinBounds === null),
    generalReportIds: generalReports, latestReadings: readings };
}

export function cameraPlanCounterevidence(session: CameraSession): CameraPlanCounterevidence[] {
  const reasoning = session.reasoning;
  if (!reasoning) return [];
  return [
    ...reasoning.comparisons.filter(comparison => comparison.status !== 'supported_by_view'
      && !reasoning.claims.find(claim => claim.id === `claim:comparison:${comparison.evidence.turnId}`)?.resolvedBy).map(comparison => ({ id: comparison.id,
      version: comparison.version, frameId: comparison.evidence.frameId, sha256: comparison.evidence.sha256, status: comparison.status as 'contradicted' | 'unresolved' })),
    ...reasoning.claims.filter(claim => ['contradicted', 'unresolved', 'reported'].includes(claim.status) && !claim.resolvedBy).map(claim => {
      const failedReport = (session.reviews || []).some(review => claim.id === `claim:operator:${review.turnId}:${review.sessionRevision}` && review.outcome === 'failed')
        || (session.readingReports || []).some(report => claim.id === `claim:${report.id}` && report.derivedKnownFailure);
      return { id: claim.id, version: claim.version, frameId: claim.evidence.frameId, sha256: claim.evidence.sha256,
        status: claim.source === 'operator_report' && failedReport ? 'reported_failure' as const
          : claim.status === 'contradicted' ? 'contradicted' as const : 'unresolved' as const };
    }),
  ];
}

export function bindCameraEntity<T extends CameraSession>(session: T, input: { turnId: string; observationId: string; entityId: string;
  label: string; operatorConfirmed: true }, workflow: WorkflowDefinition, at: string): T {
  const turn = session.latestTurn;
  if (!turn || turn.id !== input.turnId || session.status !== 'active' || !isCameraDecisionAssessment(turn.assessment)
    || turn.assessment.frameQuality !== 'clear' || !turn.assessment.observations.find(observation => observation.id === input.observationId)?.box)
    reject(409, 'Bind an explicitly confirmed physical label to a located observation in the current clear frame.');
  const age = timestamp(at, 'Identity review') - timestamp(turn.receivedAt, 'Frame receipt');
  if (age < -1000 || age > CAMERA_FRAME_FRESHNESS_MS) reject(409, 'Capture a current view before confirming physical identity.');
  const version = cameraReasoningVersion(session, session.revision + 1), evidence = cameraTurnEvidence(turn);
  const reasoning = reasoningCall(() => bindEntityByOperator(session.reasoning!, { id: input.entityId, label: input.label.trim(),
    observationId: input.observationId, operatorConfirmed: input.operatorConfirmed, version, evidence }));
  const next: T = { ...structuredClone(session), revision: version.revision, latestTurn: null, updatedAt: at, reasoning,
    evidenceRequests: staleCameraEvidenceRequests(session.evidenceRequests, at, 'Operator-confirmed physical identity changed the reasoning context. A fresh assessment is required.') };
  next.guidance = deriveGuidance(next, workflow, at); return next;
}

export function acceptCameraPlanChange<T extends CameraSession>(session: T, input: { proposalId: string; clientOperationId: string; operatorConfirmed: true },
  workflow: WorkflowDefinition, at: string): T {
  const result = reasoningCall(() => approveCameraPlanChange(session.plan!, { ...input, version: cameraReasoningVersion(session), workflow,
    completedStepIds: session.completedSteps.map(completed => completed.stepId) }));
  if (result.replayed) return session;
  const next: T = { ...structuredClone(session), plan: result.state, revision: result.state.current.version.revision, status: 'active',
    currentStepId: result.currentStepId, completedSteps: session.completedSteps.filter(completed => result.retainedCompletedStepIds.includes(completed.stepId)),
    beforeTurn: null, latestTurn: null, updatedAt: at, reasoning: { ...structuredClone(session.reasoning!), activePredictionId: null },
    evidenceRequests: staleCameraEvidenceRequests(session.evidenceRequests, at, 'The operator accepted a new plan version. Fresh evidence is required for its next action.') };
  next.guidance = deriveGuidance(next, workflow, at); return next;
}

export const CAMERA_REQUEST_HISTORY_LIMIT = 20;
export function openCameraEvidenceRequest(session: CameraSession): CameraEvidenceRequest | null {
  return (session.evidenceRequests || []).filter(request => request.status === 'open').at(-1) || null;
}
export function staleCameraEvidenceRequests(requests: CameraEvidenceRequest[] | undefined, at: string, reason: string): CameraEvidenceRequest[] {
  return (requests || []).map(request => ['open', 'answered'].includes(request.status) ? {
    ...structuredClone(request), status: 'stale', closedAt: at, closeReason: reason,
    answers: request.answers.map(answer => answer.status === 'pending' ? { ...answer, status: 'superseded', completedAt: at } : structuredClone(answer)),
  } : structuredClone(request));
}

/** The application records a finished model request; it never holds a provider continuation. */
export function registerCameraEvidenceRequest<T extends CameraSession>(session: T, input: {
  turn: CameraTurn; sourceSceneEpoch: number; factsHash: string; checksVersion: CameraRequestChecksVersion;
}, at: string): T {
  const assessment = CameraAssessmentSchema.parse(input.turn.assessment);
  if (!['request_view', 'request_measurement'].includes(assessment.decisionKind)) return session;
  const requestId = `request:${input.turn.id}`;
  const records = session.evidenceRequests || [];
  if (records.length >= CAMERA_REQUEST_HISTORY_LIMIT || records.some(request => request.id === requestId))
    reject(409, 'This run cannot add another evidence request. Start a deliberate new run.');
  if (!input.turn.frameSha256 || !/^[a-f0-9]{64}$/i.test(input.turn.frameSha256))
    reject(400, 'An evidence request needs its exact saved source frame hash.');
  const payload = assessment.decisionKind === 'request_view' ? assessment.viewRequest! : assessment.measurementRequest!;
  const eligible = session.status === 'active' && session.sceneEpoch === input.sourceSceneEpoch && session.currentStepId === input.turn.stepId;
  const request: CameraEvidenceRequest = {
    id: requestId, kind: assessment.decisionKind as CameraEvidenceRequest['kind'], sourceTurnId: input.turn.id,
    sourceFrameId: input.turn.frameId, sourceFrameSha256: input.turn.frameSha256, sourceRevision: input.turn.revision,
    sourcePurpose: input.turn.purpose, stateRevision: session.revision, sceneEpoch: input.sourceSceneEpoch,
    planVersion: session.plan?.current.id,
    stepId: input.turn.stepId, factsHash: input.factsHash, checksVersion: structuredClone(input.checksVersion),
    instruction: payload.instruction, whyNeeded: payload.whyNeeded, resolves: payload.resolves,
    targetObservationIds: [...payload.targetObservationIds],
    measurement: assessment.measurementRequest ? { factKey: assessment.measurementRequest.factKey, unit: assessment.measurementRequest.unit } : null,
    status: eligible ? 'open' : 'stale', createdAt: at, closedAt: eligible ? null : at,
    closeReason: eligible ? null : 'The physical scene or phase changed while this request was produced.', answers: [],
  };
  const prior = records.map(record => record.status === 'open' ? { ...structuredClone(record), status: 'stale' as const,
    closedAt: at, closeReason: 'A newer saved decision superseded this evidence request.' } : structuredClone(record));
  return { ...structuredClone(session), evidenceRequests: [...prior, request] };
}

function currentEvidenceRequest(session: CameraSession, requestId: string): CameraEvidenceRequest {
  const request = (session.evidenceRequests || []).find(candidate => candidate.id === requestId);
  if (!request || request.status !== 'open' || request.sceneEpoch !== session.sceneEpoch || request.stepId !== session.currentStepId
    || request.stateRevision !== session.revision || session.status !== 'active')
    reject(409, 'This evidence request is no longer open in the current scene and revision. Refresh the saved run.');
  return request;
}

/** A numeric answer confirms a prerequisite, never an observed result or phase pass. */
export function answerCameraMeasurementRequest<T extends CameraSession>(session: T, input: {
  requestId: string; value: number; unit: string | null; operationId: string;
}, workflow: WorkflowDefinition, at: string): T {
  const request = currentEvidenceRequest(session, input.requestId);
  if (request.kind !== 'request_measurement' || !request.measurement) reject(400, 'This request needs a new view, not a numeric answer.');
  const definition = workflow.requiredFacts.find(fact => fact.id === request.measurement!.factKey);
  const step = currentStep(session, workflow);
  if (!definition || definition.kind !== 'number' || !step?.requiredFactIds.includes(definition.id)
    || input.unit !== definition.unit || input.unit !== request.measurement.unit)
    reject(400, 'Answer the requested numeric prerequisite in its exact declared unit.');
  const confirmed = session.facts[definition.id];
  if (confirmed !== undefined && confirmed !== input.value)
    reject(409, 'This answer would change a confirmed fact. Review the facts and explicitly reset the run first.');
  const facts = validateCameraFacts(workflow, { ...session.facts, [definition.id]: input.value });
  const answer: CameraEvidenceAnswer = { id: `answer:${input.operationId}`, operationId: input.operationId, requestId: request.id,
    kind: 'measurement', factKey: definition.id, value: input.value, unit: input.unit,
    status: 'accepted', createdAt: at, completedAt: at };
  const next: T = { ...structuredClone(session), facts, latestTurn: null, revision: session.revision + 1, updatedAt: at,
    evidenceRequests: (session.evidenceRequests || []).map(record => record.id === request.id ? { ...structuredClone(record),
      status: 'answered', closedAt: at, closeReason: 'The operator confirmed the requested prerequisite; a fresh assessment is required.',
      answers: [...structuredClone(record.answers), answer] } : structuredClone(record)) };
  next.guidance = deriveGuidance(next, workflow, at);
  return next;
}

/** Admit one operator-confirmed, previously unknown prerequisite without restarting completed phases. */
export function confirmCameraPrerequisite<T extends CameraSession>(session: T, input: {
  factKey: string; value: string | number | boolean; unit?: string | null; operatorConfirmed: true;
}, workflow: WorkflowDefinition, at: string): T {
  timestamp(at, 'Prerequisite confirmation');
  const step = currentStep(session, workflow);
  if (!step || session.status !== 'active') reject(409, 'This run has no active phase for a new prerequisite.');
  if (input.operatorConfirmed !== true) reject(400, 'A person must explicitly confirm this prerequisite.');
  if (unsupportedAssessment(session)) reject(409, 'Reconfirm the setup under the current decision contract first.');
  if (openCameraEvidenceRequest(session)) reject(409, 'Answer or cancel the current evidence request before confirming another prerequisite.');
  const definition = workflow.requiredFacts.find(fact => fact.id === input.factKey);
  if (!definition || !step.requiredFactIds.includes(definition.id)) reject(400, 'Confirm only a prerequisite needed by the current phase.');
  if (definition.kind === 'number' ? input.unit !== definition.unit : input.unit !== undefined && input.unit !== null)
    reject(400, 'Confirm the prerequisite in its exact declared unit.');
  const previous = session.facts[definition.id];
  if (previous !== undefined && previous !== '')
    reject(409, 'This prerequisite is already recorded. Changing a known value requires an explicit setup reset.');
  const facts = validateCameraFacts(workflow, { ...session.facts, [definition.id]: input.value });
  if (facts[definition.id] === '') reject(400, 'Enter the actual prerequisite description before confirming it.');
  const next: T = { ...structuredClone(session), facts, revision: session.revision + 1, updatedAt: at,
    beforeTurn: null, latestTurn: null,
    evidenceRequests: staleCameraEvidenceRequests(session.evidenceRequests, at, 'A new operator-confirmed prerequisite requires a fresh view under the updated facts.') };
  if (next.reasoning) next.reasoning.activePredictionId = null;
  next.guidance = deriveGuidance(next, workflow, at);
  return next;
}

export function cancelCameraEvidenceRequest<T extends CameraSession>(session: T, requestId: string, workflow: WorkflowDefinition, at: string): T {
  const request = currentEvidenceRequest(session, requestId);
  const next: T = { ...structuredClone(session), latestTurn: null, revision: session.revision + 1, updatedAt: at,
    evidenceRequests: (session.evidenceRequests || []).map(record => record.id === request.id ? { ...structuredClone(record),
      status: 'cancelled', closedAt: at, closeReason: 'The operator cancelled this request. A fresh assessment is required.',
      answers: record.answers.map(answer => answer.status === 'pending' ? { ...answer, status: 'superseded', completedAt: at } : structuredClone(answer)) } : structuredClone(record)) };
  next.guidance = deriveGuidance(next, workflow, at);
  return next;
}

function missingFacts(session: CameraSession, step: WorkflowStepDefinition, workflow: WorkflowDefinition): string[] {
  return step.requiredFactIds.flatMap(id => {
    const fact = workflow.requiredFacts.find(candidate => candidate.id === id)!;
    const value = session.facts[id];
    // Boolean facts are affirmative scope/capability confirmations. A negative
    // answer remains recorded, but cannot satisfy the corresponding prerequisite.
    return value === undefined || value === '' || (fact.kind === 'boolean' && value !== true)
      ? [`Confirm ${fact.label} before continuing.`] : [];
  });
}

function unsupportedAssessment(session: CameraSession): boolean {
  return [session.beforeTurn, session.latestTurn].some(turn => turn && !isCameraDecisionAssessment(turn.assessment));
}

function frameReasons(session: CameraSession, turn: CameraTurn, workflow: WorkflowDefinition, now: string): string[] {
  const reasons: string[] = [];
  if (!isCameraDecisionAssessment(turn.assessment))
    return ['This assessment uses an older or invalid decision contract. Reconfirm facts and reset the run before continuing.'];
  const assessment = turn.assessment;
  const nowMs = timestamp(now, 'Current time');
  const receivedMs = timestamp(turn.receivedAt, 'Frame receipt');
  if (receivedMs > nowMs + 1000 || nowMs - receivedMs > CAMERA_FRAME_FRESHNESS_MS)
    reasons.push('This assessment is no longer current. Capture another view before acting or confirming.');
  if (assessment.frameQuality !== 'clear') reasons.push('The relevant physical state is not clearly visible. Retake the view.');
  const baseline = turn.purpose === 'before' && session.beforeTurn?.id === turn.id && session.completedSteps.length === 0;
  if (assessment.continuity !== 'same_scene' && !(assessment.continuity === 'first_view' && baseline))
    reasons.push('The same physical setup has not been established in this view.');
  if (assessment.suggestedStepId !== session.currentStepId) reasons.push('The frame does not establish the current workflow step.');
  const observations = assessment.observations;
  if (!observations.length) reasons.push('No visible physical observation grounds this assessment.');
  reasons.push(...cameraDecisionReferenceIssues(assessment, workflow, turn.stepId));
  if (['propose_action', 'ready_for_operator_review'].includes(assessment.decisionKind)) {
    const targets = cameraDecisionTargets(assessment);
    if (!targets.length) reasons.push('An action or physical check needs a named visual target in this frame.');
    if (targets.some(id => observations.find(observation => observation.id === id)?.box === null))
      reasons.push('The action target has no known location in this frame. Retake the view.');
    const manipulates = assessment.decisionKind === 'ready_for_operator_review' || assessment.actionProposal?.kind === 'perform';
    if (manipulates && assessment.entityHypotheses.some(hypothesis => targets.includes(hypothesis.observationId) && hypothesis.candidateEntityIds.length > 1
      && !session.reasoning?.entityBindings.some(binding => binding.observationId === hypothesis.observationId
        && binding.evidence.turnId === turn.id && binding.evidence.frameId === turn.frameId && binding.evidence.sha256 === turn.frameSha256
        && binding.version.runId === session.plan?.current.version.runId && binding.version.sceneEpoch === session.sceneEpoch
        && binding.version.stepId === turn.stepId && hypothesis.candidateEntityIds.includes(binding.entityId))))
      reasons.push('The target matches more than one physical entity. Request a discriminating view or explicitly confirm its identity before acting or reviewing.');
  }
  if (['request_view', 'request_measurement'].includes(assessment.decisionKind))
    reasons.push('Resolve the requested evidence before continuing. No physical action is admitted.');
  if (assessment.decisionKind === 'hold') reasons.push('The decision is held. Resolve its stated resume condition before continuing.');
  if (assessment.decisionKind === 'propose_plan_change') reasons.push('The proposed plan change requires explicit operator acceptance and a fresh view.');
  if (assessment.decisionKind === 'ready_for_operator_review') {
    const active = session.reasoning?.activePredictionId;
    const compared = session.reasoning?.comparisons.find(comparison => comparison.id === `comparison:${turn.id}`);
    if (!active || !assessment.comparison || assessment.comparison.predictionId !== active
      || assessment.comparison.status !== 'supported_by_view' || compared?.status !== 'supported_by_view'
      || compared.predictionId !== active) reasons.push('Operator review needs a supported comparison against the exact active prediction.');
    if (getCurrentReportedFailures(session, workflow).knownFailure) reasons.push('Record an actual recheck of the known failed operator reading or condition before review.');
  }
  if (assessment.decisionKind === 'ready_for_operator_review' && turn.purpose === 'before')
    reasons.push('Operator review needs an after view of an admitted action; this before view cannot establish an action prediction.');
  return reasons;
}

function deriveGuidance(session: CameraSession, workflow: WorkflowDefinition, now: string): CameraGuidance {
  const step = currentStep(session, workflow);
  if (session.status === 'operator_reviewed_complete')
    return { actionable: false, canConfirm: false, reasons: ['All steps were reviewed by the operator. This is not an independent physical verification.'] };
  if (session.status === 'scene_changed')
    return { actionable: false, canConfirm: false, reasons: ['The physical setup changed. Reconfirm facts and reset the run before continuing.'] };
  if (unsupportedAssessment(session))
    return { actionable: false, canConfirm: false, reasons: ['This run contains an older or invalid decision contract. Reconfirm facts and reset the run before continuing.'] };
  if (!step) return { actionable: false, canConfirm: false, reasons: ['The current workflow step is unavailable.'] };
  if (openCameraEvidenceRequest(session)) return { actionable: false, canConfirm: false,
    reasons: ['Answer or cancel the saved evidence request before continuing. No physical action is admitted.'] };
  const reasons = missingFacts(session, step, workflow);
  const turn = session.latestTurn;
  if (!turn) return { actionable: false, canConfirm: false, reasons: [...reasons,
    session.beforeTurn?.stepId === step.id ? 'Capture a new after view to inspect this step’s result.' : 'Capture a before view of this step.'] };
  reasons.push(...frameReasons(session, turn, workflow, now));
  // The guard above holds historical/malformed persisted assessments. Keep the
  // narrowing local so reads never dereference an unsupported payload.
  if (!isCameraDecisionAssessment(turn.assessment)) return { actionable: false, canConfirm: false, reasons };
  if (turn.purpose === 'after') {
    const before = session.beforeTurn;
    if (!before || before.stepId !== turn.stepId || !isCameraDecisionAssessment(before.assessment)
      || before.assessment.decisionKind !== 'propose_action') reasons.push('Capture a usable before view with an admitted action before reviewing this step.');
    else {
      if (before.frameId === turn.frameId || (before.frameSha256 && turn.frameSha256 && before.frameSha256.toLowerCase() === turn.frameSha256.toLowerCase()))
        reasons.push('Use a new after view rather than the same captured image.');
      if (timestamp(turn.receivedAt, 'After frame') <= timestamp(before.receivedAt, 'Before frame'))
        reasons.push('The after view must be received after the before view.');
    }
    const canConfirm = !reasons.length && turn.assessment.decisionKind === 'ready_for_operator_review';
    return { actionable: !reasons.length && turn.assessment.decisionKind === 'propose_action', canConfirm, reasons };
  }
  return { actionable: !reasons.length && turn.assessment.decisionKind === 'propose_action', canConfirm: false, reasons };
}

export function createCameraSession(workflow: WorkflowDefinition, facts: unknown, now: string): CameraSession {
  timestamp(now, 'Session creation');
  const values = validateCameraFacts(workflow, facts);
  const session: CameraSession = { workflowId: workflow.id, revision: 1, sceneEpoch: 1, currentStepId: workflow.steps[0].id,
    status: 'active', facts: values, completedSteps: [], reviews: [], beforeTurn: null, latestTurn: null,
    guidance: { actionable: false, canConfirm: false, reasons: [] }, createdAt: now, updatedAt: now };
  session.guidance = deriveGuidance(session, workflow, now);
  return session;
}

/** Recompute receipt-age gates on reads without mutating persisted state/version. */
export function refreshCameraGuidance<T extends CameraSession>(session: T, workflow: WorkflowDefinition, now: string): T {
  return { ...structuredClone(session), guidance: deriveGuidance(session, workflow, now) };
}

export function applyCameraAssessment<T extends CameraSession>(session: T, input: CameraTurn, workflow: WorkflowDefinition, now: string): T {
  const step = currentStep(session, workflow);
  if (!step || session.status === 'operator_reviewed_complete') reject(409, 'This run has no active step to assess.');
  if (unsupportedAssessment(session)) reject(409, 'Reconfirm facts and reset the run before applying a new decision contract.');
  if (!Number.isSafeInteger(input.revision) || input.revision !== session.revision) reject(409, 'The session changed while this frame was being assessed. Capture a new view.');
  if (input.stepId !== step.id) reject(409, 'This frame belongs to an earlier workflow step.');
  if (!input.id || !input.frameId || !['before', 'after'].includes(input.purpose) || !['camera', 'upload'].includes(input.source))
    reject(400, 'The frame metadata is incomplete.');
  timestamp(input.receivedAt, 'Frame receipt');
  if (input.capturedAt !== null) timestamp(input.capturedAt, 'Claimed capture');
  if (input.source === 'upload' && input.capturedAt !== null) reject(400, 'An uploaded still has an unknown capture time.');
  if (input.frameSha256 && !/^[a-f0-9]{64}$/i.test(input.frameSha256)) reject(400, 'The frame hash is invalid.');
  const assessment = CameraAssessmentSchema.parse(input.assessment);
  const referenceIssues = cameraDecisionReferenceIssues(assessment, workflow, step.id);
  if (referenceIssues.length) reject(400, referenceIssues.join(' '));
  const turn = { ...structuredClone(input), assessment, ...cameraTurnDecisionIds(input.id, assessment) };
  const isBaseline = input.purpose === 'before' && !session.latestTurn && !session.completedSteps.length;
  if (turn.assessment.continuity === 'first_view' && !isBaseline) reject(409, 'A first view is only valid at the start of a new or reset run.');
  const next = { ...structuredClone(session), revision: session.revision + 1, latestTurn: turn, updatedAt: now };
  const active = session.reasoning?.predictions.find(prediction => prediction.id === session.reasoning?.activePredictionId) || null;
  if (!session.reasoning || !session.plan) reject(409, 'This run needs the current versioned reasoning and plan records. Reset its facts explicitly.');
  if (turn.assessment.continuity === 'changed') {
    next.status = 'scene_changed'; next.sceneEpoch++; next.completedSteps = []; next.beforeTurn = null;
    next.currentStepId = workflow.steps[0].id;
    next.evidenceRequests = staleCameraEvidenceRequests(next.evidenceRequests, now, 'The physical scene changed. These answers belong to its earlier scene.');
    next.reasoning = { ...structuredClone(session.reasoning), activePredictionId: null };
  } else if (session.status !== 'scene_changed' && turn.purpose === 'before') {
    // A rejected new before view cannot leave an older actionable anchor in place.
    next.beforeTurn = turn;
    if (assessment.decisionKind !== 'propose_action' || missingFacts(next, step, workflow).length
      || frameReasons(next, turn, workflow, now).length) next.beforeTurn = null;
  }
  if (turn.assessment.continuity !== 'changed') {
    const version = cameraReasoningVersion(next), evidence = cameraTurnEvidence(turn);
    let reasoning = structuredClone(session.reasoning);
    if (active) {
      if (!assessment.comparison || assessment.comparison.predictionId !== active.id) reject(409, 'Compare the exact active prediction before proposing another decision.');
      if (assessment.comparison.status === 'supported_by_view' && (evidence.sha256 === active.evidence.sha256 || evidence.frameId === active.evidence.frameId))
        reject(409, 'A supported comparison needs new evidence after its predicted action.');
      reasoning = reasoningCall(() => recordPredictionComparison(reasoning, assessment.comparison!, version, evidence,
        getCurrentReportedFailures(session, workflow).ids));
      if (assessment.recovery) reasoning = reasoningCall(() => recordRecovery(reasoning, assessment.recovery!, version, evidence, {
        answerIds: (session.evidenceRequests || []).filter(request => request.status === 'answered' && request.sceneEpoch === session.sceneEpoch && request.stepId === session.currentStepId)
          .flatMap(request => request.answers.filter(answer => answer.status === 'accepted').map(answer => answer.id)),
        readingIds: getCurrentReportedFailures(session, workflow).latestReadings.map(reading => reading.id),
      }));
    } else if (assessment.comparison || assessment.recovery) reject(409, 'No current admitted prediction exists for this comparison or recovery.');
    for (const hypothesis of assessment.entityHypotheses) reasoning = reasoningCall(() => recordEntityHypothesis(reasoning, {
      ...hypothesis, id: `hypothesis:${turn.id}:${hypothesis.observationId}`, version, evidence,
    }));
    for (const observation of assessment.observations) reasoning = reasoningCall(() => addReasoningClaim(reasoning, {
      id: `claim:observation:${turn.id}:${observation.id}`, entityIds: [], statement: `${observation.label}: ${observation.detail}`.slice(0, 1000),
      status: 'supported_by_view', source: 'model_hypothesis', version, evidence,
    }));
    if (assessment.comparison) reasoning = reasoningCall(() => addReasoningClaim(reasoning, {
      id: `claim:comparison:${turn.id}`, entityIds: [], statement: JSON.stringify({ predictionId: assessment.comparison!.predictionId,
        status: assessment.comparison!.status, failedConditions: assessment.comparison!.failedConditions, unknownConditions: assessment.comparison!.unknownConditions }).slice(0, 1000),
      status: assessment.comparison!.status, source: 'comparison', version, evidence,
    }));
    next.reasoning = reasoning;
    if (assessment.planChange) next.plan = reasoningCall(() => proposeCameraPlanChange(next.plan!, { ...assessment.planChange!, sourceTurnId: turn.id }, {
      version, evidence, workflow, ownedCounterevidence: cameraPlanCounterevidence(next),
    }));
    const admission = deriveGuidance(next, workflow, now);
    if (assessment.decisionKind === 'propose_action' && admission.actionable) {
      next.reasoning = reasoningCall(() => registerPrediction(next.reasoning!, { id: `prediction:${turn.id}`, turnId: turn.id,
        parentPredictionId: active?.id || null, version, evidence, instruction: assessment.actionProposal!.instruction,
        expectedVisibleResult: assessment.actionProposal!.expectedVisibleResult, stopCondition: assessment.actionProposal!.stopCondition,
        targetObservationIds: assessment.actionProposal!.targetObservationIds,
        targetObservations: assessment.observations.filter(observation => assessment.actionProposal!.targetObservationIds.includes(observation.id)),
      }));
      if (active && session.beforeTurn) next.beforeTurn = structuredClone(session.beforeTurn);
    }
  }
  next.guidance = deriveGuidance(next, workflow, now);
  return next;
}

type OperatorReview = { turnId: string; confirmations: Record<string, boolean>; measurements?: Record<string, number | null>; notes: string };

function reviewNotes(input: OperatorReview): string {
  if (typeof input.notes !== 'string' || !input.notes.trim() || input.notes.length > 3000)
    reject(400, 'Record what you actually checked, including measurements or assistance.');
  return input.notes.trim();
}

function reviewChecks(step: WorkflowStepDefinition, input: OperatorReview, requireAll: boolean) {
  const required = step.requiredConfirmations.map(check => check.id);
  if (!input.confirmations || typeof input.confirmations !== 'object' || Array.isArray(input.confirmations)
    || Object.entries(input.confirmations).some(([id, value]) => !required.includes(id) || typeof value !== 'boolean')
    || (requireAll && required.some(id => input.confirmations[id] !== true)))
    reject(400, 'Explicitly review the required operator checks for this exact step.');
  return { ...input.confirmations };
}

/** Shared by the server and phone UI; limits always come from confirmed facts. */
export function cameraMeasurementWithinBounds(measurement: WorkflowMeasurementDefinition, value: unknown, facts: CameraFacts): boolean {
  const bound = facts[measurement.factId];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || typeof bound !== 'number' || !Number.isFinite(bound)) return false;
  if (measurement.relation !== 'within_tolerance') return measurement.relation === 'gte' ? value >= bound : value <= bound;
  const tolerance = facts[measurement.toleranceFactId];
  if (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance <= 0 || tolerance >= bound) return false;
  // This slack only absorbs represented-number arithmetic at a decimal
  // boundary; it is far below the smallest supported physical tolerance.
  const arithmeticSlack = Number.EPSILON * Math.max(1, Math.abs(value), Math.abs(bound), tolerance) * 4;
  return Math.abs(value - bound) <= tolerance + arithmeticSlack;
}

function reviewMeasurements(step: WorkflowStepDefinition, input: OperatorReview, facts: CameraFacts) {
  const required = step.measurements || [];
  if (input.measurements !== undefined && (!input.measurements || typeof input.measurements !== 'object' || Array.isArray(input.measurements)
    || Object.keys(input.measurements).some(id => !required.some(measurement => measurement.id === id))))
    reject(400, 'Measurements must match the exact checks for this step.');
  const values: Record<string, number | null> = {};
  let missing = false, failed = false;
  for (const measurement of required) {
    const value = input.measurements?.[measurement.id] ?? null;
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0))
      reject(400, `Enter an actual nonnegative measurement for ${measurement.label}.`);
    values[measurement.id] = value;
    const bound = facts[measurement.factId];
    if (value === null || typeof bound !== 'number' || !Number.isFinite(bound)) { missing = true; continue; }
    if (measurement.relation === 'within_tolerance') {
      const tolerance = facts[measurement.toleranceFactId];
      if (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance <= 0 || tolerance >= bound) { missing = true; continue; }
    }
    if (!cameraMeasurementWithinBounds(measurement, value, facts)) failed = true;
  }
  return { values, missing, failed };
}

function stepReview(session: CameraSession, step: WorkflowStepDefinition, input: OperatorReview, outcome: CameraStepReview['outcome'], now: string): CameraStepReview {
  return { stepId: step.id, turnId: input.turnId,
    beforeTurnId: session.beforeTurn?.id || (session.latestTurn?.purpose === 'before' ? session.latestTurn.id : null),
    afterTurnId: session.latestTurn?.purpose === 'after' ? session.latestTurn.id : null,
    confirmations: reviewChecks(step, input, outcome === 'passed'), measurements: reviewMeasurements(step, input, session.facts).values,
    notes: reviewNotes(input), outcome, reviewedAt: now, facts: structuredClone(session.facts), sessionRevision: session.revision, sceneEpoch: session.sceneEpoch,
    checksVersion: CAMERA_ENGINE_VERSION, stepSnapshot: structuredClone(step) };
}

function recordOperatorClaim(state: ReasoningState, id: string, statement: string, version: ReasoningVersion, evidence: ReasoningEvidence) {
  return reasoningCall(() => addReasoningClaim(state, { id, entityIds: [], statement: statement.slice(0, 1000),
    status: 'reported', source: 'operator_report', version, evidence }));
}
function resolveOperatorCheckedClaims(state: ReasoningState, version: ReasoningVersion, evidence: ReasoningEvidence, resolutionId: string) {
  let next = state;
  for (const claim of state.claims.filter(claim => !claim.resolvedBy && ['operator_report', 'comparison'].includes(claim.source)
    && claim.version.runId === version.runId && claim.version.sceneEpoch === version.sceneEpoch && claim.version.stepId === version.stepId))
    next = reasoningCall(() => resolveReasoningClaim(next, { claimId: claim.id, resolutionId, version, evidence, operatorConfirmed: true }));
  return next;
}

/** An explicit human recheck supplies actual readings; it does not complete a phase or call a model. */
export function recordCameraReadingReport<T extends CameraSession>(session: T, input: OperatorReview & { operationId: string; operatorConfirmed: true }, workflow: WorkflowDefinition, at: string): T {
  const step = currentStep(session, workflow), turn = session.latestTurn;
  if (!step || !turn || turn.id !== input.turnId || session.status !== 'active' || input.operatorConfirmed !== true || unsupportedAssessment(session))
    reject(409, 'Choose the current assessed frame and explicitly confirm its actual recheck.');
  const age = timestamp(at, 'Recheck time') - timestamp(turn.receivedAt, 'Frame receipt');
  if (age < -1000 || age > CAMERA_FRAME_FRESHNESS_MS) reject(409, 'Capture a current view before reporting an actual recheck.');
  if ((session.readingReports || []).length >= 40) reject(409, 'The bounded actual-reading history is full. Start a deliberate new run; no earlier readings were discarded.');
  const readings = reviewMeasurements(step, input, session.facts), confirmations = reviewChecks(step, input, false), notes = reviewNotes(input);
  const version = cameraReasoningVersion(session, session.revision + 1), evidence = cameraTurnEvidence(turn);
  const report: CameraReadingReport = { id: `reading-report:${input.operationId}`, operationId: input.operationId,
    turnId: turn.id, frameId: turn.frameId, frameSha256: turn.frameSha256!, stepId: step.id, sceneEpoch: session.sceneEpoch,
    revision: version.revision, factsHash: version.factsHash, planVersion: version.planVersion, measurements: readings.values,
    confirmations, notes, derivedKnownFailure: readings.failed, createdAt: at, criterionSnapshot: structuredClone(step), facts: structuredClone(session.facts) };
  let reasoning = structuredClone(session.reasoning!);
  const complete = !readings.missing && !readings.failed && step.requiredConfirmations.every(check => confirmations[check.id] === true);
  if (complete) reasoning = resolveOperatorCheckedClaims(reasoning, version, evidence, report.id);
  else reasoning = recordOperatorClaim(reasoning, `claim:${report.id}`, `Operator actual recheck ${report.id}: ${JSON.stringify({
    knownFailure: report.derivedKnownFailure, measurements: report.measurements, confirmations: report.confirmations,
    notesExcerpt: report.notes.slice(0, 200), rawReportId: report.id })}`, version, evidence);
  const next: T = { ...structuredClone(session), revision: version.revision, latestTurn: null, updatedAt: at, reasoning,
    readingReports: [...structuredClone(session.readingReports || []), report],
    evidenceRequests: staleCameraEvidenceRequests(session.evidenceRequests, at, 'An explicit actual-reading report changed the evidence; a fresh assessment is required.') };
  next.guidance = deriveGuidance(next, workflow, at); return next;
}

export function confirmCameraStep<T extends CameraSession>(session: T, input: OperatorReview, workflow: WorkflowDefinition, now: string): T {
  const step = currentStep(session, workflow);
  const guidance = deriveGuidance(session, workflow, now);
  if (!step || !guidance.canConfirm || !session.latestTurn || !session.beforeTurn || session.latestTurn.id !== input.turnId)
    reject(409, 'Review a current, clear after view of this step before confirming it.');
  const measurements = reviewMeasurements(step, input, session.facts);
  if (measurements.missing || measurements.failed) reject(400, 'Record each required actual measurement within this revision’s confirmed limits, or save a failed/incomplete review.');
  const review = stepReview(session, step, input, 'passed', now);
  const completedSteps = [...structuredClone(session.completedSteps), { stepId: step.id, beforeTurnId: session.beforeTurn.id,
    afterTurnId: session.latestTurn.id, confirmations: review.confirmations, measurements: review.measurements, notes: review.notes, confirmedAt: now }];
  const index = workflow.steps.findIndex(candidate => candidate.id === step.id);
  const next: T = { ...structuredClone(session), completedSteps, reviews: [...structuredClone(session.reviews || []), review], revision: session.revision + 1,
    currentStepId: workflow.steps[index + 1]?.id || null,
    status: index + 1 === workflow.steps.length ? 'operator_reviewed_complete' : 'active', beforeTurn: null, latestTurn: null, updatedAt: now };
  if (session.reasoning) {
    const version = cameraReasoningVersion(session, next.revision), evidence = cameraTurnEvidence(session.latestTurn);
    next.reasoning = { ...resolveOperatorCheckedClaims(structuredClone(session.reasoning), version, evidence, `review:${review.turnId}:${review.sessionRevision}`), activePredictionId: null };
  }
  next.guidance = deriveGuidance(next, workflow, now);
  return next;
}

/** A failed/incomplete operator report remains evidence, never a step advance. */
export function recordCameraStepReview<T extends CameraSession>(session: T, input: OperatorReview & { outcome: 'failed' | 'incomplete' }, workflow: WorkflowDefinition, now: string): T {
  if (unsupportedAssessment(session)) reject(409, 'Reconfirm facts and reset the run before adding a review under the new decision contract.');
  const current = currentStep(session, workflow);
  const turn = session.latestTurn;
  if (session.status !== 'active' || !current || !turn || turn.id !== input.turnId || turn.stepId !== current.id)
    reject(409, 'Choose the current assessed frame of an active step for this operator review. Reconfirm a changed setup first.');
  const age = timestamp(now, 'Review time') - timestamp(turn.receivedAt, 'Frame receipt');
  if (age > CAMERA_FRAME_FRESHNESS_MS || age < -1000) reject(409, 'Capture another current view before attaching this review.');
  if (!['failed', 'incomplete'].includes(input.outcome)) reject(400, 'Use an explicit failed or incomplete review outcome.');
  const step = workflow.steps.find(candidate => candidate.id === turn.stepId);
  if (!step) reject(409, 'The assessed step is unavailable.');
  const measurementResult = reviewMeasurements(step, input, session.facts);
  const outcome = measurementResult.failed ? 'failed' : input.outcome;
  const review = stepReview(session, step, input, outcome, now);
  const next: T = { ...structuredClone(session), reviews: [...structuredClone(session.reviews || []), review], revision: session.revision + 1,
    beforeTurn: null, latestTurn: null, updatedAt: now,
    evidenceRequests: staleCameraEvidenceRequests(session.evidenceRequests, now, 'A new operator review changed the evidence for this phase. Capture a fresh assessment.') };
  if (session.reasoning) next.reasoning = recordOperatorClaim(structuredClone(session.reasoning), `claim:operator:${review.turnId}:${review.sessionRevision}`,
    `Operator ${review.outcome} review ${review.turnId}:${review.sessionRevision}: ${JSON.stringify({ measurements: review.measurements,
      confirmations: review.confirmations, notesExcerpt: review.notes.slice(0, 200), rawReviewId: `review:${review.turnId}:${review.sessionRevision}` })}`,
    cameraReasoningVersion(session, next.revision), cameraTurnEvidence(turn));
  next.guidance = deriveGuidance(next, workflow, now);
  return next;
}

/** An explicit facts/reset operation starts fresh checks; audit turns remain external. */
export function reviseCameraSession<T extends CameraSession>(session: T, facts: unknown, workflow: WorkflowDefinition, now: string): T {
  currentStep(session, workflow);
  return { ...structuredClone(session), ...createCameraSession(workflow, facts, now), revision: session.revision + 1,
    sceneEpoch: session.sceneEpoch + 1, createdAt: session.createdAt, reviews: structuredClone(session.reviews || []),
    evidenceRequests: staleCameraEvidenceRequests(session.evidenceRequests, now, 'An explicit facts or workflow reset invalidated this request and its answers for the current scene.'),
    ...(session.reasoning ? { reasoning: { ...structuredClone(session.reasoning), activePredictionId: null } } : {}) };
}

export function undoLastCameraStep<T extends CameraSession>(session: T, workflow: WorkflowDefinition, now: string): T {
  currentStep(session, workflow);
  if (unsupportedAssessment(session)) reject(409, 'Reconfirm facts and reset the run before reopening a step under the new decision contract.');
  if (session.status === 'scene_changed') reject(409, 'Reconfirm the physical setup before starting again.');
  const completedSteps = structuredClone(session.completedSteps);
  const previous = completedSteps.pop();
  if (!previous) reject(409, 'There is no reviewed step to reopen.');
  const next: T = { ...structuredClone(session), completedSteps, currentStepId: previous.stepId, status: 'active', revision: session.revision + 1,
    beforeTurn: null, latestTurn: null, updatedAt: now,
    evidenceRequests: staleCameraEvidenceRequests(session.evidenceRequests, now, 'The operator reopened an earlier phase. Its dependent evidence requests must be reassessed.') };
  if (next.reasoning) next.reasoning.activePredictionId = null;
  next.guidance = deriveGuidance(next, workflow, now);
  return next;
}
