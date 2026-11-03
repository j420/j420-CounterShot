import { z } from 'zod';
import { PredictionComparisonSchema, RecoveryProposalSchema, EntityHypothesisSchema, CameraPlanChangeSchema } from './decision-contract';
import type { ReasoningState } from './reasoning';
import type { CameraPlanState } from './plan';
import type { ExecutionBudget } from '../meta/budget';

export const CAMERA_SCHEMA_VERSION = '3.0.0';
export const CAMERA_ENGINE_VERSION = '3.0.0';
export const CAMERA_FRAME_FRESHNESS_MS = 120_000;
export const CameraWorkflowIdSchema = z.enum(['harness_routing', 'fragment_dry_fit', 'webbing_lacing', 'gasket_seating', 'gravity_fluidics']);
export type CameraWorkflowId = z.infer<typeof CameraWorkflowIdSchema>;
export type CameraFactValue = string | number | boolean;
export type CameraFacts = Record<string, CameraFactValue>;
export type WorkflowFactDefinition = { id: string; label: string; kind: 'text' | 'number' | 'boolean'; unit: string | null; min: number | null; max: number | null };
export type WorkflowMeasurementDefinition = { id: string; label: string; unit: string; factId: string } & (
  { relation: 'gte' | 'lte' } | { relation: 'within_tolerance'; toleranceFactId: string }
);
export type WorkflowStepDefinition = { id: string; title: string; instruction: string; visibleChecks: string[]; requiredFactIds: string[]; requiredConfirmations: { id: string; label: string }[]; recoveryHint: string; measurements?: WorkflowMeasurementDefinition[] };
export type WorkflowDefinition = {
  id: CameraWorkflowId; iteration: number; title: string; summary: string; physicalScope: string;
  requiredFacts: WorkflowFactDefinition[]; steps: WorkflowStepDefinition[]; completionChecks: string[]; limitations: string[];
};

const shortText = z.string().trim().min(1).max(1000);
const identifier = z.string().min(1).max(100);
export const CameraBoxSchema = z.object({
  x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1),
  width: z.number().finite().positive().max(1), height: z.number().finite().positive().max(1),
}).strict();
// Kept solely for displaying historical records. Never use this as a fallback
// parser for a new model response or convert it into an actionable v2 decision.
export const LegacyCameraAssessmentSchema = z.object({
  summary: shortText,
  frameQuality: z.enum(['clear', 'blurred', 'occluded', 'insufficient']),
  continuity: z.enum(['first_view', 'same_scene', 'changed', 'uncertain']),
  observations: z.array(z.object({ id: identifier, label: shortText, detail: shortText, box: CameraBoxSchema.nullable() }).strict()).max(12),
  stepStatus: z.enum(['action_needed', 'ready_for_review', 'needs_information', 'blocked']),
  nextAction: z.object({ kind: z.enum(['perform', 'inspect', 'measure', 'retake', 'pause']), instruction: shortText,
    expectedVisibleResult: shortText, stopCondition: shortText, targetObservationIds: z.array(identifier).max(12) }).strict(),
  questions: z.array(shortText).max(8),
  suggestedStepId: identifier.nullable(),
}).strict();
export type LegacyCameraAssessment = z.infer<typeof LegacyCameraAssessmentSchema>;

const targets = z.array(identifier).max(5);
const proposal = z.object({
  kind: z.enum(['perform', 'inspect']), instruction: shortText,
  preconditions: z.array(shortText).max(5), expectedVisibleResult: shortText,
  stopCondition: shortText, targetObservationIds: targets.min(1),
}).strict();
const decisionKindsV2 = ['request_view', 'request_measurement', 'propose_action', 'ready_for_operator_review', 'hold'] as const;
const decisionKinds = [...decisionKindsV2, 'propose_plan_change'] as const;
export type CameraDecisionKind = typeof decisionKinds[number];

// The provider receives this plain closed schema. Exactly-one-payload validation
// runs locally, keeping unsupported unions/refinements out of the wire format.
export const CameraAssessmentV2WireSchema = z.object({
  contractVersion: z.enum(['camera-decision-v2']),
  summary: shortText,
  frameQuality: z.enum(['clear', 'blurred', 'occluded', 'insufficient']),
  continuity: z.enum(['first_view', 'same_scene', 'changed', 'uncertain']),
  observations: z.array(z.object({ id: identifier, label: shortText, detail: shortText, box: CameraBoxSchema.nullable() }).strict()).max(5),
  suggestedStepId: identifier.nullable(),
  decisionKind: z.enum(decisionKindsV2),
  viewRequest: z.object({ instruction: shortText, whyNeeded: shortText, resolves: shortText, targetObservationIds: targets }).strict().nullable(),
  measurementRequest: z.object({ factKey: identifier, unit: shortText.nullable(), instruction: shortText,
    whyNeeded: shortText, resolves: shortText, targetObservationIds: targets }).strict().nullable(),
  actionProposal: proposal.nullable(),
  operatorReview: z.object({ instruction: shortText, expectedVisibleResult: shortText,
    stopCondition: shortText, targetObservationIds: targets.min(1) }).strict().nullable(),
  hold: z.object({ reason: shortText, resumeWhen: shortText }).strict().nullable(),
}).strict();

export const CameraAssessmentWireSchema = CameraAssessmentV2WireSchema.extend({
  contractVersion: z.enum(['camera-decision-v3']),
  decisionKind: z.enum(decisionKinds),
  comparison: PredictionComparisonSchema.nullable(),
  recovery: RecoveryProposalSchema.nullable(),
  entityHypotheses: z.array(EntityHypothesisSchema).max(5),
  planChange: CameraPlanChangeSchema.nullable(),
}).strict();

const payloadFor = {
  request_view: 'viewRequest', request_measurement: 'measurementRequest',
  propose_action: 'actionProposal', ready_for_operator_review: 'operatorReview', hold: 'hold', propose_plan_change: 'planChange',
} as const;
export const CameraAssessmentV2Schema = CameraAssessmentV2WireSchema.superRefine((value, context) => {
  for (const kind of decisionKindsV2) {
    const field = payloadFor[kind], required = kind === value.decisionKind;
    if (required === (value[field] === null)) context.addIssue({ code: 'custom', path: [field], message: 'An historical v2 decision requires exactly its matching payload.' });
  }
});
export type CameraAssessmentV2 = z.infer<typeof CameraAssessmentV2WireSchema>;
export const CameraAssessmentSchema = CameraAssessmentWireSchema.superRefine((value, context) => {
  for (const field of Object.values(payloadFor)) {
    const required = field === payloadFor[value.decisionKind];
    if (required === (value[field] === null)) context.addIssue({ code: 'custom', path: [field],
      message: required ? 'This decision needs its matching payload.' : 'Only the matching decision payload may be present.' });
  }
  if (value.comparison) {
    const comparison = value.comparison;
    if (comparison.status === 'supported_by_view' && (comparison.failedConditions.length || comparison.unknownConditions.length))
      context.addIssue({ code: 'custom', path: ['comparison'], message: 'Supported comparisons cannot conceal failed or unknown conditions.' });
    if (comparison.status === 'contradicted' && !comparison.failedConditions.length)
      context.addIssue({ code: 'custom', path: ['comparison'], message: 'A contradiction must name the failed prediction condition.' });
    if (comparison.status === 'unresolved' && (!comparison.unknownConditions.length || comparison.failedConditions.length))
      context.addIssue({ code: 'custom', path: ['comparison'], message: 'Unresolved comparisons name unknown conditions rather than conceal known failures.' });
  }
  if (value.recovery && (value.decisionKind !== 'propose_action' || !value.actionProposal
    || !value.comparison || value.comparison.status === 'supported_by_view'
    || value.recovery.predictionId !== value.comparison.predictionId || value.recovery.correction !== value.actionProposal.instruction))
    context.addIssue({ code: 'custom', path: ['recovery'], message: 'Recovery must correct the exact failed/unresolved prediction with the single published action.' });
});
export type CameraAssessment = z.infer<typeof CameraAssessmentWireSchema>;
export type StoredCameraAssessment = CameraAssessment | CameraAssessmentV2 | LegacyCameraAssessment;
export function isCameraDecisionAssessment(value: unknown): value is CameraAssessment {
  return CameraAssessmentSchema.safeParse(value).success;
}
export function cameraDecisionTargets(assessment: CameraAssessment): string[] {
  const payload = assessment[payloadFor[assessment.decisionKind]];
  return payload && 'targetObservationIds' in payload ? payload.targetObservationIds : [];
}
/** App-assigned identities. A model cannot choose or overwrite these fields. */
export function cameraTurnDecisionIds(turnId: string, assessment: CameraAssessment) {
  return { decisionId: `decision:${turnId}`,
    requestId: ['request_view', 'request_measurement'].includes(assessment.decisionKind) ? `request:${turnId}` : null,
    predictionId: assessment.decisionKind === 'propose_action' ? `prediction:${turnId}` : null };
}
/** Structural references are checked identically at the adapter and commit gate. */
export function cameraDecisionReferenceIssues(assessment: CameraAssessment, workflow: WorkflowDefinition, stepId: string): string[] {
  const issues: string[] = [];
  const ids = new Set(assessment.observations.map(observation => observation.id));
  const selected = cameraDecisionTargets(assessment);
  if (ids.size !== assessment.observations.length) issues.push('Observation identities must be unique in this frame.');
  if (new Set(selected).size !== selected.length || selected.some(id => !ids.has(id)))
    issues.push('Decision targets must reference distinct observations in the current frame.');
  if (assessment.comparison && (new Set(assessment.comparison.evidenceObservationIds).size !== assessment.comparison.evidenceObservationIds.length
    || assessment.comparison.evidenceObservationIds.some(id => !ids.has(id)))) issues.push('Comparison references must name current observed evidence.');
  if (new Set(assessment.entityHypotheses.map(item => item.observationId)).size !== assessment.entityHypotheses.length
    || assessment.entityHypotheses.some(item => !ids.has(item.observationId) || new Set(item.candidateEntityIds).size !== item.candidateEntityIds.length))
    issues.push('Identity hypotheses must name distinct current observations and candidate entity identities.');
  if (assessment.observations.some(observation => observation.box
    && (observation.box.x + observation.box.width > 1 + 1e-9 || observation.box.y + observation.box.height > 1 + 1e-9)))
    issues.push('Observation regions must remain inside the current frame.');
  if (assessment.suggestedStepId !== null && assessment.suggestedStepId !== stepId)
    issues.push('The decision cannot substitute a different workflow step.');
  const request = assessment.measurementRequest;
  if (request) {
    const fact = workflow.requiredFacts.find(candidate => candidate.id === request.factKey);
    const step = workflow.steps.find(candidate => candidate.id === stepId);
    if (!fact || fact.kind !== 'number' || !step?.requiredFactIds.includes(fact.id) || request.unit !== fact.unit)
      issues.push('A measurement request must name a numeric fact and its unit required by this step.');
  }
  return issues;
}
export type CameraTurn = {
  id: string; frameId: string; purpose: 'before' | 'after'; capturedAt: string | null;
  receivedAt: string; source: 'camera' | 'upload'; revision: number; stepId: string;
  assessment: StoredCameraAssessment; frameSha256?: string;
  decisionId?: string; requestId?: string | null; predictionId?: string | null;
};
export type CameraStepConfirmation = {
  stepId: string; beforeTurnId: string; afterTurnId: string; confirmations: Record<string, boolean>; notes: string; confirmedAt: string;
  measurements?: Record<string, number | null>;
};
export type CameraStepReview = {
  stepId: string; turnId: string; beforeTurnId: string | null; afterTurnId: string | null;
  confirmations: Record<string, boolean>; measurements: Record<string, number | null>; notes: string;
  outcome: 'passed' | 'failed' | 'incomplete'; reviewedAt: string; facts: CameraFacts; sessionRevision: number; sceneEpoch: number;
  checksVersion?: string; stepSnapshot?: WorkflowStepDefinition;
};
export type CameraRequestChecksVersion = { schemaVersion: string; engineVersion: string; workflowHash: string };
export type CameraReadingReport = {
  id: string; operationId: string; turnId: string; frameId: string; frameSha256: string;
  stepId: string; sceneEpoch: number; revision: number; factsHash: string; planVersion: string;
  measurements: Record<string, number | null>; confirmations: Record<string, boolean>; notes: string;
  derivedKnownFailure: boolean; createdAt: string; criterionSnapshot: WorkflowStepDefinition; facts: CameraFacts;
};
export type CameraEvidenceAnswer = {
  id: string; operationId: string; requestId: string; createdAt: string;
  status: 'pending' | 'accepted' | 'failed' | 'superseded'; completedAt: string | null;
} & ({ kind: 'view'; frameId: string; frameSha256: string; turnId: string }
  | { kind: 'measurement'; factKey: string; value: number; unit: string | null });
export type CameraEvidenceRequest = {
  id: string; kind: 'request_view' | 'request_measurement'; sourceTurnId: string; sourceFrameId: string;
  sourceFrameSha256: string; sourceRevision: number; sourcePurpose: 'before' | 'after'; stateRevision: number;
  sceneEpoch: number; stepId: string; factsHash: string; checksVersion: CameraRequestChecksVersion;
  planVersion?: string;
  instruction: string; whyNeeded: string; resolves: string; targetObservationIds: string[];
  measurement: { factKey: string; unit: string | null } | null;
  status: 'open' | 'answered' | 'cancelled' | 'stale'; createdAt: string; closedAt: string | null;
  closeReason: string | null; answers: CameraEvidenceAnswer[];
};
export type CameraGuidance = { actionable: boolean; canConfirm: boolean; reasons: string[] };
export type CameraSession = {
  workflowId: CameraWorkflowId; revision: number; sceneEpoch: number; currentStepId: string | null;
  status: 'active' | 'scene_changed' | 'operator_reviewed_complete'; facts: CameraFacts;
  completedSteps: CameraStepConfirmation[]; beforeTurn: CameraTurn | null; latestTurn: CameraTurn | null;
  reviews?: CameraStepReview[];
  readingReports?: CameraReadingReport[];
  evidenceRequests?: CameraEvidenceRequest[];
  reasoning?: ReasoningState;
  plan?: CameraPlanState;
  executionBudget?: ExecutionBudget;
  /** Derived on reads; durable authority remains evidenceRequests. */
  openRequest?: CameraEvidenceRequest | null;
  guidance: CameraGuidance; createdAt: string; updatedAt: string;
};
