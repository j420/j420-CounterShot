import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { NextRequest } from 'next/server';

// Only subprocess tests with explicitly isolated storage may execute this fixture.
assert.ok(process.env.DATA_ROOT?.startsWith(path.join(os.tmpdir(), 'countershot-http-test-')));
assert.equal(process.env.DATABASE_PATH, path.join(process.env.DATA_ROOT!, 'test.sqlite'));
assert.equal(process.env.ASSET_ROOT, path.join(process.env.DATA_ROOT!, 'assets'));
delete process.env.APP_ACCESS_CODE;
process.env.MODEL_API_KEY = '';
delete process.env.MAX_CLIP_BYTES;
delete process.env.MAX_CLIP_SECONDS;

const { POST: upload } = await import('../../app/api/projects/[id]/assets/route');
const { GET: download } = await import('../../app/api/projects/[id]/assets/[assetId]/route');
const { createProject } = await import('../../src/server/projects');
const store = await import('../../src/storage/db');
const run = promisify(execFile);
const scenario = process.argv[2];
const session = 'isolated-media-regression-session';
const project = createProject({ title: 'HTTP regression fixture', workflow: 'workshop_jig', goal: 'Check media decoding and storage invariants offline', finishedDefinition: 'Software fixture only, no physical success claim' }, session);
const mediaPath = path.join(process.env.DATA_ROOT!, 'valid.mp4');
const ffmpeg = (args: string[]) => run('ffmpeg', ['-v', 'error', '-nostdin', ...args], { timeout: 15_000, maxBuffer: 1_000_000 });
await ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=32x32:r=10', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mediaPath]);
const validVideo = await readFile(mediaPath);

function uploadRequest(bytes: Uint8Array, name: string) {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(bytes)], name));
  form.set('purpose', 'trial');
  return new NextRequest(`http://localhost/api/projects/${project.id}/assets`, { method: 'POST', headers: { cookie: `countershot_session=${session}` }, body: form });
}
const submit = (bytes: Uint8Array, name = 'test.mp4') => upload(uploadRequest(bytes, name), { params: Promise.resolve({ id: project.id }) });
const files = () => readdir(store.assetRoot);
const assets = () => store.list<{ id: string; byteLength: number; storageKey: string }>('assets', project.id);

try {
  if (scenario === 'valid') {
    const pngPath = path.join(process.env.DATA_ROOT!, 'valid.png');
    const jpgPath = path.join(process.env.DATA_ROOT!, 'valid.jpg');
    await ffmpeg(['-i', mediaPath, '-frames:v', '1', '-threads', '1', pngPath]);
    await ffmpeg(['-i', mediaPath, '-frames:v', '1', '-threads', '1', jpgPath]);
    for (const [name, expectedMime, bytes] of [
      ['valid.mp4', 'video/mp4', validVideo],
      ['valid.png', 'image/png', await readFile(pngPath)],
      ['valid.jpg', 'image/jpeg', await readFile(jpgPath)],
    ] as const) {
      const response = await submit(bytes, name);
      const value = await response.json();
      assert.equal(response.status, 201, value.error);
      assert.equal(value.asset.mime, expectedMime);
      assert.equal(value.asset.durationMs, expectedMime === 'video/mp4' ? 1000 : null);
      assert.equal(value.asset.purpose, 'trial');
      assert.equal(value.asset.sha256, store.bytesHash(bytes));
      const params = { params: Promise.resolve({ id: project.id, assetId: value.asset.id }) };
      const retrieved = await download(new NextRequest(`http://localhost/api/projects/${project.id}/assets/${value.asset.id}`, { headers: { cookie: `countershot_session=${session}` } }), params);
      assert.equal(retrieved.status, 200);
      assert.deepEqual(Buffer.from(await retrieved.arrayBuffer()), bytes);
      const forbidden = await download(new NextRequest(`http://localhost/api/projects/${project.id}/assets/${value.asset.id}`), params);
      assert.equal(forbidden.status, 404);
    }
    assert.equal(assets().length, 3);
    assert.equal((await files()).length, 3);
  } else if (scenario === 'single-frame') {
    const singlePath = path.join(process.env.DATA_ROOT!, 'single-frame.mp4');
    await ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=32x32:r=10', '-frames:v', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', singlePath]);
    const metadata = JSON.parse((await run('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
      '-show_entries', 'format=duration:stream=nb_read_frames', '-of', 'json', singlePath])).stdout);
    assert.equal(Number(metadata.streams[0].nb_read_frames), 1);
    assert.equal(Number(metadata.format.duration), 0.1);
    const bytes = await readFile(singlePath);
    const response = await submit(bytes, 'single-frame.mp4');
    const value = await response.json();
    assert.equal(response.status, 201, value.error);
    assert.equal(value.asset.durationMs, 100, 'The final frame display interval counts even when its timestamp is zero.');
    assert.equal(value.asset.sha256, store.bytesHash(bytes));
    assert.equal(assets().length, 1);
    assert.equal((await files()).length, 1);
  } else if (scenario === 'invalid') {
    const boxes: Buffer[] = [];
    for (let offset = 0; offset + 8 <= validVideo.length;) {
      const size = validVideo.readUInt32BE(offset);
      assert.ok(size >= 8);
      const type = validVideo.toString('ascii', offset + 4, offset + 8);
      if (type === 'ftyp' || type === 'moov') boxes.push(validVideo.subarray(offset, offset + size));
      offset += size;
    }
    const emptyMdat = Buffer.alloc(8);
    emptyMdat.writeUInt32BE(8);
    emptyMdat.write('mdat', 4);
    const noFrames = Buffer.concat([...boxes, emptyMdat]);
    const noFramesPath = path.join(process.env.DATA_ROOT!, 'no-frames.mp4');
    await writeFile(noFramesPath, noFrames);
    const metadata = JSON.parse((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', noFramesPath])).stdout);
    assert.equal(Number(metadata.format.duration), 1);
    assert.ok(metadata.streams.some((stream: { codec_type: string; width: number }) => stream.codec_type === 'video' && stream.width === 32));
    assert.equal((await submit(noFrames, 'headers-only.mp4')).status, 415);

    const jpgPath = path.join(process.env.DATA_ROOT!, 'cover.jpg');
    const pngPath = path.join(process.env.DATA_ROOT!, 'image.png');
    const coverPath = path.join(process.env.DATA_ROOT!, 'audio-with-cover.mp4');
    await ffmpeg(['-i', mediaPath, '-frames:v', '1', '-threads', '1', jpgPath]);
    await ffmpeg(['-i', mediaPath, '-frames:v', '1', '-threads', '1', pngPath]);
    await ffmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-i', jpgPath, '-t', '1', '-map', '0:a', '-map', '1:v', '-c:a', 'aac', '-c:v', 'copy', '-disposition:v', 'attached_pic', coverPath]);
    assert.equal((await submit(await readFile(coverPath), 'cover-only.mp4')).status, 415);
    const png = await readFile(pngPath);
    const noImageData = png.subarray(0, png.indexOf(Buffer.from('IDAT')) + 4);
    assert.equal((await submit(noImageData, 'broken.png')).status, 415);
    const jpeg = await readFile(jpgPath);
    const noScanData = jpeg.subarray(0, jpeg.indexOf(Buffer.from([0xff, 0xda])) + 2);
    assert.equal((await submit(noScanData, 'broken.jpg')).status, 415);
    assert.equal(assets().length, 0);
    assert.deepEqual(await files(), []);
  } else if (scenario === 'duration' || scenario === 'duration-final-frame') {
    const frameCount = scenario === 'duration' ? 20 : 11;
    const longerPath = path.join(process.env.DATA_ROOT!, 'longer.mp4');
    await ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=32x32:r=10', '-frames:v', String(frameCount), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', longerPath]);
    const misreported = await readFile(longerPath);
    // Misstate movie/track durations without changing the actual sample times.
    for (const kind of ['mvhd', 'mdhd']) {
      const header = misreported.indexOf(Buffer.from(kind));
      assert.ok(header > 0);
      assert.equal(misreported[header + 4], 0);
      const timeScale = misreported.readUInt32BE(header + 16);
      misreported.writeUInt32BE(timeScale, header + 20);
    }
    const trackHeader = misreported.indexOf(Buffer.from('tkhd'));
    assert.ok(trackHeader > 0);
    misreported.writeUInt32BE(1000, trackHeader + 24);
    await writeFile(longerPath, misreported);
    const metadata = JSON.parse((await run('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
      '-show_entries', 'format=duration:stream=nb_read_frames', '-of', 'json', longerPath])).stdout);
    assert.equal(Number(metadata.format.duration), 1);
    assert.equal(Number(metadata.streams[0].nb_read_frames), frameCount, 'Understated headers must leave every encoded sample available to the decoder.');
    process.env.MAX_CLIP_SECONDS = '1';
    const response = await submit(misreported, 'misreported-duration.mp4');
    assert.equal(response.status, 400, JSON.stringify(await response.json()));
    assert.equal(assets().length, 0);
    assert.deepEqual(await files(), []);
  } else if (scenario === 'quota') {
    const quotaBytes = 500 * 1024 * 1024;
    store.insert('assets', { id: store.id(), projectId: project.id, name: 'Isolated quota metadata fixture', mime: 'video/mp4',
      byteLength: quotaBytes - validVideo.length, sha256: store.bytesHash('isolated fixture'), storageKey: 'never-read.fixture',
      durationMs: 1000, purpose: 'source', createdAt: store.now() });
    const responses = await Promise.all([submit(validVideo, 'first.mp4'), submit(validVideo, 'second.mp4')]);
    assert.deepEqual(responses.map(response => response.status).sort(), [201, 413]);
    assert.equal(assets().reduce((total, asset) => total + asset.byteLength, 0), quotaBytes);
    assert.equal(assets().length, 2);
    assert.equal((await files()).length, 1);
  } else if (scenario === 'rollback') {
    store.db.exec("CREATE TEMP TRIGGER reject_asset_audit BEFORE INSERT ON records WHEN NEW.collection='audit' AND json_extract(NEW.json,'$.event')='asset_uploaded' BEGIN SELECT RAISE(ABORT,'isolated audit failure'); END;");
    const response = await submit(validVideo);
    assert.equal(response.status, 500);
    assert.equal(assets().length, 0);
    assert.deepEqual(await files(), []);
  } else {
    assert.fail('Unknown HTTP media regression scenario.');
  }
  console.log(`HTTP media regression passed: ${scenario}`);
} finally {
  store.db.close();
  delete (globalThis as { countershotDb?: unknown }).countershotDb;
}
