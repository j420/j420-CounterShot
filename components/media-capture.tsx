"use client";

import { useId, useRef, useState, type ChangeEvent } from "react";
import { Camera, LoaderCircle, Upload, Video } from "lucide-react";
import { NativeMediaCapture } from "./native-media-capture";

const videoAccept = "video/mp4,video/quicktime,video/webm,video/x-m4v,.mp4,.mov,.m4v,.webm";
const photoAccept = "image/jpeg,image/png,.jpg,.jpeg,.png";
const maxBytes = 50 * 1024 * 1024;

type MediaCaptureProps = {
  label: string;
  existingLabel: string;
  allowPhotos?: boolean;
  disabled: boolean;
  maxClipSeconds: number;
  onFiles: (files: File[]) => Promise<void>;
  onUploadingChange: (uploading: boolean) => void;
};

export function MediaCapture({ label, existingLabel, allowPhotos = false, disabled, maxClipSeconds, onFiles, onUploadingChange }: MediaCaptureProps) {
  const videoInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const existingInput = useRef<HTMLInputElement>(null);
  const uploadInFlight = useRef(false);
  const [uploading, setUploading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [captureMode, setCaptureMode] = useState<"photo" | "video" | null>(null);
  const instructionsId = useId();
  const locked = disabled || uploading;

  async function upload(files: File[]): Promise<boolean> {
    if (!files.length || disabled || uploadInFlight.current) return false;
    setError("");
    setSaved(false);
    if (!allowPhotos && files.length > 1) { setError("Choose one uninterrupted trial recording at a time."); return false; }
    for (const file of files) {
      if (file.size > maxBytes) { setError("Use a file smaller than 50 MiB."); return false; }
      const video = /\.(mp4|mov|m4v|webm)$/i.test(file.name) || ["video/mp4", "video/quicktime", "video/webm", "video/x-m4v"].includes(file.type.split(";")[0].toLowerCase());
      const photo = /\.(jpe?g|png)$/i.test(file.name) || ["image/jpeg", "image/png"].includes(file.type.toLowerCase());
      if (!video && !(allowPhotos && photo)) {
        setError(allowPhotos ? "Choose an MP4, MOV, M4V or WebM video, or a JPEG/PNG photo. For HEIC photos, export JPEG/PNG or use your camera’s compatible format setting." : "Choose an MP4, MOV, M4V or WebM recording. Trial evidence needs video of the uninterrupted cycle.");
        return false;
      }
    }
    uploadInFlight.current = true;
    setUploading(true);
    onUploadingChange(true);
    try { await onFiles(files); setSaved(true); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Upload failed. Please try again."); return false; }
    finally { uploadInFlight.current = false; setUploading(false); onUploadingChange(false); }
  }

  function selected(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files || []);
    event.currentTarget.value = "";
    void upload(files);
  }

  function choose(input: HTMLInputElement | null) {
    if (locked || !input) return;
    setError("");
    input.value = "";
    input.click();
  }

  return <section className="media-capture" aria-label={`${label} media controls`} aria-busy={uploading}
    onDragOver={event => event.preventDefault()}
    onDrop={event => { event.preventDefault(); if (!locked && !captureMode) void upload(Array.from(event.dataTransfer.files)); }}>
    <input ref={videoInput} className="sr-only" type="file" tabIndex={-1} accept={videoAccept} capture="environment" disabled={locked} onChange={selected} aria-label={`Record ${label} video`} aria-describedby={instructionsId}/>
    {allowPhotos && <input ref={photoInput} className="sr-only" type="file" tabIndex={-1} accept={photoAccept} capture="environment" disabled={locked} onChange={selected} aria-label={`Take ${label} photo`} aria-describedby={instructionsId}/>}
    <input ref={existingInput} className="sr-only" type="file" tabIndex={-1} accept={allowPhotos ? `${videoAccept},${photoAccept}` : videoAccept} multiple={allowPhotos} disabled={locked} onChange={selected} aria-label={existingLabel} aria-describedby={instructionsId}/>
    {!captureMode && <div className="media-capture-heading"><strong>{allowPhotos ? "Capture" : "Record the complete trial."}</strong></div>}
    {!captureMode && <div className="media-capture-actions">
      <button type="button" className="button primary" disabled={locked} onClick={() => { setError(""); setCaptureMode("video"); }}><Video size={18}/> Record video</button>
      {allowPhotos && <button type="button" className="button secondary" disabled={locked} onClick={() => { setError(""); setCaptureMode("photo"); }}><Camera size={18}/> Take photo</button>}
      <button type="button" className="button secondary" disabled={locked} onClick={() => choose(existingInput.current)}><Upload size={17}/> Choose existing</button>
    </div>}
    {captureMode && <NativeMediaCapture mode={captureMode} label={label} maxClipSeconds={maxClipSeconds} disabled={locked}
      onUse={file => upload([file])} onClose={() => setCaptureMode(null)}
      onFallback={() => { const input = captureMode === "photo" ? photoInput.current : videoInput.current; setCaptureMode(null); choose(input); }}/>}
    {!captureMode && <><p id={instructionsId} className="media-capture-help">Up to {maxClipSeconds} seconds · 50 MiB per file{allowPhotos ? " · JPEG/PNG photos" : ""}.</p>
    <details className="media-capture-details"><summary>Camera & file help</summary><p className="media-capture-help">Allow camera access over HTTPS. If recording is unavailable, use your device’s Camera app or choose a saved MP4, MOV, M4V or WebM file{allowPhotos ? ", or JPEG/PNG photo" : ""}. Trials need one uninterrupted recording. You can also drop files here.</p></details></>}
    {uploading && <div className="media-upload-status" role="status"><LoaderCircle size={17} className="spin"/> Checking and saving your recording{allowPhotos ? " or photo" : ""}…</div>}
    {saved && !uploading && <p className="media-upload-saved" role="status">{allowPhotos ? "Saved. Ready to analyze." : "Recording saved. Review the outcome below."}</p>}
    {error && <div className="error-banner" role="alert">{error}</div>}
  </section>;
}
