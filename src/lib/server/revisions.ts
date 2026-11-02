import type { CompiledDesign, Proposal } from "../contracts";
import { hash } from "./store";

/** Compares declared hardware and executable semantics; prose and renamed IDs add no new result. */
export function designFingerprint(
  proposal: Proposal,
  compiled: CompiledDesign,
): string {
  const stepIndex = new Map(
    proposal.steps.map((step, index) => [step.id, index]),
  );
  const objects = new Map<string, number>();
  const object = (id: string) => {
    if (!objects.has(id)) objects.set(id, objects.size);
    return objects.get(id)!;
  };
  const ancestorIndices = (
    index: number,
    seen = new Set<number>(),
  ): number[] => {
    for (const dependency of proposal.steps[index].dependsOn) {
      const parent = stepIndex.get(dependency);
      if (parent !== undefined && !seen.has(parent)) {
        seen.add(parent);
        ancestorIndices(parent, seen);
      }
    }
    return [...seen].sort((a, b) => a - b);
  };
  const supportList = (supports: Proposal["steps"][number]["supportsDuring"]) =>
    supports
      .map((s) => ({
        object: object(s.objectId),
        provider: s.provider,
        role: s.role,
      }))
      .sort(
        (a, b) =>
          a.object - b.object ||
          a.provider.localeCompare(b.provider) ||
          a.role.localeCompare(b.role),
      );
  const steps = proposal.steps.map((step, index) => ({
    operation: step.operation,
    activeHand: step.activeHand,
    activeObject: object(step.activeObjectId),
    ancestors: ancestorIndices(index),
    supportsDuring: supportList(step.supportsDuring),
    supportChangesAfter: supportList(step.supportChangesAfter),
    releaseObjectsAfter: step.releaseObjectsAfter
      .map(object)
      .sort((a, b) => a - b),
    xMm: step.xMm,
    yMm: step.yMm,
  }));
  return hash({
    hardware: {
      family: proposal.packageFamily,
      arrangement: proposal.arrangement,
      insert: proposal.insert,
      orientation: proposal.orientation,
      clearanceMm: proposal.clearanceMm,
      insertWallHeightMm: proposal.insertWallHeightMm,
      stopHeightMm: proposal.stopHeightMm,
      stationXMm: proposal.stationXMm,
      stationYMm: proposal.stationYMm,
      sharedDimensions: compiled.sharedDimensions,
      cutList: compiled.cutList.map((p) => ({
        quantity: p.quantity,
        widthMm: p.widthMm,
        heightMm: p.heightMm,
        material: p.material,
      })),
    },
    steps,
  });
}
