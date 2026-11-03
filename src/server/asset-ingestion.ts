import type { NextRequest } from 'next/server';
import { writeFile, rename, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { fail, HttpError, readBody } from './http';
import { prepareMedia, sniffMedia, mediaFileHash, providerMediaByteLimit } from './media';
import { assetRoot, bytesHash, id as uuid, insert, list, now, transaction } from '../storage/db';
import { audit } from './projects';
import type { Asset, Project } from './types';
import type { UploadPurpose } from './upload-intents';

const projectByteLimit = 500 * 1024 * 1024;
const storedBytes = (asset: Asset) => asset.byteLength + (asset.original && asset.original.storageKey !== asset.storageKey ? asset.original.byteLength : 0);
function checkStorage(projectId: string, byteLength: number) {
  if (list<Asset>('assets', projectId).reduce((sum, asset) => sum + storedBytes(asset), 0) + byteLength > projectByteLimit)
    fail(413, 'This project has reached the 500 MB prototype storage limit.');
}

export async function ingestAsset(req: NextRequest, project: Project, expectedPurpose?: UploadPurpose) {
  const id = project.id;
  const maxSeconds = Math.min(600, Math.max(1, Number(process.env.MAX_CLIP_SECONDS) || (project.workflow === 'workshop_jig' || project.workflow === 'electronics_kit' ? 180 : 60)));
  const configuredBytes = Number(process.env.MAX_CLIP_BYTES);
  const limit = Number.isSafeInteger(configuredBytes) && configuredBytes > 0 ? Math.min(configuredBytes, projectByteLimit) : providerMediaByteLimit;
  const body = await readBody(req, limit + 100_000);
  let form: FormData;
  try {
    form = await new Response(body, { headers: { 'Content-Type': req.headers.get('content-type') || '' } }).formData();
  } catch {
    fail(400, 'Expected a multipart media upload.');
  }
  const suppliedPurpose = form.get('purpose');
  if (expectedPurpose !== undefined && suppliedPurpose !== null && suppliedPurpose !== expectedPurpose)
    fail(400, 'This upload link belongs to a different recording purpose. Start the upload again.');
  const purpose = expectedPurpose ?? (suppliedPurpose === 'trial' ? 'trial' : 'source');
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) fail(400, 'Choose an MP4, MOV, M4V or WebM video, or a JPEG/PNG photo.');
  if (file.size > limit) fail(413, 'Maximum upload size is 50 MB.');
  checkStorage(id, file.size);
  const bytes = Buffer.from(await file.arrayBuffer());
  const format = sniffMedia(bytes);
  const name = Array.from(file.name).slice(0, 180).join('');
  const assetId = uuid();
  const temp = path.join(assetRoot, assetId + '.upload');
  const normalizedTemp = path.join(assetRoot, assetId + '.normalized.mp4');
  const originalKey = assetId + '.original' + format.extension;
  const originalPath = path.join(assetRoot, originalKey);
  let storedPath: string | null = null;
  try {
    await writeFile(temp, bytes, { flag: 'wx' });
    let media: Awaited<ReturnType<typeof prepareMedia>>;
    try {
      media = await prepareMedia(temp, normalizedTemp, format, maxSeconds, Math.min(limit, providerMediaByteLimit));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      fail(415, 'Unable to read the complete recording or create a playable copy. Try the phone’s standard video setting, or choose a JPEG/PNG photo.');
    }
    const storageKey = assetId + media.extension;
    storedPath = path.join(assetRoot, storageKey);
    const sourceHash = bytesHash(bytes);
    const canonicalSize = media.normalized ? (await stat(normalizedTemp)).size : bytes.length;
    const canonicalHash = media.normalized ? await mediaFileHash(normalizedTemp) : sourceHash;
    const original = media.normalized ? { name, mime: format.mime, byteLength: bytes.length, sha256: sourceHash,
      storageKey: originalKey, durationMs: media.normalization.sourceDurationMs } : undefined;
    const totalBytes = canonicalSize + (original?.byteLength || 0);
    if (media.normalized) {
      await rename(temp, originalPath);
      await rename(normalizedTemp, storedPath);
    } else {
      await rename(temp, storedPath);
    }
    const asset = transaction(() => {
      // Other uploads can finish during decoding. Both retained files count toward storage.
      checkStorage(id, totalBytes);
      const record = insert<Asset>('assets', { id: assetId, projectId: id, name, mime: media.mime,
        byteLength: canonicalSize, sha256: canonicalHash, storageKey, durationMs: media.durationMs,
        purpose, createdAt: now(),
        ...(original ? { original, normalization: media.normalized ? media.normalization : undefined } : {}) });
      audit(id, 'asset_uploaded', assetId, media.normalized
        ? `${format.mime} original retained (${bytes.length} bytes, SHA-256 ${sourceHash}); complete H.264 MP4 copy (${canonicalSize} bytes), normalization ${media.normalization.version}.`
        : `${media.mime}, ${bytes.length} bytes; hash and visual decode verified.`);
      return record;
    });
    return asset;
  } catch (error) {
    await Promise.all([temp, normalizedTemp, originalPath, ...(storedPath ? [storedPath] : [])].map(filePath => unlink(filePath).catch(() => {})));
    throw error;
  }
}
