import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { fail } from './http';
import type { MediaNormalization } from './types';

const run = promisify(execFile);
const maxPixels = 7680 * 7680;
export const providerMediaByteLimit = 50 * 1024 * 1024;
export type MediaFormat = { kind: 'image' | 'video'; mime: string; extension: string; container: 'png' | 'jpeg' | 'mp4' | 'quicktime' | 'webm' };
type Stream = { index: number; codec_type?: string; codec_name?: string; pix_fmt?: string; width?: number; height?: number;
  avg_frame_rate?: string; disposition?: { attached_pic?: number }; tags?: { rotate?: string }; side_data_list?: { rotation?: number }[] };
type Probe = { streams?: Stream[]; format?: { duration?: string; format_name?: string } };
type Inspection = { stream: Stream; audio: Stream[]; durationMs: number | null; frames: number; rotation: number; frameDurationMs: number; streamCount: number };

export function sniffMedia(bytes: Buffer): MediaFormat {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return { kind: 'image', mime: 'image/png', extension: '.png', container: 'png' };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return { kind: 'image', mime: 'image/jpeg', extension: '.jpg', container: 'jpeg' };
  if (bytes.toString('ascii', 4, 8) === 'ftyp') {
    const brand = bytes.toString('ascii', 8, 12);
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1', 'avif', 'avis'].includes(brand))
      fail(415, 'HEIC/HEIF photos are not supported yet. Choose a JPEG or PNG copy from your phone.');
    if (brand === 'qt  ') return { kind: 'video', mime: 'video/quicktime', extension: '.mov', container: 'quicktime' };
    return { kind: 'video', mime: brand === 'M4V ' ? 'video/x-m4v' : 'video/mp4', extension: brand === 'M4V ' ? '.m4v' : '.mp4', container: 'mp4' };
  }
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    // WebM's EBML DocType identifies it independently of filename or upload MIME.
    const header = bytes.subarray(0, 4096);
    const docType = header.indexOf(Buffer.from([0x42, 0x82]));
    if (docType >= 0 && header[docType + 2] === 0x84 && header.toString('ascii', docType + 3, docType + 7) === 'webm')
      return { kind: 'video', mime: 'video/webm', extension: '.webm', container: 'webm' };
  }
  fail(415, 'Choose an MP4, MOV, M4V or WebM video, or a JPEG/PNG photo. HEIC photos need a JPEG or PNG copy.');
}

function durationError(maxSeconds: number): never {
  fail(400, `This workflow accepts clips up to ${maxSeconds} seconds. Keep the complete physical trial uninterrupted; use a shorter complete cycle or configure a longer application limit.`);
}

async function inspectMedia(filePath: string, format: MediaFormat, maxSeconds: number): Promise<Inspection> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries',
    'format=duration,format_name:stream=index,codec_type,codec_name,pix_fmt,width,height,avg_frame_rate:stream_disposition=attached_pic:stream_tags=rotate:stream_side_data=rotation', '-of', 'json', filePath,
  ], { timeout: 15_000, maxBuffer: 1_000_000 });
  const info = JSON.parse(stdout) as Probe;
  const names = info.format?.format_name?.split(',') || [];
  const expected = format.container === 'webm' ? names.includes('webm') : format.kind === 'video' ? names.includes('mov')
    : format.container === 'png' ? names.some(name => ['png_pipe', 'apng', 'image2'].includes(name))
      : names.some(name => ['jpeg_pipe', 'mjpeg', 'image2'].includes(name));
  if (!expected) fail(415, 'The media contents do not match a supported video or image container.');
  const streams = info.streams || [];
  const stream = streams.find(candidate => candidate.codec_type === 'video' && candidate.disposition?.attached_pic !== 1);
  if (!stream?.width || !stream.height || !Number.isInteger(stream.index))
    fail(415, 'The file must contain decodable visual media. Audio cover art is not trial video.');
  if (stream.width > 7680 || stream.height > 7680) fail(415, 'Use media at 8K resolution or below.');
  const declaredSeconds = Number(info.format?.duration);
  if (format.kind === 'video' && Number.isFinite(declaredSeconds) && declaredSeconds > 0 && Math.round(declaredSeconds * 1000) > maxSeconds * 1000)
    durationError(maxSeconds);

  // Decode complete real frames; headers, cover art and corrupt images cannot qualify.
  // The extra second detects a misleading declared duration without an unbounded decode.
  const decoded = await run('ffmpeg', ['-v', 'error', '-xerror', '-nostdin', '-threads', '2', '-err_detect', 'explode',
    '-max_pixels', String(maxPixels), '-protocol_whitelist', 'file,pipe', '-i', filePath,
    '-map', `0:${stream.index}`, '-an', '-sn', '-dn', '-vsync', '0',
    ...(format.kind === 'video' ? ['-t', String(maxSeconds + 1)] : ['-frames:v', '1']),
    '-progress', 'pipe:1', '-nostats', '-f', 'null', '-',
  ], { timeout: 30_000, maxBuffer: 1_000_000 });
  const frames = Number([...decoded.stdout.matchAll(/^frame=(\d+)$/gm)].at(-1)?.[1]);
  if (!Number.isSafeInteger(frames) || frames < 1) fail(415, 'The file contains no decodable visual frames.');
  let durationMs: number | null = null;
  if (format.kind === 'video') {
    durationMs = Math.round(Number([...decoded.stdout.matchAll(/^out_time_us=(\d+)$/gm)].at(-1)?.[1]) / 1000);
    if (!Number.isFinite(durationMs) || durationMs <= 0) fail(415, 'Video duration could not be verified from decoded frames.');
    if (durationMs > maxSeconds * 1000) durationError(maxSeconds);
  }
  const rotation = Number(stream.side_data_list?.find(data => Number.isFinite(data.rotation))?.rotation ?? stream.tags?.rotate ?? 0);
  const [numerator, denominator] = (stream.avg_frame_rate || '').split('/').map(Number);
  const fps = numerator / denominator;
  return { stream, audio: streams.filter(candidate => candidate.codec_type === 'audio'), durationMs, frames,
    rotation: Number.isFinite(rotation) ? rotation : 0, frameDurationMs: Number.isFinite(fps) && fps > 0 ? 1000 / fps : 100,
    streamCount: streams.length };
}

export async function prepareMedia(inputPath: string, normalizedPath: string, format: MediaFormat, maxSeconds: number, byteLimit: number) {
  const source = await inspectMedia(inputPath, format, maxSeconds);
  const sourceSize = (await stat(inputPath)).size;
  const compatible = format.kind === 'image' || (format.container === 'mp4' && format.mime === 'video/mp4' && source.stream.codec_name === 'h264'
    && source.stream.pix_fmt === 'yuv420p' && source.rotation % 360 === 0 && source.audio.length <= 1
    && source.audio.every(audio => audio.codec_name === 'aac') && source.streamCount === 1 + source.audio.length && sourceSize <= byteLimit);
  if (compatible) return { normalized: false as const, durationMs: source.durationMs, mime: format.mime, extension: format.extension };

  // Preserve timestamps, all video frames, orientation and the first audio track.
  // A bounded H.264/AAC copy makes native phone footage playable and provider-compatible.
  // The uploaded original remains separate and byte-exact for evidence provenance.
  const durationSeconds = source.durationMs! / 1000;
  const audioBitrate = source.audio.length ? 128_000 : 0;
  const videoBitrate = Math.max(128_000, Math.min(8_000_000, Math.floor(byteLimit * 8 * 0.9 / durationSeconds) - audioBitrate));
  await run('ffmpeg', ['-v', 'error', '-xerror', '-nostdin', '-threads', '2', '-err_detect', 'explode', '-max_pixels', String(maxPixels),
    '-protocol_whitelist', 'file,pipe', '-i', inputPath, '-map', `0:${source.stream.index}`, '-map', '0:a:0?', '-sn', '-dn',
    '-map_metadata', '-1', '-metadata:s:v:0', 'rotate=0', '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
    '-c:v', 'libx264', '-preset', 'veryfast', '-threads', '2', '-pix_fmt', 'yuv420p', '-b:v', String(videoBitrate), '-maxrate', String(videoBitrate), '-bufsize', String(videoBitrate * 2),
    '-vsync', '0', '-c:a', 'aac', '-b:a', '128k', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart',
    '-fs', String(byteLimit + 1), '-f', 'mp4', normalizedPath,
  ], { timeout: 90_000, maxBuffer: 1_000_000 });
  const normalizedSize = (await stat(normalizedPath)).size;
  if (normalizedSize > byteLimit) fail(413, 'The playable video copy exceeds the upload size limit. Use a shorter complete recording or a lower camera resolution.');
  const output = await inspectMedia(normalizedPath, { kind: 'video', mime: 'video/mp4', extension: '.mp4', container: 'mp4' }, maxSeconds);
  if (output.frames !== source.frames || Math.abs(output.durationMs! - source.durationMs!) > Math.max(100, source.frameDurationMs + 5))
    fail(415, 'A complete video copy could not be preserved. Try recording with the phone’s standard video setting.');
  if (source.audio.length && !output.audio.length) fail(415, 'The recording audio could not be preserved.');
  const normalization: MediaNormalization = { version: 'phone-mp4-v1', method: 'transcoded', sourceDurationMs: source.durationMs!, durationMs: output.durationMs!,
    sourceVideoCodec: source.stream.codec_name || 'unknown', sourceAudioCodec: source.audio[0]?.codec_name || null,
    videoCodec: 'h264', pixelFormat: 'yuv420p', audioCodec: output.audio.length ? 'aac' : null,
    rotationAppliedDegrees: source.rotation, widthPx: output.stream.width!, heightPx: output.stream.height!, videoBitrate };
  return { normalized: true as const, durationMs: output.durationMs, mime: 'video/mp4', extension: '.mp4', normalization };
}

export async function mediaFileHash(filePath: string) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest('hex');
}
