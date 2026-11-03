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
  const root = await mkdtemp(path.join(os.tmpdir(), 'countershot-camera-api-'));
  try {
    const { NODE_TEST_CONTEXT: _context, ...environment } = process.env;
    await run(process.execPath, ['--import', 'tsx', 'tests/fixtures/camera-server-regression.ts', scenario], {
      cwd: repo, timeout: 90_000, maxBuffer: 1_000_000,
      env: { ...environment, DATA_ROOT: root, DATABASE_PATH: path.join(root, 'test.sqlite'), ASSET_ROOT: path.join(root, 'assets'),
        MODEL_API_KEY: 'offline-camera-fixture-key', APP_ACCESS_CODE: '', APP_PUBLIC_ORIGIN: '', PUBLIC_API_ORIGIN: '' },
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('camera sessions preserve access-code and browser ownership without leaking private storage', () => regression('ownership'));
test('camera frame analysis is idempotent and before/after review never advances automatically', () => regression('cycle'));
test('view and measurement requests are completed saved decisions that cannot authorize actions or progression', () => regression('request-decisions'));
test('numeric request answers fill unknown prerequisites once and preserve admitted predictions without becoming result readings', () => regression('numeric-answer'));
test('new-view answers reject repeated source pixels and retain failed attempts for explicit idempotent retry', () => regression('view-answer-retry'));
test('cancelling a pending evidence request fences late guidance and preserves paid work as history', () => regression('request-cancel'));
test('operator identity and actual recheck APIs retain counterevidence and immutable idempotent receipts', () => regression('reasoning-memory-api'));
test('checked plan acceptance reopens only mandatory earlier phases and cannot replay a phase rewind', () => regression('plan-change-api'));
test('a reserved continuation carrying an earlier response ID is fenced again after a facts reset', () => regression('reserved-continuation-reset'));
test('the camera API reserves a shared durable budget before both owned-evidence model calls and preserves the historical crop manifest', () => regression('durable-owned-retrieval'));
test('shared camera call, output and deadline limits block new media despite few turns and cannot be refilled by facts reset', () => regression('durable-shared-budget'));
test('a facts reset after the second durable reservation fences its POST while late snapshots preserve a newer camera invocation', () => regression('durable-retrieval-reset'));
test('a paid mixed-intent response remains auditable without becoming camera guidance', () => regression('mixed-decision'));
test('successive after views retain the exact original prediction independently from the comparison image', () => regression('prediction-context'));
test('a valid latest comparison cannot hide substitution of the original action prediction', () => regression('prediction-ownership'));
test('historical mixed-intent assessments stay readable and held without becoming new decisions', () => regression('legacy-decision'));
test('an in-flight camera result cannot overwrite revised facts and duplicated requests do not repeat inference', () => regression('stale'));
test('concurrent identical camera submissions publish one frame and start only one assessment', () => regression('concurrent'));
test('expired camera inference stays unknown and late paid usage cannot restore actionable guidance', () => regression('expiry'));
test('a newer failed camera view cannot revive an older ready-to-confirm assessment', () => regression('withdrawal-failure'));
test('expiry of a newer camera view withdraws old guidance while retaining its valid before anchor', () => regression('withdrawal-expiry'));
test('invalid camera media and metadata fail before inference or retained frame records', () => regression('validation'));
test('failed camera inference retains its exact frame and safe provider trace', () => regression('failure'));
test('camera session budgets and cross-session pending limits are enforced before inference', () => regression('budgets'));
test('camera frame publication rolls back database state and removes files on audit failure', () => regression('rollback'));
test('a facts reset before assessment starts prevents a stale paid camera request', () => regression('before-request-reset'));
test('a facts reset after initial preparation is fenced immediately before the camera provider POST', () => regression('prepared-request-reset'));
test('an expired pending camera check cannot start a provider request', () => regression('before-request-expiry'));
test('after-view retry binds its image and expected result to the retained before assessment', () => regression('comparison-context'));
test('a corrupted retained before image fails before a camera provider request', () => regression('comparison-hash'));
test('invalid camera comparison ownership and associations fail before inference and retained files', () => regression('comparison-ownership'));
test('completed historical workflows require an explicit reset when quantitative criteria change', () => regression('workflow-upgrade'));
test('unversioned camera sessions remain readable and held until facts are reconfirmed', () => regression('workflow-legacy'));
test('workflow criteria changed during preparation prevent a paid camera request', () => regression('prepared-workflow-upgrade'));
test('a paid result under changed workflow criteria remains historical without advancing', () => regression('paid-workflow-upgrade'));
test('an explicit legacy facts reset detaches a pending check and late paid usage cannot lock or overwrite the new run', () => regression('workflow-pending-reset'));
