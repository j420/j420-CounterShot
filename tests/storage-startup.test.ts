import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('database startup waits for an existing writer before configuring WAL and schema', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'countershot-startup-test-'));
  const dbPath = path.join(root, 'test.sqlite');
  const blocker = new DatabaseSync(dbPath);
  blocker.exec('CREATE TABLE startup_fixture(value TEXT); BEGIN IMMEDIATE; INSERT INTO startup_fixture VALUES(\'held\');');
  let locked = true;
  let release: ReturnType<typeof setTimeout> | undefined;
  let watch: ReturnType<typeof setInterval> | undefined;
  try {
    const { NODE_TEST_CONTEXT: _context, ...environment } = process.env;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      "import {writeFileSync} from 'node:fs'; import {DatabaseSync} from 'node:sqlite'; const execute=DatabaseSync.prototype.exec; let marked=false; DatabaseSync.prototype.exec=function(sql){if(!marked&&sql.includes('PRAGMA journal_mode=WAL')){marked=true;writeFileSync(process.env.DATA_ROOT+'/opening','started');} return execute.call(this,sql);}; const {db}=await import('./src/storage/db.ts'); db.close(); writeFileSync(process.env.DATA_ROOT+'/ready','done');"], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: { ...environment, DATA_ROOT: root, DATABASE_PATH: dbPath, ASSET_ROOT: path.join(root, 'assets'), MODEL_API_KEY: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let errors = '';
    child.stdout!.resume();
    watch = setInterval(() => {
      if (!existsSync(path.join(root, 'opening')) || release) return;
      release = setTimeout(() => { blocker.exec('COMMIT'); locked = false; }, 750);
    }, 10);
    child.stderr!.on('data', chunk => { errors += chunk; });
    const timeout = setTimeout(() => child.kill(), 15_000);
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    clearTimeout(timeout);
    assert.equal(code, 0, `${errors}\nWriter still locked: ${locked}`);
    assert.equal(existsSync(path.join(root, 'ready')), true);
    assert.equal(locked, false, 'the import waited until the competing write completed');
    const verified = new DatabaseSync(dbPath);
    try {
      assert.equal(verified.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
      assert.equal(verified.prepare('SELECT COUNT(*) AS count FROM records').get()?.count, 0);
      assert.equal(verified.prepare('SELECT COUNT(*) AS count FROM jobs').get()?.count, 0);
    } finally { verified.close(); }
  } finally {
    if (release) clearTimeout(release);
    if (watch) clearInterval(watch);
    if (locked) blocker.exec('ROLLBACK');
    blocker.close();
    await rm(root, { recursive: true, force: true });
  }
});
