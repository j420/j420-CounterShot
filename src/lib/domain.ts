import {
  constraintsSchema,
  proposalSchema,
  trialInputSchema,
  type CheckReport,
  type Constraints,
  type Issue,
  type PlanStep,
  type Proposal,
  type Trial,
  type TrialInput,
} from "./contracts";

type Support = PlanStep["supportsDuring"][number];
const handName = (provider: Support["provider"]) =>
  provider === "right_hand"
    ? "right"
    : provider === "left_hand"
      ? "left"
      : null;

/** Checks declared resources and facts. It is not a stability or motion simulation. */
export function validatePlan(
  proposal: Proposal,
  constraints: Constraints,
): CheckReport {
  const issues: Issue[] = [];
  const add = (
    rule: string,
    message: string,
    actionId?: string,
    severity: Issue["severity"] = "error",
  ) =>
    issues.push({ rule, severity, message, ...(actionId ? { actionId } : {}) });
  const parsedConstraints = constraintsSchema.safeParse(constraints);
  const parsedProposal = proposalSchema.safeParse(proposal);
  if (!parsedConstraints.success || !parsedProposal.success) {
    for (const error of [
      ...(!parsedConstraints.success ? parsedConstraints.error.issues : []),
      ...(!parsedProposal.success ? parsedProposal.error.issues : []),
    ]) {
      add(
        "INPUT_SCHEMA",
        `${error.path.join(".") || "input"}: ${error.message}`,
      );
    }
    return { valid: false, issues };
  }
  const c = parsedConstraints.data;
  const p = parsedProposal.data;
  if (p.packageFamily !== c.packageFamily)
    add(
      "PACKAGE_FAMILY",
      "The proposal must use the confirmed package family.",
    );
  if (
    c.packageFamily === "tuck_carton" &&
    [c.cartonLengthMm, c.cartonWidthMm, c.cartonHeightMm].some(
      (v) => v === null,
    )
  ) {
    add(
      "CARTON_MEASUREMENTS",
      "Confirm all three usable interior carton dimensions before designing.",
    );
  }
  if (
    p.insert === "tray" &&
    p.insertWallHeightMm < c.cardboardThicknessMm * 2
  ) {
    add(
      "MATERIAL_FIT",
      "A tray needs a positive wall with enough material for the declared thickness; increase its wall height or choose a flat insert.",
    );
  }
  const byId = new Map<string, PlanStep>();
  for (const step of p.steps) {
    if (!step.id.trim() || byId.has(step.id))
      add("PLAN_ID", "Action IDs must be nonempty and unique.", step.id);
    byId.set(step.id, step);
  }
  for (const step of p.steps) {
    if (new Set(step.dependsOn).size !== step.dependsOn.length)
      add("PLAN_DEPENDENCY", "An action lists a dependency twice.", step.id);
    for (const dep of step.dependsOn) {
      if (dep === step.id || !byId.has(dep))
        add(
          "PLAN_DEPENDENCY",
          `Unresolved or self dependency: ${dep}.`,
          step.id,
        );
      else if (p.steps.findIndex((s) => s.id === dep) >= p.steps.indexOf(step))
        add(
          "PLAN_DISPLAY_ORDER",
          "Every dependency must appear earlier in the displayed operating sequence. Reorder the steps rather than relying on hidden topological sorting.",
          step.id,
        );
    }
  }
  // A deterministic topological order, preserving supplied order for independent actions.
  const ordered: PlanStep[] = [];
  const completed = new Set<string>();
  while (ordered.length < byId.size) {
    const next = p.steps.find(
      (s) => !completed.has(s.id) && s.dependsOn.every((d) => completed.has(d)),
    );
    if (!next) break;
    ordered.push(next);
    completed.add(next.id);
  }
  if (ordered.length !== byId.size)
    add(
      "PLAN_CYCLE",
      "Actions have a dependency cycle or unresolved dependency.",
    );
  const required: PlanStep["operation"][] = [
    "prepare",
    "load",
    "close",
    "release",
    "reset",
  ];
  if (p.packageFamily === "wraparound") required.splice(2, 0, "fold");
  for (const operation of required)
    if (!p.steps.some((s) => s.operation === operation))
      add(
        "PLAN_FULL_CYCLE",
        `The complete cycle is missing a ${operation} action.`,
      );
  const ancestors = (step: PlanStep, seen = new Set<string>()): Set<string> => {
    for (const id of step.dependsOn)
      if (!seen.has(id)) {
        seen.add(id);
        const parent = byId.get(id);
        if (parent) ancestors(parent, seen);
      }
    return seen;
  };
  let previous: PlanStep | undefined;
  for (const operation of required) {
    const step = ordered.find((s) => s.operation === operation);
    if (step && previous && !ancestors(step).has(previous.id))
      add(
        "PLAN_PHASE_DEPENDENCY",
        `${operation} must explicitly depend on the preceding ${previous.operation} stage.`,
        step.id,
      );
    if (step) previous = step;
  }
  if (ordered.length && ordered.at(-1)?.operation !== "reset")
    add(
      "PLAN_RESET",
      "The final action must leave the station ready for the next fresh package.",
    );

  const state = new Map<string, Support[]>();
  const closedObjectId = ordered.find(
    (s) => s.operation === "close",
  )?.activeObjectId;
  const permitted =
    c.activeHand === "both"
      ? new Set(["left", "right"])
      : new Set([c.activeHand]);
  const operationActions: Record<
    PlanStep["operation"],
    Constraints["allowedActions"][number][]
  > = {
    prepare: ["grasp"],
    position: ["grasp"],
    load: ["grasp"],
    fold: ["fold"],
    retain: ["grasp", "press"],
    close: ["press", "fold"],
    release: ["pull", "grasp"],
    reset: ["grasp"],
  };
  const verifySupport = (support: Support, step: PlanStep) => {
    const hand = handName(support.provider);
    if (hand && !permitted.has(hand))
      add(
        "PLAN_HAND",
        `The ${hand} hand is unavailable but is used as a persistent support.`,
        step.id,
      );
    if (support.provider === "insert" && p.insert === "none")
      add(
        "PLAN_SUPPORT",
        "The action relies on an insert that this design does not provide.",
        step.id,
      );
    if (!support.objectId.trim())
      add("PLAN_SUPPORT", "A support must identify its object.", step.id);
  };
  const checkCapacity = (step: PlanStep, includeActive: boolean) => {
    for (const hand of ["right", "left"] as const) {
      const held = new Set(
        [...state.entries()]
          .filter(([, supports]) =>
            supports.some((s) => handName(s.provider) === hand),
          )
          .map(([object]) => object),
      );
      if (
        includeActive &&
        (step.activeHand === hand || step.activeHand === "both") &&
        step.activeObjectId.trim()
      )
        held.add(step.activeObjectId);
      if (held.size > 1)
        add(
          "PLAN_HAND_CONFLICT",
          `The ${hand} hand is assigned simultaneous duties for ${[...held].join(", ")}. Transfer the held object to a fixture in an earlier action.`,
          step.id,
        );
    }
  };
  for (const step of ordered) {
    if (step.activeHand !== "none" && !step.activeObjectId.trim())
      add(
        "PLAN_ACTIVE_OBJECT",
        "An active manipulation must identify the object being acted on.",
        step.id,
      );
    if (
      !Number.isFinite(step.xMm) ||
      !Number.isFinite(step.yMm) ||
      step.xMm < 0 ||
      step.yMm < 0 ||
      step.xMm > c.workspaceWidthMm ||
      step.yMm > c.workspaceDepthMm
    ) {
      add(
        "PLAN_REACH",
        "The declared action point is outside the confirmed workspace rectangle.",
        step.id,
      );
    }
    if (step.activeHand === "both" && c.activeHand !== "both")
      add("PLAN_HAND", "This action requires both hands.", step.id);
    if (
      step.activeHand !== "none" &&
      step.activeHand !== "both" &&
      !permitted.has(step.activeHand)
    )
      add("PLAN_HAND", `The ${step.activeHand} hand is unavailable.`, step.id);
    if (
      step.activeHand === "none" &&
      !["retain", "reset"].includes(step.operation)
    )
      add(
        "PLAN_HAND",
        "A physical manipulation cannot silently use no hand.",
        step.id,
      );
    if (
      step.activeHand !== "none" &&
      !operationActions[step.operation].some((a) =>
        c.allowedActions.includes(a),
      )
    )
      add(
        "PLAN_CAPABILITY",
        `No declared permitted action supports ${step.operation}.`,
        step.id,
      );
    for (const support of step.supportsDuring) {
      verifySupport(support, step);
      const previousSupports = state.get(support.objectId) ?? [];
      if (
        !previousSupports.some(
          (s) => s.provider === support.provider && s.role === support.role,
        )
      )
        state.set(support.objectId, [...previousSupports, support]);
    }
    if (
      closedObjectId &&
      ["load", "fold", "close"].includes(step.operation) &&
      !state.get(closedObjectId)?.length
    ) {
      add(
        "PLAN_MISSING_SUPPORT",
        `The parcel ${closedObjectId} has no declared support during ${step.operation}. Explicitly state its continuous holding duty.`,
        step.id,
      );
    }
    checkCapacity(step, true);
    const changes = new Map<string, Support[]>();
    for (const support of step.supportChangesAfter) {
      verifySupport(support, step);
      changes.set(support.objectId, [
        ...(changes.get(support.objectId) ?? []),
        support,
      ]);
    }
    for (const [object, supports] of changes) state.set(object, supports);
    for (const object of step.releaseObjectsAfter) {
      if (changes.has(object))
        add(
          "PLAN_EFFECT_CONFLICT",
          "An object is both assigned support and released in the same after-state.",
          step.id,
        );
      state.delete(object);
    }
    checkCapacity(step, false);
    for (const assumption of step.physicalAssumptions)
      add("PHYSICAL_ASSUMPTION", assumption, step.id, "trial_required");
  }
  const releaseSteps = ordered.filter((s) => s.operation === "release");
  if (
    releaseSteps.length &&
    !releaseSteps.some((s) => s.releaseObjectsAfter.length > 0)
  )
    add(
      "PLAN_RELEASE",
      "The release action must explicitly remove the parcel/object from its declared restraints.",
    );
  const closedObject = closedObjectId;
  if (
    closedObject &&
    !releaseSteps.some((s) => s.releaseObjectsAfter.includes(closedObject))
  )
    add(
      "PLAN_RELEASE",
      `The closed parcel ${closedObject} must be explicitly released. The close action must name the complete parcel, not merely its tape or tab.`,
    );
  for (const [object, supports] of state)
    if (supports.some((s) => handName(s.provider)))
      add(
        "PLAN_RESET",
        `The final state still consumes a hand holding ${object}.`,
      );
  const released = new Set(releaseSteps.flatMap((s) => s.releaseObjectsAfter));
  for (const object of released)
    if (state.get(object)?.some((s) => s.provider === "station"))
      add(
        "PLAN_RELEASE",
        `${object} remains assigned to the station after its release.`,
      );
  for (const assumption of p.assumptions)
    add("PHYSICAL_ASSUMPTION", assumption, undefined, "trial_required");
  add(
    "PHYSICAL_PROOF",
    "Symbolic consistency does not prove force, friction, stability, flap clearance, accessible release or comfortable reach. Test the complete fresh-package cycle on the actual materials.",
    undefined,
    "trial_required",
  );
  return { valid: !issues.some((i) => i.severity === "error"), issues };
}

/**
 * Backend must first resolve assetIds to validated, project-owned trial video assets.
 * Nonempty strings are not proof of an uploaded video. Never expose this as a client verdict.
 */
export function deriveTrialOutcome(input: TrialInput): Trial["outcome"] {
  if (!trialInputSchema.safeParse(input).success) return "incomplete";
  if (
    !input.buildConfirmed ||
    !input.scaleConfirmed ||
    !input.materialMatches ||
    !input.evidenceComplete ||
    !input.assetIds.length
  )
    return "incomplete";
  if (
    input.helperInterventions > 0 ||
    !input.contentsCorrect ||
    !input.closureComplete ||
    !input.parcelReleased ||
    !input.stationReset ||
    !input.freshPackageStarted
  )
    return "failed";
  return "observed_complete";
}
