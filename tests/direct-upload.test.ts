import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
async function regression(scenario: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'countershot-direct-test-'));
  try {
    const { NODE_TEST_CONTEXT: _testContext, ...environment } = process.env;
    await run(process.execPath, ['--import', 'tsx', 'tests/fixtures/direct-upload-regression.ts', scenario], {
      cwd: repoRoot, timeout: 90_000, maxBuffer: 1_000_000,
      env: { ...environment, DATA_ROOT: root, ASSET_ROOT: path.join(root, 'assets'), DATABASE_PATH: path.join(root, 'test.sqlite'),
        MODEL_API_KEY: '', APP_ACCESS_CODE: 'isolated-direct-access', PUBLIC_API_ORIGIN: '', APP_PUBLIC_ORIGIN: '',
        MAX_CLIP_BYTES: '', MAX_CLIP_SECONDS: '' },
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('direct-upload origin configuration has an explicit local fallback and otherwise fails closed', () => regression('configuration'));
test('only the owning browser with application access can mint scoped hashed upload tickets', () => regression('mint-access'));
test('direct upload rejects invalid origin and capability before reading or consuming a valid ticket', () => regression('lifecycle'));
test('expired tickets, mismatched purposes and oversized bodies remain single-use', () => regression('expiry-purpose'));
test('direct-upload CORS preflight grants only the exact frontend origin, POST and required headers', () => regression('cors'));
test('concurrent uses of one upload ticket read and commit exactly one upload', () => regression('race'));
test('direct MOV and WebM uploads retain source/trial ownership and private original evidence', () => regression('media'));
