import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('owner trace API and export retain normal and late attempts without provider credentials', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'countershot-trace-test-'));
  const repoRoot = fileURLToPath(new URL('../', import.meta.url));
  try {
    const { NODE_TEST_CONTEXT: _testContext, ...environment } = process.env;
    await promisify(execFile)(process.execPath, ['--import', 'tsx', 'tests/fixtures/trace-export-regression.ts'], {
      cwd: repoRoot, timeout: 30_000, maxBuffer: 1_000_000,
      env: { ...environment, DATA_ROOT: root, DATABASE_PATH: path.join(root, 'test.sqlite'), ASSET_ROOT: path.join(root, 'assets'),
        MODEL_API_KEY: '', APP_ACCESS_CODE: '' },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
