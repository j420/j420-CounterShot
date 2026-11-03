/**
 * Exercise a configured frontend + persistent API without starting inference.
 * SMOKE_BASE_URL=https://app.example node --import tsx scripts/hybrid-smoke.ts
 * APP_ACCESS_CODE is needed only if /api/health reports that the optional workspace gate is enabled.
 * Requires ffmpeg locally. Custom CAs belong in NODE_EXTRA_CA_CERTS; TLS verification stays enabled.
 * Creates synthetic records and leaves a private /tmp checkpoint for a restart check.
 */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const cookieJar = new Map<string, string>();
const checks: string[] = [];
function requireCheck(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function httpsOrigin(value: string | undefined, label: string) {
  let url: URL;
  try { url = new URL(value || ''); } catch { throw new Error(`${label} must be a bare HTTPS origin.`); }
  requireCheck(/^https:\/\//i.test(value || '') && !/[\s\\@?#]/.test(value || '') && url.protocol === 'https:'
    && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, `${label} must be a bare HTTPS origin.`);
  return url.origin;
}
const base = httpsOrigin(process.env.SMOKE_BASE_URL, 'SMOKE_BASE_URL');
const expectedApi = process.env.SMOKE_API_ORIGIN ? httpsOrigin(process.env.SMOKE_API_ORIGIN, 'SMOKE_API_ORIGIN') : null;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const cookieHeader = () => [...cookieJar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');

async function request(url: string, init: RequestInit, label: string) {
  try { return await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(180_000) }); }
  catch { throw new Error(`${label} could not complete. Check HTTPS trust, routing and service availability.`); }
}
async function ownedRequest(route: string, body?: unknown) {
  const response = await request(base + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: base }), ...(cookieJar.size ? { Cookie: cookieHeader() } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, `Owned ${route}`);
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(';', 1)[0], separator = pair.indexOf('=');
    if (separator > 0) {
      const name = pair.slice(0, separator);
      if (name === 'countershot_access' || name === 'countershot_session')
        requireCheck(/;\s*secure(?:;|$)/i.test(header) && /;\s*httponly(?:;|$)/i.test(header)
          && /;\s*samesite=lax(?:;|$)/i.test(header), 'The protected HTTPS cookie is missing its secure browser attributes.');
      cookieJar.set(name, pair.slice(separator + 1));
    }
  }
  return response;
}
async function ownedJson(route: string, body?: unknown) {
  const response = await ownedRequest(route, body);
  requireCheck(response.ok, `Owned ${route} returned HTTP ${response.status}.`);
  try { return await response.json(); } catch { throw new Error(`Owned ${route} did not return JSON.`); }
}
type Ticket = { url: string; token: string; expiresAt: string };
async function ticket(projectId: string, purpose: 'source' | 'trial'): Promise<Ticket> {
  const output = await ownedJson(`/api/projects/${projectId}/upload-intents`, { purpose });
  requireCheck(output && output.upload, 'Direct uploads must be configured; this smoke never falls back to the frontend upload route.');
  const upload = output.upload;
  let url: URL;
  try { url = new URL(upload.url); } catch { throw new Error('The upload ticket has an invalid destination.'); }
  requireCheck(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
    && url.pathname === `/api/projects/${projectId}/uploads` && url.origin !== base
    && (!expectedApi || url.origin === expectedApi), 'The upload ticket must target the separate expected HTTPS API.');
  requireCheck(typeof upload.token === 'string' && /^[a-f0-9]{64}$/.test(upload.token), 'The upload ticket has an invalid capability.');
  const expiry = Date.parse(upload.expiresAt);
  requireCheck(Number.isFinite(expiry) && expiry > Date.now(), 'The upload ticket is already expired.');
  return { url: url.href, token: upload.token, expiresAt: upload.expiresAt };
}
async function directRequest(upload: Ticket, body: BodyInit, origin = base, url = upload.url) {
  return request(url, { method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${upload.token}` }, body,
    credentials: 'omit', referrerPolicy: 'no-referrer' }, 'Direct media upload');
}

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'countershot-hybrid-media-'));
try {
  const health = await ownedJson('/api/health');
  requireCheck(health?.status === 'ok' && typeof health.accessCodeRequired === 'boolean', 'Health did not report the backend access mode.');
  const accessCodeRequired: boolean = health.accessCodeRequired;
  if (accessCodeRequired) {
    requireCheck(process.env.APP_ACCESS_CODE, 'This backend enables the workspace gate. Set APP_ACCESS_CODE for its smoke session.');
    await ownedJson('/api/session', { accessCode: process.env.APP_ACCESS_CODE });
    requireCheck(cookieJar.has('countershot_access'), 'Login did not retain the application access cookie.');
    checks.push('optional workspace gate login and access cookie retained');
  } else {
    requireCheck(health.accessGranted === true, 'The public backend did not grant direct entry.');
    checks.push('public entry requires no workspace code');
  }
  const created = await ownedJson('/api/projects', {
    title: 'Synthetic HTTPS hybrid smoke', workflow: 'workshop_jig', demo: true,
    goal: 'Synthetic transport verification only: preserve original phone footage and a private compatible copy. No inference or physical assembly is performed.',
    finishedDefinition: 'Private evidence survives the frontend/API boundary and a persistent backend restart. No physical result is claimed.',
  });
  const projectId: string = created.project?.id;
  requireCheck(typeof projectId === 'string' && projectId.length > 0 && created.project.isDemo === true, 'A synthetic owned workshop project was not created.');
  requireCheck(cookieJar.has('countershot_session') && (!accessCodeRequired || cookieJar.has('countershot_access')), 'Creating a project lost a required browser cookie.');
  checks.push('private browser ownership cookie retained', 'synthetic owned project created');
  const foreignCookies = [
    ...(accessCodeRequired ? [`countershot_access=${cookieJar.get('countershot_access')!}`] : []),
    `countershot_session=${randomUUID()}`,
  ].join('; ');

  const unauthorized = await request(`${base}/api/projects/${projectId}/upload-intents`, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ purpose: 'source' }),
  }, 'Unauthenticated mint denial');
  requireCheck(unauthorized.status === (accessCodeRequired ? 401 : 404), 'A browser without session cookies could mint an upload capability.');
  const noOwner = await request(`${base}/api/projects/${projectId}/upload-intents`, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', Cookie: foreignCookies },
    body: JSON.stringify({ purpose: 'source' }),
  }, 'Foreign-browser mint denial');
  requireCheck(noOwner.status === 404, 'A different browser could mint an upload capability for this project.');
  checks.push('upload minting requires the owning browser');

  const source = path.join(fixtureRoot, 'synthetic-phone.mov');
  await run('ffmpeg', ['-v', 'error', '-nostdin', '-filter_threads', '1', '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=20',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-t', '1.5', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv422p', '-c:a', 'pcm_s16le', '-threads', '1', '-f', 'mov', source], { timeout: 30_000, maxBuffer: 1_000_000 });
  const padding = Buffer.alloc(5 * 1024 * 1024 + 8);
  padding.writeUInt32BE(padding.length, 0); padding.write('free', 4, 'ascii');
  const original = Buffer.concat([await readFile(source), padding]);
  requireCheck(original.length > 4.5 * 1024 * 1024, 'The fixture must exceed the frontend upload body limit.');
  const originalHash = digest(original);
  if (process.env.SMOKE_VERIFY_FRONTEND_LIMIT === '1') {
    const limited = await request(`${base}/api/projects/${projectId}/assets`, { method: 'POST',
      headers: { Cookie: cookieHeader(), Origin: base, 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(original) }, 'Frontend body-limit calibration');
    requireCheck(limited.status === 413, 'The local frontend proxy did not enforce its 4.5 MiB request body limit.');
    checks.push('frontend request body limit rejects the oversized fixture');
  }
  const upload = await ticket(projectId, 'source');
  const apiOrigin = new URL(upload.url).origin;
  const preflight = await request(upload.url, { method: 'OPTIONS', headers: { Origin: base, 'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'Authorization, Content-Type' }, credentials: 'omit' }, 'Direct upload CORS preflight');
  const allowedMethods = (preflight.headers.get('access-control-allow-methods') || '').split(',').map(value => value.trim().toUpperCase()).filter(Boolean);
  const allowedHeaders = (preflight.headers.get('access-control-allow-headers') || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  requireCheck(preflight.status === 204 && preflight.headers.get('access-control-allow-origin') === base
    && preflight.headers.get('access-control-allow-credentials') === null && allowedMethods.length === 1 && allowedMethods[0] === 'POST'
    && allowedHeaders.length === 2 && allowedHeaders.includes('authorization') && allowedHeaders.includes('content-type')
    && (preflight.headers.get('vary') || '').split(',').some(value => value.trim().toLowerCase() === 'origin'), 'The direct upload preflight did not grant the exact credentialless frontend origin, method and required headers.');
  const deniedPreflight = await request(upload.url, { method: 'OPTIONS', headers: { Origin: 'https://untrusted.invalid',
    'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Authorization' }, credentials: 'omit' }, 'Wrong-origin preflight denial');
  requireCheck(deniedPreflight.status === 403 && deniedPreflight.headers.get('access-control-allow-origin') === null, 'A different origin received upload CORS access.');
  requireCheck((await directRequest(upload, 'not media', 'https://untrusted.invalid')).status === 403, 'The direct endpoint accepted a wrong origin.');
  const wrongProjectUrl = new URL(upload.url); wrongProjectUrl.pathname = `/api/projects/${randomUUID()}/uploads`;
  requireCheck((await directRequest(upload, 'not media', base, wrongProjectUrl.href)).status === 401, 'The capability could be used for another project.');
  checks.push('exact CORS preflight and wrong-origin denial', 'project-scoped capability');

  const form = new FormData(); form.set('file', new File([new Uint8Array(original)], 'synthetic-phone.mov', { type: 'video/quicktime' })); form.set('purpose', 'source');
  const saved = await directRequest(upload, form);
  requireCheck(saved.status === 201 && saved.headers.get('access-control-allow-origin') === base, `Direct upload returned HTTP ${saved.status}.`);
  const { asset } = await saved.json();
  requireCheck(asset?.projectId === projectId && asset.purpose === 'source' && asset.mime === 'video/mp4'
    && asset.original?.mime === 'video/quicktime' && asset.original.sha256 === originalHash && asset.original.byteLength === original.length
    && asset.original.storageKey !== asset.storageKey && asset.normalization?.method === 'transcoded'
    && asset.normalization.version === 'phone-mp4-v1' && asset.normalization.videoCodec === 'h264'
    && asset.normalization.pixelFormat === 'yuv420p' && asset.normalization.audioCodec === 'aac', 'The uploaded asset lost original/hash/normalization provenance.');
  requireCheck((await directRequest(upload, 'replay must fail')).status === 401, 'A used upload capability was replayable.');
  const purposeTicket = await ticket(projectId, 'trial');
  const wrongPurpose = new FormData(); wrongPurpose.set('purpose', 'source'); wrongPurpose.set('file', new File(['synthetic'], 'unused.bin'));
  requireCheck((await directRequest(purposeTicket, wrongPurpose)).status === 400, 'The upload capability permitted a different recording purpose.');
  requireCheck((await directRequest(purposeTicket, 'replay must fail')).status === 401, 'A failed upload did not consume its capability.');
  checks.push('MOV larger than 4.5 MiB uploaded directly and normalized', 'original bytes and both SHA-256 identities recorded', 'single use and purpose binding');

  const assetRoute = `/api/projects/${projectId}/assets/${asset.id}`;
  const canonical = await ownedRequest(assetRoute);
  requireCheck(canonical.status === 200 && canonical.headers.get('content-type') === 'video/mp4'
    && canonical.headers.get('cache-control') === 'private, no-store', 'Canonical playback is not private MP4.');
  const canonicalBytes = Buffer.from(await canonical.arrayBuffer());
  requireCheck(canonicalBytes.length === asset.byteLength && digest(canonicalBytes) === asset.sha256, 'Canonical playback bytes do not match the persisted hash.');
  const ranged = await request(base + assetRoute, { headers: { Cookie: cookieHeader(), Range: 'bytes=0-99' } }, 'Protected canonical Range');
  requireCheck(ranged.status === 206 && ranged.headers.get('content-range') === `bytes 0-99/${asset.byteLength}`
    && ranged.headers.get('content-length') === '100' && Buffer.from(await ranged.arrayBuffer()).equals(canonicalBytes.subarray(0, 100)), 'Canonical byte-range playback failed.');
  const originalResponse = await ownedRequest(assetRoute + '?original=1');
  requireCheck(originalResponse.status === 200 && originalResponse.headers.get('content-type') === 'video/quicktime'
    && originalResponse.headers.get('content-disposition')?.startsWith('attachment;')
    && originalResponse.headers.get('x-countershot-sha256') === originalHash, 'Original download lost its private attachment/hash headers.');
  requireCheck(Buffer.from(await originalResponse.arrayBuffer()).equals(original), 'The downloaded original is not byte-exact.');
  for (const privateRoute of [assetRoute, assetRoute + '?original=1']) {
    const outsider = await request(base + privateRoute, {}, 'Private media denial');
    requireCheck(outsider.status === (accessCodeRequired ? 401 : 404), 'A browser without session cookies could download private media.');
    const unowned = await request(base + privateRoute, { headers: { Cookie: foreignCookies } }, 'Foreign-browser media denial');
    requireCheck(unowned.status === 404, 'A different browser could download private media.');
  }
  const capabilityGet = await request(apiOrigin + assetRoute, { headers: { Authorization: `Bearer ${upload.token}` } }, 'Upload capability download denial');
  requireCheck(capabilityGet.status === (accessCodeRequired ? 401 : 404), 'An upload capability granted media download access.');
  checks.push('protected frontend canonical MP4 and Range retrieval', 'byte-exact original download through frontend', 'upload capability cannot read private media');

  const state = await ownedJson(`/api/projects/${projectId}`);
  requireCheck(state.assets.length === 1 && state.assets[0].id === asset.id && state.jobs.length === 0 && state.trials.length === 0
    && state.project.isDemo === true, 'The smoke unexpectedly created extra assets, inference jobs or physical trial records.');
  if (process.env.SMOKE_REQUIRE_UNCONFIGURED_MODEL === '1') requireCheck(state.meta?.configured === false, 'The local backend model key must remain blank for this smoke.');
  checks.push('no inference jobs or physical completion records');
  const checkpointRoot = await mkdtemp(path.join(os.tmpdir(), 'countershot-hybrid-checkpoint-'));
  const checkpointPath = path.join(checkpointRoot, 'checkpoint.json');
  await writeFile(checkpointPath, JSON.stringify({ version: 1, createdAt: new Date().toISOString(), baseUrl: base, apiOrigin,
    cookies: [...cookieJar.entries()], projectId, assetId: asset.id, originalSha256: originalHash, originalByteLength: original.length,
    canonicalSha256: asset.sha256, canonicalByteLength: asset.byteLength, synthetic: true, physicalStatus: 'untested', noProviderCalls: true }, null, 2), { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ passed: true, checkedAt: new Date().toISOString(), baseUrl: base, apiOrigin, projectId, assetId: asset.id,
    originalBytes: original.length, canonicalBytes: asset.byteLength, synthetic: true, physicalStatus: 'untested', noProviderCalls: true,
    accessCodeRequired, checks, checkpointPath }, null, 2));
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}
