import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { assetRoot, bytesHash, get, hash, id, insert, list, now, replace, transaction } from '../storage/db';
import { fail, HttpError, ownerHash, readBody } from '../server/http';
import { prepareMedia, sniffMedia } from '../server/media';
import { metaStatus, MetaError, type ModelTrace } from '../meta';
import { assessCameraFrame } from './meta';
import { cameraWorkflow, cameraWorkflows } from './workflows';
import { applyCameraAssessment, CameraDomainError, confirmCameraStep, createCameraSession, refreshCameraGuidance, recordCameraStepReview,
  reviseCameraSession, undoLastCameraStep, answerCameraMeasurementRequest, cancelCameraEvidenceRequest,
  openCameraEvidenceRequest, registerCameraEvidenceRequest, CAMERA_REQUEST_HISTORY_LIMIT } from './engine';
import { initializeCameraReasoning, cameraReasoningVersion, bindCameraEntity, acceptCameraPlanChange, recordCameraReadingReport } from './engine';
import { CAMERA_ENGINE_VERSION, CAMERA_SCHEMA_VERSION, CameraAssessmentSchema, cameraTurnDecisionIds, isCameraDecisionAssessment,
  type StoredCameraAssessment, type CameraSession, type CameraTurn, type WorkflowDefinition, type CameraEvidenceRequest,
  type CameraEvidenceAnswer, type CameraRequestChecksVersion } from './schema';
import { assertCameraStill } from './frame-media';
import { executionForCamera, assertCameraExecutionCurrent, type CameraExecutionScope } from './execution';
import { createOwnedEvidenceResolver, publicEvidenceCatalog, type OwnedEvidenceFrame } from './evidence';
import { assertExecutionCanContinue, remainingExecutionBudget } from '../meta/budget';

const run = promisify(execFile);
const MAX_FRAME_BYTES = 300 * 1024;
const MAX_TURNS = 20;
const PENDING_MS = 5 * 60_000;
const factsSchema = z.record(z.string(), z.union([z.string().max(3000), z.number().finite(), z.boolean()]));
const createSchema = z.object({ workflowId: z.string().max(100), facts: factsSchema }).strict();
const patchSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('facts'), expectedRevision: z.number().int().positive(), facts: factsSchema }).strict(),
  z.object({ action: z.literal('confirm'), expectedRevision: z.number().int().positive(), turnId: z.string().uuid(),
    confirmations: z.record(z.string(), z.boolean()), measurements: z.record(z.string(), z.number().finite().nullable()).optional(), notes: z.string().max(3000) }).strict(),
  z.object({ action: z.literal('review'), expectedRevision: z.number().int().positive(), turnId: z.string().uuid(),
    outcome: z.enum(['failed', 'incomplete']), confirmations: z.record(z.string(), z.boolean()),
    measurements: z.record(z.string(), z.number().finite().nullable()).optional(), notes: z.string().max(3000) }).strict(),
  z.object({ action: z.literal('undo'), expectedRevision: z.number().int().positive() }).strict(),
  z.object({ action: z.literal('request_answer'), expectedRevision: z.number().int().positive(), requestId: z.string().min(1).max(200),
    value: z.number().finite(), unit: z.string().max(100).nullable(), clientOperationId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('request_cancel'), expectedRevision: z.number().int().positive(), requestId: z.string().min(1).max(200),
    clientOperationId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('entity_bind'), expectedRevision: z.number().int().positive(), turnId: z.string().uuid(), observationId: z.string().min(1).max(200),
    label: z.string().trim().min(1).max(200), entityId: z.string().min(1).max(200).nullable(), operatorConfirmed: z.literal(true), clientOperationId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('plan_accept'), expectedRevision: z.number().int().positive(), proposalId: z.string().min(1).max(200),
    operatorConfirmed: z.literal(true), clientOperationId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('reading_report'), expectedRevision: z.number().int().positive(), turnId: z.string().uuid(),
    measurements: z.record(z.string(), z.number().finite().nullable()), confirmations: z.record(z.string(), z.boolean()), notes: z.string().max(3000),
    operatorConfirmed: z.literal(true), clientOperationId: z.string().uuid() }).strict(),
]);
const frameSchema = z.object({ operationId: z.string().uuid(), expectedRevision: z.coerce.number().int().positive(),
  purpose: z.enum(['before', 'after']), source: z.enum(['camera', 'upload']),
  capturedAt: z.iso.datetime().nullable(), operatorNote: z.string().max(2000), requestId: z.string().min(1).max(200).optional() }).strict();

export type CameraChecksVersion = CameraRequestChecksVersion;
export type StoredCameraWorkflowSpec = CameraChecksVersion & { definition: WorkflowDefinition };
export type StoredCameraSession = CameraSession & { id: string; projectId: string; ownerHash: string; activeTurnId: string | null;
  workflowSpec?: StoredCameraWorkflowSpec };
export type StoredCameraFrame = { id: string; projectId: string; storageKey: string; mime: 'image/jpeg' | 'image/png';
  byteLength: number; sha256: string; width: number; height: number; purpose: 'before' | 'after'; source: 'camera' | 'upload';
  capturedAt: string | null; receivedAt: string; revision: number; stepId: string; createdAt: string };
export type StoredCameraTurn = { id: string; projectId: string; frameId: string; operationId: string; requestHash: string;
  revision: number; stepId: string; sceneEpoch: number; status: 'pending' | 'completed' | 'failed' | 'superseded';
  assessment: StoredCameraAssessment | null; trace: ModelTrace | null; error: string | null; createdAt: string; completedAt: string | null;
  decisionId?: string; requestId?: string | null; predictionId?: string | null;
  answersRequestId?: string | null;
  planVersion?: string; factsHash?: string;
  lateResult?: boolean; operatorNote: string; comparison?: StoredCameraComparison | null; checksVersion?: CameraChecksVersion };
export type StoredCameraComparison = { turnId: string; frameId: string; sha256: string; stepId: string; revision: number; sceneEpoch: number };
export type CameraAssessor = typeof assessCameraFrame;
type OwnedCameraComparison = { reference: StoredCameraComparison; turn: StoredCameraTurn; frame: StoredCameraFrame };
const RECONFIRM_CHECKS = 'The workflow checks changed or their original version was not recorded. Review the current facts and explicitly reset this run before continuing. Earlier results remain historical.';
function currentWorkflowSpec(workflow: WorkflowDefinition): StoredCameraWorkflowSpec {
  return { schemaVersion: CAMERA_SCHEMA_VERSION, engineVersion: CAMERA_ENGINE_VERSION, workflowHash: hash(workflow), definition: structuredClone(workflow) };
}
function checksVersion(spec?: StoredCameraWorkflowSpec): CameraChecksVersion | null {
  return spec ? { schemaVersion: spec.schemaVersion, engineVersion: spec.engineVersion, workflowHash: spec.workflowHash } : null;
}
function currentChecks(session: StoredCameraSession) {
  const spec = session.workflowSpec, workflow = cameraWorkflow(session.workflowId);
  return !!spec && !!workflow && spec.schemaVersion === CAMERA_SCHEMA_VERSION && spec.engineVersion === CAMERA_ENGINE_VERSION
    && spec.definition?.id === session.workflowId && spec.workflowHash === hash(spec.definition) && spec.workflowHash === hash(workflow);
}
function requireCurrentChecks(session: StoredCameraSession) {
  if (!currentChecks(session)) fail(409, RECONFIRM_CHECKS);
}
function currentReasoning(session: StoredCameraSession) {
  return !!session.reasoning && !!session.plan && session.plan.current.version.runId === session.id
    && session.plan.current.version.sceneEpoch === session.sceneEpoch && session.plan.current.version.factsHash === hash(session.facts);
}
function ownedCurrentCameraTurn(session: StoredCameraSession, turnId: string) {
  const turn = get<StoredCameraTurn>('camera_turns', turnId), snapshot = session.latestTurn;
  const frame = turn ? get<StoredCameraFrame>('camera_frames', turn.frameId) : null;
  if (!turn || turn.projectId !== session.id || turn.status !== 'completed' || turn.sceneEpoch !== session.sceneEpoch || turn.stepId !== session.currentStepId
    || !snapshot || snapshot.id !== turnId || snapshot.frameId !== turn.frameId || hash(snapshot.assessment) !== hash(turn.assessment)
    || hash(turn.checksVersion) !== hash(checksVersion(session.workflowSpec))
    || !frame || frame.projectId !== session.id || frame.sha256 !== snapshot.frameSha256 || frame.revision !== turn.revision || frame.stepId !== turn.stepId)
    fail(409, 'Choose the exact current owned assessment before reporting a recheck or physical identity.');
  try { if (bytesHash(readFileSync(path.join(assetRoot, frame.storageKey))) !== frame.sha256) throw new Error('changed'); }
  catch { fail(409, 'The assessed image no longer matches its recorded bytes. Capture a new view before reviewing it.'); }
  return turn;
}

/** Resolve metadata, pixels and prior instruction from the same owned saved turn. */
function cameraComparison(session: StoredCameraSession): OwnedCameraComparison | null {
  const snapshot = session.latestTurn || session.beforeTurn;
  const answered = (session.evidenceRequests || []).filter(request => ['answered', 'cancelled'].includes(request.status)
    && request.sceneEpoch === session.sceneEpoch && request.stepId === session.currentStepId).at(-1);
  const turnId = snapshot?.id || openCameraEvidenceRequest(session)?.sourceTurnId || answered?.sourceTurnId || session.completedSteps.at(-1)?.afterTurnId;
  if (!turnId) return null;
  const turn = get<StoredCameraTurn>('camera_turns', turnId);
  const frame = turn ? get<StoredCameraFrame>('camera_frames', turn.frameId) : null;
  if (!turn || turn.projectId !== session.id || turn.sceneEpoch !== session.sceneEpoch || turn.status !== 'completed' || !turn.assessment
    || !isCameraDecisionAssessment(turn.assessment)
    || hash(turn.checksVersion) !== hash(checksVersion(session.workflowSpec))
    || !frame || frame.projectId !== session.id || frame.id !== turn.frameId || frame.stepId !== turn.stepId || frame.revision !== turn.revision
    || (snapshot && snapshot.frameId !== frame.id))
    fail(409, 'The saved comparison view is missing or does not belong to this camera run. Reconfirm the setup before continuing.');
  return { turn, frame, reference: { turnId: turn.id, frameId: frame.id, sha256: frame.sha256,
    stepId: turn.stepId, revision: turn.revision, sceneEpoch: turn.sceneEpoch } };
}

/** A later comparison image cannot substitute its own prediction for the before action. */
function validateOriginalPrediction(session: StoredCameraSession) {
  const original = session.beforeTurn;
  if (!original) return;
  const turn = get<StoredCameraTurn>('camera_turns', original.id);
  const frame = turn ? get<StoredCameraFrame>('camera_frames', turn.frameId) : null;
  if (!turn || turn.projectId !== session.id || turn.status !== 'completed' || turn.sceneEpoch !== session.sceneEpoch
    || turn.stepId !== session.currentStepId || turn.revision !== original.revision
    || hash(turn.checksVersion) !== hash(checksVersion(session.workflowSpec))
    || !isCameraDecisionAssessment(turn.assessment) || turn.assessment.decisionKind !== 'propose_action'
    || hash(turn.assessment) !== hash(original.assessment)
    || !frame || frame.projectId !== session.id || frame.id !== original.frameId || frame.purpose !== 'before'
    || frame.stepId !== original.stepId || frame.stepId !== turn.stepId || frame.revision !== turn.revision
    || !original.frameSha256 || original.frameSha256 !== frame.sha256)
    fail(409, 'The original action prediction is missing or no longer matches its owned before view. Reconfirm the setup before continuing.');
}

function workflowFor(session: CameraSession): WorkflowDefinition {
  const workflow = cameraWorkflow(session.workflowId);
  if (!workflow) fail(409, 'This camera workflow version is not available. Start a new session.');
  return workflow;
}
function domainSession(session: StoredCameraSession): CameraSession {
  const { id: _id, projectId: _project, ownerHash: _owner, activeTurnId: _active, workflowSpec: _spec, openRequest: _open, ...domain } = session;
  return domain;
}

/** Validate the immutable request source as well as the state in which it can be answered. */
function boundEvidenceRequest(session: StoredCameraSession, requestId: string, ignoreStateRevision = false): CameraEvidenceRequest {
  const request = (session.evidenceRequests || []).find(candidate => candidate.id === requestId);
  const source = request ? get<StoredCameraTurn>('camera_turns', request.sourceTurnId) : null;
  const frame = source ? get<StoredCameraFrame>('camera_frames', source.frameId) : null;
  if (!request || request.status !== 'open' || session.status !== 'active' || !currentChecks(session)
    || (!ignoreStateRevision && request.stateRevision !== session.revision) || request.sceneEpoch !== session.sceneEpoch
    || request.stepId !== session.currentStepId || request.factsHash !== hash(session.facts)
    || request.planVersion !== session.plan?.current.id
    || hash(request.checksVersion) !== hash(checksVersion(session.workflowSpec))
    || !source || source.projectId !== session.id || source.status !== 'completed' || source.requestId !== request.id
    || source.revision !== request.sourceRevision || source.sceneEpoch !== request.sceneEpoch || source.stepId !== request.stepId
    || hash(source.checksVersion) !== hash(request.checksVersion) || !isCameraDecisionAssessment(source.assessment)
    || source.assessment.decisionKind !== request.kind
    || !frame || frame.projectId !== session.id || frame.id !== request.sourceFrameId || frame.sha256 !== request.sourceFrameSha256
    || frame.purpose !== request.sourcePurpose || frame.stepId !== request.stepId || frame.revision !== request.sourceRevision)
    fail(409, 'This evidence request no longer matches its saved source, facts, scene, phase or check version. Refresh or explicitly reset the run.');
  const payload = request.kind === 'request_view' ? source.assessment.viewRequest : source.assessment.measurementRequest;
  if (!payload || payload.instruction !== request.instruction || payload.whyNeeded !== request.whyNeeded || payload.resolves !== request.resolves
    || hash(payload.targetObservationIds) !== hash(request.targetObservationIds)
    || (request.kind === 'request_measurement' && (!request.measurement || !source.assessment.measurementRequest
      || request.measurement.factKey !== source.assessment.measurementRequest.factKey || request.measurement.unit !== source.assessment.measurementRequest.unit)))
    fail(409, 'The saved evidence request payload changed. Start a deliberate fresh assessment.');
  return request;
}

function viewAnswerBindingMatches(session: StoredCameraSession, turn: StoredCameraTurn) {
  if (!turn.answersRequestId) return true;
  try {
    const request = boundEvidenceRequest(session, turn.answersRequestId);
    return request.kind === 'request_view' && request.answers.some(answer => answer.kind === 'view' && answer.turnId === turn.id
      && answer.frameId === turn.frameId && answer.status === 'pending');
  } catch { return false; }
}

function finishViewAnswer(session: StoredCameraSession, turn: StoredCameraTurn, accepted: boolean, reason?: string) {
  if (!turn.answersRequestId) return;
  const request = (session.evidenceRequests || []).find(candidate => candidate.id === turn.answersRequestId);
  const answer = request?.answers.find(candidate => candidate.kind === 'view' && candidate.turnId === turn.id);
  if (!request || !answer || answer.status !== 'pending') return;
  const at = now();
  answer.completedAt = at;
  if (accepted) {
    answer.status = 'accepted'; request.status = 'answered'; request.closedAt = at;
    request.closeReason = 'The requested new view was saved and assessed; this does not establish a physical pass.';
    return;
  }
  let current = false;
  try { boundEvidenceRequest(session, request.id, true); current = true; } catch { /* invalidated answers stay historical */ }
  answer.status = current ? 'failed' : 'superseded';
  if (current) { request.stateRevision = session.revision; request.closeReason = reason || 'The view check did not finish. Choose a deliberate new view to retry.'; }
  else if (request.status === 'open') { request.status = 'stale'; request.closedAt = at; request.closeReason = reason || 'The request state changed before this answer could be applied.'; }
}

type RequestActionReceipt = { id: string; projectId: string; operationId: string; requestId: string;
  action: 'request_answer' | 'request_cancel'; requestHash: string; inputRevision: number; resultRevision: number; createdAt: string };
function domainCall<T>(operation: () => T): T {
  try { return operation(); }
  catch (error) { if (error instanceof CameraDomainError) fail(error.status, error.message); throw error; }
}
function audit(sessionId: string, event: string, subjectId: string, detail: string) {
  insert('camera_audit', { id: id(), projectId: sessionId, event, subjectId, detail, createdAt: now() });
}
function invalidateCurrentAttempt(session: StoredCameraSession, turn: StoredCameraTurn) {
  if (session.activeTurnId !== turn.id || session.revision !== turn.revision || session.currentStepId !== turn.stepId) return;
  session.latestTurn = null;
  const frame = get<StoredCameraFrame>('camera_frames', turn.frameId);
  if (frame?.purpose === 'before') session.beforeTurn = null;
  session.revision++; session.updatedAt = now();
}

export function authorizeCamera(req: NextRequest, sessionId: string) {
  const session = get<StoredCameraSession>('camera_sessions', sessionId);
  if (!session || !ownerHash(req) || session.ownerHash !== ownerHash(req)) fail(404, 'Camera session not found in this browser.');
  return session;
}

/** Unknown interrupted inference is not reissued when a page reconnects. */
function expirePending(session: StoredCameraSession, at = now()) {
  if (!session.activeTurnId) return session;
  const turn = get<StoredCameraTurn>('camera_turns', session.activeTurnId);
  if (!turn || turn.status !== 'pending') {
    session.activeTurnId = null; replace('camera_sessions', session); return session;
  }
  if (Date.parse(at) - Date.parse(turn.createdAt) >= PENDING_MS) {
    turn.status = 'failed'; turn.completedAt = at;
    turn.error = 'The camera check was interrupted or exceeded its recovery window. Meta may have performed work. This attempt will not be repeated automatically.';
    replace('camera_turns', turn);
    invalidateCurrentAttempt(session, turn);
    finishViewAnswer(session, turn, false, turn.error);
    session.activeTurnId = null; replace('camera_sessions', session);
    audit(session.id, 'camera_check_outcome_unknown', turn.id, turn.error);
  }
  return session;
}
function publicSession(session: StoredCameraSession) {
  const requiresReconfirmation = !currentChecks(session);
  const domain = requiresReconfirmation ? structuredClone(domainSession(session)) : refreshCameraGuidance(domainSession(session), workflowFor(session), now());
  if (requiresReconfirmation) domain.guidance = { actionable: false, canConfirm: false, reasons: [RECONFIRM_CHECKS] };
  else if (session.activeTurnId) domain.guidance = { actionable: false, canConfirm: false, reasons: ['A newer camera view is being checked. Wait for its saved result.'] };
  let openRequest: CameraEvidenceRequest | null = null;
  const requested = openCameraEvidenceRequest(domain);
  if (requested && !requiresReconfirmation) { try { openRequest = structuredClone(boundEvidenceRequest(session, requested.id)); } catch { /* stale source is never answerable */ } }
  return { ...domain, openRequest, id: session.id, activeTurnId: session.activeTurnId, requiresReconfirmation,
    checksVersion: checksVersion(session.workflowSpec), checksVersionReason: requiresReconfirmation ? RECONFIRM_CHECKS : null };
}
function publicFrame(frame: StoredCameraFrame) {
  const { projectId, storageKey: _storage, ...safe } = frame;
  return { ...safe, url: `/api/camera/sessions/${projectId}/frames/${frame.id}` };
}
function publicTurn(turn: StoredCameraTurn) {
  const { projectId: _project, requestHash: _hash, ...safe } = turn;
  return safe;
}
/** The client charges transport delay without counting model processing twice. */
export function cameraResponseData<T extends object>(output: T, startedAt: number) {
  const serverProcessingMs = Math.max(0, performance.now() - startedAt);
  return { ...output, serverNow: now(), serverProcessingMs };
}
export function cameraState(req: NextRequest, sessionId: string) {
  authorizeCamera(req, sessionId);
  const session = transaction(() => {
    const saved = get<StoredCameraSession>('camera_sessions', sessionId)!;
    return currentChecks(saved) ? expirePending(saved) : saved;
  });
  return { session: publicSession(session), workflow: workflowFor(session),
    historicalWorkflow: !currentChecks(session) ? session.workflowSpec?.definition || null : null,
    turns: list<StoredCameraTurn>('camera_turns', sessionId).map(publicTurn),
    frames: list<StoredCameraFrame>('camera_frames', sessionId).map(publicFrame),
    audit: list('camera_audit', sessionId), meta: metaStatus(), limits: { maxTurns: MAX_TURNS, maxFrameBytes: MAX_FRAME_BYTES }, serverNow: now() };
}
export function cameraSessions(req: NextRequest) {
  const owner = ownerHash(req);
  const sessions = owner ? transaction(() => list<StoredCameraSession>('camera_sessions')
    .filter(session => session.ownerHash === owner).map(session => publicSession(currentChecks(session) ? expirePending(session) : session))) : [];
  return { sessions, workflows: cameraWorkflows, meta: metaStatus(), limits: { maxTurns: MAX_TURNS, maxFrameBytes: MAX_FRAME_BYTES }, serverNow: now() };
}
export function createOwnedCameraSession(body: unknown, browserSession: string) {
  const parsed = createSchema.parse(body);
  const workflow = cameraWorkflow(parsed.workflowId);
  if (!workflow) fail(400, 'Choose one of the supported camera workflows.');
  return transaction(() => {
    const owner = bytesHash(browserSession);
    if (list<StoredCameraSession>('camera_sessions').filter(session => session.ownerHash === owner).length >= 30)
      fail(429, 'This browser has reached the 30-session camera prototype limit.');
    const sessionId = id();
    const base = domainCall(() => createCameraSession(workflow, parsed.facts, now()));
    const domain = domainCall(() => initializeCameraReasoning(base, workflow, { runId: sessionId, factsHash: hash(base.facts) }));
    const session = insert<StoredCameraSession>('camera_sessions', { ...domain, id: sessionId, projectId: sessionId, ownerHash: owner, activeTurnId: null,
      workflowSpec: currentWorkflowSpec(workflow) });
    audit(sessionId, 'camera_session_created', sessionId, 'Operator-confirmed facts. No physical completion is inferred.');
    return session;
  });
}
export function patchCameraSession(req: NextRequest, sessionId: string, body: unknown) {
  authorizeCamera(req, sessionId);
  const parsed = patchSchema.parse(body);
  transaction(() => {
    const saved = get<StoredCameraSession>('camera_sessions', sessionId)!;
    if (parsed.action === 'entity_bind' || parsed.action === 'plan_accept' || parsed.action === 'reading_report') {
      const receiptId = `${sessionId}:${parsed.clientOperationId}`, { expectedRevision: _revision, clientOperationId: _operation, ...intent } = parsed;
      const requestHash = hash(intent), receipt = get<{ projectId: string; requestHash: string }>('camera_state_receipts', receiptId);
      if (receipt) { if (receipt.projectId !== sessionId || receipt.requestHash !== requestHash) fail(409, 'This operation ID belongs to a different saved review.'); return; }
      requireCurrentChecks(saved);
      const session = expirePending(saved);
      if (session.revision !== parsed.expectedRevision || !currentReasoning(session)) fail(409, 'The scene, facts or revision changed. Refresh this run before reviewing it.');
      if (session.activeTurnId) fail(409, 'Wait for the current camera check before changing identity, plan or readings.');
      const workflow = workflowFor(session), at = now();
      if (parsed.action !== 'plan_accept') ownedCurrentCameraTurn(session, parsed.turnId);
      if (parsed.action === 'entity_bind' && parsed.entityId !== null && !session.reasoning!.entities.some(entity => entity.id === parsed.entityId
        && entity.version.runId === sessionId && entity.version.sceneEpoch === session.sceneEpoch)) fail(400, 'Select an owned physical entity from this scene; new identities are assigned by the application.');
      const updated = domainCall(() => parsed.action === 'entity_bind'
        ? bindCameraEntity(domainSession(session), { turnId: parsed.turnId, observationId: parsed.observationId,
          entityId: parsed.entityId || `entity:${id()}`, label: parsed.label, operatorConfirmed: true }, workflow, at)
        : parsed.action === 'plan_accept' ? acceptCameraPlanChange(domainSession(session), parsed, workflow, at)
          : recordCameraReadingReport(domainSession(session), { turnId: parsed.turnId, measurements: parsed.measurements,
            confirmations: parsed.confirmations, notes: parsed.notes, operatorConfirmed: true, operationId: parsed.clientOperationId }, workflow, at));
      replace('camera_sessions', { ...session, ...updated });
      insert('camera_state_receipts', { id: receiptId, projectId: sessionId, operationId: parsed.clientOperationId, action: parsed.action,
        requestHash, inputRevision: session.revision, resultRevision: updated.revision, createdAt: at });
      audit(sessionId, `camera_${parsed.action}`, sessionId, 'An explicit operator review changed the saved reasoning state. No inference or physical completion was performed.'); return;
    }
    if (parsed.action === 'request_answer' || parsed.action === 'request_cancel') {
      const receiptId = `${sessionId}:${parsed.clientOperationId}`;
      const requestHash = hash({ action: parsed.action, requestId: parsed.requestId,
        ...(parsed.action === 'request_answer' ? { value: parsed.value, unit: parsed.unit } : {}) });
      const receipt = get<RequestActionReceipt>('camera_request_receipts', receiptId);
      if (receipt) {
        if (receipt.projectId !== sessionId || receipt.requestHash !== requestHash) fail(409, 'This operation ID belongs to a different evidence answer.');
        return;
      }
      requireCurrentChecks(saved);
      const session = expirePending(saved);
      if (session.revision !== parsed.expectedRevision) fail(409, 'The camera session changed. Refresh its saved state before answering.');
      boundEvidenceRequest(session, parsed.requestId);
      if (parsed.action === 'request_answer' && session.activeTurnId) fail(409, 'Wait for the current view check before saving a numeric answer.');
      const workflow = workflowFor(session), at = now();
      const answered = domainCall(() => parsed.action === 'request_answer'
        ? answerCameraMeasurementRequest(domainSession(session), { requestId: parsed.requestId, value: parsed.value, unit: parsed.unit,
          operationId: parsed.clientOperationId }, workflow, at)
        : cancelCameraEvidenceRequest(domainSession(session), parsed.requestId, workflow, at));
      const updated = domainCall(() => initializeCameraReasoning(answered, workflow, { runId: sessionId, factsHash: hash(answered.facts) }));
      if (parsed.action === 'request_cancel' && session.activeTurnId) {
        const pending = get<StoredCameraTurn>('camera_turns', session.activeTurnId);
        if (pending?.status === 'pending' && pending.answersRequestId === parsed.requestId) {
          pending.status = 'superseded'; pending.completedAt = at; pending.error = 'The operator cancelled the evidence request while its answer was being checked.';
          replace('camera_turns', pending);
        }
      }
      replace('camera_sessions', { ...session, ...updated, activeTurnId: null });
      insert<RequestActionReceipt>('camera_request_receipts', { id: receiptId, projectId: sessionId, operationId: parsed.clientOperationId,
        requestId: parsed.requestId, action: parsed.action, requestHash, inputRevision: session.revision, resultRevision: updated.revision, createdAt: at });
      audit(sessionId, `camera_${parsed.action}`, parsed.requestId, parsed.action === 'request_answer'
        ? 'The operator confirmed a requested prerequisite. No inference, observed-result reading or phase advancement was performed.'
        : 'The operator cancelled a saved evidence request. Any late provider work remains historical.');
      return;
    }
    if (parsed.action !== 'facts') requireCurrentChecks(saved);
    // An explicit reset can recover a historical interrupted request without
    // first advancing its old revision through the automatic expiry path.
    const session = parsed.action === 'facts' ? saved : expirePending(saved);
    if (session.revision !== parsed.expectedRevision) fail(409, 'The camera session changed. Refresh its saved state before continuing.');
    if (parsed.action === 'confirm' && session.activeTurnId)
      fail(409, 'A newer camera view is being checked. Wait for its saved result before confirming an earlier view.');
    const workflow = workflowFor(session);
    let updated = domainCall(() => parsed.action === 'facts' ? reviseCameraSession(domainSession(session), parsed.facts, workflow, now())
      : parsed.action === 'undo' ? undoLastCameraStep(domainSession(session), workflow, now())
        : parsed.action === 'review' ? recordCameraStepReview(domainSession(session), { turnId: parsed.turnId, confirmations: parsed.confirmations,
          measurements: parsed.measurements, notes: parsed.notes, outcome: parsed.outcome }, workflow, now())
          : confirmCameraStep(domainSession(session), { turnId: parsed.turnId, confirmations: parsed.confirmations, measurements: parsed.measurements, notes: parsed.notes }, workflow, now()));
    if (parsed.action === 'facts') updated = domainCall(() => initializeCameraReasoning(updated, workflow, { runId: sessionId, factsHash: hash(updated.facts) }));
    if (parsed.action === 'facts' && session.activeTurnId) {
      const pending = get<StoredCameraTurn>('camera_turns', session.activeTurnId);
      if (pending?.projectId === sessionId && pending.status === 'pending') {
        pending.status = 'superseded'; pending.completedAt = now();
        pending.error = 'An explicit facts reset replaced this camera check. Any provider work remains historical and will not be repeated automatically.';
        replace('camera_turns', pending);
        audit(sessionId, 'camera_check_superseded_by_reset', pending.id, pending.error);
      }
    }
    replace('camera_sessions', { ...session, ...updated, ...(parsed.action === 'facts' ? { workflowSpec: currentWorkflowSpec(workflow), activeTurnId: null } : {}) });
    audit(sessionId, `camera_${parsed.action}`, sessionId, parsed.action === 'confirm'
      ? 'A person confirmed the required checks against the exact before/after frames. This is not an automated physical pass.'
      : 'Session revision changed; earlier model observations remain historical.');
  });
  return cameraState(req, sessionId);
}

async function frameBody(req: NextRequest) {
  const bytes = await readBody(req, MAX_FRAME_BYTES + 50 * 1024);
  let form: FormData;
  try { form = await new Response(bytes, { headers: { 'Content-Type': req.headers.get('content-type') || '' } }).formData(); }
  catch { fail(400, 'Choose a camera frame as a multipart JPEG or PNG upload.'); }
  const file = form.get('file');
  if (!(file instanceof File) || !file.size) fail(400, 'Capture or select a JPEG/PNG frame.');
  if (file.size > MAX_FRAME_BYTES) fail(413, 'Camera frames must be 300 KiB or smaller.');
  const captured = form.get('capturedAt');
  const metadata = frameSchema.parse({ operationId: form.get('operationId'), expectedRevision: form.get('expectedRevision'),
    purpose: form.get('purpose'), source: form.get('source'), capturedAt: captured === null || captured === '' || captured === 'null' ? null : captured,
    operatorNote: form.get('operatorNote') || '', requestId: form.get('requestId') || undefined });
  if (metadata.source === 'camera' && !metadata.capturedAt) fail(400, 'A camera capture needs its reported capture time.');
  if (metadata.source === 'upload' && metadata.capturedAt !== null) fail(400, 'The capture time of an uploaded still is unknown.');
  const image = Buffer.from(await file.arrayBuffer());
  const format = sniffMedia(image);
  if (format.kind !== 'image') fail(415, 'Camera checks use one JPEG/PNG frame, not a video.');
  assertCameraStill(image, format);
  return { image, metadata, format, sha256: bytesHash(image) };
}
function duplicateTurn(sessionId: string, operationId: string, requestHash: string) {
  const existing = list<StoredCameraTurn>('camera_turns', sessionId).find(turn => turn.operationId === operationId);
  if (existing && existing.requestHash !== requestHash) fail(409, 'This operation ID belongs to different frame inputs. Refresh saved checks before starting another.');
  return existing;
}
function checkCanStart(session: StoredCameraSession, expectedRevision: number, purpose: 'before' | 'after', requestId?: string, frameSha256?: string) {
  requireCurrentChecks(session);
  if (!currentReasoning(session)) fail(409, 'The saved reasoning plan does not match the actual confirmed facts and scene. Reset this run explicitly.');
  if (session.revision !== expectedRevision) fail(409, 'The camera session changed. Refresh before inspecting another frame.');
  if (session.activeTurnId) fail(409, 'A camera check is already in progress. Refresh to retrieve its saved result.');
  if (!session.currentStepId || session.status !== 'active') fail(409, 'Review or reset the workflow before inspecting another frame.');
  if (session.executionBudget) {
    try {
      assertExecutionCanContinue(session.executionBudget);
      const remaining = remainingExecutionBudget(session.executionBudget);
      if (remaining.invocations < 1 || remaining.outputTokens < 6000 || remaining.inputBytes < 1)
        fail(429, 'This run has exhausted its shared model-request allowance. Earlier checks remain saved; start a deliberate new run.');
    } catch (error) {
      if (error instanceof HttpError) throw error;
      fail(429, 'This run has reached its shared execution limit. Earlier checks remain saved; start a deliberate new run.');
    }
  }
  const openRequest = openCameraEvidenceRequest(session);
  if (openRequest || requestId) {
    if (!openRequest || !requestId || openRequest.id !== requestId) fail(409, 'Answer the exact saved evidence request or cancel it before choosing another check.');
    const request = boundEvidenceRequest(session, requestId);
    if (request.kind !== 'request_view') fail(409, 'Confirm the requested numeric prerequisite or cancel that request before another frame check.');
    if (request.sourcePurpose !== purpose) fail(400, 'Answer this view request using its original checkpoint purpose.');
    if (!frameSha256 || frameSha256 === request.sourceFrameSha256) fail(409, 'A view answer needs a new image, not the same pixels that caused the request.');
    if (request.answers.length >= CAMERA_REQUEST_HISTORY_LIMIT) fail(429, 'This evidence request has reached its answer-attempt limit. Start a deliberate new run.');
  }
  if (purpose === 'after' && (!session.beforeTurn || session.beforeTurn.stepId !== session.currentStepId))
    fail(409, 'Inspect a before view of the current step before submitting an after view.');
  if (list('camera_turns', session.id).length >= MAX_TURNS) fail(429, 'This session has reached its 20-check prototype budget. Start a deliberate new session for more checks.');
  const owned = list<StoredCameraSession>('camera_sessions').filter(candidate => candidate.ownerHash === session.ownerHash);
  const active = owned.map(candidate => currentChecks(candidate) ? expirePending(candidate) : candidate).filter(candidate => {
    const pending = candidate.activeTurnId ? get<StoredCameraTurn>('camera_turns', candidate.activeTurnId) : null;
    return pending?.status === 'pending' && Date.now() - Date.parse(pending.createdAt) < PENDING_MS;
  }).length;
  if (active >= 3) fail(429, 'Three camera checks are already in progress in this browser. Wait for a saved result.');
}

export async function submitCameraFrame(req: NextRequest, sessionId: string, assessor: CameraAssessor = assessCameraFrame) {
  requireCurrentChecks(authorizeCamera(req, sessionId));
  const payload = await frameBody(req);
  const requestHash = hash({ ...payload.metadata, sha256: payload.sha256 });
  const replay = transaction(() => {
    const session = expirePending(get<StoredCameraSession>('camera_sessions', sessionId)!);
    requireCurrentChecks(session);
    const previous = duplicateTurn(sessionId, payload.metadata.operationId, requestHash);
    if (!previous) checkCanStart(session, payload.metadata.expectedRevision, payload.metadata.purpose, payload.metadata.requestId, payload.sha256);
    return previous;
  });
  if (replay) return { ...cameraState(req, sessionId), turn: publicTurn(get<StoredCameraTurn>('camera_turns', replay.id)!), pending: replay.status === 'pending' };
  if (!metaStatus().configured) fail(503, 'Camera analysis needs the server-side Meta API key. Your local camera preview can remain open.');
  const frameId = id();
  const folder = path.join(assetRoot, 'camera');
  await mkdir(folder, { recursive: true });
  const temporary = path.join(folder, `${frameId}.upload`);
  const normalized = path.join(folder, `${frameId}.normalized`);
  const storageKey = `camera/${frameId}${payload.format.extension}`;
  const framePath = path.join(assetRoot, storageKey);
  let committed = false;
  let record: StoredCameraFrame | null = null;
  let turn: StoredCameraTurn | null = null;
  let frozen: StoredCameraSession | null = null;
  let comparison: OwnedCameraComparison | null = null;
  try {
    await writeFile(temporary, payload.image, { flag: 'wx' });
    try {
      const probe = await run('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-max_pixels', String(1600 * 1600), '-show_entries', 'stream=width,height', '-of', 'json', temporary], { timeout: 5000, maxBuffer: 100_000 });
      const dimensions = JSON.parse(probe.stdout).streams?.[0];
      if (!dimensions || !Number.isInteger(dimensions.width) || !Number.isInteger(dimensions.height) || dimensions.width <= 0 || dimensions.height <= 0 || dimensions.width > 1600 || dimensions.height > 1600)
        fail(415, 'Use a camera frame no larger than 1600 pixels on either side.');
      // Header bounds come first; metadata alone still cannot admit corrupt media.
      await prepareMedia(temporary, normalized, payload.format, 1, MAX_FRAME_BYTES);
      record = { id: frameId, projectId: sessionId, storageKey, mime: payload.format.mime as StoredCameraFrame['mime'],
        byteLength: payload.image.length, sha256: payload.sha256, width: dimensions.width, height: dimensions.height,
        ...payload.metadata, revision: payload.metadata.expectedRevision, receivedAt: now(), stepId: '', createdAt: now() };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      fail(415, 'The camera frame could not be decoded completely. Capture a clear JPEG/PNG and try again.');
    }
    await rename(temporary, framePath);
    const concurrentReplay = transaction(() => {
      const session = expirePending(get<StoredCameraSession>('camera_sessions', sessionId)!);
      const previous = duplicateTurn(sessionId, payload.metadata.operationId, requestHash);
      if (previous) return previous;
      checkCanStart(session, payload.metadata.expectedRevision, payload.metadata.purpose, payload.metadata.requestId, payload.sha256);
      validateOriginalPrediction(session);
      comparison = cameraComparison(session);
      record!.stepId = session.currentStepId!;
      const inserted = insert<StoredCameraFrame>('camera_frames', record!);
      turn = insert<StoredCameraTurn>('camera_turns', { id: id(), projectId: sessionId, frameId: inserted.id,
        operationId: payload.metadata.operationId, requestHash, revision: session.revision, stepId: session.currentStepId!,
        sceneEpoch: session.sceneEpoch, status: 'pending', assessment: null, trace: null, error: null,
        answersRequestId: payload.metadata.requestId || null,
        planVersion: session.plan!.current.id, factsHash: hash(session.facts),
        operatorNote: payload.metadata.operatorNote, comparison: comparison?.reference || null, checksVersion: checksVersion(session.workflowSpec)!, createdAt: now(), completedAt: null });
      if (payload.metadata.requestId) {
        const request = boundEvidenceRequest(session, payload.metadata.requestId);
        const answer: CameraEvidenceAnswer = { id: `answer:${turn.id}`, operationId: payload.metadata.operationId, requestId: request.id,
          kind: 'view', frameId: inserted.id, frameSha256: inserted.sha256, turnId: turn.id,
          status: 'pending', createdAt: now(), completedAt: null };
        request.answers.push(answer);
      }
      // Freeze comparison context before withdrawing older actionable guidance.
      frozen = structuredClone(session);
      session.activeTurnId = turn.id;
      session.latestTurn = null;
      if (payload.metadata.purpose === 'before') session.beforeTurn = null;
      replace('camera_sessions', session);
      audit(sessionId, 'camera_frame_received', inserted.id, `One ${inserted.source} frame saved with SHA-256 ${inserted.sha256}; capture time ${inserted.source === 'upload' ? 'unknown' : 'reported by client, not attested'}.`);
      return null;
    });
    if (concurrentReplay) {
      await unlink(framePath).catch(() => {});
      return { ...cameraState(req, sessionId), turn: publicTurn(concurrentReplay), pending: concurrentReplay.status === 'pending' };
    }
    committed = true;
  } finally {
    await Promise.all([temporary, normalized, ...(!committed ? [framePath] : [])].map(filename => unlink(filename).catch(() => {})));
  }
  const currentTurn = turn as unknown as StoredCameraTurn;
  const frame = record!;
  const session = frozen as unknown as StoredCameraSession;
  const selectedComparison = comparison as OwnedCameraComparison | null;
  const onTrace = async (trace: ModelTrace) => {
    const permitted = transaction(() => {
      let saved = get<StoredCameraTurn>('camera_turns', currentTurn.id);
      if (!saved || saved.projectId !== sessionId) return false;
      // Paid late responses stay auditable even when their guidance is obsolete.
      saved.trace = trace;
      if (trace.providerResponseId && saved.status !== 'pending') saved.lateResult = true;
      replace('camera_turns', saved);
      const invocation = trace.executionBudget?.invocations.find(candidate => candidate.invocationId === trace.modelInvocationId);
      // A continuation checkpoint can still carry the preceding paid response.
      // Its newly reserved invocation must pass the same fence as the first POST.
      if (trace.providerResponseId && (!invocation || invocation.status === 'responded')) return true;
      const latest = get<StoredCameraSession>('camera_sessions', sessionId);
      if (!latest) return false;
      expirePending(latest);
      saved = get<StoredCameraTurn>('camera_turns', currentTurn.id)!;
      if (saved.status !== 'pending') return false;
      if (!currentChecks(latest) || hash(saved.checksVersion) !== hash(checksVersion(latest.workflowSpec))
        || latest.activeTurnId !== saved.id || latest.revision !== saved.revision || latest.currentStepId !== saved.stepId
        || latest.sceneEpoch !== saved.sceneEpoch || latest.status !== 'active' || !viewAnswerBindingMatches(latest, saved) || !currentReasoning(latest)
        || saved.planVersion !== latest.plan?.current.id || saved.factsHash !== hash(latest.facts)) {
        saved.status = 'superseded'; saved.completedAt = now();
        saved.error = 'Facts, scene or step changed before the provider request started. No new camera inference was permitted.';
        replace('camera_turns', saved);
        finishViewAnswer(latest, saved, false, saved.error);
        if (latest.activeTurnId === saved.id) { latest.activeTurnId = null; replace('camera_sessions', latest); }
        audit(sessionId, 'camera_check_superseded_before_request', saved.id, saved.error);
        return false;
      }
      if (latest.executionBudget) assertExecutionCanContinue(latest.executionBudget);
      return true;
    });
    if (!permitted) throw new MetaError('This camera check expired or was replaced before a provider request could start. Refresh the saved session.', 'cancelled');
  };
  try {
    const executionScope: CameraExecutionScope = { runId: session.id, turnId: currentTurn.id, revision: currentTurn.revision,
      stepId: currentTurn.stepId, sceneEpoch: currentTurn.sceneEpoch, factsHash: currentTurn.factsHash!,
      planVersion: currentTurn.planVersion!, checksVersion: currentTurn.checksVersion! };
    const execution = executionForCamera(executionScope);
    const historicalTurns = list<StoredCameraTurn>('camera_turns', session.id).filter(candidate => candidate.status === 'completed'
      && candidate.sceneEpoch === session.sceneEpoch && candidate.id !== currentTurn.id
      && hash(candidate.checksVersion) === hash(currentTurn.checksVersion));
    const ownedCatalog: OwnedEvidenceFrame[] = historicalTurns.flatMap(candidate => {
      const source = get<StoredCameraFrame>('camera_frames', candidate.frameId);
      if (!source || source.projectId !== session.id || source.id === frame.id || source.id === selectedComparison?.frame.id) return [];
      const sourcePath = path.resolve(assetRoot, source.storageKey);
      if (!sourcePath.startsWith(path.resolve(assetRoot) + path.sep)) throw new MetaError('Owned evidence must remain inside this run\'s private asset store.', 'evidence_unavailable');
      return [{ frameId: source.id, turnId: candidate.id, runId: session.id, sceneEpoch: candidate.sceneEpoch,
        sha256: source.sha256, mime: source.mime, width: source.width, height: source.height, source: source.source,
        capturedAt: source.capturedAt, receivedAt: source.receivedAt, purpose: source.purpose, stepId: source.stepId, path: sourcePath }];
    });
    const evidence = ownedCatalog.length ? { catalog: publicEvidenceCatalog({ runId: session.id, sceneEpoch: session.sceneEpoch, catalog: ownedCatalog }),
      resolve: createOwnedEvidenceResolver({ runId: session.id, sceneEpoch: session.sceneEpoch, turnId: currentTurn.id,
        catalog: ownedCatalog, deadlineAt: execution.budget.deadlineAt,
        onVerified: async () => { assertCameraExecutionCurrent(executionScope); } }) } : undefined;
    const result = await assessor({ runId: session.id, turnId: currentTurn.id, workflow: workflowFor(session), session: domainSession(session), framePath,
      previousFramePath: selectedComparison ? path.join(assetRoot, selectedComparison.frame.storageKey) : null,
      comparison: selectedComparison ? { turnId: selectedComparison.turn.id, assessment: CameraAssessmentSchema.parse(selectedComparison.turn.assessment), frame: {
        id: selectedComparison.frame.id, sha256: selectedComparison.frame.sha256, purpose: selectedComparison.frame.purpose,
        source: selectedComparison.frame.source, capturedAt: selectedComparison.frame.capturedAt, receivedAt: selectedComparison.frame.receivedAt,
        stepId: selectedComparison.frame.stepId, revision: selectedComparison.frame.revision } } : null,
      frame: { id: frame.id, sha256: frame.sha256, purpose: frame.purpose, source: frame.source, capturedAt: frame.capturedAt,
        receivedAt: frame.receivedAt, stepId: frame.stepId, revision: frame.revision }, operatorNote: currentTurn.operatorNote, onTrace, execution, evidence });
    const assessment = CameraAssessmentSchema.parse(result.assessment);
    transaction(() => {
      const saved = get<StoredCameraTurn>('camera_turns', currentTurn.id)!;
      const latest = get<StoredCameraSession>('camera_sessions', sessionId)!;
      saved.trace = result.trace; saved.assessment = assessment;
      Object.assign(saved, cameraTurnDecisionIds(saved.id, assessment));
      if (saved.status !== 'pending') { saved.lateResult = true; replace('camera_turns', saved); return; }
      if (!currentChecks(latest) || hash(saved.checksVersion) !== hash(checksVersion(latest.workflowSpec))
        || latest.activeTurnId !== saved.id || latest.revision !== saved.revision || latest.currentStepId !== saved.stepId || latest.sceneEpoch !== saved.sceneEpoch
        || !viewAnswerBindingMatches(latest, saved) || !currentReasoning(latest)
        || saved.planVersion !== latest.plan?.current.id || saved.factsHash !== hash(latest.facts)) {
        saved.status = 'superseded'; saved.error = 'Facts, scene or step changed while this frame was being assessed. The response remains historical.';
        finishViewAnswer(latest, saved, false, saved.error);
      } else {
        const assessed: CameraTurn = { id: saved.id, frameId: frame.id, frameSha256: frame.sha256, purpose: frame.purpose,
          source: frame.source, capturedAt: frame.capturedAt, receivedAt: frame.receivedAt, revision: saved.revision, stepId: saved.stepId,
          ...cameraTurnDecisionIds(saved.id, assessment), assessment };
        finishViewAnswer(latest, saved, true);
        const updated = domainCall(() => applyCameraAssessment(domainSession(latest), assessed, workflowFor(latest), now()));
        const requested = domainCall(() => registerCameraEvidenceRequest(updated, { turn: assessed, sourceSceneEpoch: saved.sceneEpoch,
          factsHash: hash(latest.facts), checksVersion: saved.checksVersion! }, now()));
        Object.assign(latest, refreshCameraGuidance(requested, workflowFor(latest), now())); saved.status = 'completed';
      }
      saved.completedAt = now(); replace('camera_turns', saved);
      if (latest.activeTurnId === saved.id) { latest.activeTurnId = null; replace('camera_sessions', latest); }
      audit(sessionId, 'camera_check_recorded', saved.id, `${saved.status}; model inference only, no automatic step or physical completion.`);
    });
  } catch (error) {
    transaction(() => {
      const saved = get<StoredCameraTurn>('camera_turns', currentTurn.id)!;
      if (error instanceof MetaError && error.trace && typeof error.trace === 'object') saved.trace = error.trace as ModelTrace;
      if (saved.status === 'pending') {
        const latest = get<StoredCameraSession>('camera_sessions', sessionId)!;
        const superseded = !currentChecks(latest) || !currentReasoning(latest) || latest.activeTurnId !== saved.id
          || latest.revision !== saved.revision || latest.currentStepId !== saved.stepId || latest.sceneEpoch !== saved.sceneEpoch
          || saved.planVersion !== latest.plan?.current.id || saved.factsHash !== hash(latest.facts);
        saved.status = superseded ? 'superseded' : 'failed'; saved.completedAt = now();
        saved.error = error instanceof CameraDomainError || error instanceof HttpError
          ? String(error.message) : error instanceof MetaError ? error.message
            : 'Camera analysis did not complete. A request may have reached Meta; inspect this saved attempt before deliberately starting another check.';
        invalidateCurrentAttempt(latest, saved);
        finishViewAnswer(latest, saved, false, saved.error);
        if (latest.activeTurnId === saved.id) { latest.activeTurnId = null; replace('camera_sessions', latest); }
        audit(sessionId, superseded ? 'camera_check_superseded' : 'camera_check_failed', saved.id, saved.error);
      }
      replace('camera_turns', saved);
    });
  }
  return { ...cameraState(req, sessionId), turn: publicTurn(get<StoredCameraTurn>('camera_turns', currentTurn.id)!), pending: false };
}

export async function cameraFrameResponse(req: NextRequest, sessionId: string, frameId: string) {
  authorizeCamera(req, sessionId);
  const frame = get<StoredCameraFrame>('camera_frames', frameId);
  if (!frame || frame.projectId !== sessionId) fail(404, 'Camera frame not found.');
  const bytes = await readFile(path.join(assetRoot, frame.storageKey));
  if (bytes.length !== frame.byteLength || bytesHash(bytes) !== frame.sha256)
    fail(409, 'The saved camera image no longer matches its recorded evidence. Restore the original image or capture a new view before continuing.');
  return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': frame.mime, 'Content-Length': String(bytes.length),
    'Cache-Control': 'private, no-store', 'Content-Security-Policy': "default-src 'none'; sandbox", ETag: `"${frame.sha256}"` } });
}
