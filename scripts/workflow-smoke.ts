import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir,writeFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';

const base=process.env.SMOKE_BASE_URL||'http://127.0.0.1:3001';
const live=process.argv.includes('--live');
const kit=process.argv.includes('--kit');
const legacy=process.argv.includes('--carton');
const workshop=!kit&&!legacy;
const workflow=workshop?'workshop_jig':kit?'electronics_kit':'carton_packing';
let cookie='';
const cookieJar=new Map<string,string>();
async function request(path:string,body?:unknown){const r=await fetch(base+path,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined});for(const header of r.headers.getSetCookie()){const pair=header.split(';')[0];cookieJar.set(pair.slice(0,pair.indexOf('=')),pair);}cookie=[...cookieJar.values()].join('; ');const output=await r.json();assert.ok(r.ok,`${r.status}: ${output.error||path}`);return output;}
if(process.env.APP_ACCESS_CODE)await request('/api/session',{accessCode:process.env.APP_ACCESS_CODE});
const {project}=await request('/api/projects',{title:'Synthetic end-to-end verification',workflow,goal:workshop?'Synthetic software verification: design only a workshop jig for low-force precut instrument enclosure panel assembly. Locate the base, brace all loose walls during joining, keep joint windows open, remove and park the temporary gate, slide out the assembled workpiece, place it in the finished area and reset. No physical trial is claimed.':kit?'Synthetic software verification: fulfil the exact loose mechanical screw/washer/spacer/grommet counts into their separately closing labelled cells, include inventory slip, close carton, remove and reset with one confirmed hand. No physical trial is claimed.':'Synthetic software verification: pack a notebook and accompanying loose card with one confirmed hand, using prepared open top-opening tuck cartons and prepared inserts. No physical trial is claimed.',finishedDefinition:workshop?'All supplied panels joined within the declared alignment tolerance, temporary gate parked, finished assembly released and jig reset using only allowed resources.':'Correct contents, closed carton, parcel removed, station reset, only confirmed resources used.',demo:true});
let state=await request(`/api/projects/${project.id}`);
assert.ok(state.designs[0].artifacts,'Synthetic sample compiler must work');
assert.equal(state.trials.length,0,'A sample must not contain fabricated trials');
let jobId:string|null=null;
if(live){
 const operation=randomUUID();
 const {job}=await request(`/api/projects/${project.id}/jobs`,{kind:'plan',clientOperationId:operation});jobId=job.id;
 const duplicate=await request(`/api/projects/${project.id}/jobs`,{kind:'plan',clientOperationId:operation});assert.equal(duplicate.job.id,job.id);
 const started=Date.now();let lastStage='';
 while(Date.now()-started<480_000){state=await request(`/api/projects/${project.id}`);const current=state.jobs.find((j:any)=>j.id===job.id);if(current.stage!==lastStage){console.log(current.stage);lastStage=current.stage;}if(!['queued','running'].includes(current.status)){assert.equal(current.status,'completed',current.error||current.stage);break;}await pause(1500);}
 const final=state.jobs.find((j:any)=>j.id===job.id);assert.equal(final.status,'completed','Job exceeded the end-to-end test budget');
 const generated=state.designs.find((d:any)=>d.id===final.resultId);assert.equal(generated.source,'meta');assert.equal(generated.proposal.outcome,'candidate');assert.equal(generated.status,'checks_passed');assert.ok(generated.trace.providerResponseId);assert.ok(generated.artifacts);assert.equal(state.project.currentDesignId,generated.id);
}
const design=state.designs.find((d:any)=>d.id===state.project.currentDesignId);
for(const kind of [workshop?'parts.svg':'package.svg',workshop?'setup.svg':'station.svg','print.html','evidence.json']){const r=await fetch(`${base}/api/projects/${project.id}/designs/${design.id}/artifacts/${kind}`,{headers:{Cookie:cookie}});assert.equal(r.status,200);assert.ok((await r.text()).includes(kind==='evidence.json'?design.hash:'50'));}
const outsider=await fetch(`${base}/api/projects/${project.id}`);assert.ok([401,404].includes(outsider.status),'An unrelated browser must not access the project');
const readiness=workshop?{stock_loading:false,datum_registration:false,joint_access:false,support_transfer:false,finished_release:false,reset:false}:{fresh_loading:false,fold_clearance:false,closure_access:false,release:false,reset:false,...(kit?{compartment_loading:false,compartment_closure:false,kit_release:false}:{})};
const {build}=await request(`/api/projects/${project.id}/builds`,{designId:design.id,materialConfirmed:false,scaleConfirmed:false,partsConfirmed:false,deviations:'Software verification only; nothing was constructed.',makerAssistance:'No physical work performed',readiness});
const {trial}=await request(`/api/projects/${project.id}/trials`,{buildId:build.id,criteria:workshop?{registration:'not_observed',alignment:'not_observed',completion:'not_observed',release:'not_observed',reset:'not_observed',allowed_resources:'not_observed'}:{contents:'not_observed',closure:'not_observed',removal:'not_observed',reset:'not_observed',allowed_resources:'not_observed'},completeness:'incomplete',undeclaredResources:false,feedback:'Synthetic software verification. No physical operating trial occurred.',durationSeconds:null,reviewer:'Software smoke test',evidenceAssetId:null,observedAlignmentErrorMm:null,componentCounts:kit?{screws:null,washers:null,spacers:null,grommets:null}:{}});
assert.equal(trial.outcome,'incomplete');
const evidence=await request(`/api/projects/${project.id}/export`);assert.equal(evidence.project.isDemo,true);assert.equal(evidence.trials[0].outcome,'incomplete');
await mkdir('data/verification',{recursive:true});await writeFile(`data/verification/workflow-smoke-${workflow}-${live?'live':'local'}.json`,JSON.stringify({checkedAt:new Date().toISOString(),liveMeta:live,workflow,synthetic:true,physicalStatus:'untested',projectId:project.id,jobId,designId:design.id,designHash:design.hash,providerResponseId:design.trace?.providerResponseId||null,checks:['sample provenance','operation deduplication if live','durable worker commit if live','all four artifact downloads','unrelated-browser rejection','nonconforming build cannot pass','incomplete trial persisted','evidence export']},null,2));
console.log('Workflow smoke passed. Synthetic software evidence only; no physical success claimed.');
