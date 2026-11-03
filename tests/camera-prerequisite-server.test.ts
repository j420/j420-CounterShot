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
  const root = await mkdtemp(path.join(os.tmpdir(), 'countershot-camera-prerequisite-'));
  try {
    const { NODE_TEST_CONTEXT: _context, ...environment } = process.env;
    await run(process.execPath, ['--import', 'tsx', 'tests/fixtures/camera-prerequisite-server-regression.ts', scenario], {
      cwd: repo, timeout: 90_000, maxBuffer: 1_000_000,
      env: { ...environment, DATA_ROOT: root, DATABASE_PATH: path.join(root, 'test.sqlite'), ASSET_ROOT: path.join(root, 'assets'),
        MODEL_API_KEY: 'offline-prerequisite-fixture-key', APP_ACCESS_CODE: '', APP_PUBLIC_ORIGIN: '', PUBLIC_API_ORIGIN: '' },
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('camera bootstrap establishes ownership before paid intake and draft confirmation retains exact source provenance', () => regression('bootstrap-adoption'));
test('a late-phase prerequisite preserves reviewed work and old receipt replay cannot rewind it or cross ownership', () => regression('late-phase-replay'));
test('foreign, changed and old-scene draft evidence cannot become a confirmed prerequisite', () => regression('draft-integrity'));
test('in-flight camera checks fence prerequisite mutations without another inference', () => regression('pending'));
test('prerequisite routes reject unconfirmed, stale, later-phase and incompatible-unit inputs before mutation', () => regression('invalid-input'));
