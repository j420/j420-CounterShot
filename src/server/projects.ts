import { z } from 'zod';
import { FactsSchema } from '../domain/schema';
import { demoFacts, demoProposal, kitFacts, kitProposal, workshopFacts, workshopProposal } from '../domain/demo';
import { checkDesign } from '../checks';
import { compileDesign, COMPILER_VERSION } from '../geometry';
import { db, bytesHash, get, hash, id, insert, list, now, replace, transaction } from '../storage/db';
import { fail } from './http';
import type { Asset, Audit, Build, Design, Project, Snapshot, Trial } from './types';

export function audit(projectId:string,event:string,subjectId:string,detail:string){
  return insert<Audit>('audit',{id:id(),projectId,event,subjectId,detail,at:now()});
}
type MutationReceipt={id:string;projectId:string;collection:string;requestHash:string;recordId:string;createdAt:string};
/** A lost response must not turn one human confirmation/build/attempt into two. */
function persistOnce<T extends {id:string}>(projectId:string,collection:'snapshots'|'builds'|'trials',body:Record<string,unknown>&{clientOperationId?:string},create:()=>T):T{
  const {clientOperationId,...payload}=body;
  return transaction(()=>{
    const receiptId=clientOperationId?hash({projectId,collection,clientOperationId}):null;
    const requestHash=hash(payload);
    if(receiptId){
      const previous=get<MutationReceipt>('mutation_receipts',receiptId);
      if(previous){
        if(previous.projectId!==projectId||previous.collection!==collection||previous.requestHash!==requestHash)
          fail(409,'This operation ID already belongs to different inputs. Refresh the saved records before starting another operation.');
        const record=get<T>(collection,previous.recordId);
        if(!record)throw new Error('The saved operation receipt has no corresponding record.');
        return record;
      }
    }
    const record=create();
    if(receiptId)insert<MutationReceipt>('mutation_receipts',{id:receiptId,projectId,collection,requestHash,recordId:record.id,createdAt:now()});
    return record;
  });
}
const NewProject=z.object({
  title:z.string().trim().min(1).max(120),goal:z.string().trim().min(10).max(3000),
  finishedDefinition:z.string().trim().min(5).max(2000),demo:z.boolean().optional(),
  workflow:z.enum(['workshop_jig','carton_packing','electronics_kit']).default('workshop_jig'),
});
export function createProject(body:unknown,session:string){
  const b=NewProject.parse(body);
  const sampleFacts=b.workflow==='workshop_jig'?workshopFacts:b.workflow==='electronics_kit'?kitFacts:demoFacts;
  const sampleProposal=b.workflow==='workshop_jig'?workshopProposal:b.workflow==='electronics_kit'?kitProposal:demoProposal;
  return transaction(()=>{
    const p=insert<Project>('projects',{id:id(),title:b.title,goal:b.goal,finishedDefinition:b.finishedDefinition,
      workflow:b.workflow,ownerHash:bytesHash(session),version:1,currentSnapshotId:null,currentDesignId:null,
      isDemo:!!b.demo,createdAt:now(),updatedAt:now()});
    audit(p.id,'project_created',p.id,b.demo?'Synthetic example. No physical trials or success evidence.':'Project created.');
    if(b.demo){
      const snapshot=insert<Snapshot>('snapshots',{id:id(),projectId:p.id,facts:sampleFacts,hash:hash(sampleFacts),
        confirmedBy:'Synthetic example — not measured',source:'synthetic',createdAt:now()});
      p.currentSnapshotId=snapshot.id;
      const checks=checkDesign(sampleFacts,sampleProposal);
      const blocked=checks.some(c=>c.severity==='error');
      const designHash=hash({snapshot:snapshot.hash,proposal:sampleProposal,compiler:COMPILER_VERSION});
      const design=insert<Design>('designs',{id:id(),projectId:p.id,number:1,inputSnapshotId:snapshot.id,parentId:null,
        proposal:sampleProposal,checks,hash:designHash,artifacts:blocked?null:compileDesign(sampleFacts,sampleProposal,designHash),
        status:blocked?'checks_failed':'checks_passed',trace:null,source:'synthetic',createdAt:now()});
      p.currentDesignId=design.id;replace('projects',p);
    }
    return p;
  });
}
export function confirmFacts(project:Project,body:unknown){
  const b=z.object({facts:FactsSchema,confirmed:z.literal(true),clientOperationId:z.string().uuid().optional()}).parse(body);
  if(b.facts.workflow==='electronics_kit'&&(b.facts.kitComponents.length!==4||new Set(b.facts.kitComponents.map(c=>c.id)).size!==4))
    fail(400,'Confirm the required count and measured group envelope for all four component identities before planning.');
  if(b.facts.workflow==='carton_packing'&&[b.facts.itemLengthMm,b.facts.itemWidthMm,b.facts.itemHeightMm].some(v=>v===null))
    fail(400,'Confirm the actual item length, width and height before planning.');
  if(b.facts.workflow==='workshop_jig'&&!['left','right','rear','front'].every(edge=>b.facts.workflow==='workshop_jig'&&b.facts.jointZones.some(zone=>zone.edge===edge)))
    fail(400,'Confirm the measured joint access window on every edge; missing access cannot imply clearance.');
  if(b.facts.workflow!==(project.workflow||'carton_packing'))
    fail(409,'These measurements belong to a different workflow. Create a project for that workflow.');
  return persistOnce(project.id,'snapshots',b,()=>{
    const current=get<Project>('projects',project.id)!;
    const snapshot=insert<Snapshot>('snapshots',{id:id(),projectId:project.id,facts:b.facts,hash:hash(b.facts),
      confirmedBy:'Operator confirmation in project session',source:project.isDemo?'synthetic':'operator_confirmed',createdAt:now()});
    current.currentSnapshotId=snapshot.id;current.currentDesignId=null;current.version++;current.updatedAt=now();replace('projects',current);
    const waiting=db.prepare("SELECT json FROM jobs WHERE project_id=? AND status='waiting_for_user'").all(project.id) as {json:string}[];
    for(const row of waiting){
      const job=JSON.parse(row.json);job.status='superseded';job.stage='Facts updated; a new generation uses a new immutable input snapshot';job.completedAt=now();
      db.prepare('UPDATE jobs SET status=?,json=? WHERE id=?').run(job.status,JSON.stringify(job),job.id);
    }
    audit(project.id,'facts_confirmed',snapshot.id,'New immutable input snapshot; earlier outputs remain historical. Measurement uncertainty is unspecified.');
    return snapshot;
  });
}
export const readinessKeysFor=(workflow:string):string[]=>workflow==='workshop_jig'
  ?['stock_loading','datum_registration','joint_access','support_transfer','finished_release','reset']
  :['fresh_loading','fold_clearance','closure_access','release','reset',...(workflow==='electronics_kit'?['compartment_loading','compartment_closure','kit_release']:[])];
const BuildSchema=z.object({designId:z.string(),materialConfirmed:z.boolean(),scaleConfirmed:z.boolean(),partsConfirmed:z.boolean(),
  deviations:z.string().max(3000),makerAssistance:z.string().max(2000),readiness:z.record(z.string(),z.boolean()),clientOperationId:z.string().uuid().optional()});
export function recordBuild(project:Project,body:unknown){
  const b=BuildSchema.parse(body);
  return persistOnce(project.id,'builds',b,()=>{
    const current=get<Project>('projects',project.id)!;
    const design=get<Design>('designs',b.designId);
    if(!design||design.projectId!==project.id)fail(404,'Design not found.');
    if(design.inputSnapshotId!==current.currentSnapshotId||design.status!=='checks_passed')
      fail(409,'This design is stale or has blocking errors. Generate from the current facts first.');
    if(design.proposal.outcome!=='candidate')fail(409,'This outcome does not contain a construction candidate.');
    const snapshot=get<Snapshot>('snapshots',design.inputSnapshotId);
    if(!snapshot||snapshot.projectId!==project.id||checkDesign(snapshot.facts,design.proposal).some(check=>check.severity==='error'))
      fail(409,'This design no longer passes the current construction checks. Generate a new design from the current facts before recording a new build.');
    let currentArtifacts:Design['artifacts'];
    try{currentArtifacts=compileDesign(snapshot.facts,design.proposal,design.hash);}
    catch{fail(409,'This design cannot produce a current construction pack. Generate a new design before recording a new build.');}
    if(!design.artifacts||hash(design.artifacts)!==hash(currentArtifacts))
      fail(409,'The saved construction pack differs from the current compiler. Generate a new design and use its construction pack before recording a new build.');
    const keys=readinessKeysFor(project.workflow||'carton_packing');
    if(Object.keys(b.readiness).some(key=>!keys.includes(key)))fail(400,'Readiness checks must match this workflow.');
    const readiness=Object.fromEntries(keys.map(key=>[key,b.readiness[key]===true]));
    const conforming=b.materialConfirmed&&b.scaleConfirmed&&b.partsConfirmed&&!b.deviations.trim();
    const build=insert<Build>('builds',{...b,readiness,id:id(),projectId:project.id,conforming,createdAt:now()});
    audit(project.id,'build_recorded',build.id,conforming?'Maker confirmed exact materials, parts and print scale. Physical tests still required.'
      :'Nonconforming build. Material/geometry deviations require a new design before completion can be claimed.');
    return build;
  });
}
export const criterionKeys=['contents','closure','removal','reset','allowed_resources'] as const;
export const workshopCriterionKeys=['registration','alignment','completion','release','reset','allowed_resources'] as const;
export const criterionKeysFor=(workflow:string):readonly string[]=>workflow==='workshop_jig'?workshopCriterionKeys:criterionKeys;
const criterion=z.enum(['pass','fail','not_observed','not_applicable']);
const TrialSchema=z.object({buildId:z.string(),criteria:z.record(z.string(),criterion),completeness:z.enum(['complete','incomplete']),
  undeclaredResources:z.boolean(),feedback:z.string().max(5000),durationSeconds:z.number().finite().positive().max(86400).nullable(),
  reviewer:z.string().trim().min(1).max(100),evidenceAssetId:z.string().nullable(),
  componentCounts:z.record(z.string(),z.number().int().min(0).max(1000).nullable()).default({}),
  observedAlignmentErrorMm:z.number().finite().min(0).max(1000).nullable().default(null),clientOperationId:z.string().uuid().optional()});
export function deriveOutcome(criteria:Trial['criteria'],complete:boolean,undeclaredResources:boolean,keys:readonly string[]=criterionKeys):Trial['outcome']{
  if(undeclaredResources||keys.some(k=>criteria[k]==='fail'))return 'failed';
  return complete&&keys.every(k=>criteria[k]==='pass')?'observed_complete':'incomplete';
}
export function recordTrial(project:Project,body:unknown){
  const b=TrialSchema.parse(body);
  return persistOnce(project.id,'trials',b,()=>{
    const build=get<Build>('builds',b.buildId);if(!build||build.projectId!==project.id)fail(404,'Build not found.');
    const design=get<Design>('designs',build.designId)!;
    const snapshot=get<Snapshot>('snapshots',design.inputSnapshotId)!;
    const workflow=snapshot.facts.workflow||'carton_packing';
    const keys=criterionKeysFor(workflow);
    if(keys.some(key=>!Object.hasOwn(b.criteria,key))||Object.keys(b.criteria).some(key=>!keys.includes(key)))
      fail(400,'Review each required criterion for this workflow.');
    let hasEvidence=false;
    if(b.evidenceAssetId){
      const asset=get<Asset>('assets',b.evidenceAssetId);if(!asset||asset.projectId!==project.id)fail(400,'Trial evidence must belong to this project.');
      hasEvidence=asset.mime==='video/mp4'&&asset.purpose==='trial'&&!!asset.durationMs&&asset.durationMs>0;
    }
    const ready=readinessKeysFor(workflow).every(key=>build.readiness[key]===true);
    const components=snapshot.facts.workflow==='electronics_kit'?snapshot.facts.kitComponents:[];
    const requiredComponentCounts=Object.fromEntries(components.map(c=>[c.id,c.requiredCount]));
    if(Object.keys(b.componentCounts).some(key=>!Object.hasOwn(requiredComponentCounts,key)))
      fail(400,'Observed counts must refer to this exact design inventory.');
    const countsComplete=components.every(c=>b.componentCounts[c.id]!==null&&b.componentCounts[c.id]!==undefined);
    const countMismatch=components.some(c=>typeof b.componentCounts[c.id]==='number'&&b.componentCounts[c.id]!==c.requiredCount);
    const alignmentToleranceMm=snapshot.facts.workflow==='workshop_jig'?snapshot.facts.alignmentToleranceMm:null;
    const alignmentKnown=workflow!=='workshop_jig'||b.observedAlignmentErrorMm!==null;
    const alignmentFailed=alignmentToleranceMm!==null&&b.observedAlignmentErrorMm!==null&&b.observedAlignmentErrorMm>alignmentToleranceMm;
    const effectiveCriteria:Trial['criteria']={...b.criteria};
    if(countMismatch)effectiveCriteria.contents='fail';
    if(alignmentFailed)effectiveCriteria.alignment='fail';
    const complete=b.completeness==='complete'&&hasEvidence&&build.conforming&&ready&&countsComplete&&alignmentKnown&&!project.isDemo&&design.source!=='synthetic';
    const outcome=deriveOutcome(effectiveCriteria,complete,b.undeclaredResources,keys);
    const trial=insert<Trial>('trials',{...b,criteria:effectiveCriteria,alignmentToleranceMm,requiredComponentCounts,id:id(),projectId:project.id,
      designId:build.designId,completeness:complete?'complete':'incomplete',outcome,
      testDefinitionVersion:workflow==='workshop_jig'?'workshop-assembly-complete-cycle-v1':components.length?'repair-kit-complete-cycle-v1':'packing-complete-cycle-v1',createdAt:now()});
    audit(project.id,'trial_reviewed',trial.id,`Reviewer ${b.reviewer} recorded ${outcome} against exact build ${build.id}. This is reviewer evidence, not an automated physical assessment.`);
    return trial;
  });
}
