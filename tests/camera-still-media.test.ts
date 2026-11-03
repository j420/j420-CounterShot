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
  const root = await mkdtemp(path.join(os.tmpdir(), 'countershot-camera-still-'));
  try {
    const { NODE_TEST_CONTEXT: _context, ...environment } = process.env;
    await run(process.execPath, ['--import', 'tsx', 'tests/fixtures/camera-still-media-regression.ts', scenario], {
      cwd: repo, timeout: 45_000, maxBuffer: 1_000_000,
      env: { ...environment, DATA_ROOT: root, DATABASE_PATH: path.join(root, 'test.sqlite'), ASSET_ROOT: path.join(root, 'assets'),
        MODEL_API_KEY: 'offline-still-fixture-no-provider', APP_ACCESS_CODE: '', APP_PUBLIC_ORIGIN: '', PUBLIC_API_ORIGIN: '' },
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('camera checkpoints reject animated PNG before assessment or stored evidence', () => regression('animation'));
test('camera checkpoints retain static PNG and JPEG bytes with private image access', () => regression('static'));
test('PNG text containing animation chunk names is still a valid static checkpoint', () => regression('text'));
test('small compressed high-resolution camera images fail before inference or retained evidence', () => regression('resolution'));
