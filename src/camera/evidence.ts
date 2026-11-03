import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export const OWNED_EVIDENCE_LIMITS = {
  maxFramesInCatalog: 20, maxRetrievalsPerTurn: 1,
  maxInputBytes: 300 * 1024, maxOutputBytes: 300 * 1024,
  maxInputSide: 1600, maxOutputSide: 960, transformTimeoutMs: 5000,
} as const;

const RegionSchema = z.object({
  x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1),
  width: z.number().finite().positive().max(1), height: z.number().finite().positive().max(1),
}).strict();
/** The provider sees only owned IDs and normalized regions, never storage paths. */
export const evidenceRequestSchema = z.object({ frameId: z.string().min(1).max(200), region: RegionSchema.nullable() }).strict();
export type OwnedEvidenceRequest = z.infer<typeof evidenceRequestSchema>;
export type OwnedEvidenceFrame = {
  frameId: string; turnId: string; runId: string; sceneEpoch: number; sha256: string;
  mime: 'image/jpeg' | 'image/png'; width: number; height: number;
  source: 'camera' | 'upload'; capturedAt: string | null; receivedAt: string;
  purpose: 'before' | 'after'; stepId: string; path: string;
};
export type OwnedEvidenceScope = { runId: string; sceneEpoch: number; turnId: string };
type PixelRegion = { x: number; y: number; width: number; height: number };
export type OwnedEvidenceManifest = {
  version: 'owned-camera-evidence-v1'; role: 'historical'; runId: string; sceneEpoch: number;
  retrievedForTurnId: string; sourceFrameId: string; sourceTurnId: string; sourceSha256: string;
  derivedSha256: string; sourceMime: 'image/jpeg' | 'image/png'; derivedMime: 'image/jpeg' | 'image/png';
  sourcePixels: { width: number; height: number }; derivedPixels: { width: number; height: number };
  region: OwnedEvidenceRequest['region']; pixelRegion: PixelRegion | null;
  transformation: 'exact_source' | 'crop_png' | 'resize_png'; source: 'camera' | 'upload'; capturedAt: string | null;
  receivedAt: string; uploadReceivedAt: string | null;
  captureTimeStatus: 'unknown_actual_capture_time' | 'browser_reported_not_hardware_attested';
  freshness: 'historical_not_refreshed_by_retrieval';
};
export class OwnedEvidenceError extends Error {
  constructor(message: string, public readonly code: 'invalid_evidence_request' | 'evidence_limit' | 'evidence_unavailable'
    | 'evidence_integrity' | 'evidence_transform') { super(message); this.name = 'OwnedEvidenceError'; }
}
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const identifier = (value: unknown) => typeof value === 'string' && !!value.trim() && value.length <= 200;
function invalid(message: string): never { throw new OwnedEvidenceError(message, 'invalid_evidence_request'); }
function integrity(message: string): never { throw new OwnedEvidenceError(message, 'evidence_integrity'); }
function validateScope(scope: OwnedEvidenceScope) {
  if (!identifier(scope.runId) || !identifier(scope.turnId) || !Number.isSafeInteger(scope.sceneEpoch) || scope.sceneEpoch < 1)
    invalid('Evidence retrieval needs the exact application run, scene and requesting turn.');
}
function validateFrame(frame: OwnedEvidenceFrame) {
  if (![frame.frameId, frame.turnId, frame.runId, frame.stepId].every(identifier)
    || !Number.isSafeInteger(frame.sceneEpoch) || frame.sceneEpoch < 1
    || !['image/jpeg', 'image/png'].includes(frame.mime) || !/^[a-f0-9]{64}$/i.test(frame.sha256)
    || ![frame.width, frame.height].every(side => Number.isSafeInteger(side) && side > 0 && side <= OWNED_EVIDENCE_LIMITS.maxInputSide)
    || !['camera', 'upload'].includes(frame.source) || !['before', 'after'].includes(frame.purpose)
    || !Number.isFinite(Date.parse(frame.receivedAt)) || (frame.capturedAt !== null && !Number.isFinite(Date.parse(frame.capturedAt)))
    || (frame.source === 'upload' && frame.capturedAt !== null)
    || typeof frame.path !== 'string' || !path.isAbsolute(frame.path))
    invalid('The saved evidence has incomplete canonical-frame metadata.');
}
function ownedFrames(scope: Pick<OwnedEvidenceScope, 'runId' | 'sceneEpoch'>, catalog: OwnedEvidenceFrame[]) {
  if (!Array.isArray(catalog)) invalid('An application-owned evidence catalog is required.');
  const selected = catalog.filter(frame => frame.runId === scope.runId && frame.sceneEpoch === scope.sceneEpoch);
  if (selected.length > OWNED_EVIDENCE_LIMITS.maxFramesInCatalog)
    throw new OwnedEvidenceError('The owned evidence catalog exceeds the bounded 20-frame camera run.', 'evidence_limit');
  if (new Set(selected.map(frame => frame.frameId)).size !== selected.length) invalid('Evidence frame identifiers must be unambiguous.');
  selected.forEach(validateFrame);
  return selected;
}
export function publicEvidenceCatalog(input: { runId: string; sceneEpoch: number; catalog: OwnedEvidenceFrame[] }) {
  validateScope({ ...input, turnId: 'catalog-read' });
  return ownedFrames(input, input.catalog).map(({ path: _privatePath, ...frame }) => ({ ...frame, role: 'historical' as const,
    captureTimeStatus: frame.source === 'camera' && frame.capturedAt ? 'browser_reported_not_hardware_attested' as const : 'unknown_actual_capture_time' as const,
    freshness: 'historical_not_refreshed_by_retrieval' as const }));
}

/** A fixed allocation, final extra-byte check and digest bind the bytes used below. */
async function verifiedBytes(frame: OwnedEvidenceFrame) {
  let file;
  try { file = await open(frame.path, 'r'); }
  catch { throw new OwnedEvidenceError('The recorded evidence file is unavailable.', 'evidence_unavailable'); }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > OWNED_EVIDENCE_LIMITS.maxInputBytes)
      throw new OwnedEvidenceError('Saved camera evidence must be a nonempty file of at most 300 KiB.', 'evidence_limit');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const next = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!next.bytesRead) integrity('The recorded evidence file became incomplete.');
      offset += next.bytesRead;
    }
    const extra = await file.read(Buffer.alloc(1), 0, 1, bytes.length);
    if (extra.bytesRead || sha(bytes) !== frame.sha256.toLowerCase()) integrity('The saved evidence no longer matches its recorded SHA-256.');
    return bytes;
  } catch (error) {
    if (error instanceof OwnedEvidenceError) throw error;
    throw new OwnedEvidenceError('The recorded evidence could not be read completely.', 'evidence_unavailable');
  } finally { await file.close(); }
}

function dimensions(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (bytes.length < 33 || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR')
      integrity('The saved PNG header is incomplete.');
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), mime: 'image/png' as const };
  }
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    let position = 2;
    while (position < bytes.length) {
      if (bytes[position++] !== 255) integrity('The saved JPEG header is invalid.');
      while (bytes[position] === 255) position++;
      const marker = bytes[position++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd8) continue;
      if (position + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(position);
      if (length < 2 || position + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8) break;
        return { width: bytes.readUInt16BE(position + 5), height: bytes.readUInt16BE(position + 3), mime: 'image/jpeg' as const };
      }
      position += length;
    }
  }
  integrity('Owned evidence must be a recorded JPEG or PNG still.');
}
function pixelRegion(region: NonNullable<OwnedEvidenceRequest['region']>, width: number, height: number): PixelRegion {
  if (region.x + region.width > 1 || region.y + region.height > 1) invalid('The requested region falls outside the recorded frame.');
  const x = Math.floor(region.x * width), y = Math.floor(region.y * height);
  const right = Math.min(width, Math.ceil((region.x + region.width) * width));
  const bottom = Math.min(height, Math.ceil((region.y + region.height) * height));
  if (right <= x || bottom <= y) invalid('The requested crop contains no source pixels.');
  return { x, y, width: right - x, height: bottom - y };
}
function cropVerifiedBytes(bytes: Buffer, region: PixelRegion, timeoutMs: number): Promise<Buffer> {
  const ratio = Math.min(1, OWNED_EVIDENCE_LIMITS.maxOutputSide / region.width, OWNED_EVIDENCE_LIMITS.maxOutputSide / region.height);
  const width = Math.max(1, Math.floor(region.width * ratio)), height = Math.max(1, Math.floor(region.height * ratio));
  const filter = `crop=w=${region.width}:h=${region.height}:x=${region.x}:y=${region.y}:exact=1,scale=w=${width}:h=${height}:flags=area`;
  return new Promise((resolve, reject) => {
    // Only verified bytes reach the decoder. There is no source filename, URL,
    // user-authored filter, shell or second open of the private storage path.
    const child = spawn('ffmpeg', ['-v', 'error', '-xerror', '-nostdin', '-threads', '1', '-err_detect', 'explode',
      '-protocol_whitelist', 'pipe', '-max_pixels', String(OWNED_EVIDENCE_LIMITS.maxInputSide ** 2), '-f', 'image2pipe', '-i', 'pipe:0',
      '-frames:v', '1', '-vf', filter, '-an', '-sn', '-map_metadata', '-1', '-c:v', 'png', '-pix_fmt', 'rgba', '-threads', '1', '-f', 'image2pipe', 'pipe:1'],
    { stdio: ['pipe', 'pipe', 'ignore'], shell: false });
    const chunks: Buffer[] = [];
    let size = 0, settled = false, failure: OwnedEvidenceError | null = null;
    const timeout = setTimeout(() => {
      failure = new OwnedEvidenceError('The bounded evidence crop exceeded its shared transform deadline.', 'evidence_transform');
      child.kill('SIGKILL');
    }, timeoutMs);
    const finish = (error?: OwnedEvidenceError) => {
      if (settled) return;
      settled = true; clearTimeout(timeout);
      if (error) reject(error); else resolve(Buffer.concat(chunks, size));
    };
    child.once('error', () => finish(new OwnedEvidenceError('The evidence decoder could not start.', 'evidence_transform')));
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure || settled) return;
      size += chunk.length;
      if (size > OWNED_EVIDENCE_LIMITS.maxOutputBytes) {
        failure = new OwnedEvidenceError('The derived evidence exceeds the 300 KiB output allowance.', 'evidence_limit');
        child.kill('SIGKILL');
      } else chunks.push(chunk);
    });
    child.stdin.on('error', () => {
      if (!failure) failure = new OwnedEvidenceError('The evidence decoder did not accept the recorded bytes.', 'evidence_transform');
      child.kill('SIGKILL');
    });
    child.once('close', code => finish(failure || (code !== 0 || !size
      ? new OwnedEvidenceError('The evidence could not be decoded into a complete bounded crop.', 'evidence_transform') : undefined)));
    child.stdin.end(bytes);
  });
}

/** The per-turn closure reserves its one retrieval before any asynchronous work. */
export function createOwnedEvidenceResolver(input: OwnedEvidenceScope & { catalog: OwnedEvidenceFrame[]; onVerified?: () => Promise<void>; deadlineAt?: number }) {
  const { onVerified } = input;
  const deadlineAt = input.deadlineAt;
  if (deadlineAt !== undefined && (!Number.isSafeInteger(deadlineAt) || deadlineAt < 0)) invalid('Evidence retrieval needs its recorded execution deadline.');
  const remainingTime = () => {
    const remaining = deadlineAt === undefined ? OWNED_EVIDENCE_LIMITS.transformTimeoutMs : deadlineAt - Date.now();
    if (remaining <= 0) throw new OwnedEvidenceError('The shared execution deadline expired before evidence retrieval completed.', 'evidence_limit');
    return Math.min(OWNED_EVIDENCE_LIMITS.transformTimeoutMs, remaining);
  };
  const scope: OwnedEvidenceScope = { runId: input.runId, sceneEpoch: input.sceneEpoch, turnId: input.turnId };
  validateScope(scope);
  const catalog = structuredClone(ownedFrames(scope, input.catalog));
  let used = false;
  return async (request: unknown) => {
    if (used) throw new OwnedEvidenceError('Only one owned-evidence retrieval is available in this model turn.', 'evidence_limit');
    used = true;
    remainingTime();
    const parsed = evidenceRequestSchema.safeParse(request);
    if (!parsed.success) invalid('Choose one recorded frame ID and a normalized region or null; paths and URLs are not request parameters.');
    const frame = catalog.find(candidate => candidate.frameId === parsed.data.frameId);
    if (!frame) throw new OwnedEvidenceError('This frame is not owned evidence from the current run and scene.', 'evidence_unavailable');
    const selected = parsed.data.region ? pixelRegion(parsed.data.region, frame.width, frame.height) : null;
    const bytes = await verifiedBytes(frame);
    const original = dimensions(bytes);
    if (original.mime !== frame.mime || original.width !== frame.width || original.height !== frame.height)
      integrity('The decoded frame dimensions or media type disagree with the recorded canonical evidence.');
    await onVerified?.();
    const timeoutMs = remainingTime();
    const resized = !selected && Math.max(frame.width, frame.height) > OWNED_EVIDENCE_LIMITS.maxOutputSide;
    const derived = selected || resized ? await cropVerifiedBytes(bytes, selected || { x: 0, y: 0, width: frame.width, height: frame.height }, timeoutMs) : bytes;
    remainingTime();
    const result = dimensions(derived);
    if (result.width > OWNED_EVIDENCE_LIMITS.maxOutputSide || result.height > OWNED_EVIDENCE_LIMITS.maxOutputSide)
      throw new OwnedEvidenceError('The derived evidence exceeds the 960-pixel crop bound.', 'evidence_limit');
    const manifest: OwnedEvidenceManifest = {
      version: 'owned-camera-evidence-v1', role: 'historical', runId: scope.runId, sceneEpoch: scope.sceneEpoch,
      retrievedForTurnId: scope.turnId, sourceFrameId: frame.frameId, sourceTurnId: frame.turnId, sourceSha256: frame.sha256.toLowerCase(),
      derivedSha256: sha(derived), sourceMime: frame.mime, derivedMime: result.mime,
      sourcePixels: { width: frame.width, height: frame.height }, derivedPixels: { width: result.width, height: result.height },
      region: parsed.data.region, pixelRegion: selected, transformation: selected ? 'crop_png' : resized ? 'resize_png' : 'exact_source',
      source: frame.source, capturedAt: frame.capturedAt, receivedAt: frame.receivedAt,
      uploadReceivedAt: frame.source === 'upload' ? frame.receivedAt : null,
      captureTimeStatus: frame.source === 'camera' && frame.capturedAt ? 'browser_reported_not_hardware_attested' : 'unknown_actual_capture_time',
      freshness: 'historical_not_refreshed_by_retrieval',
    };
    return { image: { type: 'input_image' as const, image_url: `data:${result.mime};base64,${derived.toString('base64')}`, detail: 'auto' as const }, manifest };
  };
}
