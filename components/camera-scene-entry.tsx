"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { ArrowRight, Camera, CircleAlert, ImagePlus, LoaderCircle, RefreshCw, ScanLine, StopCircle } from "lucide-react";
import { cameraWorkflow } from "../src/camera/workflows";
import { CAMERA_INTAKE_LIMITS, type CameraIntakeResponse, type PublicCameraIntake } from "../src/camera/intake-contract";
import type { CameraCapture, CameraFeed } from "./use-camera-feed";
import styles from "./camera-workbench.module.css";

type Props = {
  camera: CameraFeed;
  meta: { configured: boolean; model: string } | null;
  locked: boolean;
  available: boolean;
  onAdopt: (intake: PublicCameraIntake) => Promise<void>;
  onManual: () => void;
};

export default function CameraSceneEntry({ camera, meta, locked, available, onAdopt, onManual }: Props) {
  const [goal, setGoal] = useState("");
  const [context, setContext] = useState("");
  const [selectedPhoto, setSelectedPhoto] = useState<CameraCapture | null>(null);
  const [photoUnanalysed, setPhotoUnanalysed] = useState(false);
  const [intake, setIntake] = useState<PublicCameraIntake | null>(null);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [retaking, setRetaking] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [error, setError] = useState("");
  const [loadedFrame, setLoadedFrame] = useState<string | null>(null);
  const mounted = useRef(true);
  const autoStarted = useRef(false);
  const operation = useRef<string | null>(null);
  const attemptedRevision = useRef<number | null>(null);
  const requestSequence = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const photoSequence = useRef(0);
  const result = intake?.result;
  const proposedWorkflow = result?.workflowId ? cameraWorkflow(result.workflowId) : null;
  const pending = intake?.status === "pending";
  const reviewing = !!intake?.frame && !retaking && !photoUnanalysed;
  const blocked = busy || reading || locked || pending || uncertain || needsRefresh;
  const attemptsUsed = intake?.executionBudget.invocations.length ?? 0;
  const exhausted = attemptsUsed >= CAMERA_INTAKE_LIMITS.maxAttempts;
  const terminal = intake?.status === "cancelled" || intake?.status === "adopted";
  const analysedInputsMatch = !!intake && goal.trim() === intake.goal && context.trim() === intake.context && !photoUnanalysed;
  const canAdopt = !blocked && !retaking && intake?.status === "completed" && result?.frameQuality === "clear" && !result.viewRequest
    && !!proposedWorkflow && analysedInputsMatch && loadedFrame === intake.frame?.id;
  const canResumeSaved = !blocked && intake?.status === "adopted" && !!intake.adoptedSessionId;

  function apply(response: CameraIntakeResponse, sequence: number, recovered = false, unresolved = false) {
    if (!mounted.current || sequence !== requestSequence.current) return;
    setIntake(response.intake); setUncertain(unresolved); setNeedsRefresh(false); setRetaking(false);
    if (recovered && !unresolved) { setGoal(response.intake.goal); setContext(response.intake.context); }
    if (!unresolved) {
      operation.current = null; attemptedRevision.current = null;
      window.history.replaceState({}, "", `/camera?intake=${encodeURIComponent(response.intake.id)}`);
    }
  }

  async function refreshSaved(initial?: { id?: string; operationId?: string }) {
    if (busy && !initial) return;
    const id = initial?.id || intake?.id;
    const operationId = initial?.operationId || operation.current;
    if (!id && !operationId) return;
    const sequence = ++requestSequence.current;
    setBusy(true); setError("");
    try {
      let response = await fetch(operationId ? `/api/camera/intakes?operationId=${encodeURIComponent(operationId)}`
        : `/api/camera/intakes/${encodeURIComponent(id!)}`, { cache: "no-store" });
      let body = await response.json();
      let unresolved = false;
      if (response.status === 404 && operationId && id) {
        response = await fetch(`/api/camera/intakes/${encodeURIComponent(id)}`, { cache: "no-store" });
        body = await response.json();
        // An unchanged old record does not prove that an uncertain POST cannot arrive late.
        unresolved = attemptedRevision.current !== null && body.intake?.revision <= attemptedRevision.current;
      }
      if (!response.ok) throw new Error(body.error || "The saved scene analysis is not available yet. Refresh again; no analysis was repeated.");
      apply(body as CameraIntakeResponse, sequence, true, unresolved);
    } catch (cause) {
      if (mounted.current && sequence === requestSequence.current) {
        setError((cause as Error).message); setUncertain(true);
      }
    } finally { if (mounted.current && sequence === requestSequence.current) setBusy(false); }
  }

  useEffect(() => {
    mounted.current = true;
    const query = new URLSearchParams(window.location.search);
    const saved = query.get("intake"), savedOperation = query.get("intakeOperation"), revision = query.get("intakeRevision");
    const savedId = saved && /^[a-zA-Z0-9-]{1,100}$/.test(saved) ? saved : undefined;
    if (available && savedOperation && /^[a-zA-Z0-9-]{1,100}$/.test(savedOperation)) {
      operation.current = savedOperation;
      attemptedRevision.current = revision && /^\d{1,9}$/.test(revision) ? Number(revision) : null;
      setUncertain(true); void refreshSaved({ ...(savedId ? { id: savedId } : {}), operationId: savedOperation });
    } else if (available && savedId) void refreshSaved({ id: savedId });
    return () => { mounted.current = false; requestSequence.current++; photoSequence.current++; };
    // Recovery happens once on entry. Refresh never requests another model response.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled || autoStarted.current || document.visibilityState !== "visible") return;
      autoStarted.current = true;
      void camera.start();
    });
    return () => { cancelled = true; };
  }, [camera.start]);

  async function analyse() {
    if (blocked || exhausted || terminal || !available || !meta?.configured || !goal.trim()) return;
    const sequence = ++requestSequence.current;
    let paidIntentSent = false;
    setBusy(true); setError("");
    try {
      const capture = selectedPhoto || camera.capture();
      const bytes = Uint8Array.from(atob(capture.dataUrl.split(",", 2)[1]), character => character.charCodeAt(0));
      const operationId = crypto.randomUUID(); operation.current = operationId;
      attemptedRevision.current = intake?.revision ?? null;
      const form = new FormData();
      form.set("file", new File([bytes], "scene-checkpoint.jpg", { type: "image/jpeg" }));
      form.set("goal", goal.trim()); form.set("context", context.trim()); form.set("source", capture.source);
      form.set("capturedAt", capture.capturedAt || ""); form.set("operationId", operationId);
      if (intake) { form.set("intakeId", intake.id); form.set("expectedRevision", String(intake.revision)); }
      const recovery = new URLSearchParams({ intakeOperation: operationId });
      if (intake) { recovery.set("intake", intake.id); recovery.set("intakeRevision", String(intake.revision)); }
      window.history.replaceState({}, "", `/camera?${recovery}`);
      paidIntentSent = true;
      const response = await fetch("/api/camera/intakes", { method: "POST", body: form });
      const body = await response.json();
      if (!mounted.current || sequence !== requestSequence.current) return;
      if (body.intake) { apply(body as CameraIntakeResponse, sequence); setPhotoUnanalysed(false); }
      if (!response.ok) {
        const definiteRejection = response.status >= 400 && response.status < 500 && response.status !== 408;
        if (!body.intake && !definiteRejection) setUncertain(true);
        if (!body.intake && definiteRejection) {
          operation.current = null; attemptedRevision.current = null; setUncertain(false);
          setNeedsRefresh(response.status === 409 && !!intake);
          window.history.replaceState({}, "", intake ? `/camera?intake=${encodeURIComponent(intake.id)}` : "/camera");
        }
        throw new Error(body.error || "The scene analysis could not complete.");
      }
    } catch (cause) {
      if (mounted.current && sequence === requestSequence.current) {
        setError((cause as Error).message);
        if (paidIntentSent && operation.current) setUncertain(true);
      }
    } finally { if (mounted.current && sequence === requestSequence.current) setBusy(false); }
  }

  async function cancelSaved() {
    if (!intake || intake.status !== "pending" || busy || locked) return;
    const sequence = ++requestSequence.current;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/camera/intakes/${encodeURIComponent(intake.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel", expectedRevision: intake.revision }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "The saved analysis could not be cancelled. Refresh its saved record.");
      apply(body as CameraIntakeResponse, sequence);
    } catch (cause) {
      if (mounted.current && sequence === requestSequence.current) { setError((cause as Error).message); setUncertain(true); }
    } finally { if (mounted.current && sequence === requestSequence.current) setBusy(false); }
  }

  async function choosePhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
    if (!file || blocked) return;
    const sequence = ++photoSequence.current;
    camera.stop(); setReading(true); setError(""); setRetaking(!!intake?.frame); setLoadedFrame(null);
    try {
      const capture = await camera.readUpload(file);
      if (mounted.current && sequence === photoSequence.current) { setSelectedPhoto(capture); setPhotoUnanalysed(true); setRetaking(true); }
    } catch (cause) { if (mounted.current && sequence === photoSequence.current) setError((cause as Error).message); }
    finally { if (mounted.current && sequence === photoSequence.current) setReading(false); }
  }

  function resumeCamera() { photoSequence.current++; setReading(false); setRetaking(!!intake?.frame); setLoadedFrame(null); setSelectedPhoto(null); setPhotoUnanalysed(false); void camera.start(); }

  const goalFields = <>
    <label className={styles.field}>What would you like to do?<textarea rows={2} maxLength={CAMERA_INTAKE_LIMITS.goalCharacters} disabled={blocked} value={goal} onChange={event => setGoal(event.target.value)} placeholder="Tell me what you want to make or fix."/></label>
    <details className={styles.supportingDetails}><summary>Add context (optional)</summary><label className={styles.field}>Constraints or context<textarea rows={2} maxLength={CAMERA_INTAKE_LIMITS.contextCharacters} disabled={blocked} value={context} onChange={event => setContext(event.target.value)} placeholder="A constraint, reference or tool."/></label></details>
  </>;

  return <section className={styles.sceneEntry} aria-label="Start from the camera">
    <div className={styles.sceneHeading}><h1>Show the setup.</h1></div>
    <div className={styles.workspace}>
      <section className={styles.cameraColumn} aria-label="Scene camera">
        <div className={styles.cameraStage}>
          <video ref={camera.attachVideo} className={styles.liveVideo} autoPlay playsInline muted style={{ display: camera.active && !selectedPhoto && !reviewing ? "block" : "none" }} aria-label="Local camera preview"/>
          {reviewing && intake?.frame ? <><div className={`${styles.frameCanvas} ${styles.stageReview}`} aria-label="Analysed scene snapshot"><img key={intake.frame.id} src={intake.frame.url} alt="Exact photo used to understand the scene" onLoad={() => setLoadedFrame(intake.frame!.id)} onError={() => setLoadedFrame(value => value === intake.frame!.id ? null : value)}/></div><span className={styles.cameraStatus}>Analysed photo</span></> : selectedPhoto ? <><img className={styles.frozenImage} src={selectedPhoto.dataUrl} alt="Selected scene photo, not yet sent for analysis"/><span className={styles.cameraStatus}>Selected photo</span></>
            : camera.active ? <span className={styles.cameraStatus}><i/> Preview · on device</span>
            : <div className={styles.cameraEmpty}><Camera size={37}/><h3>{camera.starting ? "Opening camera…" : "Show your workspace."}</h3><button type="button" className={`${styles.button} ${styles.primary}`} onClick={resumeCamera} disabled={camera.starting}>{camera.starting ? <LoaderCircle className={styles.busy} size={17}/> : <Camera size={17}/>} {camera.starting ? "Opening camera…" : "Start camera"}</button></div>}
        </div>
        <div className={styles.cameraControls}>
          {camera.active || camera.starting ? <button type="button" className={styles.button} onClick={camera.stop}><StopCircle size={16}/>{camera.starting ? "Cancel camera request" : "Stop camera"}</button>
            : selectedPhoto && <button type="button" className={styles.button} onClick={resumeCamera}><Camera size={16}/> Use camera instead</button>}
          {reviewing ? <button type="button" className={styles.button} disabled={blocked || terminal || exhausted} onClick={resumeCamera}><RefreshCw size={16}/> Retake view</button> : <button type="button" className={styles.button} disabled={blocked} onClick={() => fileInput.current?.click()}><ImagePlus size={16}/>{selectedPhoto ? "Choose another scene photo" : "Choose a scene photo"}</button>}
          <input ref={fileInput} className={styles.hidden} type="file" accept="image/jpeg,image/png" aria-label="Choose scene photo" disabled={blocked} onChange={event => void choosePhoto(event)}/>
        </div>
        <p className={styles.cameraHelp}>{reviewing ? "Review this photo before continuing. Camera stays local." : "Preview stays local. Understand sends one photo to Meta."}</p>
        {camera.error && <div className={`${styles.notice} ${styles.error}`} role="alert">{camera.error}</div>}
      </section>
      <section className={styles.coach} aria-label="Scene understanding">
        {result ? <details className={styles.supportingDetails}><summary>Goal &amp; context</summary>{goalFields}</details> : goalFields}
        {error && <div className={`${styles.notice} ${styles.error}`} role="alert"><CircleAlert size={16}/> {error}</div>}
        {busy || pending ? <p className={styles.notice} role="status"><LoaderCircle size={16} className={styles.busy}/> {pending ? "Analysis pending. Refresh to check." : "Understanding this view…"}</p> : null}
        {!meta?.configured && <p className={styles.notice}>Meta is unavailable. You can use manual setup.</p>}
        {!available && <p className={styles.notice} role="status">Scene understanding is being updated. Try again shortly, or use manual setup.</p>}
        {uncertain && <p className={styles.notice} role="status">The analysis result is uncertain. Refresh before sending another photo.</p>}
        {needsRefresh && <p className={styles.notice} role="status">This scene changed in another request. Refresh to continue.</p>}
        {exhausted && <p className={styles.notice} role="status">Scene-analysis limit reached. Use the saved result or manual setup.</p>}

        {result && <section className={styles.sceneResult} aria-label="Scene analysis result"><h2>{proposedWorkflow ? proposedWorkflow.title : result.frameQuality === "clear" ? "No supported workflow matches this scene." : "This scene needs another look."}</h2><p>{result.summary}</p>
          {result.viewRequest && <div className={styles.notice}><strong>Show another view</strong><p>{result.viewRequest.instruction}</p></div>}
          {proposedWorkflow && !analysedInputsMatch && <p className={styles.notice}>Your input changed. Understand the new view before continuing.</p>}
        </section>}
        <div className={`${styles.cameraControls} ${styles.sceneSubmit}`}>
          {proposedWorkflow && intake?.status !== "adopted" && <button type="button" className={`${styles.button} ${styles.primary}`} disabled={!canAdopt} onClick={() => intake && void onAdopt(intake)}>Use this workflow <ArrowRight size={16}/></button>}
          {intake?.status === "adopted" && intake.adoptedSessionId && <button type="button" className={`${styles.button} ${styles.primary}`} disabled={!canResumeSaved} onClick={() => void onAdopt(intake)}>Continue saved workflow <ArrowRight size={16}/></button>}
          {!terminal && !reviewing && <button type="button" className={`${styles.button} ${!proposedWorkflow ? styles.primary : ""}`} onClick={() => void analyse()} disabled={blocked || exhausted || !available || !meta?.configured || !goal.trim() || (!camera.active && !selectedPhoto)}><ScanLine size={17}/>{busy ? "Understanding view…" : intake ? "Understand a new view" : "Understand this view"}</button>}
          {(uncertain || pending || needsRefresh) && <button type="button" className={styles.button} disabled={busy || locked || reading} onClick={() => void refreshSaved()}><RefreshCw size={15}/> Refresh saved analysis</button>}
          {pending && <button type="button" className={styles.button} disabled={busy || locked || reading} onClick={() => void cancelSaved()}>Cancel saved analysis</button>}
        </div>
        {intake?.status === "cancelled" && <p className={styles.notice} role="status">Analysis cancelled. Late responses cannot become guidance.</p>}
        {intake?.error && <p className={styles.notice}>{intake.error}</p>}
        {intake && <details className={styles.supportingDetails}><summary>Scene details</summary><p>{result?.workflowReason}</p>{result?.viewRequest && <p>{result.viewRequest.whyNeeded}</p>}
          {!!result?.observations.length && <><strong>Visible details</strong><ul>{result.observations.map(observation => <li key={observation.id}><b>{observation.label}.</b> {observation.detail}</li>)}</ul></>}
          {!!result?.unknowns.length && <><strong>Still unknown</strong><ul>{result.unknowns.map(unknown => <li key={unknown}>{unknown}</li>)}</ul></>}
          <p>Visual details are drafts for you to confirm. Measurements and hidden conditions need your checks.</p><p>{attemptsUsed} of {CAMERA_INTAKE_LIMITS.maxAttempts} scene analyses used. Retakes share the workflow allowance.</p><p>Uploads have no verified capture time. This image is context, not a completed physical check.</p>
          {!(uncertain || pending || needsRefresh) && <button type="button" className={styles.button} disabled={busy || locked || reading} onClick={() => void refreshSaved()}><RefreshCw size={15}/> Refresh saved analysis</button>}
        </details>}
        <details className={styles.supportingDetails}><summary>Choose a different starting point</summary><button type="button" className={`${styles.button} ${styles.subtle}`} disabled={busy || reading || locked || pending} onClick={onManual}>Choose workflow manually <ArrowRight size={15}/></button></details>
      </section>
    </div>
  </section>;
}
