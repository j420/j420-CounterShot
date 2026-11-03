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
  const root = await mkdtemp(path.join(os.tmpdir(), 'countershot-mobile-test-'));
  try {
    const { NODE_TEST_CONTEXT: _testContext, ...environment } = process.env;
    await run(process.execPath, ['--import', 'tsx', 'tests/fixtures/mobile-media-regression.ts', scenario], {
      cwd: repoRoot, timeout: 120_000, maxBuffer: 1_000_000,
      env: { ...environment, DATA_ROOT: root, ASSET_ROOT: path.join(root, 'assets'), DATABASE_PATH: path.join(root, 'test.sqlite'),
        MODEL_API_KEY: '', APP_ACCESS_CODE: '', MAX_CLIP_BYTES: '', MAX_CLIP_SECONDS: '' },
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('phone MOV and browser WebM source/trial clips normalize with original bytes and audio retained privately', () => regression('formats'));
test('compatible H264/AAC MP4 remains byte-exact for playback and original download', () => regression('passthrough'));
test('portrait rotation and available HEVC phone video normalize into ordinary portrait H264 MP4', () => regression('rotation-codec'));
test('normalization preserves variable video frame timestamps and complete audio duration', () => regression('timing'));
test('project storage quota includes newly retained originals and originals already stored', () => regression('quota'));
test('oversized normalized output and overlong mobile input fail without retained files or silent trimming', () => regression('bounds'));
test('failed normalized asset transactions remove both derivative and original', () => regression('rollback'));
