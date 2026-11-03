"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type CameraCapture = {
  dataUrl: string;
  width: number;
  height: number;
  source: "camera" | "upload";
  capturedAt: string | null;
  submittedAt: string;
};

/** Preview remains local. This hook never performs a network request. */
export function useCameraFeed() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const generation = useRef(0);
  const pending = useRef<number | null>(null);
  const mounted = useRef(true);
  const videoGeneration = useRef(0);
  const [active, setActive] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  const stop = useCallback(() => {
    generation.current++;
    pending.current = null;
    const stream = streamRef.current;
    streamRef.current = null;
    for (const track of stream?.getTracks() || []) track.stop();
    if (videoRef.current) videoRef.current.srcObject = null;
    if (mounted.current) { setActive(false); setStarting(false); }
  }, []);

  /** A scene can become a workflow without losing its already-authorized camera stream. */
  const attachVideo = useCallback((video: HTMLVideoElement | null) => {
    const attachment = ++videoGeneration.current;
    videoRef.current = video;
    const stream = streamRef.current;
    if (!video || !stream) return;
    if (video.srcObject !== stream) video.srcObject = stream;
    void video.play().catch(() => {
      if (videoGeneration.current !== attachment || videoRef.current !== video || streamRef.current !== stream) return;
      stop();
      if (mounted.current) setError("The preview could not resume. Start the camera again or choose a photo.");
    });
  }, [stop]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; stop(); };
  }, [stop]);

  const start = useCallback(async () => {
    if (pending.current !== null || streamRef.current) return;
    setError("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Camera preview needs a supported browser and HTTPS. You can choose a JPEG or PNG checkpoint instead.");
      return;
    }
    const attempt = ++generation.current;
    pending.current = attempt;
    setStarting(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false });
      if (!mounted.current || generation.current !== attempt) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      streamRef.current = stream;
      for (const track of stream.getTracks()) track.addEventListener("ended", () => { if (streamRef.current === stream) stop(); }, { once: true });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      if (mounted.current && generation.current === attempt) setActive(true);
    } catch (cause) {
      if (!mounted.current || generation.current !== attempt) return;
      for (const track of streamRef.current?.getTracks() || []) track.stop();
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      const name = cause instanceof DOMException ? cause.name : "";
      setError(name === "NotAllowedError" ? "Camera permission was not granted. Enable it in your browser or choose a checkpoint photo." : "The camera could not start. Close another camera app, try again, or choose a checkpoint photo.");
      setActive(false);
    } finally {
      if (pending.current === attempt) {
        pending.current = null;
        if (mounted.current) setStarting(false);
      }
    }
  }, [stop]);

  const capture = useCallback((): CameraCapture => {
    const video = videoRef.current;
    if (!streamRef.current || !video || video.readyState < 2 || !video.videoWidth || !video.videoHeight)
      throw new Error("Wait for a clear camera preview before taking a checkpoint.");
    const at = new Date().toISOString();
    return { ...jpegFrame(video, video.videoWidth, video.videoHeight), source: "camera", capturedAt: at, submittedAt: at };
  }, []);

  const readUpload = useCallback(async (file: File): Promise<CameraCapture> => {
    if (!file.size || file.size > 12 * 1024 * 1024) throw new Error("Choose a non-empty JPEG or PNG image up to 12 MiB.");
    if (!["image/jpeg", "image/png"].includes(file.type) && !/\.(jpe?g|png)$/i.test(file.name)) throw new Error("Choose a JPEG or PNG checkpoint photo. Export HEIC photos as JPEG first.");
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      if (!image.naturalWidth || !image.naturalHeight) throw new Error("This photo has no usable image data.");
      return { ...jpegFrame(image, image.naturalWidth, image.naturalHeight), source: "upload", capturedAt: null, submittedAt: new Date().toISOString() };
    } catch (cause) {
      if (cause instanceof Error && cause.message.includes("usable image")) throw cause;
      throw new Error("This photo could not be opened. Choose a standard JPEG or PNG.");
    } finally { URL.revokeObjectURL(url); }
  }, []);

  return { videoRef, attachVideo, active, starting, error, clearError: () => setError(""), start, stop, capture, readUpload };
}

export type CameraFeed = ReturnType<typeof useCameraFeed>;

/** A small frame budget keeps deliberate checks viable over a phone connection. */
function jpegFrame(source: CanvasImageSource, width: number, height: number) {
  const canvas = document.createElement("canvas");
  let scale = Math.min(1, 960 / Math.max(width, height));
  for (let attempt = 0; attempt < 4; attempt++) {
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot prepare a camera checkpoint. Try another browser.");
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", .76);
    if (dataUrl.length <= 300 * 1024) return { dataUrl, width: canvas.width, height: canvas.height };
    scale *= .75;
  }
  throw new Error("The checkpoint is too detailed to send. Move closer to the relevant part and try again.");
}
