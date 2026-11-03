import { z } from 'zod';

const text = z.string().trim().min(1).max(1000);
const identifier = z.string().trim().min(1).max(200);
const observationIds = z.array(identifier).max(5);

export const PredictionComparisonSchema = z.object({
  predictionId: identifier,
  status: z.enum(['supported_by_view', 'contradicted', 'unresolved']),
  evidenceObservationIds: observationIds,
  failedConditions: z.array(text).max(5),
  unknownConditions: z.array(text).max(5),
}).strict();
export const RecoveryProposalSchema = z.object({
  predictionId: identifier, changedHypothesis: text, failedConditions: z.array(text).max(5),
  correction: text, nextObservation: text,
}).strict();
export const EntityHypothesisSchema = z.object({
  observationId: identifier, candidateEntityIds: z.array(identifier).max(5), detail: text,
}).strict();
export const CameraPlanChangeSchema = z.object({
  parentPlanVersion: identifier, kind: z.enum(['within_phase', 'reopen_phase']),
  reopenStepId: identifier.nullable(),
  substeps: z.array(z.object({ instruction: text, preconditions: z.array(text).max(5),
    expectedVisibleResult: text, stopCondition: text }).strict()).max(4),
  counterevidenceIds: z.array(identifier).min(1).max(5), rationale: text,
}).strict();
