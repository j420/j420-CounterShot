import path from 'node:path';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile, rename, unlink, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { assetRoot, bytesHash, get, hash, id, insert, list, now, replace, transaction } from '../storage/db';
import { fail, HttpError, ownerHash, readBody } from '../server/http';
import { prepareMedia, sniffMedia } from '../server/media';
import { metaStatus, MetaError, type ModelTrace } from '../meta';
import { assertExecutionCanContinue, createExecutionBudget, DEFAULT_CAMERA_EXECUTION_LIMITS, mergeExecutionBudgets,
  remainingExecutionBudget, type ExecutionBudget } from '../meta/budget';
import type { ExecutionBinding } from '../meta/execution';
import { assertCameraStill } from './frame-media';
import { cameraWorkflow } from './workflows';
import { assessCameraIntake } from './intake-meta';
import { CAMERA_INTAKE_DRAFT_KEYS, CAMERA_INTAKE_LIMITS, CameraIntakeWireSchema,
  type CameraIntakeFactDraft, type CameraIntakeResponse, type CameraIntakeResult, type PublicCameraIntake } from './intake-contract';
import type { CameraWorkflowId } from './schema';

const run = promisify(execFile);
const pendingMs = 5 * 60_000;
type Frame = { id: string; projectId: string; storageKey: string; mime: 'image/jpeg' | 'image/png';
  sha256: string; byteLength: number; width: number; height: number; source: 'camera' | 'upload';
  capturedAt: string | null; receivedAt: string; createdAt: string };
export type StoredCameraIntake = Omit<PublicCameraIntake, 'frame'> & {
  projectId: string; ownerHash: string; frameId: string | null; activeAttemptId: string | null;
  attempts: number; createdAt: string; updatedAt: string;
};
type Attempt = { id: string; projectId: string; operationId: string; requestHash: string; revision: number; frameId: string;
  status: PublicCameraIntake['status']; trace: ModelTrace | null; result: CameraIntakeResult | null;
  error: string | null; createdAt: string; completedAt: string | null };
type Operation = { id: string; projectId: string; attemptId: string; requestHash: string; createdAt: string };
const bodySchema = z.object({ operationId: z.string().uuid(), goal: z.string().trim().max(CAMERA_INTAKE_LIMITS.goalCharacters),
  context: z.string().trim().max(CAMERA_INTAKE_LIMITS.contextCharacters), source: z.enum(['camera', 'upload']),
  capturedAt: z.iso.datetime().nullable(), intakeId: z.string().uuid().optional(), expectedRevision: z.coerce.number().int().positive().optional(),
}).strict().refine(value => Boolean(value.intakeId) === (value.expectedRevision !== undefined), 'A retake needs its saved intake and revision.');

function owned(req: NextRequest, intakeId: string): StoredCameraIntake {
  const intake = get<StoredCameraIntake>('camera_intakes', intakeId);
  if (!intake || !ownerHash(req) || intake.ownerHash !== ownerHash(req)) fail(404, 'Scene intake not found in this browser session.');
  return intake;
}
function frameFor(intake: StoredCameraIntake): Frame | null {
  const frame = intake.frameId ? get<Frame>('camera_intake_frames', intake.frameId) : null;
  return frame?.projectId === intake.id ? frame : null;
}
function verifyFrame(intake: StoredCameraIntake): Frame {
  const frame = frameFor(intake);
  if (!frame) fail(409, 'The scene intake image is unavailable. Analyze a new view.');
  try { if (bytesHash(readFileSync(path.join(assetRoot, frame.storageKey))) !== frame.sha256) throw new Error('changed'); }
  catch { fail(409, 'The scene intake image no longer matches its recorded bytes. Analyze a new view.'); }
  return frame;
}
function expire(intake: StoredCameraIntake): StoredCameraIntake {
  if (intake.status !== 'pending' || !intake.activeAttemptId) return intake;
  const attempt = get<Attempt>('camera_intake_attempts', intake.activeAttemptId);
  if (!attempt || Date.now() - Date.parse(attempt.createdAt) >= pendingMs) {
    const error = 'This scene check was interrupted or exceeded its recovery window. Meta may have performed work; it will not be repeated automatically.';
    if (attempt) replace('camera_intake_attempts', { ...attempt, status: 'failed', error, completedAt: now() });
    intake = { ...intake, status: 'failed', error, result: null, activeAttemptId: null, updatedAt: now() };
    replace('camera_intakes', intake);
  }
  return intake;
}
function publicIntake(intake: StoredCameraIntake): PublicCameraIntake {
  const frame = frameFor(intake);
  const adopted = intake.adoptedSessionId ? get<{ ownerHash: string; executionBudget?: ExecutionBudget }>('camera_sessions', intake.adoptedSessionId) : null;
  const budget = adopted?.ownerHash === intake.ownerHash && adopted.executionBudget
    ? mergeExecutionBudgets(intake.executionBudget, adopted.executionBudget) : intake.executionBudget;
  return { id: intake.id, revision: intake.revision, status: intake.status, goal: intake.goal, context: intake.context,
    frame: frame ? { id: frame.id, url: `/api/camera/intakes/${intake.id}/frames/${frame.id}`, sha256: frame.sha256,
      source: frame.source, capturedAt: frame.capturedAt, receivedAt: frame.receivedAt, width: frame.width, height: frame.height } : null,
    result: intake.result, error: intake.error, adoptedSessionId: intake.adoptedSessionId,
    executionBudget: structuredClone(budget) };
}
function response(intake: StoredCameraIntake): CameraIntakeResponse {
  return { intake: publicIntake(intake), meta: metaStatus(), serverNow: now() };
}
export function cameraIntakeState(req: NextRequest, intakeId: string): CameraIntakeResponse {
  return response(transaction(() => expire(owned(req, intakeId))));
}
export function cameraIntakeByOperation(req: NextRequest, operationId: string): CameraIntakeResponse {
  z.string().uuid().parse(operationId);
  const owner = ownerHash(req);
  const operation = owner ? get<Operation>('camera_intake_operations', `${owner}:${operationId}`) : null;
  if (!operation) fail(404, 'This scene operation was not found in this browser session.');
  return cameraIntakeState(req, operation.projectId);
}
export function pendingCameraIntakeCount(owner: string): number {
  return list<StoredCameraIntake>('camera_intakes').filter(record => record.ownerHash === owner)
    .map(expire).filter(record => record.status === 'pending').length;
}
function assertCurrent(intakeId: string, attemptId: string, revision: number) {
  const intake = get<StoredCameraIntake>('camera_intakes', intakeId);
  const attempt = get<Attempt>('camera_intake_attempts', attemptId);
  if (!intake || !attempt || attempt.projectId !== intakeId || intake.revision !== revision || attempt.revision !== revision
    || intake.activeAttemptId !== attemptId || intake.status !== 'pending' || attempt.status !== 'pending'
    || intake.frameId !== attempt.frameId || Date.now() - Date.parse(attempt.createdAt) >= pendingMs)
    throw new MetaError('This scene intake changed or was cancelled. The earlier check remains historical.', 'cancelled');
  verifyFrame(intake);
  assertExecutionCanContinue(intake.executionBudget);
  return intake;
}
function bindingFor(intakeId: string, attemptId: string, revision: number): ExecutionBinding {
  const intake = assertCurrent(intakeId, attemptId, revision);
  return { budget: structuredClone(intake.executionBudget), onBudget: async (incoming, checkpoint) => {
    const budget = transaction(() => {
      const current = get<StoredCameraIntake>('camera_intakes', intakeId);
      if (!current) throw new MetaError('This scene intake no longer exists.', 'cancelled');
      current.executionBudget = mergeExecutionBudgets(current.executionBudget, incoming);
      replace('camera_intakes', current);
      // An adopted session is the same paid run; late accounting cannot be lost at handoff.
      const adopted = get<{ id: string; executionBudget?: ExecutionBudget }>('camera_sessions', intakeId);
      if (adopted) replace('camera_sessions', { ...adopted,
        executionBudget: mergeExecutionBudgets(adopted.executionBudget || current.executionBudget, current.executionBudget) });
      return current.executionBudget;
    });
    if (checkpoint === 'preflight' || checkpoint === 'reserve' || checkpoint === 'tool_reserve') assertCurrent(intakeId, attemptId, revision);
    return budget;
  } };
}
function validateResult(input: unknown, frame: Frame, intake: StoredCameraIntake): CameraIntakeResult {
  const result = CameraIntakeWireSchema.parse(input);
  const observations = new Set(result.observations.map(observation => observation.id));
  if (observations.size !== result.observations.length) fail(502, 'Meta returned duplicate scene observation identities.');
  const refs = (values: string[]) => new Set(values).size === values.length && values.every(value => observations.has(value));
  if (result.observations.some(observation => observation.box &&
    (observation.box.x + observation.box.width > 1 + 1e-9 || observation.box.y + observation.box.height > 1 + 1e-9))
    || !refs(result.workflowEvidenceObservationIds) || result.workflowId !== null && !result.workflowEvidenceObservationIds.length
    || result.viewRequest && !refs(result.viewRequest.targetObservationIds)) fail(502, 'Meta returned ungrounded scene evidence references.');
  if (!result.workflowId && result.factDrafts.length) fail(502, 'An unsupported scene cannot supply workflow fact drafts.');
  const workflow = result.workflowId ? cameraWorkflow(result.workflowId) : null;
  const keys = new Set<string>();
  const factDrafts = result.factDrafts.map(draft => {
    if (!workflow || !CAMERA_INTAKE_DRAFT_KEYS[workflow.id].includes(draft.factKey)
      || workflow.requiredFacts.find(fact => fact.id === draft.factKey)?.kind !== 'text'
      || keys.has(draft.factKey) || !refs(draft.evidenceObservationIds))
      fail(502, 'Meta returned an unsupported or ungrounded scene draft. No facts were confirmed.');
    keys.add(draft.factKey);
    return { ...draft, id: `draft:${intake.id}:${intake.revision}:${draft.factKey}`, frameId: frame.id,
      frameSha256: frame.sha256, workflowId: workflow.id };
  });
  return { ...result, factDrafts };
}
async function intakeBody(req: NextRequest) {
  const bytes = await readBody(req, CAMERA_INTAKE_LIMITS.maxFrameBytes + 50 * 1024);
  let form: FormData;
  try { form = await new Response(bytes, { headers: { 'Content-Type': req.headers.get('content-type') || '' } }).formData(); }
  catch { fail(400, 'Send a scene intake as one multipart JPEG or PNG image.'); }
  const allowed = new Set(['file', 'goal', 'context', 'source', 'capturedAt', 'operationId', 'intakeId', 'expectedRevision']);
  for (const key of form.keys()) if (!allowed.has(key) || form.getAll(key).length !== 1) fail(400, 'Scene intake fields must be distinct supported values.');
  const file = form.get('file');
  if (!(file instanceof File) || !file.size) fail(400, 'Capture or choose one scene image.');
  if (file.size > CAMERA_INTAKE_LIMITS.maxFrameBytes) fail(413, 'Scene images must be 300 KiB or smaller.');
  const captured = form.get('capturedAt');
  const metadata = bodySchema.parse({ operationId: form.get('operationId'), goal: form.get('goal') || '', context: form.get('context') || '',
    source: form.get('source'), capturedAt: captured === null || captured === '' || captured === 'null' ? null : captured,
    intakeId: form.get('intakeId') || undefined, expectedRevision: form.get('expectedRevision') || undefined });
  if (metadata.source === 'camera' && !metadata.capturedAt) fail(400, 'A camera capture needs its reported capture time.');
  if (metadata.source === 'upload' && metadata.capturedAt !== null) fail(400, 'An uploaded still has unknown actual capture time.');
  const image = Buffer.from(await file.arrayBuffer()), format = sniffMedia(image);
  assertCameraStill(image, format);
  return { image, format, metadata, sha256: bytesHash(image) };
}
function checkStart(owner: string, metadata: z.infer<typeof bodySchema>) {
  if (metadata.intakeId) {
    const saved = get<StoredCameraIntake>('camera_intakes', metadata.intakeId);
    if (!saved || saved.ownerHash !== owner) fail(404, 'Scene intake not found in this browser session.');
    const intake = expire(saved);
    if (intake.revision !== metadata.expectedRevision) fail(409, 'This scene intake changed. Refresh its saved result.');
    if (intake.status === 'pending') fail(409, 'A scene check is already in progress. Retrieve it or cancel before another analysis.');
    if (intake.adoptedSessionId) fail(409, 'This scene intake already belongs to a workflow. Continue that run.');
    if (intake.attempts >= CAMERA_INTAKE_LIMITS.maxAttempts) fail(429, 'This scene intake has reached its three-analysis limit.');
    try { assertExecutionCanContinue(intake.executionBudget); }
    catch { fail(429, 'This run has reached its shared execution limit.'); }
    const remaining = remainingExecutionBudget(intake.executionBudget);
    if (remaining.invocations < 1 || remaining.outputTokens < 3000) fail(429, 'This run cannot support another scene analysis.');
    return intake;
  }
  const ownedIntakes = list<StoredCameraIntake>('camera_intakes').filter(record => record.ownerHash === owner);
  const sessions = list<{ id: string; ownerHash: string }>('camera_sessions').filter(record => record.ownerHash === owner);
  if (new Set([...ownedIntakes, ...sessions].map(record => record.id)).size >= 30) fail(429, 'This browser has reached its 30-run camera limit.');
  return null;
}
export async function submitCameraIntake(req: NextRequest, browserSession: string, assessor = assessCameraIntake): Promise<CameraIntakeResponse> {
  if (!browserSession || req.cookies.get('countershot_session')?.value !== browserSession)
    fail(400, 'Reload the camera workspace before analysing a scene so a lost response remains recoverable in this browser.');
  const payload = await intakeBody(req), owner = bytesHash(browserSession);
  const requestHash = hash({ ...payload.metadata, sha256: payload.sha256 });
  const operationKey = `${owner}:${payload.metadata.operationId}`;
  const replay = transaction(() => {
    const operation = get<Operation>('camera_intake_operations', operationKey);
    if (operation) {
      if (operation.requestHash !== requestHash) fail(409, 'This operation identity belongs to different scene inputs.');
      return expire(get<StoredCameraIntake>('camera_intakes', operation.projectId)!);
    }
    checkStart(owner, payload.metadata); return null;
  });
  if (replay) return response(replay);
  if (!metaStatus().configured) fail(503, 'Scene understanding needs the server-side Meta key. The local preview remains available.');
  const frameId = id(), folder = path.join(assetRoot, 'camera-intakes');
  await mkdir(folder, { recursive: true });
  const temporary = path.join(folder, `${frameId}.upload`), normalized = path.join(folder, `${frameId}.normalized`);
  const storageKey = `camera-intakes/${frameId}${payload.format.extension}`, filePath = path.join(assetRoot, storageKey);
  let retained = false;
  let intake: StoredCameraIntake | null = null, attempt: Attempt | null = null;
  try {
    await writeFile(temporary, payload.image, { flag: 'wx' });
    let width: number, height: number;
    try {
      const probe = await run('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-max_pixels', String(1600 * 1600),
        '-show_entries', 'stream=width,height', '-of', 'json', temporary], { timeout: 5000, maxBuffer: 100_000 });
      const dimensions = JSON.parse(probe.stdout).streams?.[0];
      if (!dimensions || !Number.isInteger(dimensions.width) || !Number.isInteger(dimensions.height)
        || dimensions.width <= 0 || dimensions.height <= 0 || dimensions.width > 1600 || dimensions.height > 1600)
        fail(415, 'Use a scene image no larger than 1600 pixels on either side.');
      width = dimensions.width; height = dimensions.height;
      await prepareMedia(temporary, normalized, payload.format, 1, CAMERA_INTAKE_LIMITS.maxFrameBytes);
    } catch (error) { if (error instanceof HttpError) throw error; fail(415, 'This scene image could not be decoded completely.'); }
    await rename(temporary, filePath);
    const duplicate = transaction(() => {
      const existing = get<Operation>('camera_intake_operations', operationKey);
      if (existing) {
        if (existing.requestHash !== requestHash) fail(409, 'This operation identity belongs to different scene inputs.');
        return expire(get<StoredCameraIntake>('camera_intakes', existing.projectId)!);
      }
      const previous = checkStart(owner, payload.metadata);
      const pending = pendingCameraIntakeCount(owner);
      const active = list<{ ownerHash: string; activeTurnId: string | null }>('camera_sessions')
        .filter(record => {
          if (record.ownerHash !== owner || !record.activeTurnId) return false;
          const turn = get<{ status: string; createdAt: string }>('camera_turns', record.activeTurnId);
          return turn?.status === 'pending' && Date.now() - Date.parse(turn.createdAt) < pendingMs;
        }).length;
      if (pending + active >= 3) fail(429, 'Three camera checks are already in progress in this browser.');
      const intakeId = previous?.id || id(), at = now(), attemptId = id();
      intake = { id: intakeId, projectId: intakeId, ownerHash: owner, revision: previous ? previous.revision + 1 : 1,
        status: 'pending', goal: payload.metadata.goal, context: payload.metadata.context, frameId,
        result: null, error: null, adoptedSessionId: null, activeAttemptId: attemptId, attempts: (previous?.attempts || 0) + 1,
        executionBudget: previous?.executionBudget || createExecutionBudget(intakeId, DEFAULT_CAMERA_EXECUTION_LIMITS),
        createdAt: previous?.createdAt || at, updatedAt: at };
      const frame: Frame = { id: frameId, projectId: intakeId, storageKey, mime: payload.format.mime as Frame['mime'],
        byteLength: payload.image.length, sha256: payload.sha256, width, height, source: payload.metadata.source,
        capturedAt: payload.metadata.capturedAt, receivedAt: at, createdAt: at };
      attempt = { id: attemptId, projectId: intakeId, operationId: payload.metadata.operationId, requestHash,
        revision: intake.revision, frameId, status: 'pending', trace: null, result: null, error: null, createdAt: at, completedAt: null };
      insert('camera_intake_frames', frame); insert('camera_intake_attempts', attempt);
      insert<Operation>('camera_intake_operations', { id: operationKey, projectId: intakeId, attemptId, requestHash, createdAt: at });
      if (previous) replace('camera_intakes', intake); else insert('camera_intakes', intake);
      return null;
    });
    if (duplicate) return response(duplicate);
    retained = true;
    const frozen = intake as StoredCameraIntake | null, currentAttempt = attempt as Attempt | null;
    if (!frozen || !currentAttempt) throw new Error('Scene intake publication failed.');
    const onTrace = async (trace: ModelTrace) => {
      transaction(() => {
        const saved = get<Attempt>('camera_intake_attempts', currentAttempt.id);
        if (saved) replace('camera_intake_attempts', { ...saved, trace: structuredClone(trace) });
      });
      assertCurrent(frozen.id, currentAttempt.id, frozen.revision);
    };
    try {
      const result = await assessor({ runId: frozen.id, turnId: currentAttempt.id, framePath: filePath,
        frame: { id: frameId, sha256: payload.sha256, source: payload.metadata.source,
          capturedAt: payload.metadata.capturedAt, receivedAt: frozen.updatedAt }, goal: frozen.goal, context: frozen.context,
        execution: bindingFor(frozen.id, currentAttempt.id, frozen.revision), onTrace });
      // Preserve provider audit before validating references or publishing any draft.
      transaction(() => {
        const saved = get<Attempt>('camera_intake_attempts', currentAttempt.id)!;
        replace('camera_intake_attempts', { ...saved, trace: structuredClone(result.trace) });
      });
      const validated = validateResult(result.result, verifyFrame(frozen), frozen);
      transaction(() => {
        const latest = assertCurrent(frozen.id, currentAttempt.id, frozen.revision);
        replace('camera_intake_attempts', { ...get<Attempt>('camera_intake_attempts', currentAttempt.id)!,
          status: 'completed', result: validated, completedAt: now() });
        replace('camera_intakes', { ...latest, result: validated, status: 'completed', activeAttemptId: null, updatedAt: now() });
      });
    } catch (error) {
      transaction(() => {
        const saved = get<Attempt>('camera_intake_attempts', currentAttempt.id)!;
        const trace = error instanceof MetaError && error.trace ? error.trace as ModelTrace : saved.trace;
        const message = error instanceof HttpError || error instanceof MetaError ? error.message
          : 'Meta returned an invalid scene result. No workflow or facts were adopted.';
        replace('camera_intake_attempts', { ...saved, trace, status: saved.status === 'pending' ? 'failed' : saved.status,
          error: message, completedAt: now() });
        const latest = get<StoredCameraIntake>('camera_intakes', frozen.id)!;
        if (latest.activeAttemptId === currentAttempt.id && latest.revision === frozen.revision)
          replace('camera_intakes', { ...latest, status: 'failed', result: null, error: message, activeAttemptId: null, updatedAt: now() });
      });
    }
    return response(get<StoredCameraIntake>('camera_intakes', frozen.id)!);
  } finally {
    await unlink(temporary).catch(() => {}); await unlink(normalized).catch(() => {});
    if (!retained) await unlink(filePath).catch(() => {});
  }
}
export function cancelCameraIntake(req: NextRequest, intakeId: string, body: unknown): CameraIntakeResponse {
  const parsed = z.object({ action: z.literal('cancel'), expectedRevision: z.number().int().positive() }).strict().parse(body);
  return response(transaction(() => {
    const intake = expire(owned(req, intakeId));
    if (intake.status === 'cancelled' && parsed.expectedRevision === intake.revision - 1) return intake;
    if (intake.revision !== parsed.expectedRevision) fail(409, 'This scene intake changed. Refresh its saved state.');
    if (intake.adoptedSessionId) fail(409, 'This intake was already adopted. Continue the saved workflow.');
    if (intake.activeAttemptId) {
      const attempt = get<Attempt>('camera_intake_attempts', intake.activeAttemptId);
      if (attempt) replace('camera_intake_attempts', { ...attempt, status: 'cancelled', completedAt: now() });
    }
    // Fence retakes that passed preflight before this cancellation but are still decoding media.
    const cancelled: StoredCameraIntake = { ...intake, revision: intake.revision + 1, status: 'cancelled', result: null, activeAttemptId: null,
      error: 'Scene analysis cancelled. Any started provider work remains recorded and is not retried automatically.', updatedAt: now() };
    replace('camera_intakes', cancelled); return cancelled;
  }));
}
export function adoptCameraIntake<T>(input: { intakeId: string; expectedRevision: number; workflowId: string; browserSession: string },
  create: (info: { id: string; budget: ExecutionBudget; goal: string; context: string }) => T): T {
  return transaction(() => {
    const intake = get<StoredCameraIntake>('camera_intakes', input.intakeId);
    if (!intake || intake.ownerHash !== bytesHash(input.browserSession)) fail(404, 'Scene intake not found in this browser session.');
    if (intake.revision !== input.expectedRevision || intake.result?.workflowId !== input.workflowId)
      fail(409, 'Adopt only the latest recommended workflow from this exact scene intake.');
    if (intake.adoptedSessionId) {
      const session = get<{ ownerHash: string; workflowId: string }>('camera_sessions', intake.adoptedSessionId);
      if (!session || session.ownerHash !== intake.ownerHash || session.workflowId !== input.workflowId) fail(409, 'The adopted workflow is unavailable.');
      return session as T;
    }
    verifyFrame(intake);
    if (intake.status !== 'completed' || !intake.result || !intake.result.workflowId
      || intake.result.frameQuality !== 'clear' || intake.result.viewRequest !== null)
      fail(409, 'Understand a clear scene and resolve its requested view before adopting a supported workflow.');
    try { assertExecutionCanContinue(intake.executionBudget); }
    catch { fail(429, 'This scene run has reached its shared execution limit.'); }
    const created = create({ id: intake.id, budget: structuredClone(intake.executionBudget), goal: intake.goal, context: intake.context });
    const session = get<{ id: string; ownerHash: string; workflowId: string; facts: Record<string, unknown>; executionBudget?: ExecutionBudget }>('camera_sessions', intake.id);
    if (!session || session.id !== intake.id || session.ownerHash !== intake.ownerHash || session.workflowId !== input.workflowId
      || Object.keys(session.facts).length || hash(session.executionBudget) !== hash(intake.executionBudget))
      fail(409, 'Scene adoption must preserve its exact owned run, unknown facts and shared execution allowance.');
    replace('camera_intakes', { ...intake, status: 'adopted', adoptedSessionId: intake.id, updatedAt: now() });
    return created;
  });
}
export function publicCameraIntakeForSession(sessionId: string, browserSession: string): PublicCameraIntake | null {
  const intake = get<StoredCameraIntake>('camera_intakes', sessionId);
  if (!intake || intake.ownerHash !== bytesHash(browserSession) || intake.adoptedSessionId !== sessionId || intake.status !== 'adopted') return null;
  return publicIntake(intake);
}
export function cameraIntakeDraftForSession(sessionId: string, browserSession: string, draftId: string): CameraIntakeFactDraft | null {
  const intake = get<StoredCameraIntake>('camera_intakes', sessionId);
  const session = get<{ id: string; ownerHash: string; workflowId: string; sceneEpoch: number; setupContext?: { intakeId?: string } }>('camera_sessions', sessionId);
  if (!intake || !session || intake.ownerHash !== bytesHash(browserSession) || session.ownerHash !== intake.ownerHash
    || intake.adoptedSessionId !== sessionId || intake.status !== 'adopted' || intake.result?.workflowId !== session.workflowId
    || session.sceneEpoch !== 1 || session.setupContext?.intakeId !== intake.id) return null;
  let frame: Frame;
  try { frame = verifyFrame(intake); } catch { return null; }
  const draft = intake.result.factDrafts.find(candidate => candidate.id === draftId && candidate.frameId === frame.id
    && candidate.frameSha256 === frame.sha256 && candidate.workflowId === session.workflowId);
  return draft ? structuredClone(draft) : null;
}
export async function cameraIntakeFrameResponse(req: NextRequest, intakeId: string, frameId?: string): Promise<Response> {
  const intake = owned(req, intakeId);
  const frame = frameId ? get<Frame>('camera_intake_frames', frameId) : frameFor(intake);
  if (!frame || frame.projectId !== intake.id) fail(404, 'Scene image not found in this intake.');
  let bytes: Buffer;
  try { bytes = await readFile(path.join(assetRoot, frame.storageKey)); }
  catch { fail(404, 'This scene image is unavailable.'); }
  if (bytesHash(bytes) !== frame.sha256) fail(409, 'The scene image changed while it was being read.');
  return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': frame.mime, 'Content-Length': String(bytes.length),
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
}
