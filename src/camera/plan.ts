import type { WorkflowDefinition } from './schema';
import type { ReasoningEvidence, ReasoningVersion } from './reasoning';

export const CAMERA_PLAN_VERSION = 'camera-plan-v1';
export const CAMERA_PLAN_LIMITS = { substepsPerPhase: 4, proposals: 20, versions: 20, counterevidence: 5 } as const;
export type CameraPlanSubstepInput = { instruction: string; preconditions: string[]; expectedVisibleResult: string; stopCondition: string };
export type CameraPlanSubstep = CameraPlanSubstepInput & { id: string; sourceProposalId: string };
export type CameraPlanRecord = { id: string; parentId: string | null; version: ReasoningVersion;
  mandatoryObligations: string; substepsByPhase: Record<string, CameraPlanSubstep[]> };
export type CameraPlanCounterevidence = { id: string; version: ReasoningVersion; frameId: string; sha256: string;
  status: 'contradicted' | 'unresolved' | 'reported_failure' };
export type CameraPlanChangeInput = { sourceTurnId: string; parentPlanVersion: string; kind: 'within_phase' | 'reopen_phase';
  reopenStepId: string | null; substeps: CameraPlanSubstepInput[]; counterevidenceIds: string[]; rationale: string };
export type CameraPlanProposal = CameraPlanChangeInput & { id: string; version: ReasoningVersion;
  evidence: ReasoningEvidence; counterevidence: CameraPlanCounterevidence[]; mandatoryObligations: string;
  status: 'proposed' | 'accepted' };
export type CameraPlanApproval = { clientOperationId: string; requestIdentity: string; proposalId: string;
  priorPlanId: string; nextPlanId: string; approvedVersion: ReasoningVersion };
export type CameraPlanState = { version: typeof CAMERA_PLAN_VERSION; current: CameraPlanRecord;
  history: CameraPlanRecord[]; proposals: CameraPlanProposal[]; approvals: CameraPlanApproval[] };
export type CameraPlanApprovalResult = { replayed: true; state: CameraPlanState; approval: CameraPlanApproval } | {
  replayed: false; state: CameraPlanState; approval: CameraPlanApproval; currentStepId: string;
  retainedCompletedStepIds: string[]; invalidatedStepIds: string[]; requiresFreshView: true;
};
export class CameraPlanError extends Error {
  constructor(public code: 'invalid_plan_change' | 'stale_plan_change' | 'plan_limit', message: string) { super(message); this.name = 'CameraPlanError'; }
}
function invalid(message: string): never { throw new CameraPlanError('invalid_plan_change', message); }
function stale(message: string): never { throw new CameraPlanError('stale_plan_change', message); }
function text(value: string, name: string, maximum = 1000) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) invalid(`${name} must be bounded recorded text.`);
}
function identityList(values: string[], name: string, maximum = 50) {
  if (!Array.isArray(values) || values.length > maximum || new Set(values).size !== values.length
    || values.some(value => typeof value !== 'string' || !value.trim() || value.length > 200)) invalid(`${name} must name distinct recorded identities.`);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .filter(([, item]) => item !== undefined).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
function validateVersion(value: ReasoningVersion) {
  if (!value || !Number.isSafeInteger(value.revision) || value.revision < 1 || !Number.isSafeInteger(value.sceneEpoch) || value.sceneEpoch < 1
    || !/^[a-f0-9]{64}$/i.test(value.factsHash || '')) invalid('Plan changes need exact recorded state, scene and facts versions.');
  text(value.runId, 'Run identity', 200); text(value.stepId, 'Phase identity', 200); text(value.planVersion, 'Plan version', 200);
}
function validateEvidence(evidence: ReasoningEvidence) {
  if (!evidence || !/^[a-f0-9]{64}$/i.test(evidence.sha256 || '')) invalid('The plan-change view needs its recorded SHA-256.');
  text(evidence.turnId, 'Evidence turn', 200); text(evidence.frameId, 'Evidence frame', 200); identityList(evidence.observationIds, 'Evidence observations', 5);
}
function mandatoryObligations(workflow: WorkflowDefinition) {
  // Exact canonical catalog data, not a collision-prone or provider-authored digest.
  return canonical({ workflowId: workflow.id, physicalScope: workflow.physicalScope, limitations: workflow.limitations,
    requiredFacts: workflow.requiredFacts, completionChecks: workflow.completionChecks,
    steps: workflow.steps.map(step => ({ id: step.id, instruction: step.instruction, visibleChecks: step.visibleChecks,
      requiredFactIds: step.requiredFactIds, requiredConfirmations: step.requiredConfirmations, measurements: step.measurements || [] })) });
}
function phaseIndex(workflow: WorkflowDefinition, stepId: string) {
  if (!workflow.steps.length || new Set(workflow.steps.map(step => step.id)).size !== workflow.steps.length) invalid('Catalog phases must remain distinct and ordered.');
  const index = workflow.steps.findIndex(step => step.id === stepId);
  if (index < 0) invalid('The plan change refers to an unsupported phase.');
  return index;
}
function current(state: CameraPlanState, version: ReasoningVersion, workflow: WorkflowDefinition) {
  validateVersion(version); phaseIndex(workflow, version.stepId);
  if (!state || state.version !== CAMERA_PLAN_VERSION || !state.current || !Array.isArray(state.proposals) || !Array.isArray(state.history)
    || !Array.isArray(state.approvals)) invalid('The saved plan contract is unavailable.');
  if (state.current.id !== version.planVersion || state.current.version.runId !== version.runId || state.current.version.sceneEpoch !== version.sceneEpoch
    || state.current.version.factsHash !== version.factsHash) stale('The plan parent, scene or facts changed. Review a proposal against the current plan.');
  if (state.current.mandatoryObligations !== mandatoryObligations(workflow)) stale('The mandatory workflow obligations changed. Reconfirm the current workflow before replanning.');
}
function sameProposalVersion(a: ReasoningVersion, b: ReasoningVersion) { return canonical(a) === canonical(b); }

export function createCameraPlan(workflow: WorkflowDefinition, version: ReasoningVersion): CameraPlanState {
  validateVersion(version); phaseIndex(workflow, version.stepId);
  return { version: CAMERA_PLAN_VERSION, current: { id: version.planVersion, parentId: null, version: structuredClone(version),
    mandatoryObligations: mandatoryObligations(workflow), substepsByPhase: {} }, history: [], proposals: [], approvals: [] };
}

/** Catalog phases cannot be skipped/reordered; proposals adapt only bounded work within them. */
export function proposeCameraPlanChange(state: CameraPlanState, input: CameraPlanChangeInput, context: {
  version: ReasoningVersion; evidence: ReasoningEvidence; workflow: WorkflowDefinition; ownedCounterevidence: CameraPlanCounterevidence[];
}): CameraPlanState {
  const { version, evidence, workflow, ownedCounterevidence } = context;
  current(state, version, workflow); validateEvidence(evidence);
  text(input.sourceTurnId, 'Proposal source turn', 200); text(input.rationale, 'Plan-change rationale');
  if (input.parentPlanVersion !== state.current.id || input.sourceTurnId !== evidence.turnId) stale('A plan proposal must identify its exact current parent and saved source turn.');
  if (!['within_phase', 'reopen_phase'].includes(input.kind)) invalid('This kind of camera plan change is unsupported.');
  identityList(input.counterevidenceIds, 'Plan counterevidence', CAMERA_PLAN_LIMITS.counterevidence);
  if (!input.counterevidenceIds.length) invalid('A plan change needs named counterevidence rather than an ungrounded preference.');
  const counterevidence = input.counterevidenceIds.map(id => {
    const record = ownedCounterevidence.find(candidate => candidate.id === id);
    if (!record || record.version.runId !== version.runId || record.version.sceneEpoch !== version.sceneEpoch || record.version.factsHash !== version.factsHash
      || record.version.planVersion !== version.planVersion || record.version.revision > version.revision
      || !['contradicted', 'unresolved', 'reported_failure'].includes(record.status) || !/^[a-f0-9]{64}$/i.test(record.sha256))
      invalid('Plan counterevidence must be owned failed/unresolved evidence from this scene, facts and parent plan.');
    text(record.frameId, 'Counterevidence frame', 200);
    return structuredClone(record);
  });
  if (!Array.isArray(input.substeps) || input.substeps.length > CAMERA_PLAN_LIMITS.substepsPerPhase) invalid('A phase adaptation supports at most four bounded substeps.');
  if (input.kind === 'within_phase') {
    if (input.reopenStepId !== null || !input.substeps.length) invalid('A within-phase change needs bounded substeps and cannot also reopen another phase.');
  } else {
    if (!input.reopenStepId || input.substeps.length || phaseIndex(workflow, input.reopenStepId) >= phaseIndex(workflow, version.stepId))
      invalid('Reopening must name an earlier mandatory phase and cannot silently add or reorder phases.');
  }
  for (const step of input.substeps) {
    text(step.instruction, 'Substep instruction'); text(step.expectedVisibleResult, 'Substep expected result'); text(step.stopCondition, 'Substep stop condition');
    if (!Array.isArray(step.preconditions) || step.preconditions.length > 5) invalid('Substep preconditions must remain bounded.');
    step.preconditions.forEach(value => text(value, 'Substep precondition'));
  }
  const proposal: CameraPlanProposal = { ...structuredClone(input), id: `plan-change:${input.sourceTurnId}`, version: structuredClone(version),
    evidence: structuredClone(evidence), counterevidence, mandatoryObligations: state.current.mandatoryObligations, status: 'proposed' };
  const existing = state.proposals.find(item => item.id === proposal.id);
  if (existing) {
    const { status: _existingStatus, ...prior } = existing;
    const { status: _nextStatus, ...next } = proposal;
    if (canonical(prior) !== canonical(next)) invalid('The immutable proposal identity already belongs to different inputs.');
    return state;
  }
  if (state.proposals.length >= CAMERA_PLAN_LIMITS.proposals) throw new CameraPlanError('plan_limit', 'This run reached its bounded plan-proposal allowance. Review retained evidence before starting a deliberate new run.');
  return { ...state, proposals: [...state.proposals, proposal] };
}

/** Operator acceptance changes a versioned proposal, never confirms a physical result. */
export function approveCameraPlanChange(state: CameraPlanState, input: { proposalId: string; clientOperationId: string; operatorConfirmed: true;
  version: ReasoningVersion; workflow: WorkflowDefinition; completedStepIds: string[] }): CameraPlanApprovalResult {
  if (input.operatorConfirmed !== true) invalid('A camera plan change requires explicit operator acceptance.');
  text(input.clientOperationId, 'Approval operation identity', 200); text(input.proposalId, 'Proposal identity', 200); validateVersion(input.version);
  const requestIdentity = canonical({ proposalId: input.proposalId, version: input.version, operatorConfirmed: input.operatorConfirmed });
  const receipt = state.approvals.find(item => item.clientOperationId === input.clientOperationId);
  if (receipt) {
    if (receipt.requestIdentity !== requestIdentity) invalid('This approval operation identity belongs to different inputs.');
    return { replayed: true, state, approval: structuredClone(receipt) };
  }
  current(state, input.version, input.workflow); identityList(input.completedStepIds, 'Completed phases');
  const proposal = state.proposals.find(item => item.id === input.proposalId);
  if (!proposal || proposal.status !== 'proposed' || proposal.parentPlanVersion !== state.current.id
    || !sameProposalVersion(proposal.version, input.version) || proposal.mandatoryObligations !== state.current.mandatoryObligations)
    stale('The proposal was replaced or its state, facts, scene or plan changed. Request a fresh checked proposal.');
  if (state.history.length + 1 >= CAMERA_PLAN_LIMITS.versions) throw new CameraPlanError('plan_limit', 'The bounded plan-version history is full. No mandatory checks were discarded.');
  const currentIndex = phaseIndex(input.workflow, input.version.stepId);
  for (const id of input.completedStepIds) if (phaseIndex(input.workflow, id) >= currentIndex) invalid('Completed phase records cannot include the active or later phase.');
  const reopenIndex = proposal.kind === 'reopen_phase' ? phaseIndex(input.workflow, proposal.reopenStepId!) : currentIndex;
  const invalidatedStepIds = input.completedStepIds.filter(id => phaseIndex(input.workflow, id) >= reopenIndex);
  const retainedCompletedStepIds = input.completedStepIds.filter(id => !invalidatedStepIds.includes(id));
  const nextPhaseId = proposal.kind === 'reopen_phase' ? proposal.reopenStepId! : input.version.stepId;
  const nextId = `plan:${proposal.sourceTurnId}`;
  if ([state.current, ...state.history].some(item => item.id === nextId)) invalid('The next application plan identity already exists.');
  const substepsByPhase = structuredClone(state.current.substepsByPhase);
  if (proposal.kind === 'within_phase') substepsByPhase[nextPhaseId] = proposal.substeps.map((step, index) => ({ ...structuredClone(step),
    id: `substep:${proposal.sourceTurnId}:${index + 1}`, sourceProposalId: proposal.id }));
  else for (const step of input.workflow.steps.slice(reopenIndex)) delete substepsByPhase[step.id];
  const next: CameraPlanRecord = { id: nextId, parentId: state.current.id, mandatoryObligations: state.current.mandatoryObligations,
    version: { ...structuredClone(input.version), revision: input.version.revision + 1, stepId: nextPhaseId, planVersion: nextId }, substepsByPhase };
  const approval: CameraPlanApproval = { clientOperationId: input.clientOperationId, requestIdentity, proposalId: proposal.id,
    priorPlanId: state.current.id, nextPlanId: nextId, approvedVersion: structuredClone(input.version) };
  const updated: CameraPlanState = { ...state, current: next, history: [...state.history, structuredClone(state.current)],
    proposals: state.proposals.map(item => item.id === proposal.id ? { ...item, status: 'accepted' } : item), approvals: [...state.approvals, approval] };
  return { replayed: false, state: updated, approval, currentStepId: nextPhaseId, retainedCompletedStepIds, invalidatedStepIds, requiresFreshView: true };
}
