import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { NextRequest } from "next/server";
import { demoFacts, demoProposal, demoObservation, kitFacts, kitProposal, workshopFacts, workshopProposal } from "../src/domain/demo";
import { checkDesign } from "../src/checks";
import { compileDesign } from "../src/geometry";
import type { Asset, Design, Job, ObservationRecord, Project, Snapshot, Trial } from "../src/server/types";
import type { ModelTrace, PlannerCheckProvenance } from '../src/meta';
import type { ExecutionBudget, InvocationSpec } from '../src/meta/budget';

// Never open the developer's real database or write a fixture into their assets.
const testRoot = mkdtempSync(path.join(os.tmpdir(), "countershot-workflow-"));
process.env.DATA_ROOT = testRoot;
process.env.ASSET_ROOT = path.join(testRoot, "assets");
process.env.DATABASE_PATH = path.join(testRoot, "test.sqlite");
const store = await import("../src/storage/db");
const services = await import("../src/server/projects");
const queue = await import("../src/jobs/queue");
const http = await import("../src/server/http");
const { processJob } = await import("../src/jobs/process");
const { describePlanningEvidence, planningEvidenceHash, finalizePlannerChecks } = await import("../src/meta");
const { createExecutionBudget, reserveInvocation, recordInvocationResponse, cancelExecutionBudget, markInvocationUnknown,
  DEFAULT_PLANNING_EXECUTION_LIMITS } = await import('../src/meta/budget');

after(() => {
  store.db.close();
  delete (globalThis as { countershotDb?: unknown }).countershotDb;
  rmSync(testRoot, { recursive: true, force: true });
});
afterEach(() => { store.db.exec("DELETE FROM jobs"); });

const readiness = { fresh_loading: true, fold_clearance: true, closure_access: true, release: true, reset: true };
const criteria = { contents: "pass", closure: "pass", removal: "pass", reset: "pass", allowed_resources: "pass" } as const;
const makeProject = (demo = false) => {
  const session = randomUUID();
  const project = services.createProject({ title: "Test fixture only", goal: "Pack the stated item and loose card into a carton", finishedDefinition: "Contents, closure, removal and reset complete", workflow: "carton_packing", demo }, session);
  return { project, session };
};
const fresh = (project: Project) => store.get<Project>("projects", project.id)!;
const fixture = () => {
  const { project, session } = makeProject();
  const snapshot = services.confirmFacts(project, { facts: demoFacts, confirmed: true });
  const designHash = store.hash({ snapshot: snapshot.hash, proposal: demoProposal });
  // This is a unit-test database fixture, not an actual model run or physical trial.
  const design = store.insert<Design>("designs", {
    id: store.id(), projectId: project.id, number: 1, inputSnapshotId: snapshot.id, parentId: null,
    proposal: demoProposal, checks: checkDesign(demoFacts, demoProposal), hash: designHash,
    artifacts: compileDesign(demoFacts, demoProposal, designHash), status: "checks_passed",
    trace: { testFixture: true }, source: "meta", createdAt: store.now(),
  });
  const current = fresh(project);
  current.currentDesignId = design.id;
  store.replace("projects", current);
  return { project: fresh(project), session, snapshot, design };
};
const makeBuild = (project: Project, design: Design, overrides: Record<string, unknown> = {}) => services.recordBuild(project, {
  designId: design.id, materialConfirmed: true, scaleConfirmed: true, partsConfirmed: true,
  deviations: "", makerAssistance: "Test fixture maker", readiness, ...overrides,
});
const makeAsset = (project: Project, overrides: Partial<Asset> = {}) => store.insert<Asset>("assets", {
  id: store.id(), projectId: project.id, name: "test-fixture.mp4", mime: "video/mp4", byteLength: 1000,
  sha256: store.hash(randomUUID()), storageKey: store.id() + ".mp4", durationMs: 12000,
  purpose: "trial", createdAt: store.now(), ...overrides,
});
const makeTrial = (project: Project, buildId: string, overrides: Record<string, unknown> = {}) => services.recordTrial(project, {
  buildId, criteria, completeness: "complete", undeclaredResources: false,
  feedback: "Unit-test fixture. This record is isolated and deleted after testing.", durationSeconds: 12,
  reviewer: "Test fixture reviewer", evidenceAssetId: null, ...overrides,
});
const expectHttp = (fn: () => unknown, status: number) => assert.throws(fn, (error: unknown) => error instanceof http.HttpError && error.status === status);
const evidenceTrace = (job: Job) => {
  const context = job.evidenceContext!;
  const media = (asset: typeof context.sourceAssets[number], source: boolean) => ({
    ...asset, path: path.join(store.assetRoot, asset.storageKey),
    ...(source ? { observationIds: context.sourceObservationIds.filter(id => store.get<ObservationRecord>("observations", id)!.assetIds.includes(asset.id)) } : {}),
  });
  const planningEvidence = describePlanningEvidence(context.sourceAssets.map(asset => media(asset, true)), context.trialAssets.map(asset => media(asset, false)), context);
  return { planningEvidence, planningEvidenceHash: planningEvidenceHash(planningEvidence) };
};
const cacheProposal = (job: Job) => store.insert("job_outputs", {
  id: job.id, projectId: job.projectId,
  result: { output: structuredClone(demoProposal), trace: { model: "unit-test-fixture", synthetic: true, physicalStatus: "untested", ...evidenceTrace(job) } },
  createdAt: store.now(),
});
const recordedObservation = (project: Project, assets: Asset[], overrides: Partial<ObservationRecord> = {}) => store.insert<ObservationRecord>("observations", {
  id: store.id(), projectId: project.id, assetIds: assets.map(asset => asset.id), evidenceAssets: assets.map(queue.evidenceAssetSnapshot),
  output: structuredClone(demoObservation), trace: { testFixture: true }, source: "meta", createdAt: store.now(), ...overrides,
});

test("same operation and immutable inputs return one logical job", () => {
  const { project } = fixture();
  const operation = randomUUID();
  const first = queue.enqueue(project, { kind: "plan", clientOperationId: operation });
  const duplicate = queue.enqueue(project, { kind: "plan", clientOperationId: operation });
  assert.equal(first.id, duplicate.id);
  assert.equal(queue.jobsFor(project.id).length, 1);
});

test("operation reuse with changed facts is a conflict, never a duplicate generation", () => {
  const { project } = fixture();
  const operation = randomUUID();
  queue.enqueue(project, { kind: "plan", clientOperationId: operation });
  services.confirmFacts(project, { facts: { ...demoFacts, itemLengthMm: 150 }, confirmed: true });
  expectHttp(() => queue.enqueue(fresh(project), { kind: "plan", clientOperationId: operation }), 409);
  assert.equal(queue.jobsFor(project.id).length, 1);
});

test("a project cannot run two independent modifying jobs concurrently", () => {
  const { project } = fixture();
  queue.enqueue(project, { kind: "plan", clientOperationId: randomUUID() });
  expectHttp(() => queue.enqueue(project, { kind: "plan", clientOperationId: randomUUID() }), 409);
});

test("new facts create an immutable snapshot and invalidate current design eligibility", () => {
  const { project, design, snapshot } = fixture();
  const originalHash = snapshot.hash;
  const updated = services.confirmFacts(project, { facts: { ...demoFacts, boardThicknessMm: 2 }, confirmed: true });
  assert.notEqual(updated.id, snapshot.id);
  assert.notEqual(updated.hash, originalHash);
  assert.equal(store.get<Snapshot>("snapshots", snapshot.id)!.hash, originalHash);
  assert.equal(fresh(project).currentDesignId, null);
  assert.equal(fresh(project).currentSnapshotId, updated.id);
  expectHttp(() => makeBuild(fresh(project), design), 409);
});

test("nonconforming material, dimensions, print scale or parts cannot inherit completion", () => {
  const { project, design } = fixture();
  const evidence = makeAsset(project);
  for (const overrides of [
    { materialConfirmed: false }, { scaleConfirmed: false }, { partsConfirmed: false },
    { deviations: "Changed a wall dimension by 3 mm" }, { deviations: "Substituted a different board" },
  ]) {
    const build = makeBuild(project, design, overrides);
    assert.equal(build.conforming, false);
    const trial = makeTrial(project, build.id, { evidenceAssetId: evidence.id });
    assert.equal(trial.outcome, "incomplete");
    assert.equal(trial.completeness, "incomplete");
  }
});

test("a historical rounded construction pack cannot admit a new build even when the raw design still passes", () => {
  const { project } = makeProject();
  const measured = { ...demoFacts, itemLengthMm: 100.04 };
  const proposal = structuredClone(demoProposal); proposal.program.insertClearanceMm = 0;
  const snapshot = services.confirmFacts(project, { facts: measured, confirmed: true });
  const checks = checkDesign(measured, proposal);
  assert.equal(checks.some(check => check.severity === "error"), false);
  const designHash = store.hash({ snapshot: snapshot.hash, proposal });
  const currentPack = compileDesign(measured, proposal, designHash);
  const oldPack = structuredClone(currentPack);
  // Reproduce the former compiler's 0.1mm serialization of real cuts and scores.
  oldPack.packageSvg = oldPack.packageSvg.replace(/\b(x|y|width|height|x1|x2|y1|y2)="(-?\d+(?:\.\d+)?)"/g,
    (_, attribute: string, value: string) => `${attribute}="${Math.round(Number(value) * 10) / 10}"`);
  oldPack.dimensions = Object.fromEntries(Object.entries(oldPack.dimensions).map(([key, value]) => [key, Math.round(value * 10) / 10]));
  assert.notEqual(oldPack.packageSvg, currentPack.packageSvg);
  assert.equal(oldPack.dimensions.trayInnerLengthMm, 100);
  const design = store.insert<Design>("designs", { id: store.id(), projectId: project.id, number: 1, inputSnapshotId: snapshot.id,
    parentId: null, proposal, checks, hash: designHash, artifacts: oldPack, status: "checks_passed", trace: { testFixture: true }, source: "meta", createdAt: store.now() });
  expectHttp(() => makeBuild(fresh(project), design), 409);
  assert.equal(store.list("builds", project.id).length, 0);
  assert.deepEqual(store.get<Design>("designs", design.id)!.artifacts, oldPack);
});

test("new build admission reruns current geometry checks rather than trusting a historical passing status", () => {
  const { project } = makeProject();
  const measured = { ...demoFacts, itemLengthMm: demoFacts.cartonLengthMm - 2 * demoFacts.boardThicknessMm + 0.04 };
  const proposal = structuredClone(demoProposal); proposal.program.insertClearanceMm = 0;
  const snapshot = services.confirmFacts(project, { facts: measured, confirmed: true });
  assert.ok(checkDesign(measured, proposal).some(check => check.ruleId === "GEOM02" && check.severity === "error"));
  const designHash = store.hash({ snapshot: snapshot.hash, proposal });
  const design = store.insert<Design>("designs", { id: store.id(), projectId: project.id, number: 1, inputSnapshotId: snapshot.id,
    parentId: null, proposal, checks: [], hash: designHash, artifacts: compileDesign(measured, proposal, designHash),
    status: "checks_passed", trace: { testFixture: true }, source: "meta", createdAt: store.now() });
  expectHttp(() => makeBuild(fresh(project), design), 409);
  assert.equal(store.list("builds", project.id).length, 0);
});

test("construction-pack changes block new builds while existing builds keep their historical trial review", () => {
  const { project, design } = fixture();
  const build = makeBuild(project, design);
  const historicalPack = structuredClone(design.artifacts!);
  historicalPack.packageSvg = historicalPack.packageSvg.replace("COUNTERSHOT / P01 RETAINING TRAY", "HISTORICAL COMPILER DRAWING");
  store.replace("designs", { ...design, artifacts: historicalPack });
  expectHttp(() => makeBuild(project, design), 409);
  const evidence = makeAsset(project);
  assert.equal(makeTrial(project, build.id, { evidenceAssetId: evidence.id }).outcome, "observed_complete");
  assert.equal(store.list("builds", project.id).length, 1);
  assert.deepEqual(store.get<Design>("designs", design.id)!.artifacts, historicalPack);
});

test("each unresolved readiness check blocks a physical completion claim", () => {
  const { project, design } = fixture();
  const evidence = makeAsset(project);
  for (const key of Object.keys(readiness)) {
    const build = makeBuild(project, design, { readiness: { ...readiness, [key]: false } });
    assert.equal(makeTrial(project, build.id, { evidenceAssetId: evidence.id }).outcome, "incomplete");
  }
});

test("all-pass reviewer boxes without video evidence remain incomplete", () => {
  const { project, design } = fixture();
  const build = makeBuild(project, design);
  assert.equal(makeTrial(project, build.id).outcome, "incomplete");
  const image = makeAsset(project, { mime: "image/jpeg", name: "still.jpg", durationMs: null });
  assert.equal(makeTrial(project, build.id, { evidenceAssetId: image.id }).outcome, "incomplete");
});

test("a source clip or undated/unprobed video cannot substitute for trial evidence", () => {
  const { project, design } = fixture();
  const build = makeBuild(project, design);
  for (const overrides of [{ purpose: "source" as const }, { durationMs: null }, { durationMs: 0 }]) {
    const asset = makeAsset(project, overrides);
    assert.equal(makeTrial(project, build.id, { evidenceAssetId: asset.id }).outcome, "incomplete");
  }
});

test("conforming complete trial requires all five criteria and actual trial video metadata", () => {
  const { project, design } = fixture();
  const build = makeBuild(project, design);
  const evidence = makeAsset(project);
  const trial = makeTrial(project, build.id, { evidenceAssetId: evidence.id });
  assert.equal(trial.outcome, "observed_complete");
  assert.equal(trial.designId, design.id);
  assert.equal(trial.buildId, build.id);
  assert.equal(trial.testDefinitionVersion, "packing-complete-cycle-v1");
});

test("synthetic walkthrough cannot create observed physical success", () => {
  const { project } = makeProject(true);
  const p = fresh(project);
  const design = store.get<Design>("designs", p.currentDesignId!)!;
  const build = makeBuild(p, design);
  const evidence = makeAsset(p);
  const trial = makeTrial(p, build.id, { evidenceAssetId: evidence.id });
  assert.equal(trial.outcome, "incomplete");
  assert.equal(trial.completeness, "incomplete");
});

test("required criteria cannot be bypassed with not-applicable or not-observed", () => {
  for (const key of services.criterionKeys) {
    for (const value of ["not_applicable", "not_observed"] as const) {
      assert.equal(services.deriveOutcome({ ...criteria, [key]: value }, true, false), "incomplete");
    }
  }
  assert.equal(services.deriveOutcome(criteria, true, false), "observed_complete");
  assert.equal(services.deriveOutcome(criteria, false, false), "incomplete");
});

test("actual failure or undeclared resource use overrides all other passing criteria", () => {
  assert.equal(services.deriveOutcome(criteria, true, true), "failed");
  assert.equal(services.deriveOutcome({ ...criteria, closure: "fail" }, false, false), "failed");
});

test("project sessions cannot authorize another project's assets or exact revision", async () => {
  const owner = fixture();
  const stranger = makeProject();
  const unauthorized = new NextRequest(`http://localhost/api/projects/${owner.project.id}`, { headers: { cookie: `countershot_session=${stranger.session}` } });
  expectHttp(() => http.authorize(unauthorized, owner.project.id), 404);
  const authorized = new NextRequest(`http://localhost/api/projects/${owner.project.id}`, { headers: { cookie: `countershot_session=${owner.session}` } });
  assert.equal(http.authorize(authorized, owner.project.id).id, owner.project.id);
  assert.equal("ownerHash" in http.publicProject(owner.project), false);
  const artifact = await import("../app/api/projects/[id]/designs/[designId]/artifacts/[kind]/route");
  const result = await artifact.GET(unauthorized, { params: Promise.resolve({ id: owner.project.id, designId: owner.design.id, kind: "package.svg" }) });
  assert.equal(result.status, 404);
});

test("cross-project build and trial evidence references are rejected", () => {
  const a = fixture();
  const b = fixture();
  expectHttp(() => makeBuild(a.project, b.design), 404);
  const build = makeBuild(a.project, a.design);
  const otherAsset = makeAsset(b.project);
  expectHttp(() => makeTrial(a.project, build.id, { evidenceAssetId: otherAsset.id }), 400);
  expectHttp(() => makeTrial(b.project, build.id), 404);
});

test('only revisions may reference an owned parent design',()=>{
 const a=fixture();const b=fixture();
 for(const kind of ['plan','observe'])expectHttp(()=>queue.enqueue(a.project,{kind,clientOperationId:randomUUID(),parentDesignId:b.design.id}),400);
 expectHttp(()=>queue.enqueue(a.project,{kind:'revise',clientOperationId:randomUUID(),parentDesignId:b.design.id,feedback:'Foreign revision must be rejected'}),400);
 assert.equal(queue.jobsFor(a.project.id).length,0);
});

test('historical malicious job references fail before provider access or cached publication',async()=>{
 const owner=fixture();const other=fixture();
 const foreignAsset=makeAsset(other.project);
 const foreignObservation=store.insert<ObservationRecord>('observations',{id:store.id(),projectId:other.project.id,assetIds:[],output:demoObservation,trace:{testFixture:true},source:'meta',createdAt:store.now()});
 const build=makeBuild(owner.project,owner.design);
 const ownTrial=makeTrial(owner.project,build.id);
 const foreignBuild=makeBuild(other.project,other.design);
 const foreignTrial=makeTrial(other.project,foreignBuild.id);
 const parentWithForeignSnapshot=store.insert<Design>('designs',{...owner.design,id:store.id(),number:2,inputSnapshotId:other.snapshot.id});
 const trialWithForeignEvidence=store.insert<Trial>('trials',{...ownTrial,id:store.id(),evidenceAssetId:foreignAsset.id});
 const cases:Partial<Job>[]=[
  {parentDesignId:other.design.id},
  {inputSnapshotId:other.snapshot.id},
  {assetIds:[foreignAsset.id]},
  {observationIds:[foreignObservation.id]},
  {kind:'revise',parentDesignId:owner.design.id,sourceTrialIds:[foreignTrial.id]},
  {kind:'revise',parentDesignId:other.design.id,sourceTrialIds:[ownTrial.id]},
  {kind:'revise',parentDesignId:parentWithForeignSnapshot.id,sourceTrialIds:[ownTrial.id]},
  {kind:'revise',parentDesignId:owner.design.id,sourceTrialIds:[trialWithForeignEvidence.id]},
 ];
 const post=test.mock.method(OpenAI.prototype,'post',()=>{throw new Error('Provider POST must not occur for invalid references');});
 const get=test.mock.method(OpenAI.prototype,'get',()=>{throw new Error('Provider GET must not occur for invalid references');});
 const errors=test.mock.method(console,'error',()=>{});
 try{
  for(const patch of cases){
   for(const cached of [false,true]){
    const job=queue.enqueue(owner.project,{kind:'plan',clientOperationId:randomUUID()});
    queue.saveJob({...job,...patch});
    if(cached)cacheProposal(job);
    const before=store.list<Design>('designs',owner.project.id).length;
    const claimed=queue.claimJob()!;await processJob(claimed);
    assert.equal(queue.jobById(job.id)!.status,'failed');
    assert.equal(queue.jobById(job.id)!.resultId,null);
    assert.equal(store.list<Design>('designs',owner.project.id).length,before);
   }
  }
  assert.equal(post.mock.callCount(),0);assert.equal(get.mock.callCount(),0);
 }finally{post.mock.restore();get.mock.restore();errors.mock.restore();}
});

test('a revision source trial must match its selected owned parent',async()=>{
 const f=fixture();const build=makeBuild(f.project,f.design);const trial=makeTrial(f.project,build.id);
 const second=store.insert<Design>('designs',{...f.design,id:store.id(),number:2});
 const job=queue.enqueue(f.project,{kind:'plan',clientOperationId:randomUUID()});
 queue.saveJob({...job,kind:'revise',parentDesignId:second.id,sourceTrialIds:[trial.id]});cacheProposal(job);
 const errors=test.mock.method(console,'error',()=>{});
 try{await processJob(queue.claimJob()!);}finally{errors.mock.restore();}
 assert.equal(queue.jobById(job.id)!.status,'failed');
 assert.match(queue.jobById(job.id)!.error!,/selected parent/);
 assert.equal(queue.jobById(job.id)!.resultId,null);
});

test('queued execution versions are frozen and checked before requests or cached publication',async()=>{
 const priorModel=process.env.META_MODEL;
 const post=test.mock.method(OpenAI.prototype,'post',()=>{throw new Error('Version drift cannot start a provider request');});
 const get=test.mock.method(OpenAI.prototype,'get',()=>{throw new Error('Version drift cannot retrieve a provider response');});
 const errors=test.mock.method(console,'error',()=>{});
 try{
  for(const mutation of ['model','prompt','missing'] as const){
   for(const cached of [false,true]){
    const f=fixture();const job=queue.enqueue(f.project,{kind:'plan',clientOperationId:randomUUID()});
    assert.equal(job.executionSpec.model,priorModel||'muse-spark-1.3');
    if(cached)cacheProposal(job);
    if(mutation==='model')process.env.META_MODEL='offline-different-runtime';
    else if(mutation==='prompt')queue.saveJob({...job,executionSpec:{...job.executionSpec,promptVersion:'historical-prompt-version'}});
    else{const historical={...job} as Partial<Job>;delete historical.executionSpec;queue.saveJob(historical as Job);}
    await processJob(queue.claimJob()!);
    const failed=queue.jobById(job.id)!;assert.equal(failed.status,'failed');assert.match(failed.error!,/deliberate new operation/);
    assert.equal(failed.resultId,null);assert.equal(fresh(f.project).currentDesignId,f.design.id);
    if(priorModel===undefined)delete process.env.META_MODEL;else process.env.META_MODEL=priorModel;
   }
  }
  assert.equal(post.mock.callCount(),0);assert.equal(get.mock.callCount(),0);
 }finally{post.mock.restore();get.mock.restore();errors.mock.restore();if(priorModel===undefined)delete process.env.META_MODEL;else process.env.META_MODEL=priorModel;}
});

test("only source media can start an original observation", () => {
  const { project } = fixture();
  makeAsset(project, { purpose: "trial" });
  expectHttp(() => queue.enqueue(project, { kind: "observe", clientOperationId: randomUUID() }), 400);
});

test("completed observation replay ignores its own newly created output and returns the same job", () => {
  const { project } = fixture();
  const source = makeAsset(project, { purpose: "source" });
  const operation = randomUUID();
  const first = queue.enqueue(project, { kind: "observe", clientOperationId: operation });
  const output = store.insert<ObservationRecord>("observations", {
    id: store.id(), projectId: project.id, assetIds: [source.id], output: demoObservation,
    trace: { testFixture: true }, source: "meta", createdAt: store.now(),
  });
  queue.saveJob({ ...first, status: "completed", resultId: output.id, completedAt: store.now() });
  const replay = queue.enqueue(project, { kind: "observe", clientOperationId: operation });
  assert.equal(replay.id, first.id);
  assert.equal(replay.requestHash, first.requestHash);
  assert.equal(replay.resultId, output.id);
  assert.equal(replay.status, "completed");
  assert.equal(queue.jobsFor(project.id).length, 1);
});

test("queued plan freezes its observation references instead of taking later observations", () => {
  const { project } = fixture();
  const initial = store.insert<ObservationRecord>("observations", { id: store.id(), projectId: project.id, assetIds: [], output: demoObservation, trace: { testFixture: true }, source: "meta", createdAt: store.now() });
  const job = queue.enqueue(project, { kind: "plan", clientOperationId: randomUUID() });
  store.insert<ObservationRecord>("observations", { id: store.id(), projectId: project.id, assetIds: [], output: { ...demoObservation, summary: "Later independent observation" }, trace: { testFixture: true }, source: "meta", createdAt: store.now() });
  assert.deepEqual(queue.jobById(job.id)!.observationIds, [initial.id]);
});

test('original pixels remain bound from observation through the actual planner request despite later uploads and observations', async () => {
 const priorKey=process.env.MODEL_API_KEY;process.env.MODEL_API_KEY='offline-fixture-not-a-credential';
 const {project}=fixture();
 const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=','base64');
 const source=makeAsset(project,{purpose:'source',mime:'image/png',durationMs:null,byteLength:bytes.length,sha256:store.bytesHash(bytes),storageKey:store.id()+'.png'});
 writeFileSync(path.join(store.assetRoot,source.storageKey),bytes);
 const bodies:Record<string,any>[]=[];
 const post=test.mock.method(OpenAI.prototype,'post',((_path:string,options:unknown)=>{
  const pending=Promise.resolve(options as {body:Record<string,any>}).then(({body})=>{
   bodies.push(body);const observation=body.text.format.name==='countershot_observation';
   return {id:observation?'resp_offline_observed_pixels':'resp_offline_planned_pixels',model:'muse-spark-1.3',status:'completed',usage:{total_tokens:1},output:[{type:'message',role:'assistant',id:store.id(),status:'completed',content:[{type:'output_text',text:JSON.stringify(observation?demoObservation:demoProposal)}]}]};
  });
  return {_thenUnwrap:(transform:(value:any)=>unknown)=>pending.then(transform)};
 }) as unknown as typeof OpenAI.prototype.post);
 try{
  const analysis=queue.enqueue(project,{kind:'observe',clientOperationId:randomUUID()});
  const unobserved=makeAsset(project,{purpose:'source'}); // No bytes exist: this must never reach either request.
  await processJob(queue.claimJob()!);
  const observed=store.get<ObservationRecord>('observations',queue.jobById(analysis.id)!.resultId!)!;
  assert.deepEqual(observed.assetIds,[source.id]);
  assert.deepEqual(observed.evidenceAssets,[queue.evidenceAssetSnapshot(source)]);
  const job=queue.enqueue(project,{kind:'plan',clientOperationId:randomUUID()});
  recordedObservation(project,[unobserved],{createdAt:'2099-01-01T00:00:00.000Z',output:{...demoObservation,summary:'Unrelated later scene'}});
  const late=makeAsset(project,{purpose:'source'});
  await processJob(queue.claimJob()!);
  assert.equal(queue.jobById(job.id)!.status,'completed');assert.equal(bodies.length,2);
  for(const body of bodies){
   const images=body.input[0].content.filter((part:any)=>part.type==='input_image');
   assert.deepEqual(images.map((part:any)=>part.image_url),['data:image/png;base64,'+bytes.toString('base64')]);
  }
  const payload=JSON.parse(bodies[1].input[0].content[0].text);
  assert.equal(payload.observation.summary,observed.output.summary);
  assert.deepEqual(payload.evidenceManifest.sourceObservationIds,[observed.id]);
  assert.deepEqual(payload.evidenceManifest.assets,[{assetId:source.id,role:'original_source',mime:source.mime,sha256:source.sha256,byteLength:source.byteLength,durationMs:null,uploadedAt:source.createdAt,captureTimeStatus:'unknown',observationIds:[observed.id]}]);
  assert.ok(!JSON.stringify(bodies[1]).includes(unobserved.id));assert.ok(!JSON.stringify(bodies[1]).includes(late.id));
  const design=store.get<Design>('designs',queue.jobById(job.id)!.resultId!)!;
  assert.deepEqual((design.trace as any).planningEvidence,payload.evidenceManifest);
  assert.equal((design.trace as any).planningEvidenceHash,planningEvidenceHash(payload.evidenceManifest));
 }finally{post.mock.restore();if(priorKey===undefined)delete process.env.MODEL_API_KEY;else process.env.MODEL_API_KEY=priorKey;}
});

test('a plan selects the exact last frozen observer media, never all uploaded source files', () => {
 const {project}=fixture();const first=makeAsset(project,{purpose:'source'});const selected=makeAsset(project,{purpose:'source'});const unused=makeAsset(project,{purpose:'source'});
 recordedObservation(project,[first],{createdAt:'2026-01-01T00:00:00.000Z'});
 const observation=recordedObservation(project,[selected],{createdAt:'2026-01-02T00:00:00.000Z'});
 const job=queue.enqueue(project,{kind:'plan',clientOperationId:randomUUID()});
 assert.deepEqual(job.evidenceContext!.sourceObservationIds,[observation.id]);
 assert.deepEqual(job.evidenceContext!.sourceAssets,[queue.evidenceAssetSnapshot(selected)]);
 assert.equal(job.evidenceContext!.sourceStatus,'observation_bound');
 assert.ok(job.assetIds.includes(first.id)&&job.assetIds.includes(unused.id),'Existing job upload references remain auditable without entering the model context');
});

test('media-backed observations without their original fingerprint require a fresh analysis before planning', () => {
 const {project}=fixture();const source=makeAsset(project,{purpose:'source'});
 const old=recordedObservation(project,[source]);delete old.evidenceAssets;store.replace('observations',old);
 expectHttp(()=>queue.enqueue(project,{kind:'plan',clientOperationId:randomUUID()}),409);
 assert.equal(queue.jobsFor(project.id).length,0);
 assert.equal(store.get<ObservationRecord>('observations',old.id)!.evidenceAssets,undefined,'Historical provenance is never backfilled');
});

test('the observer fingerprint blocks planning when a source record is replaced after analysis', () => {
 const {project}=fixture();const source=makeAsset(project,{purpose:'source'});recordedObservation(project,[source]);
 store.replace('assets',{...source,sha256:store.hash('replacement pixels')});
 expectHttp(()=>queue.enqueue(project,{kind:'plan',clientOperationId:randomUUID()}),409);
 assert.equal(queue.jobsFor(project.id).length,0);
});

test('nested observation media references must be owned source assets before a plan can be enqueued', () => {
 const f=fixture();const other=fixture();const foreign=makeAsset(other.project,{purpose:'source'});const trial=makeAsset(f.project);
 for(const asset of [foreign,trial]){
  const observation=recordedObservation(f.project,[asset]);
  expectHttp(()=>queue.enqueue(f.project,{kind:'plan',clientOperationId:randomUUID()}),400);
  store.db.prepare("DELETE FROM records WHERE collection='observations' AND id=?").run(observation.id);
 }
 assert.equal(queue.jobsFor(f.project.id).length,0);
});

test('bounded observation selection lets a project with nine saved sources analyze a focused ordered subset', async () => {
 const {project}=fixture();const sources=Array.from({length:9},()=>makeAsset(project,{purpose:'source'}));
 expectHttp(()=>queue.enqueue(project,{kind:'observe',clientOperationId:randomUUID()}),413);
 assert.equal(queue.jobsFor(project.id).length,0,'Over-budget inputs cannot leave an unusable queued job');
 const selected=[sources[8],sources[2]];const operation=randomUUID();
 const analysis=queue.enqueue(project,{kind:'observe',sourceAssetIds:selected.map(asset=>asset.id),clientOperationId:operation});
 assert.deepEqual(analysis.assetIds,selected.map(asset=>asset.id));
 assert.deepEqual(analysis.evidenceContext!.sourceAssets,selected.map(queue.evidenceAssetSnapshot));
 assert.equal(queue.enqueue(project,{kind:'observe',sourceAssetIds:selected.map(asset=>asset.id),clientOperationId:operation}).id,analysis.id);
 expectHttp(()=>queue.enqueue(project,{kind:'observe',sourceAssetIds:[...selected].reverse().map(asset=>asset.id),clientOperationId:operation}),409);
 makeAsset(project,{purpose:'source'});
 store.insert('job_outputs',{id:analysis.id,projectId:project.id,result:{output:structuredClone(demoObservation),trace:{testFixture:true}},createdAt:store.now()});
 await processJob(queue.claimJob()!);
 const observation=store.get<ObservationRecord>('observations',queue.jobById(analysis.id)!.resultId!)!;
 assert.deepEqual(observation.assetIds,selected.map(asset=>asset.id));
 assert.deepEqual(observation.evidenceAssets,selected.map(queue.evidenceAssetSnapshot));
 const plan=queue.enqueue(project,{kind:'plan',clientOperationId:randomUUID()});
 assert.deepEqual(plan.evidenceContext!.sourceAssets,selected.map(queue.evidenceAssetSnapshot),'Planning inherits the focused observation even when the complete upload history exceeds the source budget');
});

test('observation source selection rejects empty, duplicate, invalid, missing, foreign and trial IDs and cannot alter plan lineage', () => {
 const {project,design}=fixture();const own=makeAsset(project,{purpose:'source'});const trial=makeAsset(project);
 const other=fixture();const foreign=makeAsset(other.project,{purpose:'source'});
 for(const sourceAssetIds of [[],[own.id,own.id],['not-an-asset-id'],[store.id()],[foreign.id],[trial.id],Array.from({length:9},()=>store.id())]){
  assert.throws(()=>queue.enqueue(project,{kind:'observe',sourceAssetIds,clientOperationId:randomUUID()}),error=>http.errorResponse(error).status===400);
 }
 for(const kind of ['plan','revise'] as const)expectHttp(()=>queue.enqueue(project,{kind,parentDesignId:kind==='revise'?design.id:undefined,sourceAssetIds:[own.id],clientOperationId:randomUUID()}),400);
 assert.equal(queue.jobsFor(project.id).length,0);
});

test('source evidence byte, file and video budgets and invalid metadata fail before enqueueing observe or plan jobs', () => {
 for(const assets of [
  [{byteLength:51*1024*1024}],
  Array.from({length:3},()=>({byteLength:40*1024*1024})),
  Array.from({length:2},()=>({durationMs:200_000})),
 ]){
  const {project}=fixture();for(const overrides of assets)makeAsset(project,{purpose:'source',...overrides});
  for(const kind of ['observe','plan'])expectHttp(()=>queue.enqueue(project,{kind,clientOperationId:randomUUID()}),413);
  assert.equal(queue.jobsFor(project.id).length,0);
 }
 const {project}=fixture();makeAsset(project,{purpose:'source',sha256:'missing-fingerprint'});
 for(const kind of ['observe','plan'])expectHttp(()=>queue.enqueue(project,{kind,clientOperationId:randomUUID()}),400);
 assert.equal(queue.jobsFor(project.id).length,0);
});

test('frozen source metadata is rechecked before fresh requests, known-response retrieval and cached publication', async () => {
 const post=test.mock.method(OpenAI.prototype,'post',()=>{throw new Error('Changed evidence cannot reach a provider');});
 const get=test.mock.method(OpenAI.prototype,'get',()=>{throw new Error('Changed evidence cannot retrieve a response');});
 const errors=test.mock.method(console,'error',()=>{});
 try{
  for(const kind of ['observe','plan'] as const)for(const mode of ['fresh','cached','known_response'] as const){
   const {project,design}=fixture();const source=makeAsset(project,{purpose:'source'});
   if(kind==='plan')recordedObservation(project,[source]);
   const job=queue.enqueue(project,{kind,clientOperationId:randomUUID()});
   if(mode==='cached'){
    if(kind==='plan')cacheProposal(job);
    else store.insert('job_outputs',{id:job.id,projectId:project.id,result:{output:structuredClone(demoObservation),trace:{testFixture:true}},createdAt:store.now()});
   }else if(mode==='known_response')store.insert('model_traces',{id:job.id,projectId:project.id,trace:{providerResponseId:'resp_must_not_retrieve',...(kind==='plan'?evidenceTrace(job):{})},createdAt:store.now()});
   store.replace('assets',{...source,storageKey:store.id()+'.mp4'});
   await processJob(queue.claimJob()!);
   assert.equal(queue.jobById(job.id)!.status,'failed');assert.match(queue.jobById(job.id)!.error!,/changed.*frozen/);
   assert.equal(queue.jobById(job.id)!.resultId,null);assert.equal(fresh(project).currentDesignId,design.id);
   assert.equal(store.list('observations',project.id).length,kind==='plan'?1:0);
  }
  assert.equal(post.mock.callCount(),0);assert.equal(get.mock.callCount(),0);
 }finally{post.mock.restore();get.mock.restore();errors.mock.restore();}
});

test('media-bearing cached or recovered proposals need the exact frozen evidence manifest before publication', async () => {
 const priorKey=process.env.MODEL_API_KEY;process.env.MODEL_API_KEY='offline-fixture-not-a-credential';
 const post=test.mock.method(OpenAI.prototype,'post',()=>{throw new Error('Recovery cannot repeat a generation');});
 const get=test.mock.method(OpenAI.prototype,'get',(()=>({_thenUnwrap:(transform:(value:any)=>unknown)=>Promise.resolve(recoveredReply()).then(transform)})) as unknown as typeof OpenAI.prototype.get);
 const errors=test.mock.method(console,'error',()=>{});
 try{
  for(const mode of ['cached','known_response'] as const)for(const identity of ['missing','wrong_hash','different_media','valid'] as const){
   const {project,design}=fixture();const source=makeAsset(project,{purpose:'source'});recordedObservation(project,[source]);
   const job=queue.enqueue(project,{kind:'plan',clientOperationId:randomUUID()});
   let trace:Record<string,any>={providerResponseId:'resp_offline_lease_final'};
   if(identity!=='missing')trace={...trace,...evidenceTrace(job)};
   if(identity==='wrong_hash')trace.planningEvidenceHash='0'.repeat(64);
   if(identity==='different_media'){
    trace.planningEvidence=structuredClone(trace.planningEvidence);trace.planningEvidence.assets[0].sha256='f'.repeat(64);
    trace.planningEvidenceHash=planningEvidenceHash(trace.planningEvidence);
   }
   if(mode==='cached')store.insert('job_outputs',{id:job.id,projectId:project.id,result:{output:structuredClone(demoProposal),trace},createdAt:store.now()});
   else store.insert('model_traces',{id:job.id,projectId:project.id,trace,createdAt:store.now()});
   const beforeGets=get.mock.callCount();await processJob(queue.claimJob()!);
   const completed=queue.jobById(job.id)!;
   if(identity==='valid'){
    assert.equal(completed.status,'completed');assert.ok(completed.resultId);
    assert.equal(get.mock.callCount()-beforeGets,mode==='known_response'?1:0);
   }else{
    assert.equal(completed.status,'failed');assert.match(completed.error!,/exact planning evidence/);
    assert.equal(completed.resultId,null);assert.equal(fresh(project).currentDesignId,design.id);assert.equal(get.mock.callCount(),beforeGets);
   }
  }
  assert.equal(post.mock.callCount(),0);
 }finally{post.mock.restore();get.mock.restore();errors.mock.restore();if(priorKey===undefined)delete process.env.MODEL_API_KEY;else process.env.MODEL_API_KEY=priorKey;}
});

test("revision freezes exact failed trials and their evidence, excluding unrelated source media", () => {
  const { project, design } = fixture();
  const build = makeBuild(project, design);
  const source = makeAsset(project, { purpose: "source" });
  const evidence = makeAsset(project);
  const trial = makeTrial(project, build.id, { evidenceAssetId: evidence.id, criteria: { ...criteria, closure: "fail" } });
  const job = queue.enqueue(project, { kind: "revise", parentDesignId: design.id, feedback: "Actual trial fixture closure failed", clientOperationId: randomUUID() });
  const laterEvidence = makeAsset(project);
  makeTrial(project, build.id, { evidenceAssetId: laterEvidence.id, criteria: { ...criteria, removal: "fail" } });
  const frozen = queue.jobById(job.id)!;
  assert.deepEqual(frozen.sourceTrialIds, [trial.id]);
  assert.deepEqual(frozen.assetIds, [evidence.id]);
  assert.ok(!frozen.assetIds.includes(source.id));
  assert.ok(!frozen.assetIds.includes(laterEvidence.id));
  assert.equal(frozen.evidenceContext!.sourceStatus,'historical_unavailable');
  assert.deepEqual(frozen.evidenceContext!.sourceAssets,[]);
  assert.deepEqual(frozen.evidenceContext!.trialAssets.map(asset=>asset.id),[evidence.id]);
});

test('a revision inherits its exact parent original evidence and keeps failed-trial pixels in a separate role', async () => {
 const {project}=fixture();const source=makeAsset(project,{purpose:'source'});const observation=recordedObservation(project,[source],{createdAt:'2026-01-01T00:00:00.000Z'});
 const parentJob=queue.enqueue(project,{kind:'plan',clientOperationId:randomUUID()});cacheProposal(parentJob);await processJob(queue.claimJob()!);
 const parent=store.get<Design>('designs',queue.jobById(parentJob.id)!.resultId!)!;
 const unrelated=makeAsset(project,{purpose:'source'});recordedObservation(project,[unrelated],{createdAt:'2099-01-01T00:00:00.000Z'});
 const build=makeBuild(fresh(project),parent);const failedMedia=makeAsset(project);
 const trial=makeTrial(project,build.id,{evidenceAssetId:failedMedia.id,criteria:{...criteria,closure:'fail'}});
 const revision=queue.enqueue(fresh(project),{kind:'revise',parentDesignId:parent.id,sourceTrialIds:[trial.id],feedback:'The closure catches in this exact trial',clientOperationId:randomUUID()});
 assert.deepEqual(revision.observationIds,[observation.id]);
 assert.deepEqual(revision.evidenceContext!.sourceAssets,[queue.evidenceAssetSnapshot(source)]);
 assert.deepEqual(revision.evidenceContext!.trialAssets,[queue.evidenceAssetSnapshot(failedMedia)]);
 cacheProposal(revision);await processJob(queue.claimJob()!);
 const completed=queue.jobById(revision.id)!;assert.equal(completed.status,'completed');
 const trace=store.get<Design>('designs',completed.resultId!)!.trace as any;
 assert.deepEqual(trace.planningEvidence.assets.map((asset:any)=>({id:asset.assetId,role:asset.role,observations:asset.observationIds})),[
  {id:source.id,role:'original_source',observations:[observation.id]},
  {id:failedMedia.id,role:'failed_trial',observations:[]},
 ]);
 assert.ok(!JSON.stringify(trace).includes(unrelated.id));
});

test('a parent using its full original-evidence budget retains separate capacity for a failed trial', async () => {
 const {project}=fixture();
 const sources=Array.from({length:8},()=>makeAsset(project,{purpose:'source',byteLength:12.5*1024*1024,durationMs:45_000}));
 recordedObservation(project,sources);
 const parentJob=queue.enqueue(project,{kind:'plan',clientOperationId:randomUUID()});cacheProposal(parentJob);await processJob(queue.claimJob()!);
 const parent=store.get<Design>('designs',queue.jobById(parentJob.id)!.resultId!)!;
 const build=makeBuild(fresh(project),parent);const evidence=makeAsset(project,{byteLength:50*1024*1024,durationMs:180_000});
 const trial=makeTrial(project,build.id,{evidenceAssetId:evidence.id,criteria:{...criteria,closure:'fail'}});
 const revision=queue.enqueue(fresh(project),{kind:'revise',parentDesignId:parent.id,sourceTrialIds:[trial.id],feedback:'Review this failed closure against the exact original scene',clientOperationId:randomUUID()});
 assert.deepEqual(revision.evidenceContext!.sourceAssets,parentJob.evidenceContext!.sourceAssets);
 assert.deepEqual(revision.evidenceContext!.trialAssets,[queue.evidenceAssetSnapshot(evidence)]);
 const manifest=evidenceTrace(revision).planningEvidence;
 assert.equal(manifest.assets.length,9);assert.equal(manifest.assets.reduce((total,asset)=>total+asset.byteLength,0),150*1024*1024);
 assert.equal(manifest.assets.reduce((total,asset)=>total+(asset.durationMs||0),0),540_000);
 cacheProposal(revision);await processJob(queue.claimJob()!);
 assert.equal(queue.jobById(revision.id)!.status,'completed');
});

test('revision freezes only selected failed trials and rejects foreign or unrelated selections',()=>{
 const f=fixture();const build=makeBuild(f.project,f.design);
 const firstEvidence=makeAsset(f.project);const secondEvidence=makeAsset(f.project);
 const first=makeTrial(f.project,build.id,{evidenceAssetId:firstEvidence.id,criteria:{...criteria,closure:'fail'}});
 const second=makeTrial(f.project,build.id,{evidenceAssetId:secondEvidence.id,criteria:{...criteria,removal:'fail'}});
 const selected=queue.enqueue(f.project,{kind:'revise',parentDesignId:f.design.id,sourceTrialIds:[second.id],feedback:'Only the selected release failure',clientOperationId:randomUUID()});
 assert.deepEqual(selected.sourceTrialIds,[second.id]);assert.deepEqual(selected.assetIds,[secondEvidence.id]);
 queue.cancelJob(f.project.id,selected.id);
 const other=fixture();const otherBuild=makeBuild(other.project,other.design);const foreign=makeTrial(other.project,otherBuild.id);
 const secondDesign=store.insert<Design>('designs',{...f.design,id:store.id(),number:2});
 const secondBuild=makeBuild(f.project,secondDesign);const unrelated=makeTrial(f.project,secondBuild.id);
 const complete=makeTrial(f.project,build.id,{evidenceAssetId:firstEvidence.id});assert.equal(complete.outcome,'observed_complete');
 for(const sourceTrialIds of [[foreign.id],[unrelated.id],[complete.id]])expectHttp(()=>queue.enqueue(f.project,{kind:'revise',parentDesignId:f.design.id,sourceTrialIds,feedback:'Invalid selection',clientOperationId:randomUUID()}),400);
 expectHttp(()=>queue.enqueue(f.project,{kind:'plan',sourceTrialIds:[first.id],clientOperationId:randomUUID()}),400);
});

const recoveredReply=()=>({id:'resp_offline_lease_final',model:'muse-spark-1.3',status:'completed',usage:{total_tokens:7},output:[{type:'message',role:'assistant',id:'msg_offline_lease',status:'completed',content:[{type:'output_text',text:JSON.stringify(demoProposal)}]}]});

function savedInvocation(job: Job, suffix: string): InvocationSpec {
 return { invocationId: `${job.id}:${suffix}`, parentInvocationId: null, role: 'planning_audit', route: 'planning',
  model: job.executionSpec.model, contextHash: store.hash({ job: job.id, suffix }), promptVersion: job.executionSpec.promptVersion,
  schemaVersion: job.executionSpec.schemaVersion, toolVersion: job.executionSpec.checkerVersion, maxOutputTokens: 10_000, inputBytes: 42 };
}

test('worker reserves one durable invocation before each actual planner POST and shares four calls across checker continuations', async () => {
 const previousKey=process.env.MODEL_API_KEY;process.env.MODEL_API_KEY='offline-fixture-not-a-credential';
 const f=workshopFixture();const job=queue.enqueue(f.project,{kind:'plan',clientOperationId:randomUUID()});
 const invalid=structuredClone(workshopProposal.jigProgram)!;invalid.registrationClearanceMm=workshopFacts.alignmentToleranceMm+1;
 const final=structuredClone(workshopProposal);final.jigProgram!.baseWidthMm+=0.01;
 const beforePosts:ExecutionBudget[]=[];
 store.db.exec('CREATE TEMP TABLE job_budget_trace_checkpoints (value INTEGER);');
 store.db.exec("CREATE TEMP TRIGGER count_job_budget_trace_checkpoints AFTER UPDATE ON records WHEN NEW.collection='model_traces' BEGIN INSERT INTO job_budget_trace_checkpoints(value) VALUES(1); END;");
 const post=test.mock.method(OpenAI.prototype,'post',((_path:string,options:unknown)=>{
  const budget=queue.jobById(job.id)!.executionBudget!;
  beforePosts.push(structuredClone(budget));const serial=beforePosts.length;
  assert.equal(budget.invocations.length,serial,'The reservation must already be durable when the SDK starts its POST.');
  assert.equal(budget.invocations.at(-1)!.status,'reserved');
  assert(budget.invocations.slice(0,-1).every(invocation=>invocation.status==='responded'));
  const output=serial<4?[{type:'function_call',id:`fc_worker_budget_${serial}`,status:'completed',call_id:`call_worker_budget_${serial}`,
   name:'check_task_plan',arguments:JSON.stringify(serial<3?invalid:workshopProposal.jigProgram)}]
   :[{type:'message',role:'assistant',id:'msg_worker_budget_final',status:'completed',content:[{type:'output_text',text:JSON.stringify(final)}]}];
  const response={id:`resp_worker_budget_${serial}`,model:'muse-spark-1.3',status:'completed',usage:{input_tokens:11,output_tokens:3,total_tokens:14},output};
  const pending=Promise.resolve(options as {body:Record<string,any>}).then(({body})=>{
   if(serial===4){assert.deepEqual(body.tools,[]);assert.equal(body.previous_response_id,'resp_worker_budget_3');}
   return response;
  });
  return {_thenUnwrap:(transform:(value:any)=>unknown)=>pending.then(transform)};
 }) as unknown as typeof OpenAI.prototype.post);
 try{
  await processJob(queue.claimJob()!);
  const completed=queue.jobById(job.id)!;assert.equal(completed.status,'completed',completed.error||'The checked final proposal should complete.');
  const budget=completed.executionBudget!;
  assert.equal(beforePosts.length,4);assert.equal(budget.limits.maxInvocations,4);assert.equal(budget.limits.maxOutputTokens,80_000);
  assert.equal(budget.invocations.length,4);assert.equal(budget.tools.length,3);
  assert.deepEqual(budget.invocations.map(invocation=>invocation.parentInvocationId),[null,...budget.invocations.slice(0,-1).map(invocation=>invocation.invocationId)]);
  assert.deepEqual(budget.invocations.map(invocation=>invocation.responseId),[1,2,3,4].map(serial=>`resp_worker_budget_${serial}`));
  assert.equal(budget.invocations.reduce((total,invocation)=>total+invocation.maxOutputTokens,0),80_000);
  assert.equal(budget.invocations.reduce((total,invocation)=>total+(invocation.usage?.totalTokens||0),0),56);
  assert(budget.invocations.every(invocation=>invocation.status==='responded'&&/^[a-f0-9]{64}$/.test(invocation.contextHash)));
  const callbacks=store.db.prepare('SELECT COUNT(*) AS count FROM job_budget_trace_checkpoints').get() as {count:number};
  assert(callbacks.count>beforePosts.length,'Multiple trace checkpoints must not become additional invocation reservations.');
  const design=store.get<Design>('designs',completed.resultId!)!;const trace=design.trace as ModelTrace;
  assert.equal(trace.plannerChecks?.final?.relation,'differs_from_tool_checked_candidates');
  assert.equal(trace.plannerChecks?.toolChecks.length,3);
  assert.deepEqual(trace.plannerChecks?.final?.checks,checkDesign(workshopFacts,final));
  assert.equal(trace.plannerChecks?.final?.physicalStatus,'untested');
  assert.deepEqual(trace.executionBudget,budget);
 }finally{post.mock.restore();store.db.exec('DROP TRIGGER IF EXISTS count_job_budget_trace_checkpoints;');store.db.exec('DROP TABLE IF EXISTS job_budget_trace_checkpoints;');if(previousKey===undefined)delete process.env.MODEL_API_KEY;else process.env.MODEL_API_KEY=previousKey;}
});

test('exhausted, expired and cancelled saved job allowances stop before any generation POST or new design', async () => {
 const previousKey=process.env.MODEL_API_KEY;process.env.MODEL_API_KEY='offline-fixture-not-a-credential';
 const post=test.mock.method(OpenAI.prototype,'post',()=>{throw new Error('A spent or cancelled saved budget cannot start a POST');});
 const get=test.mock.method(OpenAI.prototype,'get',()=>{throw new Error('No known response exists in this exhausted/unknown budget fixture');});
 const errors=test.mock.method(console,'error',()=>{});
 try{
  for(const mode of ['calls','output_tokens','deadline','cancelled'] as const){
   const f=fixture();const job=queue.enqueue(f.project,{kind:'plan',clientOperationId:randomUUID()});
   const limits={...DEFAULT_PLANNING_EXECUTION_LIMITS,...(mode==='calls'?{maxInvocations:1}:mode==='output_tokens'?{maxOutputTokens:1}:{})};
   let budget=createExecutionBudget(job.id,limits,Date.now()-(mode==='deadline'?limits.maxDurationMs+1:0));
   if(mode==='calls')budget=markInvocationUnknown(reserveInvocation(budget,savedInvocation(job,'spent-call')).state,`${job.id}:spent-call`,'interrupted');
   if(mode==='cancelled')budget=cancelExecutionBudget(budget);
   queue.saveJob({...job,executionBudget:budget});
   await processJob(queue.claimJob()!);
   const failed=queue.jobById(job.id)!;assert.equal(failed.status,'failed');assert.equal(failed.resultId,null);
   assert.match(failed.error!,mode==='cancelled'?/cancelled/i:/allowance|exhaust|deadline/i);
   assert.equal(fresh(f.project).currentDesignId,f.design.id);
   assert.equal(store.list<Design>('designs',f.project.id).length,1);
   assert.deepEqual(failed.executionBudget,budget,'Rejecting a reservation cannot reset or replenish the saved allowance.');
  }
  assert.equal(post.mock.callCount(),0);
  assert.equal(get.mock.callCount(),0);
 }finally{post.mock.restore();get.mock.restore();errors.mock.restore();if(previousKey===undefined)delete process.env.MODEL_API_KEY;else process.env.MODEL_API_KEY=previousKey;}
});

test('cached and retrieved worker outputs bind fresh final checks to the actual proposal and retain the original tool-candidate history', async () => {
 const previousKey=process.env.MODEL_API_KEY;process.env.MODEL_API_KEY='offline-fixture-not-a-credential';
 const final=structuredClone(workshopProposal);final.jigProgram!.baseWidthMm+=0.01;
 const response={...recoveredReply(),id:'resp_offline_recovered_changed_jig',output:[{type:'message',role:'assistant',id:'msg_recovered_changed_jig',status:'completed',content:[{type:'output_text',text:JSON.stringify(final)}]}]};
 const post=test.mock.method(OpenAI.prototype,'post',()=>{throw new Error('Known output recovery cannot repeat generation');});
 const get=test.mock.method(OpenAI.prototype,'get',(()=>({_thenUnwrap:(transform:(value:any)=>unknown)=>Promise.resolve(response).then(transform)})) as unknown as typeof OpenAI.prototype.get);
 try{
  for(const mode of ['cached','retrieved'] as const){
   const f=workshopFixture();const job=queue.enqueue(f.project,{kind:'plan',clientOperationId:randomUUID()});
   const baseline=finalizePlannerChecks(workshopFacts,workshopProposal);
   const prior:PlannerCheckProvenance={...baseline,final:null,toolChecks:[{
    responseId:'resp_offline_prior_jig_check',callId:'call_offline_prior_jig_check',rawArgumentsHash:store.bytesHash(JSON.stringify(workshopProposal.jigProgram)),
    canonicalInputHash:baseline.final!.candidateHash,candidateScope:'jig_program',candidateHash:baseline.final!.candidateHash,status:'checked',
    checksHash:baseline.final!.checksHash,checks:baseline.final!.checks,
   }]};
   const trace={providerResponseId:response.id,usage:[{total_tokens:7}],plannerChecks:prior,...evidenceTrace(job)};
   if(mode==='cached')store.insert('job_outputs',{id:job.id,projectId:f.project.id,result:{output:final,trace},createdAt:store.now()});
   else store.insert('model_traces',{id:job.id,projectId:f.project.id,trace,createdAt:store.now()});
   const before=get.mock.callCount();await processJob(queue.claimJob()!);
   const completed=queue.jobById(job.id)!;assert.equal(completed.status,'completed');
   const design=store.get<Design>('designs',completed.resultId!)!,proof=(design.trace as ModelTrace).plannerChecks!;
   assert.deepEqual(design.proposal,final);assert.deepEqual(proof.toolChecks,prior.toolChecks);
   assert.equal(proof.final?.relation,'differs_from_tool_checked_candidates');
   assert.notEqual(proof.final?.candidateHash,prior.toolChecks[0].candidateHash);
   assert.equal(proof.final?.proposalHash,finalizePlannerChecks(workshopFacts,final).final?.proposalHash);
   assert.deepEqual(proof.final?.checks,checkDesign(workshopFacts,final));
   assert.equal(get.mock.callCount()-before,mode==='retrieved'?1:0);
   if(mode==='retrieved')assert.equal((design.trace as ModelTrace).recovered,true);
  }
  assert.equal(post.mock.callCount(),0);
 }finally{post.mock.restore();get.mock.restore();if(previousKey===undefined)delete process.env.MODEL_API_KEY;else process.env.MODEL_API_KEY=previousKey;}
});

function crashWindowBudget(job: Job, finalStatus: 'responded' | 'reserved' | 'unknown' = 'responded') {
 const first=savedInvocation(job,'durable-tool');
 let budget=recordInvocationResponse(reserveInvocation(createExecutionBudget(job.id,DEFAULT_PLANNING_EXECUTION_LIMITS),first).state,
  first.invocationId,'resp_offline_durable_tool',{input_tokens:10,output_tokens:5,total_tokens:15});
 const final={...savedInvocation(job,'durable-final'),parentInvocationId:first.invocationId};
 budget=reserveInvocation(budget,final).state;
 if(finalStatus==='responded')budget=recordInvocationResponse(budget,final.invocationId,'resp_offline_durable_final',{input_tokens:20,output_tokens:6,total_tokens:26});
 if(finalStatus==='unknown')budget=markInvocationUnknown(budget,final.invocationId,'interrupted');
 return budget;
}

test('expired jobs recover the latest durable final response when the trace checkpoint is old, null or absent', async () => {
 const previousKey=process.env.MODEL_API_KEY;process.env.MODEL_API_KEY='offline-fixture-not-a-credential';
 const gets:string[]=[];
 const get=test.mock.method(OpenAI.prototype,'get',((responsePath:string)=>{
  gets.push(responsePath);
  assert.match(responsePath,/\/responses\/resp_offline_durable_final$/,'An older tool-response checkpoint cannot replace the latest durable final answer.');
  const response={...recoveredReply(),id:'resp_offline_durable_final',usage:{input_tokens:20,output_tokens:6,total_tokens:26}};
  return {_thenUnwrap:(transform:(value:any)=>unknown)=>Promise.resolve(response).then(transform)};
 }) as unknown as typeof OpenAI.prototype.get);
 const post=test.mock.method(OpenAI.prototype,'post',()=>{throw new Error('A known durable response must be retrieved without another generation');});
 try{
  for(const checkpoint of ['old_tool','null','absent'] as const){
   const f=fixture();const job=queue.enqueue(f.project,{kind:'plan',clientOperationId:randomUUID()});
   const budget=crashWindowBudget(job);
   if(checkpoint!=='absent')store.insert('model_traces',{id:job.id,projectId:f.project.id,trace:{
    providerResponseId:checkpoint==='old_tool'?'resp_offline_durable_tool':null,
    responseIds:['resp_offline_durable_tool','resp_offline_durable_tool'],usage:[{total_tokens:999}],...evidenceTrace(job),
   },createdAt:store.now()});
   queue.saveJob({...job,status:'running',attempt:1,leaseUntil:'2000-01-01T00:00:00.000Z',executionBudget:budget});
   const claimed=queue.claimJob()!;assert.ok(claimed);assert.equal(claimed.id,job.id);assert.equal(claimed.attempt,2);
   const before=gets.length;await processJob(claimed);
   const completed=queue.jobById(job.id)!;assert.equal(completed.status,'completed',completed.error||'The latest known final response should recover.');
   assert.equal(gets.length-before,1);assert.equal(post.mock.callCount(),0);
   const design=store.get<Design>('designs',completed.resultId!)!,trace=design.trace as ModelTrace;
   assert.deepEqual(design.proposal,demoProposal);assert.equal(trace.providerResponseId,'resp_offline_durable_final');
   assert.deepEqual(trace.responseIds,['resp_offline_durable_tool','resp_offline_durable_final']);
   assert.deepEqual(trace.usage,[{input_tokens:10,output_tokens:5,total_tokens:15},{input_tokens:20,output_tokens:6,total_tokens:26}],
    'Actual durable usage replaces an older incomplete/stale trace checkpoint without counting any response twice.');
   assert.deepEqual(trace.executionBudget,budget);assert.equal(trace.recovered,true);
   assert.equal(trace.plannerChecks?.final?.proposalHash,finalizePlannerChecks(demoFacts,demoProposal).final?.proposalHash);
   assert.deepEqual(trace.plannerChecks?.final?.checks,checkDesign(demoFacts,demoProposal));
  }
 }finally{get.mock.restore();post.mock.restore();if(previousKey===undefined)delete process.env.MODEL_API_KEY;else process.env.MODEL_API_KEY=previousKey;}
});

test('an unknown last continuation prevents retrieval of an older response; only a completed local output permits recovery', async () => {
 const previousKey=process.env.MODEL_API_KEY;process.env.MODEL_API_KEY='offline-fixture-not-a-credential';
 const get=test.mock.method(OpenAI.prototype,'get',()=>{throw new Error('An older known response cannot stand in for a newer unknown continuation');});
 const post=test.mock.method(OpenAI.prototype,'post',()=>{throw new Error('An interrupted continuation cannot be generated again automatically');});
 try{
  for(const finalStatus of ['reserved','unknown'] as const)for(const cached of [false,true]){
   const f=fixture();const job=queue.enqueue(f.project,{kind:'plan',clientOperationId:randomUUID()});
   const budget=crashWindowBudget(job,finalStatus);
   store.insert('model_traces',{id:job.id,projectId:f.project.id,trace:{providerResponseId:'resp_offline_durable_tool',
    responseIds:['resp_offline_durable_tool'],usage:[{total_tokens:15}],...evidenceTrace(job)},createdAt:store.now()});
   if(cached)cacheProposal(job);
   const interrupted={...job,status:'running' as const,attempt:1,leaseUntil:'2000-01-01T00:00:00.000Z',executionBudget:budget};
   queue.saveJob(interrupted);
   const claimed=queue.claimJob();
   if(cached){
    assert.ok(claimed);assert.equal(claimed.id,job.id);await processJob(claimed);
    const recovered=queue.jobById(job.id)!;assert.equal(recovered.status,'completed');
    assert.equal(store.get<Design>('designs',recovered.resultId!)!.proposal.outcome,'candidate');
   }else{
    assert.equal(claimed,null);
    const failed=queue.jobById(job.id)!;assert.equal(failed.status,'failed');assert.match(failed.error!,/interrupted|unknown/i);
    assert.equal(failed.attempt,1);assert.equal(failed.resultId,null);assert.equal(fresh(f.project).currentDesignId,f.design.id);
    await processJob(interrupted); // An obsolete claimed attempt cannot revive the failed operation.
    assert.equal(queue.jobById(job.id)!.status,'failed');
   }
   assert.deepEqual(queue.jobById(job.id)!.executionBudget,budget);
  }
  assert.equal(get.mock.callCount(),0);assert.equal(post.mock.callCount(),0);
 }finally{get.mock.restore();post.mock.restore();if(previousKey===undefined)delete process.env.MODEL_API_KEY;else process.env.MODEL_API_KEY=previousKey;}
});

test('a durable response with different run, route or execution versions cannot be claimed through an older trace fallback', async () => {
 const get=test.mock.method(OpenAI.prototype,'get',()=>{throw new Error('A differently bound durable response cannot be retrieved');});
 const post=test.mock.method(OpenAI.prototype,'post',()=>{throw new Error('A differently bound durable response cannot trigger generation');});
 try{
  const changes:((budget:ExecutionBudget)=>void)[]=[
   budget=>{budget.runId='a-different-application-job';},
   budget=>{budget.invocations.at(-1)!.route='observation';},
   budget=>{budget.invocations.at(-1)!.model='muse-wonder-1.0';},
   budget=>{budget.invocations.at(-1)!.promptVersion='another-prompt';},
   budget=>{budget.invocations.at(-1)!.schemaVersion='another-schema';},
   budget=>{budget.invocations.at(-1)!.toolVersion='another-checker';},
  ];
  for(const change of changes){
   const f=fixture();const job=queue.enqueue(f.project,{kind:'plan',clientOperationId:randomUUID()});
   const budget=crashWindowBudget(job);change(budget);
   store.insert('model_traces',{id:job.id,projectId:f.project.id,trace:{providerResponseId:'resp_offline_durable_tool'},createdAt:store.now()});
   queue.saveJob({...job,status:'running',attempt:1,leaseUntil:'2000-01-01T00:00:00.000Z',executionBudget:budget});
   assert.equal(queue.claimJob(),null);
   const failed=queue.jobById(job.id)!;assert.equal(failed.status,'failed');assert.match(failed.error!,/interrupted|unknown/i);
   assert.equal(failed.resultId,null);assert.equal(fresh(f.project).currentDesignId,f.design.id);
  }
  assert.equal(get.mock.callCount(),0);assert.equal(post.mock.callCount(),0);
 }finally{get.mock.restore();post.mock.restore();}
});

test('a latest durable response does not replace the required original-media manifest during recovery', async () => {
 const previousKey=process.env.MODEL_API_KEY;process.env.MODEL_API_KEY='offline-fixture-not-a-credential';
 const get=test.mock.method(OpenAI.prototype,'get',()=>{throw new Error('Missing media provenance must fail before response retrieval');});
 const post=test.mock.method(OpenAI.prototype,'post',()=>{throw new Error('Missing media provenance cannot trigger replacement generation');});
 const errors=test.mock.method(console,'error',()=>{});
 try{
  const f=fixture();const source=makeAsset(f.project,{purpose:'source'});recordedObservation(f.project,[source]);
  const job=queue.enqueue(f.project,{kind:'plan',clientOperationId:randomUUID()});
  queue.saveJob({...job,status:'running',attempt:1,leaseUntil:'2000-01-01T00:00:00.000Z',executionBudget:crashWindowBudget(job)});
  const claimed=queue.claimJob()!;assert.ok(claimed);await processJob(claimed);
  const failed=queue.jobById(job.id)!;assert.equal(failed.status,'failed');assert.match(failed.error!,/exact planning evidence/);
  assert.equal(failed.resultId,null);assert.equal(fresh(f.project).currentDesignId,f.design.id);
  assert.equal(get.mock.callCount(),0);assert.equal(post.mock.callCount(),0);
 }finally{get.mock.restore();post.mock.restore();errors.mock.restore();if(previousKey===undefined)delete process.env.MODEL_API_KEY;else process.env.MODEL_API_KEY=previousKey;}
});

test('a replaced worker cannot fail a completed attempt or overwrite its trace with a late response',async()=>{
 const previousKey=process.env.MODEL_API_KEY;process.env.MODEL_API_KEY||='offline-fixture-not-a-credential';
 try{
  for(const lateOutcome of ['failure','success'] as const){
   const f=fixture();const job=queue.enqueue(f.project,{kind:'plan',clientOperationId:randomUUID()});
   const old=queue.claimJob()!;
   store.insert('model_traces',{id:job.id,projectId:f.project.id,attempt:old.attempt,trace:{providerResponseId:recoveredReply().id,model:'muse-spark-1.3',usage:[{total_tokens:7}],responseIds:[recoveredReply().id]},createdAt:store.now()});
   let resolveOld!:(value:unknown)=>void;let rejectOld!:(error:Error)=>void;
   const pending=new Promise((resolve,reject)=>{resolveOld=resolve;rejectOld=reject;});let gets=0;
   const get=test.mock.method(OpenAI.prototype,'get',((_path:string)=>{
    const promise=++gets===1?pending:Promise.resolve(recoveredReply());
    return {_thenUnwrap:(transform:(value:any)=>unknown)=>promise.then(transform)};
   }) as unknown as typeof OpenAI.prototype.get);
   const post=test.mock.method(OpenAI.prototype,'post',()=>{throw new Error('Recovery must not start a generation POST');});
   try{
    const oldWork=processJob(old);assert.equal(gets,1);
    queue.saveJob({...queue.jobById(job.id)!,leaseUntil:'2000-01-01T00:00:00.000Z'});
    const next=queue.claimJob()!;assert.equal(next.attempt,old.attempt+1);
    await processJob(next);
    const completed=queue.jobById(job.id)!;assert.equal(completed.status,'completed');
    const traceBefore=store.get('model_traces',job.id);
    const designsBefore=store.list<Design>('designs',f.project.id).length;
    if(lateOutcome==='failure')rejectOld(new Error('Stale original recovery failed'));else resolveOld(recoveredReply());
    await oldWork;
    assert.deepEqual(queue.jobById(job.id),completed);
    assert.deepEqual(store.get('model_traces',job.id),traceBefore);
    assert.equal(store.list<Design>('designs',f.project.id).length,designsBefore);
    assert.equal(fresh(f.project).currentDesignId,completed.resultId);
    assert.equal(store.get<{attempt:number}>('job_outputs',job.id)!.attempt,next.attempt);
    if(lateOutcome==='success'){
     const late=store.get<{late:boolean;trace:{responseIds:string[];usage:unknown}}>('model_attempt_traces',`${job.id}:${old.attempt}`)!;
     assert.equal(late.late,true);assert.deepEqual(late.trace.responseIds,[recoveredReply().id]);assert.deepEqual(late.trace.usage,[{total_tokens:7}]);
    }
    assert.equal(post.mock.callCount(),0);
   }finally{get.mock.restore();post.mock.restore();}
  }
 }finally{if(previousKey===undefined)delete process.env.MODEL_API_KEY;else process.env.MODEL_API_KEY=previousKey;}
});

test('a stale claimed attempt cannot publish the current attempt cached result',async()=>{
 const f=fixture();const job=queue.enqueue(f.project,{kind:'plan',clientOperationId:randomUUID()});cacheProposal(job);
 const old=queue.claimJob()!;queue.saveJob({...queue.jobById(job.id)!,leaseUntil:'2000-01-01T00:00:00.000Z'});
 const current=queue.claimJob()!;await processJob(old);
 assert.equal(queue.jobById(job.id)!.status,'running');assert.equal(queue.jobById(job.id)!.attempt,current.attempt);
 assert.equal(queue.jobById(job.id)!.resultId,null);assert.equal(fresh(f.project).currentDesignId,f.design.id);
 await processJob(current);assert.equal(queue.jobById(job.id)!.status,'completed');
});

test('a cancelled in-flight request retains late paid usage only in its attempt audit',async()=>{
 const priorKey=process.env.MODEL_API_KEY;process.env.MODEL_API_KEY||='offline-fixture-not-a-credential';
 const f=fixture();const job=queue.enqueue(f.project,{kind:'plan',clientOperationId:randomUUID()});const running=queue.claimJob()!;
 let finish!:(value:unknown)=>void;let started!:()=>void;
 const pending=new Promise(resolve=>{finish=resolve;});const entered=new Promise<void>(resolve=>{started=resolve;});
 const post=test.mock.method(OpenAI.prototype,'post',((_path:string)=>{started();return {_thenUnwrap:(transform:(value:any)=>unknown)=>pending.then(transform)};}) as unknown as typeof OpenAI.prototype.post);
 try{
  const work=processJob(running);await entered;
  const traceBefore=store.get('model_traces',job.id);
  const reserved=queue.jobById(job.id)!.executionBudget!;
  assert.equal(reserved.invocations.length,1);assert.equal(reserved.invocations[0].status,'reserved');
  // Simulate another already-accounted read-only invocation arriving while the
  // first request is still pending. Its newer full snapshot must survive the
  // older controller's late response callback and durable cancellation.
  const newerSpec=savedInvocation(job,'newer-audit');
  const newer=recordInvocationResponse(reserveInvocation(reserved,newerSpec).state,newerSpec.invocationId,
   'resp_offline_newer_accounted_audit',{input_tokens:90,output_tokens:9,total_tokens:99});
  queue.saveJob({...queue.jobById(job.id)!,executionBudget:newer});
  queue.cancelJob(f.project.id,job.id);
  const cancelledAt=queue.jobById(job.id)!.executionBudget!.cancelledAt;
  finish(recoveredReply());await work;
  const cancelled=queue.jobById(job.id)!;assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.resultId,null);
  assert.equal(store.get('job_outputs',job.id),null);assert.equal(fresh(f.project).currentDesignId,f.design.id);
  assert.deepEqual(store.get('model_traces',job.id),traceBefore);
  const late=store.get<{late:boolean;trace:{providerResponseId:string;usage:unknown}}>('model_attempt_traces',`${job.id}:${running.attempt}`)!;
  assert.equal(late.late,true);assert.equal(late.trace.providerResponseId,recoveredReply().id);assert.deepEqual(late.trace.usage,[{total_tokens:7}]);
  const budget=cancelled.executionBudget!;
  assert.equal(budget.cancelledAt,cancelledAt);assert.equal(budget.invocations.length,2);
  assert.equal(budget.invocations[0].responseId,recoveredReply().id);assert.equal(budget.invocations[0].usage?.totalTokens,7);
  assert.equal(budget.invocations[1].responseId,'resp_offline_newer_accounted_audit');assert.equal(budget.invocations[1].usage?.totalTokens,99);
  assert.equal(post.mock.callCount(),1,'Cancellation and late accounting cannot start a continuation or duplicate POST.');
 }finally{post.mock.restore();if(priorKey===undefined)delete process.env.MODEL_API_KEY;else process.env.MODEL_API_KEY=priorKey;}
});

test("known cached provider output remains recoverable after an expired worker lease", () => {
  const { project } = fixture();
  const job = queue.enqueue(project, { kind: "plan", clientOperationId: randomUUID() });
  queue.saveJob({ ...job, status: "running", attempt: 1, leaseUntil: "2000-01-01T00:00:00.000Z" });
  store.insert("job_outputs", { id: job.id, projectId: project.id, result: { testFixture: true }, createdAt: store.now() });
  const recovered = queue.claimJob();
  assert.equal(recovered?.id, job.id);
  assert.equal(queue.jobById(job.id)!.status, "running");
  assert.ok(store.get("job_outputs", job.id));
});

test("known provider response ID is reclaimed for retrieval instead of an unknown-outcome failure", () => {
  const { project } = fixture();
  const job = queue.enqueue(project, { kind: "plan", clientOperationId: randomUUID() });
  queue.saveJob({ ...job, status: "running", attempt: 1, leaseUntil: "2000-01-01T00:00:00.000Z" });
  store.insert("model_traces", { id: job.id, projectId: project.id, trace: { providerResponseId: "resp_test_completed", testFixture: true }, createdAt: store.now() });
  const recovered = queue.claimJob();
  assert.equal(recovered?.id, job.id);
  assert.equal(recovered?.status, "running");
  assert.equal(recovered?.error, null);
  assert.equal(store.get<{ trace: { providerResponseId: string } }>("model_traces", job.id)!.trace.providerResponseId, "resp_test_completed");
});

test("unknown interrupted provider work fails explicitly rather than silently repeating", () => {
  const { project } = fixture();
  const job = queue.enqueue(project, { kind: "plan", clientOperationId: randomUUID() });
  queue.saveJob({ ...job, status: "running", attempt: 1, leaseUntil: "2000-01-01T00:00:00.000Z" });
  queue.claimJob();
  const interrupted = queue.jobById(job.id)!;
  assert.equal(interrupted.status, "failed");
  assert.match(interrupted.error!, /unknown|interrupted/i);
  assert.equal(interrupted.attempt, 1);
});

test("cancellation is scoped and persists before any late result can be published", () => {
  const { project } = fixture();
  const other = makeProject();
  const job = queue.enqueue(project, { kind: "plan", clientOperationId: randomUUID() });
  expectHttp(() => queue.cancelJob(other.project.id, job.id), 404);
  queue.cancelJob(project.id, job.id);
  const cancelled = queue.jobById(job.id)!;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.cancelRequested, true);
  assert.ok(cancelled.completedAt);
});

test("worker commits a checked design, matching artifacts, job result and current pointer together", async () => {
  const { project, snapshot } = fixture();
  const before = store.list<Design>("designs", project.id).length;
  const job = queue.enqueue(project, { kind: "plan", clientOperationId: randomUUID() });
  cacheProposal(job);
  const claimed = queue.claimJob()!;
  assert.equal(claimed.id, job.id);
  await processJob(claimed);
  const completed = queue.jobById(job.id)!;
  assert.equal(completed.status, "completed");
  assert.equal(completed.error, null);
  const design = store.get<Design>("designs", completed.resultId!)!;
  assert.equal(design.inputSnapshotId, snapshot.id);
  assert.equal(design.status, "checks_passed");
  assert.equal(design.number, before + 1);
  assert.equal(fresh(project).currentDesignId, design.id);
  assert.equal(store.list<Design>("designs", project.id).length, before + 1);
  assert.match(design.hash, /^[a-f0-9]{64}$/);
  assert.ok(design.artifacts?.packageSvg.includes(design.hash));
  assert.ok(design.artifacts?.stationSvg.includes(design.hash));
  assert.ok(design.artifacts?.printHtml.includes(design.hash));
  assert.ok(design.checks.some(check => check.severity === "trial_required"));
  assert.equal(store.list("trials", project.id).length, 0);
  assert.equal(store.list<{ event: string }>("audit", project.id).filter(event => event.event === "job_finished").length, 1);
});

test("recovered or cached still-image observation cannot promote itself into complete cycle evidence", async () => {
  const {project}=fixture();
  const source=makeAsset(project,{purpose:'source',mime:'image/png',durationMs:null});
  const job=queue.enqueue(project,{kind:'observe',clientOperationId:randomUUID()});
  const output={...demoObservation,evidenceCompleteness:'complete',missingSegments:[]};
  store.insert('job_outputs',{id:job.id,projectId:project.id,result:{output,trace:{testFixture:true,recovered:true}},createdAt:store.now()});
  const claimed=queue.claimJob()!;
  await processJob(claimed);
  const finished=queue.jobById(job.id)!;
  assert.equal(finished.status,'completed');
  const observation=store.get<ObservationRecord>('observations',finished.resultId!)!;
  assert.deepEqual(observation.assetIds,[source.id]);
  assert.equal(observation.output.evidenceCompleteness,'incomplete');
  assert.ok(observation.output.missingSegments.includes('Uninterrupted complete operating cycle video'));
});

test("worker saves output from old facts as superseded without overwriting the newer current design", async () => {
  const { project, snapshot } = fixture();
  const job = queue.enqueue(project, { kind: "plan", clientOperationId: randomUUID() });
  cacheProposal(job);
  const claimed = queue.claimJob()!;
  const newSnapshot = services.confirmFacts(project, { facts: { ...demoFacts, boardThicknessMm: 2 }, confirmed: true });
  const newHash = store.hash({ snapshot: newSnapshot.hash, proposal: demoProposal });
  const currentDesign = store.insert<Design>("designs", {
    id: store.id(), projectId: project.id, number: 2, inputSnapshotId: newSnapshot.id, parentId: null,
    proposal: demoProposal, checks: checkDesign(newSnapshot.facts, demoProposal), hash: newHash,
    artifacts: compileDesign(newSnapshot.facts, demoProposal, newHash), status: "checks_passed",
    trace: { testFixture: true }, source: "meta", createdAt: store.now(),
  });
  const latest = fresh(project);
  latest.currentDesignId = currentDesign.id;
  store.replace("projects", latest);
  await processJob(claimed);
  const completed = queue.jobById(job.id)!;
  const stale = store.get<Design>("designs", completed.resultId!)!;
  assert.equal(completed.status, "superseded");
  assert.equal(stale.status, "superseded");
  assert.equal(stale.inputSnapshotId, snapshot.id);
  assert.equal(fresh(project).currentSnapshotId, newSnapshot.id);
  assert.equal(fresh(project).currentDesignId, currentDesign.id);
  expectHttp(() => makeBuild(fresh(project), stale), 409);
});

test("cancelled worker with cached output cannot publish a design or change the current pointer", async () => {
  const { project, design } = fixture();
  const job = queue.enqueue(project, { kind: "plan", clientOperationId: randomUUID() });
  cacheProposal(job);
  const claimed = queue.claimJob()!;
  queue.cancelJob(project.id, job.id);
  const before = store.list<Design>("designs", project.id).length;
  await processJob(claimed);
  assert.equal(queue.jobById(job.id)!.status, "cancelled");
  assert.equal(queue.jobById(job.id)!.resultId, null);
  assert.equal(store.list<Design>("designs", project.id).length, before);
  assert.equal(fresh(project).currentDesignId, design.id);
});

test("worker recovers a cached completed output after lease expiry without requiring provider access", async () => {
  const { project } = fixture();
  const job = queue.enqueue(project, { kind: "plan", clientOperationId: randomUUID() });
  cacheProposal(job);
  queue.saveJob({ ...job, status: "running", attempt: 1, leaseUntil: "2000-01-01T00:00:00.000Z" });
  const recovered = queue.claimJob()!;
  assert.equal(recovered.id, job.id);
  assert.equal(recovered.attempt, 2);
  await processJob(recovered);
  const finished = queue.jobById(job.id)!;
  assert.equal(finished.status, "completed");
  assert.ok(finished.resultId);
  assert.equal(store.list<Design>("designs", project.id).length, 2);
  assert.equal(store.get("model_traces", job.id), null);
  // Calling the processor again on a completed job cannot duplicate publication.
  await processJob(recovered);
  assert.equal(store.list<Design>("designs", project.id).length, 2);
});

test("a database failure rolls back design publication and preserves the previous usable revision", async () => {
  const { project, design } = fixture();
  const job = queue.enqueue(project, { kind: "plan", clientOperationId: randomUUID() });
  cacheProposal(job);
  const claimed = queue.claimJob()!;
  const before = store.list<Design>("designs", project.id).length;
  store.db.exec("CREATE TEMP TRIGGER fail_test_design BEFORE INSERT ON records WHEN NEW.collection='designs' BEGIN SELECT RAISE(ABORT,'unit-test injected publication failure'); END;");
  const errors = test.mock.method(console, "error", () => {});
  try {
    await processJob(claimed);
  } finally {
    store.db.exec("DROP TRIGGER IF EXISTS fail_test_design");
    errors.mock.restore();
  }
  const failed = queue.jobById(job.id)!;
  assert.equal(failed.status, "failed");
  assert.equal(failed.resultId, null);
  assert.equal(store.list<Design>("designs", project.id).length, before);
  assert.equal(fresh(project).currentDesignId, design.id);
  assert.ok(store.get("job_outputs", job.id), "Known output must remain available for deliberate recovery");
});

test("frozen hashes preserve ordered actions but ignore JSON object key order", () => {
  assert.equal(store.hash({ a: 1, b: 2 }), store.hash({ b: 2, a: 1 }));
  assert.notEqual(store.hash({ actions: ["load", "close"] }), store.hash({ actions: ["close", "load"] }));
});


// Counted-kit service fixtures are isolated software tests, never physical evidence.
function kitFixture() {
 const project=services.createProject({title:'Isolated kit-count fixture',workflow:'electronics_kit',goal:'Count loose mechanical parts into labelled compartments',finishedDefinition:'Exact counts, separate closed cells, carton release and reset',demo:false},randomUUID());
 const snapshot=services.confirmFacts(project,{facts:kitFacts,confirmed:true});
 const designHash=store.hash({snapshot:snapshot.hash,proposal:kitProposal});
 const design=store.insert<Design>('designs',{id:store.id(),projectId:project.id,number:1,inputSnapshotId:snapshot.id,parentId:null,proposal:kitProposal,checks:checkDesign(kitFacts,kitProposal),hash:designHash,artifacts:compileDesign(kitFacts,kitProposal,designHash),status:'checks_passed',trace:{testFixture:true},source:'meta',createdAt:store.now()});
 const kitReadiness={...readiness,compartment_loading:true,compartment_closure:true,kit_release:true};
 const build=makeBuild(project,design,{readiness:kitReadiness});
 const evidence=makeAsset(project);
 const counts=Object.fromEntries(kitFacts.kitComponents.map(c=>[c.id,c.requiredCount]));
 return {project,design,snapshot,build,evidence,counts,kitReadiness};
}

test('kit completion requires individually reviewed counts; passing contents alone is insufficient',()=>{
 const f=kitFixture();
 const missing=makeTrial(f.project,f.build.id,{evidenceAssetId:f.evidence.id,componentCounts:{screws:null,washers:null,spacers:null,grommets:null}});
 assert.equal(missing.outcome,'incomplete');
 const complete=makeTrial(f.project,f.build.id,{evidenceAssetId:f.evidence.id,componentCounts:f.counts});
 assert.equal(complete.outcome,'observed_complete');
 assert.deepEqual(complete.requiredComponentCounts,f.counts);
});

test('observed kit-count mismatch overrides an asserted contents pass',()=>{
 const f=kitFixture();
 const mismatch=makeTrial(f.project,f.build.id,{evidenceAssetId:f.evidence.id,componentCounts:{...f.counts,screws:f.counts.screws+1}});
 assert.equal(mismatch.criteria.contents,'fail');
 assert.equal(mismatch.outcome,'failed');
});

test('kit physical completion requires retention, staged-closure and extraction readiness',()=>{
 const f=kitFixture();
 for(const key of ['compartment_loading','compartment_closure','kit_release']){
  const build=makeBuild(f.project,f.design,{readiness:{...f.kitReadiness,[key]:false}});
  assert.equal(makeTrial(f.project,build.id,{evidenceAssetId:f.evidence.id,componentCounts:f.counts}).outcome,'incomplete');
 }
});

test('a historic kit trial uses the built revision counts after the current inventory changes',()=>{
 const f=kitFixture();
 const newFacts=structuredClone(kitFacts);newFacts.kitComponents[0].requiredCount=Math.min(8,newFacts.kitComponents[0].requiredCount+1);
 services.confirmFacts(f.project,{facts:newFacts,confirmed:true});
 const trial=makeTrial(fresh(f.project),f.build.id,{evidenceAssetId:f.evidence.id,componentCounts:f.counts});
 assert.equal(trial.outcome,'observed_complete');
 assert.deepEqual(trial.requiredComponentCounts,f.counts);
});

test('unknown kit-count identities and cross-workflow snapshots are rejected',()=>{
 const f=kitFixture();
 expectHttp(()=>makeTrial(f.project,f.build.id,{evidenceAssetId:f.evidence.id,componentCounts:{...f.counts,unlisted_part:1}}),400);
 expectHttp(()=>services.confirmFacts(f.project,{facts:demoFacts,confirmed:true}),409);
});

test('answering measurement questions supersedes the waiting request and links a fresh job',()=>{
 const {project}=fixture();
 const waiting=queue.enqueue(project,{kind:'plan',clientOperationId:randomUUID()});
 queue.saveJob({...waiting,status:'waiting_for_user',stage:'Awaiting a measured fact'});
 const snapshot=services.confirmFacts(project,{facts:{...demoFacts,slotClearanceMm:0.7},confirmed:true});
 assert.equal(queue.jobById(waiting.id)!.status,'superseded');
 assert.equal(queue.jobById(waiting.id)!.inputSnapshotId,waiting.inputSnapshotId);
 const continuation=queue.enqueue(fresh(project),{kind:'plan',clientOperationId:randomUUID()});
 assert.equal(continuation.parentJobId,waiting.id);
 assert.equal(continuation.inputSnapshotId,snapshot.id);
 assert.notEqual(continuation.requestHash,waiting.requestHash);
});


test('critical workflow measurements must be complete before a confirmed snapshot is accepted',()=>{
 const p=services.createProject({title:'Missing-count fixture',workflow:'electronics_kit',goal:'Count mechanical parts into their labelled cells',finishedDefinition:'Exact count and complete reset'},randomUUID());
 expectHttp(()=>services.confirmFacts(p,{facts:{...kitFacts,kitComponents:[]},confirmed:true}),400);
 expectHttp(()=>services.confirmFacts(p,{facts:{...kitFacts,kitComponents:[kitFacts.kitComponents[0],kitFacts.kitComponents[0],kitFacts.kitComponents[2],kitFacts.kitComponents[3]]},confirmed:true}),400);
 const legacy=makeProject().project;
 expectHttp(()=>services.confirmFacts(legacy,{facts:{...demoFacts,itemHeightMm:null},confirmed:true}),400);
});


const jigReadiness={stock_loading:true,datum_registration:true,joint_access:true,support_transfer:true,finished_release:true,reset:true};
const jigCriteria={registration:'pass',alignment:'pass',completion:'pass',release:'pass',reset:'pass',allowed_resources:'pass'} as const;
function workshopFixture(demo=false){
 const project=services.createProject({title:'Isolated workshop-jig fixture',workflow:'workshop_jig',goal:'Brace loose precut enclosure panels while one hand joins the next panel',finishedDefinition:'All supplied panels joined, alignment inspected, gate parked, finished assembly removed and jig reset',demo},randomUUID());
 const snapshot=demo?store.get<Snapshot>('snapshots',project.currentSnapshotId!)!:services.confirmFacts(project,{facts:workshopFacts,confirmed:true});
 const designHash=store.hash({snapshot:snapshot.hash,proposal:workshopProposal});
 const design=demo?store.get<Design>('designs',project.currentDesignId!)!:store.insert<Design>('designs',{id:store.id(),projectId:project.id,number:1,inputSnapshotId:snapshot.id,parentId:null,proposal:workshopProposal,checks:checkDesign(workshopFacts,workshopProposal),hash:designHash,artifacts:compileDesign(workshopFacts,workshopProposal,designHash),status:'checks_passed',trace:{testFixture:true},source:'meta',createdAt:store.now()});
 const current=fresh(project);current.currentDesignId=design.id;store.replace('projects',current);
 const build=services.recordBuild(current,{designId:design.id,materialConfirmed:true,scaleConfirmed:true,partsConfirmed:true,deviations:'',makerAssistance:'Isolated software fixture; not physical evidence',readiness:jigReadiness});
 const evidence=makeAsset(current);
 return{project:current,snapshot,design,build,evidence};
}
function reviewedJig(f:ReturnType<typeof workshopFixture>,overrides:Record<string,unknown>={}){
 return services.recordTrial(fresh(f.project),{buildId:f.build.id,criteria:jigCriteria,completeness:'complete',undeclaredResources:false,feedback:'Isolated test data, not an actual physical assembly.',durationSeconds:30,reviewer:'Software fixture',evidenceAssetId:f.evidence.id,observedAlignmentErrorMm:0.5,...overrides});
}

test('workshop completion requires a measured alignment result in addition to reviewer passes',()=>{
 const f=workshopFixture();
 assert.equal(reviewedJig(f,{observedAlignmentErrorMm:null}).outcome,'incomplete');
 assert.equal(reviewedJig(f).outcome,'observed_complete');
});

test('alignment beyond the exact built tolerance overrides an asserted alignment pass',()=>{
 const f=workshopFixture();
 const trial=reviewedJig(f,{observedAlignmentErrorMm:workshopFacts.alignmentToleranceMm+0.1});
 assert.equal(trial.criteria.alignment,'fail');assert.equal(trial.outcome,'failed');
 assert.equal(trial.alignmentToleranceMm,workshopFacts.alignmentToleranceMm);
});

test('historical jig trials retain their original tolerance after current facts are edited',()=>{
 const f=workshopFixture();
 services.confirmFacts(f.project,{facts:{...workshopFacts,alignmentToleranceMm:workshopFacts.alignmentToleranceMm+2},confirmed:true});
 const trial=reviewedJig(f,{observedAlignmentErrorMm:workshopFacts.alignmentToleranceMm+1});
 assert.equal(trial.outcome,'failed');assert.equal(trial.alignmentToleranceMm,workshopFacts.alignmentToleranceMm);
});

test('all six jig readiness duties and separate trial video are required',()=>{
 const f=workshopFixture();
 for(const key of Object.keys(jigReadiness)){
  const build=services.recordBuild(f.project,{designId:f.design.id,materialConfirmed:true,scaleConfirmed:true,partsConfirmed:true,deviations:'',makerAssistance:'Test only',readiness:{...jigReadiness,[key]:false}});
  assert.equal(reviewedJig(f,{buildId:build.id}).outcome,'incomplete');
 }
 assert.equal(reviewedJig(f,{evidenceAssetId:null}).outcome,'incomplete');
});

test('synthetic jig demonstration never records physical success even when all boxes pass',()=>{
 const f=workshopFixture(true);assert.equal(reviewedJig(f).outcome,'incomplete');
});

test('packing criteria and part counts cannot substitute for workshop assembly evidence',()=>{
 const f=workshopFixture();expectHttp(()=>reviewedJig(f,{criteria}),400);
 expectHttp(()=>reviewedJig(f,{componentCounts:{screws:4}}),400);
 expectHttp(()=>services.recordBuild(f.project,{designId:f.design.id,materialConfirmed:true,scaleConfirmed:true,partsConfirmed:true,deviations:'',makerAssistance:'Test',readiness}),400);
});

test('the durable processor publishes a jig program and its bound construction artifacts atomically',async()=>{
 const f=workshopFixture();const job=queue.enqueue(f.project,{kind:'plan',clientOperationId:randomUUID()});
 store.insert('job_outputs',{id:job.id,projectId:f.project.id,result:{output:workshopProposal,trace:{testFixture:true}},createdAt:store.now()});
 const running=queue.claimJob()!;await processJob(running);
 const completed=queue.jobById(job.id)!;assert.equal(completed.status,'completed');
 const design=store.get<Design>('designs',completed.resultId!)!;
 assert.equal(design.proposal.program,null);assert.ok(design.proposal.jigProgram);
 assert.ok(design.artifacts?.packageSvg.includes(design.hash));assert.ok(design.artifacts?.stationSvg.includes(design.hash));
 assert.equal(fresh(f.project).currentDesignId,design.id);
 assert.equal(store.list('trials',f.project.id).length,0);
});

test('unknown workshop edge access cannot be confirmed as clear geometry',()=>{
 const project=services.createProject({title:'Incomplete joint-window fixture',workflow:'workshop_jig',goal:'Hold and align supplied panels during joining',finishedDefinition:'Complete assembly, release and reset'},randomUUID());
 const left=workshopFacts.jointZones.find(zone=>zone.edge==='left')!;
 expectHttp(()=>services.confirmFacts(project,{facts:{...workshopFacts,jointZones:[left,left,left,left]},confirmed:true}),400);
});

test('a replayed fact-confirmation operation returns its original snapshot without invalidating newer work',()=>{
 const project=services.createProject({title:'Confirmation receipt test',workflow:'workshop_jig',goal:'Support the supplied panels while joining the next one',finishedDefinition:'Complete assembled output and reset'},randomUUID());
 const operation=randomUUID();
 const body={facts:workshopFacts,confirmed:true,clientOperationId:operation};
 const first=services.confirmFacts(project,body);
 const later=services.confirmFacts(fresh(project),{facts:{...workshopFacts,alignmentToleranceMm:workshopFacts.alignmentToleranceMm+1},confirmed:true,clientOperationId:randomUUID()});
 const before=fresh(project);
 const replay=services.confirmFacts(fresh(project),body);
 assert.equal(replay.id,first.id);
 assert.equal(store.list('snapshots',project.id).length,2);
 assert.equal(fresh(project).currentSnapshotId,later.id);
 assert.equal(fresh(project).version,before.version);
 expectHttp(()=>services.confirmFacts(fresh(project),{...body,facts:{...workshopFacts,alignmentToleranceMm:3}}),409);
});

test('a lost build response can be replayed once, including after facts become stale',()=>{
 const f=workshopFixture();
 const before=store.list('builds',f.project.id).length;
 const body={designId:f.design.id,materialConfirmed:true,scaleConfirmed:true,partsConfirmed:true,deviations:'',makerAssistance:'Isolated receipt regression',readiness:jigReadiness,clientOperationId:randomUUID()};
 const first=services.recordBuild(f.project,body);
 assert.equal(services.recordBuild(f.project,body).id,first.id);
 services.confirmFacts(f.project,{facts:{...workshopFacts,alignmentToleranceMm:workshopFacts.alignmentToleranceMm+1},confirmed:true});
 assert.equal(services.recordBuild(fresh(f.project),body).id,first.id);
 assert.equal(store.list('builds',f.project.id).length,before+1);
 expectHttp(()=>services.recordBuild(fresh(f.project),{...body,deviations:'Different physical build'}),409);
});

test('one reviewed physical attempt cannot be duplicated by retrying an uncertain trial response',()=>{
 const f=workshopFixture();
 const body={buildId:f.build.id,criteria:jigCriteria,completeness:'complete',undeclaredResources:false,feedback:'Isolated idempotent-trial fixture',durationSeconds:30,reviewer:'Fixture reviewer',evidenceAssetId:f.evidence.id,observedAlignmentErrorMm:0.5,clientOperationId:randomUUID()};
 const first=services.recordTrial(f.project,body);
 assert.equal(services.recordTrial(f.project,body).id,first.id);
 assert.equal(store.list('trials',f.project.id).length,1);
 expectHttp(()=>services.recordTrial(f.project,{...body,observedAlignmentErrorMm:0.75}),409);
 assert.equal(store.list('trials',f.project.id).length,1);
});
