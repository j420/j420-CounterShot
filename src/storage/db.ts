import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const dataRoot = path.resolve(/* turbopackIgnore: true */ process.env.DATA_ROOT || path.join(process.cwd(),'data'));
export const assetRoot = path.resolve(/* turbopackIgnore: true */ process.env.ASSET_ROOT || path.join(dataRoot,'assets'));
mkdirSync(dataRoot,{recursive:true});
mkdirSync(assetRoot,{recursive:true});
const dbPath=process.env.DATABASE_PATH || path.join(dataRoot,'countershot.sqlite');
mkdirSync(path.dirname(dbPath),{recursive:true});
const globalDb=globalThis as unknown as {countershotDb?:DatabaseSync};
// Install the busy handler before WAL/schema initialization: independent Next
// build workers and the web/queue processes can open a fresh database together.
export const db=globalDb.countershotDb ?? new DatabaseSync(dbPath,{timeout:5000});
globalDb.countershotDb=db;
db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
// SQLite can return BUSY immediately when journal-mode conversion needs to
// upgrade its lock, even with a busy handler. Retry only that startup operation.
const journalDeadline=Date.now()+5000;
const journalWait=new Int32Array(new SharedArrayBuffer(4));
for(;;){
 try{db.exec('PRAGMA journal_mode=WAL;');break;}
 catch(error){
  if(!error||typeof error!=='object'||!('errcode' in error)||error.errcode!==5||Date.now()>=journalDeadline)throw error;
  Atomics.wait(journalWait,0,0,Math.min(25,journalDeadline-Date.now()));
 }
}
db.exec(`
CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL,id TEXT NOT NULL,project_id TEXT NOT NULL,json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(collection,id));
CREATE INDEX IF NOT EXISTS records_project ON records(project_id,collection,created_at);
CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY,project_id TEXT NOT NULL,operation_id TEXT NOT NULL,request_hash TEXT NOT NULL,status TEXT NOT NULL,lease_until TEXT,json TEXT NOT NULL,UNIQUE(project_id,operation_id));
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status,lease_until);
PRAGMA user_version=1;`);

export function now(){return new Date().toISOString();}
export function id(){return randomUUID();}
function canonical(value:unknown):string {
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value && typeof value==='object')return '{'+Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).filter(([,v])=>v!==undefined).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
 return JSON.stringify(value) ?? 'null';
}
export function hash(value:unknown){return createHash('sha256').update(canonical(value)).digest('hex');}
export function bytesHash(value:Buffer|string){return createHash('sha256').update(value).digest('hex');}
export function transaction<T>(fn:()=>T):T{ db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;} }
export function insert<T extends {id:string;projectId?:string;createdAt?:string}>(collection:string,value:T){db.prepare('INSERT INTO records(collection,id,project_id,json,created_at) VALUES(?,?,?,?,?)').run(collection,value.id,value.projectId||value.id,JSON.stringify(value),value.createdAt||now());return value;}
export function replace<T extends {id:string}>(collection:string,value:T){const r=db.prepare('UPDATE records SET json=? WHERE collection=? AND id=?').run(JSON.stringify(value),collection,value.id);if(!r.changes)throw new Error('Record no longer exists');return value;}
export function get<T>(collection:string,recordId:string):T|null{const r=db.prepare('SELECT json FROM records WHERE collection=? AND id=?').get(collection,recordId) as {json:string}|undefined;return r?JSON.parse(r.json):null;}
export function list<T>(collection:string,projectId?:string):T[]{const rows=(projectId?db.prepare('SELECT json FROM records WHERE collection=? AND project_id=? ORDER BY created_at ASC,id ASC').all(collection,projectId):db.prepare('SELECT json FROM records WHERE collection=? ORDER BY created_at DESC,id DESC').all(collection)) as {json:string}[];return rows.map(r=>JSON.parse(r.json));}
