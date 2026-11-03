import assert from 'node:assert/strict';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

// Storage opens during module evaluation, so validate isolation before importing it.
const isWithin = (parent: string, child: string) => {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
assert.ok(process.env.DATA_ROOT && process.env.DATABASE_PATH, 'The fixture requires isolated storage paths.');
const temporaryRoot = realpathSync(os.tmpdir());
const dataRoot = realpathSync(path.resolve(process.env.DATA_ROOT));
const databasePath = path.resolve(process.env.DATABASE_PATH);
assert.ok(isWithin(temporaryRoot, dataRoot), 'DATA_ROOT must be a dedicated temporary directory.');
assert.ok(isWithin(dataRoot, databasePath), 'DATABASE_PATH must remain inside DATA_ROOT.');
const databaseDirectory = realpathSync(path.dirname(databasePath));
assert.ok(databaseDirectory === dataRoot || isWithin(dataRoot, databaseDirectory), 'Database directory must remain inside DATA_ROOT.');
try {
  assert.equal(lstatSync(databasePath).isSymbolicLink(), false, 'The fixture database cannot be a symbolic link.');
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}
if (existsSync(databasePath)) assert.ok(isWithin(dataRoot, realpathSync(databasePath)));
process.env.ASSET_ROOT = path.join(dataRoot, 'assets');
if (existsSync(process.env.ASSET_ROOT)) assert.ok(isWithin(dataRoot, realpathSync(process.env.ASSET_ROOT)));

const { readBody, jsonBody, HttpError } = await import('../../src/server/http');
const { POST: login } = await import('../../app/api/session/route');
const { POST: upload } = await import('../../app/api/projects/[id]/assets/route');
const { createProject } = await import('../../src/server/projects');
const store = await import('../../src/storage/db');

type NextRequestInit = NonNullable<ConstructorParameters<typeof NextRequest>[1]> & { duplex: 'half' };
const request = (body: BodyInit | null, headers: Record<string, string> = {}) => new NextRequest('http://localhost/api/session', {
  method: 'POST', body, headers, duplex: 'half',
} as NextRequestInit);
const rejectsStatus = (promise: Promise<unknown>, status: number) => assert.rejects(promise,
  (error: unknown) => error instanceof HttpError && error.status === status);

try {
  assert.deepEqual(await jsonBody(request('{"ok":true}')), { ok: true });
  const boundary = '"' + 'x'.repeat(199_998) + '"';
  assert.equal((await jsonBody(request(boundary))).length, 199_998);
  await rejectsStatus(jsonBody(request('"' + 'x'.repeat(199_999) + '"')), 413);
  await rejectsStatus(jsonBody(request(JSON.stringify('€'.repeat(70_000)))), 413);
  await rejectsStatus(jsonBody(request('{')), 400);
  for (const value of ['-1', '1.5', '1e3', 'garbage', '9007199254740992', ''])
    await rejectsStatus(readBody(request('x', { 'content-length': value }), 10), 400);
  assert.equal(new TextDecoder().decode(await readBody(request('abc', { 'content-length': '0003' }), 3)), 'abc');
  await rejectsStatus(readBody(request('abc', { 'content-length': '2' }), 2), 413);

  let earlyCancelled = false;
  const declaredOversize = new ReadableStream<Uint8Array>({
    pull() { throw new Error('An oversized declared request must not be read.'); },
    cancel() { earlyCancelled = true; },
  }, { highWaterMark: 0 });
  await rejectsStatus(readBody(request(declaredOversize, { 'content-length': '11' }), 10), 413);
  assert.equal(earlyCancelled, true);

  let emitted = 0, cancelled = false;
  const chunked = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emitted === 20) { controller.close(); return; }
      emitted++;
      controller.enqueue(new Uint8Array(100_000));
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  process.env.APP_ACCESS_CODE = 'http-body-fixture-code';
  const response = await login(request(chunked), {});
  assert.equal(response.status, 413);
  assert.equal(cancelled, true);
  assert.equal(emitted, 3, 'The login must stop at its first excess chunk.');

  const broken = new ReadableStream<Uint8Array>({
    pull(controller) { controller.error(new Error('Fixture disconnect')); },
  }, { highWaterMark: 0 });
  await rejectsStatus(readBody(request(broken), 10), 400);
  assert.equal((await readBody(request(null), 0)).byteLength, 0);

  delete process.env.APP_ACCESS_CODE;
  process.env.MAX_CLIP_BYTES = '1024';
  const session = 'http-body-fixture-session';
  const project = createProject({
    title: 'HTTP body fixture', goal: 'Check upload bounds in isolated temporary storage',
    finishedDefinition: 'The oversized upload is cancelled before parsing.', workflow: 'workshop_jig',
  }, session);
  const multipartBoundary = 'countershot-body-regression';
  const preamble = new TextEncoder().encode(`--${multipartBoundary}\r\nContent-Disposition: form-data; name="padding"\r\n\r\n`);
  const ending = new TextEncoder().encode(`\r\n--${multipartBoundary}--\r\n`);
  let uploadChunks = 0, uploadCancelled = false;
  const multipart = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (uploadChunks === 20) { controller.close(); return; }
      const chunk = new Uint8Array(32 * 1024).fill(120);
      if (uploadChunks === 0) chunk.set(preamble);
      if (uploadChunks === 19) chunk.set(ending, chunk.byteLength - ending.byteLength);
      uploadChunks++;
      controller.enqueue(chunk);
    },
    cancel() { uploadCancelled = true; },
  }, { highWaterMark: 0 });
  const uploadResponse = await upload(new NextRequest(`http://localhost/api/projects/${project.id}/assets`, {
    method: 'POST', body: multipart, duplex: 'half',
    headers: { cookie: `countershot_session=${session}`, 'content-type': `multipart/form-data; boundary=${multipartBoundary}` },
  } as NextRequestInit), { params: Promise.resolve({ id: project.id }) });
  assert.equal(uploadResponse.status, 413);
  assert.equal(uploadCancelled, true);
  assert.equal(uploadChunks, 4, 'The upload must stop when its 101024-byte total body limit is exceeded.');
  assert.equal(store.list('assets', project.id).length, 0);
  console.log('HTTP body regression passed');
} finally {
  store.db.close();
  delete (globalThis as { countershotDb?: unknown }).countershotDb;
}
