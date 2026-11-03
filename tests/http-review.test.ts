import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../', import.meta.url));

async function regression(fixture: string, scenario?: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'countershot-http-test-'));
  try {
    const { NODE_TEST_CONTEXT: _testContext, ...environment } = process.env;
    // Fixture assertions fail the subprocess, so a nonzero exit fails this test.
    await run(process.execPath, ['--import', 'tsx', path.join(repoRoot, 'tests/fixtures', fixture), ...(scenario ? [scenario] : [])], {
      cwd: repoRoot, timeout: 90_000, maxBuffer: 1_000_000,
      env: { ...environment, DATA_ROOT: root, ASSET_ROOT: path.join(root, 'assets'), DATABASE_PATH: path.join(root, 'test.sqlite'),
        MODEL_API_KEY: '', APP_ACCESS_CODE: 'isolated-http-test-access', MAX_CLIP_BYTES: '', MAX_CLIP_SECONDS: '' },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// Subprocesses keep these DBs separate under npm's --test-isolation=none setting.
// No provider requests or existing project/media files are used.
test('JSON and multipart limits stop streamed bodies early and validate Content-Length', () => regression('http-body-regression.ts'));
test('valid MP4, PNG and JPEG uploads remain decodable and privately retrievable', () => regression('http-media-regression.ts', 'valid'));
test('a single decoded video frame retains its full positive display duration', () => regression('http-media-regression.ts', 'single-frame'));
test('header-only MP4, audio cover art and corrupt images cannot become trial evidence', () => regression('http-media-regression.ts', 'invalid'));
test('decoded video duration cannot bypass the limit with misleading container metadata', () => regression('http-media-regression.ts', 'duration'));
test('one final frame beyond the clip limit cannot hide behind understated container metadata', () => regression('http-media-regression.ts', 'duration-final-frame'));
test('concurrent media uploads enforce the project quota in the insertion transaction', () => regression('http-media-regression.ts', 'quota'));
test('failed asset transactions leave no saved asset or media file', () => regression('http-media-regression.ts', 'rollback'));
