import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { bytesHash, db, get, insert, now, replace, transaction } from '../storage/db';
import { fail } from './http';
import type { Project } from './types';
import { uploadOrigins, UploadConfigError, type UploadOrigins } from './upload-config';

export type UploadPurpose = 'source' | 'trial';
type UploadIntent = { id: string; projectId: string; purpose: UploadPurpose; createdAt: string; expiresAt: string; usedAt: string | null };
const IntentBody = z.object({ purpose: z.enum(['source', 'trial']) }).strict();

export function configuredUploadOrigins(): UploadOrigins | null {
  try { return uploadOrigins(); }
  catch (error) {
    if (error instanceof UploadConfigError) fail(503, 'Direct media uploads are not configured correctly.');
    throw error;
  }
}

export function createUploadIntent(project: Project, body: unknown) {
  const { purpose } = IntentBody.parse(body);
  const origins = configuredUploadOrigins();
  if (!origins) return null;
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  transaction(() => {
    db.prepare("DELETE FROM records WHERE collection='upload_intents' AND json_extract(json,'$.expiresAt')<=?").run(now());
    insert<UploadIntent>('upload_intents', { id: bytesHash(token), projectId: project.id, purpose, createdAt: now(), expiresAt, usedAt: null });
  });
  return { url: `${origins.apiOrigin}/api/projects/${encodeURIComponent(project.id)}/uploads`, token, expiresAt };
}

/** Claim before reading any upload bytes, so parallel replays cannot create two assets. */
export function consumeUploadIntent(projectId: string, authorization: string | null) {
  const token = /^Bearer ([a-f0-9]{64})$/i.exec(authorization || '')?.[1];
  if (!token) fail(401, 'This upload link is invalid, expired or already used. Start the upload again.');
  return transaction(() => {
    const intent = get<UploadIntent>('upload_intents', bytesHash(token));
    if (!intent || intent.projectId !== projectId || intent.usedAt || !Number.isFinite(Date.parse(intent.expiresAt))
      || Date.parse(intent.expiresAt) <= Date.now() || !['source', 'trial'].includes(intent.purpose))
      fail(401, 'This upload link is invalid, expired or already used. Start the upload again.');
    const project = get<Project>('projects', projectId);
    if (!project) fail(401, 'This upload project is no longer available.');
    intent.usedAt = now();
    replace('upload_intents', intent);
    return { project, purpose: intent.purpose };
  });
}
