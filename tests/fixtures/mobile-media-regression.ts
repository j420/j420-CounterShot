import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { NextRequest } from 'next/server';

// Storage opens during source-module evaluation. Only a fresh subprocess DB is allowed.
assert.ok(process.env.DATA_ROOT?.startsWith(path.join(os.tmpdir(), 'countershot-mobile-test-')));
assert.ok(realpathSync(process.env.DATA_ROOT!).startsWith(realpathSync(os.tmpdir()) + path.sep));
assert.equal(process.env.DATABASE_PATH, path.join(process.env.DATA_ROOT!, 'test.sqlite'));
assert.equal(process.env.ASSET_ROOT, path.join(process.env.DATA_ROOT!, 'assets'));
process.env.MODEL_API_KEY = '';
delete process.env.APP_ACCESS_CODE;
delete process.env.MAX_CLIP_BYTES;
delete process.env.MAX_CLIP_SECONDS;

const { POST: upload } = await import('../../app/api/projects/[id]/assets/route');
const { GET: download } = await import('../../app/api/projects/[id]/assets/[assetId]/route');
const { createProject } = await import('../../src/server/projects');
const store = await import('../../src/storage/db');
const run = promisify(execFile);
const root = process.env.DATA_ROOT!;
const scenario = process.argv[2];
const session = 'isolated-mobile-regression-session';
const makeProject = () => createProject({ title: 'Mobile media fixture', workflow: 'workshop_jig',
  goal: 'Check mobile video normalization using generated offline media', finishedDefinition: 'Complete private original and compatible derivative' }, session);
const project = makeProject();
const ffmpeg = (args: string[]) => run('ffmpeg', ['-v', 'error', '-nostdin', '-filter_threads', '1', ...args], { timeout: 30_000, maxBuffer: 1_000_000 });
type Stream = { codec_type: string; codec_name: string; pix_fmt?: string; width?: number; height?: number; nb_read_frames?: string; duration?: string; side_data_list?: { rotation?: number }[] };
type Probe = { streams: Stream[]; format: { duration: string } };
type FixtureAsset = { id: string; projectId: string; name: string; mime: string; storageKey: string; byteLength: number; sha256: string; durationMs: number; purpose: 'source' | 'trial';
  original?: { name: string; mime: string; byteLength: number; sha256: string; storageKey: string; durationMs: number };
  normalization?: { version: string; method: string; sourceDurationMs: number; durationMs: number; videoCodec: string; pixelFormat: string; audioCodec: string | null; rotationAppliedDegrees?: number } };
const probe = async (file: string): Promise<Probe> => JSON.parse((await run('ffprobe', ['-v', 'error', '-count_frames', '-show_entries',
  'format=duration:stream=codec_type,codec_name,pix_fmt,width,height,duration,nb_read_frames:stream_side_data=rotation', '-of', 'json', file], { timeout: 15_000 })).stdout);
const frameTimes = async (file: string): Promise<number[]> => {
  const output = JSON.parse((await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', file], { timeout: 15_000 })).stdout);
  return output.frames.map((frame: { best_effort_timestamp_time: string }) => Number(frame.best_effort_timestamp_time));
};
const inputs = ['-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=20', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-t', '1.5'];
const generateMov = async (name = 'phone.mov', variableTiming = false) => {
  const file = path.join(root, name);
  await ffmpeg([...inputs, ...(variableTiming ? ['-vf', "select='if(lt(n,10),not(mod(n,2)),1)'", '-fps_mode', 'vfr'] : []),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv422p', '-c:a', 'pcm_s16le', '-threads', '1', file]);
  return file;
};
const generateWebm = async () => {
  const file = path.join(root, 'browser.webm');
  await ffmpeg([...inputs, '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '100k', '-c:a', 'libopus', '-threads', '1', file]);
  return file;
};
const generateMp4 = async () => {
  const file = path.join(root, 'compatible.mp4');
  await ffmpeg([...inputs, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', '-threads', '1', file]);
  return file;
};
const submit = async (bytes: Uint8Array, name: string, purpose: 'source' | 'trial' = 'source', projectId = project.id) => {
  const form = new FormData();
  // Content sniffing must work independently of unreliable phone/browser MIME labels.
  form.set('file', new File([new Uint8Array(bytes)], name, { type: 'application/octet-stream' }));
  form.set('purpose', purpose);
  return upload(new NextRequest(`http://localhost/api/projects/${projectId}/assets`, { method: 'POST',
    headers: { cookie: `countershot_session=${session}` }, body: form }), { params: Promise.resolve({ id: projectId }) });
};
const successful = async (response: Response): Promise<FixtureAsset> => {
  const output = await response.json();
  assert.equal(response.status, 201, JSON.stringify(output));
  return output.asset;
};
const files = async () => (await readdir(store.assetRoot)).sort();
const assets = (projectId = project.id) => store.list<FixtureAsset>('assets', projectId);
const retrieval = (asset: FixtureAsset, original = false, requestSession: string | null = session, projectId = asset.projectId, headers: Record<string, string> = {}) => download(
  new NextRequest(`http://localhost/api/projects/${projectId}/assets/${asset.id}${original ? '?original=1' : ''}`, {
    headers: { ...headers, ...(requestSession === null ? {} : { cookie: `countershot_session=${requestSession}` }) },
  }), { params: Promise.resolve({ id: projectId, assetId: asset.id }) });
async function checkRanges(asset: FixtureAsset) {
  const otherProject = makeProject();
  for (const original of [false, true]) {
    const descriptor = original && asset.original ? asset.original : asset;
    const bytes = await readFile(path.join(store.assetRoot, descriptor.storageKey));
    for (const [range, start, end] of [['bytes=0-99', 0, 99], ['bytes=0-', 0, bytes.length - 1], ['bytes=-100', bytes.length - 100, bytes.length - 1]] as const) {
      const response = await retrieval(asset, original, session, asset.projectId, { Range: range });
      assert.equal(response.status, 206);
      assert.equal(response.headers.get('accept-ranges'), 'bytes');
      assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${bytes.length}`);
      assert.equal(response.headers.get('content-length'), String(end - start + 1));
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(start, end + 1));
    }
    for (const range of ['bytes=', 'bytes=5-2', 'bytes=0-1,3-4', 'items=0-1', `bytes=${bytes.length}-`]) {
      const response = await retrieval(asset, original, session, asset.projectId, { Range: range });
      assert.equal(response.status, 416, range);
      assert.equal(response.headers.get('content-range'), `bytes */${bytes.length}`);
    }
    assert.equal((await retrieval(asset, original, null, asset.projectId, { Range: 'bytes=0-99' })).status, 404);
    assert.equal((await retrieval(asset, original, 'stranger', asset.projectId, { Range: 'bytes=0-99' })).status, 404);
    assert.equal((await retrieval(asset, original, session, otherProject.id, { Range: 'bytes=0-99' })).status, 404);
    process.env.APP_ACCESS_CODE = 'isolated-mobile-access-code';
    try {
      assert.equal((await retrieval(asset, original, session, asset.projectId, { Range: 'bytes=0-99' })).status, 401);
    } finally { delete process.env.APP_ACCESS_CODE; }
  }
}
async function checkNormalized(asset: FixtureAsset, source: string, originalName: string, originalMime: string, audio = true) {
  const originalBytes = await readFile(source);
  assert.equal(asset.mime, 'video/mp4');
  assert.ok(asset.storageKey.endsWith('.mp4'));
  assert.equal(asset.original?.name, originalName);
  assert.equal(asset.original?.mime, originalMime);
  assert.equal(asset.original?.byteLength, originalBytes.length);
  assert.equal(asset.original?.sha256, store.bytesHash(originalBytes));
  assert.notEqual(asset.original?.storageKey, asset.storageKey);
  assert.equal(asset.normalization?.version, 'phone-mp4-v1');
  assert.equal(asset.normalization?.method, 'transcoded');
  assert.equal(asset.normalization?.videoCodec, 'h264');
  assert.equal(asset.normalization?.pixelFormat, 'yuv420p');
  assert.equal(asset.normalization?.audioCodec, audio ? 'aac' : null);
  assert.equal(asset.normalization?.durationMs, asset.durationMs);
  const stored = path.join(store.assetRoot, asset.storageKey);
  const derivativeBytes = await readFile(stored);
  assert.equal(asset.byteLength, derivativeBytes.length);
  assert.equal(asset.sha256, store.bytesHash(derivativeBytes));
  const inputInfo = await probe(source), outputInfo = await probe(stored);
  const inputVideo = inputInfo.streams.find(stream => stream.codec_type === 'video')!;
  const outputVideo = outputInfo.streams.find(stream => stream.codec_type === 'video')!;
  assert.equal(outputVideo.codec_name, 'h264');
  assert.equal(outputVideo.pix_fmt, 'yuv420p');
  assert.equal(Number(outputVideo.nb_read_frames), Number(inputVideo.nb_read_frames), 'Every source frame must be retained.');
  assert.ok(Math.abs(Number(outputInfo.format.duration) - Number(inputInfo.format.duration)) < 0.15, 'The complete clip duration must be retained.');
  assert.ok(Math.abs(asset.normalization!.sourceDurationMs - Number(inputInfo.format.duration) * 1000) < 150);
  if (audio) {
    const outputAudio = outputInfo.streams.find(stream => stream.codec_type === 'audio');
    assert.equal(outputAudio?.codec_name, 'aac');
    assert.ok(Number(outputAudio?.duration) >= 1.4, 'Audio cannot be dropped or shortened to a single packet.');
  }
  const playback = await retrieval(asset);
  assert.equal(playback.status, 200);
  assert.equal(playback.headers.get('content-type'), 'video/mp4');
  assert.deepEqual(Buffer.from(await playback.arrayBuffer()), derivativeBytes);
  const original = await retrieval(asset, true);
  assert.equal(original.status, 200);
  assert.equal(original.headers.get('content-type'), originalMime);
  assert.match(original.headers.get('content-disposition') || '', /^attachment;/);
  assert.equal(original.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), originalBytes);
  for (const originalRequest of [false, true]) {
    assert.equal((await retrieval(asset, originalRequest, null)).status, 404);
    assert.equal((await retrieval(asset, originalRequest, 'a-stranger-session')).status, 404);
  }
}

try {
  if (scenario === 'formats') {
    for (const [source, name, mime] of [[await generateMov(), 'phone.MOV', 'video/quicktime'], [await generateWebm(), 'browser.webm', 'video/webm']]) {
      for (const purpose of ['source', 'trial'] as const) {
        const asset = await successful(await submit(await readFile(source), name, purpose));
        assert.equal(asset.purpose, purpose);
        await checkNormalized(asset, source, name, mime);
        if (name === 'phone.MOV' && purpose === 'source') await checkRanges(asset);
      }
    }
    assert.equal(assets().length, 4);
    assert.equal((await files()).length, 8);
    // The stored filename limit can bisect an emoji's UTF-16 surrogate pair.
    // Legacy/truncated metadata must still produce a valid attachment header.
    const unicodeAsset = await successful(await submit(await readFile(path.join(root, 'phone.mov')), 'x'.repeat(179) + '😀.mov'));
    const unicodeOriginal = await retrieval(unicodeAsset, true);
    assert.equal(unicodeOriginal.status, 200);
    assert.match(unicodeOriginal.headers.get('content-disposition') || '', /^attachment;/);
    assert.deepEqual(Buffer.from(await unicodeOriginal.arrayBuffer()), await readFile(path.join(root, 'phone.mov')));
  } else if (scenario === 'passthrough') {
    const source = await generateMp4(), bytes = await readFile(source);
    const asset = await successful(await submit(bytes, 'compatible.mp4', 'trial'));
    assert.equal(asset.mime, 'video/mp4');
    assert.equal(asset.original, undefined);
    assert.equal(asset.byteLength, bytes.length);
    assert.equal(asset.sha256, store.bytesHash(bytes));
    assert.deepEqual(await readFile(path.join(store.assetRoot, asset.storageKey)), bytes);
    for (const original of [false, true]) {
      const response = await retrieval(asset, original);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'video/mp4');
      if (original) assert.match(response.headers.get('content-disposition') || '', /^attachment;/);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    }
    assert.equal((await files()).length, 1);
    await checkRanges(asset);
  } else if (scenario === 'rotation-codec') {
    const base = await generateMp4(), rotated = path.join(root, 'rotated.mp4');
    // FFmpeg 5 sets the display matrix through metadata; newer releases expose an input option.
    // Both paths must produce the same independently checked 90-degree source below.
    const help = (await run('ffmpeg', ['-hide_banner', '-h', 'full'], { timeout: 15_000, maxBuffer: 4_000_000 })).stdout;
    const rotationArgs = help.includes('-display_rotation')
      ? ['-display_rotation:v:0', '90', '-i', base, '-c', 'copy']
      : ['-i', base, '-c', 'copy', '-metadata:s:v:0', 'rotate=90'];
    await ffmpeg([...rotationArgs, rotated]);
    assert.equal((await probe(rotated)).streams[0].side_data_list?.[0].rotation, 90);
    const asset = await successful(await submit(await readFile(rotated), 'portrait-phone.mp4', 'trial'));
    await checkNormalized(asset, rotated, 'portrait-phone.mp4', 'video/mp4');
    const video = (await probe(path.join(store.assetRoot, asset.storageKey))).streams.find(stream => stream.codec_type === 'video')!;
    assert.equal(video.width, 64);
    assert.equal(video.height, 96);
    assert.ok(!video.side_data_list?.some(data => data.rotation && data.rotation % 360 !== 0));
    assert.equal(Math.abs(asset.normalization!.rotationAppliedDegrees || 0), 90);
    const encoders = (await run('ffmpeg', ['-v', 'error', '-encoders'])).stdout;
    if (encoders.includes('libx265')) {
      const hevc = path.join(root, 'phone-hevc.mp4');
      await ffmpeg(['-i', base, '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'pools=none:frame-threads=1:log-level=error',
        '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', '-c:a', 'copy', '-threads', '1', hevc]);
      assert.equal((await probe(hevc)).streams[0].codec_name, 'hevc');
      const hevcAsset = await successful(await submit(await readFile(hevc), 'phone-hevc.mp4'));
      await checkNormalized(hevcAsset, hevc, 'phone-hevc.mp4', 'video/mp4');
    }
  } else if (scenario === 'timing') {
    const source = await generateMov('variable.mov', true);
    const inputTimes = await frameTimes(source);
    assert.equal(inputTimes.length, 25);
    assert.equal(inputTimes[0], 0);
    assert.ok(inputTimes.some((time, index) => index > 0 && time - inputTimes[index - 1] > 0.09));
    const asset = await successful(await submit(await readFile(source), 'variable.mov'));
    await checkNormalized(asset, source, 'variable.mov', 'video/quicktime');
    const outputTimes = await frameTimes(path.join(store.assetRoot, asset.storageKey));
    assert.equal(outputTimes.length, inputTimes.length);
    assert.ok(Math.abs(outputTimes[0] - inputTimes[0]) < 0.05,
      'Normalization cannot add a long lead-in to a video that starts at zero; brief AAC priming is allowed.');
    for (let index = 0; index < inputTimes.length; index++)
      assert.ok(Math.abs((outputTimes[index] - outputTimes[0]) - (inputTimes[index] - inputTimes[0])) < 0.02, 'Variable frame timestamps must be preserved.');
  } else if (scenario === 'quota') {
    const source = await generateMov(), bytes = await readFile(source);
    const reference = await successful(await submit(bytes, 'reference.mov'));
    const before = await files(), quota = 500 * 1024 * 1024;
    const fullIncomingSize = reference.byteLength + reference.original!.byteLength;
    const remaining = Math.max(reference.byteLength, bytes.length) + 1;
    assert.ok(fullIncomingSize > remaining);
    const incomingProject = makeProject();
    store.insert('assets', { id: store.id(), projectId: incomingProject.id, name: 'Quota metadata only', mime: 'video/mp4',
      byteLength: quota - remaining, sha256: 'isolated-fixture', storageKey: 'never-read.fixture', durationMs: 1500, purpose: 'source', createdAt: store.now() });
    assert.equal((await submit(bytes, 'over-quota.mov', 'trial', incomingProject.id)).status, 413);
    assert.equal(assets(incomingProject.id).length, 1);
    assert.deepEqual(await files(), before);
    const compatible = await readFile(await generateMp4());
    const existingOriginalProject = makeProject();
    store.insert('assets', { id: store.id(), projectId: existingOriginalProject.id, name: 'Existing original quota metadata', mime: 'video/mp4',
      byteLength: 1, sha256: 'isolated-fixture', storageKey: 'never-read.fixture', durationMs: 1500, purpose: 'source', createdAt: store.now(),
      original: { name: 'original.mov', mime: 'video/quicktime', byteLength: quota - compatible.length + 1, sha256: 'isolated-original', storageKey: 'never-read-original.fixture', durationMs: 1500 } });
    assert.equal((await submit(compatible, 'next.mp4', 'source', existingOriginalProject.id)).status, 413);
    assert.equal(assets(existingOriginalProject.id).length, 1);
    assert.deepEqual(await files(), before);
  } else if (scenario === 'bounds') {
    const tiny = path.join(root, 'tiny.webm');
    await ffmpeg(['-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=10', '-t', '1', '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '20k', '-an', '-threads', '1', tiny]);
    const bytes = await readFile(tiny);
    const reference = await successful(await submit(bytes, 'tiny.webm'));
    assert.ok(reference.byteLength > bytes.length, 'This fixture must expand during MP4 normalization.');
    const before = await files(), cappedProject = makeProject();
    process.env.MAX_CLIP_BYTES = String(bytes.length);
    assert.equal((await submit(bytes, 'capped.webm', 'trial', cappedProject.id)).status, 413);
    assert.equal(assets(cappedProject.id).length, 0);
    assert.deepEqual(await files(), before);
    delete process.env.MAX_CLIP_BYTES;
    process.env.MAX_CLIP_SECONDS = '1';
    const overlong = await generateMov('overlong.mov');
    assert.equal((await submit(await readFile(overlong), 'overlong.mov', 'source', cappedProject.id)).status, 400);
    assert.equal(assets(cappedProject.id).length, 0);
    assert.deepEqual(await files(), before);
  } else if (scenario === 'rollback') {
    const source = await generateMov();
    store.db.exec("CREATE TEMP TRIGGER reject_mobile_audit BEFORE INSERT ON records WHEN NEW.collection='audit' AND json_extract(NEW.json,'$.event')='asset_uploaded' BEGIN SELECT RAISE(ABORT,'isolated mobile audit failure'); END;");
    assert.equal((await submit(await readFile(source), 'rollback.mov', 'trial')).status, 500);
    assert.equal(assets().length, 0);
    assert.deepEqual(await files(), []);
  } else assert.fail('Unknown mobile media regression scenario.');
  console.log(`Mobile media regression passed: ${scenario}`);
} finally {
  store.db.close();
  delete (globalThis as { countershotDb?: unknown }).countershotDb;
}
