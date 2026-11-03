import { test, expect, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cameraWorkflow, cameraWorkflows, syntheticCameraFacts, syntheticCameraMeasurements } from '../src/camera/workflows';
import { acceptCameraPlanChange, answerCameraMeasurementRequest, applyCameraAssessment, bindCameraEntity, cancelCameraEvidenceRequest, confirmCameraPrerequisite, confirmCameraStep, createCameraSession, getCurrentReportedFailures, initializeCameraReasoning, openCameraEvidenceRequest, recordCameraReadingReport, recordCameraStepReview, refreshCameraGuidance, registerCameraEvidenceRequest, reviseCameraSession, undoLastCameraStep } from '../src/camera/engine';
import { CAMERA_ENGINE_VERSION, CAMERA_SCHEMA_VERSION, type CameraAssessment, type CameraAssessmentV2, type CameraDecisionKind, type CameraSession, type CameraTurn, type LegacyCameraAssessment, type StoredCameraAssessment } from '../src/camera/schema';
import { cancelExecutionBudget, createExecutionBudget, DEFAULT_CAMERA_EXECUTION_LIMITS, recordInvocationResponse, reserveInvocation } from '../src/meta/budget';
import type { PublicCameraIntake } from '../src/camera/intake-contract';

test.use({ baseURL: process.env.BROWSER_BASE_URL || 'http://127.0.0.1:3001', launchOptions: {
  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
  args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
} });

type Session = CameraSession & { id: string; activeTurnId: string | null; requiresReconfirmation?: boolean };
async function syntheticBench(page: Page, after: boolean, viewLabel = '') {
  const data = await page.evaluate(({corrected, viewLabel}) => {
    const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 640;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#f2f0e5'; context.fillRect(0, 0, 960, 640);
    context.fillStyle = '#263a31'; context.font = 'bold 22px Arial';
    context.fillText('ILLUSTRATIVE TEST SCENE · NOT A PHYSICAL TRIAL', 28, 42);
    context.font = '18px Arial'; context.fillText('Labelled branching harness · synthetic browser fixture', 28, 76);
    context.strokeStyle = '#cad2bc'; context.lineWidth = 1;
    for (let x = 30; x < 960; x += 40) { context.beginPath(); context.moveTo(x, 110); context.lineTo(x, 610); context.stroke(); }
    for (let y = 110; y < 640; y += 40) { context.beginPath(); context.moveTo(30, y); context.lineTo(930, y); context.stroke(); }
    const colors = ['#d76c49', '#5d8561', '#557f9b'];
    for (let index = 0; index < 3; index++) {
      const start = 200 + index * 150, end = corrected ? start : 500 - index * 150;
      context.strokeStyle = colors[index]; context.lineWidth = 14; context.lineCap = 'round';
      context.beginPath(); context.moveTo(145, start); context.bezierCurveTo(360, start, 620, end, 820, end); context.stroke();
      context.fillStyle = '#263a31'; context.font = 'bold 22px Arial'; context.fillText(String.fromCharCode(65 + index), 100, start + 8); context.fillText(`P${index + 1}`, 850, start + 8);
    }
    context.fillStyle = '#fffdf5'; context.fillRect(260, 535, 500, 56); context.fillStyle = '#5f7050'; context.font = '18px Arial';
    context.fillText(corrected ? 'AFTER VIEW · hypothetical corrected routing' : 'BEFORE VIEW · hypothetical crossed routing', 280, 570);
    if (viewLabel) { context.font = '16px Arial'; context.fillText(viewLabel, 28, 624); }
    return canvas.toDataURL('image/png').split(',')[1];
  }, {corrected:after,viewLabel});
  return { name: `synthetic-bench-${after ? 'after' : 'before'}.png`, mimeType: 'image/png', buffer: Buffer.from(data, 'base64') };
}

/** Offline UI fixture: real browser camera/file handling, deterministic engine, no provider. */
async function cameraFixture(page: Page, options: { native?: boolean; scene?: () => PublicCameraIntake | null; loseAdoptionResponse?: () => boolean } = {}) {
  let workflow = cameraWorkflows[0];
  let session: Session | null = null;
  let sequence = 0;
  let serverClockOffsetMs = 0;
  let nextGate: Promise<void> | null = null;
  let nextRead: { entered: () => void; wait: Promise<void>; sent: () => void; serverProcessingMs: number; serverNowOffsetMs: number } | null = null;
  let actionNeeded = false;
  let nextDecision: CameraDecisionKind | null = null;
  let nextComparison: 'supported_by_view'|'contradicted'|'unresolved'|null = null;
  let nextRecovery = false;
  let nextEntityHypothesis = false;
  let reopenPlan = false;
  let preserveStaleGuidance = false;
  let failNextAnswer = false;
  let breakNextFrame = false;
  let sessionReads = 0;
  let sessionCreates = 0;
  const brokenFrames = new Set<string>();
  const frames: { id: string; url: string; source: string; capturedAt: string | null; receivedAt: string; purpose: string; stepId: string; revision: number }[] = [];
  const turns: { id: string; frameId: string; operationId: string; status: string; assessment: StoredCameraAssessment | null; error: string | null; createdAt: string; completedAt: string | null; trace: { latencyMs: number; providerResponseId?: string } }[] = [];
  const images = new Map<string, Buffer>();
  const framePosts: { purpose: string; source: string; capturedAt: string | null; requestId?: string }[] = [];
  const patches: Record<string, unknown>[] = [];
  const clock = () => new Date(Date.now() + sequence + serverClockOffsetMs).toISOString();
  const initialize = (current: Session) => initializeCameraReasoning(current, workflow, {runId:current.id,factsHash:createHash('sha256').update(JSON.stringify(current.facts)).digest('hex')});
  const state = () => {
    const current = preserveStaleGuidance ? structuredClone(session!) : refreshCameraGuidance(session!, workflow, clock());
    return { session: { ...current, openRequest: openCameraEvidenceRequest(current) }, workflow, frames, turns, serverNow: clock(), serverProcessingMs: 0,
      ...(options.native ? { capabilities: { sceneIntake: true, progressivePrerequisites: true }, intake: options.scene?.() || null } : {}),
      meta: { configured: true, model: 'offline-browser-fixture' }, limits: { maxTurns: 20, maxFrameBytes: 307200 } };
  };
  await page.route('**/api/camera/sessions**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    try {
      if (pathname === '/api/camera/sessions') {
        if (request.method() === 'GET') { await route.fulfill({ json: { sessions: session ? [session] : [], workflows: cameraWorkflows, serverNow: clock(), ...(options.native ? { capabilities: { sceneIntake: true, progressivePrerequisites: true } } : {}), meta: { configured: true, model: 'offline-browser-fixture' } } }); return; }
        const body = request.postDataJSON(); workflow = cameraWorkflow(body.workflowId)!;
        sessionCreates++;
        session = initialize({ ...createCameraSession(workflow, body.facts, clock()), id: body.intakeId || '00000000-0000-4000-8000-000000000001', activeTurnId: null });
        if (body.intakeId) {
          const intake = options.scene?.(); expect(intake?.id).toBe(body.intakeId); expect(intake?.revision).toBe(body.intakeRevision);
          expect(body.facts).toEqual({});
          session = { ...session, setupContext: { intakeId: intake!.id, goal: intake!.goal, context: intake!.context }, executionBudget: structuredClone(intake!.executionBudget) };
          intake!.status = 'adopted'; intake!.adoptedSessionId = session.id;
          if (options.loseAdoptionResponse?.()) { await route.abort('failed'); return; }
        }
        await route.fulfill({ json: state() }); return;
      }
      if (!session) { await route.fulfill({ status: 404, json: { error: 'No fixture session' } }); return; }
      if (request.method() === 'GET' && pathname.includes('/frames/')) {
        if (brokenFrames.has(pathname.split('/').at(-1)!)) { await route.fulfill({ status: 409, json: { error: 'Saved snapshot integrity could not be confirmed.' } }); return; }
        await route.fulfill({ contentType: 'image/jpeg', body: images.get(pathname.split('/').at(-1)!) || Buffer.alloc(0) }); return;
      }
      if (request.method() === 'GET') {
        sessionReads++;
        const snapshot = structuredClone(state()), held = nextRead; nextRead = null;
        if (held) {
          snapshot.serverProcessingMs = held.serverProcessingMs;
          snapshot.serverNow = new Date(Date.parse(snapshot.serverNow) + held.serverNowOffsetMs).toISOString();
          held.entered(); await held.wait;
        }
        await route.fulfill({ json: snapshot }); held?.sent(); return;
      }
      if (pathname.endsWith('/frames')) {
        const form = await new Response(new Uint8Array(request.postDataBuffer()!), { headers: { 'Content-Type': request.headers()['content-type'] } }).formData();
        const purpose = form.get('purpose') as 'before' | 'after', source = form.get('source') as 'camera' | 'upload';
        const capturedAt = form.get('capturedAt') === 'null' ? null : String(form.get('capturedAt'));
        const file = form.get('file') as File;
        expect(file.type).toBe('image/jpeg'); expect(file.size).toBeLessThanOrEqual(300 * 1024);
        expect(Number(form.get('expectedRevision'))).toBe(session.revision);
        const requestId = typeof form.get('requestId') === 'string' ? String(form.get('requestId')) : undefined;
        const answering = openCameraEvidenceRequest(session);
        if (answering) {
          expect(answering.kind).toBe('request_view');
          expect(requestId).toBe(answering.id);
          expect(purpose).toBe(answering.sourcePurpose);
        } else expect(requestId).toBeUndefined();
        framePosts.push({ purpose, source, capturedAt, ...(requestId ? { requestId } : {}) });
        const gate = nextGate; nextGate = null;
        if (gate && answering) {
          const id = `held-frame-${framePosts.length}`, turnId = `held-turn-${framePosts.length}`, at = clock(), revision = session.revision;
          const sha256 = createHash('sha256').update(id).digest('hex');
          const held = { id:turnId,frameId:id,operationId:String(form.get('operationId')),status:'pending',assessment:null,error:null as string|null,createdAt:at,completedAt:null as string|null,trace:{latencyMs:0,providerResponseId:undefined as string|undefined} };
          frames.push({id,url:`/api/camera/sessions/${session.id}/frames/${id}`,source,capturedAt,receivedAt:at,purpose,stepId:session.currentStepId!,revision});
          images.set(id,Buffer.from(await file.arrayBuffer())); turns.push(held);
          session = {...session,activeTurnId:turnId,evidenceRequests:(session.evidenceRequests||[]).map(request=>request.id===answering.id ? {...request,answers:[...request.answers,{id:`answer:${turnId}`,requestId:request.id,kind:'view',frameId:id,frameSha256:sha256,turnId,operationId:held.operationId,status:'pending',createdAt:at,completedAt:null}]} : request)};
          await gate;
          if (session.revision !== revision || openCameraEvidenceRequest(session)?.id !== answering.id) {
            held.status='superseded'; held.completedAt=clock(); held.error='The cancelled answer returned late and remains historical.';
            held.trace={latencyMs:42,providerResponseId:'offline-late-response-retained'};
            await route.fulfill({json:{...state(),turn:held}}); return;
          }
          turns.splice(turns.indexOf(held),1); frames.splice(frames.findIndex(frame=>frame.id===id),1); images.delete(id);
          session={...session,activeTurnId:null,evidenceRequests:(session.evidenceRequests||[]).map(request=>request.id===answering.id ? {...request,answers:request.answers.filter(answer=>answer.id!==`answer:${turnId}`)} : request)};
        } else if (gate) await gate;
        sequence++;
        const at = clock(), id = `frame-${sequence}`, turnId = `turn-${sequence}`;
        const sourceSceneEpoch = session.sceneEpoch;
        const decisionKind = nextDecision || (purpose === 'before' || actionNeeded ? 'propose_action' : 'ready_for_operator_review');
        nextDecision = null;
        const requiredFactIds = workflow.steps.find(step => step.id === session!.currentStepId)!.requiredFactIds;
        const requestedFact = workflow.requiredFacts.find(fact => fact.kind === 'number' && requiredFactIds.includes(fact.id));
        const recovery = nextRecovery; nextRecovery=false;
        const comparisonStatus=nextComparison || (recovery || decisionKind==='propose_plan_change' || getCurrentReportedFailures(session,workflow).knownFailure ? 'contradicted' : 'supported_by_view');
        nextComparison=null;
        const identityHypothesis=nextEntityHypothesis;nextEntityHypothesis=false;
        const reopening=reopenPlan;reopenPlan=false;
        const instruction=recovery ? 'Expose the opposite side of the labelled branch without forcing it.' : 'Inspect the named reversible placement.';
        const model: CameraAssessment = {
          contractVersion: 'camera-decision-v3',
          summary: `Synthetic ${purpose} check ${sequence}; no physical success is claimed.`, frameQuality: 'clear',
          continuity: purpose === 'before' && !session.latestTurn && !session.completedSteps.length ? 'first_view' : 'same_scene',
          observations: [{ id: 'target', label: 'Labelled target', detail: 'Offline visible relationship for this browser journey.', box: { x: .2, y: .25, width: .3, height: .35 } }],
          suggestedStepId: session.currentStepId, decisionKind,
          viewRequest: decisionKind === 'request_view' ? { instruction: 'Show the hidden branch label from the opposite side.', whyNeeded: 'The label is not legible in this view.', resolves: 'Resolve which branch belongs to the declared destination.', targetObservationIds: ['target'] } : null,
          measurementRequest: decisionKind === 'request_measurement' ? { factKey: requestedFact!.id, unit: requestedFact!.unit, instruction: 'Read the required cable specification with its unit.', whyNeeded: 'The image cannot establish the required numeric bound.', resolves: 'Resolve the measured bound before another placement.', targetObservationIds: ['target'] } : null,
          actionProposal: decisionKind === 'propose_action' ? { kind: 'perform', instruction, preconditions: ['The actual target label matches the declared map.'], expectedVisibleResult: recovery ? 'The opposite label is visible without moving the declared destination.' : 'The marked target stays visible at the intended relationship.', stopCondition: 'Stop if the identity or support is lost.', targetObservationIds: ['target'] } : null,
          operatorReview: decisionKind === 'ready_for_operator_review' ? { instruction: 'Inspect the named reversible placement.', expectedVisibleResult: 'The marked target stays visible at the intended relationship.', stopCondition: 'Stop if the identity or support is lost.', targetObservationIds: ['target'] } : null,
          hold: decisionKind === 'hold' ? { reason: 'The current target identity remains contradictory.', resumeWhen: 'The operator has exposed a distinct physical label.' } : null,
          comparison: session.reasoning?.activePredictionId ? { predictionId:session.reasoning.activePredictionId, status:comparisonStatus, evidenceObservationIds:['target'],
            failedConditions:comparisonStatus==='contradicted' ? ['The expected access or reported limit remains unsatisfied.'] : [], unknownConditions:comparisonStatus==='unresolved' ? ['The opposite-side condition is hidden.'] : [] } : null,
          recovery:recovery ? {predictionId:session.reasoning!.activePredictionId!,changedHypothesis:'The visible route concealed the opposite-side label.',failedConditions:['The expected access or reported limit remains unsatisfied.'],correction:instruction,nextObservation:'Show both labels together from the opposite side.'} : null,
          entityHypotheses:identityHypothesis ? [{observationId:'target',candidateEntityIds:session.reasoning?.entities.filter(entity=>entity.version.sceneEpoch===session!.sceneEpoch).map(entity=>entity.id).slice(0,1)||[],detail:'This visible target may match a labelled part; an operator must establish identity.'}] : [], planChange:decisionKind === 'propose_plan_change' ? {parentPlanVersion:session.plan!.current.id,kind:reopening ? 'reopen_phase' : 'within_phase',reopenStepId:reopening ? workflow.steps[0].id : null,
            substeps:reopening ? [] : [{instruction:'Expose the blocked label before a reversible placement.',preconditions:['Keep the declared physical target in view.'],expectedVisibleResult:'The declared label and path are visible together.',stopCondition:'Stop if the label or permitted support is lost.'}],counterevidenceIds:[`comparison:${turnId}`],rationale:reopening ? 'The new evidence contradicts an earlier identity check, so that mandatory phase must be reviewed again.' : 'The blocked access requires a focused adaptation inside the current mandatory phase.'} : null,
        };
        const frame = { id, url: `/api/camera/sessions/${session.id}/frames/${id}`, source, capturedAt, receivedAt: at, purpose, stepId: session.currentStepId!, revision: session.revision };
        frames.push(frame); images.set(id, Buffer.from(await file.arrayBuffer()));
        if (breakNextFrame) { brokenFrames.add(id); breakNextFrame = false; }
        // The domain fixture uses distinct synthetic identities; image truth is tested elsewhere.
        const turn: CameraTurn = { ...frame, id: turnId, frameId: id, assessment: model, frameSha256: createHash('sha256').update(String(sequence)).digest('hex') };
        if (answering) session = { ...session, evidenceRequests: (session.evidenceRequests || []).map(request => request.id === answering.id ? {
          ...request, status: 'answered', closedAt: at, closeReason: 'The selected new view was accepted for a fresh assessment.', answers: [...request.answers, { id: `answer:${turnId}`, kind: 'view', requestId: request.id, operationId: String(form.get('operationId')), frameId: id, frameSha256: turn.frameSha256!, turnId, status: 'accepted', createdAt: at, completedAt: at }],
        } : request) };
        session = applyCameraAssessment(session, turn, workflow, at);
        session = registerCameraEvidenceRequest(session, { turn, sourceSceneEpoch, factsHash: createHash('sha256').update(JSON.stringify(session.facts)).digest('hex'),
          checksVersion: { schemaVersion: CAMERA_SCHEMA_VERSION, engineVersion: CAMERA_ENGINE_VERSION, workflowHash: createHash('sha256').update(JSON.stringify(workflow)).digest('hex') } }, at);
        turns.push({ id: turnId, frameId: id, operationId: String(form.get('operationId')), status: 'completed', assessment: model, error: null, createdAt: at, completedAt: at, trace: { latencyMs: 42 } });
        await route.fulfill({ json: { ...state(), turn: turns.at(-1) } }); return;
      }
      const body = request.postDataJSON(); patches.push(body);
      expect(body.expectedRevision).toBe(session.revision);
      if (body.action === 'prerequisite') {
        session = confirmCameraPrerequisite(session, body, workflow, clock());
      } else if (body.action === 'request_answer') {
        if (failNextAnswer) { failNextAnswer = false; await route.abort('failed'); return; }
        session = answerCameraMeasurementRequest(session, { requestId: body.requestId, value: body.value, unit: body.unit, operationId: body.clientOperationId }, workflow, clock());
      } else if (body.action === 'request_cancel') {
        session = {...cancelCameraEvidenceRequest(session, body.requestId, workflow, clock()),activeTurnId:null};
        for (const turn of turns) if (turn.status==='pending') {turn.status='superseded';turn.completedAt=clock();turn.error='The operator cancelled the request while its answer was pending.';}
      }
      else if (body.action === 'entity_bind') session=bindCameraEntity(session,{turnId:body.turnId,observationId:body.observationId,entityId:body.entityId||`entity:${body.clientOperationId}`,label:body.label,operatorConfirmed:body.operatorConfirmed},workflow,clock());
      else if (body.action === 'plan_accept') session=acceptCameraPlanChange(session,{proposalId:body.proposalId,clientOperationId:body.clientOperationId,operatorConfirmed:body.operatorConfirmed},workflow,clock());
      else if (body.action === 'reading_report') session=recordCameraReadingReport(session,{turnId:body.turnId,measurements:body.measurements,confirmations:body.confirmations,notes:body.notes,operationId:body.clientOperationId,operatorConfirmed:body.operatorConfirmed},workflow,clock());
      else if (body.action === 'confirm') session = confirmCameraStep(session, body, workflow, clock());
      else if (body.action === 'review') session = recordCameraStepReview(session, body, workflow, clock());
      else if (body.action === 'undo') session = undoLastCameraStep(session, workflow, clock());
      else if (body.action === 'facts') session = { ...reviseCameraSession(session, body.facts, workflow, clock()), activeTurnId: null, requiresReconfirmation: false };
      session = initialize(session);
      await route.fulfill({ json: state() });
    } catch (cause) {
      await route.fulfill({ status: typeof (cause as { status?: number }).status === 'number' ? (cause as { status: number }).status : 500, json: { error: (cause as Error).message } });
    }
  });
  return {
    get session() { return session!; }, get workflow() { return workflow; }, get sessionReads() { return sessionReads; }, get sessionCreates() { return sessionCreates; }, framePosts, patches, turns,
    keepActionNeeded() { actionNeeded = true; },
    chooseNextDecision(kind: CameraDecisionKind) { nextDecision = kind; },
    chooseNextComparison(status:'supported_by_view'|'contradicted'|'unresolved') {nextComparison=status;},
    proposeRecoveryNext() {nextDecision='propose_action';nextRecovery=true;},
    proposeEntityHypothesisNext() {nextEntityHypothesis=true;},
    reopenEarlierPhaseNext() {nextDecision='propose_plan_change';reopenPlan=true;},
    failNextRequestAnswer() { failNextAnswer = true; },
    resetNativeFacts() { session = initialize({ ...reviseCameraSession(session!, {}, workflow, clock()), activeTurnId: null }); },
    seedMixedDecision() {
      const turn = session!.latestTurn!;
      const mixed = { ...turn.assessment, decisionKind: 'request_view', viewRequest: { instruction: 'Invalid mixed-payload request.', whyNeeded: 'Offline corrupted-record regression.', resolves: 'No proposal may be displayed.', targetObservationIds: ['target'] } } as CameraAssessment;
      session = { ...session!, latestTurn: { ...turn, assessment: mixed }, guidance: { actionable: true, canConfirm: true, reasons: [] } };
      preserveStaleGuidance = true; // Exercise the client boundary independently of the engine's recheck.
    },
    seedV2History() {
      const {comparison:_comparison,recovery:_recovery,entityHypotheses:_entities,planChange:_change,...prior}=structuredClone(turns.at(-1)!.assessment as CameraAssessment);
      const legacy:CameraAssessmentV2={...prior,contractVersion:'camera-decision-v2',decisionKind:'propose_action',summary:'Historical v2 strict decision.',
        actionProposal:{...prior.actionProposal!,instruction:'Historical v2 instruction, not current guidance.'}};
      turns.push({id:'v2-historical-turn',frameId:'v2-historical-frame',operationId:'v2-history-operation',status:'completed',assessment:legacy,error:null,createdAt:clock(),completedAt:clock(),trace:{latencyMs:1}});
    },
    seedModelBudget(mode:'calls'|'response_capacity'|'deadline') {
      const at=Date.now()-(mode==='deadline'?61_000:0);
      let budget=createExecutionBudget(session!.id,{...DEFAULT_CAMERA_EXECUTION_LIMITS,maxInvocations:mode==='calls'?1:20,
        maxOutputTokens:mode==='response_capacity'?6000:120_000,maxDurationMs:mode==='deadline'?60_000:3_600_000},at);
      if(mode!=='deadline') {
        budget=reserveInvocation(budget,{invocationId:'offline-ui-inspection',parentInvocationId:null,role:'camera',route:'camera_reasoning',model:'muse-spark-1.3',
          contextHash:'a'.repeat(64),promptVersion:'offline-ui',schemaVersion:CAMERA_SCHEMA_VERSION,toolVersion:'offline-ui',maxOutputTokens:6000,inputBytes:10},at).state;
        budget=recordInvocationResponse(budget,'offline-ui-inspection','offline-ui-response',{input_tokens:1,output_tokens:1,total_tokens:2},at);
      }
      session={...session!,executionBudget:budget};
    },
    breakNextFrameImage() { breakNextFrame = true; },
    advanceServerClock(milliseconds: number) { serverClockOffsetMs += milliseconds; },
    holdNext() { let release!: () => void; nextGate = new Promise<void>(resolve => { release = resolve; }); return release; },
    holdNextRead(options: { serverProcessingMs?: number; serverNowOffsetMs?: number } = {}) {
      let release!: () => void, entered!: () => void, sent!: () => void;
      const wait = new Promise<void>(resolve => { release = resolve; });
      const entry = new Promise<void>(resolve => { entered = resolve; });
      const delivered = new Promise<void>(resolve => { sent = resolve; });
      nextRead = { entered, wait, sent, serverProcessingMs: options.serverProcessingMs || 0, serverNowOffsetMs: options.serverNowOffsetMs || 0 };
      return { release, entered: entry, delivered };
    },
    beginPendingCheck() { session = { ...session!, activeTurnId: 'offline-pending-check', latestTurn: null }; },
    seedLegacyCompleted(pending = false) {
      const legacy: LegacyCameraAssessment = { summary: 'Historical mixed-intent camera assessment.', frameQuality: 'clear', continuity: 'same_scene', observations: [],
        suggestedStepId: workflow.steps[0].id, stepStatus: 'needs_information', nextAction: { kind: 'perform', instruction: 'Historical instruction: move the marked fragment.', expectedVisibleResult: 'Historical predicted fit.', stopCondition: 'Historical stop condition.', targetObservationIds: [] }, questions: ['Historical question: which fragment was labelled A?'] };
      turns.push({ id: 'legacy-completed-turn', frameId: 'legacy-completed-frame', operationId: 'legacy-completed-operation', status: 'completed', assessment: legacy, error: null, createdAt: clock(), completedAt: clock(), trace: { latencyMs: 1 } });
      const facts = { ...session!.facts }; delete facts.maximum_outline_error_mm;
      session = { ...session!, revision: session!.revision + 1, facts, requiresReconfirmation: true,
        currentStepId: null, status: 'operator_reviewed_complete',
        completedSteps: workflow.steps.map(step => ({ stepId: step.id, beforeTurnId: `old-before-${step.id}`, afterTurnId: `old-after-${step.id}`,
          confirmations: {}, notes: 'Synthetic historical record under earlier checks.', confirmedAt: clock() })),
        reviews: [{ stepId: workflow.steps.at(-1)!.id, turnId: 'old-turn', beforeTurnId: 'old-before', afterTurnId: 'old-after',
          confirmations: {}, measurements: { original_outline_error_mm: .3 }, notes: 'Synthetic legacy review; original criteria metadata absent.',
          outcome: 'passed', reviewedAt: clock(), facts, sessionRevision: session!.revision, sceneEpoch: session!.sceneEpoch }],
      };
      if (pending) {
        session = { ...session, status: 'active', currentStepId: workflow.steps[1].id, completedSteps: session.completedSteps.slice(0, 1), activeTurnId: 'legacy-pending-turn' };
        turns.push({ id: 'legacy-pending-turn', frameId: 'legacy-pending-frame', operationId: 'legacy-operation', status: 'pending',
          assessment: null, error: null, createdAt: clock(), completedAt: null, trace: { latencyMs: 0 } });
      }
    },
  };
}

/** Deterministic scene-intake transport fixture; no actual model or physical claim. */
async function nativeSceneFixture(page: Page) {
  let intake: PublicCameraIntake | null = null;
  let responseKind: 'supported' | 'unsupported' | 'view' = 'supported';
  let loseNextResponse = false;
  let pendingNext = false;
  let loseAdoptionResponse = false;
  let rejectNextStatus: number | null = null;
  let sequence = 0;
  const images = new Map<string, Buffer>();
  const posts: { goal: string; context: string; source: string; capturedAt: string; operationId: string; intakeId: string | null; expectedRevision: number | null }[] = [];
  const operations = new Map<string, string>();
  const gets: string[] = [];
  const browserFixture = await cameraFixture(page, { native: true, scene: () => intake,
    loseAdoptionResponse() { const lose = loseAdoptionResponse; loseAdoptionResponse = false; return lose; } });
  const state = () => ({ intake, meta: { configured: true, model: 'offline-scene-fixture', configurationError: null }, serverNow: new Date().toISOString() });
  await page.route('**/api/camera/intakes**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() === 'GET') {
      gets.push(url.pathname + url.search);
      if (url.pathname.includes('/frames/')) {
        const bytes = images.get(url.pathname.split('/').at(-1)!);
        await route.fulfill(bytes ? { contentType: 'image/jpeg', headers: { 'Cache-Control': 'private, no-store' }, body: bytes } : { status: 404, json: { error: 'Unknown synthetic scene frame.' } }); return;
      }
      const operationId = url.searchParams.get('operationId');
      if (!intake || operationId && !operations.has(operationId)) { await route.fulfill({ status: 404, json: { error: 'No saved scene analysis found yet.' } }); return; }
      await route.fulfill({ json: state() }); return;
    }
    if (request.method() === 'PATCH') {
      const body = request.postDataJSON();
      expect(body).toEqual({ action: 'cancel', expectedRevision: intake!.revision });
      intake = { ...intake!, status: 'cancelled', revision: intake!.revision + 1, result: null, executionBudget: cancelExecutionBudget(intake!.executionBudget) };
      await route.fulfill({ json: state() }); return;
    }
    const form = await new Response(new Uint8Array(request.postDataBuffer()!), { headers: { 'Content-Type': request.headers()['content-type'] } }).formData();
    const file = form.get('file') as File, bytes = Buffer.from(await file.arrayBuffer());
    expect(file.type).toBe('image/jpeg'); expect(file.size).toBeLessThanOrEqual(300 * 1024);
    const previous = intake;
    const operationId = String(form.get('operationId'));
    posts.push({ goal: String(form.get('goal')), context: String(form.get('context')), source: String(form.get('source')), capturedAt: String(form.get('capturedAt')),
      operationId, intakeId: form.get('intakeId') as string | null, expectedRevision: form.has('expectedRevision') ? Number(form.get('expectedRevision')) : null });
    if (rejectNextStatus !== null) { const status = rejectNextStatus; rejectNextStatus = null; await route.fulfill({ status, json: { error: 'The saved scene revision changed before this analysis could start.' } }); return; }
    if (previous) { expect(form.get('intakeId')).toBe(previous.id); expect(Number(form.get('expectedRevision'))).toBe(previous.revision); }
    sequence++;
    const frameId = `scene-frame-${sequence}`, sha256 = createHash('sha256').update(bytes).digest('hex');
    images.set(frameId, bytes);
    let budget = previous?.executionBudget || createExecutionBudget('11111111-1111-4111-8111-111111111111', DEFAULT_CAMERA_EXECUTION_LIMITS);
    budget = reserveInvocation(budget, { invocationId: `scene-analysis-${sequence}`, parentInvocationId: null, role: 'scene_intake', route: 'camera_reasoning', model: 'muse-spark-1.3',
      contextHash: createHash('sha256').update(bytes).digest('hex'), promptVersion: 'offline-scene-prompt', schemaVersion: 'camera-intake-v1', toolVersion: 'none', maxOutputTokens: 2000, inputBytes: bytes.length }).state;
    const keepPending = pendingNext; pendingNext = false;
    if (!keepPending) budget = recordInvocationResponse(budget, `scene-analysis-${sequence}`, `offline-scene-response-${sequence}`, { input_tokens: 3, output_tokens: 2, total_tokens: 5 });
    const workflowId = responseKind === 'unsupported' ? null : 'harness_routing';
    intake = { id: '11111111-1111-4111-8111-111111111111', revision: sequence * 2, status: 'completed', goal: String(form.get('goal')), context: String(form.get('context')),
      frame: { id: frameId, url: `/api/camera/intakes/11111111-1111-4111-8111-111111111111/frames/${frameId}`, sha256,
        source: form.get('source') as 'camera' | 'upload', capturedAt: form.get('capturedAt') ? String(form.get('capturedAt')) : null, receivedAt: new Date().toISOString(), width: 960, height: 640 },
      result: { summary: 'Offline scene fixture: labelled sensor branches and destination map are visible. No physical result is established.', frameQuality: 'clear', workflowId,
        workflowReason: workflowId ? 'The shown labels and branches match the supported bench routing workflow.' : 'This scene does not establish a supported physical workflow.',
        workflowEvidenceObservationIds: ['labels'], observations: [{ id: 'labels', label: 'Visible branch labels', detail: 'Synthetic labels A, B and P1, P2 are readable in this browser fixture.', box: { x: .1, y: .2, width: .7, height: .5 } }], unknowns: ['The permitted handling and actual cable specification remain unknown.'],
        viewRequest: responseKind === 'view' ? { instruction: 'Expose the labels in one clear view.', whyNeeded: 'The current label map remains occluded.', targetObservationIds: ['labels'] } : null,
        factDrafts: workflowId ? [{ id: `draft-map-${sequence}`, factKey: 'target_port_map', value: 'A → P1; B → P2, via the labelled bench anchors.', evidenceObservationIds: ['labels'], frameId, frameSha256: sha256, workflowId },
          { id: `draft-labels-${sequence}`, factKey: 'branch_labels', value: 'Actual labels shown: A, B, P1, P2.', evidenceObservationIds: ['labels'], frameId, frameSha256: sha256, workflowId }] : [] }, error: null, adoptedSessionId: null, executionBudget: budget };
    operations.set(operationId, intake.id);
    if (keepPending) { intake.status = 'pending'; intake.result = null; }
    if (loseNextResponse) { loseNextResponse = false; await route.abort('failed'); return; }
    await route.fulfill({ json: state() });
  });
  return { browserFixture, posts, gets, get intake() { return intake!; },
    chooseNext(kind: typeof responseKind) { responseKind = kind; }, loseNextResponse() { loseNextResponse = true; }, pendingNext() { pendingNext = true; },
    loseNextAdoptionResponse() { loseAdoptionResponse = true; },
    rejectNext(status: number) { rejectNextStatus = status; },
    advanceRevision() { intake = { ...intake!, revision: intake!.revision + 1 }; },
    lateCancelledResponse() { intake!.executionBudget = recordInvocationResponse(intake!.executionBudget, `scene-analysis-${sequence}`, `offline-scene-response-${sequence}`, { total_tokens: 5 }); } };
}

async function startWorkflow(page: Page, id = cameraWorkflows[0].id, unknownFactIds: string[] = []) {
  const workflow = cameraWorkflow(id)!;
  await page.goto('/camera');
  await expect(page.getByRole('heading', { name: 'Show the setup.' })).toBeVisible();
  await page.getByText('Choose a different starting point', { exact: true }).click();
  await page.getByRole('button', { name: 'Choose workflow manually', exact: true }).click();
  await expect(page.getByLabel('Camera workflows').getByRole('button')).toHaveCount(5);
  await page.getByRole('button').filter({ hasText: workflow.title }).click();
  for (const fact of workflow.requiredFacts) {
    const field = page.getByLabel(fact.label, { exact: false });
    expect(await field.inputValue()).toBe('');
    if (unknownFactIds.includes(fact.id)) { expect(fact.kind).toBe('number'); continue; }
    if (fact.kind === 'boolean') await field.selectOption(String(syntheticCameraFacts[id][fact.id]));
    else await field.fill(String(syntheticCameraFacts[id][fact.id]));
  }
  await page.getByLabel('These are actual measured or operator-stated facts.', { exact: false }).check();
  await page.getByRole('button', { name: 'Start this workflow', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start camera', exact: true })).toBeVisible();
}

async function sceneGoal(page: Page, context = '') {
  await page.getByRole('textbox', { name: 'What would you like to do?', exact: true }).fill('Route these labelled prototype sensor branches to the shown destinations.');
  if (context) {
    await page.getByText('Add context (optional)', { exact: true }).click();
    await page.getByLabel('Constraints or context', { exact: true }).fill(context);
  }
}

async function understandNewView(page: Page) {
  const retake = page.getByRole('button', { name: 'Retake view', exact: true });
  if (await retake.isVisible()) await retake.click();
  await page.getByRole('button', { name: 'Understand a new view', exact: true }).click();
}

async function openSessionHistory(page: Page) {
  const summary = page.locator('summary').filter({ hasText: /^Session history$/ });
  if (!await summary.evaluate(node => (node.parentElement as HTMLDetailsElement).open)) await summary.click();
}

test('camera opens first and the selected scene supplies reviewable drafts before one-at-a-time prerequisites', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    (window as unknown as { sceneCameraStarts: number }).sceneCameraStarts = 0;
    navigator.mediaDevices.getUserMedia = async constraints => { (window as unknown as { sceneCameraStarts: number }).sceneCameraStarts++; return original(constraints); };
  });
  const fixture = await nativeSceneFixture(page);
  await page.goto('/camera');
  await expect(page.getByRole('heading', { name: 'Show the setup.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop camera', exact: true })).toBeVisible();
  await expect.poll(() => page.getByLabel('Local camera preview').evaluate(video => (video as HTMLVideoElement).videoWidth)).toBeGreaterThan(0);
  await expect(page.getByRole('region', { name: 'Confirm workflow facts' })).toHaveCount(0);
  await expect(page.getByLabel('Camera workflows')).toHaveCount(0);
  expect(await page.locator('textarea:visible, input[type="text"]:visible').count()).toBe(1);
  expect(fixture.posts).toHaveLength(0);
  await page.screenshot({ path: '/tmp/countershot-camera-first-mobile-entry.png' });
  await page.setViewportSize({ width: 1366, height: 940 });
  await page.screenshot({ path: '/tmp/countershot-camera-first-desktop-entry.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await sceneGoal(page, 'Use one hand and removable bench clips only.');
  expect(await page.locator('textarea:visible, input[type="text"]:visible').count()).toBe(2);
  expect(fixture.posts).toHaveLength(0);
  await page.getByRole('button', { name: 'Understand this view', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Scene analysis result' })).toContainText('labelled sensor branches');
  await expect(page.getByRole('button', { name: 'Use this workflow', exact: true })).toBeEnabled();
  await expect(page.getByAltText('Exact photo used to understand the scene')).toBeVisible();
  await expect(page.getByLabel('Local camera preview')).toBeHidden();
  expect(await page.getByLabel('Scene camera').locator('img:visible').count()).toBe(1);
  await page.screenshot({ path: '/tmp/countershot-minimal-camera-mobile-result.png' });
  expect(fixture.posts).toHaveLength(1);
  expect(fixture.posts[0]).toMatchObject({ source: 'camera', context: 'Use one hand and removable bench clips only.' });
  expect(fixture.posts[0].capturedAt).toMatch(/^\d{4}-/);
  await page.getByRole('button', { name: 'Use this workflow', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Next setup detail' })).toContainText('disconnected, unpowered bench harness');
  expect(fixture.browserFixture.session.facts).toEqual({});
  expect(fixture.browserFixture.session.executionBudget?.invocations).toHaveLength(1);
  expect(fixture.browserFixture.framePosts).toHaveLength(0);
  await expect(page.getByText('Your physical verification', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Inspect this setup', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as unknown as { sceneCameraStarts: number }).sceneCameraStarts)).toBe(1);
  expect(await page.getByLabel('Local camera preview').evaluate(video => !!(video as HTMLVideoElement).srcObject)).toBe(true);
  const detail = page.getByRole('region', { name: 'Next setup detail' });
  await detail.getByLabel('I confirm this is true for the actual setup.', { exact: true }).check();
  await detail.getByRole('button', { name: 'Confirm this scope', exact: true }).click();
  await expect(detail).toContainText('branch-to-port map');
  await expect(detail.getByRole('button', { name: 'Confirm this detail', exact: true })).toBeEnabled();
  await detail.getByRole('button', { name: 'Confirm this detail', exact: true }).click();
  await expect(detail).toContainText('Actual labels on the trunk');
  await detail.getByRole('button', { name: 'Confirm this detail', exact: true }).click();
  await expect(detail).toContainText('Available hands');
  await detail.getByRole('button', { name: 'Use the constraints I entered', exact: true }).click();
  await expect(detail).toHaveCount(0);
  await expect(page.getByText('Your physical verification', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Inspect this setup', exact: true })).toBeEnabled();
  expect(fixture.browserFixture.session.facts).toMatchObject({ scope_confirmed: true, target_port_map: fixture.intake.result!.factDrafts[0].value,
    branch_labels: fixture.intake.result!.factDrafts[1].value, operator_constraints: 'Use one hand and removable bench clips only.' });
  expect(fixture.browserFixture.session.facts.minimum_bend_radius_mm).toBeUndefined();
  expect(fixture.browserFixture.session.facts.retention_method).toBeUndefined();
  expect(fixture.browserFixture.patches.filter(patch => patch.action === 'prerequisite')).toHaveLength(4);
  expect(fixture.browserFixture.patches.filter(patch => patch.intakeDraftId)).toHaveLength(2);
  expect(fixture.posts).toHaveLength(1); expect(fixture.browserFixture.framePosts).toHaveLength(0);
  await page.getByRole('button', { name: 'Stop camera', exact: true }).click();
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window as unknown as { sceneCameraStarts: number }).sceneCameraStarts)).toBe(1);
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1366, height: 940 });
  await page.screenshot({ path: '/tmp/countershot-camera-first-desktop-session.png' });
});

test('denied camera permission keeps an explicit photo fallback without starting analysis automatically', async ({ page }) => {
  await page.addInitScript(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Offline denied camera fixture', 'NotAllowedError'); }; });
  const fixture = await nativeSceneFixture(page);
  await page.goto('/camera');
  await expect(page.getByRole('alert').filter({ hasText: 'Camera permission was not granted' })).toBeVisible();
  await sceneGoal(page);
  await page.getByLabel('Choose scene photo', { exact: true }).setInputFiles(await syntheticBench(page, false, 'First scene, uploaded explicitly'));
  expect(fixture.posts).toHaveLength(0);
  await page.getByRole('button', { name: 'Understand this view', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use this workflow', exact: true })).toBeEnabled();
  expect(fixture.posts).toHaveLength(1);
  expect(fixture.posts[0]).toMatchObject({ source: 'upload', capturedAt: '' });
});

test('switching back to the camera cancels a slow photo read without leaving scene controls locked', async ({ page }) => {
  await page.addInitScript(() => {
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = function () {
      const state = window as unknown as { holdPhotoDecode?: boolean; photoDecodeEntered?: boolean; releasePhotoDecode?: () => void };
      if (state.holdPhotoDecode && this.src.startsWith('blob:')) {
        state.photoDecodeEntered = true;
        return new Promise<void>((resolve, reject) => { state.releasePhotoDecode = () => { void decode.call(this).then(resolve, reject); }; });
      }
      return decode.call(this);
    };
  });
  const fixture = await nativeSceneFixture(page);
  await page.goto('/camera'); await sceneGoal(page);
  await page.getByLabel('Choose scene photo', { exact: true }).setInputFiles(await syntheticBench(page, false, 'First selected image'));
  await expect(page.getByRole('button', { name: 'Understand this view', exact: true })).toBeEnabled();
  await page.evaluate(() => { (window as unknown as { holdPhotoDecode: boolean }).holdPhotoDecode = true; });
  await page.getByLabel('Choose scene photo', { exact: true }).setInputFiles(await syntheticBench(page, true, 'Slow second selected image'));
  await expect.poll(() => page.evaluate(() => (window as unknown as { photoDecodeEntered: boolean }).photoDecodeEntered)).toBe(true);
  await page.getByRole('button', { name: 'Use camera instead', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop camera', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Understand this view', exact: true })).toBeEnabled();
  await page.evaluate(() => { (window as unknown as { releasePhotoDecode: () => void }).releasePhotoDecode(); });
  await expect(page.getByAltText('Selected scene photo, not yet sent for analysis')).toHaveCount(0);
  await expect(page.getByLabel('Choose scene photo', { exact: true })).toBeEnabled();
  expect(fixture.posts).toHaveLength(0);
  await page.getByRole('button', { name: 'Understand this view', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use this workflow', exact: true })).toBeEnabled();
  expect(fixture.posts).toHaveLength(1); expect(fixture.posts[0].source).toBe('camera');
});

test('unsupported scenes remain outside a workflow and retakes retain the same three-analysis allowance', async ({ page }) => {
  const fixture = await nativeSceneFixture(page); fixture.chooseNext('unsupported');
  await page.goto('/camera'); await sceneGoal(page);
  await expect(page.getByRole('button', { name: 'Understand this view', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Understand this view', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No supported workflow matches this scene.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use this workflow', exact: true })).toHaveCount(0);
  const originalId = fixture.intake.id;
  fixture.chooseNext('view');
  await understandNewView(page);
  await expect(page.getByText('Expose the labels in one clear view.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use this workflow', exact: true })).toBeDisabled();
  fixture.chooseNext('supported');
  await understandNewView(page);
  await expect(page.getByRole('button', { name: 'Use this workflow', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Retake view', exact: true })).toBeDisabled();
  expect(fixture.posts).toHaveLength(3);
  expect(fixture.posts.slice(1).every(post => post.intakeId === originalId && post.expectedRevision !== null)).toBe(true);
  expect(fixture.intake.executionBudget.invocations).toHaveLength(3);
  await page.getByRole('button', { name: 'Use this workflow', exact: true }).click();
  expect(fixture.browserFixture.session.executionBudget?.invocations).toHaveLength(3);
});

test('a lost scene response is recovered by GET without another paid scene request', async ({ page }) => {
  const fixture = await nativeSceneFixture(page); fixture.loseNextResponse();
  await page.goto('/camera'); await sceneGoal(page);
  await expect(page.getByRole('button', { name: 'Understand this view', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Understand this view', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'analysis result is uncertain' })).toBeVisible();
  expect(fixture.posts).toHaveLength(1);
  await page.getByRole('button', { name: 'Refresh saved analysis', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use this workflow', exact: true })).toBeEnabled();
  expect(fixture.posts).toHaveLength(1);
  expect(fixture.intake.executionBudget.invocations).toHaveLength(1);
});

test('a stale scene revision refreshes its known record without looking up an unregistered paid operation', async ({ page }) => {
  const fixture = await nativeSceneFixture(page);
  await page.goto('/camera'); await sceneGoal(page);
  await expect(page.getByRole('button', { name: 'Understand this view', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Understand this view', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use this workflow', exact: true })).toBeEnabled();
  fixture.advanceRevision(); fixture.rejectNext(409);
  await understandNewView(page);
  await expect(page.getByRole('status').filter({ hasText: 'scene changed in another request' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Understand a new view', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Refresh saved analysis', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use this workflow', exact: true })).toBeEnabled();
  expect(fixture.gets.at(-1)).toBe(`/api/camera/intakes/${fixture.intake.id}`);
  expect(fixture.gets.some(path => path.includes('operationId='))).toBe(false);
  expect(fixture.posts).toHaveLength(2); expect(fixture.intake.executionBudget.invocations).toHaveLength(1);
});

test('a saved adopted workflow can be continued after a lost adoption response without repeating analysis or creation', async ({ page }) => {
  const fixture = await nativeSceneFixture(page);
  await page.goto('/camera'); await sceneGoal(page);
  await expect(page.getByRole('button', { name: 'Understand this view', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Understand this view', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use this workflow', exact: true })).toBeEnabled();
  fixture.loseNextAdoptionResponse();
  await page.getByRole('button', { name: 'Use this workflow', exact: true }).click();
  await expect.poll(() => fixture.browserFixture.sessionCreates).toBe(1);
  await expect(page.getByRole('button', { name: 'Use this workflow', exact: true })).toBeEnabled();
  await page.route('**/api/camera/intakes/*/frames/*', route => route.fulfill({ status: 409, json: { error: 'Historical scene image integrity fixture.' } }));
  await page.reload();
  await expect(page.getByRole('button', { name: 'Continue saved workflow', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Continue saved workflow', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Next setup detail' })).toBeVisible();
  expect(fixture.browserFixture.sessionCreates).toBe(1);
  expect(fixture.posts).toHaveLength(1); expect(fixture.browserFixture.framePosts).toHaveLength(0);
  expect(fixture.browserFixture.session.executionBudget?.invocations).toHaveLength(1);
});

test('a reset keeps one-question setup while earlier-scene visual drafts remain unavailable', async ({ page }) => {
  const fixture = await nativeSceneFixture(page);
  await page.goto('/camera'); await sceneGoal(page);
  await expect(page.getByRole('button', { name: 'Understand this view', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Understand this view', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use this workflow', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Use this workflow', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Next setup detail' })).toBeVisible();
  fixture.browserFixture.resetNativeFacts();
  await page.getByRole('button', { name: 'Refresh session', exact: true }).click();
  expect(fixture.browserFixture.session.sceneEpoch).toBe(2);
  await expect(page.getByRole('group', { name: 'Saved scene context' })).toHaveCount(0);
  const detail = page.getByRole('region', { name: 'Next setup detail' });
  await detail.getByLabel('I confirm this is true for the actual setup.', { exact: true }).check();
  await detail.getByRole('button', { name: 'Confirm this scope', exact: true }).click();
  await expect(detail.getByRole('textbox', { name: 'Your confirmed detail', exact: true })).toBeVisible();
  await expect(detail.getByRole('button', { name: 'Confirm this detail', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Confirm workflow facts' })).toHaveCount(0);
  expect(fixture.posts).toHaveLength(1); expect(fixture.browserFixture.framePosts).toHaveLength(0);
});

test('returning from retake requires the saved photo to load again before adoption', async ({ page }) => {
  await page.addInitScript(() => {
    document.addEventListener('load', event => {
      const image = event.target;
      const state = window as unknown as { holdSavedLoad?: boolean; savedLoadBlocked?: boolean; releaseSavedLoad?: () => void };
      if (state.holdSavedLoad && image instanceof HTMLImageElement && image.alt === 'Exact photo used to understand the scene') {
        event.stopImmediatePropagation(); state.savedLoadBlocked = true;
        state.releaseSavedLoad = () => { state.holdSavedLoad = false; image.dispatchEvent(new Event('load')); };
      }
    }, true);
  });
  const fixture = await nativeSceneFixture(page);
  await page.goto('/camera'); await sceneGoal(page);
  await expect(page.getByRole('button', { name: 'Understand this view', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Understand this view', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use this workflow', exact: true })).toBeEnabled();
  await page.evaluate(() => { (window as unknown as { holdSavedLoad: boolean }).holdSavedLoad = true; });
  await page.getByRole('button', { name: 'Retake view', exact: true }).click();
  await expect(page.getByLabel('Local camera preview')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use this workflow', exact: true })).toBeDisabled();
  await page.getByText('Scene details', { exact: true }).click();
  await page.getByRole('button', { name: 'Refresh saved analysis', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { savedLoadBlocked: boolean }).savedLoadBlocked)).toBe(true);
  await expect(page.getByRole('button', { name: 'Use this workflow', exact: true })).toBeDisabled();
  await page.evaluate(() => { (window as unknown as { releaseSavedLoad: () => void }).releaseSavedLoad(); });
  await expect(page.getByAltText('Exact photo used to understand the scene')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use this workflow', exact: true })).toBeEnabled();
  expect(fixture.posts).toHaveLength(1); expect(fixture.browserFixture.framePosts).toHaveLength(0);
});

test('changed scene details and a newly analysed image must be checked before workflow adoption', async ({ page }) => {
  const fixture = await nativeSceneFixture(page);
  await page.goto('/camera'); await sceneGoal(page);
  await expect(page.getByRole('button', { name: 'Understand this view', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Understand this view', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use this workflow', exact: true })).toBeEnabled();
  const firstFrame = fixture.intake.frame!.id;
  await page.getByText('Goal & context', { exact: true }).click();
  await page.getByRole('textbox', { name: 'What would you like to do?', exact: true }).fill('Inspect the new labelled route in this changed scene.');
  await expect(page.getByRole('button', { name: 'Use this workflow', exact: true })).toBeDisabled();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), requested = new Promise<void>(resolve => { entered = resolve; });
  await page.route('**/api/camera/intakes/*/frames/*', async route => {
    if (new URL(route.request().url()).pathname.endsWith(firstFrame)) { await route.fallback(); return; }
    entered(); await held; await route.fallback();
  });
  try {
    await understandNewView(page);
    await requested;
    expect(fixture.intake.frame!.id).not.toBe(firstFrame);
    await expect(page.getByRole('button', { name: 'Use this workflow', exact: true })).toBeDisabled();
    release();
    await expect(page.getByRole('button', { name: 'Use this workflow', exact: true })).toBeEnabled();
    expect(fixture.posts).toHaveLength(2);
  } finally { release(); }
});

test('a pending saved scene can be cancelled and late paid usage cannot restore a workflow proposal', async ({ page }) => {
  const fixture = await nativeSceneFixture(page); fixture.pendingNext();
  await page.goto('/camera'); await sceneGoal(page);
  await expect(page.getByRole('button', { name: 'Understand this view', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Understand this view', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancel saved analysis', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Cancel saved analysis', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Analysis cancelled' })).toBeVisible();
  fixture.lateCancelledResponse();
  await page.getByText('Scene details', { exact: true }).click();
  await page.getByRole('button', { name: 'Refresh saved analysis', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use this workflow', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Understand a new view', exact: true })).toHaveCount(0);
  expect(fixture.posts).toHaveLength(1);
  expect(fixture.intake.executionBudget.invocations[0].responseId).toBe('offline-scene-response-1');
});

test('a locked camera workspace does not request device permission before access is granted', async ({ page }) => {
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    (window as unknown as { privateCameraStarts: number }).privateCameraStarts = 0;
    navigator.mediaDevices.getUserMedia = async constraints => { (window as unknown as { privateCameraStarts: number }).privateCameraStarts++; return original(constraints); };
  });
  const fixture = await nativeSceneFixture(page);
  let locked = true;
  await page.route('**/api/camera/sessions', async route => locked ? route.fulfill({ status: 401, json: { error: 'Offline workspace is locked.' } }) : route.fallback());
  await page.route('**/api/session', async route => { locked = false; await route.fulfill({ json: { ok: true } }); });
  await page.goto('/camera');
  await expect(page.getByRole('heading', { name: 'Open your camera workspace.' })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { privateCameraStarts: number }).privateCameraStarts)).toBe(0);
  await page.getByLabel('Workspace access code', { exact: true }).fill('offline-browser-access-fixture');
  await page.getByRole('button', { name: 'Open workspace', exact: false }).click();
  await expect(page.getByRole('button', { name: 'Stop camera', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { privateCameraStarts: number }).privateCameraStarts)).toBe(1);
  expect(fixture.posts).toHaveLength(0);
});

test('an older backend still opens local preview and offers manual setup without calling an unsupported intake endpoint', async ({ page }) => {
  const fixture = await cameraFixture(page);
  let unexpectedPosts = 0;
  await page.route('**/api/camera/intakes**', async route => { unexpectedPosts++; await route.fulfill({ status: 404, json: { error: 'Old backend fixture.' } }); });
  await page.goto('/camera');
  await expect(page.getByRole('button', { name: 'Stop camera', exact: true })).toBeVisible();
  await sceneGoal(page);
  await expect(page.getByRole('status').filter({ hasText: 'Scene understanding is being updated' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Understand this view', exact: true })).toBeDisabled();
  expect(unexpectedPosts).toBe(0); expect(fixture.framePosts).toHaveLength(0);
  await page.getByText('Choose a different starting point', { exact: true }).click();
  await page.getByRole('button', { name: 'Choose workflow manually', exact: true }).click();
  await expect(page.getByLabel('Camera workflows').getByRole('button')).toHaveCount(5);
});

test('phone checkpoint loop preserves unknown readings and records a failed measured attempt without advancing', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await cameraFixture(page);
  await startWorkflow(page);
  const beforeImage = await syntheticBench(page, false), afterImage = await syntheticBench(page, true);
  await page.getByRole('button', { name: 'Start camera', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Inspect this setup', exact: true })).toBeEnabled();
  await page.getByLabel('Upload camera checkpoint').setInputFiles(beforeImage);
  await expect(page.getByLabel('Checkpoint purpose')).toHaveValue('after');
  expect(fixture.framePosts[0]).toEqual({ purpose: 'before', source: 'upload', capturedAt: null });
  await expect(page.getByLabel('Current camera action').getByText('Look for:', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Current camera action').getByText('Stop or retake if:', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm reviewed step', exact: false })).toBeDisabled();
  await page.getByLabel('Upload camera checkpoint').setInputFiles(afterImage);
  await expect(page.getByLabel('Assessed frozen frame')).toBeVisible();
  await page.getByRole('button', { name: 'Stop camera', exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(page.getByLabel('Current camera action')).toBeInViewport();
  await page.screenshot({ path: '/tmp/countershot-camera-ui/mobile.png' });
  await page.setViewportSize({ width: 1366, height: 940 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: '/tmp/countershot-camera-ui/desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.getByLabel('Local camera preview').evaluate(video => video.parentElement!.querySelectorAll('svg[aria-label="Model observations on this saved frame"]').length)).toBe(0);
  for (const check of fixture.workflow.steps[0].requiredConfirmations) await page.getByLabel(check.label, { exact: true }).check();
  await page.getByLabel('What did you physically verify?').fill('Synthetic browser fixture: operator explicitly reviews the labelled setup, not a real physical success.');
  await page.getByRole('button', { name: 'Confirm reviewed step', exact: false }).click();
  await expect(page.getByRole('heading', { name: fixture.workflow.steps[1].title, exact: true })).toBeVisible();
  await page.getByLabel('Upload camera checkpoint').setInputFiles(beforeImage);
  await expect(page.getByLabel('Checkpoint purpose')).toHaveValue('after');
  await page.getByLabel('Upload camera checkpoint').setInputFiles(afterImage);
  await expect(page.getByLabel('What did you physically verify?')).toBeEnabled();
  const step = fixture.workflow.steps[1];
  for (const check of step.requiredConfirmations) await page.getByLabel(check.label, { exact: true }).check();
  const readings = syntheticCameraMeasurements(fixture.workflow.id, step.id);
  for (const definition of step.measurements || []) {
    const field = page.getByLabel(`${definition.label} (${definition.unit})`, { exact: false });
    await expect(field).toHaveValue('');
    await field.fill(String(readings[definition.id]));
  }
  const first = step.measurements![0];
  await page.getByLabel(`${first.label} (${first.unit})`, { exact: false }).fill(String(Number(fixture.session.facts[first.factId]) - 1));
  await page.getByLabel('What did you physically verify?').fill('Synthetic failed measurement: observed radius is below the confirmed cable requirement. No physical trial occurred.');
  await expect(page.getByRole('button', { name: 'Confirm reviewed step', exact: false })).toBeDisabled();
  await page.getByRole('button', { name: 'Record incomplete evidence', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Your failed review was saved' })).toBeVisible();
  await openSessionHistory(page);
  await expect(page.getByLabel('Physical review history').getByText('Failed attempt', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Physical review history')).toContainText('required at least 10 mm');
  expect(fixture.session.currentStepId).toBe(step.id);
  expect(fixture.session.completedSteps).toHaveLength(1);
  await expect(page.getByLabel('Checkpoint purpose')).toHaveValue('before');
  await expect(page.getByLabel(`${first.label} (${first.unit})`, { exact: false })).toHaveValue('');
  await expect(page.getByLabel('What did you physically verify?')).toHaveValue('');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('watching sends at most three after-checks, waits for responses and stops future paid checks explicitly', async ({ page, context }) => {
  await context.grantPermissions(['camera']);
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    (window as unknown as { cameraStops: number }).cameraStops = 0;
    navigator.mediaDevices.getUserMedia = async constraints => {
      (window as unknown as { cameraConstraints: unknown }).cameraConstraints = constraints;
      const stream = await original(constraints);
      for (const track of stream.getTracks()) { const stop = track.stop.bind(track); track.stop = () => { (window as unknown as { cameraStops: number }).cameraStops++; stop(); }; }
      return stream;
    };
  });
  const fixture = await cameraFixture(page); fixture.keepActionNeeded();
  await startWorkflow(page);
  await page.getByRole('button', { name: 'Start camera', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Inspect this setup', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Inspect this setup', exact: true }).click();
  await page.locator('summary').filter({ hasText: /^Watch options$/ }).click();
  await expect(page.getByRole('button', { name: 'Watch this step (3 checks)', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as unknown as { cameraConstraints: MediaStreamConstraints }).cameraConstraints.audio)).toBe(false);
  await page.clock.install();
  const release = fixture.holdNext();
  await page.getByRole('button', { name: 'Watch this step (3 checks)', exact: true }).click();
  await expect.poll(() => fixture.framePosts.length).toBe(2);
  await page.clock.runFor(60_000);
  expect(fixture.framePosts).toHaveLength(2);
  await page.getByRole('button', { name: 'Stop watching', exact: true }).click();
  release();
  await page.locator('summary').filter({ hasText: /^Watch options$/ }).click();
  await expect(page.getByRole('button', { name: 'Watch this step (3 checks)', exact: true })).toBeEnabled();
  await page.clock.runFor(16_000);
  expect(fixture.framePosts).toHaveLength(2);
  await page.getByRole('button', { name: 'Watch this step (3 checks)', exact: true }).click();
  await expect.poll(() => fixture.framePosts.length).toBe(3);
  await page.getByLabel('Camera guidance').getByText('Scene details', { exact: true }).click();
  await expect(page.getByText('Synthetic after check 3;', { exact: false }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop watching', exact: true })).toBeVisible();
  await page.clock.runFor(15_001);
  await expect.poll(() => fixture.framePosts.length).toBe(4);
  await expect(page.getByText('Synthetic after check 4;', { exact: false }).first()).toBeVisible();
  await page.clock.runFor(15_001);
  await expect.poll(() => fixture.framePosts.length).toBe(5);
  await expect(page.getByRole('status').filter({ hasText: 'Three-check budget used' })).toBeVisible();
  await page.clock.setSystemTime(new Date(Date.now() - 600_000));
  await expect(page.getByRole('button', { name: 'Read guidance aloud', exact: true })).toBeEnabled();
  await page.clock.runFor(121_000);
  await expect(page.getByRole('button', { name: 'Read guidance aloud', exact: true })).toBeDisabled();
  await page.clock.setSystemTime(new Date(Date.now() - 1_200_000));
  await page.clock.runFor(1000);
  await expect(page.getByRole('button', { name: 'Read guidance aloud', exact: true })).toBeDisabled();
  expect(fixture.framePosts).toHaveLength(5);
  expect(fixture.patches).toHaveLength(0);
  await page.getByRole('button', { name: 'Stop camera', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { cameraStops: number }).cameraStops)).toBeGreaterThan(0);
  expect(fixture.framePosts.slice(1).every(frame => frame.purpose === 'after' && frame.source === 'camera')).toBe(true);
});

test('a camera permission resolved after cancellation releases its tracks and sends no frame', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { lateStops: number }).lateStops = 0;
    navigator.mediaDevices.getUserMedia = () => new Promise(resolve => {
      (window as unknown as { resolveCamera: () => void }).resolveCamera = () => {
        const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
        const stream = canvas.captureStream(1);
        for (const track of stream.getTracks()) { const stop = track.stop.bind(track); track.stop = () => { (window as unknown as { lateStops: number }).lateStops++; stop(); }; }
        resolve(stream);
      };
    });
  });
  const fixture = await cameraFixture(page);
  await startWorkflow(page, 'gasket_seating');
  await page.getByRole('button', { name: 'Start camera', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel camera request', exact: true }).click();
  await page.evaluate(() => (window as unknown as { resolveCamera: () => void }).resolveCamera());
  await expect.poll(() => page.evaluate(() => (window as unknown as { lateStops: number }).lateStops)).toBe(1);
  expect(fixture.framePosts).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'Start camera', exact: true })).toBeEnabled();
});

test('delayed camera reads cannot restore an earlier revision or same-revision guidance after a newer result', async ({ page }) => {
  const fixture = await cameraFixture(page);
  await startWorkflow(page);
  const before = await syntheticBench(page, false), after = await syntheticBench(page, true);
  await page.getByLabel('Upload camera checkpoint').setInputFiles(before);
  await expect(page.getByLabel('Checkpoint purpose')).toHaveValue('after');
  const held = fixture.holdNextRead();
  try {
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await held.entered;
    await page.getByLabel('Upload camera checkpoint').setInputFiles(after);
    await expect(page.getByLabel('Camera guidance')).toContainText('Synthetic after check 2;');
    held.release(); await held.delivered;
    await page.waitForTimeout(100);
    await expect(page.getByLabel('Camera guidance')).toContainText('Synthetic after check 2;');
    await expect(page.getByLabel('Camera guidance')).not.toContainText('Synthetic before check 1;');
  } finally { held.release(); }

  const oldReady = fixture.holdNextRead();
  try {
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await oldReady.entered;
    fixture.beginPendingCheck();
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.getByRole('status').filter({ hasText: 'Checking your photo' })).toBeVisible();
    oldReady.release(); await oldReady.delivered;
    await page.waitForTimeout(100);
    await expect(page.getByRole('status').filter({ hasText: 'Checking your photo' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Read guidance aloud', exact: true })).toHaveCount(0);
  } finally { oldReady.release(); }
});

async function controlledVisibility(page: Page, visible: boolean) {
  await page.evaluate(value => {
    (window as unknown as { reviewVisibility: string }).reviewVisibility = value ? 'visible' : 'hidden';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (window as unknown as { reviewVisibility: string }).reviewVisibility });
    document.dispatchEvent(new Event('visibilitychange'));
  }, visible);
}

test('a delayed response cannot renew expired advice while genuine server processing is not counted twice', async ({ page, context }) => {
  const fixture = await cameraFixture(page);
  await startWorkflow(page);
  await page.getByLabel('Upload camera checkpoint').setInputFiles(await syntheticBench(page, false));
  await expect(page.getByRole('button', { name: 'Read guidance aloud', exact: true })).toBeEnabled();
  await page.clock.install();
  await controlledVisibility(page, false);
  const delayed = fixture.holdNextRead();
  try {
    await controlledVisibility(page, true);
    await delayed.entered;
    await page.clock.runFor(121_000);
    delayed.release(); await delayed.delivered;
    await expect(page.getByRole('button', { name: 'Read guidance aloud', exact: true })).toBeDisabled();
    await expect(page.getByLabel('Current camera action')).not.toContainText('Inspect the named reversible placement.');
  } finally { delayed.release(); }

  const processedPage = await context.newPage();
  try {
    const processedFixture = await cameraFixture(processedPage);
    await startWorkflow(processedPage);
    await processedPage.getByLabel('Upload camera checkpoint').setInputFiles(await syntheticBench(processedPage, false));
    await expect(processedPage.getByRole('button', { name: 'Read guidance aloud', exact: true })).toBeEnabled();
    await processedPage.clock.install();
    await controlledVisibility(processedPage, false);
    const processed = processedFixture.holdNextRead({ serverProcessingMs: 80_000, serverNowOffsetMs: 80_000 });
    try {
      await controlledVisibility(processedPage, true);
      await processed.entered;
      await processedPage.clock.runFor(80_000);
      processed.release(); await processed.delivered;
      await expect(processedPage.getByRole('button', { name: 'Read guidance aloud', exact: true })).toBeEnabled();
      await processedPage.clock.runFor(41_000);
      await expect(processedPage.getByRole('button', { name: 'Read guidance aloud', exact: true })).toBeDisabled();
    } finally { processed.release(); }
  } finally { await processedPage.close(); }
});

test('fragment review requires measured outline dimensions and retains the original tolerance after facts change', async ({ page }) => {
  const fixture = await cameraFixture(page);
  await startWorkflow(page, 'fragment_dry_fit');
  const before = await syntheticBench(page, false), after = await syntheticBench(page, true);
  for (let index = 0; index < 2; index++) {
    await page.getByLabel('Upload camera checkpoint').setInputFiles(before);
    await expect(page.getByLabel('Checkpoint purpose')).toHaveValue('after');
    await page.getByLabel('Upload camera checkpoint').setInputFiles(after);
    const step = fixture.workflow.steps[index];
    for (const check of step.requiredConfirmations) await page.getByLabel(check.label, { exact: true }).check();
    const measured = syntheticCameraMeasurements(fixture.workflow.id, step.id);
    for (const definition of step.measurements || []) await page.getByLabel(`${definition.label} (${definition.unit})`, { exact: false }).fill(String(measured[definition.id]));
    await page.getByLabel('What did you physically verify?').fill('Synthetic UI review only; no real fragment was manipulated.');
    await page.getByRole('button', { name: 'Confirm reviewed step', exact: false }).click();
    await expect(page.getByRole('heading', { name: fixture.workflow.steps[index + 1].title, exact: true })).toBeVisible();
  }
  await page.getByLabel('Upload camera checkpoint').setInputFiles(before);
  await expect(page.getByLabel('Checkpoint purpose')).toHaveValue('after');
  await page.getByLabel('Upload camera checkpoint').setInputFiles(after);
  const step = fixture.workflow.steps[2];
  for (const check of step.requiredConfirmations) await page.getByLabel(check.label, { exact: true }).check();
  await page.getByLabel('What did you physically verify?').fill('Synthetic failed outline measurement; no physical reconstruction claim.');
  const definitions = step.measurements!.filter(definition => definition.relation === 'within_tolerance');
  expect(definitions).toHaveLength(2);
  const width = definitions.find(definition => definition.factId === 'reference_width_mm')!;
  const height = definitions.find(definition => definition.factId === 'reference_height_mm')!;
  const target = Number(fixture.session.facts[width.factId]);
  const tolerance = Number(fixture.session.facts[width.toleranceFactId]);
  await expect(page.getByLabel(`${width.label} (${width.unit})`, { exact: false })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Confirm reviewed step', exact: false })).toBeDisabled();
  await page.getByLabel(`${height.label} (${height.unit})`, { exact: false }).fill(String(fixture.session.facts[height.factId]));
  await page.getByLabel(`${width.label} (${width.unit})`, { exact: false }).fill(String(target + tolerance + .1));
  await expect(page.getByRole('button', { name: 'Confirm reviewed step', exact: false })).toBeDisabled();
  await page.getByRole('button', { name: 'Record incomplete evidence', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Your failed review was saved' })).toBeVisible();
  await expect(page.getByLabel('Physical review history')).toContainText(`required target ${target} ± ${tolerance} mm`);
  await page.getByRole('button', { name: 'Review facts', exact: true }).click();
  const targetFact = fixture.workflow.requiredFacts.find(fact => fact.id === width.factId)!;
  const toleranceFact = fixture.workflow.requiredFacts.find(fact => fact.id === width.toleranceFactId)!;
  await page.getByLabel(targetFact.label, { exact: false }).fill(String(target + 10));
  await page.getByLabel(toleranceFact.label, { exact: false }).fill(String(tolerance / 2));
  await page.getByLabel('These are actual measured or operator-stated facts.', { exact: false }).check();
  await page.getByRole('button', { name: 'Save facts and restart view checks', exact: false }).click();
  await expect(page.getByLabel('Physical review history')).toContainText(`required target ${target} ± ${tolerance} mm`);
});

test('a legacy completed workflow stays historical until newly required facts are confirmed and checks restart', async ({ page }) => {
  const fixture = await cameraFixture(page);
  await startWorkflow(page, 'fragment_dry_fit');
  fixture.seedLegacyCompleted();
  const originalSceneEpoch = fixture.session.sceneEpoch;
  await page.getByRole('button', { name: 'Refresh session', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Historical operator review.', exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Historical checks · confirmation required.' })).toBeVisible();
  await expect(page.getByText('All required step reviews are recorded', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reopen previous step', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Inspect this setup', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Watch this step (3 checks)', exact: true })).toHaveCount(0);
  await openSessionHistory(page);
  const history = page.getByLabel('Physical review history');
  await expect(history).toContainText('Historical review · earlier checks');
  await history.locator('summary').click();
  await expect(history).toContainText('Original criterion definition not recorded.');
  await expect(history).toContainText('original outline error mm: 0.3');
  await expect(history).not.toContainText('required target');
  await openSessionHistory(page);
  await page.locator('summary').filter({ hasText: /^Checkpoint history/ }).click();
  await page.locator('summary').filter({ hasText: /^Historical mixed-intent camera assessment/ }).click();
  await expect(page.getByText('Historical assessment · earlier decision contract', { exact: true })).toBeVisible();
  await expect(page.getByText('Historical instruction: move the marked fragment.', { exact: true })).toBeVisible();
  await expect(page.getByText('Historical question: which fragment was labelled A?', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Read guidance aloud', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Review facts', exact: true }).click();
  const tolerance = fixture.workflow.requiredFacts.find(fact => fact.id === 'maximum_outline_error_mm')!;
  await expect(page.getByLabel(tolerance.label, { exact: false })).toHaveValue('');
  await page.getByLabel(tolerance.label, { exact: false }).fill(String(syntheticCameraFacts.fragment_dry_fit.maximum_outline_error_mm));
  await page.getByLabel('These are actual measured or operator-stated facts.', { exact: false }).check();
  await page.getByRole('button', { name: 'Save facts and restart view checks', exact: false }).click();
  await expect(page.getByRole('heading', { name: fixture.workflow.steps[0].title, exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Historical checks · confirmation required.' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Choose checkpoint photo', exact: true })).toBeEnabled();
  await expect(page.getByLabel('Physical review history')).toContainText('Historical review · earlier checks');
  expect(fixture.session.requiresReconfirmation).toBe(false);
  expect(fixture.session.sceneEpoch).toBe(originalSceneEpoch + 1);
});

test('missing assessed image pauses current advice, speech, watching and review while a new checkpoint can recover', async ({ page }) => {
  const fixture = await cameraFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await startWorkflow(page);
  await page.getByRole('button', { name: 'Start camera', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Inspect this setup', exact: true })).toBeEnabled();
  const before = await syntheticBench(page, false), after = await syntheticBench(page, true);
  await page.getByLabel('Upload camera checkpoint').setInputFiles(before);
  await expect(page.getByRole('button', { name: 'Read guidance aloud', exact: true })).toBeEnabled();
  await page.locator('summary').filter({ hasText: /^Watch options$/ }).click();
  await expect(page.getByRole('button', { name: 'Watch this step (3 checks)', exact: true })).toBeEnabled();
  fixture.breakNextFrameImage();
  await page.getByLabel('Upload camera checkpoint').setInputFiles(after);
  await expect(page.getByRole('alert').filter({ hasText: 'The assessed snapshot could not be displayed.' })).toBeVisible();
  await expect(page.getByLabel('Current camera action')).not.toContainText('Inspect the named reversible placement.');
  await expect(page.getByRole('button', { name: 'Read guidance aloud', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Watch this step (3 checks)', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Confirm reviewed step', exact: false })).toBeDisabled();
  await expect(page.getByLabel('What did you physically verify?')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Record incomplete evidence', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Check after action', exact: true })).toBeEnabled();
  await page.getByLabel('Upload camera checkpoint').setInputFiles(before);
  await expect(page.getByRole('alert').filter({ hasText: 'The assessed snapshot could not be displayed.' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Read guidance aloud', exact: true })).toBeEnabled();
  await expect(page.getByLabel('What did you physically verify?')).toBeEnabled();
  expect(fixture.framePosts).toHaveLength(3);
});

test('a new fast checkpoint refines a conservative clock overestimate after a delayed upstream request', async ({ page }) => {
  const fixture = await cameraFixture(page);
  await startWorkflow(page);
  await page.getByLabel('Upload camera checkpoint').setInputFiles(await syntheticBench(page, false));
  await expect(page.getByRole('button', { name: 'Read guidance aloud', exact: true })).toBeEnabled();
  await page.clock.install();
  await controlledVisibility(page, false);
  const held = fixture.holdNextRead({ serverNowOffsetMs: 121_000 });
  try {
    await controlledVisibility(page, true);
    await held.entered;
    await page.clock.runFor(121_000);
    fixture.advanceServerClock(121_000);
    held.release(); await held.delivered;
    await expect(page.getByRole('button', { name: 'Read guidance aloud', exact: true })).toBeDisabled();
    await page.getByLabel('Upload camera checkpoint').setInputFiles(await syntheticBench(page, true));
    await page.getByLabel('Camera guidance').getByText('Scene details', { exact: true }).click();
    await expect(page.getByText('Synthetic after check 2;', { exact: false }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Read guidance aloud', exact: true })).toBeEnabled();
  } finally { held.release(); }
});

test('an earlier pending check remains historical without locking facts reset or polling indefinitely', async ({ page }) => {
  const fixture = await cameraFixture(page);
  await startWorkflow(page, 'fragment_dry_fit');
  fixture.seedLegacyCompleted(true);
  await page.getByRole('button', { name: 'Refresh session', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Historical checks · confirmation required.' })).toBeVisible();
  await openSessionHistory(page);
  await page.locator('summary').filter({ hasText: /^Checkpoint history/ }).click();
  await expect(page.getByText('Analysis pending', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review facts', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Choose checkpoint photo', exact: true })).toBeDisabled();
  await page.locator('summary').filter({ hasText: /^Watch options$/ }).click();
  await expect(page.getByRole('button', { name: 'Watch this step (3 checks)', exact: true })).toBeDisabled();
  await page.clock.install();
  const reads = fixture.sessionReads;
  await page.clock.runFor(6000);
  expect(fixture.sessionReads).toBe(reads);
  await page.getByRole('button', { name: 'Review facts', exact: true }).click();
  const tolerance = fixture.workflow.requiredFacts.find(fact => fact.id === 'maximum_outline_error_mm')!;
  await expect(page.getByLabel(tolerance.label, { exact: false })).toHaveValue('');
  await page.getByLabel(tolerance.label, { exact: false }).fill(String(syntheticCameraFacts.fragment_dry_fit.maximum_outline_error_mm));
  await page.getByLabel('These are actual measured or operator-stated facts.', { exact: false }).check();
  await page.getByRole('button', { name: 'Save facts and restart view checks', exact: false }).click();
  await expect(page.getByRole('button', { name: 'Choose checkpoint photo', exact: true })).toBeEnabled();
  await openSessionHistory(page);
  await page.locator('summary').filter({ hasText: /^Checkpoint history/ }).click();
  await expect(page.getByText('Analysis pending', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Physical review history')).toContainText('Historical review · earlier checks');
  expect(fixture.session.activeTurnId).toBeNull();
});

for (const kind of ['request_view', 'request_measurement', 'hold'] as const) {
  test(`${kind} presents one request or hold and stops watching without authorizing a physical action`, async ({page}) => {
    await page.setViewportSize({width:390,height:844});
    await page.addInitScript(() => {
      (window as unknown as { spokenGuidance: string[] }).spokenGuidance = [];
      window.speechSynthesis.speak = utterance => { (window as unknown as { spokenGuidance: string[] }).spokenGuidance.push(utterance.text); };
    });
    const fixture = await cameraFixture(page);
    await startWorkflow(page);
    if (kind === 'request_measurement') {
      await page.getByLabel('Upload camera checkpoint').setInputFiles(await syntheticBench(page, false));
      await expect(page.getByLabel('Checkpoint purpose')).toHaveValue('after');
      await page.getByLabel('Upload camera checkpoint').setInputFiles(await syntheticBench(page, true));
      for (const check of fixture.workflow.steps[0].requiredConfirmations) await page.getByLabel(check.label, {exact:true}).check();
      await page.getByLabel('What did you physically verify?').fill('Offline transition to a phase with a declared numeric fact; no physical trial claimed.');
      await page.getByRole('button', {name:'Confirm reviewed step',exact:false}).click();
    }
    fixture.keepActionNeeded();
    await page.getByRole('button',{name:'Start camera',exact:true}).click();
    await page.getByRole('button',{name:'Inspect this setup',exact:true}).click();
    await page.locator('summary').filter({hasText:/^Watch options$/}).click();
    await expect(page.getByRole('button',{name:'Watch this step (3 checks)',exact:true})).toBeEnabled();
    const before = fixture.framePosts.length;
    fixture.chooseNextDecision(kind);
    await page.clock.install();
    await page.getByRole('button',{name:'Watch this step (3 checks)',exact:true}).click();
    await expect.poll(() => fixture.framePosts.length).toBe(before + 1);
    const instruction = kind === 'request_view' ? 'Show the hidden branch label from the opposite side.'
      : kind === 'request_measurement' ? 'Read the required cable specification with its unit.' : 'The current target identity remains contradictory.';
    await expect(page.getByLabel('Current camera action')).toContainText(instruction);
    await expect(page.getByLabel('Camera guidance')).toContainText(instruction);
    await expect(page.getByLabel('Camera guidance')).not.toContainText('Look for:');
    await expect(page.getByLabel('Current camera action')).not.toContainText('Inspect the named reversible placement.');
    await expect(page.getByRole('button',{name:'Stop watching',exact:true})).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Confirm reviewed step',exact:false})).toBeDisabled();
    await expect(page.getByRole('button',{name:'Read guidance aloud',exact:true})).toBeEnabled();
    await page.getByRole('button',{name:'Read guidance aloud',exact:true}).click();
    const spoken = await page.evaluate(() => (window as unknown as {spokenGuidance:string[]}).spokenGuidance);
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toContain(instruction);
    expect(spoken[0]).not.toContain('Inspect the named reversible placement.');
    await page.clock.runFor(16_000);
    expect(fixture.framePosts).toHaveLength(before + 1);
    expect(fixture.patches.filter(patch => patch.action === 'confirm')).toHaveLength(kind === 'request_measurement' ? 1 : 0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('a mixed saved decision cannot restore physical guidance even when stale server flags allow it', async ({page}) => {
  const fixture = await cameraFixture(page);
  await startWorkflow(page);
  await page.getByLabel('Upload camera checkpoint').setInputFiles(await syntheticBench(page, false));
  await expect(page.getByRole('button',{name:'Read guidance aloud',exact:true})).toBeEnabled();
  fixture.seedMixedDecision();
  await page.getByRole('button',{name:'Refresh session',exact:true}).click();
  await expect(page.getByLabel('Current camera action')).not.toContainText('Inspect the named reversible placement.');
  await expect(page.getByLabel('Current camera action')).not.toContainText('Invalid mixed-payload request.');
  await expect(page.getByRole('button',{name:'Read guidance aloud',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Confirm reviewed step',exact:false})).toBeDisabled();
  await expect(page.getByLabel('Camera guidance')).toContainText('It cannot authorize current guidance.');
});

async function reviewInitialHarnessPhase(page: Page, fixture: Awaited<ReturnType<typeof cameraFixture>>) {
  await page.getByLabel('Upload camera checkpoint').setInputFiles(await syntheticBench(page, false));
  await expect(page.getByLabel('Checkpoint purpose')).toHaveValue('after');
  await page.getByLabel('Upload camera checkpoint').setInputFiles(await syntheticBench(page, true));
  for (const check of fixture.workflow.steps[0].requiredConfirmations) await page.getByLabel(check.label, {exact:true}).check();
  await page.getByLabel('What did you physically verify?').fill('Offline fixture: reviewed the declared labels; this does not claim a physical trial.');
  await page.getByRole('button',{name:'Confirm reviewed step',exact:false}).click();
  await expect(page.getByRole('heading',{name:fixture.workflow.steps[1].title,exact:true})).toBeVisible();
}

test('a saved view request survives refresh and resumes only from an explicitly linked after-view', async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  const fixture = await cameraFixture(page);
  await startWorkflow(page);
  await page.getByLabel('Upload camera checkpoint').setInputFiles(await syntheticBench(page, false));
  await expect(page.getByLabel('Checkpoint purpose')).toHaveValue('after');
  const anchor = structuredClone(fixture.session.beforeTurn);
  fixture.chooseNextDecision('request_view');
  await page.getByLabel('Upload camera checkpoint').setInputFiles(await syntheticBench(page, true));
  const requestPanel = page.getByRole('region',{name:'Saved evidence request'});
  await expect(requestPanel).toContainText('Show the requested view.');
  const request = openCameraEvidenceRequest(fixture.session)!;
  expect(request.sourcePurpose).toBe('after');
  const epoch = fixture.session.sceneEpoch;
  const phase = fixture.session.currentStepId;
  await page.getByRole('button',{name:'Refresh session',exact:true}).click();
  await expect(requestPanel).toContainText('saved after-action request');
  await expect(page.getByLabel('Checkpoint purpose')).toHaveValue('after');
  await expect(page.getByLabel('Checkpoint purpose')).toBeDisabled();
  await expect(page.getByRole('button',{name:'Choose requested view',exact:true})).toBeEnabled();
  await page.waitForTimeout(100);
  expect(fixture.framePosts).toHaveLength(2);
  await page.getByLabel('Upload camera checkpoint').setInputFiles(await syntheticBench(page, true, 'Requested opposite-side view · offline illustration'));
  await expect(requestPanel).toHaveCount(0);
  expect(fixture.framePosts).toHaveLength(3);
  expect(fixture.framePosts[2].requestId).toBe(request.id);
  expect(fixture.framePosts[2].purpose).toBe('after');
  expect(fixture.session.sceneEpoch).toBe(epoch);
  expect(fixture.session.currentStepId).toBe(phase);
  expect(fixture.session.beforeTurn).toEqual(anchor);
  expect(fixture.session.evidenceRequests?.find(item=>item.id===request.id)?.status).toBe('answered');
  await openSessionHistory(page);
  await expect(page.getByRole('region',{name:'Evidence request history'})).toContainText('Answered · Requested view');
  await expect(page.getByRole('button',{name:'Confirm reviewed step',exact:false})).toBeDisabled();
  fixture.chooseNextDecision('request_view');
  await page.getByLabel('Upload camera checkpoint').setInputFiles(await syntheticBench(page, true, 'Another requested comparison · offline illustration'));
  await expect(requestPanel).toBeVisible();
  await requestPanel.getByRole('button',{name:'Cancel evidence request',exact:true}).click();
  await expect(requestPanel).toHaveCount(0);
  expect(fixture.framePosts).toHaveLength(4);
  expect(fixture.session.sceneEpoch).toBe(epoch);
  expect(fixture.session.currentStepId).toBe(phase);
  await openSessionHistory(page);
  await expect(page.getByRole('region',{name:'Evidence request history'})).toContainText('Cancelled request · Requested view');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('an unknown prerequisite is answered in its exact unit without resetting the scene or starting analysis', async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  const fixture = await cameraFixture(page);
  await startWorkflow(page,'harness_routing',['minimum_bend_radius_mm']);
  expect(fixture.session.facts.minimum_bend_radius_mm).toBeUndefined();
  await reviewInitialHarnessPhase(page,fixture);
  fixture.chooseNextDecision('request_measurement');
  await page.getByLabel('Upload camera checkpoint').setInputFiles(await syntheticBench(page,false,'Unknown specification request'));
  const requestPanel = page.getByRole('region',{name:'Saved evidence request'});
  await expect(requestPanel).toBeVisible();
  const request = openCameraEvidenceRequest(fixture.session)!;
  const scene = fixture.session.sceneEpoch, phase = fixture.session.currentStepId, completed = structuredClone(fixture.session.completedSteps);
  await expect(page.getByRole('button',{name:'Choose checkpoint photo',exact:true})).toBeDisabled();
  await expect(requestPanel).toContainText('prerequisite fact or specification');
  const input = requestPanel.getByLabel(/^Requested fact:/);
  await input.fill('10');
  const save = requestPanel.getByRole('button',{name:'Save requested fact',exact:true});
  await expect(save).toBeDisabled();
  await requestPanel.getByLabel('I checked this exact prerequisite fact and its stated unit.',{exact:true}).check();
  fixture.failNextRequestAnswer();
  await save.click();
  await expect(page.getByRole('status').filter({hasText:'Saved session refreshed. No analysis request was repeated.'})).toBeVisible();
  expect(fixture.patches.filter(patch=>patch.action==='request_answer')).toHaveLength(1);
  expect(fixture.framePosts).toHaveLength(3);
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByRole('status').filter({hasText:'Your confirmed fact was saved.'})).toBeVisible();
  const answers = fixture.patches.filter(patch=>patch.action==='request_answer');
  expect(answers).toHaveLength(2);
  expect(answers[0].clientOperationId).toBe(answers[1].clientOperationId);
  expect(answers[1]).toMatchObject({requestId:request.id,value:10,unit:'mm'});
  expect(fixture.framePosts).toHaveLength(3);
  expect(fixture.session.facts.minimum_bend_radius_mm).toBe(10);
  expect(fixture.session.sceneEpoch).toBe(scene);
  expect(fixture.session.currentStepId).toBe(phase);
  expect(fixture.session.completedSteps).toEqual(completed);
  expect(fixture.session.latestTurn).toBeNull();
  await expect(page.getByLabel('Smallest actual bend radius inspected (mm)',{exact:false})).toHaveValue('');
  await page.getByLabel('Upload camera checkpoint').setInputFiles(await syntheticBench(page,false,'Fresh assessment after explicit prerequisite answer'));
  await expect(page.getByRole('button',{name:'Read guidance aloud',exact:true})).toBeEnabled();
  expect(fixture.framePosts).toHaveLength(4);
  expect(fixture.framePosts[3].requestId).toBeUndefined();
  await openSessionHistory(page);
  await expect(page.getByRole('region',{name:'Evidence request history'})).toContainText('Answered · Requested prerequisite fact');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('changing a confirmed prerequisite requires an explicit facts reset and makes its old request stale', async ({page}) => {
  const fixture = await cameraFixture(page);
  await startWorkflow(page);
  await reviewInitialHarnessPhase(page,fixture);
  fixture.chooseNextDecision('request_measurement');
  await page.getByLabel('Upload camera checkpoint').setInputFiles(await syntheticBench(page,false,'Reconfirm the declared specification'));
  const requestPanel = page.getByRole('region',{name:'Saved evidence request'});
  await expect(requestPanel).toBeVisible();
  const original = fixture.session.facts.minimum_bend_radius_mm as number;
  const epoch = fixture.session.sceneEpoch;
  await requestPanel.getByLabel(/^Requested fact:/).fill(String(original+1));
  await expect(requestPanel.getByRole('button',{name:'Save requested fact',exact:true})).toBeDisabled();
  await expect(requestPanel.getByLabel('I checked this exact prerequisite fact and its stated unit.',{exact:true})).toBeDisabled();
  expect(fixture.patches.filter(patch=>patch.action==='request_answer')).toHaveLength(0);
  await requestPanel.getByRole('button',{name:'Review changed facts',exact:true}).click();
  await expect(page.getByLabel('Minimum bend radius from the actual cable specification (mm)',{exact:false})).toHaveValue(String(original+1));
  await expect(page.getByLabel('These are actual measured or operator-stated facts.',{exact:false})).not.toBeChecked();
  await page.getByLabel('These are actual measured or operator-stated facts.',{exact:false}).check();
  await page.getByRole('button',{name:'Save facts and restart view checks',exact:false}).click();
  await expect(requestPanel).toHaveCount(0);
  expect(fixture.session.facts.minimum_bend_radius_mm).toBe(original+1);
  expect(fixture.session.sceneEpoch).toBe(epoch+1);
  expect(fixture.session.currentStepId).toBe(fixture.workflow.steps[0].id);
  expect(fixture.framePosts).toHaveLength(3);
  await openSessionHistory(page);
  await expect(page.getByRole('region',{name:'Evidence request history'})).toContainText('Stale request · Requested prerequisite fact');
});

test('cancelling a pending view answer keeps its late response historical while a new checkpoint remains current', async ({page}) => {
  const fixture=await cameraFixture(page);
  await startWorkflow(page);
  await page.getByLabel('Upload camera checkpoint').setInputFiles(await syntheticBench(page,false));
  await expect(page.getByLabel('Checkpoint purpose')).toHaveValue('after');
  fixture.chooseNextDecision('request_view');
  await page.getByLabel('Upload camera checkpoint').setInputFiles(await syntheticBench(page,true,'Request the opposite-side view'));
  const requestPanel=page.getByRole('region',{name:'Saved evidence request'});
  await expect(requestPanel).toBeVisible();
  const request=openCameraEvidenceRequest(fixture.session)!;
  const release=fixture.holdNext();
  try {
    await page.getByLabel('Upload camera checkpoint').setInputFiles(await syntheticBench(page,true,'Pending answer view'));
    await expect.poll(()=>fixture.framePosts.length).toBe(3);
    const cancel=requestPanel.getByRole('button',{name:'Cancel evidence request',exact:true});
    await expect(cancel).toBeEnabled();
    await cancel.click();
    await expect(page.getByRole('status').filter({hasText:'The evidence request was cancelled.'})).toBeVisible();
    await expect(requestPanel).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Choose checkpoint photo',exact:true})).toBeEnabled();
    expect(fixture.session.evidenceRequests?.find(item=>item.id===request.id)?.status).toBe('cancelled');
    await page.getByLabel('Upload camera checkpoint').setInputFiles(await syntheticBench(page,true,'Explicit new checkpoint before the late return'));
    await expect(page.getByRole('button',{name:'Read guidance aloud',exact:true})).toBeEnabled();
    const current=fixture.session.latestTurn!.id;
    release();
    await expect.poll(()=>fixture.turns.find(turn=>turn.id==='held-turn-3')?.trace.providerResponseId).toBe('offline-late-response-retained');
    await page.getByRole('button',{name:'Refresh session',exact:true}).click();
    expect(fixture.session.latestTurn!.id).toBe(current);
    expect(fixture.framePosts).toHaveLength(4);
    expect(fixture.patches.filter(patch=>patch.action==='request_cancel')).toHaveLength(1);
    await openSessionHistory(page);
    await page.locator('summary').filter({hasText:/^Checkpoint history/}).click();
    await page.locator('summary').filter({hasText:'Historical check · facts or step changed'}).click();
    await expect(page.getByText('The cancelled answer returned late and remains historical.',{exact:true})).toBeVisible();
    await expect(page.getByRole('region',{name:'Saved evidence request'})).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Read guidance aloud',exact:true})).toBeEnabled();
  } finally {release();}
});

test('recovery shows the exact failed prediction and one changed action while retaining the earlier counterevidence', async ({page}) => {
  const fixture=await cameraFixture(page);
  await startWorkflow(page);
  await page.getByLabel('Upload camera checkpoint').setInputFiles(await syntheticBench(page,false));
  await expect(page.getByLabel('Checkpoint purpose')).toHaveValue('after');
  const original=structuredClone(fixture.session.reasoning!.predictions[0]);
  fixture.proposeRecoveryNext();
  await page.getByLabel('Upload camera checkpoint').setInputFiles(await syntheticBench(page,true,'Contradict the first predicted relationship'));
  const comparison=page.getByRole('region',{name:'Prediction comparison'});
  await expect(comparison).toContainText('Original prediction contradicted');
  await expect(comparison).toContainText(original.expectedVisibleResult);
  await expect(page.getByLabel('Current camera action')).toContainText('Expose the opposite side of the labelled branch without forcing it.');
  await expect(page.getByLabel('Current camera action')).not.toContainText(original.instruction);
  await page.getByLabel('Recovery rationale').locator('summary').click();
  await expect(page.getByLabel('Recovery rationale')).toContainText('The visible route concealed the opposite-side label.');
  await expect(page.getByLabel('Recovery rationale')).toContainText('Show both labels together from the opposite side.');
  expect(fixture.session.reasoning!.predictions[0]).toEqual(original);
  expect(fixture.session.reasoning!.recoveries).toHaveLength(1);
  const recoveryPrediction=fixture.session.reasoning!.predictions.at(-1)!;
  expect(recoveryPrediction.parentPredictionId).toBe(original.id);
  await page.getByLabel('Upload camera checkpoint').setInputFiles(await syntheticBench(page,true,'After the new explicit recovery action'));
  await expect(comparison).toContainText(recoveryPrediction.expectedVisibleResult);
  expect(fixture.session.reasoning!.comparisons.at(-1)!.predictionId).toBe(recoveryPrediction.id);
  expect(fixture.session.reasoning!.comparisons[0].status).toBe('contradicted');
  await expect(page.getByRole('button',{name:'Confirm reviewed step',exact:false})).toBeDisabled();
});

test('physical identity hypotheses stay unconfirmed until the operator binds and reuses a distinct label', async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  const fixture=await cameraFixture(page);
  await startWorkflow(page);
  fixture.proposeEntityHypothesisNext();
  await page.getByLabel('Upload camera checkpoint').setInputFiles(await syntheticBench(page,false));
  await expect(page.getByLabel('Checkpoint purpose')).toHaveValue('after');
  const identities=page.getByLabel('Physical identities');
  await identities.locator('summary').click();
  await expect(identities).toContainText('Unconfirmed visual match:');
  expect(fixture.session.reasoning!.entities).toHaveLength(0);
  const binding=page.getByRole('form',{name:'Confirm identity for Labelled target'});
  await binding.getByLabel('Actual physical label',{exact:true}).fill('Bench branch A');
  const save=binding.getByRole('button',{name:'Save physical identity',exact:true});
  await expect(save).toBeDisabled();
  await binding.getByLabel('I matched this observed part to the physical label.',{exact:true}).check();
  await save.click();
  await expect(page.getByRole('status').filter({hasText:'The physical label was saved'})).toBeVisible();
  expect(fixture.framePosts).toHaveLength(1);
  const entity=fixture.session.reasoning!.entities[0];
  expect(entity.label).toBe('Bench branch A');
  expect(fixture.patches.filter(patch=>patch.action==='entity_bind')[0]).toMatchObject({entityId:null,label:'Bench branch A',operatorConfirmed:true});
  expect(fixture.session.latestTurn).toBeNull();
  fixture.proposeEntityHypothesisNext();
  await page.getByLabel('Upload camera checkpoint').setInputFiles(await syntheticBench(page,true,'Reobserve the labelled physical part'));
  await expect(binding).toBeVisible();
  expect(fixture.session.reasoning!.entities).toHaveLength(1);
  expect(fixture.session.reasoning!.entityBindings).toHaveLength(1);
  await binding.getByRole('combobox',{name:'Match an existing physical label',exact:true}).selectOption(entity.id);
  await expect(binding.getByLabel('Actual physical label',{exact:true})).toHaveValue('Bench branch A');
  await binding.getByLabel('I matched this observed part to the physical label.',{exact:true}).check();
  await save.click();
  await expect(page.getByRole('status').filter({hasText:'The physical label was saved'})).toBeVisible();
  expect(fixture.session.reasoning!.entities).toHaveLength(1);
  expect(fixture.session.reasoning!.entityBindings).toHaveLength(2);
  expect(fixture.patches.filter(patch=>patch.action==='entity_bind')[1]).toMatchObject({entityId:entity.id,label:'Bench branch A',operatorConfirmed:true});
  expect(fixture.framePosts).toHaveLength(2);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('a checked phase adaptation needs explicit acceptance and a new view while mandatory checks remain', async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  const fixture=await cameraFixture(page);
  await startWorkflow(page);
  await page.getByLabel('Upload camera checkpoint').setInputFiles(await syntheticBench(page,false));
  await expect(page.getByLabel('Checkpoint purpose')).toHaveValue('after');
  const parent=fixture.session.plan!.current.id,phase=fixture.session.currentStepId,epoch=fixture.session.sceneEpoch;
  fixture.chooseNextDecision('propose_plan_change');
  await page.getByLabel('Upload camera checkpoint').setInputFiles(await syntheticBench(page,true,'Counterevidence supporting a phase adaptation'));
  const proposal=page.getByRole('region',{name:'Proposed plan change'});
  await expect(proposal).toBeVisible();
  await expect(proposal).toContainText('All mandatory workflow checks and confirmed measurement limits still apply.');
  const accept=proposal.getByRole('button',{name:'Accept plan change',exact:true});
  await expect(accept).toBeDisabled();
  const proposed=fixture.session.plan!.proposals.at(-1)!;
  expect(proposed.parentPlanVersion).toBe(parent);
  expect(proposed.counterevidenceIds).toEqual([`comparison:${fixture.session.latestTurn!.id}`]);
  await proposal.getByLabel('I accept this plan change and will capture a fresh view before acting.',{exact:true}).check();
  await accept.click();
  await expect(page.getByRole('status').filter({hasText:'Your plan change was saved.'})).toBeVisible();
  expect(fixture.patches.filter(patch=>patch.action==='plan_accept')[0]).toMatchObject({proposalId:proposed.id,operatorConfirmed:true});
  expect(fixture.framePosts).toHaveLength(2);
  expect(fixture.session.currentStepId).toBe(phase);
  expect(fixture.session.sceneEpoch).toBe(epoch);
  expect(fixture.session.plan!.current.id).not.toBe(parent);
  expect(fixture.session.latestTurn).toBeNull();
  expect(fixture.session.beforeTurn).toBeNull();
  expect(fixture.session.completedSteps).toHaveLength(0);
  const guidance=page.getByLabel('Current phase guidance');
  await guidance.locator('summary').click();
  await expect(guidance).toContainText('They have no automatic completion status');
  await expect(guidance.getByRole('checkbox')).toHaveCount(0);
  for (const check of fixture.workflow.steps[0].requiredConfirmations) await expect(page.getByLabel(check.label,{exact:true})).toHaveCount(1);
  await page.getByLabel('Upload camera checkpoint').setInputFiles(await syntheticBench(page,false,'Fresh setup after explicit phase adaptation'));
  await expect(page.getByRole('button',{name:'Read guidance aloud',exact:true})).toBeEnabled();
  expect(fixture.framePosts).toHaveLength(3);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('accepting an earlier-phase plan change reopens the affected mandatory checks without another inference', async ({page}) => {
  const fixture=await cameraFixture(page);
  await startWorkflow(page);
  await reviewInitialHarnessPhase(page,fixture);
  await page.getByLabel('Upload camera checkpoint').setInputFiles(await syntheticBench(page,false,'Current routing phase setup'));
  await expect(page.getByLabel('Checkpoint purpose')).toHaveValue('after');
  fixture.reopenEarlierPhaseNext();
  await page.getByLabel('Upload camera checkpoint').setInputFiles(await syntheticBench(page,true,'An earlier identity condition is contradicted'));
  const proposal=page.getByRole('region',{name:'Proposed plan change'});
  await expect(proposal).toContainText('Its later completed checks must be reviewed again.');
  await proposal.getByLabel('I accept this plan change and will capture a fresh view before acting.',{exact:true}).check();
  await proposal.getByRole('button',{name:'Accept plan change',exact:true}).click();
  await expect(page.getByRole('heading',{name:fixture.workflow.steps[0].title,exact:true})).toBeVisible();
  expect(fixture.session.completedSteps).toHaveLength(0);
  expect(fixture.framePosts).toHaveLength(4);
  expect(fixture.session.beforeTurn).toBeNull();
  expect(fixture.session.reasoning!.activePredictionId).toBeNull();
});

test('actual failed readings stay held until an explicit passing recheck and fresh comparison', async ({page}) => {
  const fixture=await cameraFixture(page);
  await startWorkflow(page);
  await reviewInitialHarnessPhase(page,fixture);
  await page.getByLabel('Upload camera checkpoint').setInputFiles(await syntheticBench(page,false,'Setup with actual routing limits'));
  await expect(page.getByLabel('Checkpoint purpose')).toHaveValue('after');
  const anchor=structuredClone(fixture.session.beforeTurn),phase=fixture.session.currentStepId;
  await page.getByLabel('Upload camera checkpoint').setInputFiles(await syntheticBench(page,true,'Inspect the actual radius and free service length'));
  const step=fixture.workflow.steps[1],passing=syntheticCameraMeasurements(fixture.workflow.id,step.id);
  for (const check of step.requiredConfirmations) await page.getByLabel(check.label,{exact:true}).check();
  for (const reading of step.measurements!) await page.getByLabel(`${reading.label} (${reading.unit})`,{exact:false}).fill(String(passing[reading.id]));
  const first=step.measurements![0];
  await page.getByLabel(`${first.label} (${first.unit})`,{exact:false}).fill(String((fixture.session.facts[first.factId] as number)-1));
  await page.getByLabel('What did you physically verify?').fill('Offline actual-reading fixture: the reported radius fails its confirmed limit.');
  const report=page.getByRole('button',{name:'Save actual recheck',exact:true});
  await expect(report).toBeDisabled();
  await page.getByLabel('I physically checked the readings and conditions recorded here.',{exact:true}).check();
  await report.click();
  await expect(page.getByRole('status').filter({hasText:'Your actual recheck was saved'})).toBeVisible();
  expect(fixture.framePosts).toHaveLength(4);
  expect(fixture.session.beforeTurn).toEqual(anchor);
  expect(fixture.session.currentStepId).toBe(phase);
  expect(fixture.session.readingReports![0].derivedKnownFailure).toBe(true);
  await page.getByLabel('Upload camera checkpoint').setInputFiles(await syntheticBench(page,true,'View alone cannot erase the known failed reading'));
  await expect(page.getByRole('region',{name:'Prediction comparison'})).toContainText('Original prediction contradicted');
  await expect(page.getByRole('button',{name:'Confirm reviewed step',exact:false})).toBeDisabled();
  for (const check of step.requiredConfirmations) await page.getByLabel(check.label,{exact:true}).check();
  for (const reading of step.measurements!) await page.getByLabel(`${reading.label} (${reading.unit})`,{exact:false}).fill(String(passing[reading.id]));
  await page.getByLabel('What did you physically verify?').fill('Offline fixture: the operator explicitly rechecked both actual readings within the unchanged limits.');
  await page.getByLabel('I physically checked the readings and conditions recorded here.',{exact:true}).check();
  await report.click();
  await expect(page.getByRole('status').filter({hasText:'Your actual recheck was saved'})).toBeVisible();
  expect(fixture.framePosts).toHaveLength(5);
  expect(fixture.session.completedSteps).toHaveLength(1);
  expect(fixture.session.currentStepId).toBe(phase);
  expect(fixture.session.readingReports).toHaveLength(2);
  expect(fixture.session.readingReports![0].derivedKnownFailure).toBe(true);
  expect(fixture.session.readingReports![1].derivedKnownFailure).toBe(false);
  await page.getByLabel('Upload camera checkpoint').setInputFiles(await syntheticBench(page,true,'Fresh after-view following the actual passing recheck'));
  await expect(page.getByRole('region',{name:'Prediction comparison'})).toContainText('Supported by this view');
  expect(fixture.session.guidance.canConfirm).toBe(true);
  await expect(page.getByRole('button',{name:'Confirm reviewed step',exact:false})).toBeDisabled();
  await openSessionHistory(page);
  await expect(page.getByRole('region',{name:'Actual recheck history'})).toContainText('Known failure recorded');
  await openSessionHistory(page);
  await expect(page.getByRole('region',{name:'Actual recheck history'})).toContainText('Actual recheck recorded');
  expect(fixture.framePosts).toHaveLength(6);
});

test('a saved v2 decision stays readable in history without becoming current v3 guidance', async ({page}) => {
  const fixture=await cameraFixture(page);
  await startWorkflow(page);
  await page.getByLabel('Upload camera checkpoint').setInputFiles(await syntheticBench(page,false));
  await expect(page.getByRole('button',{name:'Read guidance aloud',exact:true})).toBeEnabled();
  fixture.seedV2History();
  await page.getByRole('button',{name:'Refresh session',exact:true}).click();
  await openSessionHistory(page);
  await page.locator('summary').filter({hasText:/^Checkpoint history/}).click();
  await page.locator('summary').filter({hasText:'Historical v2 strict decision.'}).click();
  await expect(page.getByText('Historical assessment · earlier decision contract',{exact:true})).toBeVisible();
  await expect(page.getByText('Historical v2 instruction, not current guidance.',{exact:true})).toBeVisible();
  await expect(page.getByLabel('Current camera action')).not.toContainText('Historical v2 instruction');
  await expect(page.getByRole('button',{name:'Read guidance aloud',exact:true})).toHaveCount(1);
  expect(fixture.framePosts).toHaveLength(1);
});

for(const mode of ['calls','response_capacity','deadline'] as const) {
  test(`${mode} allowance stops new camera requests while facts reset preserves the shared budget`, async ({page}) => {
    const fixture=await cameraFixture(page);
    await startWorkflow(page);
    await page.getByRole('button',{name:'Start camera',exact:true}).click();
    await page.getByLabel('Upload camera checkpoint').setInputFiles(await syntheticBench(page,false));
    await expect(page.getByRole('button',{name:'Read guidance aloud',exact:true})).toBeEnabled();
    await page.locator('summary').filter({hasText:/^Watch options$/}).click();
    await expect(page.getByRole('button',{name:'Watch this step (3 checks)',exact:true})).toBeEnabled();
    fixture.seedModelBudget(mode);
    const original=structuredClone(fixture.session.executionBudget);
    await page.getByRole('button',{name:'Refresh session',exact:true}).click();
    await expect(page.getByRole('button',{name:'Choose checkpoint photo',exact:true})).toBeDisabled();
    await expect(page.getByRole('button',{name:'Check after action',exact:true})).toBeDisabled();
    await expect(page.getByRole('button',{name:'Watch this step (3 checks)',exact:true})).toBeDisabled();
    await expect(page.getByRole('status').filter({hasText:'This session has used its analysis allowance or reached its time limit.'})).toBeVisible();
    const allowance=page.getByLabel('Analysis allowance');
    await allowance.locator('summary').click();
    await expect(allowance).toContainText('at most two model requests');
    if(mode==='calls') await expect(page.getByText('0 model requests remain.',{exact:false})).toBeVisible();
    if(mode==='response_capacity') await expect(allowance).toContainText('Response capacity reserved: 100%');
    if(mode==='deadline') await expect(allowance).toContainText('Time remaining: 0 minutes.');
    await page.getByRole('button',{name:'Review facts',exact:true}).click();
    await page.getByLabel('These are actual measured or operator-stated facts.',{exact:false}).check();
    await page.getByRole('button',{name:'Save facts and restart view checks',exact:false}).click();
    await expect(page.getByRole('button',{name:'Choose checkpoint photo',exact:true})).toBeDisabled();
    expect(fixture.session.executionBudget).toEqual(original);
    expect(fixture.framePosts).toHaveLength(1);
  });
}
