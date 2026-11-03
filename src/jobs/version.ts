import { DOMAIN_SCHEMA_VERSION } from '../domain/schema';
import { CHECKER_VERSION } from '../checks';
import { COMPILER_VERSION } from '../geometry';
import { PROMPT_VERSION } from '../meta/prompts';
import type { JobExecutionSpec } from '../server/types';

/** A queued request may run only with the exact runtime that was hashed. */
export function currentExecutionSpec(): JobExecutionSpec {
 return {
  model: process.env.META_MODEL || 'muse-spark-1.3',
  promptVersion: PROMPT_VERSION,
  schemaVersion: DOMAIN_SCHEMA_VERSION,
  checkerVersion: CHECKER_VERSION,
  compilerVersion: COMPILER_VERSION,
 };
}
