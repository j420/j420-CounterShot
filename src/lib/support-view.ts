import type { PlanStep } from "./contracts";

/** Project the same persistent support semantics used by the plan checker. */
export function effectiveSupportsAtStep(
  steps: PlanStep[],
  index: number,
): PlanStep["supportsDuring"] {
  const state = new Map<string, PlanStep["supportsDuring"]>();
  for (const [position, step] of steps.entries()) {
    for (const support of step.supportsDuring) {
      const previous = state.get(support.objectId) ?? [];
      if (
        !previous.some(
          (s) => s.provider === support.provider && s.role === support.role,
        )
      )
        state.set(support.objectId, [...previous, support]);
    }
    if (position === index) return [...state.values()].flat();
    const changes = new Map<string, PlanStep["supportsDuring"]>();
    for (const support of step.supportChangesAfter)
      changes.set(support.objectId, [
        ...(changes.get(support.objectId) ?? []),
        support,
      ]);
    for (const [object, supports] of changes) state.set(object, supports);
    for (const object of step.releaseObjectsAfter) state.delete(object);
  }
  return [];
}
