import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import type { ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses';
import { demoFacts, demoObservation, demoProposal } from '../src/domain/demo';
import { plan, observe, type ModelTrace } from '../src/meta';
import { createMetaClient, MetaError } from '../src/meta/client';
import { describePlanningEvidence, planningEvidenceHash, PLANNING_EVIDENCE_LIMITS,
  type GroundedMediaAsset, type PlanningEvidenceContext } from '../src/meta/evidence';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const sourceContext: PlanningEvidenceContext = {
  version: 'grounded-evidence-v1', sourceStatus: 'observation_bound', sourceObservationIds: ['observed-cycle'],
};
const planInput = { goal: 'Offline grounded planning contract', facts: demoFacts,
  observation: demoObservation, parent: null, feedback: null };
const reply = (output: unknown = demoProposal) => ({ id: 'response-grounded-offline', model: 'muse-spark-1.3',
  status: 'completed', usage: { total_tokens: 2 }, output: [{ type: 'message', role: 'assistant',
    id: 'message-grounded-offline', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] });

async function withMedia(run: (make: (id: string, mime?: string, observationIds?: string[]) => Promise<{ asset: GroundedMediaAsset; bytes: Buffer }>) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'countershot-grounded-adapter-'));
  try {
    await run(async (id, mime = 'image/png', observationIds = []) => {
      // These are byte-identity fixtures. Real media decoding is covered at ingestion.
      const bytes = Buffer.from(`synthetic offline canonical bytes for ${id}`);
      const filename = path.join(directory, id);
      await writeFile(filename, bytes);
      return { bytes, asset: { id, path: filename, mime, sha256: sha256(bytes), byteLength: bytes.length,
        durationMs: mime === 'video/mp4' ? 30_000 : null, createdAt: '2026-11-01T12:00:00.000Z', observationIds } };
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function withProvider(run: (client: ReturnType<typeof createMetaClient>) => Promise<void>) {
  const previous = process.env.MODEL_API_KEY;
  process.env.MODEL_API_KEY = 'offline-fixture-not-a-credential';
  const client = createMetaClient();
  // Fail closed: every test overrides only the calls it expects to perform.
  const create = mock.method(client.responses, 'create', (() => { throw new Error('Unexpected offline generation'); }) as typeof client.responses.create);
  const upload = mock.method(client.files, 'create', (() => { throw new Error('Unexpected offline upload'); }) as unknown as typeof client.files.create);
  try { await run(client); }
  finally {
    create.mock.restore(); upload.mock.restore();
    if (previous === undefined) delete process.env.MODEL_API_KEY; else process.env.MODEL_API_KEY = previous;
  }
}

test('the evidence record distinguishes observation-bound sources, failed trials and unknown capture time', async () => {
  await withMedia(async make => {
    const { asset: source } = await make('source', 'image/png', sourceContext.sourceObservationIds);
    const { asset: trial } = await make('trial', 'image/jpeg');
    const manifest = describePlanningEvidence([source], [trial], sourceContext);
    assert.equal(manifest.mediaRepresentation, 'canonical_application_media');
    assert.deepEqual(manifest.sourceObservationIds, ['observed-cycle']);
    assert.deepEqual(manifest.assets.map(asset => [asset.assetId, asset.role, asset.observationIds]), [
      ['source', 'original_source', ['observed-cycle']], ['trial', 'failed_trial', []],
    ]);
    assert(manifest.assets.every(asset => asset.captureTimeStatus === 'unknown' && asset.uploadedAt === source.createdAt));
    assert(!JSON.stringify(manifest).includes(source.path));
    assert.equal(describePlanningEvidence([], [], sourceContext).sourceStatus, 'observation_bound');
    assert.deepEqual(describePlanningEvidence([], [], sourceContext).sourceObservationIds, ['observed-cycle']);
    assert.throws(() => describePlanningEvidence([source], [], { ...sourceContext, sourceStatus: 'historical_unavailable', sourceObservationIds: [] }),
      (error: unknown) => error instanceof MetaError && error.code === 'invalid_planning_evidence');
    assert.throws(() => describePlanningEvidence([], [{ ...trial, observationIds: ['observed-cycle'] }], sourceContext),
      (error: unknown) => error instanceof MetaError && error.code === 'invalid_planning_evidence');
  });
});

test('separate source and trial budgets preserve revision headroom and reject over-limit roles without dropping evidence', async () => {
  await withMedia(async make => {
    const { asset } = await make('budget-base');
    const size = PLANNING_EVIDENCE_LIMITS.maxFileBytes;
    const sources = Array.from({ length: 8 }, (_, index) => ({ ...asset, id: `parent-source-${index}`,
      mime: 'video/mp4', byteLength: 100 * 1024 * 1024 / 8, durationMs: 360_000 / 8,
      observationIds: sourceContext.sourceObservationIds }));
    const trials = Array.from({ length: 4 }, (_, index) => ({ ...asset, id: `revision-trial-${index}`,
      mime: 'video/mp4', byteLength: 50 * 1024 * 1024 / 4, durationMs: 180_000 / 4 }));
    // A parent using its full source allowance can still attach a full new trial.
    const manifest = describePlanningEvidence(sources, trials, sourceContext);
    assert.equal(describePlanningEvidence(sources, [], sourceContext).assets.length, 8);
    assert.equal(manifest.assets.length, 12);
    assert.equal(manifest.assets.reduce((total, asset) => total + asset.byteLength, 0), 150 * 1024 * 1024);
    assert.equal(manifest.assets.reduce((total, asset) => total + (asset.durationMs || 0), 0), 540_000);
    assert.deepEqual(manifest.assets.slice(0, 8).map(asset => asset.assetId), sources.map(asset => asset.id));
    assert(manifest.assets.slice(8).every(asset => asset.role === 'failed_trial'));
    const rejected: [string, GroundedMediaAsset[], GroundedMediaAsset[]][] = [
      ['ninth original', [...sources, { ...sources[0], id: 'ninth-source', byteLength: 1, durationMs: 1 }], []],
      ['fifth trial', [], [...trials, { ...trials[0], id: 'fifth-trial', byteLength: 1, durationMs: 1 }]],
      ['single original over 50 MiB', [{ ...sources[0], byteLength: size + 1 }], []],
      ['single trial over 50 MiB', [], [{ ...trials[0], byteLength: size + 1 }]],
      ['source total one byte over', sources.map((asset, index) => ({ ...asset, byteLength: asset.byteLength + (index === 0 ? 1 : 0) })), []],
      ['trial total one byte over', [], trials.map((asset, index) => ({ ...asset, byteLength: asset.byteLength + (index === 0 ? 1 : 0) }))],
      ['source video one millisecond over', sources.map((asset, index) => ({ ...asset, durationMs: asset.durationMs + (index === 0 ? 1 : 0) })), []],
      ['trial video one millisecond over', [], trials.map((asset, index) => ({ ...asset, durationMs: asset.durationMs + (index === 0 ? 1 : 0) }))],
    ];
    for (const [reason, selectedSources, selectedTrials] of rejected) assert.throws(() => describePlanningEvidence(selectedSources, selectedTrials, sourceContext),
      (error: unknown) => error instanceof MetaError && error.code === 'planning_evidence_limit', reason);
  });
});

test('planning sends exact original and failed-trial image bytes alongside their immutable evidence manifest', async () => {
  await withMedia(async make => withProvider(async client => {
    const source = await make('original-frame', 'image/png', sourceContext.sourceObservationIds);
    const trial = await make('failed-trial-frame', 'image/jpeg');
    const requests: any[] = [], checkpoints: ModelTrace[] = [];
    const generate = mock.method(client.responses, 'create', (async (body: ResponseCreateParamsNonStreaming) => { requests.push(body); return reply(); }) as unknown as typeof client.responses.create);
    try {
      const result = await plan({ ...planInput, sourceAssets: [source.asset], trialAssets: [trial.asset], evidenceContext: sourceContext,
        onTrace: async trace => { checkpoints.push(structuredClone(trace)); } });
      assert.equal(requests.length, 1);
      const content = requests[0].input[0].content;
      const input = JSON.parse(content[0].text);
      assert.deepEqual(input.observation, demoObservation);
      assert.equal(input.observationProvenance, 'inferred_or_synthetic_summary_not_confirmed_fact');
      assert.deepEqual(content.filter((item: any) => item.type === 'input_image').map((item: any) => item.image_url), [
        `data:image/png;base64,${source.bytes.toString('base64')}`, `data:image/jpeg;base64,${trial.bytes.toString('base64')}`,
      ]);
      assert.match(content[1].text, /ORIGINAL TASK SOURCE.*original-frame/);
      assert.match(content[3].text, /FAILED TRIAL.*failed-trial-frame/);
      assert.deepEqual(input.evidenceManifest, describePlanningEvidence([source.asset], [trial.asset], sourceContext));
      assert.deepEqual(input.trialEvidence, input.evidenceManifest.assets.filter((asset: any) => asset.role === 'failed_trial'));
      assert.deepEqual(result.trace.planningEvidence, input.evidenceManifest);
      assert.equal(result.trace.planningEvidenceHash, planningEvidenceHash(input.evidenceManifest));
      assert(checkpoints.length > 0 && checkpoints.every(trace => trace.planningEvidenceHash === result.trace.planningEvidenceHash));
      assert.match(requests[0].instructions, /Uploaded times do not establish capture freshness/);
      assert.match(requests[0].instructions, /untrusted task data/);
    } finally { generate.mock.restore(); }
  }));
});

test('planning uploads the same verified buffers after file replacement and freezes caller selection before asynchronous work', async () => {
  await withMedia(async make => withProvider(async client => {
    const source = await make('original-video', 'video/mp4', sourceContext.sourceObservationIds);
    const trial = await make('trial-photo');
    const requests: any[] = [], uploadedBytes: Buffer[] = [];
    const generate = mock.method(client.responses, 'create', (async (body: ResponseCreateParamsNonStreaming) => { requests.push(body); return reply(); }) as unknown as typeof client.responses.create);
    const upload = mock.method(client.files, 'create', (async (body: { file: unknown }) => {
      uploadedBytes.push(Buffer.from(await (body.file as File).arrayBuffer()));
      return { id: 'file-verified-video' };
    }) as unknown as typeof client.files.create);
    let checkpoint = 0;
    try {
      const result = await plan({ ...planInput, sourceAssets: [source.asset], trialAssets: [trial.asset], evidenceContext: sourceContext,
        onTrace: async () => {
          checkpoint++;
          if (checkpoint === 1) source.asset.sha256 = '0'.repeat(64); // Selection was already copied.
          if (checkpoint === 2) {
            // All selected media was read and hashed before this attachment checkpoint.
            await writeFile(source.asset.path, Buffer.alloc(source.bytes.length, 120));
            await writeFile(trial.asset.path, Buffer.alloc(trial.bytes.length, 121));
          }
        } });
      assert.deepEqual(uploadedBytes, [source.bytes]);
      const content = requests[0].input[0].content;
      assert.deepEqual(content.find((item: any) => item.type === 'input_file'), { type: 'input_file', file_id: 'file-verified-video' });
      assert.equal(content.find((item: any) => item.type === 'input_image').image_url, `data:image/png;base64,${trial.bytes.toString('base64')}`);
      assert.equal(result.trace.planningEvidence?.assets[0].sha256, sha256(source.bytes));
      assert.deepEqual(result.trace.uploadedFileIds, ['file-verified-video']);
    } finally { generate.mock.restore(); upload.mock.restore(); }
  }));
});

test('a corrupt later trial file prevents every upload and generation in the selected bundle', async () => {
  await withMedia(async make => withProvider(async client => {
    const source = await make('valid-video', 'video/mp4', sourceContext.sourceObservationIds);
    const trial = await make('changed-trial');
    await writeFile(trial.asset.path, Buffer.alloc(trial.bytes.length, 120));
    let uploads = 0, requests = 0;
    const upload = mock.method(client.files, 'create', (() => { uploads++; throw new Error('Should not upload'); }) as unknown as typeof client.files.create);
    const generate = mock.method(client.responses, 'create', (() => { requests++; throw new Error('Should not generate'); }) as typeof client.responses.create);
    try {
      await assert.rejects(plan({ ...planInput, sourceAssets: [source.asset], trialAssets: [trial.asset], evidenceContext: sourceContext }), (error: unknown) => {
        assert(error instanceof MetaError);
        assert.equal(error.code, 'invalid_planning_evidence');
        const trace = error.trace as ModelTrace;
        assert.equal(trace.planningEvidence?.assets.length, 2);
        assert.deepEqual(trace.uploadedFileIds, []);
        return true;
      });
      assert.equal(uploads, 0); assert.equal(requests, 0);
    } finally { generate.mock.restore(); upload.mock.restore(); }
  }));
});

test('failed partial upload retains successful provider file IDs and the complete selected manifest for cleanup', async () => {
  await withMedia(async make => withProvider(async client => {
    const source = await make('source-video', 'video/mp4', sourceContext.sourceObservationIds);
    const trial = await make('trial-video', 'video/mp4');
    let uploads = 0;
    const upload = mock.method(client.files, 'create', (async () => {
      if (++uploads === 1) return { id: 'file-first-upload-retained' };
      throw new MetaError('Offline second upload failed', 'provider_error');
    }) as unknown as typeof client.files.create);
    const checkpoints: ModelTrace[] = [];
    try {
      await assert.rejects(plan({ ...planInput, sourceAssets: [source.asset], trialAssets: [trial.asset], evidenceContext: sourceContext,
        onTrace: async trace => { checkpoints.push(structuredClone(trace)); } }), (error: unknown) => {
        assert(error instanceof MetaError);
        assert.equal(error.code, 'provider_error');
        const trace = error.trace as ModelTrace;
        assert.deepEqual(trace.uploadedFileIds, ['file-first-upload-retained']);
        assert.equal(trace.planningEvidence?.assets.length, 2);
        assert.equal(trace.planningEvidenceHash, planningEvidenceHash(trace.planningEvidence!));
        return true;
      });
      assert.equal(uploads, 2);
      assert(checkpoints.some(trace => trace.uploadedFileIds?.includes('file-first-upload-retained')));
    } finally { upload.mock.restore(); }
  }));
});

test('a rejected final model answer retains paid-response identity and original evidence provenance', async () => {
  await withMedia(async make => withProvider(async client => {
    const source = await make('original', 'image/png', sourceContext.sourceObservationIds);
    const generate = mock.method(client.responses, 'create', (async () => reply({ unexpected: 'invalid structured output' })) as unknown as typeof client.responses.create);
    try {
      await assert.rejects(plan({ ...planInput, sourceAssets: [source.asset], evidenceContext: sourceContext }), (error: unknown) => {
        assert(error instanceof MetaError);
        assert.equal(error.code, 'invalid_output');
        const trace = error.trace as ModelTrace;
        assert.deepEqual(trace.responseIds, ['response-grounded-offline']);
        assert.equal(trace.providerResponseId, 'response-grounded-offline');
        assert.deepEqual(trace.usage, [{ total_tokens: 2 }]);
        assert.equal(trace.planningEvidence?.assets[0].sha256, source.asset.sha256);
        assert.equal(trace.planningEvidenceHash, planningEvidenceHash(trace.planningEvidence!));
        return true;
      });
    } finally { generate.mock.restore(); }
  }));
});

test('grounded observation rejects changed saved pixels before a generation can produce a trusted summary', async () => {
  await withMedia(async make => withProvider(async () => {
    const source = await make('source-to-observe');
    await writeFile(source.asset.path, Buffer.alloc(source.bytes.length, 120));
    await assert.rejects(observe({ goal: 'Offline observation grounding', notes: '', assets: [source.asset] }),
      (error: unknown) => error instanceof MetaError && error.code === 'invalid_planning_evidence');
  }));
});
