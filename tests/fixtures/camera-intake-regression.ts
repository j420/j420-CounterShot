import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsPromises, { readFile, readdir, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { mock } from 'node:test';
import OpenAI from 'openai';
import { NextRequest } from 'next/server';
import type { CameraIntakeWire, CameraIntakeResponse } from '../../src/camera/intake-contract';
import type { InvocationSpec } from '../../src/meta/budget';

assert.ok(process.env.DATA_ROOT?.startsWith(path.join(os.tmpdir(), 'countershot-camera-intake-')));
assert.equal(process.env.DATABASE_PATH, path.join(process.env.DATA_ROOT!, 'test.sqlite'));
assert.equal(process.env.ASSET_ROOT, path.join(process.env.DATA_ROOT!, 'assets'));
process.env.MODEL_API_KEY = 'offline-intake-fixture-key';
delete process.env.APP_ACCESS_CODE;
delete process.env.APP_PUBLIC_ORIGIN;
delete process.env.PUBLIC_API_ORIGIN;
const intake = await import('../../src/camera/intake');
const store = await import('../../src/storage/db');
const camera = await import('../../src/camera/server');
const { POST: postRoute, GET: lookupRoute } = await import('../../app/api/camera/intakes/route');
const POST = (req: NextRequest) => postRoute(req, {});
const recoverRoute = (req: NextRequest) => lookupRoute(req, {});
const { GET: stateRoute } = await import('../../app/api/camera/intakes/[id]/route');
const { GET: frameRoute } = await import('../../app/api/camera/intakes/[id]/frames/[frameId]/route');
const run = promisify(execFile), root = process.env.DATA_ROOT!;
const owner = 'offline-intake-owner', stranger = 'offline-intake-stranger';
const scenario = process.argv[2];
const source = path.join(root, 'scene.png');
await run('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=blue:s=32x32', '-frames:v', '1', '-threads', '1', source], { timeout: 10_000 });
const image = await readFile(source);
const request = (url: string, browser = owner) => new NextRequest(`http://localhost${url}`, {
  headers: { cookie: `countershot_session=${browser}` },
});
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const frameParams = (id: string, frameId: string) => ({ params: Promise.resolve({ id, frameId }) });
function capture(operationId = randomUUID(), extra: Record<string, string> = {}, bytes: Uint8Array = image, browser = owner) {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(bytes)], 'synthetic-scene.png', { type: 'application/octet-stream' }));
  form.set('operationId', operationId); form.set('source', 'upload'); form.set('capturedAt', '');
  form.set('goal', 'Route the labelled synthetic bench harness.'); form.set('context', 'Offline software fixture; no physical success claim.');
  for (const [key, value] of Object.entries(extra)) form.set(key, value);
  return new NextRequest('http://localhost/api/camera/intakes', { method: 'POST',
    headers: { cookie: `countershot_session=${browser}` }, body: form });
}
const result = (): CameraIntakeWire => ({
  summary: 'Synthetic labelled harness scene for isolated API testing.', frameQuality: 'clear',
  workflowId: 'harness_routing', workflowReason: 'The shown labels and written route reference match this supported family.',
  workflowEvidenceObservationIds: ['labels'],
  observations: [{ id: 'labels', label: 'Synthetic printed branch labels', detail: 'A visible written fixture reference names trunk A and port B.',
    box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }],
  unknowns: ['The actual cable specification and power isolation are unconfirmed.'], viewRequest: null,
  factDrafts: [{ factKey: 'branch_labels', value: 'Trunk A; destination B', evidenceObservationIds: ['labels'] }],
});
let calls = 0;
let currentResult: unknown = result();
let rawText: string | null = null;
let respond: ((body: Record<string, any>) => unknown | Promise<unknown>) | null = null;
const reply = (id = `resp_intake_${calls}`, value: unknown = currentResult) => ({ id, model: 'muse-spark-1.3', status: 'completed',
  usage: { input_tokens: 14, output_tokens: 3, total_tokens: 17 },
  output: [{ type: 'message', role: 'assistant', id: `message-${id}`, status: 'completed', content: [{ type: 'output_text', text: rawText ?? JSON.stringify(value) }] }] });
const provider = mock.method(OpenAI.prototype, 'post', ((_url: string, options: Record<string, unknown>) => {
  assert.equal(_url, '/responses', 'No unmocked endpoint may run in this fixture.');
  calls++;
  const output = Promise.resolve(options).then(async resolved => {
    const body = resolved.body as Record<string, any>;
    assert.equal(body.model, 'muse-spark-1.3');
    assert.ok(body.max_output_tokens > 0 && body.max_output_tokens <= 6000);
    assert.equal(body.tools, undefined, 'Scene intake cannot acquire physical planning or retrieval tools.');
    const context = JSON.parse(body.input[0].content.find((item: { type: string }) => item.type === 'input_text').text);
    const durable = store.get<any>('camera_intakes', context.runId);
    assert.ok(durable, 'The intake must exist before its actual SDK POST.');
    assert.equal(durable.executionBudget.runId, context.runId);
    assert.ok(durable.executionBudget.invocations.some((item: any) => item.status === 'reserved' && item.responseId === null),
      'The paid invocation must be durably reserved before the SDK call.');
    return respond ? respond(body) : reply();
  });
  return { _thenUnwrap: (transform: (value: unknown) => unknown) => output.then(transform) };
}) as unknown as typeof OpenAI.prototype.post);
const submit = (operationId = randomUUID(), extra: Record<string, string> = {}, bytes: Uint8Array = image) => intake.submitCameraIntake(capture(operationId, extra, bytes), owner);
const state = (id: string, browser = owner) => intake.cameraIntakeState(request(`/api/camera/intakes/${id}`, browser), id);
const isStatus = (code: number) => (error: unknown) => !!error && typeof error === 'object' && 'status' in error && error.status === code;
const storedJSON = (id: string) => JSON.stringify(store.db.prepare('SELECT json FROM records WHERE project_id=?').all(id));
const rejectAdoption = (value: CameraIntakeResponse['intake'], workflowId = value.result!.workflowId!, expectedRevision = value.revision, browserSession = owner) =>
  intake.adoptCameraIntake({ intakeId: value.id, expectedRevision, workflowId, browserSession }, () => assert.fail('Rejected adoption cannot create a session.'));

try {
  if (scenario === 'ownership') {
    const operation = randomUUID();
    const response = await POST(capture(operation));
    assert.ok(response.status >= 200 && response.status < 300);
    const first = await response.json() as CameraIntakeResponse;
    assert.equal(first.intake.status, 'completed'); assert.equal(calls, 1);
    assert.equal(first.intake.frame!.sha256, store.bytesHash(image));
    assert.equal(first.intake.frame!.capturedAt, null);
    assert.equal(first.intake.executionBudget.invocations.length, 1);
    assert.equal(first.intake.executionBudget.invocations[0].responseId, 'resp_intake_1');
    assert.equal(first.intake.executionBudget.invocations[0].usage!.totalTokens, 17);
    const repeated = await submit(operation);
    assert.equal(repeated.intake.id, first.intake.id); assert.equal(calls, 1);
    await assert.rejects(submit(operation, { goal: 'Changed operation inputs' }), isStatus(409));
    const recovered = await recoverRoute(request(`/api/camera/intakes?operationId=${operation}`));
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json()).intake.id, first.intake.id);
    assert.equal((await stateRoute(request(`/api/camera/intakes/${first.intake.id}`, stranger), params(first.intake.id))).status, 404);
    assert.equal((await recoverRoute(request(`/api/camera/intakes?operationId=${operation}`, stranger))).status, 404);
    const frame = await frameRoute(request(first.intake.frame!.url), frameParams(first.intake.id, first.intake.frame!.id));
    assert.equal(frame.status, 200); assert.equal(frame.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(Buffer.from(await frame.arrayBuffer()), image);
    assert.equal((await frameRoute(request(first.intake.frame!.url, stranger), frameParams(first.intake.id, first.intake.frame!.id))).status, 404);
    const publicText = JSON.stringify(first);
    assert.ok(!publicText.includes('ownerHash') && !publicText.includes('storageKey') && !publicText.includes(store.assetRoot));
  } else if (scenario === 'validation') {
    process.env.MODEL_API_KEY = '';
    assert.equal((await POST(capture())).status, 503);
    process.env.MODEL_API_KEY = 'offline-intake-fixture-key';
    for (const bytes of [Buffer.from('not an image'), Buffer.alloc(300 * 1024 + 1)]) {
      assert.ok((await POST(capture(randomUUID(), {}, bytes))).status >= 400);
    }
    const large = path.join(root, 'oversized.png'), animated = path.join(root, 'animated.png');
    await run('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=blue:s=1602x2', '-frames:v', '1', '-threads', '1', large], { timeout: 10_000 });
    await run('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc=size=32x32:rate=2', '-t', '1', '-plays', '0', '-threads', '1', '-f', 'apng', animated], { timeout: 10_000 });
    assert.equal((await POST(capture(randomUUID(), {}, await readFile(large)))).status, 415);
    assert.equal((await POST(capture(randomUUID(), {}, await readFile(animated)))).status, 415);
    assert.equal((await POST(capture(randomUUID(), { capturedAt: new Date().toISOString() }))).status, 400);
    assert.equal((await POST(capture(randomUUID(), { goal: 'x'.repeat(501) }))).status, 400);
    assert.equal(calls, 0);
  } else if (scenario === 'invalid-output') {
    const invalid: unknown[] = [
      { ...result(), factDrafts: [{ factKey: 'scope_confirmed', value: 'true', evidenceObservationIds: ['labels'] }] },
      { ...result(), factDrafts: [{ factKey: 'minimum_bend_radius_mm', value: '10', evidenceObservationIds: ['labels'] }] },
      { ...result(), factDrafts: [{ factKey: 'operator_constraints', value: 'Two hands', evidenceObservationIds: ['labels'] }] },
      { ...result(), factDrafts: [{ factKey: 'branch_labels', value: 'A/B', evidenceObservationIds: ['foreign'] }] },
      { ...result(), workflowEvidenceObservationIds: ['foreign'] },
      { ...result(), workflowEvidenceObservationIds: [] },
      { ...result(), workflowId: 'unsupported_physical_workflow' },
      { ...result(), observations: [result().observations[0], result().observations[0]] },
      { ...result(), observations: [{ ...result().observations[0], box: { x: 0.9, y: 0, width: 0.5, height: 0.5 } }] },
    ];
    for (const value of invalid) {
      currentResult = value;
      const output = await submit();
      assert.equal(output.intake.status, 'failed'); assert.equal(output.intake.result, null);
      assert.equal(output.intake.executionBudget.invocations.length, 1);
      assert.equal(output.intake.executionBudget.invocations[0].usage!.totalTokens, 17);
      assert.ok(storedJSON(output.intake.id).includes(`resp_intake_${calls}`), 'Known paid response identity remains auditable.');
    }
    rawText = '{invalid-json-paid-output';
    const malformed = await submit();
    assert.equal(malformed.intake.status, 'failed'); assert.equal(malformed.intake.result, null);
    assert.ok(storedJSON(malformed.intake.id).includes(rawText), 'The rejected provider output is retained as private evidence.');
  } else if (scenario === 'attempts') {
    let output = await submit();
    const id = output.intake.id, deadline = output.intake.executionBudget.deadlineAt;
    const first = output.intake;
    const changedPath = path.join(root, 'retaken-red-scene.png');
    await run('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=red:s=32x32', '-frames:v', '1', '-threads', '1', changedPath], { timeout: 10_000 });
    const changedImage = await readFile(changedPath);
    assert.notEqual(store.bytesHash(changedImage), store.bytesHash(image));
    output = await submit(randomUUID(), { intakeId: id, expectedRevision: String(output.intake.revision) }, changedImage);
    const second = output.intake;
    assert.notEqual(first.frame!.url, second.frame!.url);
    assert.ok(first.frame!.url.includes(first.frame!.id) && second.frame!.url.includes(second.frame!.id));
    output = await submit(randomUUID(), { intakeId: id, expectedRevision: String(output.intake.revision) }, changedImage);
    assert.equal(output.intake.executionBudget.invocations.length, 3);
    assert.equal(output.intake.executionBudget.deadlineAt, deadline);
    assert.equal(output.intake.executionBudget.runId, id);
    await assert.rejects(submit(randomUUID(), { intakeId: id, expectedRevision: String(output.intake.revision) }), isStatus(429));
    assert.equal(calls, 3);
    for (const [saved, expected] of [[first, image], [second, changedImage]] as const) {
      const response = await frameRoute(request(saved.frame!.url), frameParams(id, saved.frame!.id));
      assert.equal(response.status, 200);
      const retained = Buffer.from(await response.arrayBuffer());
      assert.deepEqual(retained, expected, 'A historical frame URL cannot switch to the latest captured pixels.');
      assert.equal(store.bytesHash(retained), saved.frame!.sha256);
    }
    assert.equal((await frameRoute(request(first.frame!.url, stranger), frameParams(id, first.frame!.id))).status, 404);
    const other = await submit();
    assert.notEqual(other.intake.id, id);
    assert.equal((await frameRoute(request(`/api/camera/intakes/${id}/frames/${other.intake.frame!.id}`),
      frameParams(id, other.intake.frame!.id))).status, 404, 'A frame from another intake cannot be read through this intake, even by the same owner.');
  } else if (scenario === 'cancel') {
    let finish!: (value: unknown) => void, entered!: () => void;
    const pending = new Promise(resolve => { finish = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    respond = () => { entered(); return pending; };
    const operation = randomUUID(), work = submit(operation);
    await started;
    const saved = intake.cameraIntakeByOperation(request(`/api/camera/intakes?operationId=${operation}`), operation);
    assert.equal(saved.intake.status, 'pending');
    const duplicate = await submit(operation); assert.equal(duplicate.intake.id, saved.intake.id); assert.equal(calls, 1);
    await assert.rejects(submit(randomUUID(), { intakeId: saved.intake.id, expectedRevision: String(saved.intake.revision) }), isStatus(409));
    const cancelled = intake.cancelCameraIntake(request(`/api/camera/intakes/${saved.intake.id}`), saved.intake.id,
      { action: 'cancel', expectedRevision: saved.intake.revision });
    assert.equal(cancelled.intake.status, 'cancelled');
    const oldResult = result();
    respond = null;
    currentResult = { ...result(), summary: 'A separately requested retake is the current scene.' };
    const retaken = await submit(randomUUID(), { intakeId: saved.intake.id, expectedRevision: String(cancelled.intake.revision) });
    assert.equal(retaken.intake.status, 'completed');
    assert.notEqual(retaken.intake.frame!.id, saved.intake.frame!.id);
    finish(reply('resp_intake_cancelled', oldResult));
    await work;
    const latest = state(saved.intake.id);
    assert.equal(latest.intake.status, 'completed');
    assert.equal(latest.intake.result!.summary, 'A separately requested retake is the current scene.');
    assert.equal(latest.intake.frame!.id, retaken.intake.frame!.id);
    assert.equal(latest.intake.executionBudget.invocations.length, 2);
    assert.equal(latest.intake.executionBudget.invocations[0].responseId, 'resp_intake_cancelled');
    assert.equal(latest.intake.executionBudget.invocations[0].usage!.totalTokens, 17);
    assert.equal(latest.intake.executionBudget.invocations[1].usage!.totalTokens, 17);
    assert.equal((await submit(operation)).intake.frame!.id, retaken.intake.frame!.id); assert.equal(calls, 2);
  } else if (scenario === 'cancel-preflight') {
    const original = await submit();
    const before = original.intake;
    const folder = path.join(store.assetRoot, 'camera-intakes');
    const filesBefore = (await readdir(folder)).sort();
    for (const initialStatus of ['completed', 'cancelled']) {
      const current = state(before.id).intake;
      assert.equal(current.status, initialStatus);
      let resume!: () => void, entered!: () => void;
      const paused = new Promise<void>(resolve => { entered = resolve; });
      const released = new Promise<void>(resolve => { resume = resolve; });
      const originalWrite = fsPromises.writeFile;
      // Intercept an existing filesystem dependency after media allocation, without an app test hook.
      const writing = mock.method(fsPromises, 'writeFile', (async (...args: Parameters<typeof writeFile>) => {
        await originalWrite(...args);
        if (String(args[0]).endsWith('.upload')) { entered(); await released; }
      }) as typeof writeFile);
      syncBuiltinESMExports();
      try {
        const stale = submit(randomUUID(), { intakeId: current.id, expectedRevision: String(current.revision) });
        await paused;
        const cancelled = intake.cancelCameraIntake(request(`/api/camera/intakes/${current.id}`), current.id,
          { action: 'cancel', expectedRevision: current.revision });
        assert.equal(cancelled.intake.status, 'cancelled');
        assert.equal(cancelled.intake.revision, current.revision + 1);
        assert.deepEqual(cancelled.intake.executionBudget, before.executionBudget);
        assert.equal(intake.cancelCameraIntake(request(`/api/camera/intakes/${current.id}`), current.id,
          { action: 'cancel', expectedRevision: current.revision }).intake.revision, cancelled.intake.revision,
        'Replaying the same cancellation cannot advance its revision again.');
        const rejected = assert.rejects(stale, isStatus(409));
        resume(); await rejected;
        assert.equal(calls, 1, 'A preflight retake cannot start a paid POST after a later cancellation.');
        assert.equal(store.list('camera_intake_attempts', before.id).length, 1);
        assert.equal(store.list('camera_intake_frames', before.id).length, 1);
        assert.deepEqual((await readdir(folder)).sort(), filesBefore, 'Abandoned retake media must be removed.');
        assert.equal(state(before.id).intake.status, 'cancelled');
      } finally { resume(); writing.mock.restore(); syncBuiltinESMExports(); }
    }
    const cancelled = state(before.id).intake;
    const fresh = await submit(randomUUID(), { intakeId: before.id, expectedRevision: String(cancelled.revision) });
    assert.equal(fresh.intake.status, 'completed');
    assert.equal(fresh.intake.executionBudget.invocations.length, 2);
    assert.equal(fresh.intake.executionBudget.createdAt, before.executionBudget.createdAt);
    assert.equal(fresh.intake.executionBudget.deadlineAt, before.executionBudget.deadlineAt);
    assert.equal(calls, 2, 'Only the fresh explicit retake may spend the next shared invocation.');
  } else if (scenario === 'unknown') {
    respond = () => { throw new Error('Offline injected connection failure after request reservation'); };
    const operation = randomUUID(), failed = await submit(operation);
    assert.equal(failed.intake.status, 'failed'); assert.equal(failed.intake.result, null);
    assert.equal(failed.intake.executionBudget.invocations[0].status, 'unknown');
    assert.equal((await submit(operation)).intake.status, 'failed');
    assert.equal(calls, 1);
  } else if (scenario === 'adoption') {
    const output = await submit(), value = output.intake;
    assert.throws(() => rejectAdoption(value, 'fragment_dry_fit'), isStatus(409));
    assert.throws(() => rejectAdoption(value, 'harness_routing', value.revision + 1), isStatus(409));
    assert.throws(() => rejectAdoption(value, 'harness_routing', value.revision, stranger), isStatus(404));
    const body = { workflowId: 'harness_routing', facts: {}, intakeId: value.id, intakeRevision: value.revision };
    const session = camera.createOwnedCameraSession(body, owner);
    assert.equal(session.id, value.id); assert.deepEqual(session.facts, {});
    assert.equal(session.beforeTurn, null); assert.equal(session.latestTurn, null); assert.equal(session.completedSteps.length, 0);
    assert.deepEqual(session.executionBudget, value.executionBudget);
    assert.equal(camera.createOwnedCameraSession(body, owner).id, session.id);
    assert.equal(calls, 1);
    const adopted = intake.publicCameraIntakeForSession(session.id, owner)!;
    assert.equal(adopted.status, 'adopted'); assert.equal(adopted.adoptedSessionId, session.id);
    assert.equal(intake.publicCameraIntakeForSession(session.id, stranger), null);
    const draft = adopted.result!.factDrafts[0];
    assert.equal(draft.frameSha256, adopted.frame!.sha256); assert.equal(draft.frameId, adopted.frame!.id);
    assert.equal(intake.cameraIntakeDraftForSession(session.id, owner, draft.id)!.value, draft.value);
    assert.equal(intake.cameraIntakeDraftForSession(session.id, stranger, draft.id), null);
    const { reserveInvocation, recordInvocationResponse } = await import('../../src/meta/budget');
    const later: InvocationSpec = { invocationId: 'offline-later-camera-check', parentInvocationId: null,
      role: 'camera_observe_decide', route: 'camera_reasoning', model: 'muse-spark-1.3', contextHash: store.hash('offline-later-camera-check'),
      promptVersion: 'offline-camera-fixture', schemaVersion: 'camera-decision-v3', toolVersion: 'none', maxOutputTokens: 6000, inputBytes: 200 };
    const charged = recordInvocationResponse(reserveInvocation(session.executionBudget!, later).state,
      later.invocationId, 'resp_offline_later_camera_check', { input_tokens: 4, output_tokens: 3, total_tokens: 7 });
    store.replace('camera_sessions', { ...session, executionBudget: charged });
    assert.deepEqual(intake.publicCameraIntakeForSession(session.id, owner)!.executionBudget, charged,
      'The public intake allowance includes later camera work in this same adopted run.');
    assert.equal(store.get<any>('camera_intakes', session.id)!.executionBudget.invocations.length, 1,
      'Displaying the live allowance does not rewrite the original intake history.');
    const records = store.db.prepare('SELECT json FROM records WHERE project_id=?').all(session.id) as { json: string }[];
    const retainedFrame = records.map(row => JSON.parse(row.json)).find(record => record.id === adopted.frame!.id && typeof record.storageKey === 'string');
    assert.ok(retainedFrame);
    await writeFile(path.join(store.assetRoot, retainedFrame.storageKey), Buffer.from('Changed adopted synthetic source bytes'));
    assert.equal(intake.cameraIntakeDraftForSession(session.id, owner, draft.id), null,
      'A model draft cannot claim the original image provenance after the retained pixels change.');
    const recovered = camera.createOwnedCameraSession(body, owner);
    assert.equal(recovered.id, session.id, 'An adoption response can still be recovered after its historical image becomes unavailable.');
    assert.deepEqual(recovered.executionBudget, charged, 'Adoption recovery cannot refill or replace the live shared allowance.');
    assert.equal(calls, 1);
  } else if (scenario === 'pending-cap') {
    const turns = Array.from({ length: 3 }, () => {
      const sessionId = randomUUID(), turnId = randomUUID();
      store.insert('camera_sessions', { id: sessionId, projectId: sessionId, ownerHash: store.bytesHash(owner),
        activeTurnId: turnId, createdAt: store.now() });
      return store.insert('camera_turns', { id: turnId, projectId: sessionId, status: 'pending', createdAt: '2000-01-01T00:00:00.000Z' });
    });
    const admitted = await submit();
    assert.equal(admitted.intake.status, 'completed');
    assert.equal(calls, 1, 'Expired pending turns cannot occupy a current inference slot.');
    for (const turn of turns) store.replace('camera_turns', { ...turn, createdAt: store.now() });
    const attemptsBefore = store.list('camera_intake_attempts').length;
    const framesBefore = store.list('camera_intake_frames').length;
    const retainedBefore = (await readdir(path.join(store.assetRoot, 'camera-intakes'))).sort();
    const callsBefore = calls;
    await assert.rejects(submit(), isStatus(429));
    assert.equal(calls, callsBefore, 'A full pending allowance must start zero additional SDK POSTs.');
    assert.equal(store.list('camera_intake_attempts').length, attemptsBefore);
    assert.equal(store.list('camera_intake_frames').length, framesBefore);
    assert.deepEqual((await readdir(path.join(store.assetRoot, 'camera-intakes'))).sort(), retainedBefore,
      'A rejected concurrent intake leaves no temporary or retained frame behind.');
  } else if (scenario === 'scene-reset') {
    const output = await submit(), value = output.intake;
    const session = camera.createOwnedCameraSession({ workflowId: 'harness_routing', facts: {},
      intakeId: value.id, intakeRevision: value.revision }, owner);
    const draft = intake.publicCameraIntakeForSession(session.id, owner)!.result!.factDrafts[0];
    assert.equal(session.sceneEpoch, 1);
    assert.equal(intake.cameraIntakeDraftForSession(session.id, owner, draft.id)!.value, draft.value);
    const resetBody = { action: 'facts', expectedRevision: session.revision, facts: {} };
    const resetRequest = new NextRequest(`http://localhost/api/camera/sessions/${session.id}`, { method: 'PATCH',
      headers: { cookie: `countershot_session=${owner}`, 'Content-Type': 'application/json' }, body: JSON.stringify(resetBody) });
    const reset = camera.patchCameraSession(resetRequest, session.id, resetBody);
    assert.equal(reset.session.sceneEpoch, 2);
    assert.equal(intake.cameraIntakeDraftForSession(session.id, owner, draft.id), null,
      'A new scene cannot claim an old intake observation even when the old image bytes remain intact.');
    assert.equal(calls, 1, 'The explicit operator reset and provenance check do not trigger another inference.');
  } else if (scenario === 'unsupported-integrity') {
    currentResult = { ...result(), workflowId: null, workflowReason: 'No supported workflow is established.', workflowEvidenceObservationIds: [], factDrafts: [] };
    const unsupported = await submit();
    assert.equal(unsupported.intake.status, 'completed'); assert.equal(unsupported.intake.result!.workflowId, null);
    assert.throws(() => rejectAdoption(unsupported.intake, 'harness_routing'), isStatus(409));
    currentResult = result();
    const output = await submit();
    const frameRows = store.db.prepare('SELECT json FROM records WHERE project_id=?').all(output.intake.id) as { json: string }[];
    const frame = frameRows.map(row => JSON.parse(row.json)).find(record => record.id === output.intake.frame!.id && typeof record.storageKey === 'string');
    assert.ok(frame, 'The owned current frame is durably recorded.');
    await writeFile(path.join(store.assetRoot, frame.storageKey), Buffer.from('Changed synthetic source bytes'));
    assert.throws(() => rejectAdoption(output.intake, 'harness_routing'), (error: unknown) => !!error && typeof error === 'object' && 'status' in error);
  } else assert.fail('Unknown scene-intake regression scenario.');
  console.log(`Scene intake regression passed: ${scenario}`);
} finally {
  provider.mock.restore();
  store.db.close();
  delete (globalThis as { countershotDb?: unknown }).countershotDb;
}
