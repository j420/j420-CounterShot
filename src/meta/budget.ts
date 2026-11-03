import { validateModelUse, type MetaRoute } from './capabilities';

export const EXECUTION_BUDGET_VERSION = 'model-execution-v1';
export type ExecutionBudgetLimits = {
  maxInvocations: number; maxOutputTokens: number; maxKnownTotalTokens: number;
  maxInputBytes: number; maxToolExecutions: number; maxToolsPerResponse: number; maxDurationMs: number;
};
/** Prototype application policies, not provider capacity or billing guarantees. */
export const DEFAULT_CAMERA_EXECUTION_LIMITS: Readonly<ExecutionBudgetLimits> = Object.freeze({
  maxInvocations: 20, maxOutputTokens: 120_000, maxKnownTotalTokens: 400_000, maxInputBytes: 32 * 1024 * 1024,
  maxToolExecutions: 20, maxToolsPerResponse: 1, maxDurationMs: 60 * 60_000,
});
export const DEFAULT_PLANNING_EXECUTION_LIMITS: Readonly<ExecutionBudgetLimits> = Object.freeze({
  maxInvocations: 4, maxOutputTokens: 80_000, maxKnownTotalTokens: 200_000, maxInputBytes: 256 * 1024 * 1024,
  maxToolExecutions: 12, maxToolsPerResponse: 4, maxDurationMs: 8 * 60_000,
});
export const DEFAULT_OBSERVATION_EXECUTION_LIMITS: Readonly<ExecutionBudgetLimits> = Object.freeze({
  maxInvocations: 1, maxOutputTokens: 10_000, maxKnownTotalTokens: 30_000, maxInputBytes: 144 * 1024 * 1024,
  maxToolExecutions: 0, maxToolsPerResponse: 0, maxDurationMs: 2 * 60_000,
});
export type InvocationSpec = {
  invocationId: string; parentInvocationId: string | null; role: string; route: MetaRoute; model: string;
  contextHash: string; promptVersion: string; schemaVersion: string; toolVersion: string;
  maxOutputTokens: number; inputBytes: number;
};
export type KnownModelUsage = { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null };
export type ModelInvocation = InvocationSpec & {
  reservedAt: number; completedAt: number | null; status: 'reserved' | 'responded' | 'unknown';
  responseId: string | null; usage: KnownModelUsage | null;
  unknownReason: 'interrupted' | 'timeout' | 'connection_error' | 'cancelled' | 'unknown' | null;
};
export type ToolCallSpec = { callId: string; toolName: string; argumentsHash: string };
export type ToolReservation = ToolCallSpec & { invocationId: string; responseId: string; reservedAt: number };
export type ExecutionBudget = {
  version: typeof EXECUTION_BUDGET_VERSION; runId: string; createdAt: number; deadlineAt: number;
  cancelledAt: number | null; limits: ExecutionBudgetLimits; invocations: ModelInvocation[]; tools: ToolReservation[];
};

export class ExecutionBudgetError extends Error {
  constructor(message: string, public readonly code: 'invalid_execution_budget' | 'execution_budget_exhausted'
    | 'execution_cancelled' | 'invocation_conflict' | 'tool_conflict') {
    super(message); this.name = 'ExecutionBudgetError';
  }
}
function invalid(message: string): never { throw new ExecutionBudgetError(message, 'invalid_execution_budget'); }
function integer(value: number, minimum = 0) { return Number.isSafeInteger(value) && value >= minimum; }
function identifier(value: unknown) { return typeof value === 'string' && !!value.trim() && value.length <= 200; }
function timestamp(value: number) { if (!integer(value)) invalid('Execution time must be a recorded nonnegative integer timestamp.'); }
function clone<T>(value: T): T { return structuredClone(value); }
const specKeys = ['invocationId', 'parentInvocationId', 'role', 'route', 'model', 'contextHash', 'promptVersion', 'schemaVersion', 'toolVersion', 'maxOutputTokens', 'inputBytes'] as const;
function sameSpec(a: InvocationSpec, b: InvocationSpec) { return specKeys.every(key => a[key] === b[key]); }

function validateLimits(limits: ExecutionBudgetLimits) {
  if (!limits || !integer(limits.maxInvocations, 1) || limits.maxInvocations > 1000
    || !integer(limits.maxOutputTokens, 1) || limits.maxOutputTokens > 20_000_000
    || !integer(limits.maxKnownTotalTokens, 1) || limits.maxKnownTotalTokens > 100_000_000
    || !integer(limits.maxInputBytes, 1) || limits.maxInputBytes > 1024 * 1024 * 1024
    || !integer(limits.maxToolExecutions) || limits.maxToolExecutions > 1000
    || !integer(limits.maxToolsPerResponse) || limits.maxToolsPerResponse > limits.maxToolExecutions
    || !integer(limits.maxDurationMs, 1) || limits.maxDurationMs > 86_400_000)
    invalid('Execution needs explicit finite call, token, byte, tool and elapsed-time limits.');
}

/** Pure state can be saved transactionally beside a run/job and restored verbatim. */
export function createExecutionBudget(runId: string, limits: ExecutionBudgetLimits, now = Date.now()): ExecutionBudget {
  if (!identifier(runId)) invalid('An execution budget needs its exact application run identity.');
  timestamp(now); validateLimits(limits);
  if (!integer(now + limits.maxDurationMs)) invalid('Execution deadline exceeds the supported timestamp range.');
  return { version: EXECUTION_BUDGET_VERSION, runId, createdAt: now, deadlineAt: now + limits.maxDurationMs,
    cancelledAt: null, limits: clone(limits), invocations: [], tools: [] };
}

function validateState(state: ExecutionBudget) {
  if (!state || state.version !== EXECUTION_BUDGET_VERSION || !identifier(state.runId)
    || !Array.isArray(state.invocations) || !Array.isArray(state.tools)) invalid('This execution budget version or identity is unavailable.');
  validateLimits(state.limits); timestamp(state.createdAt); timestamp(state.deadlineAt);
  if (state.deadlineAt !== state.createdAt + state.limits.maxDurationMs
    || (state.cancelledAt !== null && !integer(state.cancelledAt))) invalid('The saved execution deadline or cancellation record is invalid.');
  if (new Set(state.invocations.map(item => item.invocationId)).size !== state.invocations.length
    || new Set(state.tools.map(item => JSON.stringify([item.responseId, item.callId]))).size !== state.tools.length)
    invalid('Execution records contain duplicate invocation or tool identities.');
  const responses = new Set<string>();
  for (const [index, invocation] of state.invocations.entries()) {
    validateInvocation(invocation); timestamp(invocation.reservedAt);
    if (!['reserved', 'responded', 'unknown'].includes(invocation.status)
      || (invocation.completedAt !== null && !integer(invocation.completedAt))
      || (invocation.responseId !== null && !identifier(invocation.responseId))
      || (invocation.status === 'responded' && invocation.responseId === null)
      || (invocation.status !== 'responded' && invocation.responseId !== null)) invalid('The saved invocation outcome is invalid.');
    if (invocation.parentInvocationId !== null && !state.invocations.slice(0, index).some(parent => parent.invocationId === invocation.parentInvocationId
      && parent.status === 'responded' && parent.reservedAt <= invocation.reservedAt)) invalid('The saved invocation parent does not belong to an earlier known response in this execution.');
    if (invocation.responseId !== null) {
      if (responses.has(invocation.responseId)) invalid('Provider response identities cannot be counted in multiple invocations.');
      responses.add(invocation.responseId);
    }
    if (invocation.usage && Object.values(invocation.usage).some(value => value !== null && !integer(value))) invalid('Recorded provider usage must contain only nonnegative token counts.');
  }
  for (const tool of state.tools) {
    const invocation = state.invocations.find(candidate => candidate.invocationId === tool.invocationId && candidate.responseId === tool.responseId);
    if (!invocation || !identifier(tool.callId) || !identifier(tool.toolName) || !/^[a-f0-9]{64}$/i.test(tool.argumentsHash)
      || !integer(tool.reservedAt)) invalid('A saved tool reservation has no matching owned response.');
    validateModelUse({ route: invocation.route, model: invocation.model, toolNames: [tool.toolName] });
  }
}

export function remainingExecutionBudget(state: ExecutionBudget, now = Date.now()) {
  validateState(state); timestamp(now);
  const reservedOutputTokens = state.invocations.reduce((sum, invocation) => sum + invocation.maxOutputTokens, 0);
  const inputBytes = state.invocations.reduce((sum, invocation) => sum + invocation.inputBytes, 0);
  const knownTotalTokens = state.invocations.reduce((sum, invocation) => sum + (invocation.usage?.totalTokens || 0), 0);
  return { invocations: Math.max(0, state.limits.maxInvocations - state.invocations.length),
    outputTokens: Math.max(0, state.limits.maxOutputTokens - reservedOutputTokens),
    inputBytes: Math.max(0, state.limits.maxInputBytes - inputBytes),
    knownTotalTokens: Math.max(0, state.limits.maxKnownTotalTokens - knownTotalTokens),
    tools: Math.max(0, state.limits.maxToolExecutions - state.tools.length),
    timeMs: Math.max(0, state.deadlineAt - now), cancelled: state.cancelledAt !== null,
    unknownInvocations: state.invocations.filter(invocation => invocation.status !== 'responded' || invocation.usage?.totalTokens === null).length };
}

export function assertExecutionCanContinue(state: ExecutionBudget, now = Date.now()) {
  validateState(state); timestamp(now);
  if (now < state.createdAt) invalid('The execution clock moved before the recorded run start.');
  if (state.cancelledAt !== null) throw new ExecutionBudgetError('This execution was cancelled. No further model calls or tools may start.', 'execution_cancelled');
  if (now >= state.deadlineAt) throw new ExecutionBudgetError('The shared execution deadline has expired. Start a deliberate new operation.', 'execution_budget_exhausted');
  if (state.invocations.length > state.limits.maxInvocations
    || state.invocations.reduce((sum, invocation) => sum + invocation.maxOutputTokens, 0) > state.limits.maxOutputTokens
    || state.invocations.reduce((sum, invocation) => sum + invocation.inputBytes, 0) > state.limits.maxInputBytes
    || state.tools.length > state.limits.maxToolExecutions
    || state.invocations.some(invocation => state.tools.filter(tool => tool.responseId === invocation.responseId).length > state.limits.maxToolsPerResponse))
    throw new ExecutionBudgetError('Merged execution reservations exceed the shared allowance. Paid and late results remain recorded; no further work may start.', 'execution_budget_exhausted');
  const used = state.invocations.reduce((sum, invocation) => sum + (invocation.usage?.totalTokens || 0), 0);
  if (used >= state.limits.maxKnownTotalTokens || state.invocations.some(invocation => (invocation.usage?.outputTokens || 0) > invocation.maxOutputTokens))
    throw new ExecutionBudgetError('The shared known-token usage limit has been reached. No further model calls or tools may start.', 'execution_budget_exhausted');
}

function validateInvocation(spec: InvocationSpec) {
  if (!spec || !identifier(spec.invocationId) || !identifier(spec.role) || !identifier(spec.model)
    || !identifier(spec.promptVersion) || !identifier(spec.schemaVersion) || !identifier(spec.toolVersion)
    || (spec.parentInvocationId !== null && !identifier(spec.parentInvocationId))
    || typeof spec.contextHash !== 'string' || !/^[a-f0-9]{64}$/i.test(spec.contextHash)
    || !integer(spec.maxOutputTokens, 1) || !integer(spec.inputBytes))
    invalid('Each model invocation needs recorded identity, versions, context hash and bounded request size.');
  validateModelUse({ route: spec.route, model: spec.model, maxOutputTokens: spec.maxOutputTokens });
}

/** Persist before POST. A repeated reservation is NOT permission to repeat a POST. */
export function reserveInvocation(state: ExecutionBudget, spec: InvocationSpec, now = Date.now()): { state: ExecutionBudget; reserved: boolean } {
  validateState(state); validateInvocation(spec); timestamp(now);
  const existing = state.invocations.find(invocation => invocation.invocationId === spec.invocationId);
  if (existing) {
    if (!sameSpec(existing, spec)) throw new ExecutionBudgetError('This invocation identity already belongs to different model inputs.', 'invocation_conflict');
    return { state: clone(state), reserved: false };
  }
  assertExecutionCanContinue(state, now);
  if (spec.parentInvocationId !== null && !state.invocations.some(invocation => invocation.invocationId === spec.parentInvocationId && invocation.status === 'responded'))
    invalid('A child invocation needs a known provider response in the same shared budget; unknown outcomes cannot be continued or retried automatically.');
  const remaining = remainingExecutionBudget(state, now);
  if (!remaining.invocations || spec.maxOutputTokens > remaining.outputTokens || spec.inputBytes > remaining.inputBytes)
    throw new ExecutionBudgetError('The shared model call, output-token or input-byte allowance is exhausted. No child receives a fresh allowance.', 'execution_budget_exhausted');
  const next = clone(state);
  next.invocations.push({ ...clone(spec), reservedAt: now, completedAt: null, status: 'reserved', responseId: null, usage: null, unknownReason: null });
  return { state: next, reserved: true };
}

function normalizedUsage(value: unknown): KnownModelUsage {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const count = (key: string) => typeof record[key] === 'number' && integer(record[key] as number) ? record[key] as number : null;
  const inputTokens = count('input_tokens'), outputTokens = count('output_tokens'), reportedTotal = count('total_tokens');
  const sum = inputTokens !== null && outputTokens !== null && integer(inputTokens + outputTokens) ? inputTokens + outputTokens : null;
  // Preserve a conservative observed total if the provider reports inconsistent fields.
  const totalTokens = reportedTotal === null ? sum : sum === null ? reportedTotal : Math.max(reportedTotal, sum);
  return { inputTokens, outputTokens, totalTokens };
}

function mergeUsage(previous: KnownModelUsage | null, current: KnownModelUsage | null): KnownModelUsage | null {
  if (!previous) return clone(current);
  if (!current) return clone(previous);
  const merged = { ...current };
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
    const oldValue = previous[key], newValue = current[key];
    if (oldValue !== null && newValue !== null && oldValue !== newValue)
      throw new ExecutionBudgetError('The same provider response has conflicting known usage; it was not counted twice.', 'invocation_conflict');
    merged[key] = oldValue ?? newValue;
  }
  return merged;
}

/** A late/over-budget result is still accounted, even after cancellation/deadline. */
export function recordInvocationResponse(state: ExecutionBudget, invocationId: string, responseId: string, usage: unknown, now = Date.now()): ExecutionBudget {
  validateState(state); timestamp(now);
  if (!identifier(responseId)) invalid('A known response needs its provider response identity.');
  const index = state.invocations.findIndex(invocation => invocation.invocationId === invocationId);
  if (index < 0) invalid('The response has no reserved invocation in this execution.');
  if (state.invocations.some(invocation => invocation.invocationId !== invocationId && invocation.responseId === responseId))
    throw new ExecutionBudgetError('This provider response already belongs to another reserved invocation.', 'invocation_conflict');
  const invocation = state.invocations[index], copiedUsage = normalizedUsage(usage);
  if (invocation.responseId !== null && invocation.responseId !== responseId)
    throw new ExecutionBudgetError('This invocation already has a different provider response identity.', 'invocation_conflict');
  const mergedUsage = mergeUsage(invocation.usage, copiedUsage);
  const next = clone(state), target = next.invocations[index];
  target.status = 'responded'; target.responseId = responseId; target.completedAt = target.completedAt ?? now;
  // A duplicate incomplete callback must not erase already-known usage.
  target.usage = mergedUsage;
  return next;
}

export function markInvocationUnknown(state: ExecutionBudget, invocationId: string,
  reason: NonNullable<ModelInvocation['unknownReason']> = 'unknown', now = Date.now()): ExecutionBudget {
  validateState(state); timestamp(now);
  if (!['interrupted', 'timeout', 'connection_error', 'cancelled', 'unknown'].includes(reason)) invalid('Unknown invocation outcomes need a bounded failure category.');
  const index = state.invocations.findIndex(invocation => invocation.invocationId === invocationId);
  if (index < 0) invalid('The interrupted request has no reserved invocation in this execution.');
  const next = clone(state), target = next.invocations[index];
  if (target.status !== 'responded') { target.status = 'unknown'; target.unknownReason = reason; target.completedAt ??= now; }
  return next;
}

export function cancelExecutionBudget(state: ExecutionBudget, now = Date.now()): ExecutionBudget {
  validateState(state); timestamp(now);
  const next = clone(state); next.cancelledAt ??= now; return next;
}

/** Merge late full snapshots without erasing newer reservations, usage or cancellation. */
export function mergeExecutionBudgets(existing: ExecutionBudget, incoming: ExecutionBudget): ExecutionBudget {
  validateState(existing); validateState(incoming);
  const limitKeys = ['maxInvocations', 'maxOutputTokens', 'maxKnownTotalTokens', 'maxInputBytes', 'maxToolExecutions', 'maxToolsPerResponse', 'maxDurationMs'] as const;
  if (existing.runId !== incoming.runId || existing.version !== incoming.version || existing.createdAt !== incoming.createdAt
    || existing.deadlineAt !== incoming.deadlineAt || limitKeys.some(key => existing.limits[key] !== incoming.limits[key]))
    throw new ExecutionBudgetError('Execution snapshots must share the exact run identity, start, deadline and immutable limits.', 'invocation_conflict');
  const next = clone(existing);
  const cancellations = [existing.cancelledAt, incoming.cancelledAt].filter((value): value is number => value !== null);
  next.cancelledAt = cancellations.length ? Math.min(...cancellations) : null;
  for (const candidate of incoming.invocations) {
    const index = next.invocations.findIndex(invocation => invocation.invocationId === candidate.invocationId);
    if (index < 0) { next.invocations.push(clone(candidate)); continue; }
    const previous = next.invocations[index];
    if (!sameSpec(previous, candidate) || previous.reservedAt !== candidate.reservedAt
      || (previous.responseId !== null && candidate.responseId !== null && previous.responseId !== candidate.responseId))
      throw new ExecutionBudgetError('An invocation snapshot conflicts with its saved input, reservation or provider response.', 'invocation_conflict');
    const completed = [previous.completedAt, candidate.completedAt].filter((value): value is number => value !== null);
    const responseId = previous.responseId ?? candidate.responseId;
    next.invocations[index] = { ...previous, responseId, usage: mergeUsage(previous.usage, candidate.usage),
      status: responseId !== null ? 'responded' : previous.status === 'unknown' || candidate.status === 'unknown' ? 'unknown' : 'reserved',
      completedAt: completed.length ? Math.min(...completed) : null,
      unknownReason: previous.unknownReason ?? candidate.unknownReason };
  }
  for (const candidate of incoming.tools) {
    const index = next.tools.findIndex(tool => tool.responseId === candidate.responseId && tool.callId === candidate.callId);
    if (index < 0) { next.tools.push(clone(candidate)); continue; }
    const previous = next.tools[index];
    if (previous.invocationId !== candidate.invocationId || previous.toolName !== candidate.toolName || previous.argumentsHash !== candidate.argumentsHash)
      throw new ExecutionBudgetError('A tool snapshot conflicts with the saved response/call arguments.', 'tool_conflict');
    next.tools[index].reservedAt = Math.min(previous.reservedAt, candidate.reservedAt);
  }
  // Never discard evidence of work that already started. The next reservation
  // gate rejects a merged oversubscription or observed-token overage.
  validateState(next);
  return next;
}

/** Reserve the complete returned batch before executing its first immediate tool. */
export function reserveToolBatch(state: ExecutionBudget, invocationId: string, responseId: string, calls: ToolCallSpec[], now = Date.now()): { state: ExecutionBudget; executableCallIds: string[] } {
  assertExecutionCanContinue(state, now);
  const invocation = state.invocations.find(candidate => candidate.invocationId === invocationId);
  if (!invocation || invocation.status !== 'responded' || invocation.responseId !== responseId)
    invalid('Tools need the exact recorded provider response and reserved invocation.');
  if (!Array.isArray(calls) || new Set(calls.map(call => call.callId)).size !== calls.length)
    throw new ExecutionBudgetError('A tool response must name each call identity once.', 'tool_conflict');
  for (const call of calls) {
    if (!identifier(call.callId) || !identifier(call.toolName) || !/^[a-f0-9]{64}$/i.test(call.argumentsHash)) invalid('Tool calls need exact names, identities and argument fingerprints.');
    validateModelUse({ route: invocation.route, model: invocation.model, toolNames: [call.toolName] });
  }
  const known = state.tools.filter(tool => tool.responseId === responseId);
  const fresh = calls.filter(call => {
    const existing = known.find(tool => tool.callId === call.callId);
    if (existing && (existing.invocationId !== invocationId || existing.toolName !== call.toolName || existing.argumentsHash !== call.argumentsHash))
      throw new ExecutionBudgetError('This response/call identity already belongs to different tool arguments.', 'tool_conflict');
    return !existing;
  });
  if (known.length + fresh.length > state.limits.maxToolsPerResponse || state.tools.length + fresh.length > state.limits.maxToolExecutions)
    throw new ExecutionBudgetError('The complete tool batch exceeds the shared tool allowance. No partial batch was admitted.', 'execution_budget_exhausted');
  const next = clone(state);
  next.tools.push(...fresh.map(call => ({ ...clone(call), invocationId, responseId, reservedAt: now })));
  return { state: next, executableCallIds: fresh.map(call => call.callId) };
}
