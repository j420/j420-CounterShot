import { createHash } from 'node:crypto';
import { MetaError } from '../meta/client';
import { reasoningContext, ReasoningError, type ReasoningVersion } from './reasoning';
import type { publicEvidenceCatalog } from './evidence';
import type { remainingExecutionBudget } from '../meta/budget';
import { getCurrentReportedFailures, cameraPlanCounterevidence } from './engine';
import {
  CAMERA_ENGINE_VERSION, CAMERA_SCHEMA_VERSION, isCameraDecisionAssessment,
  type CameraSession, type StoredCameraAssessment, type WorkflowDefinition,
} from './schema';

export const CAMERA_CONTEXT_VERSION = 'camera-context-v3';
export type CameraFrameContext = {
  id: string; sha256: string; purpose: 'before' | 'after'; source: 'camera' | 'upload';
  capturedAt: string | null; receivedAt: string; stepId: string; revision: number;
};
export type CameraComparisonContext = { frame: CameraFrameContext; turnId: string; assessment: StoredCameraAssessment };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).filter(([, item]) => item !== undefined)
    .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
export function cameraContextHash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
const captureTimeStatus = (source: 'camera' | 'upload') => source === 'upload'
  ? 'unknown_actual_capture_time' : 'browser_reported_not_hardware_attested';

/** One application-built snapshot; prior model interpretations never become facts. */
export function buildCameraContext(input: {
  runId: string; turnId: string; workflow: WorkflowDefinition; session: CameraSession;
  frame: CameraFrameContext; comparison?: CameraComparisonContext | null;
  operatorNote: string; promptVersion: string;
  evidenceCatalog?: ReturnType<typeof publicEvidenceCatalog>;
  remainingBudget?: ReturnType<typeof remainingExecutionBudget>;
}) {
  const { runId, turnId, workflow, session, frame, comparison, operatorNote, promptVersion, evidenceCatalog, remainingBudget } = structuredClone(input);
  if (![runId, turnId].every(value => typeof value === 'string' && !!value.trim() && value.length <= 200))
    throw new MetaError('Camera reasoning needs its recorded run and turn identities.', 'invalid_camera_context');
  const step = workflow.steps.find(candidate => candidate.id === session.currentStepId);
  if (!step || session.workflowId !== workflow.id || frame.stepId !== step.id || frame.revision !== session.revision)
    throw new MetaError('The camera step or revision changed before inspection. Refresh the session.', 'stale_camera_frame');
  const version: ReasoningVersion = { runId, revision: session.revision, sceneEpoch: session.sceneEpoch, stepId: step.id,
    factsHash: cameraContextHash(session.facts), planVersion: session.plan?.current.id || `plan:${runId}:scene:${session.sceneEpoch}` };
  let memory = null;
  try { if (session.reasoning) memory = reasoningContext(session.reasoning, version); }
  catch (error) { if (error instanceof ReasoningError) throw new MetaError(error.message, error.code); throw error; }
  const before = frame.purpose === 'after' ? session.beforeTurn : null;
  let originalPrediction = null;
  if (before) {
    if (before.purpose !== 'before' || before.stepId !== step.id || before.revision > session.revision
      || !/^[a-f0-9]{64}$/i.test(before.frameSha256 || '') || !isCameraDecisionAssessment(before.assessment)
      || before.assessment.decisionKind !== 'propose_action' || !before.assessment.actionProposal)
      throw new MetaError('The original before-view prediction is unavailable or no longer belongs to this step. Capture a deliberate new before view.', 'invalid_camera_context');
    const beforeAssessment = before.assessment, actionProposal = beforeAssessment.actionProposal!;
    originalPrediction = {
      predictionId: `prediction:${before.id}`, actionTurnId: before.id, frameId: before.frameId,
      frameSha256: before.frameSha256, stepId: before.stepId, revision: before.revision, sceneEpoch: session.sceneEpoch,
      capturedAt: before.capturedAt, receivedAt: before.receivedAt, source: before.source,
      captureTimeStatus: captureTimeStatus(before.source),
      referenceImageAttached: comparison?.frame.id === before.frameId,
      ...actionProposal,
      targetObservations: beforeAssessment.observations.filter(observation => actionProposal.targetObservationIds.includes(observation.id)),
      targetReference: 'original_before_frame_observations',
      provenance: 'original_model_proposal_not_physically_verified',
    };
  }
  const beforeAnchorPrediction = originalPrediction;
  const rootPrediction = memory?.rootPrediction;
  const originalRootPrediction = rootPrediction ? { ...structuredClone(rootPrediction), predictionId: rootPrediction.id,
    actionTurnId: rootPrediction.turnId, frameId: rootPrediction.evidence.frameId, frameSha256: rootPrediction.evidence.sha256,
    targetReference: 'original_root_prediction_frame_observations', provenance: 'original_root_model_proposal_not_physically_verified' } : originalPrediction;
  const operatorReviews = (session.reviews || []).filter(review => review.sceneEpoch === session.sceneEpoch && review.stepId === step.id)
    .slice(-3).map(review => ({
      stepId: review.stepId, turnId: review.turnId, outcome: review.outcome, reviewedAt: review.reviewedAt,
      sessionRevision: review.sessionRevision, sceneEpoch: review.sceneEpoch, confirmations: review.confirmations,
      measurements: review.measurements, notes: review.notes, facts: review.facts,
      provenance: 'operator_reported_history_not_camera_measured',
    }));
  const negativeReviews = (session.reviews || []).filter(review => review.sceneEpoch === session.sceneEpoch && review.stepId === step.id && review.outcome !== 'passed');
  if (negativeReviews.length > 40) throw new MetaError('Unresolved reported counterevidence exceeds this turn\'s bounded context. Review the retained reports before requesting more guidance; none was silently omitted.', 'reasoning_limit');
  const currentReportedFailures = getCurrentReportedFailures(session, workflow);
  const operatorCounterevidence = negativeReviews.map(review => ({ ...structuredClone(review),
    id: `review:${review.turnId}:${review.sessionRevision}`,
    appliesToActivePrediction: currentReportedFailures.ids.some(id => id === `review:${review.turnId}:${review.sessionRevision}`
      || id.startsWith(`review:${review.turnId}:${review.sessionRevision}:`)),
    provenance: 'operator_reported_counterevidence_not_camera_measured',
  }));
  const context = {
    contextVersion: CAMERA_CONTEXT_VERSION,
    identity: { runId, turnId, decisionId: `decision:${turnId}`, revision: session.revision,
      sceneEpoch: session.sceneEpoch, currentStepId: step.id, planVersion: version.planVersion, factsHash: version.factsHash,
      versions: { schemaVersion: CAMERA_SCHEMA_VERSION, engineVersion: CAMERA_ENGINE_VERSION,
        promptVersion, workflowHash: cameraContextHash(workflow) } },
    workflow: { id: workflow.id, iteration: workflow.iteration, title: workflow.title,
      physicalScope: workflow.physicalScope, limitations: workflow.limitations },
    ...(session.setupContext ? { taskIntent: { ...structuredClone(session.setupContext),
      provenance: 'operator_entered_goal_and_context_not_camera_measured', sceneIntakeIsNotActionEvidence: true } } : {}),
    currentStep: step,
    currentFactDefinitions: workflow.requiredFacts.filter(fact => step.requiredFactIds.includes(fact.id)),
    allowedMeasurementRequests: workflow.requiredFacts.filter(fact => step.requiredFactIds.includes(fact.id) && fact.kind === 'number'),
    confirmedFacts: session.facts, confirmedFactsProvenance: 'operator_confirmed_not_camera_measured',
    completedStepIds: session.completedSteps.map(completed => completed.stepId),
    frame: { ...frame, captureTimeStatus: captureTimeStatus(frame.source) },
    previousTurn: comparison ? { id: comparison.turnId, frameId: comparison.frame.id, frameSha256: comparison.frame.sha256,
      stepId: comparison.frame.stepId, purpose: comparison.frame.purpose, revision: comparison.frame.revision,
      source: comparison.frame.source, capturedAt: comparison.frame.capturedAt, receivedAt: comparison.frame.receivedAt,
      captureTimeStatus: captureTimeStatus(comparison.frame.source), assessment: comparison.assessment,
      provenance: 'historical_model_assessment_not_confirmed_fact' } : null,
    comparisonImageAttached: !!comparison, originalPrediction: originalRootPrediction, beforeAnchorPrediction,
    operatorReportedNote: operatorNote, operatorReviews, operatorCounterevidence,
    currentReportedFailures,
    operatorReadingReports: (session.readingReports || []).filter(report => report.sceneEpoch === session.sceneEpoch && report.stepId === step.id)
      .map(report => ({ ...structuredClone(report), provenance: 'operator_actual_reading_not_camera_measurement' })),
    reasoning: memory,
    activePrediction: memory?.activePrediction || originalPrediction,
    plan: session.plan ? { current: session.plan.current,
      pendingProposals: session.plan.proposals.filter(proposal => proposal.status === 'proposed'),
      allowedCounterevidence: cameraPlanCounterevidence(session).filter(item => item.version.runId === runId
        && item.version.sceneEpoch === version.sceneEpoch && item.version.factsHash === version.factsHash && item.version.planVersion === version.planVersion) } : null,
    evidenceCatalog: evidenceCatalog || [],
    evidenceRequests: (session.evidenceRequests || []).map(request => ({
      id: request.id, kind: request.kind, sourceTurnId: request.sourceTurnId, sourceFrameId: request.sourceFrameId,
      sourceFrameSha256: request.sourceFrameSha256, sceneEpoch: request.sceneEpoch, stepId: request.stepId,
      sourcePurpose: request.sourcePurpose, factsHash: request.factsHash, status: request.status,
      instruction: request.instruction, whyNeeded: request.whyNeeded, resolves: request.resolves,
      measurement: request.measurement, closeReason: request.closeReason, answers: request.answers,
      provenance: 'application_request_and_operator_answer_history_not_camera_measurement',
    })),
    availableDecisions: ['request_view', 'request_measurement', 'propose_action', 'ready_for_operator_review', 'hold', 'propose_plan_change'],
    execution: { maximumResponseCalls: Math.min(evidenceCatalog?.length ? 2 : 1, remainingBudget?.invocations ?? 2), automaticRetries: 0,
      tools: evidenceCatalog?.length ? ['read_owned_evidence'] : [], remainingBudget: remainingBudget || null },
    physicalOutcome: 'unverified; only an operator can confirm the actual step',
  };
  return { ...context, contextHash: cameraContextHash(context) };
}
