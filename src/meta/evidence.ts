import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { MetaError } from './client';
import { PLANNING_EVIDENCE_LIMITS } from './evidence-limits';
export { PLANNING_EVIDENCE_LIMITS } from './evidence-limits';

export type GroundedMediaAsset = {
  id: string; path: string; mime: string; sha256: string; byteLength: number;
  durationMs: number | null; createdAt: string; observationIds?: string[];
};
export type PlanningEvidenceContext = {
  version: 'grounded-evidence-v1'; sourceObservationIds: string[];
  sourceStatus: 'observation_bound' | 'source_only' | 'historical_unavailable' | 'none';
};
export type PlanningEvidenceManifest = PlanningEvidenceContext & {
  mediaRepresentation: 'canonical_application_media';
  assets: {
    assetId: string; role: 'original_source' | 'failed_trial'; mime: string; sha256: string;
    byteLength: number; durationMs: number | null; uploadedAt: string;
    captureTimeStatus: 'unknown'; observationIds: string[];
  }[];
};
function invalid(message: string): never { throw new MetaError(message, 'invalid_planning_evidence'); }
function uniqueIds(values: string[], name: string) {
  if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !value.trim() || value.length > 200)
    || new Set(values).size !== values.length) invalid(`The ${name} need unique recorded identifiers.`);
  return [...values];
}

/** Pure, path-free record of the exact evidence selected for this model request. */
export function describePlanningEvidence(
  sourceAssets: GroundedMediaAsset[] = [], trialAssets: GroundedMediaAsset[] = [],
  context?: PlanningEvidenceContext,
): PlanningEvidenceManifest {
  const selected = context || { version: 'grounded-evidence-v1', sourceObservationIds: [],
    sourceStatus: sourceAssets.length ? 'source_only' : 'none' };
  if (selected.version !== 'grounded-evidence-v1'
    || !['observation_bound', 'source_only', 'historical_unavailable', 'none'].includes(selected.sourceStatus))
    invalid('The planning evidence context version or source status is unavailable.');
  const sourceObservationIds = uniqueIds(selected.sourceObservationIds, 'source observations');
  if (selected.sourceStatus === 'observation_bound' && !sourceObservationIds.length)
    invalid('Observation-bound evidence needs its exact source observation.');
  if (selected.sourceStatus !== 'observation_bound' && sourceObservationIds.length)
    invalid('Unbound source evidence cannot claim an observation association.');
  if (['historical_unavailable', 'none'].includes(selected.sourceStatus) && sourceAssets.length)
    invalid('Unavailable source evidence cannot be replaced by unrelated uploads.');
  const all = [...sourceAssets, ...trialAssets];
  if (sourceAssets.length > PLANNING_EVIDENCE_LIMITS.maxSourceAssets
    || trialAssets.length > PLANNING_EVIDENCE_LIMITS.maxTrialAssets || all.length > PLANNING_EVIDENCE_LIMITS.maxAssets)
    throw new MetaError('Select at most 8 original source files and 4 failed-trial files. No evidence was silently omitted.', 'planning_evidence_limit');
  uniqueIds(all.map(asset => asset.id), 'evidence assets');
  const totals = { original_source: { bytes: 0, videoMs: 0 }, failed_trial: { bytes: 0, videoMs: 0 } };
  const assets: PlanningEvidenceManifest['assets'] = all.map((asset, index) => {
    const role = index < sourceAssets.length ? 'original_source' as const : 'failed_trial' as const;
    if (!['image/jpeg', 'image/png', 'video/mp4'].includes(asset.mime)
      || !/^[a-f0-9]{64}$/i.test(asset.sha256) || !Number.isSafeInteger(asset.byteLength) || asset.byteLength <= 0
      || !Number.isFinite(Date.parse(asset.createdAt))) invalid('Planning needs recorded JPEG/PNG/MP4 metadata and an exact SHA-256.');
    if (asset.byteLength > PLANNING_EVIDENCE_LIMITS.maxFileBytes)
      throw new MetaError('Each planning evidence file must be 50 MiB or smaller.', 'planning_evidence_limit');
    if (asset.mime === 'video/mp4') {
      if (typeof asset.durationMs !== 'number' || !Number.isFinite(asset.durationMs) || asset.durationMs <= 0)
        invalid('Planning video needs its recorded decoded duration.');
      totals[role].videoMs += asset.durationMs;
    } else if (asset.durationMs !== null) invalid('A still image cannot claim a video duration.');
    totals[role].bytes += asset.byteLength;
    const observationIds = uniqueIds(asset.observationIds || [], 'asset observations');
    if (role === 'failed_trial' && observationIds.length) invalid('Failed-trial evidence is separate from the original observation.');
    if (role === 'original_source' && (observationIds.some(id => !sourceObservationIds.includes(id))
      || (selected.sourceStatus === 'observation_bound' && !observationIds.length)))
      invalid('Original evidence must name its exact selected observation association.');
    return { assetId: asset.id, role, mime: asset.mime, sha256: asset.sha256.toLowerCase(), byteLength: asset.byteLength,
      durationMs: asset.durationMs, uploadedAt: asset.createdAt, captureTimeStatus: 'unknown', observationIds };
  });
  if (totals.original_source.bytes > PLANNING_EVIDENCE_LIMITS.maxSourceBytes
    || totals.original_source.videoMs > PLANNING_EVIDENCE_LIMITS.maxSourceVideoMs)
    throw new MetaError('Select original sources totalling at most 100 MiB and 360 seconds of video. No evidence was silently omitted.', 'planning_evidence_limit');
  if (totals.failed_trial.bytes > PLANNING_EVIDENCE_LIMITS.maxTrialBytes
    || totals.failed_trial.videoMs > PLANNING_EVIDENCE_LIMITS.maxTrialVideoMs)
    throw new MetaError('Select failed-trial evidence totalling at most 50 MiB and 180 seconds of video. No evidence was silently omitted.', 'planning_evidence_limit');
  if (totals.original_source.bytes + totals.failed_trial.bytes > PLANNING_EVIDENCE_LIMITS.maxTotalBytes
    || totals.original_source.videoMs + totals.failed_trial.videoMs > PLANNING_EVIDENCE_LIMITS.maxTotalVideoMs)
    throw new MetaError('Selected planning evidence exceeds the bounded combined media allowance. No evidence was silently omitted.', 'planning_evidence_limit');
  return { version: selected.version, sourceStatus: selected.sourceStatus, sourceObservationIds,
    mediaRepresentation: 'canonical_application_media', assets };
}

export function planningEvidenceHash(manifest: PlanningEvidenceManifest) {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

/** Fixed-size reads prevent a changed file from growing beyond the selected budget. */
async function readRecordedBytes(asset: GroundedMediaAsset) {
  const file = await open(asset.path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== asset.byteLength) invalid('Saved planning media no longer matches its recorded byte length.');
    const bytes = Buffer.alloc(asset.byteLength);
    let offset = 0;
    while (offset < bytes.length) {
      const next = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!next.bytesRead) invalid('Saved planning media is incomplete.');
      offset += next.bytesRead;
    }
    const extra = await file.read(Buffer.alloc(1), 0, 1, bytes.length);
    if (extra.bytesRead || createHash('sha256').update(bytes).digest('hex') !== asset.sha256.toLowerCase())
      invalid('Saved planning media no longer matches its recorded SHA-256.');
    return bytes;
  } finally { await file.close(); }
}

/** Validate every file before any provider upload, then send these same buffers. */
export async function preparePlanningEvidence(
  sourceAssets: GroundedMediaAsset[], trialAssets: GroundedMediaAsset[], context?: PlanningEvidenceContext,
) {
  const manifest = describePlanningEvidence(sourceAssets, trialAssets, context);
  const prepared: { asset: PlanningEvidenceManifest['assets'][number]; bytes: Buffer }[] = [];
  const all = [...sourceAssets, ...trialAssets];
  for (let index = 0; index < all.length; index++) {
    try { prepared.push({ asset: manifest.assets[index], bytes: await readRecordedBytes(all[index]) }); }
    catch (error) {
      if (error instanceof MetaError) throw error;
      throw new MetaError('Saved planning evidence could not be read. Restore the recorded file or start a deliberate observation with new media.', 'planning_evidence_unavailable');
    }
  }
  return { manifest, prepared };
}
