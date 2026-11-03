"use client";

import { useId, useRef, useState, type ChangeEvent } from "react";
import { Camera, LoaderCircle, Upload, Video } from "lucide-react";

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
  const instructionsId = useId();
  const locked = disabled || uploading;

  async function upload(files: File[]) {
    if (!files.length || disabled || uploadInFlight.current) return;
    setError("");
    setSaved(false);
    if (!allowPhotos && files.length > 1) { setError("Choose one uninterrupted trial recording at a time."); return; }
    for (const file of files) {
      if (file.size > maxBytes) { setError("Each file must be 50 MiB or smaller. Use a lower recording resolution, such as 720p, and try again."); return; }
      const video = /\.(mp4|mov|m4v|webm)$/i.test(file.name) || ["video/mp4", "video/quicktime", "video/webm", "video/x-m4v"].includes(file.type.split(";")[0].toLowerCase());
      const photo = /\.(jpe?g|png)$/i.test(file.name) || ["image/jpeg", "image/png"].includes(file.type.toLowerCase());
      if (!video && !(allowPhotos && photo)) {
        setError(allowPhotos ? "Choose an MP4, MOV, M4V or WebM video, or a JPEG/PNG photo. For HEIC photos, export JPEG/PNG or use your camera’s compatible format setting." : "Choose an MP4, MOV, M4V or WebM recording. Trial evidence needs video of the uninterrupted cycle.");
        return;
      }
    }
    uploadInFlight.current = true;
    setUploading(true);
    onUploadingChange(true);
    try { await onFiles(files); setSaved(true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The upload could not be completed. Try choosing the file again."); }
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
    onDrop={event => { event.preventDefault(); if (!locked) void upload(Array.from(event.dataTransfer.files)); }}>
    <input ref={videoInput} className="sr-only" type="file" tabIndex={-1} accept={videoAccept} capture="environment" disabled={locked} onChange={selected} aria-label={`Record ${label} video`} aria-describedby={instructionsId}/>
    {allowPhotos && <input ref={photoInput} className="sr-only" type="file" tabIndex={-1} accept={photoAccept} capture="environment" disabled={locked} onChange={selected} aria-label={`Take ${label} photo`} aria-describedby={instructionsId}/>}
    <input ref={existingInput} className="sr-only" type="file" tabIndex={-1} accept={allowPhotos ? `${videoAccept},${photoAccept}` : videoAccept} multiple={allowPhotos} disabled={locked} onChange={selected} aria-label={existingLabel} aria-describedby={instructionsId}/>
    <div className="media-capture-heading"><strong>{allowPhotos ? "Show the work from your phone." : "Keep the whole trial in one recording."}</strong><span>{allowPhotos ? "Record now, take a checkpoint photo, or choose an existing file." : "Use a mount or have a reviewer film, keeping the work and reset visible."}</span></div>
    <div className="media-capture-actions">
      <button type="button" className="button primary" disabled={locked} onClick={() => choose(videoInput.current)}><Video size={18}/> Record video</button>
      {allowPhotos && <button type="button" className="button secondary" disabled={locked} onClick={() => choose(photoInput.current)}><Camera size={18}/> Take photo</button>}
      <button type="button" className="button secondary" disabled={locked} onClick={() => choose(existingInput.current)}><Upload size={17}/> Choose existing</button>
    </div>
    <p id={instructionsId} className="media-capture-help">Up to {maxClipSeconds} seconds · 50 MiB per file{allowPhotos ? " · JPEG/PNG photos" : ""}.</p>
    <details className="media-capture-details"><summary>File formats & camera help</summary><p className="media-capture-help">Video: MP4, MOV, M4V or WebM. The camera buttons request the rear camera. If it does not open, record with your Camera app and choose the saved file. You can also drop files here.</p></details>
    {uploading && <div className="media-upload-status" role="status"><LoaderCircle size={17} className="spin"/> Checking and saving your recording{allowPhotos ? " or photo" : ""}…</div>}
    {saved && !uploading && <p className="media-upload-saved" role="status">{allowPhotos ? "Upload saved. Next, choose Analyze the job to request the analysis." : "Recording saved. Review the result, then record the outcome below."}</p>}
    {error && <div className="error-banner" role="alert">{error}</div>}
  </section>;
}
