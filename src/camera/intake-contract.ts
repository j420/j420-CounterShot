import { z } from 'zod';
import { CameraBoxSchema, CameraWorkflowIdSchema, type CameraWorkflowId } from './schema';
import type { ExecutionBudget } from '../meta/budget';

export const CAMERA_INTAKE_SCHEMA_VERSION = 'camera-intake-v1';
export const CAMERA_INTAKE_LIMITS = Object.freeze({ maxAttempts: 3, maxFrameBytes: 300 * 1024,
  maxFrameSide: 1600, goalCharacters: 500, contextCharacters: 1000 });
export const CAMERA_INTAKE_DRAFT_KEYS: Record<CameraWorkflowId, readonly string[]> = {
  harness_routing: ['target_port_map', 'branch_labels'],
  fragment_dry_fit: ['reference_pattern', 'fragment_labels'],
  webbing_lacing: ['declared_slot_path', 'slot_labels', 'front_face_marker'],
  gasket_seating: ['matched_part_ids', 'quadrant_labels', 'specified_seating_method'],
  gravity_fluidics: ['target_port_map', 'tube_port_labels'],
};
const text = z.string().trim().min(1).max(1000);
const identifier = z.string().trim().min(1).max(100);
export const CameraIntakeWireSchema = z.object({
  summary: text,
  frameQuality: z.enum(['clear', 'blurred', 'occluded', 'insufficient']),
  workflowId: CameraWorkflowIdSchema.nullable(),
  workflowReason: text,
  workflowEvidenceObservationIds: z.array(identifier).max(5),
  observations: z.array(z.object({ id: identifier, label: text, detail: text, box: CameraBoxSchema.nullable() }).strict()).max(5),
  unknowns: z.array(text).max(3),
  viewRequest: z.object({ instruction: text, whyNeeded: text, targetObservationIds: z.array(identifier).max(5) }).strict().nullable(),
  factDrafts: z.array(z.object({ factKey: identifier, value: text,
    evidenceObservationIds: z.array(identifier).min(1).max(5) }).strict()).max(10),
}).strict();
export type CameraIntakeWire = z.infer<typeof CameraIntakeWireSchema>;
export type CameraIntakeFactDraft = CameraIntakeWire['factDrafts'][number] & {
  id: string; frameId: string; frameSha256: string; workflowId: CameraWorkflowId;
};
export type CameraIntakeResult = Omit<CameraIntakeWire, 'factDrafts'> & { factDrafts: CameraIntakeFactDraft[] };
export type CameraIntakeFrame = {
  id: string; url: string; sha256: string; source: 'camera' | 'upload'; capturedAt: string | null;
  receivedAt: string; width: number; height: number;
};
export type PublicCameraIntake = {
  id: string; revision: number; status: 'pending' | 'completed' | 'failed' | 'cancelled' | 'adopted';
  goal: string; context: string; frame: CameraIntakeFrame | null; result: CameraIntakeResult | null;
  error: string | null; adoptedSessionId: string | null; executionBudget: ExecutionBudget;
};
export type CameraIntakeResponse = {
  intake: PublicCameraIntake;
  meta: { configured: boolean; model: string; configurationError: string | null };
  serverNow: string;
};
