import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import OpenAI from 'openai';
import { NextRequest } from 'next/server';

// No storage-dependent module may load until the subprocess paths are checked.
assert.ok(process.env.DATA_ROOT?.startsWith(path.join(os.tmpdir(), 'countershot-trace-test-')));
assert.ok(realpathSync(process.env.DATA_ROOT!).startsWith(realpathSync(os.tmpdir()) + path.sep));
assert.equal(process.env.DATABASE_PATH, path.join(process.env.DATA_ROOT!, 'test.sqlite'));
assert.equal(process.env.ASSET_ROOT, path.join(process.env.DATA_ROOT!, 'assets'));
const fakeKey = 'offline-trace-key-sentinel-never-a-real-credential';
const fakeHeader = 'offline-trace-header-sentinel';
const accessCode = 'offline-trace-access-sentinel';
process.env.MODEL_API_KEY = fakeKey;
process.env.APP_ACCESS_CODE = accessCode;

const { demoFacts, demoProposal } = await import('../../src/domain/demo');
const services = await import('../../src/server/projects');
const store = await import('../../src/storage/db');
const queue = await import('../../src/jobs/queue');
const { processJob } = await import('../../src/jobs/process');
const { GET: state } = await import('../../app/api/projects/[id]/route');
const { GET: exportProject } = await import('../../app/api/projects/[id]/export/route');

const ownerSession = 'trace-fixture-owner-session';
const strangerSession = 'trace-fixture-stranger-session';
const makeProject = (session: string) => services.createProject({
  title: 'Trace fixture only', goal: 'Check private trace export using an offline provider stub',
  finishedDefinition: 'A scoped credential-free audit export', workflow: 'carton_packing',
}, session);
const project = makeProject(ownerSession);
services.confirmFacts(project, { facts: demoFacts, confirmed: true });
const foreign = makeProject(strangerSession);
const foreignTraceId = 'foreign-trace-must-remain-private';
store.insert('model_traces', { id: foreignTraceId, projectId: foreign.id, trace: { providerResponseId: foreignTraceId }, createdAt: store.now() });
store.insert('model_attempt_traces', { id: foreignTraceId + ':1', projectId: foreign.id, trace: { providerResponseId: foreignTraceId }, late: true, createdAt: store.now() });

const reply = (responseId: string) => ({
  id: responseId, model: 'offline-model', status: 'completed', usage: { total_tokens: 7 },
  output: [{ type: 'message', role: 'assistant', id: 'offline-message', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(demoProposal) }] }],
  // Deliberately attach fields that must never be copied from a raw SDK response.
  headers: { Authorization: fakeHeader }, request: { headers: { Authorization: fakeHeader } }, apiKey: fakeKey,
});
let finishLate!: (response: ReturnType<typeof reply>) => void;
let requestStarted!: () => void;
const pending = new Promise<ReturnType<typeof reply>>(resolve => { finishLate = resolve; });
const entered = new Promise<void>(resolve => { requestStarted = resolve; });
let posts = 0;
const post = mock.method(OpenAI.prototype, 'post', ((requestPath: string) => {
  assert.equal(requestPath, '/responses');
  posts++;
  if (posts === 2) requestStarted();
  const result = posts === 1 ? Promise.resolve(reply('resp_offline_complete')) : pending;
  return { _thenUnwrap: (transform: (value: unknown) => unknown) => result.then(transform) };
}) as unknown as typeof OpenAI.prototype.post);
const get = mock.method(OpenAI.prototype, 'get', () => { throw new Error('No provider retrieval is permitted in this offline fixture.'); });

try {
  const first = queue.enqueue(project, { kind: 'plan', clientOperationId: randomUUID() });
  await processJob(queue.claimJob()!);
  assert.equal(queue.jobById(first.id)!.status, 'completed');
  const second = queue.enqueue(project, { kind: 'plan', clientOperationId: randomUUID() });
  const claimed = queue.claimJob()!;
  const work = processJob(claimed);
  await entered;
  const currentTrace = store.get('model_traces', second.id);
  queue.cancelJob(project.id, second.id);
  finishLate(reply('resp_offline_late'));
  await work;
  assert.equal(queue.jobById(second.id)!.status, 'cancelled');
  assert.deepEqual(store.get('model_traces', second.id), currentTrace);
  const late = store.get<{ late: boolean; trace: { providerResponseId: string; usage: unknown } }>('model_attempt_traces', `${second.id}:${claimed.attempt}`)!;
  assert.equal(late.late, true);
  assert.equal(late.trace.providerResponseId, 'resp_offline_late');
  assert.deepEqual(late.trace.usage, [{ total_tokens: 7 }]);

  const request = (session: string, withAccess = true) => new NextRequest(`http://localhost/api/projects/${project.id}`, {
    headers: { cookie: `countershot_session=${session}${withAccess ? '; countershot_access=' + store.bytesHash(accessCode) : ''}` },
  });
  const ctx = { params: Promise.resolve({ id: project.id }) };
  for (const endpoint of [state, exportProject]) {
    assert.equal((await endpoint(request(ownerSession, false), ctx)).status, 401);
    assert.equal((await endpoint(request(strangerSession), ctx)).status, 404);
    assert.equal((await endpoint(request(''), ctx)).status, 404);
    const response = await endpoint(request(ownerSession), ctx);
    assert.equal(response.status, 200);
    const text = await response.text();
    const output = JSON.parse(text);
    assert.equal(output.project.ownerHash, undefined);
    assert.equal(output.modelTraces.length, 2);
    assert.equal(output.modelAttemptTraces.length, 2);
    assert.ok(output.modelTraces.some((record: { trace: { providerResponseId: string } }) => record.trace.providerResponseId === 'resp_offline_complete'));
    assert.ok(output.modelAttemptTraces.some((record: { late: boolean; trace: { providerResponseId: string } }) => record.late && record.trace.providerResponseId === 'resp_offline_late'));
    for (const sentinel of [fakeKey, fakeHeader, accessCode, ownerSession, strangerSession, foreignTraceId]) assert.equal(text.includes(sentinel), false);
  }
  const saved = JSON.stringify(store.list('model_traces', project.id)) + JSON.stringify(store.list('model_attempt_traces', project.id));
  assert.equal(saved.includes(fakeKey), false);
  assert.equal(saved.includes(fakeHeader), false);
  assert.equal(posts, 2);
  assert.equal(get.mock.callCount(), 0);
  console.log('Trace export regression passed');
} finally {
  post.mock.restore();
  get.mock.restore();
  store.db.close();
  delete (globalThis as { countershotDb?: unknown }).countershotDb;
}
