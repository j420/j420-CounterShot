import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

// No application module may open storage before this subprocess isolation check.
assert.ok(process.env.DATA_ROOT?.startsWith(path.join(os.tmpdir(), 'countershot-direct-test-')));
assert.ok(realpathSync(process.env.DATA_ROOT!).startsWith(realpathSync(os.tmpdir()) + path.sep));
assert.equal(process.env.DATABASE_PATH, path.join(process.env.DATA_ROOT!, 'test.sqlite'));
assert.equal(process.env.ASSET_ROOT, path.join(process.env.DATA_ROOT!, 'assets'));
process.env.MODEL_API_KEY = '';
process.env.APP_ACCESS_CODE = 'isolated-direct-access';
delete process.env.MAX_CLIP_BYTES;
delete process.env.MAX_CLIP_SECONDS;
const frontend = 'https://frontend.example';
const backend = 'https://backend.example';
process.env.PUBLIC_API_ORIGIN = backend;
process.env.APP_PUBLIC_ORIGIN = frontend;

const { POST: mintIntent } = await import('../../app/api/projects/[id]/upload-intents/route');
const { POST: upload, OPTIONS: preflight } = await import('../../app/api/projects/[id]/uploads/route');
const { GET: download } = await import('../../app/api/projects/[id]/assets/[assetId]/route');
const { createProject } = await import('../../src/server/projects');
const store = await import('../../src/storage/db');
const run = promisify(execFile);
const root = process.env.DATA_ROOT!;
const scenario = process.argv[2];
const session = 'direct-upload-fixture-owner';
const accessCookie = `countershot_access=${store.bytesHash('isolated-direct-access')}`;
const ownerCookie = `countershot_session=${session}; ${accessCookie}`;
const makeProject = () => createProject({ title: 'Direct upload fixture', workflow: 'workshop_jig',
  goal: 'Check direct uploads against an isolated persistent backend', finishedDefinition: 'One scoped private evidence upload' }, session);
const project = makeProject(), otherProject = makeProject();
type NextRequestInit = NonNullable<ConstructorParameters<typeof NextRequest>[1]> & { duplex?: 'half' };
type Ticket = { url: string; token: string; expiresAt: string };
type IntentRecord = { id: string; projectId: string; purpose: 'source' | 'trial'; expiresAt: string; usedAt: string | null; tokenHash?: string };
type UploadedAsset = { id: string; projectId: string; mime: string; purpose: string; sha256: string; storageKey: string;
  original?: { name: string; mime: string; sha256: string; byteLength: number; storageKey: string } };
const context = (projectId = project.id) => ({ params: Promise.resolve({ id: projectId }) });
const intentRecords = () => store.list<IntentRecord>('upload_intents');
const recordFor = (token: string) => intentRecords().find(record => JSON.stringify(record).includes(store.bytesHash(token)))!;
const mintRequest = (body: unknown = { purpose: 'source' }, options: { cookie?: string; origin?: string | null; projectId?: string } = {}) =>
  new NextRequest(`${backend}/api/projects/${options.projectId || project.id}/upload-intents`, { method: 'POST',
    headers: { host: 'backend.example', 'content-type': 'application/json', cookie: options.cookie ?? ownerCookie,
      ...(options.origin === null ? {} : { origin: options.origin ?? frontend }) }, body: JSON.stringify(body) });
const mintResponse = (body?: unknown, options?: { cookie?: string; origin?: string | null; projectId?: string }) =>
  mintIntent(mintRequest(body, options), context(options?.projectId));
async function mint(purpose: 'source' | 'trial' = 'source'): Promise<Ticket> {
  const before = Date.now(), response = await mintResponse({ purpose });
  const output = await response.json();
  assert.equal(response.status, 200, JSON.stringify(output));
  assert.equal(output.upload.url, `${backend}/api/projects/${project.id}/uploads`);
  assert.match(output.upload.token, /^[a-f0-9]{64}$/i);
  assert.ok(Date.parse(output.upload.expiresAt) >= before + 299_000);
  assert.ok(Date.parse(output.upload.expiresAt) <= Date.now() + 301_000);
  return output.upload;
}
function directRequest(ticket: Ticket | null, body: BodyInit | null = null, options: { origin?: string | null; projectId?: string; headers?: Record<string, string> } = {}) {
  return new NextRequest(`${backend}/api/projects/${options.projectId || project.id}/uploads`, { method: 'POST', body, duplex: 'half',
    headers: { ...(ticket ? { authorization: `Bearer ${ticket.token}` } : {}),
      ...(options.origin === null ? {} : { origin: options.origin ?? frontend }), ...options.headers },
  } as NextRequestInit);
}
const direct = (ticket: Ticket | null, body?: BodyInit | null, options?: { origin?: string | null; projectId?: string; headers?: Record<string, string> }) =>
  upload(directRequest(ticket, body, options), context(options?.projectId));
function unreadBody() {
  let reads = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) { reads++; controller.enqueue(new Uint8Array(32)); } }, { highWaterMark: 0 });
  return { body, reads: () => reads };
}
async function rejectsWithoutRead(ticket: Ticket | null, expected: number | number[], options: { origin?: string | null; projectId?: string; headers?: Record<string, string> } = {}) {
  const stream = unreadBody(), response = await direct(ticket, stream.body, options);
  assert.ok((Array.isArray(expected) ? expected : [expected]).includes(response.status), `Unexpected direct response ${response.status}`);
  assert.equal(stream.reads(), 0, 'Rejected requests cannot read the upload body.');
  return response;
}
function checkCors(response: Response) {
  assert.equal(response.headers.get('access-control-allow-origin'), frontend);
  assert.ok(response.headers.get('vary')?.toLowerCase().split(',').map(value => value.trim()).includes('origin'));
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
}
const ffmpeg = (args: string[]) => run('ffmpeg', ['-v', 'error', '-nostdin', '-filter_threads', '1', ...args], { timeout: 20_000, maxBuffer: 1_000_000 });
async function png() {
  const file = path.join(root, 'fixture.png');
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=32x32', '-frames:v', '1', '-threads', '1', file]);
  return readFile(file);
}
function form(bytes: Uint8Array, name = 'fixture.png', purpose?: string) {
  const value = new FormData(); value.set('file', new File([new Uint8Array(bytes)], name));
  if (purpose !== undefined) value.set('purpose', purpose);
  return value;
}
async function assetResponse(response: Response): Promise<UploadedAsset> {
  const output = await response.json();
  assert.equal(response.status, 201, JSON.stringify(output)); checkCors(response);
  return output.asset;
}
async function streamedForm(bytes: Uint8Array) {
  const encoded = new Response(form(bytes));
  const body = new Uint8Array(await encoded.arrayBuffer());
  let reads = 0, sent = false;
  return { contentType: encoded.headers.get('content-type')!, reads: () => reads,
    body: new ReadableStream<Uint8Array>({ pull(controller) { reads++; if (sent) { controller.close(); return; } sent = true; controller.enqueue(body); } }, { highWaterMark: 0 }) };
}

try {
  if (scenario === 'configuration') {
    delete process.env.PUBLIC_API_ORIGIN; delete process.env.APP_PUBLIC_ORIGIN;
    const local = await mintResponse({ purpose: 'source' }, { origin: null });
    assert.equal(local.status, 200); assert.deepEqual(await local.json(), { upload: null });
    await rejectsWithoutRead(null, 503);
    assert.equal((await preflight(new NextRequest(`${backend}/api/projects/${project.id}/uploads`, { method: 'OPTIONS', headers: { origin: frontend } }))).status, 503);
    for (const [api, app] of [[backend, ''], ['', frontend], ['http://backend.example', frontend], [backend + '/path', frontend],
      [backend + '?query=1', frontend], [backend + '#fragment', frontend], ['https://user:password@backend.example', frontend],
      [backend, 'http://frontend.example'], [backend, frontend + '/path'], [backend, backend]]) {
      process.env.PUBLIC_API_ORIGIN = api; process.env.APP_PUBLIC_ORIGIN = app;
      const response = await mintResponse({ purpose: 'source' }, { origin: null });
      assert.equal(response.status, 503, JSON.stringify({ api, app, response: await response.json() }));
      await rejectsWithoutRead(null, 503);
    }
    process.env.PUBLIC_API_ORIGIN = backend + '/'; process.env.APP_PUBLIC_ORIGIN = frontend + '/';
    await mint();
  } else if (scenario === 'mint-access') {
    for (const cookie of ['', `countershot_session=${session}`]) assert.equal((await mintResponse({ purpose: 'source' }, { cookie })).status, 401);
    assert.equal((await mintResponse({ purpose: 'source' }, { cookie: `countershot_session=stranger; ${accessCookie}` })).status, 404);
    for (const origin of ['https://evil.example', 'http://frontend.example', 'null'])
      assert.equal((await mintResponse({ purpose: 'source' }, { origin })).status, 403);
    const spoofed = new NextRequest(`${backend}/api/projects/${project.id}/upload-intents`, { method: 'POST',
      headers: { host: 'backend.example', 'x-forwarded-host': 'evil.example', origin: 'https://evil.example',
        cookie: ownerCookie, 'content-type': 'application/json' }, body: JSON.stringify({ purpose: 'source' }) });
    assert.equal((await mintIntent(spoofed, context())).status, 403);
    assert.equal((await mintResponse({ purpose: 'source' }, { origin: 'http://backend.example' })).status, 403);
    assert.equal((await mintResponse({ purpose: 'source' }, { origin: backend })).status, 200);
    assert.equal((await mintResponse({ purpose: 'source' }, { origin: null })).status, 200);
    for (const body of [{ purpose: 'other' }, {}, { purpose: null }]) assert.equal((await mintResponse(body)).status, 400);
    const ticket = await mint('trial'), record = recordFor(ticket.token);
    assert.equal(record.projectId, project.id); assert.equal(record.purpose, 'trial'); assert.equal(record.usedAt, null);
    const stored = JSON.stringify(intentRecords());
    assert.equal(stored.includes(ticket.token), false); assert.equal(stored.includes(store.bytesHash(ticket.token)), true);
  } else if (scenario === 'lifecycle') {
    const ticket = await mint('source');
    for (const origin of ['https://evil.example', 'http://frontend.example', 'null', null]) await rejectsWithoutRead(ticket, 403, { origin });
    assert.equal(recordFor(ticket.token).usedAt, null);
    await rejectsWithoutRead({ ...ticket, token: 'a'.repeat(64) }, 401);
    await rejectsWithoutRead(null, 401);
    await rejectsWithoutRead(ticket, 401, { projectId: otherProject.id });
    await rejectsWithoutRead(ticket, [401, 404], { projectId: randomUUID() });
    assert.equal(recordFor(ticket.token).usedAt, null);
    const asset = await assetResponse(await direct(ticket, form(await png())));
    assert.equal(asset.projectId, project.id); assert.equal(asset.purpose, 'source');
    assert.ok(Date.parse(recordFor(ticket.token).usedAt!));
    checkCors(await rejectsWithoutRead(ticket, 401));
    assert.equal(store.list('assets', project.id).length, 1);
    assert.equal(store.list('assets', otherProject.id).length, 0);
  } else if (scenario === 'expiry-purpose') {
    const expired = await mint(), record = recordFor(expired.token);
    store.replace('upload_intents', { ...record, expiresAt: '2000-01-01T00:00:00.000Z' });
    await rejectsWithoutRead(expired, 401);
    const mismatched = await mint('source');
    assert.equal(store.get('upload_intents', record.id), null, 'Minting purges expired ticket records.');
    const mismatch = await direct(mismatched, form(new Uint8Array([1]), 'irrelevant.bin', 'trial'));
    assert.equal(mismatch.status, 400); checkCors(mismatch);
    assert.ok(recordFor(mismatched.token).usedAt);
    await rejectsWithoutRead(mismatched, 401);
    const invalid = await mint('trial');
    assert.equal((await direct(invalid, form(new Uint8Array([1]), 'irrelevant.bin', 'other'))).status, 400);
    await rejectsWithoutRead(invalid, 401);
    process.env.MAX_CLIP_BYTES = '1024';
    const oversized = await mint('trial');
    let reads = 0, cancelled = false;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { reads++; controller.enqueue(new Uint8Array(32 * 1024)); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
    const overrun = await direct(oversized, body, { headers: { 'content-type': 'multipart/form-data; boundary=fixture' } });
    assert.equal(overrun.status, 413); checkCors(overrun); assert.equal(reads, 4); assert.equal(cancelled, true);
    await rejectsWithoutRead(oversized, 401); assert.equal(store.list('assets', project.id).length, 0);
  } else if (scenario === 'cors') {
    const options = (origin: string | null, method = 'POST', headers = 'Authorization, Content-Type') => preflight(new NextRequest(`${backend}/api/projects/${project.id}/uploads`, {
      method: 'OPTIONS', headers: { ...(origin === null ? {} : { origin }), 'access-control-request-method': method, 'access-control-request-headers': headers },
    }));
    const response = await options(frontend); assert.ok([200, 204].includes(response.status)); checkCors(response);
    assert.equal(response.headers.get('access-control-allow-methods')?.toUpperCase(), 'POST');
    const allowed = response.headers.get('access-control-allow-headers')!.toLowerCase().split(',').map(value => value.trim()).sort();
    assert.deepEqual(allowed, ['authorization', 'content-type']);
    for (const origin of ['https://evil.example', 'http://frontend.example', 'null', null]) {
      const denied = await options(origin); assert.equal(denied.status, 403); assert.equal(denied.headers.get('access-control-allow-origin'), null);
    }
    for (const method of ['GET', 'PUT', 'DELETE']) assert.equal((await options(frontend, method)).status, 403);
    assert.equal((await options(frontend, 'POST', 'Authorization, X-Other')).status, 403);
    assert.equal(intentRecords().length, 0);
  } else if (scenario === 'race') {
    const ticket = await mint(), bytes = await png();
    const requests = await Promise.all([streamedForm(bytes), streamedForm(bytes)]);
    const responses = await Promise.all(requests.map(request => direct(ticket, request.body, { headers: { 'content-type': request.contentType } })));
    assert.deepEqual(responses.map(response => response.status).sort(), [201, 401]);
    for (let index = 0; index < responses.length; index++) {
      checkCors(responses[index]);
      if (responses[index].status === 401) assert.equal(requests[index].reads(), 0);
      else assert.ok(requests[index].reads() > 0);
    }
    assert.equal(store.list('assets', project.id).length, 1);
  } else if (scenario === 'media') {
    const inputs = ['-f', 'lavfi', '-i', 'testsrc2=size=64x48:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-t', '1'];
    for (const [extension, mime, purpose, codec] of [['mov', 'video/quicktime', 'source', 'mov'], ['webm', 'video/webm', 'trial', 'webm']] as const) {
      const file = path.join(root, `fixture.${extension}`);
      await ffmpeg([...inputs, ...(codec === 'mov' ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv422p', '-c:a', 'pcm_s16le']
        : ['-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '100k', '-c:a', 'libopus']), '-threads', '1', file]);
      const bytes = await readFile(file), ticket = await mint(purpose);
      const asset = await assetResponse(await direct(ticket, form(bytes, `phone.${extension}`)));
      assert.equal(asset.projectId, project.id); assert.equal(asset.purpose, purpose); assert.equal(asset.mime, 'video/mp4');
      assert.equal(asset.original?.mime, mime); assert.equal(asset.original?.sha256, store.bytesHash(bytes)); assert.equal(asset.original?.byteLength, bytes.length);
      for (const original of [false, true]) {
        const url = `${backend}/api/projects/${project.id}/assets/${asset.id}${original ? '?original=1' : ''}`;
        const ctx = { params: Promise.resolve({ id: project.id, assetId: asset.id }) };
        const response = await download(new NextRequest(url, { headers: { cookie: ownerCookie } }), ctx);
        assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store');
        const content = Buffer.from(await response.arrayBuffer());
        assert.equal(store.bytesHash(content), original ? store.bytesHash(bytes) : asset.sha256);
        if (original) { assert.equal(response.headers.get('content-type'), mime); assert.match(response.headers.get('content-disposition') || '', /^attachment;/); assert.deepEqual(content, bytes); }
        else assert.equal(response.headers.get('content-type'), 'video/mp4');
        assert.equal((await download(new NextRequest(url, { headers: { authorization: `Bearer ${ticket.token}` } }), ctx)).status, 401);
        assert.equal((await download(new NextRequest(url, { headers: { cookie: `countershot_session=stranger; ${accessCookie}` } }), ctx)).status, 404);
      }
      await rejectsWithoutRead(ticket, 401);
    }
    assert.equal(store.list('assets', project.id).length, 2);
  } else assert.fail('Unknown direct-upload regression scenario.');
  console.log(`Direct upload regression passed: ${scenario}`);
} finally {
  store.db.close(); delete (globalThis as { countershotDb?: unknown }).countershotDb;
}
