import { createHash } from 'node:crypto';
import type { Response, ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses';
import { createExecutionBudget, assertExecutionCanContinue, markInvocationUnknown, mergeExecutionBudgets,
  recordInvocationResponse, remainingExecutionBudget, reserveInvocation, reserveToolBatch,
  type ExecutionBudget, type ExecutionBudgetLimits, type InvocationSpec, type ToolCallSpec } from './budget';
import { validateModelUse, type MetaRoute } from './capabilities';
import { MetaError, normalizeMetaError } from './client';

export type ExecutionCheckpoint = 'preflight' | 'reserve' | 'response' | 'tool_reserve' | 'unknown';
export type ExecutionBinding = {
  budget: ExecutionBudget;
  onBudget?: (state: ExecutionBudget, checkpoint: ExecutionCheckpoint) => Promise<ExecutionBudget | void>;
};
export const modelRequestHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function configuredTimeoutMs() {
  const raw = process.env.JOB_TIMEOUT_MS;
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new MetaError('JOB_TIMEOUT_MS must be a positive integer number of milliseconds.', 'invalid_model_configuration');
  return value;
}

/** One controller shared by all immediate continuations/roles of this operation. */
export class ModelExecution {
  private state: ExecutionBudget;
  private readonly onBudget?: ExecutionBinding['onBudget'];
  private sequence = 0;
  modelInvocationId: string | null = null;
  lastResponse: Response | null = null;

  constructor(binding: ExecutionBinding | undefined, options: { runId: string; limits: ExecutionBudgetLimits }) {
    configuredTimeoutMs();
    this.state = binding ? structuredClone(binding.budget) : createExecutionBudget(options.runId, options.limits);
    this.onBudget = binding?.onBudget;
    if (this.state.runId !== options.runId) throw new MetaError('The execution budget belongs to a different application run.', 'invalid_execution_budget');
    // Validate a restored record without declaring an old audit response invalid
    // merely because its deadline has now passed.
    remainingExecutionBudget(this.state);
  }
  snapshot(): ExecutionBudget { return structuredClone(this.state); }
  /** Media transfers share the same deadline and configured network timeout. */
  workTimeoutMs(maximumMs = 120_000): number {
    assertExecutionCanContinue(this.state);
    const remainingMs = remainingExecutionBudget(this.state).timeMs;
    if (remainingMs <= 0) throw new MetaError('The shared execution deadline expired before remote work could start.', 'execution_budget_exhausted');
    return Math.min(maximumMs, configuredTimeoutMs() ?? maximumMs, remainingMs);
  }

  private async persist(checkpoint: ExecutionCheckpoint) {
    const durable = await this.onBudget?.(this.snapshot(), checkpoint);
    if (durable) this.state = mergeExecutionBudgets(this.state, durable);
  }

  /** Media work must remain eligible for its planned call without spending one. */
  async preflight(requiredOutputTokens: number) {
    if (!Number.isSafeInteger(requiredOutputTokens) || requiredOutputTokens <= 0)
      throw new MetaError('A media preflight needs the planned model output allowance.', 'invalid_execution_budget');
    await this.persist('preflight');
    assertExecutionCanContinue(this.state);
    const remaining = remainingExecutionBudget(this.state);
    if (!remaining.invocations || remaining.outputTokens < requiredOutputTokens || !remaining.inputBytes || remaining.timeMs <= 0)
      throw new MetaError('The shared execution allowance cannot support the planned model call. No further media was uploaded.', 'execution_budget_exhausted');
  }

  async request(input: {
    prefix: string; role: string; route: MetaRoute; payload: ResponseCreateParamsNonStreaming;
    promptVersion: string; schemaVersion: string; toolVersion: string;
    parentInvocationId?: string | null;
    beforePost: () => Promise<void>;
    send: (timeoutMs: number) => Promise<Response>;
  }): Promise<Response> {
    if (!Number.isSafeInteger(input.payload.max_output_tokens) || (input.payload.max_output_tokens ?? 0) <= 0)
      throw new MetaError('Every model invocation needs an explicit enforced output-token limit.', 'invalid_execution_budget');
    const tools = (input.payload.tools || []).map(tool => tool.type === 'function' ? tool.name : tool.type);
    const binding = validateModelUse({ route: input.route, model: input.payload.model,
      toolNames: tools, maxOutputTokens: input.payload.max_output_tokens ?? undefined });
    const configuredTimeout = configuredTimeoutMs();
    const invocationId = `${input.prefix}:${this.sequence++}`;
    const spec: InvocationSpec = { invocationId, parentInvocationId: input.parentInvocationId ?? null,
      role: input.role, route: input.route, model: binding.model, contextHash: modelRequestHash(input.payload),
      promptVersion: input.promptVersion, schemaVersion: input.schemaVersion, toolVersion: input.toolVersion,
      maxOutputTokens: input.payload.max_output_tokens ?? binding.maxOutputTokens,
      inputBytes: Buffer.byteLength(JSON.stringify(input.payload)) };
    let reserved = false;
    try {
      const next = reserveInvocation(this.state, spec);
      this.state = next.state;
      this.modelInvocationId = invocationId;
      if (!next.reserved) throw new MetaError('This invocation was already reserved. Its prior outcome must be recovered; no duplicate model request was sent.', 'invocation_already_reserved');
      reserved = true;
      await this.persist('reserve');
      // Durable reservation and the final state/version fence both finish before POST.
      await input.beforePost();
      assertExecutionCanContinue(this.state);
      const remainingTimeMs = remainingExecutionBudget(this.state).timeMs;
      if (remainingTimeMs <= 0) throw new MetaError('The shared execution deadline expired before the model request could start.', 'execution_budget_exhausted');
      const timeoutMs = Math.min(binding.timeoutMs, configuredTimeout ?? binding.timeoutMs, remainingTimeMs);
      const response = await input.send(timeoutMs);
      this.lastResponse = response;
      this.state = recordInvocationResponse(this.state, invocationId, response.id, response.usage);
      await this.persist('response');
      return response;
    } catch (error) {
      const normalized = normalizeMetaError(error);
      const current = this.state.invocations.find(invocation => invocation.invocationId === invocationId);
      if (reserved && current && current.status !== 'responded') {
        this.state = markInvocationUnknown(this.state, invocationId,
          normalized.code === 'timeout' ? 'timeout' : normalized.code === 'cancelled' ? 'cancelled' : 'unknown');
        try { await this.persist('unknown'); } catch { /* The caller still receives the complete local audit snapshot. */ }
      }
      throw normalized;
    }
  }

  async tools(responseId: string, calls: ToolCallSpec[]): Promise<string[]> {
    if (!this.modelInvocationId) throw new MetaError('Tool execution has no reserved model invocation.', 'invalid_execution_budget');
    const next = reserveToolBatch(this.state, this.modelInvocationId, responseId, calls);
    this.state = next.state;
    await this.persist('tool_reserve');
    assertExecutionCanContinue(this.state);
    return next.executableCallIds;
  }
}
