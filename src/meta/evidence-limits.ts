/** Application media allowances; source capacity never consumes trial capacity. */
export const PLANNING_EVIDENCE_LIMITS = {
  maxSourceAssets: 8, maxTrialAssets: 4, maxAssets: 12,
  maxFileBytes: 50 * 1024 * 1024,
  maxSourceBytes: 100 * 1024 * 1024, maxTrialBytes: 50 * 1024 * 1024,
  maxTotalBytes: 150 * 1024 * 1024,
  maxSourceVideoMs: 360_000, maxTrialVideoMs: 180_000, maxTotalVideoMs: 540_000,
} as const;
