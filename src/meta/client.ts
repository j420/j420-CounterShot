import OpenAI from "openai";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import { DEFAULT_META_MODEL, ModelCapabilityError, resolveModelBinding } from './capabilities';
import { ExecutionBudgetError } from './budget';

/** Credentials stay on the server. The cloud proxy injects destination-bound secrets. */
let client: OpenAI | undefined;
export function metaStatus() {
  const model = process.env.META_MODEL || DEFAULT_META_MODEL;
  try {
    resolveModelBinding('camera_reasoning', model);
    return { configured: Boolean(process.env.MODEL_API_KEY), model, configurationError: null };
  } catch (error) {
    return { configured: false, model, configurationError: error instanceof ModelCapabilityError ? error.message : 'The configured model route is unavailable.' };
  }
}

export function createMetaClient(): OpenAI {
  try { resolveModelBinding('camera_reasoning', process.env.META_MODEL); }
  catch (error) { throw normalizeMetaError(error); }
  if (!process.env.MODEL_API_KEY) throw new MetaError("Meta API access is not configured. Add MODEL_API_KEY to the server environment.", "not_configured");
  if (client) return client;
  const dispatcher = process.env.HTTPS_PROXY || process.env.HTTP_PROXY ? new EnvHttpProxyAgent() : undefined;
  // undici retains inherited TLS trust, including NODE_EXTRA_CA_CERTS. Never disable verification.
  const proxyFetch: typeof globalThis.fetch = (input, init) => undiciFetch(
    input as Parameters<typeof undiciFetch>[0],
    { ...init, dispatcher } as Parameters<typeof undiciFetch>[1],
  ) as unknown as Promise<Response>;
  client = new OpenAI({
    baseURL: "https://api.meta.ai/v1",
    apiKey: process.env.MODEL_API_KEY,
    fetch: proxyFetch,
    maxRetries: 0,
    timeout: Number(process.env.JOB_TIMEOUT_MS || 120_000),
  });
  return client;
}

export class MetaError extends Error {
  /** Server-side audit evidence only; never includes credentials or request headers. */
  trace?: unknown;
  constructor(message: string, public code: string, public status?: number, public retryAfterSeconds?: number) {
    super(message); this.name = "MetaError";
  }
}

export function normalizeMetaError(error: unknown): MetaError {
  if (error instanceof MetaError) return error;
  if (error instanceof ModelCapabilityError || error instanceof ExecutionBudgetError) return new MetaError(error.message, error.code);
  if (error instanceof OpenAI.APIConnectionTimeoutError) return new MetaError("Meta request timed out. The provider may still have performed work; inspect the recorded attempt before retrying.", "timeout");
  if (error instanceof OpenAI.APIError) {
    const status = error.status;
    const retryAfter = Number(error.headers?.get("retry-after"));
    if (status === 401 || status === 403) return new MetaError("Meta rejected this server's credentials or model permission. Check the participant account and configured key.", "authentication", status);
    if (status === 429) return new MetaError("Meta rate or usage limit reached. Retry after the account's quota permits it.", "rate_limit", status, Number.isFinite(retryAfter) ? retryAfter : undefined);
    if (status === 400) return new MetaError("Meta rejected the request or its schema/media. This attempt was not retried automatically.", "invalid_request", status);
    return new MetaError(status ? `Meta returned HTTP ${status}. This attempt was not retried automatically.` : "Could not reach Meta through the server's configured network path.", "provider_error", status);
  }
  return new MetaError("Meta generation could not complete. No design was published.", "generation_error");
}
