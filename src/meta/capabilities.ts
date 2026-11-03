/** Verified application adapters, not a claim about every model in Meta's catalog. */
export const MODEL_BINDING_VERSION = 'meta-bindings-v2';
export const DEFAULT_META_MODEL = 'muse-spark-1.3';
export type MetaRoute = 'camera_reasoning' | 'observation' | 'planning';
export type InputModality = 'text' | 'image' | 'video';
export type ModelBinding = {
  version: typeof MODEL_BINDING_VERSION; route: MetaRoute; model: typeof DEFAULT_META_MODEL;
  endpoint: 'https://api.meta.ai/v1'; inputModalities: readonly InputModality[];
  structuredOutput: true; toolNames: readonly string[]; maxOutputTokens: number;
  timeoutMs: number; automaticRetries: 0;
};

export class ModelCapabilityError extends Error {
  readonly code = 'unsupported_model_binding';
  constructor(message: string) { super(message); this.name = 'ModelCapabilityError'; }
}

const routes: Record<MetaRoute, Readonly<ModelBinding>> = {
  camera_reasoning: Object.freeze({ version: MODEL_BINDING_VERSION, route: 'camera_reasoning', model: DEFAULT_META_MODEL,
    endpoint: 'https://api.meta.ai/v1', inputModalities: Object.freeze(['text', 'image'] as InputModality[]),
    structuredOutput: true, toolNames: Object.freeze(['read_owned_evidence']), maxOutputTokens: 6000, timeoutMs: 90_000, automaticRetries: 0 }),
  observation: Object.freeze({ version: MODEL_BINDING_VERSION, route: 'observation', model: DEFAULT_META_MODEL,
    endpoint: 'https://api.meta.ai/v1', inputModalities: Object.freeze(['text', 'image', 'video'] as InputModality[]),
    structuredOutput: true, toolNames: Object.freeze([]), maxOutputTokens: 10_000, timeoutMs: 120_000, automaticRetries: 0 }),
  planning: Object.freeze({ version: MODEL_BINDING_VERSION, route: 'planning', model: DEFAULT_META_MODEL,
    endpoint: 'https://api.meta.ai/v1', inputModalities: Object.freeze(['text', 'image', 'video'] as InputModality[]),
    structuredOutput: true, toolNames: Object.freeze(['check_task_plan']), maxOutputTokens: 20_000, timeoutMs: 120_000, automaticRetries: 0 }),
};

/** An arbitrary catalog name must never inherit the Spark schema/media/tool contract. */
export function resolveModelBinding(route: MetaRoute, configuredModel?: string): Readonly<ModelBinding> {
  if (!Object.prototype.hasOwnProperty.call(routes, route)) throw new ModelCapabilityError('This reasoning route has no validated Meta adapter.');
  const model = configuredModel === undefined || configuredModel === '' ? DEFAULT_META_MODEL : configuredModel;
  if (model !== DEFAULT_META_MODEL) throw new ModelCapabilityError(`The configured model has no validated ${route} binding. Configure ${DEFAULT_META_MODEL}; catalog availability alone does not validate an adapter.`);
  return routes[route];
}

/** Validate actual requested use as well as model identity before sending a request. */
export function validateModelUse(input: { route: MetaRoute; model?: string; modalities?: InputModality[];
  toolNames?: string[]; maxOutputTokens?: number }): Readonly<ModelBinding> {
  const binding = resolveModelBinding(input.route, input.model);
  if (input.modalities?.some(modality => !binding.inputModalities.includes(modality)))
    throw new ModelCapabilityError('The selected model route does not support this application input modality.');
  if (input.toolNames?.some(name => !binding.toolNames.includes(name)))
    throw new ModelCapabilityError('The selected model route does not permit this application tool.');
  if (input.maxOutputTokens !== undefined && (!Number.isSafeInteger(input.maxOutputTokens)
    || input.maxOutputTokens <= 0 || input.maxOutputTokens > binding.maxOutputTokens))
    throw new ModelCapabilityError('The requested output allowance exceeds the validated model-route limit.');
  return binding;
}
