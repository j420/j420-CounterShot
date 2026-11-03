import { z } from 'zod';
import { db, get, hash, id, list, now, transaction } from '../storage/db';
import type { Asset, Design, FrozenEvidenceAsset, Job, JobEvidenceContext, ObservationRecord, Project, Trial } from '../server/types';
import { audit } from '../server/projects';
import { fail } from '../server/http';
import { currentExecutionSpec } from './version';
import { cancelExecutionBudget } from '../meta/budget';
import { describePlanningEvidence, PLANNING_EVIDENCE_LIMITS, type GroundedMediaAsset } from '../meta/evidence';
import { MetaError } from '../meta/client';

export function jobsFor(projectId:string):Job[]{return (db.prepare('SELECT json FROM jobs WHERE project_id=? ORDER BY rowid ASC').all(projectId) as {json:string}[]).map(r=>JSON.parse(r.json));}
export function jobById(jobId:string):Job|null{const row=db.prepare('SELECT json FROM jobs WHERE id=?').get(jobId) as {json:string}|undefined;return row?JSON.parse(row.json):null;}
export function saveJob(job:Job){db.prepare('UPDATE jobs SET status=?,lease_until=?,json=? WHERE id=?').run(job.status,job.leaseUntil,JSON.stringify(job),job.id);return job;}
/** The latest reserved continuation wins over an older trace checkpoint. */
export function latestJobResponseId(job:Job,traceResponseId?:string|null):string|null {
 const budget=job.executionBudget;
 const latest=budget?.invocations.at(-1);
 if(!latest)return traceResponseId||null;
 if(budget!.runId!==job.id||latest.model!==job.executionSpec.model||latest.promptVersion!==job.executionSpec.promptVersion
  ||latest.schemaVersion!==job.executionSpec.schemaVersion||latest.route!==(job.kind==='observe'?'observation':'planning')
  ||latest.toolVersion!==(job.kind==='observe'?'none':job.executionSpec.checkerVersion))return null;
 return latest.status==='responded'?latest.responseId:null;
}
export function evidenceAssetSnapshot(asset:Asset):FrozenEvidenceAsset {
 return {id:asset.id,mime:asset.mime,sha256:asset.sha256,byteLength:asset.byteLength,durationMs:asset.durationMs,createdAt:asset.createdAt,storageKey:asset.storageKey};
}
function sourceEvidenceAsset(projectId:string,assetId:string):Asset {
 const asset=get<Asset>('assets',assetId);
 if(!asset||asset.projectId!==projectId||asset.purpose!=='source')fail(400,'Original observation evidence must be owned source media from this project.');
 return asset;
}
function parentEvidence(projectId:string,parentDesignId:string):JobEvidenceContext|null {
 const origin=jobsFor(projectId).find(job=>job.kind!=='observe'&&job.resultId===parentDesignId);
 return origin?.evidenceContext?.version==='grounded-evidence-v1'?origin.evidenceContext:null;
}
function validateEvidenceContext(context:JobEvidenceContext,observations:ObservationRecord[]){
 const selected=new Set(context.sourceObservationIds);
 const media=(asset:FrozenEvidenceAsset,source:boolean):GroundedMediaAsset=>({...asset,path:'',
  ...(source?{observationIds:observations.filter(observation=>selected.has(observation.id)&&observation.assetIds.includes(asset.id)).map(observation=>observation.id)}:{})});
 try{describePlanningEvidence(context.sourceAssets.map(asset=>media(asset,true)),context.trialAssets.map(asset=>media(asset,false)),context);}
 catch(error){if(error instanceof MetaError)fail(error.code==='planning_evidence_limit'?413:400,error.message);throw error;}
}
const StartSchema=z.object({kind:z.enum(['observe','plan','revise']),clientOperationId:z.string().uuid(),parentDesignId:z.string().optional(),sourceAssetIds:z.array(z.string().uuid()).min(1).max(PLANNING_EVIDENCE_LIMITS.maxSourceAssets).refine(ids=>new Set(ids).size===ids.length,'Select each source asset once.').optional(),sourceTrialIds:z.array(z.string().uuid()).max(100).refine(ids=>new Set(ids).size===ids.length,'Select each source trial once.').optional(),feedback:z.string().max(5000).optional()});
export function enqueue(project:Project,body:unknown){
 const b=StartSchema.parse(body);
 if(b.kind!=='revise'&&(b.parentDesignId!==undefined||b.sourceTrialIds!==undefined))
  fail(400,'Only a revision may reference a parent design or source trials.');
 if(b.kind!=='observe'&&b.sourceAssetIds!==undefined)fail(400,'Only an observation may select original source uploads. Plans retain the exact observed evidence.');
 return transaction(()=>{
  const p=get<Project>('projects',project.id)!;
  if(b.kind==='revise'){
   const parent=get<Design>('designs',b.parentDesignId||'');
   if(!parent||parent.projectId!==p.id)fail(400,'Select the exact design to revise.');
  }
  const sourceTrials=b.kind!=='revise'?[]:b.sourceTrialIds?b.sourceTrialIds.map(trialId=>{
   const trial=get<Trial>('trials',trialId);
   if(!trial||trial.projectId!==p.id||trial.designId!==b.parentDesignId||trial.outcome==='observed_complete')
    fail(400,'Select failed or incomplete trials from this exact parent design.');
   return trial;
  }):list<Trial>('trials',p.id).filter(t=>t.designId===b.parentDesignId&&t.outcome!=='observed_complete');
  const trialAssetIds=sourceTrials.flatMap(t=>t.evidenceAssetId?[t.evidenceAssetId]:[]);
  for(const assetId of trialAssetIds){
   const asset=get<Asset>('assets',assetId);
   if(!asset||asset.projectId!==p.id||asset.purpose!=='trial')fail(400,'Selected failed-trial evidence must be owned trial media from this project.');
  }
  const assets=b.kind==='observe'&&b.sourceAssetIds?b.sourceAssetIds.map(assetId=>sourceEvidenceAsset(p.id,assetId))
   :list<Asset>('assets',p.id).filter(a=>b.kind==='revise'?trialAssetIds.includes(a.id):a.purpose==='source');
  let observations=b.kind==='observe'?[]:list<ObservationRecord>('observations',p.id);
  let evidenceContext:JobEvidenceContext|undefined;
  if(b.kind==='observe'){
   evidenceContext={version:'grounded-evidence-v1',sourceObservationIds:[],sourceStatus:'source_only',sourceAssets:assets.map(evidenceAssetSnapshot),trialAssets:[]};
  }else{
   if(b.kind==='revise'){
    const prior=parentEvidence(p.id,b.parentDesignId!);
    if(prior){
     observations=prior.sourceObservationIds.map(observationId=>{
      const observation=get<ObservationRecord>('observations',observationId);
      if(!observation||observation.projectId!==p.id)fail(400,'The parent design references missing or unowned original observations.');
      return observation;
     });
     evidenceContext={version:'grounded-evidence-v1',sourceObservationIds:[...prior.sourceObservationIds],sourceStatus:prior.sourceStatus,
      sourceAssets:structuredClone(prior.sourceAssets),trialAssets:assets.map(evidenceAssetSnapshot)};
     for(const frozen of evidenceContext.sourceAssets){
      if(hash(evidenceAssetSnapshot(sourceEvidenceAsset(p.id,frozen.id)))!==hash(frozen))
       fail(409,'The parent design original evidence changed. Restore the exact saved media before requesting a revision.');
     }
    }else{
     // Earlier designs never recorded which source pixels reached planning.
     // Preserve that uncertainty instead of assigning today's latest observation.
     observations=[];
     evidenceContext={version:'grounded-evidence-v1',sourceObservationIds:[],sourceStatus:'historical_unavailable',sourceAssets:[],trialAssets:assets.map(evidenceAssetSnapshot)};
    }
   }else{
    const selected=observations.at(-1);
    const sourceAssets=selected?selected.assetIds.map(assetId=>sourceEvidenceAsset(p.id,assetId)):assets;
    if(new Set(sourceAssets.map(asset=>asset.id)).size!==sourceAssets.length)fail(400,'An observation must reference each original media asset once.');
    if(selected&&sourceAssets.length){
     if(!selected.evidenceAssets)fail(409,'This older observation has no recorded original-media fingerprint. Analyze the source media again before planning.');
     if(hash(selected.evidenceAssets)!==hash(sourceAssets.map(evidenceAssetSnapshot)))
      fail(409,'The original media changed after observation. Analyze the source media again before planning.');
    }
    evidenceContext={version:'grounded-evidence-v1',sourceObservationIds:selected?[selected.id]:[],
     sourceStatus:selected?'observation_bound':sourceAssets.length?'source_only':'none',
     sourceAssets:selected&&sourceAssets.length?structuredClone(selected.evidenceAssets!):sourceAssets.map(evidenceAssetSnapshot),trialAssets:[]};
   }
  }
  validateEvidenceContext(evidenceContext!,observations);
  const executionSpec=currentExecutionSpec();
  const requestHash=hash({
   kind:b.kind,snapshot:p.currentSnapshotId,assets:assets.map(a=>a.sha256),observations:observations.map(o=>o.id),
   parent:b.parentDesignId||null,feedback:b.feedback||null,trials:sourceTrials.map(t=>t.id),
   goal:p.goal,finishedDefinition:p.finishedDefinition,executionSpec,...(evidenceContext?{evidenceContext}:{}),
  });
  const existing=jobsFor(p.id).find(j=>j.clientOperationId===b.clientOperationId);
  if(existing){
   if(existing.requestHash!==requestHash)fail(409,'This operation ID belongs to different inputs. Start a new operation.');
   return existing;
  }
  if(jobsFor(p.id).some(j=>j.status==='queued'||j.status==='running'))
   fail(409,'This project already has an active job. Wait or cancel it first.');
  if(b.kind==='observe'&&!assets.length)fail(400,'Upload an original MP4 or checkpoint image before analysis.');
  if(b.kind!=='observe'&&!p.currentSnapshotId)fail(400,'Confirm the critical measurements and capabilities first.');
  if(b.kind==='revise'){
   if(!sourceTrials.length)fail(400,'Record a failed or incomplete trial on this revision first.');
   if(!b.feedback?.trim())fail(400,'Describe what failed and what the evidence shows.');
  }
  const job:Job={
   id:id(),projectId:p.id,kind:b.kind,status:'queued',stage:'Queued for the worker',error:null,
   inputSnapshotId:p.currentSnapshotId,parentDesignId:b.parentDesignId||null,
   parentJobId:jobsFor(p.id).filter(j=>j.stage.startsWith('Facts updated;')).at(-1)?.id||null,
   feedback:b.feedback||null,clientOperationId:b.clientOperationId,requestHash,executionSpec,
   assetIds:assets.map(a=>a.id),observationIds:observations.map(o=>o.id),sourceTrialIds:sourceTrials.map(t=>t.id),...(evidenceContext?{evidenceContext}:{}),
   attempt:0,leaseUntil:null,cancelRequested:false,createdAt:now(),completedAt:null,resultId:null,
  };
  db.prepare('INSERT INTO jobs(id,project_id,operation_id,request_hash,status,lease_until,json) VALUES(?,?,?,?,?,?,?)')
   .run(job.id,p.id,job.clientOperationId,requestHash,job.status,null,JSON.stringify(job));
  audit(p.id,'job_started',job.id,`${job.kind}; immutable request ${requestHash}`);
  return job;
 });
}
export function cancelJob(projectId:string,jobId:string){return transaction(()=>{const job=jobById(jobId);if(!job||job.projectId!==projectId)fail(404,'Job not found.');if(['queued','running','waiting_for_user'].includes(job.status)){job.status='cancelled';job.stage='Cancelled; any late provider result will be ignored';job.cancelRequested=true;if(job.executionBudget)job.executionBudget=cancelExecutionBudget(job.executionBudget);job.completedAt=now();saveJob(job);audit(projectId,'job_cancelled',job.id,'Cancellation prevents publication; a running provider request may still incur usage.');}return job;});}
export function claimJob():Job|null{return transaction(()=>{const expired=(db.prepare("SELECT json FROM jobs WHERE status='running' AND lease_until<?").all(now()) as {json:string}[]).map(r=>JSON.parse(r.json) as Job);for(const job of expired){const trace=get<{trace:{providerResponseId:string|null}}>('model_traces',job.id)?.trace;if(get('job_outputs',job.id)||latestJobResponseId(job,trace?.providerResponseId)){job.status='queued';job.stage='Recovering known provider response';}else{job.status='failed';job.error='Worker interrupted during a provider request. Remote outcome may be unknown. Start a deliberate new attempt; no automatic duplicate request was made.';job.stage='Interrupted';job.completedAt=now();}saveJob(job);}const row=db.prepare("SELECT json FROM jobs WHERE status='queued' ORDER BY rowid ASC LIMIT 1").get() as {json:string}|undefined;if(!row)return null;const job=JSON.parse(row.json) as Job;job.status='running';job.stage=job.kind==='observe'?'Reading the original operation':'Reasoning about supports, access and the complete operation';job.attempt++;job.leaseUntil=new Date(Date.now()+180_000).toISOString();saveJob(job);return job;});}
