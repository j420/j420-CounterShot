import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const run=promisify(execFile);
const base=process.env.SMOKE_BASE_URL||'http://127.0.0.1:3001';
let cookie='';
const cookieJar=new Map<string,string>();
async function json(url:string,body:unknown){const r=await fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});for(const header of r.headers.getSetCookie()){const pair=header.split(';')[0];cookieJar.set(pair.slice(0,pair.indexOf('=')),pair);}cookie=[...cookieJar.values()].join('; ');const value=await r.json();assert.ok(r.ok,value.error);return value;}
if(process.env.APP_ACCESS_CODE)await json('/api/session',{accessCode:process.env.APP_ACCESS_CODE});
const {project}=await json('/api/projects',{title:'Synthetic media validation',workflow:'workshop_jig',goal:'Decode synthetic media only; no actual packing or physical trial.',finishedDefinition:'Software upload verification only',demo:false});
const root=await mkdtemp(path.join(os.tmpdir(),'countershot-media-'));
try{
 const mp4=path.join(root,'synthetic.mp4'),png=path.join(root,'synthetic.png');
 await run('ffmpeg',['-v','error','-nostdin','-f','lavfi','-i','color=c=beige:s=320x240:r=10','-t','1','-c:v','libx264','-pix_fmt','yuv420p',mp4]);
 await run('ffmpeg',['-v','error','-nostdin','-i',mp4,'-frames:v','1','-threads','1',png]);
 for(const [file,mime] of [[mp4,'video/mp4'],[png,'image/png']]){
  const bytes=await readFile(file);const form=new FormData();form.set('file',new File([new Uint8Array(bytes)],path.basename(file),{type:mime}));form.set('purpose','source');
  const r=await fetch(`${base}/api/projects/${project.id}/assets`,{method:'POST',headers:{Cookie:cookie},body:form});const value=await r.json();assert.equal(r.status,201,value.error);assert.equal(value.asset.mime,mime);assert.equal(value.asset.purpose,'source');if(mime==='video/mp4')assert.equal(value.asset.durationMs,1000);
  const download=await fetch(`${base}/api/projects/${project.id}/assets/${value.asset.id}`,{headers:{Cookie:cookie}});assert.equal(download.status,200);assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
  const denied=await fetch(`${base}/api/projects/${project.id}/assets/${value.asset.id}`);assert.ok([401,404].includes(denied.status));
 }
 const bad=new FormData();bad.set('file',new File(['This is not a video.'],'forged.mp4',{type:'video/mp4'}));const invalid=await fetch(`${base}/api/projects/${project.id}/assets`,{method:'POST',headers:{Cookie:cookie},body:bad});assert.equal(invalid.status,415);
 console.log('Media smoke passed: decoded MP4/PNG, duration, byte-exact protected retrieval, unrelated-browser denial and forged-type rejection. No Meta request or physical trial occurred.');
}finally{await rm(root,{recursive:true,force:true});}
