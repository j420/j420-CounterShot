import type { Constraints, PlanStep, Proposal } from "../src/lib/contracts";

export function makeConstraints(
  overrides: Partial<Constraints> = {},
): Constraints {
  return {
    activeHand: "right",
    allowedActions: ["grasp", "press", "pull", "fold", "palm_support"],
    workspaceWidthMm: 800,
    workspaceDepthMm: 650,
    itemLengthMm: 180,
    itemWidthMm: 120,
    itemHeightMm: 18,
    cardboardThicknessMm: 1.5,
    sheetWidthMm: 1000,
    sheetHeightMm: 1000,
    packageFamily: "wraparound",
    cartonLengthMm: null,
    cartonWidthMm: null,
    cartonHeightMm: null,
    measurementsConfirmed: true,
    notes: "Synthetic software fixture; not physical admission evidence.",
    ...overrides,
  };
}

function step(
  id: string,
  operation: PlanStep["operation"],
  label: string,
  previous: string | null,
  overrides: Partial<PlanStep> = {},
): PlanStep {
  return {
    id,
    label,
    instruction: label,
    operation,
    dependsOn: previous ? [previous] : [],
    activeHand: "right",
    activeObjectId: "package",
    supportsDuring: [
      { objectId: "package", provider: "table", role: "weight" },
    ],
    supportChangesAfter: [],
    releaseObjectsAfter: [],
    xMm: 180,
    yMm: 180,
    physicalAssumptions: [
      "Stability and clearance require a real physical trial.",
    ],
    ...overrides,
  };
}

/** A complete synthetic cycle; fixtures never imply physical success. */
export function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  const steps: PlanStep[] = [
    step(
      "prepare",
      "prepare",
      "Take a fresh wrap blank from the supply.",
      null,
    ),
    step(
      "position",
      "position",
      "Locate the blank and insert against exterior stops.",
      "prepare",
      {
        supportChangesAfter: [
          { objectId: "package", provider: "table", role: "weight" },
          { objectId: "package", provider: "station", role: "locate" },
        ],
      },
    ),
    step(
      "load",
      "load",
      "Place the notebook and card in the retaining insert.",
      "position",
      {
        activeObjectId: "contents",
        supportsDuring: [
          { objectId: "package", provider: "station", role: "locate" },
        ],
        supportChangesAfter: [
          { objectId: "contents", provider: "insert", role: "retain" },
        ],
      },
    ),
    step(
      "fold",
      "fold",
      "Fold the accessible wrap panels around the supported contents.",
      "load",
      {
        supportsDuring: [
          { objectId: "package", provider: "station", role: "locate" },
          { objectId: "contents", provider: "insert", role: "retain" },
        ],
      },
    ),
    step(
      "retain",
      "retain",
      "Use the exterior stop to retain the folded panels.",
      "fold",
      {
        supportChangesAfter: [
          { objectId: "package", provider: "table", role: "weight" },
          { objectId: "package", provider: "station", role: "resist_push" },
        ],
      },
    ),
    step("close", "close", "Complete the declared wrap closure.", "retain", {
      supportsDuring: [
        { objectId: "package", provider: "station", role: "resist_push" },
      ],
    }),
    step(
      "release",
      "release",
      "Remove the finished parcel from the exterior supports.",
      "close",
      {
        releaseObjectsAfter: ["package", "contents"],
      },
    ),
    step(
      "reset",
      "reset",
      "Restore the station for the next unused blank.",
      "release",
      {
        activeObjectId: "station",
        supportsDuring: [
          { objectId: "station", provider: "table", role: "weight" },
        ],
      },
    ),
  ];

  return {
    title: "Synthetic complete wrap cycle",
    summary:
      "Software fixture for a bounded insert and exterior support arrangement.",
    originalConflict:
      "Holding a package while loading contents competes for the declared hand.",
    packageFamily: "wraparound",
    arrangement: "corner_nest",
    insert: "tray",
    orientation: "landscape",
    clearanceMm: 4,
    insertWallHeightMm: 12,
    stopHeightMm: 20,
    stationXMm: 20,
    stationYMm: 20,
    steps,
    changes: [
      {
        layer: "package",
        change: "Retain contents in a measured insert.",
        reason: "Reduce a declared holding duty.",
      },
      {
        layer: "workspace",
        change: "Use exterior registration stops.",
        reason: "Transfer positioning support to the station.",
      },
      {
        layer: "sequence",
        change: "Load before folding and release before reset.",
        reason: "Keep the full cycle explicit.",
      },
    ],
    assumptions: [
      "Friction, fold access and extraction have not been physically tested.",
    ],
    materials: ["Measured cardboard", "Declared closure"],
    nextTest:
      "Run fresh-package loading through release and reset without operating assistance.",
    simplerAlternative:
      "Compare a pre-creased wrap with an ordinary exterior holder.",
    ...overrides,
  };
}
