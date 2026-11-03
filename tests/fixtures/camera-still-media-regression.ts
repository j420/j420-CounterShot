import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { createDeflate } from 'node:zlib';
import type { CameraAssessor } from '../../src/camera/server';

assert.ok(process.env.DATA_ROOT?.startsWith(path.join(os.tmpdir(), 'countershot-camera-still-')));
assert.ok(realpathSync(process.env.DATA_ROOT!).startsWith(realpathSync(os.tmpdir()) + path.sep));
assert.equal(process.env.DATABASE_PATH, path.join(process.env.DATA_ROOT!, 'test.sqlite'));
assert.equal(process.env.ASSET_ROOT, path.join(process.env.DATA_ROOT!, 'assets'));
const server = await import('../../src/camera/server');
const store = await import('../../src/storage/db');
const { cameraWorkflows, syntheticCameraFacts } = await import('../../src/camera/workflows');
const { GET: getFrame } = await import('../../app/api/camera/sessions/[id]/frames/[frameId]/route');
const { assertCameraStill } = await import('../../src/camera/frame-media');
const { sniffMedia } = await import('../../src/server/media');
const run = promisify(execFile);
const root = process.env.DATA_ROOT!;
const owner = 'isolated-still-review-owner';
const workflow = cameraWorkflows[0];
const session = () => server.createOwnedCameraSession({ workflowId: workflow.id, facts: syntheticCameraFacts[workflow.id] }, owner);
let calls = 0;
const assessor: CameraAssessor = async input => {
  calls++;
  return { assessment: { summary: 'Offline static-media fixture, not a physical result.', frameQuality: 'clear', continuity: 'first_view',
    observations: [{ id: 'target', label: 'Synthetic target', detail: 'Offline generated pixels.', box: { x: .1, y: .1, width: .2, height: .2 } }],
    contractVersion: 'camera-decision-v3', comparison: null, recovery: null, entityHypotheses: [], planChange: null,
    decisionKind: 'propose_action', viewRequest: null, measurementRequest: null, operatorReview: null, hold: null,
    actionProposal: { kind: 'perform', instruction: 'Offline fixture only.', preconditions: [], targetObservationIds: ['target'],
      expectedVisibleResult: 'A fixed image stays fixed.', stopCondition: 'Pause if the scene differs.' }, suggestedStepId: input.frame.stepId },
    trace: { model: 'offline-still-fixture', providerResponseId: null, latencyMs: 1, usage: [], promptVersion: 'offline-still-fixture' } };
};
function request(sessionId: string, bytes: Buffer, name: string) {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(bytes)], name));
  form.set('operationId', randomUUID()); form.set('expectedRevision', '1'); form.set('purpose', 'before');
  form.set('source', 'upload'); form.set('capturedAt', ''); form.set('operatorNote', 'Synthetic still-image regression only.');
  return new NextRequest(`http://localhost/api/camera/sessions/${sessionId}/frames`, {
    method: 'POST', headers: { cookie: `countershot_session=${owner}` }, body: form,
  });
}
async function accepted(bytes: Buffer, name: string) {
  const created = session();
  const result = await server.submitCameraFrame(request(created.id, bytes, name), created.id, assessor);
  assert.equal(result.turn.status, 'completed');
  const frame = result.frames[0];
  assert.equal(frame.sha256, store.bytesHash(bytes));
  const ctx = { params: Promise.resolve({ id: created.id, frameId: frame.id }) };
  const response = await getFrame(new NextRequest(`http://localhost${frame.url}`, { headers: { cookie: `countershot_session=${owner}` } }), ctx);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  const denied = await getFrame(new NextRequest(`http://localhost${frame.url}`, { headers: { cookie: 'countershot_session=other-browser' } }), ctx);
  assert.equal(denied.status, 404);
}
function pngChunk(type: string, data: Buffer) {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length); result.write(type, 4, 'ascii'); data.copy(result, 8);
  let crc = 0xffffffff;
  for (const byte of result.subarray(4, result.length - 4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}

try {
  if (process.argv[2] === 'resolution') {
    // A highly compressible image fits the byte cap while far exceeding the
    // camera pixel budget. Reusing the immutable row avoids a large test bitmap.
    const width = 7680, height = 7680;
    const row = Buffer.alloc(1 + width * 3);
    const compressed = await new Promise<Buffer>((resolve, reject) => {
      const stream = createDeflate({ level: 9 });
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.once('error', reject); stream.once('end', () => resolve(Buffer.concat(chunks)));
      for (let y = 0; y < height; y++) stream.write(row);
      stream.end();
    });
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
    const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header),
      pngChunk('IDAT', compressed), pngChunk('IEND', Buffer.alloc(0))]);
    assert.ok(bytes.length < 300 * 1024);
    assert.throws(() => assertCameraStill(bytes, sniffMedia(bytes)),
      (error: unknown) => !!error && typeof error === 'object' && 'status' in error && error.status === 415,
      'the small IHDR gate must reject this before any native decoder/probe');
    const wrongFirstChunk = Buffer.concat([bytes.subarray(0, 8), pngChunk('tEXt', header), bytes.subarray(33)]);
    assert.throws(() => assertCameraStill(wrongFirstChunk, sniffMedia(wrongFirstChunk)),
      (error: unknown) => !!error && typeof error === 'object' && 'status' in error && error.status === 415);
    const created = session();
    await assert.rejects(() => server.submitCameraFrame(request(created.id, bytes, 'compressed-large.png'), created.id, assessor),
      (error: unknown) => !!error && typeof error === 'object' && 'status' in error && error.status === 415);
    assert.equal(calls, 0);
    assert.equal(store.list('camera_frames', created.id).length, 0);
    assert.equal(store.list('camera_turns', created.id).length, 0);
    assert.deepEqual(await readdir(path.join(store.assetRoot, 'camera')).catch(() => []), []);
  } else if (process.argv[2] === 'animation') {
    const file = path.join(root, 'animated.png');
    await run('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc=size=96x64:rate=2', '-t', '1', '-plays', '0', '-threads', '1', '-f', 'apng', file], { timeout: 10_000 });
    const bytes = await readFile(file);
    const probe = JSON.parse((await run('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'json', file])).stdout);
    assert.equal(Number(probe.streams[0].nb_read_frames), 2, 'the fixture really contains two displayed frames');
    assert.ok(bytes.length < 300 * 1024);
    const created = session();
    await assert.rejects(() => server.submitCameraFrame(request(created.id, bytes, 'animation.png'), created.id, assessor),
      (error: unknown) => !!error && typeof error === 'object' && 'status' in error && error.status === 415);
    assert.equal(calls, 0);
    assert.equal(store.list('camera_frames', created.id).length, 0);
    assert.equal(store.list('camera_turns', created.id).length, 0);
    assert.deepEqual(await readdir(path.join(store.assetRoot, 'camera')).catch(() => []), []);
  } else {
    const png = path.join(root, 'static.png');
    await run('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=blue:s=32x32', '-frames:v', '1', '-threads', '1', png], { timeout: 10_000 });
    const bytes = await readFile(png);
    if (process.argv[2] === 'static') {
      const jpeg = path.join(root, 'static.jpg');
      await run('ffmpeg', ['-v', 'error', '-nostdin', '-i', png, '-frames:v', '1', '-threads', '1', jpeg], { timeout: 10_000 });
      await accepted(bytes, 'static.png'); await accepted(await readFile(jpeg), 'static.jpg');
      assert.equal(calls, 2);
    } else if (process.argv[2] === 'text') {
      const literal = pngChunk('tEXt', Buffer.from('Comment\0Ordinary text: acTL fcTL fdAT are not chunk types here.'));
      const noted = Buffer.concat([bytes.subarray(0, bytes.length - 12), literal, bytes.subarray(bytes.length - 12)]);
      assertCameraStill(noted, sniffMedia(noted));
      await accepted(noted, 'still-with-note.png');
      assert.equal(calls, 1);
      assert.throws(() => assertCameraStill(noted.subarray(0, noted.length - 3), sniffMedia(noted)),
        (error: unknown) => !!error && typeof error === 'object' && 'status' in error && error.status === 415);
    } else throw new Error('Unknown still-media scenario.');
  }
} finally { store.db.close(); delete (globalThis as { countershotDb?: unknown }).countershotDb; }
