import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, mock } from 'node:test';
import { promisify } from 'node:util';
import { createOwnedEvidenceResolver, publicEvidenceCatalog, OwnedEvidenceError, OWNED_EVIDENCE_LIMITS,
  type OwnedEvidenceFrame } from '../src/camera/evidence';

const run = promisify(execFile);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const scope = { runId: 'owned-run', sceneEpoch: 2, turnId: 'current-model-turn' };
const request = { frameId: 'frame-before', region: null };
const pixels = (bytes: Buffer) => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });
async function fixture(work: (input: { frame: OwnedEvidenceFrame; bytes: Buffer; directory: string }) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'countershot-owned-evidence-'));
  try {
    const file = path.join(directory, 'source.png');
    await run('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=blue:s=100x80',
      '-vf', 'drawbox=x=50:y=0:w=50:h=80:color=red:t=fill', '-frames:v', '1', '-threads', '1', '-pix_fmt', 'rgba', file], { timeout: 5000 });
    const bytes = await readFile(file);
    const frame: OwnedEvidenceFrame = { frameId: request.frameId, turnId: 'original-model-turn', runId: scope.runId,
      sceneEpoch: scope.sceneEpoch, sha256: sha(bytes), mime: 'image/png', width: 100, height: 80, source: 'upload', capturedAt: null,
      receivedAt: '2026-11-01T09:00:00.000Z', purpose: 'before', stepId: 'identify_harness', path: file };
    await work({ frame, bytes, directory });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
const encodedBytes = (result: Awaited<ReturnType<ReturnType<typeof createOwnedEvidenceResolver>>>) => Buffer.from(result.image.image_url.split(',', 2)[1], 'base64');
const isCode = (code: OwnedEvidenceError['code']) => (error: unknown) => error instanceof OwnedEvidenceError && error.code === code;

test('evidence reads and transforms share the execution deadline instead of receiving a fresh timeout', () => fixture(async ({ frame }) => {
  await assert.rejects(createOwnedEvidenceResolver({ ...scope, deadlineAt: Date.now() - 1,
    catalog: [{ ...frame, path: '/this-expired-request-must-not-read.png' }] })(request), isCode('evidence_limit'));
  const deadlineAt = Date.now() + 60_000;
  let clock: ReturnType<typeof mock.method> | undefined;
  const resolve = createOwnedEvidenceResolver({ ...scope, deadlineAt, catalog: [frame], onVerified: async () => {
    clock = mock.method(Date, 'now', () => deadlineAt);
  } });
  try { await assert.rejects(resolve({ ...request, region: { x: 0, y: 0, width: 0.5, height: 0.5 } }), isCode('evidence_limit')); }
  finally { clock?.mock.restore(); }
}));

test('the public catalog exposes only current owned scene metadata and never private paths', () => fixture(async ({ frame }) => {
  const foreign = { ...frame, frameId: 'foreign-frame', runId: 'another-run', path: '/private/foreign-storage.png' };
  const oldScene = { ...frame, frameId: 'old-scene-frame', sceneEpoch: 1 };
  const visible = publicEvidenceCatalog({ ...scope, catalog: [frame, foreign, oldScene] });
  assert.equal(visible.length, 1);
  assert.equal(visible[0].frameId, frame.frameId);
  assert.equal(visible[0].role, 'historical');
  assert.equal(visible[0].captureTimeStatus, 'unknown_actual_capture_time');
  assert.equal(visible[0].receivedAt, frame.receivedAt);
  assert.equal(visible[0].freshness, 'historical_not_refreshed_by_retrieval');
  assert(!JSON.stringify(visible).includes('path'));
  assert(!JSON.stringify(visible).includes(frame.path));
  assert(!JSON.stringify(visible).includes(foreign.runId));
}));

test('whole-frame evidence uses the exact verified bytes and preserves historical capture provenance', () => fixture(async ({ frame, bytes }) => {
  const selected = structuredClone(frame);
  const resolve = createOwnedEvidenceResolver({ ...scope, catalog: [selected], onVerified: async () => {
    // The file is replaced after verification. Reopening it would send different pixels.
    await writeFile(frame.path, Buffer.alloc(bytes.length, 120));
  } });
  selected.sha256 = '0'.repeat(64);
  const result = await resolve(request);
  assert.deepEqual(encodedBytes(result), bytes);
  assert.equal(result.manifest.sourceSha256, sha(bytes));
  assert.equal(result.manifest.derivedSha256, sha(bytes));
  assert.equal(result.manifest.transformation, 'exact_source');
  assert.equal(result.manifest.sourceFrameId, frame.frameId);
  assert.equal(result.manifest.sourceTurnId, frame.turnId);
  assert.equal(result.manifest.retrievedForTurnId, scope.turnId);
  assert.equal(result.manifest.receivedAt, frame.receivedAt);
  assert.equal(result.manifest.uploadReceivedAt, frame.receivedAt);
  assert.equal(result.manifest.capturedAt, null);
  assert.equal(result.manifest.captureTimeStatus, 'unknown_actual_capture_time');
  assert(!JSON.stringify(result.manifest).includes(frame.path));
}));

test('a crop decodes the same verified buffer after replacement and records exact source and derived hashes', () => fixture(async ({ frame, bytes, directory }) => {
  const replacement = path.join(directory, 'replacement.png');
  await run('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=green:s=100x80', '-frames:v', '1', '-threads', '1', replacement], { timeout: 5000 });
  const resolve = createOwnedEvidenceResolver({ ...scope, catalog: [frame], onVerified: async () => { await writeFile(frame.path, await readFile(replacement)); } });
  const region = { x: .5, y: 0, width: .5, height: 1 };
  const result = await resolve({ frameId: frame.frameId, region });
  const crop = encodedBytes(result);
  assert.deepEqual(pixels(crop), { width: 50, height: 80 });
  assert.equal(result.manifest.sourceSha256, sha(bytes));
  assert.equal(result.manifest.derivedSha256, sha(crop));
  assert.notEqual(result.manifest.derivedSha256, result.manifest.sourceSha256);
  assert.deepEqual(result.manifest.region, region);
  assert.deepEqual(result.manifest.pixelRegion, { x: 50, y: 0, width: 50, height: 80 });
  assert.equal(result.manifest.transformation, 'crop_png');
  const cropFile = path.join(directory, 'derived.png');
  await writeFile(cropFile, crop);
  const decoded = await run('ffmpeg', ['-v', 'error', '-nostdin', '-i', cropFile, '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer', maxBuffer: 100_000 });
  assert(decoded.stdout[0] > 240 && decoded.stdout[1] < 10 && decoded.stdout[2] < 10, 'The original red half is returned, not the replacement green image.');
}));

test('a turn reserves at most one retrieval, including parallel requests and failed selections', () => fixture(async ({ frame }) => {
  const resolve = createOwnedEvidenceResolver({ ...scope, catalog: [frame] });
  const results = await Promise.allSettled([resolve(request), resolve(request)]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert(results[1].status === 'rejected' && isCode('evidence_limit')(results[1].reason));
  const failed = createOwnedEvidenceResolver({ ...scope, catalog: [frame] });
  await assert.rejects(failed({ frameId: 'missing', region: null }), isCode('evidence_unavailable'));
  await assert.rejects(failed(request), isCode('evidence_limit'));
}));

test('missing, foreign-run and old-scene frame IDs cannot select storage files', () => fixture(async ({ frame }) => {
  for (const selected of [{ ...frame, runId: 'foreign-run' }, { ...frame, sceneEpoch: 1 }]) {
    const resolve = createOwnedEvidenceResolver({ ...scope, catalog: [selected] });
    await assert.rejects(resolve(request), isCode('evidence_unavailable'));
  }
  const resolve = createOwnedEvidenceResolver({ ...scope, catalog: [frame] });
  await assert.rejects(resolve({ frameId: '../../etc/passwd', region: null }), isCode('evidence_unavailable'));
}));

test('paths, URLs, unknown parameters and invalid normalized regions fail before file access', () => fixture(async ({ frame }) => {
  await unlink(frame.path);
  for (const invalid of [
    { ...request, path: '/etc/passwd' }, { ...request, url: 'https://example.test/image.png' }, { frameId: frame.frameId },
    { frameId: frame.frameId, region: { x: .9, y: 0, width: .2, height: 1 } },
    { frameId: frame.frameId, region: { x: 0, y: 0, width: 0, height: 1 } },
    { frameId: frame.frameId, region: { x: 0, y: -1, width: 1, height: 1 } },
    { frameId: frame.frameId, region: { x: NaN, y: 0, width: 1, height: 1 } },
  ]) await assert.rejects(createOwnedEvidenceResolver({ ...scope, catalog: [frame] })(invalid), isCode('invalid_evidence_request'));
}));

test('missing files, changed hashes, media metadata and oversized input fail closed', () => fixture(async ({ frame, bytes }) => {
  await assert.rejects(createOwnedEvidenceResolver({ ...scope, catalog: [{ ...frame, sha256: '0'.repeat(64) }] })(request), isCode('evidence_integrity'));
  await assert.rejects(createOwnedEvidenceResolver({ ...scope, catalog: [{ ...frame, width: 99 }] })(request), isCode('evidence_integrity'));
  await assert.rejects(createOwnedEvidenceResolver({ ...scope, catalog: [{ ...frame, mime: 'image/jpeg' }] })(request), isCode('evidence_integrity'));
  assert.throws(() => createOwnedEvidenceResolver({ ...scope, catalog: [{ ...frame, width: 1601 }] }), isCode('invalid_evidence_request'));
  assert.throws(() => createOwnedEvidenceResolver({ ...scope, catalog: [frame, frame] }), isCode('invalid_evidence_request'));
  const tooLarge = Buffer.alloc(OWNED_EVIDENCE_LIMITS.maxInputBytes + 1);
  await writeFile(frame.path, tooLarge);
  await assert.rejects(createOwnedEvidenceResolver({ ...scope, catalog: [{ ...frame, sha256: sha(tooLarge) }] })(request), isCode('evidence_limit'));
  await writeFile(frame.path, bytes);
  await unlink(frame.path);
  await assert.rejects(createOwnedEvidenceResolver({ ...scope, catalog: [frame] })(request), isCode('evidence_unavailable'));
}));

test('full-frame resizing stays below 960 pixels while retaining original capture metadata', () => fixture(async ({ frame, directory }) => {
  const file = path.join(directory, 'wide.jpg');
  await run('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=blue:s=1280x720', '-frames:v', '1', '-threads', '1', '-q:v', '5', file], { timeout: 5000 });
  const bytes = await readFile(file);
  const recorded: OwnedEvidenceFrame = { ...frame, path: file, mime: 'image/jpeg', width: 1280, height: 720, sha256: sha(bytes),
    source: 'camera', capturedAt: '2026-11-01T08:59:58.000Z' };
  const result = await createOwnedEvidenceResolver({ ...scope, catalog: [recorded] })(request);
  assert.deepEqual(pixels(encodedBytes(result)), { width: 960, height: 540 });
  assert.equal(result.manifest.transformation, 'resize_png');
  assert.equal(result.manifest.region, null);
  assert.equal(result.manifest.sourceSha256, recorded.sha256);
  assert.equal(result.manifest.capturedAt, recorded.capturedAt);
  assert.equal(result.manifest.receivedAt, recorded.receivedAt);
  assert.equal(result.manifest.uploadReceivedAt, null);
  assert.equal(result.manifest.captureTimeStatus, 'browser_reported_not_hardware_attested');
}));

test('a highly compressed JPEG cannot expand into an unbounded PNG tool response', () => fixture(async ({ frame, directory }) => {
  const file = path.join(directory, 'noisy.jpg');
  await run('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=gray:s=600x600,noise=alls=100:allf=t:all_seed=7',
    '-frames:v', '1', '-threads', '1', '-q:v', '31', file], { timeout: 5000 });
  const bytes = await readFile(file);
  assert(bytes.length <= OWNED_EVIDENCE_LIMITS.maxInputBytes, 'This fixture exercises output expansion rather than the input limit.');
  const recorded: OwnedEvidenceFrame = { ...frame, path: file, mime: 'image/jpeg', width: 600, height: 600, sha256: sha(bytes) };
  await assert.rejects(createOwnedEvidenceResolver({ ...scope, catalog: [recorded] })({ frameId: frame.frameId, region: { x: 0, y: 0, width: 1, height: 1 } }),
    (error: unknown) => isCode('evidence_limit')(error) && error instanceof Error && /derived evidence/.test(error.message));
}));
