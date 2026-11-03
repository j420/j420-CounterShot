"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { ArrowRight, Camera, Check, ChevronRight, CircleAlert, Clock3, ImagePlus, LoaderCircle, RefreshCw, RotateCcw, ScanLine, StopCircle, Volume2, X } from "lucide-react";
import { Mark } from "./shell";
import { useCameraFeed, type CameraCapture } from "./use-camera-feed";
import CameraSceneEntry from "./camera-scene-entry";
import CameraPrerequisite from "./camera-prerequisite";
import type { PublicCameraIntake } from "../src/camera/intake-contract";
import { cameraWorkflows, cameraWorkflow } from "../src/camera/workflows";
import { cameraMeasurementWithinBounds } from "../src/camera/engine";
import { assertExecutionCanContinue, remainingExecutionBudget } from "../src/meta/budget";
import { resolveModelBinding } from "../src/meta/capabilities";
import { CAMERA_ENGINE_VERSION, CAMERA_SCHEMA_VERSION, CameraAssessmentV2Schema, isCameraDecisionAssessment, LegacyCameraAssessmentSchema, type CameraAssessment, type CameraAssessmentV2, type CameraDecisionKind, type CameraFacts, type CameraSession, type StoredCameraAssessment, type WorkflowDefinition, type WorkflowMeasurementDefinition } from "../src/camera/schema";
import styles from "./camera-workbench.module.css";

type Session = CameraSession & { id: string; activeTurnId: string | null; requiresReconfirmation?: boolean };
type Frame = { id: string; url: string; source: "camera" | "upload"; capturedAt: string | null; receivedAt: string; purpose: "before" | "after"; stepId: string; revision: number };
type Turn = { id: string; frameId: string; operationId: string; status: "pending" | "completed" | "failed" | "superseded"; assessment: StoredCameraAssessment | null; trace?: { latencyMs?: number; model?: string } | null; error: string | null; createdAt: string; completedAt: string | null };
type CameraCapabilities = { sceneIntake?: boolean; progressivePrerequisites?: boolean };
type CameraState = { session: Session; workflow: WorkflowDefinition; turns: Turn[]; frames: Frame[]; intake?: PublicCameraIntake | null; capabilities?: CameraCapabilities; meta: { configured: boolean; model: string }; serverNow: string; serverProcessingMs?: number; turn?: Turn; limits?: { maxTurns: number; maxFrameBytes: number } };
type SessionList = { sessions: Session[]; serverNow: string; serverProcessingMs?: number; capabilities?: CameraCapabilities; meta: { configured: boolean; model: string } };
type FactInputs = Record<string, string>;
type WatchRun = { id: number; sessionId: string; stepId: string; sceneEpoch: number; beforeTurnId: string; checksStarted: number; timer: number | null };
type RequestTicket = { generation: number; sequence: number; startedMono: number; visibilityEpoch: number };

function factsInputs(facts: CameraFacts = {}): FactInputs { return Object.fromEntries(Object.entries(facts).map(([key, value]) => [key, String(value)])); }
function ageLabel(at: string, now: number) { const seconds = Math.max(0, Math.floor((now - Date.parse(at)) / 1000)); return Number.isFinite(seconds) ? seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ${seconds % 60}s ago` : "time unavailable"; }
function publicError(body: { error?: string; details?: unknown }, fallback: string) { return typeof body.error === "string" ? body.error : fallback; }
function measurementRequirement(definition: WorkflowMeasurementDefinition, facts: CameraFacts) {
  return definition.relation === "within_tolerance"
    ? `target ${String(facts[definition.factId])} ± ${String(facts[definition.toleranceFactId])} ${definition.unit}`
    : `${definition.relation === "gte" ? "at least" : "at most"} ${String(facts[definition.factId])} ${definition.unit}`;
}

type DecisionDisplay = { kind: CameraDecisionKind; label: string; instruction: string; expectedVisibleResult?: string; stopCondition?: string; whyNeeded?: string; resolves?: string; preconditions?: string[] };
/** Only the single locally validated payload can become current guidance or speech. */
function decisionDisplay(assessment: CameraAssessment | CameraAssessmentV2): DecisionDisplay | null {
  switch (assessment.decisionKind) {
    case "propose_action": return assessment.actionProposal ? { ...assessment.actionProposal, kind: assessment.decisionKind, label: "Proposed action" } : null;
    case "ready_for_operator_review": return assessment.operatorReview ? { ...assessment.operatorReview, kind: assessment.decisionKind, label: "Ready for your review" } : null;
    case "request_view": return assessment.viewRequest ? { ...assessment.viewRequest, kind: assessment.decisionKind, label: "Another view needed" } : null;
    case "request_measurement": return assessment.measurementRequest ? { ...assessment.measurementRequest, kind: assessment.decisionKind, label: "Measurement needed" } : null;
    case "hold": return assessment.hold ? { kind: assessment.decisionKind, label: "Paused", instruction: assessment.hold.reason, resolves: `Resume when: ${assessment.hold.resumeWhen}` } : null;
    case "propose_plan_change": return assessment.planChange ? { kind: assessment.decisionKind, label: "Plan change for your review", instruction: assessment.planChange.rationale,
      resolves: "Review this adaptation before accepting it. It does not authorize a physical action." } : null;
  }
}
function DecisionDetails({ decision }: { decision: DecisionDisplay }) {
  return <>{decision.expectedVisibleResult && <p><b>Look for:</b> {decision.expectedVisibleResult}</p>}{decision.stopCondition && <p><b>Stop or retake if:</b> {decision.stopCondition}</p>}{decision.whyNeeded && <p><b>Why:</b> {decision.whyNeeded}</p>}{decision.resolves && <p>{decision.resolves}</p>}{!!decision.preconditions?.length && <ul>{decision.preconditions.map(condition => <li key={condition}>{condition}</li>)}</ul>}</>;
}
function PhysicalMeasurements({ definitions, values, facts, progressive, index, disabled, onValue, onIndex }: {
  definitions: WorkflowMeasurementDefinition[]; values: Record<string, string>; facts: CameraFacts; progressive: boolean;
  index: number; disabled: boolean; onValue: (id: string, value: string) => void; onIndex: (index: number) => void;
}) {
  const visible = progressive ? definitions.slice(index, index + 1) : definitions;
  return <>{progressive && definitions.length > 0 && <div className={styles.readingsSummary}>{definitions.map((definition, itemIndex) => <div key={definition.id}><span>{definition.label}: {values[definition.id]?.trim() || "not recorded"} {values[definition.id]?.trim() ? definition.unit : ""}</span>{values[definition.id]?.trim() && itemIndex !== index && <button type="button" className={`${styles.button} ${styles.subtle}`} disabled={disabled} onClick={() => onIndex(itemIndex)}>Edit reading</button>}</div>)}</div>}
    {visible.map(measurement => <label className={styles.field} key={measurement.id}>{measurement.label} ({measurement.unit})<input type="number" min="0" step="any" value={values[measurement.id] || ""} disabled={disabled} onChange={event => onValue(measurement.id, event.target.value)}/><small>Confirmed limit: {measurementRequirement(measurement, facts)}. Leave unknown readings blank; the model does not supply them.</small></label>)}
    {progressive && visible.length > 0 && <button type="button" className={styles.button} disabled={disabled || !values[visible[0].id]?.trim() || !Number.isFinite(Number(values[visible[0].id])) || Number(values[visible[0].id]) < 0} onClick={() => onIndex(index + 1)}>Keep this reading <ArrowRight size={15}/></button>}
  </>;
}
function HistoricalAssessment({ assessment }: { assessment: StoredCameraAssessment }) {
  if (isCameraDecisionAssessment(assessment)) {
    const decision = decisionDisplay(assessment);
    return decision ? <><strong>{decision.label}</strong><p>{decision.instruction}</p><DecisionDetails decision={decision}/></> : null;
  }
  const v2 = CameraAssessmentV2Schema.safeParse(assessment);
  if (v2.success) { const decision = decisionDisplay(v2.data); return <><strong>Historical assessment · earlier decision contract</strong>{decision && <><p>{decision.instruction}</p><DecisionDetails decision={decision}/></>}<p>This saved decision cannot authorize a current action. Review facts and restart view checks.</p></>; }
  const legacy = LegacyCameraAssessmentSchema.safeParse(assessment);
  return legacy.success ? <><strong>Historical assessment · earlier decision contract</strong><p>{legacy.data.nextAction.instruction}</p>{!!legacy.data.questions.length && <ul>{legacy.data.questions.map(question => <li key={question}>{question}</li>)}</ul>}<p>This saved assessment cannot authorize a current action. Review facts and restart view checks.</p></> : <p>This saved assessment does not match the current decision contract and cannot authorize an action.</p>;
}


function CameraFlow() {
  return <section className={styles.expectations} aria-label="What happens after a photo">
    <ol className={styles.flowDiagram}>
      <li><span className={styles.flowIcon}><Camera size={18}/></span><div><strong>Show the setup</strong><p>Capture the view or choose a photo.</p></div><ArrowRight size={16} className={styles.flowArrow} aria-hidden="true"/></li>
      <li><span className={styles.flowIcon}><ScanLine size={18}/></span><div><strong>Understand the scene</strong><p>Review the proposed workflow and visible details.</p></div><ArrowRight size={16} className={styles.flowArrow} aria-hidden="true"/></li>
      <li><span className={styles.flowIcon}><Check size={18}/></span><div><strong>Guide and check</strong><p>Confirm the next detail, then compare before and after views.</p></div></li>
    </ol>
    <p className={styles.flowNote}>Meta analyses only the snapshot you select. Scene context comes first; physical suggestions need fresh checkpoints and your actual checks.</p>
  </section>;
}

export default function CameraWorkbench() {
  const camera = useCameraFeed();
  const [selectedWorkflowId, setSelectedWorkflowId] = useState(cameraWorkflows[0].id);
  const [inputs, setInputs] = useState<FactInputs>({});
  const [factsConfirmed, setFactsConfirmed] = useState(false);
  const [sessionList, setSessionList] = useState<Session[]>([]);
  const [state, setState] = useState<CameraState | null>(null);
  const [editingFacts, setEditingFacts] = useState(false);
  const [manualEntry, setManualEntry] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [accessRequired, setAccessRequired] = useState(false);
  const [accessChecked, setAccessChecked] = useState(false);
  const [accessCode, setAccessCode] = useState("");
  const [meta, setMeta] = useState<{ configured: boolean; model: string } | null>(null);
  const [capabilities, setCapabilities] = useState<CameraCapabilities>({});
  const [purpose, setPurpose] = useState<"before" | "after">("before");
  const [operatorNote, setOperatorNote] = useState("");
  const [confirmationNotes, setConfirmationNotes] = useState("");
  const [confirmations, setConfirmations] = useState<Record<string, boolean>>({});
  const [measurements, setMeasurements] = useState<Record<string, string>>({});
  const [measurementIndex, setMeasurementIndex] = useState(0);
  const [requestAnswerValue, setRequestAnswerValue] = useState("");
  const [requestAnswerConfirmed, setRequestAnswerConfirmed] = useState(false);
  const [requestMutationBusy, setRequestMutationBusy] = useState(false);
  const [identityInputs, setIdentityInputs] = useState<Record<string, { label: string; entityId: string; confirmed: boolean }>>({});
  const [planAccepted, setPlanAccepted] = useState(false);
  const [recheckConfirmed, setRecheckConfirmed] = useState(false);
  const [assessedImage, setAssessedImage] = useState<{ sessionId: string; frameId: string; status: "loaded" | "error" } | null>(null);
  const [sceneImageLoaded, setSceneImageLoaded] = useState<string | null>(null);
  const [, setClockTick] = useState(0);
  const [watchStatus, setWatchStatus] = useState({ active: false, checksStarted: 0 });
  const fileInput = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const operationSequence = useRef(0);
  const activeOperation = useRef<number | null>(null);
  const pendingViewAnswer = useRef<{ sessionId: string; requestId: string; operation: number | null } | null>(null);
  const polling = useRef(false);
  const mounted = useRef(true);
  const requestGeneration = useRef(0);
  const requestSequence = useRef(0);
  const lastAppliedSequence = useRef(0);
  const visibilityEpoch = useRef(0);
  const stateRef = useRef<CameraState | null>(null);
  const requestController = useRef<AbortController | null>(null);
  const requestOperationIds = useRef(new Map<string, string>());
  const watchRun = useRef<WatchRun | null>(null);
  const watchSequence = useRef(0);
  const watchTick = useRef<(id: number) => Promise<void>>(async () => {});
  const serverClock = useRef<{ serverMs: number; localMono: number } | null>(null);
  const workflow = state?.workflow || cameraWorkflow(selectedWorkflowId)!;
  const session = state?.session;
  const step = workflow.steps.find(item => item.id === session?.currentStepId);
  const latest = session?.latestTurn;
  const latestFrame = state?.frames.find(frame => frame.id === latest?.frameId);
  const lastRequest = state?.turns.at(-1);
  const assessment = latest?.assessment;
  const currentAssessment = isCameraDecisionAssessment(assessment) ? assessment : null;
  const decision = currentAssessment ? decisionDisplay(currentAssessment) : null;
  const assessedImageMatches = !!latestFrame && assessedImage?.sessionId === session?.id && assessedImage?.frameId === latestFrame.id;
  const assessedImageReady = assessedImageMatches && assessedImage?.status === "loaded";
  const assessedImageFailed = assessedImageMatches && assessedImage?.status === "error";
  const now = serverClock.current ? serverClock.current.serverMs + Math.max(0, performance.now() - serverClock.current.localMono) : NaN;
  const frameAge = latest ? now - Date.parse(latest.receivedAt) : NaN;
  const fresh = Number.isFinite(frameAge) && frameAge >= -1000 && frameAge <= 120_000;
  const requiresReconfirmation = session?.requiresReconfirmation === true;
  const openRequest = !requiresReconfirmation && session?.status === "active" && session.openRequest?.status === "open"
    && session.openRequest.sceneEpoch === session.sceneEpoch && session.openRequest.stepId === session.currentStepId
    && session.openRequest.stateRevision === session.revision && session.openRequest.checksVersion.schemaVersion === CAMERA_SCHEMA_VERSION
    && session.openRequest.checksVersion.engineVersion === CAMERA_ENGINE_VERSION ? session.openRequest : null;
  const requestedFact = openRequest?.measurement ? workflow.requiredFacts.find(fact => fact.id === openRequest.measurement?.factKey) : null;
  const answerNumber = requestAnswerValue.trim() ? Number(requestAnswerValue) : NaN;
  const confirmedRequestValue = requestedFact ? session?.facts[requestedFact.id] : undefined;
  const changesConfirmedFact = typeof confirmedRequestValue === "number" && Number.isFinite(answerNumber) && answerNumber !== confirmedRequestValue;
  const requestAnswerInRange = !!requestedFact && Number.isFinite(answerNumber) && (requestedFact.min === null || answerNumber >= requestedFact.min) && (requestedFact.max === null || answerNumber <= requestedFact.max);
  const awaitingFactAnswer = openRequest?.kind === "request_measurement";
  const waiting = !requiresReconfirmation && !!session?.activeTurnId;
  const complete = session?.status === "operator_reviewed_complete";
  const locked = busy || waiting || uncertain || requestMutationBusy;
  const sceneIntake = state?.intake && session && state.intake.id === session.id && state.intake.adoptedSessionId === session.id
    && state.intake.status === "adopted" && session.sceneEpoch === 1 && session.setupContext?.intakeId === session.id ? state.intake : null;
  const progressiveSetup = session?.setupContext?.intakeId === session?.id && !!session?.id
    && state?.capabilities?.progressivePrerequisites === true && !requiresReconfirmation;
  const requiredSetupFacts = progressiveSetup && session?.status === "active" && step
    ? step.requiredFactIds.map(id => workflow.requiredFacts.find(fact => fact.id === id)).filter((fact): fact is WorkflowDefinition['requiredFacts'][number] => !!fact) : [];
  const negativeScope = requiredSetupFacts.find(fact => fact.kind === "boolean" && session?.facts[fact.id] === false);
  const nextPrerequisite = !openRequest && !negativeScope ? requiredSetupFacts.find(fact => {
    const value = session?.facts[fact.id];
    return fact.kind === "number" ? typeof value !== "number" || !Number.isFinite(value)
      : fact.kind === "boolean" ? typeof value !== "boolean" : typeof value !== "string" || !value.trim();
  }) : null;
  const prerequisitesPending = !!nextPrerequisite || !!negativeScope;
  const prerequisiteDraft = nextPrerequisite?.kind === "text" && sceneIntake?.frame && sceneIntake.result?.workflowId === workflow.id
    ? sceneIntake.result.factDrafts.find(draft => draft.factKey === nextPrerequisite.id && draft.workflowId === workflow.id
      && draft.frameId === sceneIntake.frame!.id && draft.frameSha256 === sceneIntake.frame!.sha256) : undefined;
  const matchingPendingViewAnswer = openRequest?.kind === "request_view" && (pendingViewAnswer.current?.sessionId === session?.id && pendingViewAnswer.current?.requestId === openRequest.id
    || !!session?.activeTurnId && openRequest.answers.some(answer => answer.kind === "view" && answer.status === "pending" && answer.turnId === session.activeTurnId));
  const canCancelEvidenceRequest = !!openRequest && !requestMutationBusy && (!locked || matchingPendingViewAnswer);
  const watching = watchStatus.active;
  const checksRemaining = Math.max(0, (state?.limits?.maxTurns ?? 20) - (state?.turns.length ?? 0));
  const executionBudget = session?.executionBudget;
  let remainingModelAllowance: ReturnType<typeof remainingExecutionBudget> | null = null;
  let invalidModelAllowance = false;
  let stoppedModelAllowance = false;
  try { if (executionBudget) remainingModelAllowance = remainingExecutionBudget(executionBudget, Math.max(0,Math.floor(Number.isFinite(now) ? now : executionBudget.createdAt))); }
  catch { invalidModelAllowance = true; }
  try { if (executionBudget && remainingModelAllowance) assertExecutionCanContinue(executionBudget, Math.max(0,Math.floor(Number.isFinite(now) ? now : executionBudget.createdAt))); }
  catch { stoppedModelAllowance = true; }
  const modelRequestsRemaining = remainingModelAllowance?.invocations ?? checksRemaining;
  const modelAllowanceExhausted = !!executionBudget && (invalidModelAllowance || stoppedModelAllowance || !remainingModelAllowance || !Number.isFinite(now)
    || remainingModelAllowance.cancelled || remainingModelAllowance.timeMs <= 0 || remainingModelAllowance.invocations <= 0
    || remainingModelAllowance.outputTokens < resolveModelBinding("camera_reasoning").maxOutputTokens
    || remainingModelAllowance.knownTotalTokens <= 0 || remainingModelAllowance.inputBytes <= 0);
  const responseCapacityReserved = executionBudget && remainingModelAllowance ? Math.min(100,Math.ceil((executionBudget.limits.maxOutputTokens-remainingModelAllowance.outputTokens)/executionBudget.limits.maxOutputTokens*100)) : 0;
  const allConfirmations = !!step && step.requiredConfirmations.every(check => confirmations[check.id] === true);
  const requiredMeasurements = step?.measurements || [];
  const allMeasurements = requiredMeasurements.every(measurement => {
    const raw = measurements[measurement.id]?.trim();
    const value = raw ? Number(raw) : NaN;
    return cameraMeasurementWithinBounds(measurement, value, session?.facts || {});
  });
  const supportedCurrentPrediction = !!latest && currentAssessment?.comparison?.status === "supported_by_view"
    && currentAssessment.comparison.predictionId === session?.reasoning?.activePredictionId
    && session.reasoning.comparisons.some(item => item.evidence.turnId === latest.id && item.evidence.frameId === latest.frameId
      && item.predictionId === currentAssessment.comparison!.predictionId && item.status === "supported_by_view");
  const currentActionRecorded = !!latest && session?.reasoning?.activePredictionId === `prediction:${latest.id}`;
  const canConfirm = !prerequisitesPending && !openRequest && decision?.kind === "ready_for_operator_review" && supportedCurrentPrediction && assessedImageReady && !requiresReconfirmation && !!session?.guidance.canConfirm && fresh && allConfirmations && allMeasurements && !!confirmationNotes.trim() && !locked && !watching;
  const admittedAction = !prerequisitesPending && !openRequest && !!decision && (decision.kind === "propose_action" && currentActionRecorded || decision.kind === "ready_for_operator_review" && supportedCurrentPrediction) && assessedImageReady && !requiresReconfirmation && fresh && !!session && (session.guidance.actionable || session.guidance.canConfirm) && !locked;
  const readableAction = !!decision && assessedImageReady && !requiresReconfirmation && fresh && !locked && (admittedAction || ["request_view", "request_measurement", "hold", "propose_plan_change"].includes(decision.kind));
  const visibleDecision = readableAction ? decision : null;
  const knownEntities = (session?.reasoning?.entities || []).filter(entity => entity.version.runId === session?.id && entity.version.sceneEpoch === session?.sceneEpoch);
  const recordedComparison = currentAssessment?.comparison && latest ? session?.reasoning?.comparisons.find(item => item.predictionId === currentAssessment.comparison!.predictionId
    && item.evidence.turnId === latest.id && item.evidence.frameId === latest.frameId) : null;
  const comparedPrediction = recordedComparison ? session?.reasoning?.predictions.find(item => item.id === recordedComparison.predictionId) : null;
  const recordedRecovery = currentAssessment?.recovery && latest ? session?.reasoning?.recoveries.find(item => item.evidence.turnId === latest.id
    && item.predictionId === currentAssessment.recovery!.predictionId) : null;
  const planProposal = decision?.kind === "propose_plan_change" && latest ? session?.plan?.proposals.find(proposal => proposal.sourceTurnId === latest.id
    && proposal.status === "proposed" && proposal.parentPlanVersion === session.plan?.current.id && proposal.version.revision === session.revision
    && proposal.version.sceneEpoch === session.sceneEpoch && proposal.version.stepId === session.currentStepId) : null;
  const phaseGuidance = session?.currentStepId ? session.plan?.current.substepsByPhase[session.currentStepId] || [] : [];
  const counterevidence = (session?.reasoning?.claims || []).filter(claim => !claim.resolvedBy && ["contradicted", "unresolved", "reported"].includes(claim.status)
    && claim.version.sceneEpoch === session?.sceneEpoch && claim.version.stepId === session?.currentStepId).map(claim => {
      const comparison = session?.reasoning?.comparisons.find(item => item.evidence.turnId === claim.evidence.turnId);
      const report = session?.readingReports?.find(item => claim.id === `claim:${item.id}`);
      const review = session?.reviews?.find(item => claim.id === `claim:operator:${item.turnId}:${item.sessionRevision}`);
      const displayStatement = claim.source === "comparison" && comparison ? [...comparison.failedConditions,...comparison.unknownConditions].join(" ")
        : claim.source === "operator_report" ? report?.notes || review?.notes || "An unresolved physical report remains in your review history." : claim.statement;
      return { ...claim, displayStatement };
    });

  const stopWatching = useCallback((message?: string) => {
    const run = watchRun.current;
    if (!run) return;
    if (run.timer !== null) window.clearTimeout(run.timer);
    watchRun.current = null;
    if (mounted.current) { setWatchStatus({ active: false, checksStarted: run.checksStarted }); if (message) setNotice(message); }
  }, []);
  const stopCamera = useCallback(() => { stopWatching("Watching stopped. An in-flight check may still finish; no additional snapshot will be sent."); camera.stop(); }, [camera.stop, stopWatching]);
  const markAssessedImage = useCallback((sessionId: string, frameId: string, status: "loaded" | "error") => {
    const current = stateRef.current;
    if (current?.session.id !== sessionId || current.session.latestTurn?.frameId !== frameId) return;
    setAssessedImage({ sessionId, frameId, status });
  }, []);

  const beginRequest = useCallback((): RequestTicket => ({ generation: requestGeneration.current,
    sequence: ++requestSequence.current, startedMono: performance.now(), visibilityEpoch: visibilityEpoch.current }), []);
  const canApplyResponse = useCallback((ticket: RequestTicket, next?: CameraState) => {
    if (!mounted.current || ticket.generation !== requestGeneration.current || ticket.visibilityEpoch !== visibilityEpoch.current) return false;
    const current = stateRef.current;
    if (next && current) {
      if (next.session.id !== current.session.id || next.session.revision < current.session.revision) return false;
      // A genuinely newer server revision may arrive on an earlier read. Equal
      // revisions still need request ordering (pending state need not bump it).
      if (next.session.revision > current.session.revision) return true;
    }
    return ticket.sequence >= lastAppliedSequence.current;
  }, []);
  const calibrateClock = useCallback((serverNow: string, ticket: RequestTicket, serverProcessingMs?: number) => {
    const receivedMono = performance.now();
    const serverMs = Date.parse(serverNow);
    if (!Number.isFinite(serverMs) || document.visibilityState !== "visible") { serverClock.current = null; return; }
    // Server processing is already reflected in serverNow. Charge the remaining
    // round trip conservatively so a stalled response cannot restart freshness.
    const elapsed = Math.max(0, receivedMono - ticket.startedMono);
    const processing = typeof serverProcessingMs === "number" && Number.isFinite(serverProcessingMs) && serverProcessingMs >= 0
      ? Math.min(elapsed, serverProcessingMs) : 0;
    const sample = serverMs + elapsed - processing;
    const previous = serverClock.current ? serverClock.current.serverMs + Math.max(0, receivedMono - serverClock.current.localMono) : sample;
    // Both samples bound the current server time from above. Keep the tighter
    // bound so a later fast response can resolve earlier transport uncertainty.
    serverClock.current = { serverMs: Math.min(sample, previous), localMono: receivedMono };
  }, []);
  const applyState = useCallback((next: CameraState, ticket: RequestTicket) => {
    if (!canApplyResponse(ticket, next)) return null;
    lastAppliedSequence.current = Math.max(lastAppliedSequence.current, ticket.sequence);
    calibrateClock(next.serverNow, ticket, next.serverProcessingMs);
    stateRef.current = next;
    setState(next); setMeta(next.meta); setCapabilities(next.capabilities || {}); setSelectedWorkflowId(next.workflow.id); setUncertain(false); setAccessRequired(false); setAccessChecked(true);
    setSessionList(previous => [next.session, ...previous.filter(item => item.id !== next.session.id)]);
    return next;
  }, [calibrateClock, canApplyResponse]);

  const loadSession = useCallback(async (id: string) => {
    const ticket = beginRequest();
    const response = await fetch(`/api/camera/sessions/${encodeURIComponent(id)}`, { cache: "no-store" });
    const body = await response.json();
    if (!canApplyResponse(ticket, response.ok ? body : undefined)) return null;
    if (response.status === 401) { setAccessRequired(true); setAccessChecked(true); }
    if (!response.ok) throw new Error(publicError(body, "This camera session could not be opened."));
    return applyState(body, ticket);
  }, [applyState, beginRequest, canApplyResponse]);

  const loadIndex = useCallback(async () => {
    const ticket = beginRequest();
    const response = await fetch("/api/camera/sessions", { cache: "no-store" });
    const body = await response.json();
    if (!canApplyResponse(ticket)) return;
    if (response.status === 401) { setAccessRequired(true); setAccessChecked(true); return; }
    if (!response.ok) throw new Error(publicError(body, "Camera sessions could not be loaded."));
    if (!mounted.current) return;
    const list = body as SessionList;
    lastAppliedSequence.current = Math.max(lastAppliedSequence.current, ticket.sequence);
    calibrateClock(list.serverNow, ticket, list.serverProcessingMs);
    setSessionList(list.sessions); setMeta(list.meta); setCapabilities(list.capabilities || {}); setAccessRequired(false); setAccessChecked(true);
  }, [beginRequest, calibrateClock, canApplyResponse]);

  useEffect(() => {
    mounted.current = true;
    const generation = requestGeneration.current;
    void (async () => {
      try {
        await loadIndex();
        if (!mounted.current || generation !== requestGeneration.current) return;
        const requested = new URLSearchParams(window.location.search).get("session");
        if (requested && /^[a-zA-Z0-9-]{1,100}$/.test(requested)) await loadSession(requested);
      } catch (cause) { if (mounted.current) setError((cause as Error).message); }
      finally { if (mounted.current) setLoading(false); }
    })();
    return () => { mounted.current = false; stopWatching(); requestGeneration.current++; requestController.current?.abort(); window.speechSynthesis?.cancel(); };
  }, [loadIndex, loadSession, stopWatching]);

  useEffect(() => { const timer = window.setInterval(() => setClockTick(value => value + 1), 1000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    setConfirmations({}); setMeasurements({}); setMeasurementIndex(0); setConfirmationNotes(""); setOperatorNote("");
    setIdentityInputs({}); setRecheckConfirmed(false);
    setPurpose(session?.beforeTurn && session.beforeTurn.stepId === session.currentStepId ? "after" : "before");
    window.speechSynthesis?.cancel();
  }, [session?.revision, latest?.id, session?.currentStepId]);
  useEffect(() => { setPlanAccepted(false); }, [planProposal?.id]);
  useEffect(() => { if (!readableAction) window.speechSynthesis?.cancel(); }, [readableAction]);
  useEffect(() => { if (assessedImageFailed) stopWatching("Watching stopped because the assessed snapshot could not be displayed. Capture a new checkpoint or reload this page."); }, [assessedImageFailed, stopWatching]);
  useEffect(() => { if (complete || requiresReconfirmation) stopCamera(); }, [complete, requiresReconfirmation, stopCamera]);
  useEffect(() => { if (accessRequired) stopCamera(); }, [accessRequired, stopCamera]);
  useEffect(() => { if (modelAllowanceExhausted) stopWatching("Watching stopped because this session's analysis allowance is exhausted."); }, [modelAllowanceExhausted, stopWatching]);
  useEffect(() => {
    setRequestAnswerValue(""); setRequestAnswerConfirmed(false);
    if (openRequest) { stopWatching("Watching stopped while this saved evidence request awaits your answer."); setPurpose(openRequest.sourcePurpose); }
  }, [openRequest?.id, stopWatching]);
  useEffect(() => {
    const run = watchRun.current;
    if (run && (!camera.active || session?.id !== run.sessionId || session.currentStepId !== run.stepId || session.sceneEpoch !== run.sceneEpoch || session.status !== "active" || session.beforeTurn?.id !== run.beforeTurnId))
      stopWatching("Watching paused because the camera, setup or current step changed.");
  }, [camera.active, session?.id, session?.currentStepId, session?.sceneEpoch, session?.status, session?.beforeTurn?.id, stopWatching]);
  useEffect(() => {
    const changed = () => {
      if (document.visibilityState !== "visible") {
        visibilityEpoch.current++;
        serverClock.current = null; setClockTick(value => value + 1);
        stopWatching("Watching paused while the page is hidden. Restart it explicitly when ready."); camera.stop();
      } else if (session?.id) void loadSession(session.id).catch(cause => setError((cause as Error).message));
    };
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, [camera.stop, stopWatching, session?.id, loadSession]);
  useEffect(() => {
    if (requiresReconfirmation || !session?.activeTurnId) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible" || polling.current || inFlight.current) return;
      polling.current = true;
      void loadSession(session.id).catch(cause => setError((cause as Error).message)).finally(() => { polling.current = false; });
    }, 2000);
    return () => window.clearInterval(timer);
  }, [requiresReconfirmation, session?.id, session?.activeTurnId, loadSession]);

  function selectWorkflow(id: typeof selectedWorkflowId) {
    stopCamera(); requestGeneration.current++; window.speechSynthesis?.cancel();
    stateRef.current = null; serverClock.current = null; lastAppliedSequence.current = 0;
    setSelectedWorkflowId(id); setState(null); setInputs({}); setFactsConfirmed(false); setEditingFacts(false); setManualEntry(false); setUncertain(false); setError(""); setNotice("");
    window.history.replaceState({}, "", "/camera");
  }

  async function operate(path: string, body: unknown, method = "POST") {
    if (inFlight.current) return null;
    const operation = ++operationSequence.current;
    activeOperation.current = operation;
    inFlight.current = true; setBusy(true); setError(""); setNotice("");
    const ticket = beginRequest();
    const generation = ticket.generation;
    const controller = new AbortController(); requestController.current = controller;
    try {
      const response = await fetch(path, { method, signal: controller.signal, ...(body instanceof FormData ? { body } : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
      const output = await response.json();
      if (!response.ok) throw new Error(publicError(output, "The camera check could not be saved."));
      return applyState(output, ticket);
    } catch (cause) {
      if (!mounted.current || requestGeneration.current !== generation || activeOperation.current !== operation) return null;
      setError((cause as Error).message || "The check result could not be confirmed.");
      if (session) {
        setUncertain(true);
        try { await loadSession(session.id); setNotice("Saved session refreshed. No analysis request was repeated."); }
        catch { setNotice("The save result is uncertain. Refresh the session before requesting another check; the server may still be processing it."); }
      }
      return null;
    } finally {
      if (requestGeneration.current === generation && activeOperation.current === operation) { activeOperation.current = null; inFlight.current = false; setBusy(false); }
      if (requestController.current === controller) requestController.current = null;
    }
  }

  function readFacts(): CameraFacts {
    const facts: CameraFacts = {};
    for (const fact of workflow.requiredFacts) {
      const raw = inputs[fact.id]?.trim();
      if (!raw && fact.kind === "number") continue;
      if (!raw) throw new Error(`Confirm ${fact.label.toLowerCase()} before starting.`);
      if (fact.kind === "number") {
        const value = Number(raw);
        if (!Number.isFinite(value) || (fact.min !== null && value < fact.min) || (fact.max !== null && value > fact.max)) throw new Error(`Enter a measured value within the supported range for ${fact.label.toLowerCase()}.`);
        facts[fact.id] = value;
      } else if (fact.kind === "boolean") {
        if (raw !== "true") throw new Error(`This workflow needs confirmation: ${fact.label}.`);
        facts[fact.id] = true;
      } else {
        facts[fact.id] = raw;
      }
    }
    return facts;
  }

  function reviewFacts(changedFact?: { id: string; value: number }) {
    if (!session) return;
    stopCamera(); setInputs(factsInputs({ ...session.facts, ...(changedFact ? { [changedFact.id]: changedFact.value } : {}) }));
    setFactsConfirmed(false); setEditingFacts(true);
  }
  async function answerEvidenceRequest(cancel = false) {
    if (cancel) { await cancelEvidenceRequest(); return; }
    if (!session || !openRequest || locked || watching) return;
    if (!awaitingFactAnswer || !requestedFact || !requestAnswerConfirmed || !requestAnswerInRange || changesConfirmedFact) return;
    stopWatching();
    const action = "request_answer";
    const identity = JSON.stringify({ sessionId: session.id, requestId: openRequest.id, action, value: answerNumber, unit: openRequest.measurement!.unit });
    const clientOperationId = requestOperationIds.current.get(identity) || crypto.randomUUID();
    requestOperationIds.current.set(identity, clientOperationId);
    const next = await operate(`/api/camera/sessions/${session.id}`, { action, requestId: openRequest.id, expectedRevision: session.revision, clientOperationId,
      value: answerNumber, unit: openRequest.measurement!.unit }, "PATCH");
    if (next) setNotice("Your confirmed fact was saved. Take a fresh checkpoint when ready; no analysis was started.");
  }
  /** Cancellation stays available while its view-answer fetch is awaiting Meta. */
  async function cancelEvidenceRequest() {
    if (!session || !openRequest || !canCancelEvidenceRequest) return;
    const ticket = beginRequest();
    const pending = pendingViewAnswer.current;
    const identity = JSON.stringify({ sessionId: session.id, requestId: openRequest.id, action: "request_cancel" });
    const clientOperationId = requestOperationIds.current.get(identity) || crypto.randomUUID();
    requestOperationIds.current.set(identity, clientOperationId);
    setRequestMutationBusy(true); setError(""); stopWatching();
    try {
      const response = await fetch(`/api/camera/sessions/${session.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "request_cancel", requestId: openRequest.id, expectedRevision: session.revision, clientOperationId }) });
      const output = await response.json();
      if (!response.ok) throw new Error(publicError(output, "The evidence request could not be cancelled."));
      const next = applyState(output, ticket);
      if (next) {
        // Detach this local wait without aborting its fetch or erasing its audit.
        // Its eventual response still passes the normal revision/sequence fence.
        if (pending?.sessionId === session.id && pending.requestId === openRequest.id && activeOperation.current === pending.operation) {
          activeOperation.current = null; inFlight.current = false; setBusy(false);
        }
        setNotice("The evidence request was cancelled. A pending response remains in history and cannot restore its old guidance. Take a fresh checkpoint when ready.");
      }
    } catch (cause) {
      if (!canApplyResponse(ticket)) return;
      setError((cause as Error).message);
      try { await loadSession(session.id); } catch { setUncertain(true); setNotice("The cancellation result is uncertain. Refresh this session before another check."); }
    } finally { if (mounted.current && ticket.generation === requestGeneration.current) setRequestMutationBusy(false); }
  }

  async function saveFacts() {
    try {
      const facts = readFacts();
      if (!factsConfirmed) throw new Error("Confirm that these are actual operator-stated facts.");
      const next = session && editingFacts
        ? await operate(`/api/camera/sessions/${session.id}`, { action: "facts", expectedRevision: session.revision, facts }, "PATCH")
        : await operate("/api/camera/sessions", { workflowId: workflow.id, facts });
      if (next) { setEditingFacts(false); window.history.replaceState({}, "", `/camera?session=${next.session.id}`); }
    } catch (cause) { setError((cause as Error).message); }
  }

  async function adoptScene(intake: PublicCameraIntake) {
    if (!intake.adoptedSessionId && (!intake.result?.workflowId || intake.result.frameQuality !== "clear" || intake.result.viewRequest)) return;
    setError("");
    try {
      const next = intake.adoptedSessionId ? await loadSession(intake.adoptedSessionId)
        : await operate("/api/camera/sessions", { workflowId: intake.result!.workflowId, facts: {}, intakeId: intake.id, intakeRevision: intake.revision });
      if (next) {
        setEditingFacts(false); setManualEntry(false); setInputs({}); setFactsConfirmed(false);
        window.history.replaceState({}, "", `/camera?session=${next.session.id}`);
        setNotice("Your scene is saved. Confirm one detail at a time, then capture a fresh setup view before following physical guidance.");
      }
    } catch (cause) { setError((cause as Error).message || "The saved workflow could not be opened. Refresh and try again."); }
  }

  async function confirmPrerequisite(value: string | number | boolean, intakeDraftId?: string) {
    if (!session || !nextPrerequisite || !state?.capabilities?.progressivePrerequisites || locked || watching) return;
    const payload = { factKey: nextPrerequisite.id, value, unit: nextPrerequisite.kind === "number" ? nextPrerequisite.unit : null, operatorConfirmed: true, ...(intakeDraftId ? { intakeDraftId } : {}) };
    const next = await operate(`/api/camera/sessions/${session.id}`, { action: "prerequisite", expectedRevision: session.revision,
      ...payload, clientOperationId: operatorOperationId("prerequisite", payload) }, "PATCH");
    if (next) setNotice("That detail was confirmed. No analysis was started and no phase was advanced.");
  }

  async function submitFrame(frame: CameraCapture, framePurpose: "before" | "after" = purpose) {
    if (!session || requiresReconfirmation || prerequisitesPending || locked || modelAllowanceExhausted || awaitingFactAnswer || !step || session.status === "scene_changed" || !checksRemaining) return;
    const pending = openRequest?.kind === "request_view" ? { sessionId: session.id, requestId: openRequest.id, operation: operationSequence.current + 1 } : null;
    try {
      window.speechSynthesis?.cancel();
      const bytes = Uint8Array.from(atob(frame.dataUrl.split(",", 2)[1]), character => character.charCodeAt(0));
      const file = new Blob([bytes], { type: "image/jpeg" });
      const form = new FormData();
      form.set("file", new File([file], "camera-checkpoint.jpg", { type: "image/jpeg" }));
      form.set("operationId", crypto.randomUUID()); form.set("expectedRevision", String(session.revision));
      form.set("purpose", openRequest?.sourcePurpose || framePurpose); form.set("source", frame.source); form.set("capturedAt", frame.capturedAt ?? "null"); form.set("operatorNote", operatorNote);
      if (openRequest?.kind === "request_view") form.set("requestId", openRequest.id);
      if (pending) pendingViewAnswer.current = pending;
      return await operate(`/api/camera/sessions/${session.id}/frames`, form);
    } catch (cause) { setError((cause as Error).message); }
    finally { if (pending && pendingViewAnswer.current === pending) pendingViewAnswer.current = null; }
  }

  async function captureNow() { try { await submitFrame(camera.capture()); } catch (cause) { setError((cause as Error).message); } }
  async function chooseFrame(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
    if (!file || locked) return;
    const generation = requestGeneration.current;
    try { const frame = await camera.readUpload(file); if (mounted.current && generation === requestGeneration.current) await submitFrame(frame); } catch (cause) { setError((cause as Error).message); }
  }
  async function refresh() { if (!session || busy) return; setError(""); setBusy(true); try { await loadSession(session.id); setNotice("Session refreshed without repeating analysis."); } catch (cause) { setError((cause as Error).message); } finally { setBusy(false); } }
  async function confirmStep() {
    if (!session || !latest || !canConfirm) return;
    const next = await operate(`/api/camera/sessions/${session.id}`, { action: "confirm", expectedRevision: session.revision, turnId: latest.id, confirmations, measurements: observedMeasurements(), notes: confirmationNotes }, "PATCH");
    if (next) setNotice(next.session.status === "operator_reviewed_complete" ? "Your complete sequence review was saved. This is an operator assessment, not independent physical verification." : "Step review saved. Take a new setup checkpoint for the next step.");
  }
  function observedMeasurements() {
    return Object.fromEntries(requiredMeasurements.map(measurement => {
      const raw = measurements[measurement.id]?.trim();
      const value = raw ? Number(raw) : NaN;
      return [measurement.id, Number.isFinite(value) ? value : null];
    }));
  }
  function operatorOperationId(action: string, payload: object) {
    const identity = JSON.stringify({ sessionId: session?.id, action, ...payload });
    const operation = requestOperationIds.current.get(identity) || crypto.randomUUID();
    requestOperationIds.current.set(identity, operation);
    return operation;
  }
  async function bindPhysicalEntity(observationId: string) {
    if (!session || !latest || !currentAssessment || openRequest || !assessedImageReady || !fresh || locked || watching) return;
    const input = identityInputs[observationId];
    const existing = input?.entityId ? knownEntities.find(entity => entity.id === input.entityId) : null;
    const label = existing?.label || input?.label.trim();
    if (!input?.confirmed || !label || input.entityId && !existing) return;
    const payload = { turnId: latest.id, observationId, label, entityId: existing?.id || null, operatorConfirmed: true };
    const next = await operate(`/api/camera/sessions/${session.id}`, { action: "entity_bind", expectedRevision: session.revision, ...payload,
      clientOperationId: operatorOperationId("entity_bind", payload) }, "PATCH");
    if (next) setNotice("The physical label was saved as your confirmed identity. Take a fresh checkpoint; no analysis was started.");
  }
  async function acceptPlanChange() {
    if (!session || !planProposal || !planAccepted || openRequest || !assessedImageReady || !fresh || locked || watching) return;
    const payload = { proposalId: planProposal.id, operatorConfirmed: true };
    const next = await operate(`/api/camera/sessions/${session.id}`, { action: "plan_accept", expectedRevision: session.revision, ...payload,
      clientOperationId: operatorOperationId("plan_accept", payload) }, "PATCH");
    if (next) setNotice("Your plan change was saved. Mandatory checks still apply. Capture a fresh setup before acting; no analysis was started.");
  }
  async function saveActualRecheck() {
    if (!session || !latest || !currentAssessment || !step || !recheckConfirmed || !assessedImageReady || !fresh || locked || watching || !confirmationNotes.trim()) return;
    const payload = { turnId: latest.id, measurements: observedMeasurements(), confirmations, notes: confirmationNotes, operatorConfirmed: true };
    const next = await operate(`/api/camera/sessions/${session.id}`, { action: "reading_report", expectedRevision: session.revision, ...payload,
      clientOperationId: operatorOperationId("reading_report", payload) }, "PATCH");
    if (next) setNotice("Your actual recheck was saved without advancing the step. Take a fresh after-view to compare the original prediction; no analysis was started.");
  }
  async function recordReview(outcome: "failed" | "incomplete") {
    if (!session || !assessedImageReady || requiresReconfirmation || session.status !== "active" || !latest || latest.stepId !== session.currentStepId || !fresh || locked || watching || !confirmationNotes.trim()) return;
    const next = await operate(`/api/camera/sessions/${session.id}`, { action: "review", outcome, expectedRevision: session.revision, turnId: latest.id, confirmations, measurements: observedMeasurements(), notes: confirmationNotes }, "PATCH");
    if (next) setNotice(`Your ${next.session.reviews?.at(-1)?.outcome || outcome} review was saved without advancing the step. Capture a new setup before the next attempt.`);
  }
  watchTick.current = async (id: number) => {
    const run = watchRun.current;
    if (!run || run.id !== id) return;
    if (document.visibilityState !== "visible" || !assessedImageReady || requiresReconfirmation || modelAllowanceExhausted || !camera.active || locked || inFlight.current || !session || session.id !== run.sessionId || session.currentStepId !== run.stepId || session.sceneEpoch !== run.sceneEpoch || session.beforeTurn?.id !== run.beforeTurnId || session.status !== "active") {
      stopWatching("Watching paused because the current setup or camera is no longer ready."); return;
    }
    try {
      const frame = camera.capture();
      run.checksStarted++;
      setWatchStatus({ active: true, checksStarted: run.checksStarted });
      const result = await submitFrame(frame, "after");
      if (watchRun.current !== run) return;
      if (!result || (result.turn || result.turns.at(-1))?.status !== "completed" || result.session.status !== "active" || result.session.currentStepId !== run.stepId || result.session.sceneEpoch !== run.sceneEpoch || result.session.beforeTurn?.id !== run.beforeTurnId) {
        stopWatching("Watching stopped after an error or setup change. No request was repeated."); return;
      }
      if (result.session.guidance.canConfirm) { stopWatching("The latest view is ready for your physical review. Watching stopped; no step was confirmed automatically."); return; }
      if (!isCameraDecisionAssessment(result.session.latestTurn?.assessment) || result.session.latestTurn.assessment.decisionKind !== "propose_action"
        || result.session.reasoning?.activePredictionId !== `prediction:${result.session.latestTurn.id}` || !result.session.guidance.actionable) { stopWatching("Watching paused so you can resolve the latest uncertainty or retake the view."); return; }
      if (run.checksStarted >= 3) { stopWatching("Three-check budget used. Inspect the saved results before choosing another watch run."); return; }
      run.timer = window.setTimeout(() => { run.timer = null; void watchTick.current(id); }, 15_000);
    } catch (cause) { setError((cause as Error).message); stopWatching("Watching stopped. No additional snapshot will be sent."); }
  };
  function beginWatching() {
    if (openRequest || modelAllowanceExhausted || !currentActionRecorded || decision?.kind !== "propose_action" || !session || !assessedImageReady || requiresReconfirmation || !step || !camera.active || !session.beforeTurn || !session.guidance.actionable || !fresh || locked || watchRun.current || !meta?.configured || !checksRemaining) return;
    const run: WatchRun = { id: ++watchSequence.current, sessionId: session.id, stepId: step.id, sceneEpoch: session.sceneEpoch, beforeTurnId: session.beforeTurn.id, checksStarted: 0, timer: null };
    watchRun.current = run; setWatchStatus({ active: true, checksStarted: 0 });
    setNotice("Watching this step sends up to three snapshots to Meta, with 15 seconds between completed checks. You still review every step yourself.");
    void watchTick.current(run.id);
  }
  function speakAction() {
    if (!visibleDecision || !readableAction || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const spoken = [visibleDecision.instruction, visibleDecision.expectedVisibleResult && `Look for: ${visibleDecision.expectedVisibleResult}`, visibleDecision.stopCondition && `Stop or retake if: ${visibleDecision.stopCondition}`, visibleDecision.whyNeeded, visibleDecision.resolves, ...(visibleDecision.preconditions || [])].filter(Boolean).join(" ");
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(spoken));
  }

  return <main className={styles.page}>
    <header className={styles.topbar}><Link href="/" className={styles.brand}><Mark/> CounterShot<span className={styles.badge}>Camera workbench</span></Link><div className={styles.topbarLinks}><span className={styles.badge}><Camera size={13}/> Camera guidance</span><Link href="/">Projects <ArrowRight size={13}/></Link></div></header>
    <div className={styles.content}>
      {error && <div className={`${styles.notice} ${styles.error}`} role="alert"><CircleAlert size={16}/> {error} <button type="button" className={`${styles.button} ${styles.subtle}`} onClick={() => setError("")} aria-label="Dismiss camera error"><X size={15}/></button></div>}
      {notice && <div className={styles.notice} role="status">{notice}</div>}
      {loading ? <p role="status"><LoaderCircle size={18} className={styles.busy}/> Opening the camera workbench…</p> : !accessChecked ? <section className={styles.notice}><p>Workspace access could not be confirmed. Refresh before opening the camera.</p><button type="button" className={styles.button} disabled={busy} onClick={() => { setLoading(true); void loadIndex().catch(cause => setError((cause as Error).message)).finally(() => setLoading(false)); }}>Refresh workspace</button></section> : accessRequired ? <section className={styles.setup}><div><span className={styles.eyebrow}>Private workspace</span><h1>Open your camera workspace.</h1><p>Use the same access code as the main application. Your projects stay in this browser session.</p></div><form onSubmit={async event => { event.preventDefault(); setBusy(true); setError(""); try { const response = await fetch("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accessCode }) }); const body = await response.json(); if (!response.ok) throw new Error(publicError(body, "The access code was not accepted.")); setAccessCode(""); await loadIndex(); } catch (cause) { setError((cause as Error).message); } finally { setBusy(false); } }}><label className={styles.field}>Workspace access code<input type="password" autoComplete="current-password" required value={accessCode} onChange={event => setAccessCode(event.target.value)}/></label><button className={`${styles.button} ${styles.primary}`} disabled={busy}>Open workspace <ArrowRight size={15}/></button></form></section> : <>
        {!state && !manualEntry && <><CameraSceneEntry camera={camera} meta={meta} locked={busy} available={capabilities.sceneIntake === true} onAdopt={adoptScene} onManual={() => { stopCamera(); setManualEntry(true); }}/><CameraFlow/></>}
        {!state && manualEntry && <><section className={styles.hero}><span className={styles.eyebrow}>Manual setup</span><h1>Choose a supported workflow.</h1><p>Use this setup when you already know the task and its actual details.</p><button type="button" className={styles.button} onClick={() => setManualEntry(false)}><Camera size={16}/> Back to the camera</button></section><div className={styles.workflowGrid} aria-label="Camera workflows">{cameraWorkflows.map(item => <button type="button" key={item.id} className={styles.workflowCard} aria-pressed={selectedWorkflowId === item.id} disabled={busy} onClick={() => { selectWorkflow(item.id); setManualEntry(true); }}><div className={styles.iteration}>Camera task <ScanLine size={17}/></div><strong>{item.title}</strong><span>{item.summary}</span></button>)}</div></>}
        {sessionList.length > 0 && !state && <label className={styles.field}>Resume a camera session<select value="" disabled={busy} onChange={event => { if (!event.target.value) return; setLoading(true); void loadSession(event.target.value).then(next => { if (next) window.history.replaceState({}, "", `/camera?session=${next.session.id}`); }).catch(cause => setError((cause as Error).message)).finally(() => setLoading(false)); }}><option value="">Choose a session in this browser</option>{sessionList.map(item => <option key={item.id} value={item.id}>{cameraWorkflow(item.workflowId)?.title} · {item.completedSteps.length} reviewed · {new Date(item.updatedAt).toLocaleString()}</option>)}</select></label>}
        {(!state && manualEntry || editingFacts) ? <section className={styles.setup} aria-label="Confirm workflow facts"><div className={styles.setupIntro}><span className={styles.eyebrow}>Explicit setup details</span><h2>{workflow.title}</h2><p>Confirm your setup so the guidance uses your real parts, measurements and available tools.</p><p>Leave measurements you do not know blank; no action is admitted until its required facts are confirmed.</p><p className={styles.setupOutcome}><ScanLine size={18}/> After your photo, you’ll get a proposed next step or a question about what is still unclear.</p><details className={styles.setupDetails}><summary>Task scope and camera limits</summary><p>{workflow.physicalScope}</p><span className={styles.sectionLabel}>Workflow</span><ul className={styles.phaseList}>{workflow.steps.map(item => <li key={item.id}>{item.title}</li>)}</ul><ul>{workflow.limitations.map(limit => <li key={limit}>{limit}</li>)}</ul></details></div><form onSubmit={event => { event.preventDefault(); void saveFacts(); }}><div className={styles.facts}>{workflow.requiredFacts.map(fact => <label className={styles.field} key={fact.id}>{fact.label}{fact.unit ? ` (${fact.unit})` : ""}{fact.kind === "boolean" ? <select required value={inputs[fact.id] || ""} onChange={event => { setInputs(previous => ({ ...previous, [fact.id]: event.target.value })); setFactsConfirmed(false); }}><option value="">Not confirmed</option><option value="true">I confirm this is true</option><option value="false">Not true / outside this workflow</option></select> : fact.kind === "number" ? <input type="number" step="any" min={fact.min ?? undefined} max={fact.max ?? undefined} value={inputs[fact.id] || ""} onChange={event => { setInputs(previous => ({ ...previous, [fact.id]: event.target.value })); setFactsConfirmed(false); }}/> : <textarea required maxLength={2000} value={inputs[fact.id] || ""} onChange={event => { setInputs(previous => ({ ...previous, [fact.id]: event.target.value })); setFactsConfirmed(false); }}/>}</label>)}</div><label className={styles.confirm}><input type="checkbox" checked={factsConfirmed} onChange={event => setFactsConfirmed(event.target.checked)}/><span>These are actual measured or operator-stated facts. A photograph does not establish hidden dimensions or capabilities.</span></label>{editingFacts && <p className={styles.cameraHelp}>Changing facts starts a new view sequence. Earlier checks and reviews stay historical.</p>}<div className={styles.cameraControls}><button className={`${styles.button} ${styles.primary}`} disabled={busy || !factsConfirmed}>{editingFacts ? "Save facts and restart view checks" : "Start this workflow"}<ArrowRight size={15}/></button>{editingFacts && <button type="button" className={styles.button} disabled={busy} onClick={() => setEditingFacts(false)}>Cancel</button>}</div></form></section> : state ? <>
          <div className={styles.sessionHeader}><div><span className={styles.eyebrow}>Your camera session</span><h2>{workflow.title}</h2><p>{workflow.summary}</p></div><div className={styles.cameraControls}><button type="button" className={styles.button} disabled={locked || watching} onClick={() => reviewFacts()}>Review facts</button><button type="button" className={styles.button} disabled={busy} onClick={() => void refresh()}><RefreshCw size={14}/> Refresh session</button><button type="button" className={`${styles.button} ${styles.subtle}`} disabled={locked || watching} onClick={() => selectWorkflow(selectedWorkflowId)}>New workflow</button></div></div>
          {requiresReconfirmation && <div className={styles.notice} role="status"><strong>Historical checks · confirmation required.</strong> This session used earlier workflow checks. Its saved evidence and reviews remain historical. Review the facts and restart view checks before continuing under the current requirements.</div>}
          {!meta?.configured && <div className={styles.notice}>AI analysis is unavailable. The workspace owner needs to connect Meta. You can still use the camera preview and view your saved records.</div>}
          {openRequest && <section className={styles.nextAction} aria-label="Saved evidence request">
            <span className={styles.sectionLabel}>Waiting for your evidence · saved request</span><h3>{awaitingFactAnswer ? "Confirm the requested setup fact." : "Show the requested view."}</h3>
            <p>{openRequest.instruction}</p><p><b>Why:</b> {openRequest.whyNeeded}</p><p>{openRequest.resolves}</p>
            {awaitingFactAnswer && requestedFact ? <form onSubmit={event => { event.preventDefault(); void answerEvidenceRequest(); }}>
              <p>This confirms a prerequisite fact or specification. Record the actual result of a physical check separately in Your physical verification.</p>
              {typeof confirmedRequestValue === "number" && <p>Currently confirmed: {confirmedRequestValue} {openRequest.measurement?.unit || ""}. A changed confirmed fact requires a new view sequence.</p>}
              <label className={styles.field}>Requested fact: {requestedFact.label}{openRequest.measurement?.unit ? ` (${openRequest.measurement.unit})` : ""}<input type="number" step="any" min={requestedFact.min ?? undefined} max={requestedFact.max ?? undefined} value={requestAnswerValue} disabled={locked} onChange={event => { setRequestAnswerValue(event.target.value); setRequestAnswerConfirmed(false); }}/></label>
              <label className={styles.confirm}><input type="checkbox" checked={requestAnswerConfirmed} disabled={locked || !requestAnswerInRange || changesConfirmedFact} onChange={event => setRequestAnswerConfirmed(event.target.checked)}/><span>I checked this exact prerequisite fact and its stated unit.</span></label>
              {changesConfirmedFact && <div className={styles.notice}><p>This value changes a confirmed fact. Review the facts and restart view checks before using it.</p><button type="button" className={styles.button} disabled={locked} onClick={() => reviewFacts({ id: requestedFact.id, value: answerNumber })}>Review changed facts</button></div>}
              <div className={styles.cameraControls}><button className={`${styles.button} ${styles.primary}`} disabled={locked || !requestAnswerConfirmed || !requestAnswerInRange || changesConfirmedFact}>Save requested fact</button><button type="button" className={styles.button} disabled={!canCancelEvidenceRequest} onClick={() => void answerEvidenceRequest(true)}>Cancel evidence request</button></div>
              <p className={styles.cameraHelp}>Saving an answer makes no model request. Choose a new checkpoint explicitly after the answer is saved.</p>
            </form> : <><p>Use Answer with this view or Choose requested view below. This answers the saved {openRequest.sourcePurpose === "before" ? "setup" : "after-action"} request without changing the step.</p><button type="button" className={styles.button} disabled={!canCancelEvidenceRequest} onClick={() => void answerEvidenceRequest(true)}>Cancel evidence request</button></>}
          </section>}
          <div className={styles.workspace}><section className={styles.cameraColumn} aria-label="Camera and selected evidence">
            <div className={styles.cameraStage}>
              <video ref={camera.attachVideo} autoPlay muted playsInline className={styles.liveVideo} style={{ display: camera.active ? "block" : "none" }} aria-label="Local camera preview"/>
              {camera.active ? <span className={styles.cameraStatus}><i/> Preview on device · not continuously sent</span> : latestFrame ? <><img src={latestFrame.url} className={styles.frozenImage} alt="Last checked snapshot; camera is stopped"/><span className={styles.cameraStatus}>Camera stopped · saved checkpoint</span>{!complete && <button type="button" className={`${styles.button} ${styles.stageRestart}`} disabled={camera.starting} onClick={() => void camera.start()}><Camera size={16}/>{camera.starting ? "Opening camera…" : "Start camera"}</button>}</> : <div className={styles.cameraEmpty}><Camera size={37}/><h3>Show the current setup.</h3><p>Start the camera or upload a photo. You’ll get a proposed next step, the change to look for and any questions to resolve.</p><button type="button" className={`${styles.button} ${styles.primary}`} disabled={camera.starting || complete} onClick={() => void camera.start()}>{camera.starting ? <LoaderCircle className={styles.busy} size={17}/> : <Camera size={17}/>} {camera.starting ? "Opening camera…" : "Start camera"}</button>{camera.starting && <button type="button" className={styles.button} onClick={stopCamera}>Cancel camera request</button>}</div>}
            </div>
            {!complete && <section className={styles.mobileCue} aria-label="Current camera action"><span className={styles.eyebrow}>{visibleDecision?.label || (assessment ? "From last checked frame" : "Next checkpoint")} · {step?.title}</span><strong>{visibleDecision ? visibleDecision.instruction : busy || waiting ? "Checking the snapshot you selected…" : prerequisitesPending ? "Confirm the setup detail for this phase before inspecting a fresh view." : "Inspect a clear setup before moving parts."}</strong>{visibleDecision && <div className={styles.cueDetails}><DecisionDetails decision={visibleDecision}/></div>}</section>}{camera.error && <div className={`${styles.notice} ${styles.error}`} role="alert">{camera.error}</div>}
            {!complete && <><div className={`${styles.cameraControls} ${styles.captureActions}`}><button type="button" className={`${styles.button} ${styles.primary}`} disabled={requiresReconfirmation || prerequisitesPending || modelAllowanceExhausted || awaitingFactAnswer || !camera.active || locked || watching || !checksRemaining || !meta?.configured || session?.status === "scene_changed"} onClick={() => void captureNow()}>{busy || waiting ? <LoaderCircle size={17} className={styles.busy}/> : <ScanLine size={17}/>} {busy || waiting ? "Checking selected frame…" : openRequest?.kind === "request_view" ? "Answer with this view" : purpose === "before" ? "Inspect this setup" : "Check after action"}</button><button type="button" className={styles.button} disabled={requiresReconfirmation || prerequisitesPending || modelAllowanceExhausted || awaitingFactAnswer || locked || watching || !checksRemaining || !meta?.configured || session?.status === "scene_changed"} onClick={() => fileInput.current?.click()}><ImagePlus size={17}/> {openRequest?.kind === "request_view" ? "Choose requested view" : "Choose checkpoint photo"}</button><input ref={fileInput} type="file" accept="image/jpeg,image/png" className={styles.hidden} aria-label="Upload camera checkpoint" disabled={requiresReconfirmation || prerequisitesPending || modelAllowanceExhausted || awaitingFactAnswer || locked || watching} onChange={event => void chooseFrame(event)}/></div><div className={styles.cameraControls}>{camera.active && <button type="button" className={styles.button} onClick={stopCamera}><StopCircle size={16}/> Stop camera</button>}</div><details className={styles.checkpointOptions}><summary>Checkpoint options and operator note</summary><label className={styles.field}>Checkpoint purpose<select value={openRequest?.sourcePurpose || purpose} disabled={!!openRequest || locked || watching || session?.status === "scene_changed"} onChange={event => setPurpose(event.target.value as "before" | "after")}><option value="before">Before action · inspect setup</option><option value="after" disabled={!session?.beforeTurn}>After action · check result</option></select></label><label className={styles.field}>What changed or needs attention?<textarea value={operatorNote} maxLength={2000} disabled={locked || watching} onChange={event => setOperatorNote(event.target.value)} placeholder="Name the part, blocked movement, changed condition, or result to inspect."/></label></details>{watching ? <div className={styles.watchControls}><span role="status">Watching: {watchStatus.checksStarted} of 3 checks started. The next check waits 15 seconds after a response.</span><button type="button" className={styles.button} onClick={() => stopWatching("Watching stopped. An in-flight check may still finish; no additional snapshot will be sent.")}><StopCircle size={16}/> Stop watching</button></div> : <details className={styles.checkpointOptions}><summary>Watch options</summary><div className={styles.watchControls}><button type="button" className={styles.button} disabled={!assessedImageReady || requiresReconfirmation || modelAllowanceExhausted || !camera.active || locked || !checksRemaining || !session?.beforeTurn || !!openRequest || !currentActionRecorded || decision?.kind !== "propose_action" || !session.guidance.actionable || !fresh || !meta?.configured} onClick={beginWatching}><Camera size={16}/> Watch this step (3 checks)</button><span>Optionally send up to three after-photos, 15 seconds after each response. You confirm the result yourself.</span></div></details>}<p className={styles.cameraHelp}>Your preview stays on this device. Inspecting a frame sends that snapshot to Meta. {executionBudget ? `${modelRequestsRemaining} model requests remain.` : `${checksRemaining} checks remain.`}</p>{executionBudget && <details className={styles.checkpointOptions} aria-label="Analysis allowance"><summary>Analysis allowance</summary><p>An inspection may retrieve one earlier view; at most two model requests. Preview stays local.</p><p>Response capacity reserved: {responseCapacityReserved}% of this session’s limit. Time remaining: {remainingModelAllowance ? Math.ceil(remainingModelAllowance.timeMs / 60_000) : 0} minutes.</p><p>Reviewing facts or changing the plan does not refill this allowance.</p></details>}{modelAllowanceExhausted && <p className={styles.notice} role="status">{invalidModelAllowance ? "The analysis allowance could not be verified. Refresh this session." : "This session has used its analysis allowance or reached its time limit. Saved evidence and operator reviews remain available."}</p>}</>}
            {latestFrame && latest && <section className={styles.frameReview} aria-label="Assessed frozen frame"><div className={styles.frameHeader}><strong>{latest.purpose === "before" ? "Setup checkpoint" : "After-action checkpoint"}</strong><span><Clock3 size={11}/> Received {ageLabel(latest.receivedAt, now)}</span></div><div className={styles.frameCanvas}><img key={`${session!.id}:${latestFrame.id}`} src={latestFrame.url} alt="Exact snapshot used for the current guidance" onLoad={() => markAssessedImage(session!.id, latestFrame.id, "loaded")} onError={() => markAssessedImage(session!.id, latestFrame.id, "error")}/><svg className={styles.regions} viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-label="Model observations on this saved frame">{assessment?.observations.map((observation, index) => { const box = observation.box; if (!box || box.x + box.width > 1 || box.y + box.height > 1) return null; return <g key={observation.id}><rect className={styles.region} x={box.x * 1000} y={box.y * 1000} width={box.width * 1000} height={box.height * 1000}/><text className={styles.regionText} x={box.x * 1000 + 7} y={box.y * 1000 + 20}>{index + 1}</text></g>; })}</svg></div><p className={styles.cameraHelp}>{latestFrame.source === "upload" ? "Uploaded photo: actual capture time is unknown." : "Camera snapshot: capture time is device-reported."} Markers belong to this saved image, not the moving preview. Check again after moving parts or changing the view.</p></section>}
          </section><aside className={styles.coach} aria-label="Camera guidance">
            <span className={styles.eyebrow}>{complete ? requiresReconfirmation ? "Historical operator review" : "Operator review recorded" : "Current step"}</span><div className={styles.stepPills} aria-label={`${session?.completedSteps.length} of ${workflow.steps.length} steps reviewed`}>{workflow.steps.map(item => <span key={item.id} data-complete={session?.completedSteps.some(done => done.stepId === item.id)} data-active={step?.id === item.id}/>)}</div>
            <h3>{complete ? requiresReconfirmation ? "Historical operator review." : "Sequence reviewed by you." : step?.title || "Inspect the current view."}</h3>
            {complete ? requiresReconfirmation ? <p>Your earlier operator review remains saved. It does not establish that the current workflow requirements were checked. Review the facts to begin a new sequence.</p> : <p>All required step reviews are recorded against their before/after frames. This is operator-reported evidence; successful physical function and comparison results still need actual trials.</p> : negativeScope ? <p>The recorded scope does not match this workflow. Review the actual setup before continuing.</p> : prerequisitesPending ? <p>Confirm the detail needed for this phase, then take a fresh setup checkpoint. A scene description does not authorize a physical action.</p> : <p>{step?.instruction}</p>}
            {sceneIntake?.frame && <details className={styles.sceneContext} open={!!nextPrerequisite} aria-label="Saved scene context"><summary>The scene we started from</summary><img src={sceneIntake.frame.url} alt="Scene snapshot used for setup drafts" onLoad={() => setSceneImageLoaded(sceneIntake.frame!.id)} onError={() => setSceneImageLoaded(value => value === sceneIntake.frame!.id ? null : value)}/><p>{sceneIntake.result?.summary}</p><p className={styles.cameraHelp}>This saved image provides context. It is not a before-action checkpoint or proof of a completed check.</p></details>}
            {nextPrerequisite && <CameraPrerequisite key={nextPrerequisite.id} fact={nextPrerequisite} draft={prerequisiteDraft} draftReady={!prerequisiteDraft || sceneImageLoaded === sceneIntake?.frame?.id} operatorContext={session?.setupContext?.context} disabled={locked || watching} onConfirm={confirmPrerequisite}/>}
            {negativeScope && <div className={styles.notice} role="status"><strong>This setup is outside the confirmed scope.</strong><p>{negativeScope.label}</p><p>Choose a different workflow, or explicitly review the facts if the physical setup has changed.</p></div>}
            {waiting && <div className={styles.notice} role="status"><LoaderCircle size={16} className={styles.busy}/> Meta is checking the selected snapshot. You can stop the local camera; no additional frames are being sent.</div>}
            {assessedImageFailed && <div className={`${styles.notice} ${styles.error}`} role="alert">The assessed snapshot could not be displayed. Guidance and physical review are paused. Capture a new checkpoint or reload this page before continuing.</div>}
            {lastRequest?.status === "failed" && <div className={`${styles.notice} ${styles.error}`}>The last check did not complete. {lastRequest.error} It was not repeated automatically.</div>}
            {session?.status === "scene_changed" && <div className={styles.notice}>The scene changed. Review the actual facts and restart the view sequence before following more guidance.</div>}
            {assessment && <><span className={styles.sectionLabel}>{currentAssessment ? "What this frame supports" : "Historical assessment"}</span><p>{assessment.summary}</p>{!currentAssessment && <div className={styles.notice}>This saved assessment uses an earlier or invalid decision contract. It cannot authorize current guidance. Review facts and restart view checks.</div>}<div className={admittedAction ? styles.nextAction : styles.notice}><strong>{visibleDecision?.label || "Guidance paused"}</strong><p>{visibleDecision ? visibleDecision.instruction : "Do not move parts from this view. Retake the checkpoint or resolve the listed uncertainty."}</p>{visibleDecision && <DecisionDetails decision={visibleDecision}/>}</div>{currentAssessment && <button type="button" className={`${styles.button} ${styles.subtle}`} disabled={!readableAction || (typeof window !== "undefined" && !("speechSynthesis" in window))} onClick={speakAction}><Volume2 size={15}/> Read guidance aloud</button>}<p className={styles.cameraHelp}>Checked frame received {latest ? ageLabel(latest.receivedAt, now) : "at an unknown time"}. {!fresh && <strong>This view is stale; take a new checkpoint before review.</strong>}</p><details className={styles.supportingDetails}><summary>About this check</summary><p>Model: {lastRequest?.trace?.model || meta?.model || "unavailable"}.{typeof lastRequest?.trace?.latencyMs === "number" ? ` Model check: ${lastRequest.trace.latencyMs < 100 ? "<0.1" : (lastRequest.trace.latencyMs / 1000).toFixed(1)}s.` : ""} A still cannot establish hidden connections, force, a seal or a completed physical cycle.</p></details>{assessment.observations.length > 0 && <details className={styles.supportingDetails}><summary>What Meta noticed</summary><ol className={styles.evidenceList}>{assessment.observations.map(observation => <li key={observation.id}><strong>{observation.label}.</strong> {observation.detail}</li>)}</ol></details>}</>}
            {recordedComparison && comparedPrediction && <section className={styles.notice} aria-label="Prediction comparison"><div><strong>{recordedComparison.status === "supported_by_view" ? "Supported by this view" : recordedComparison.status === "contradicted" ? "Original prediction contradicted" : "Original prediction unresolved"}</strong><p><b>Original expected result:</b> {comparedPrediction.expectedVisibleResult}</p>{!!recordedComparison.failedConditions.length && <ul>{recordedComparison.failedConditions.map(condition => <li key={condition}>{condition}</li>)}</ul>}{!!recordedComparison.unknownConditions.length && <ul>{recordedComparison.unknownConditions.map(condition => <li key={condition}>{condition}</li>)}</ul>}<p className={styles.cameraHelp}>This is a model comparison with the saved prediction. Your actual measurements and explicit review still determine progress.</p></div></section>}
            {recordedRecovery && <details className={styles.supportingDetails} aria-label="Recovery rationale"><summary>Why the proposed action changed</summary><p><b>Changed hypothesis:</b> {recordedRecovery.changedHypothesis}</p><p><b>Next discriminating check:</b> {recordedRecovery.nextObservation}</p><p>The single proposed action above is the correction. Its result still needs a new view and your actual checks.</p></details>}
            {!!counterevidence.length && <details className={styles.supportingDetails}><summary>Unresolved reports and comparisons ({counterevidence.length})</summary><ul>{counterevidence.map(claim => <li key={claim.id}><strong>{claim.source === "operator_report" ? "Operator report" : "Model interpretation"}:</strong> {claim.displayStatement}</li>)}</ul></details>}
            {planProposal && <section className={styles.nextAction} aria-label="Proposed plan change"><strong>{planProposal.kind === "reopen_phase" ? "Reopen an earlier phase" : "Adapt this phase"}</strong><p>{planProposal.rationale}</p>{planProposal.kind === "reopen_phase" ? <p>Return to {workflow.steps.find(item => item.id === planProposal.reopenStepId)?.title || planProposal.reopenStepId}. Its later completed checks must be reviewed again.</p> : <ul>{planProposal.substeps.map((substep,index) => <li key={index}><strong>{substep.instruction}</strong>{!!substep.preconditions.length && <p>Before this: {substep.preconditions.join(" ")}</p>}<p>Look for: {substep.expectedVisibleResult}</p><p>Stop if: {substep.stopCondition}</p></li>)}</ul>}<p>All mandatory workflow checks and confirmed measurement limits still apply. Accepting a plan does not complete physical work.</p><details className={styles.supportingDetails}><summary>Plan and evidence references</summary><p>Parent plan: <code style={{overflowWrap:"anywhere"}}>{planProposal.parentPlanVersion}</code></p><p>Counterevidence: <code style={{overflowWrap:"anywhere"}}>{planProposal.counterevidenceIds.join(", ")}</code></p></details><label className={styles.confirm}><input type="checkbox" checked={planAccepted} disabled={locked || !fresh || !!openRequest} onChange={event => setPlanAccepted(event.target.checked)}/><span>I accept this plan change and will capture a fresh view before acting.</span></label><button type="button" className={`${styles.button} ${styles.primary}`} disabled={!planAccepted || locked || !fresh || !assessedImageReady || !!openRequest} onClick={() => void acceptPlanChange()}>Accept plan change</button></section>}
            {!!phaseGuidance.length && <details className={styles.supportingDetails} aria-label="Current phase guidance"><summary>Current phase guidance</summary><p>These are accepted instructions within this phase. They have no automatic completion status; every mandatory physical check still applies.</p><ul>{phaseGuidance.map(substep => <li key={substep.id}><strong>{substep.instruction}</strong>{!!substep.preconditions.length && <p>Before this: {substep.preconditions.join(" ")}</p>}<p>Look for: {substep.expectedVisibleResult}</p><p>Stop if: {substep.stopCondition}</p></li>)}</ul></details>}
            {(knownEntities.length > 0 || currentAssessment?.observations.length) ? <details className={styles.supportingDetails} aria-label="Physical identities"><summary>Physical labels and identity</summary>{!!knownEntities.length && <><p>Labels confirmed by you in this scene:</p><ul>{knownEntities.map(entity => <li key={entity.id}>{entity.label}</li>)}</ul></>}{currentAssessment?.observations.map(observation => {
              const input = identityInputs[observation.id] || { label:"", entityId:"", confirmed:false };
              const hypothesis = currentAssessment.entityHypotheses.find(item => item.observationId === observation.id);
              return <form key={observation.id} aria-label={`Confirm identity for ${observation.label}`} onSubmit={event => { event.preventDefault(); void bindPhysicalEntity(observation.id); }}><strong>{observation.label}</strong>{hypothesis && <p>Unconfirmed visual match: {hypothesis.detail}</p>}<label className={styles.field}>Match an existing physical label<select value={input.entityId} disabled={locked || !fresh || !!openRequest} onChange={event => { const entity = knownEntities.find(item => item.id === event.target.value); setIdentityInputs(previous => ({...previous,[observation.id]:{ entityId:event.target.value, label:entity?.label || "", confirmed:false }})); }}><option value="">Create a new distinct physical label</option>{knownEntities.map(entity => <option key={entity.id} value={entity.id}>{entity.label}</option>)}</select></label><label className={styles.field}>Actual physical label<input maxLength={200} value={input.label} readOnly={!!input.entityId} disabled={locked || !fresh || !!openRequest} onChange={event => setIdentityInputs(previous => ({...previous,[observation.id]:{...input,label:event.target.value,confirmed:false}}))}/></label><label className={styles.confirm}><input type="checkbox" checked={input.confirmed} disabled={locked || !fresh || !!openRequest || !input.label.trim()} onChange={event => setIdentityInputs(previous => ({...previous,[observation.id]:{...input,confirmed:event.target.checked}}))}/><span>I matched this observed part to the physical label.</span></label><button className={styles.button} disabled={!input.confirmed || !input.label.trim() || locked || !fresh || !assessedImageReady || !!openRequest}>Save physical identity</button></form>;
            })}</details> : null}
            {!assessment && !complete && !prerequisitesPending && <div className={styles.nextAction}><strong>Take a fresh checkpoint.</strong><p>After your photo, Meta highlights what it can see and proposes one next step. If something is unclear, you’ll get a question or a request for another view.</p></div>}
            {!complete && (!progressiveSetup || !prerequisitesPending) && session?.guidance.reasons.length ? <ul className={styles.evidenceList} aria-label="Review blockers">{session.guidance.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul> : null}
            {!complete && step && (!progressiveSetup || !prerequisitesPending) && <details className={styles.reviewDetails} open={!!assessment}><summary>Your physical verification</summary><p className={styles.cameraHelp}>First inspect the setup, perform the suggested action, and take an after-action checkpoint. Then verify each hidden or measured condition yourself.</p>{step.requiredConfirmations.map(check => <label className={styles.confirm} key={check.id}><input type="checkbox" checked={confirmations[check.id] === true} disabled={!assessedImageReady || requiresReconfirmation || !!openRequest || !currentAssessment || !latest || !fresh || locked || watching} onChange={event => setConfirmations(previous => ({ ...previous, [check.id]: event.target.checked }))}/><span>{check.label}</span></label>)}<PhysicalMeasurements definitions={requiredMeasurements} values={measurements} facts={session?.facts || {}} progressive={progressiveSetup} index={measurementIndex} disabled={!assessedImageReady || requiresReconfirmation || !latest || !fresh || locked || watching} onValue={(id, value) => setMeasurements(previous => ({ ...previous, [id]: value }))} onIndex={setMeasurementIndex}/>{requiredMeasurements.length > 0 && !allMeasurements && <p className={styles.cameraHelp}>A missing or out-of-limit reading cannot pass. Record a failed or incomplete attempt if that is what happened.</p>}<label className={styles.field}>What did you physically verify?<textarea required maxLength={3000} disabled={!assessedImageReady || requiresReconfirmation || !latest || !fresh || locked || watching} value={confirmationNotes} onChange={event => setConfirmationNotes(event.target.value)} placeholder="Record the actual inspection, measurement, failed attempt, or intervention."/></label><label className={styles.confirm}><input type="checkbox" checked={recheckConfirmed} disabled={!assessedImageReady || requiresReconfirmation || !currentAssessment || !latest || !fresh || locked || watching} onChange={event => setRecheckConfirmed(event.target.checked)}/><span>I physically checked the readings and conditions recorded here.</span></label><button type="button" className={styles.button} disabled={!recheckConfirmed || !assessedImageReady || requiresReconfirmation || !currentAssessment || !latest || !fresh || locked || watching || !confirmationNotes.trim()} onClick={() => void saveActualRecheck()}>Save actual recheck</button><p className={styles.cameraHelp}>An actual recheck records your observations without advancing the phase or starting analysis. Unknown readings stay unknown.</p><button type="button" className={`${styles.button} ${styles.primary}`} disabled={!canConfirm} onClick={() => void confirmStep()}><Check size={17}/> Confirm reviewed step <ChevronRight size={15}/></button><div className={styles.cameraControls}><button type="button" className={styles.button} disabled={!assessedImageReady || requiresReconfirmation || !latest || session?.status !== "active" || latest.stepId !== session.currentStepId || !fresh || locked || watching || !confirmationNotes.trim()} onClick={() => void recordReview("failed")}>Record failed attempt</button><button type="button" className={styles.button} disabled={!assessedImageReady || requiresReconfirmation || !latest || session?.status !== "active" || latest.stepId !== session.currentStepId || !fresh || locked || watching || !confirmationNotes.trim()} onClick={() => void recordReview("incomplete")}>Record incomplete evidence</button></div></details>}
            {!!session?.completedSteps.length && <button type="button" className={`${styles.button} ${styles.subtle}`} disabled={requiresReconfirmation || locked || watching} onClick={() => void operate(`/api/camera/sessions/${session.id}`, { action: "undo", expectedRevision: session.revision }, "PATCH")}><RotateCcw size={14}/> Reopen previous step</button>}
          </aside></div>
          {!!session?.readingReports?.length && <section className={styles.history} aria-label="Actual recheck history"><h3>Actual rechecks, reported by you.</h3>{[...session.readingReports].reverse().map(report => <details key={report.id}><summary>{report.derivedKnownFailure ? "Known failure recorded" : "Actual recheck recorded"} · {report.criterionSnapshot.title}</summary><p>{report.notes}</p><ul>{Object.entries(report.measurements).map(([key,value]) => { const definition=report.criterionSnapshot.measurements?.find(item=>item.id===key); return <li key={key}>{definition?.label || key.replaceAll("_"," ")}: {value===null ? "not measured" : value}{definition ? ` ${definition.unit} · required ${measurementRequirement(definition,report.facts)}` : ""}</li>; })}</ul><small>{new Date(report.createdAt).toLocaleString()} · Original criteria and facts stay with this report. It does not advance a phase.</small></details>)}</section>}
          {!!session?.evidenceRequests?.length && <section className={styles.history} aria-label="Evidence request history"><h3>Evidence requests and answers.</h3>{[...session.evidenceRequests].reverse().map(request => <details key={request.id}><summary>{request.status === "open" ? "Awaiting answer" : request.status === "answered" ? "Answered" : request.status === "stale" ? "Stale request" : "Cancelled request"} · {request.kind === "request_view" ? "Requested view" : "Requested prerequisite fact"}</summary><p>{request.instruction}</p><p>{request.closeReason || request.whyNeeded}</p>{!!request.answers.length && <ul>{request.answers.map(answer => <li key={answer.id}>{answer.kind === "measurement" ? `${answer.factKey.replaceAll("_", " ")}: ${answer.value}${answer.unit ? ` ${answer.unit}` : ""} · operator-confirmed prerequisite` : "Selected view evidence"} · {answer.status}</li>)}</ul>}<small>{new Date(request.createdAt).toLocaleString()} · Saved {request.sourcePurpose === "before" ? "setup" : "after-action"} request</small></details>)}</section>}
          {(session?.reviews?.length || 0) > 0 && <section className={styles.history} aria-label="Physical review history"><h3>Physical reviews, including failures.</h3>{[...(session?.reviews || [])].reverse().map((review, index) => {
            const originalStep = review.stepSnapshot;
            const historical = !originalStep || !review.checksVersion;
            return <details key={`${review.reviewedAt}-${index}`}><summary>{historical ? "Historical review · earlier checks · " : ""}{review.outcome === "passed" ? "Operator-reviewed pass" : review.outcome === "failed" ? "Failed attempt" : "Incomplete evidence"} · {originalStep?.title || review.stepId.replaceAll("_", " ")}</summary><p>{review.notes}</p>{!originalStep && <p>Original criterion definition not recorded. Saved readings are shown without evaluating them against current checks.</p>}{Object.entries(review.measurements).length > 0 && <ul>{Object.entries(review.measurements).map(([key, value]) => {
              const definition = originalStep?.measurements?.find(item => item.id === key);
              return <li key={key}>{definition?.label || key.replaceAll("_", " ")}: {value === null ? "not measured" : value}{definition ? ` ${definition.unit} · required ${measurementRequirement(definition, review.facts)}` : ""}</li>;
            })}</ul>}<small>{new Date(review.reviewedAt).toLocaleString()} · Original facts and thresholds stay with this review.</small></details>;
          })}</section>}{state.turns.length > 0 && <details className={`${styles.history} ${styles.historyArchive}`}><summary>Checkpoint history ({state.turns.length})</summary>{[...state.turns].reverse().map(turn => <details key={turn.id}><summary>{turn.status === "completed" ? turn.assessment?.summary : turn.status === "pending" ? "Analysis pending" : turn.status === "superseded" ? "Historical check · facts or step changed" : "Check failed"}</summary>{turn.assessment && <HistoricalAssessment assessment={turn.assessment}/>}{turn.error && <p>{turn.error}</p>}<small>{new Date(turn.createdAt).toLocaleString()} · {turn.status}{typeof turn.trace?.latencyMs === "number" ? ` · ${(turn.trace.latencyMs / 1000).toFixed(1)}s model check` : ""}</small></details>)}</details>}
        </> : null}
      </>}
    </div>
  </main>;
}
