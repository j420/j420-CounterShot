import { get, hash, replace, transaction } from '../storage/db';
import { MetaError } from '../meta/client';
import { assertExecutionCanContinue, createExecutionBudget, DEFAULT_CAMERA_EXECUTION_LIMITS,
  mergeExecutionBudgets } from '../meta/budget';
import type { ExecutionBinding } from '../meta/execution';
import { CAMERA_ENGINE_VERSION, CAMERA_SCHEMA_VERSION, type CameraRequestChecksVersion } from './schema';
import { cameraWorkflow } from './workflows';
import type { StoredCameraSession, StoredCameraTurn } from './server';

export type CameraExecutionScope = {
  runId: string; turnId: string; revision: number; stepId: string; sceneEpoch: number;
  factsHash: string; planVersion: string; checksVersion: CameraRequestChecksVersion;
};

/** Apply at every paid-call boundary and before an owned evidence transform. */
export function assertCameraExecutionCurrent(scope: CameraExecutionScope) {
  const session = get<StoredCameraSession>('camera_sessions', scope.runId);
  const turn = get<StoredCameraTurn>('camera_turns', scope.turnId);
  const workflow = session ? cameraWorkflow(session.workflowId) : null;
  if (!session || !turn || turn.projectId !== scope.runId || turn.status !== 'pending'
    || session.activeTurnId !== scope.turnId || session.status !== 'active'
    || session.revision !== scope.revision || session.currentStepId !== scope.stepId || session.sceneEpoch !== scope.sceneEpoch
    || session.plan?.current.id !== scope.planVersion || hash(session.facts) !== scope.factsHash
    || !session.workflowSpec || session.workflowSpec.schemaVersion !== CAMERA_SCHEMA_VERSION
    || session.workflowSpec.engineVersion !== CAMERA_ENGINE_VERSION || !workflow
    || hash(workflow) !== scope.checksVersion.workflowHash || hash(session.workflowSpec.definition) !== scope.checksVersion.workflowHash
    || hash(turn.checksVersion) !== hash(scope.checksVersion)
    || Date.now() - Date.parse(turn.createdAt) >= 5 * 60_000)
    throw new MetaError('This camera decision changed or expired before further work. Retrieve its saved history and start a deliberate current check.', 'cancelled');
  if (session.executionBudget) assertExecutionCanContinue(session.executionBudget);
}

/** Resets and human waits retain this run's allowance; late callbacks merge, never replace it. */
export function executionForCamera(scope: CameraExecutionScope): ExecutionBinding {
  const budget = transaction(() => {
    assertCameraExecutionCurrent(scope);
    const session = get<StoredCameraSession>('camera_sessions', scope.runId)!;
    if (!session.executionBudget) {
      session.executionBudget = createExecutionBudget(scope.runId, DEFAULT_CAMERA_EXECUTION_LIMITS);
      replace('camera_sessions', session);
    }
    return session.executionBudget;
  });
  return { budget, onBudget: async (incoming, checkpoint) => {
    const merged = transaction(() => {
      const session = get<StoredCameraSession>('camera_sessions', scope.runId);
      if (!session) throw new MetaError('The camera run no longer exists.', 'cancelled');
      session.executionBudget = mergeExecutionBudgets(session.executionBudget || budget, incoming);
      replace('camera_sessions', session);
      return session.executionBudget;
    });
    // Responses remain accounted after cancellation/reset. Only future work is fenced.
    if (checkpoint === 'reserve' || checkpoint === 'tool_reserve' || checkpoint === 'preflight') assertCameraExecutionCurrent(scope);
    return merged;
  } };
}
