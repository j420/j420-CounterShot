"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, Circle, LoaderCircle, RotateCcw, Square, X } from "lucide-react";
import styles from "./native-media-capture.module.css";

type Props = {
  mode: "photo" | "video";
  label: string;
  maxClipSeconds: number;
  disabled: boolean;
  onUse: (file: File) => Promise<boolean>;
  onClose: () => void;
  onFallback: () => void;
};
type Phase = "opening" | "preview" | "recording" | "processing" | "review" | "error";
const maxBytes = 50 * 1024 * 1024;

function recordingType() {
  if (typeof MediaRecorder === "undefined") return null;
  return ["video/mp4", "video/webm;codecs=vp8", "video/webm"].find(type => MediaRecorder.isTypeSupported(type)) || null;
}

/** Captures stay local until the operator explicitly chooses Use photo/video. */
export function NativeMediaCapture({ mode, label, maxClipSeconds, disabled, onUse, onClose, onFallback }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const recording = useRef<{ discard: boolean; generation: number } | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const mounted = useRef(false);
  const generation = useRef(0);
  const pending = useRef(false);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const reviewUrl = useRef<string | null>(null);
  const [phase, setPhase] = useState<Phase>("opening");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");

  const clearTimers = useCallback(() => {
    for (const timer of timers.current) { clearTimeout(timer); clearInterval(timer); }
    timers.current = [];
  }, []);
  const stopStream = useCallback(() => {
    clearTimers();
    const current = stream.current; stream.current = null;
    current?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    if (video.current) video.current.srcObject = null;
  }, [clearTimers]);
  const discard = useCallback(() => {
    generation.current++;
    pending.current = false;
    if (recording.current) recording.current.discard = true;
    const current = recorder.current; recorder.current = null;
    if (current && current.state !== "inactive") { try { current.stop(); } catch { /* Already stopped by the device. */ } }
    stopStream();
  }, [stopStream]);
  const clearReview = useCallback(() => {
    if (reviewUrl.current) URL.revokeObjectURL(reviewUrl.current);
    reviewUrl.current = null; setFile(null); setUrl("");
  }, []);
  const fail = useCallback((message: string) => {
    discard();
    if (mounted.current) { setError(message); setPhase("error"); }
  }, [discard]);
  const start = useCallback(async () => {
    discard(); clearReview();
    const attempt = generation.current;
    setError(""); setNote(""); setElapsed(0); setPhase("opening");
    if (document.visibilityState !== "visible" || disabledRef.current) { fail("Camera paused. Try again when you’re ready."); return; }
    if (!navigator.mediaDevices?.getUserMedia) { fail("Camera unavailable. Use your device camera or choose a file."); return; }
    try {
      pending.current = true;
      const opened = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
        facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 },
      } });
      if (!mounted.current || generation.current !== attempt) { opened.getTracks().forEach(track => track.stop()); return; }
      pending.current = false;
      if (disabledRef.current || document.visibilityState !== "visible") { opened.getTracks().forEach(track => track.stop()); fail("Camera paused. Try again when you’re ready."); return; }
      stream.current = opened;
      opened.getVideoTracks().forEach(track => { track.onended = () => fail("Camera disconnected. Please capture again."); });
      if (!video.current) { fail("Camera preview unavailable. Please try again."); return; }
      video.current.srcObject = opened;
      await video.current.play();
      if (!mounted.current || generation.current !== attempt) return;
      if (mode === "video" && !recordingType()) { fail("This browser cannot record video here. Use your device camera or choose a recording."); return; }
      setPhase("preview");
    } catch (cause) {
      if (!mounted.current || generation.current !== attempt) return;
      fail(cause instanceof DOMException && cause.name === "NotAllowedError"
        ? "Camera permission is off. Allow it in your browser or use your device camera."
        : "Camera could not open. Try again or choose a saved file.");
    }
  }, [clearReview, discard, fail, mode]);

  useEffect(() => {
    mounted.current = true; void start();
    const hidden = () => { if (document.visibilityState === "hidden" && (stream.current || pending.current)) fail("Camera paused. Capture again when you’re ready."); };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      mounted.current = false; discard();
      if (reviewUrl.current) URL.revokeObjectURL(reviewUrl.current);
      reviewUrl.current = null;
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [discard, fail, start]);
  useEffect(() => { if (disabled && (stream.current || pending.current)) fail("Camera paused while the project is busy. Please try again."); }, [disabled, fail]);

  function review(captured: File, attempt: number) {
    if (!mounted.current || attempt !== generation.current) return;
    if (!captured.size || captured.size > maxBytes) { fail("Capture could not be saved within the file limit. Please try a shorter recording."); return; }
    stopStream();
    if (reviewUrl.current) URL.revokeObjectURL(reviewUrl.current);
    const nextUrl = URL.createObjectURL(captured); reviewUrl.current = nextUrl;
    setFile(captured); setUrl(nextUrl); setPhase("review");
  }
  async function takePhoto() {
    if (phase !== "preview" || disabled || !video.current) return;
    const source = video.current, attempt = generation.current;
    if (source.readyState < 2 || !source.videoWidth || !source.videoHeight) { setError("Wait for the camera view, then try again."); return; }
    setPhase("processing"); setError("");
    const scale = Math.min(1, 1600 / Math.max(source.videoWidth, source.videoHeight));
    const canvas = document.createElement("canvas"); canvas.width = Math.round(source.videoWidth * scale); canvas.height = Math.round(source.videoHeight * scale);
    const context = canvas.getContext("2d");
    if (!context) { fail("This browser could not capture a photo. Use your device camera instead."); return; }
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    try {
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", 0.9));
      if (!mounted.current || attempt !== generation.current) return;
      if (!blob) { fail("Photo capture failed. Please try again."); return; }
      review(new File([blob], `camera-${Date.now()}.jpg`, { type: "image/jpeg" }), attempt);
    } catch { if (mounted.current && attempt === generation.current) fail("Photo capture failed. Please try again."); }
  }
  function stopRecording() {
    const current = recorder.current;
    if (!current || current.state !== "recording") return;
    clearTimers(); setPhase("processing");
    try { current.stop(); } catch { fail("Recording was interrupted. Please capture again."); }
  }
  function recordVideo() {
    const type = recordingType(), opened = stream.current;
    if (phase !== "preview" || disabled || !opened || !type) return;
    const attempt = generation.current, state = { discard: false, generation: attempt };
    recording.current = state;
    const chunks: Blob[] = []; let bytes = 0;
    setError(""); setNote(""); setElapsed(0);
    try {
      const current = new MediaRecorder(opened, { mimeType: type, videoBitsPerSecond: 2_000_000 }); recorder.current = current;
      current.ondataavailable = event => {
        if (state.discard || generation.current !== attempt || !event.data.size) return;
        bytes += event.data.size;
        if (bytes > maxBytes) { fail("Recording exceeded 50 MiB. Please record a shorter clip."); return; }
        chunks.push(event.data);
        if (bytes >= 48 * 1024 * 1024 && current.state === "recording") { setNote("Stopped at the file limit."); stopRecording(); }
      };
      current.onerror = () => { if (!state.discard && generation.current === attempt) fail("Recording was interrupted. Please capture again."); };
      current.onstop = () => {
        if (!mounted.current || state.discard || generation.current !== attempt) return;
        state.discard = true;
        const mime = current.mimeType.split(";")[0].toLowerCase();
        if (!["video/mp4", "video/webm"].includes(mime)) { fail("This recording format is unavailable. Use your device camera instead."); return; }
        review(new File(chunks, `camera-${Date.now()}.${mime === "video/mp4" ? "mp4" : "webm"}`, { type: current.mimeType }), attempt);
      };
      current.start(250); setPhase("recording");
      const began = performance.now();
      timers.current.push(setInterval(() => setElapsed(Math.floor((performance.now() - began) / 1000)), 250));
      // Stop before the decoded-duration ceiling; the server still validates the actual clip.
      timers.current.push(setTimeout(() => { setNote("Stopped at the recording limit."); stopRecording(); }, Math.max(500, (maxClipSeconds - 0.75) * 1000)));
    } catch { fail("Video recording is unavailable here. Use your device camera or choose a recording."); }
  }

  const working = phase === "opening" || phase === "processing";
  return <section className={styles.capture} aria-label={`${label} camera`}>
    <div className={styles.header}><strong>{phase === "review" ? "Keep this capture?" : mode === "photo" ? "Photo" : "Video"}</strong><button type="button" className="button secondary" aria-label="Close camera" onClick={() => { discard(); onClose(); }} disabled={disabled}><X size={17}/></button></div>
    <div className={styles.view}>
      <video ref={video} className={phase === "review" || phase === "error" ? styles.hidden : ""} playsInline muted autoPlay aria-label="Live camera preview"/>
      {phase === "review" && (mode === "photo" ? <img src={url} alt="Photo to review before saving"/> : <video src={url} playsInline controls aria-label="Recording to review before saving"/>)}
      {working && <span className={styles.overlay} role="status"><LoaderCircle className="spin" size={22}/>{phase === "opening" ? "Opening camera…" : "Preparing capture…"}</span>}
      {phase === "recording" && <span className={styles.recording} role="status"><Circle size={10} fill="currentColor"/> Recording · {elapsed}s</span>}
      {phase === "error" && <p className={styles.cameraError} role="alert">{error}</p>}
    </div>
    {error && phase !== "error" && <p className="error-banner" role="alert">{error}</p>}
    <div className={styles.actions}>
      {phase === "preview" && <button type="button" className="button primary" disabled={disabled} onClick={() => mode === "photo" ? void takePhoto() : recordVideo()}>{mode === "photo" ? <Camera size={18}/> : <Circle size={17}/>} {mode === "photo" ? "Capture photo" : "Start recording"}</button>}
      {phase === "recording" && <button type="button" className="button primary" onClick={stopRecording}><Square size={17} fill="currentColor"/> Stop recording</button>}
      {phase === "review" && <><button type="button" className="button primary" disabled={disabled || !file} onClick={async () => { if (file && await onUse(file)) onClose(); }}>Use {mode}</button><button type="button" className="button secondary" disabled={disabled} onClick={() => void start()}><RotateCcw size={16}/> Retake</button></>}
      {phase === "error" && <><button type="button" className="button secondary" disabled={disabled} onClick={() => void start()}>Try camera again</button><button type="button" className="button secondary" disabled={disabled} onClick={() => { discard(); onFallback(); }}>Use device camera</button></>}
    </div>
    <p className={styles.caption}>{note || (phase === "review" ? "Saved only when you choose Use. Analysis is a separate action." : mode === "video" ? `Local preview · up to ${maxClipSeconds}s · no audio` : "Local preview · nothing uploaded yet")}</p>
  </section>;
}
