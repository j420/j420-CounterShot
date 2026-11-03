import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const repo = fileURLToPath(new URL('../', import.meta.url));
async function regression(scenario: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'countershot-camera-intake-'));
  try {
    const { NODE_TEST_CONTEXT: _context, ...environment } = process.env;
    await run(process.execPath, ['--import', 'tsx', 'tests/fixtures/camera-intake-regression.ts', scenario], {
      cwd: repo, timeout: 90_000, maxBuffer: 1_000_000,
      env: { ...environment, DATA_ROOT: root, DATABASE_PATH: path.join(root, 'test.sqlite'), ASSET_ROOT: path.join(root, 'assets'),
        MODEL_API_KEY: 'offline-intake-fixture-key', APP_ACCESS_CODE: '', APP_PUBLIC_ORIGIN: '', PUBLIC_API_ORIGIN: '' },
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('scene intake reserves real mocked model work durably, recovers operations and keeps frames private', () => regression('ownership'));
test('scene intake rejects invalid media and configuration before any provider POST', () => regression('validation'));
test('invalid scene drafts and output retain paid audit evidence without selecting a workflow', () => regression('invalid-output'));
test('scene retakes share one durable allowance and stop after three explicit analyses', () => regression('attempts'));
test('cancelling pending scene intake fences late publication while retaining response identity and usage', () => regression('cancel'));
test('cancellation fences a retake already decoding media while a fresh explicit revision can continue', () => regression('cancel-preflight'));
test('unknown scene inference is saved and duplicate operation recovery never repeats paid work', () => regression('unknown'));
test('scene adoption is explicit, exact and idempotent and never promotes draft facts', () => regression('adoption'));
test('unsupported scene intake cannot be adopted and altered pixels invalidate draft provenance', () => regression('unsupported-integrity'));
test('scene intake shares the live camera pending limit while ignoring expired pending turns', () => regression('pending-cap'));
test('an explicit scene reset prevents old intake drafts from claiming current fact provenance', () => regression('scene-reset'));
