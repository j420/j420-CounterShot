import type { Action, LegacyFacts as Facts, Observation, LegacyProposal as Proposal, WorkshopFacts, JigAction, Proposal as AnyProposal } from "./schema";
import { getKitCells, resolveDimensions } from "../geometry";

/** Synthetic walkthrough data. No footage, measured capability or physical pass is implied. */
export const demoFacts: Facts = {
  workflow: "carton_packing",
  itemLengthMm: 148, itemWidthMm: 105, itemHeightMm: 12,
  cartonLengthMm: 180, cartonWidthMm: 135, cartonHeightMm: 35,
  cartonOuterLengthMm: 194, cartonOuterWidthMm: 149,
  boardThicknessMm: 1.5, sheetWidthMm: 420, sheetHeightMm: 297,
  slotClearanceMm: 0.5, foldAllowanceMm: 0,
  workspaceWidthMm: 600, workspaceDepthMm: 450,
  reachWidthMm: 550, reachDepthMm: 400,
  activeHand: "right", allowedBodySupports: "None. Table and declared passive cardboard fixtures only.",
  allowedOperations: ["take", "position", "load", "fold", "close", "release", "reset"],
  kitComponents: [],
  closure: "Existing top-opening hinged-lid tuck carton; actual one-handed tuck action requires a trial.",
  notes: "Synthetic example: notebook-sized bundle including its accompanying card. All measurements and capabilities must be replaced and confirmed for a real project.",
};

const action = (id: string, label: string, objectId: string, operation: Action["operation"], previous: string | null, holdAfter: string | null, supportAfter: string | null, xMm = 150, yMm = 130): Action => ({
  id, label, objectId, operation, dependsOn: previous ? [previous] : [], hand: "active", holdAfter, supportAfter, xMm, yMm, quantity: null, compartmentId: null,
});

export const demoProposal: Proposal = {
  outcome: "candidate",
  jigProgram: null,
  title: "A place for the parcel. A free hand for the next step.",
  summary: "A shallow retaining tray travels inside an existing tuck carton. Two exterior registration stops locate the carton while the operator loads and closes it. This is a synthetic, untested construction hypothesis.",
  rationale: "Transfer lateral registration to the exterior stops and content location to a tray, while keeping the lid side and forward extraction route clear. Compare against a carton with ordinary table support before accepting the extra material.",
  missingFacts: [],
  program: { strategy: "corner_stops", insertClearanceMm: 2, wallHeightMm: 15, stopHeightMm: 12, offsetXMm: 90, offsetYMm: 60, kitLayout: null },
  actions: [
    action("take-carton", "Take a fresh, open carton from the agreed supply", "carton", "take", null, "carton", null, 60, 100),
    action("place-carton", "Locate the carton against exterior stops and transfer it to the station", "carton", "position", "take-carton", null, "station"),
    action("take-insert", "Take a prepared retaining tray from supply", "insert", "take", "place-carton", "insert", null, 60, 160),
    action("place-insert", "Place the tray inside the carton; leave the lid and extraction path clear", "insert", "position", "take-insert", null, "carton"),
    action("take-item", "Take the notebook-sized item", "item", "take", "place-insert", "item", null, 60, 220),
    action("load-item", "Lower the item into the retaining tray and release the hand", "item", "load", "take-item", null, "insert"),
    action("take-card", "Take the accompanying loose card", "card", "take", "load-item", "card", null, 60, 260),
    action("load-card", "Place the card with the item inside the carton", "card", "load", "take-card", null, "carton"),
    action("close-carton", "Close and tuck the actual lid while the exterior stops locate the carton", "carton", "close", "load-card", null, "station"),
    action("take-finished", "Lift the completed parcel clear of both exterior stops", "carton", "take", "close-carton", "carton", null),
    action("release-finished", "Place and release the finished parcel in the finished area", "carton", "release", "take-finished", null, "finished_area", 390, 160),
    action("reset-station", "Inspect and reset the empty station; make the next carton accessible", "station", "reset", "release-finished", null, "table"),
  ],
  assumptions: [
    "The open carton can be loaded from fresh supply and its lid can close without stop interference.",
    "Actual tuck force and fixture friction permit closure using only the declared active hand.",
    "The finished parcel can be lifted without snagging or trapping a fixture; the operator can then reset independently.",
    "The shallow tray adds a measurable benefit over an ordinary supported carton; this has not been demonstrated.",
  ],
  changes: [],
};

export const demoObservation: Observation = {
  summary: "Synthetic walkthrough: placing contents while holding packaging may compete for the same hand. No uploaded footage has been analyzed in this example.",
  entities: [
    { id: "carton", label: "Existing tuck carton", description: "Measured top-opening hinged-lid carton; exact flap behavior is a physical prerequisite." },
    { id: "item", label: "Notebook-sized item", description: "Robust lightweight example bundle." },
    { id: "card", label: "Accompanying card", description: "Loose card to include with the item." },
  ],
  actions: [
    { id: "example-hold", label: "Hold the packaging in place", startMs: null, endMs: null, support: "Active hand, hypothesized", uncertain: true },
    { id: "example-load", label: "Place the item while packaging stays located", startMs: null, endMs: null, support: "Unknown until the real clip is reviewed", uncertain: true },
  ],
  conflicts: [{ description: "A persistent packaging hold could occupy the hand needed to load the item.", evidence: "Illustrative hypothesis only; not an observed conflict." }],
  questions: ["Can a simple existing carton on an ordinary supported surface already solve the task?", "What is the actual fresh-package, closure, release and reset sequence?"],
  evidenceCompleteness: "incomplete",
  missingSegments: ["All original footage", "Physical construction", "Complete operating trial"],
};

/** Synthetic mechanical-component example; no observed operation or physical pass. */
export const kitFacts: Facts = {
  ...demoFacts,
  workflow: "electronics_kit",
  itemLengthMm: null, itemWidthMm: null, itemHeightMm: null,
  cartonLengthMm: 130, cartonWidthMm: 110, cartonHeightMm: 35,
  cartonOuterLengthMm: 144, cartonOuterWidthMm: 124,
  kitComponents: [
    { id: "screws", label: "Screws", requiredCount: 4, bundleLengthMm: 35, bundleWidthMm: 25, bundleHeightMm: 8 },
    { id: "washers", label: "Washers", requiredCount: 4, bundleLengthMm: 30, bundleWidthMm: 25, bundleHeightMm: 6 },
    { id: "spacers", label: "Spacers", requiredCount: 2, bundleLengthMm: 30, bundleWidthMm: 25, bundleHeightMm: 12 },
    { id: "grommets", label: "Grommets", requiredCount: 2, bundleLengthMm: 35, bundleWidthMm: 30, bundleHeightMm: 10 },
  ],
  notes: "Synthetic one-handed repair-kit fulfilment. Each inert mechanical component starts loose in separately labelled bulk supply. The maker supplies one fresh pre-erected open carton and a prepared EMPTY/open four-cell insert; no parts are pre-counted or loaded by a helper. Each group envelope is the measured envelope of the exact target quantity, not a single part multiplied. An appropriately sized inventory slip is supplied. Replace and confirm all example measurements before a real build. No ESD or electrical-protection claim.",
};

export const kitProposal: Proposal = {
  outcome: "candidate",
  jigProgram: null,
  title: "Every part counted. Every well closed.",
  summary: "Four independently labelled, hinged-lid cardboard cells travel inside a shared carrier tray. Exterior stops locate the existing carton while one hand loads each loose mechanical part and closes each completed cell. This synthetic design is physically untested.",
  rationale: "Give screws, washers, spacers and grommets separate measured cells, close each group after its exact count, and keep the parcel located without consuming the hand. The arrangement couples target-group dimensions, compartment mapping, local closure access and the action sequence. Compare against a simple commercial organiser before accepting custom material and construction effort.",
  missingFacts: [],
  program: {
    strategy: "corner_stops", insertClearanceMm: 2, wallHeightMm: 12, stopHeightMm: 12,
    offsetXMm: 90, offsetYMm: 60,
    kitLayout: { columns: 2, cellOrder: ["screws", "washers", "spacers", "grommets"], cellClearanceMm: 2, dividerHeightMm: 18 },
  },
  actions: [],
  assumptions: [
    "The actual small components can be taken individually with the declared hand; no hidden pre-counted batches or helper preload are assumed.",
    "Each cell keeps parts separated while another cell is open and while neighbouring lids sweep through closure.",
    "The actual material, scored hinges and top-accessible local tuck locks permit one-handed closure without moving the carton or spilling parts.",
    "The prepared empty/open cell assembly enters fresh packaging without snagging, and all fixtures remain exterior during parcel extraction and reset.",
    "The symbolic counts require human inspection of actual quantities and matching labels. This prototype establishes no ESD, electrical compatibility, repair performance or transport protection.",
  ],
  changes: [],
};

// Generate the illustrative sequence from the same shared cell placement graph as
// the drawings. This is deterministic fixture data, never an actual model result.
{
  const p = kitProposal.program;
  const d = resolveDimensions(kitFacts, kitProposal);
  const cartonX = p.offsetXMm + d.footDepthMm + d.registrationGapMm;
  const cartonY = p.offsetYMm + d.footDepthMm + d.registrationGapMm;
  const cartonTargetX = cartonX + kitFacts.cartonOuterLengthMm / 2;
  const cartonTargetY = cartonY + kitFacts.cartonOuterWidthMm / 2;
  const insertX = cartonX + (kitFacts.cartonOuterLengthMm - d.trayOuterLengthMm) / 2 + kitFacts.boardThicknessMm;
  const insertY = cartonY + (kitFacts.cartonOuterWidthMm - d.trayOuterWidthMm) / 2 + kitFacts.boardThicknessMm;
  let previous: string | null = null;
  const add = (id: string, label: string, objectId: string, operation: Action["operation"], holdAfter: string | null, supportAfter: string | null, xMm: number, yMm: number, quantity: number | null = null, compartmentId: string | null = null) => {
    kitProposal.actions.push({ ...action(id, label, objectId, operation, previous, holdAfter, supportAfter, xMm, yMm), quantity, compartmentId });
    previous = id;
  };
  add("take-carton", "Take a fresh pre-erected open carton from supply", "carton", "take", "carton", null, 55, 80);
  add("place-carton", "Locate the carton on exterior stops and release the hand", "carton", "position", null, "station", cartonTargetX, cartonTargetY);
  add("take-insert", "Take the prepared EMPTY carrier with all four cells open and labelled", "insert", "take", "insert", null, 55, 130);
  add("place-insert", "Place the empty four-cell carrier inside the carton", "insert", "position", null, "carton", cartonTargetX, cartonTargetY);
  const cells = getKitCells(kitFacts, kitProposal);
  for (const [index, cell] of cells.entries()) {
    const group = kitFacts.kitComponents.find(component => component.id === cell.componentId)!;
    const x = insertX + cell.xMm + cell.outerLengthMm / 2;
    const y = insertY + cell.yMm + cell.outerWidthMm / 2;
    for (let count = 1; count <= group.requiredCount; count++) {
      add(`take-${group.id}-${count}`, `Take one ${group.label.toLowerCase()} component (${count} of ${group.requiredCount}) from its labelled loose supply`, group.id, "take", group.id, null, 55, 180 + 45 * index, 1, group.id);
      add(`load-${group.id}-${count}`, `Load that single component into the ${group.label} well; release the hand`, group.id, "load", null, `compartment_${group.id}`, x, y, 1, group.id);
    }
    add(`close-${group.id}`, `Inspect ${group.requiredCount} ${group.label.toLowerCase()}, then close only this cell's hinged lid and tuck lock`, `compartment_${group.id}`, "close", null, "insert", x, y, null, group.id);
  }
  add("take-inventory-slip", "Take the appropriately sized inventory slip from supply", "card", "take", "card", null, 55, 370);
  add("load-inventory-slip", "Place the inventory slip inside the carton with the four closed cells", "card", "load", null, "carton", cartonTargetX, cartonTargetY);
  add("close-carton", "Close the outer carton only after all four local closures and the slip are complete", "carton", "close", null, "station", cartonTargetX, cartonTargetY);
  add("take-finished", "Lift the finished kit clear of the exterior stops", "carton", "take", "carton", null, cartonTargetX, cartonTargetY);
  add("release-finished", "Release the completed kit in the finished area", "carton", "release", null, "finished_area", 440, 220);
  add("reset-station", "Reset the empty station and make the next fresh carton, empty carrier and loose parts accessible", "station", "reset", null, "table", cartonTargetX, cartonTargetY);
}

export const kitObservation: Observation = {
  summary: "Synthetic walkthrough: fulfil a repair kit from loose screws, washers, spacers and grommets using one available hand. The example illustrates quantity and segregation risks; no real operation or physical success has been observed.",
  entities: [
    ...kitFacts.kitComponents.map(group => ({ id: group.id, label: group.label, description: `Loose supply; target ${group.requiredCount} components in its own labelled cell. Counts and complete-group envelope require actual confirmation.` })),
    { id: "insert", label: "Prepared empty four-cell insert", description: "All four local cells start empty and open. Construction/preparation is declared separately from fulfilment." },
    { id: "card", label: "Inventory slip", description: "Appropriately sized paper slip supplied for this kit." },
    { id: "carton", label: "Existing dispatch carton", description: "Measured pre-erected open top-opening tuck carton." },
  ],
  actions: [
    { id: "pick-loose-part", label: "Take an individual component from its labelled supply", startMs: null, endMs: null, support: "Synthetic proposed hand action", uncertain: true },
    { id: "load-and-close", label: "Keep one group separate, verify its count and close that cell before dispatch", startMs: null, endMs: null, support: "Unverified proposed insert support", uncertain: true },
  ],
  conflicts: [{ description: "Small parts may roll or mix while a hand handles another component or closes a neighbouring lid.", evidence: "Illustrative hypothesis only; actual task video and trials are required." }],
  questions: ["What are the exact four required counts and the actual full-group envelopes?", "Can the operator pick each loose part and close each local lid with the declared hand?", "Does a simple commercial organiser already solve this job?"],
  evidenceCompleteness: "incomplete",
  missingSegments: ["Actual source footage", "Measured part groups and materials", "Physical construction", "Complete fulfilment, closure, extraction and reset trial"],
};

/** Synthetic low-force assembly hypothesis, never measured prototype evidence. */
export const workshopFacts: WorkshopFacts = {
  workflow: "workshop_jig",
  boardThicknessMm: 2, sheetWidthMm: 420, sheetHeightMm: 297,
  slotClearanceMm: 0.5, foldAllowanceMm: 0,
  workspaceWidthMm: 600, workspaceDepthMm: 450,
  reachWidthMm: 550, reachDepthMm: 400,
  activeHand: "right",
  allowedBodySupports: "None. Only the declared table, jig baseplate, outside braces and removable gate may support workpieces.",
  allowedOperations: ["take", "locate", "join", "engage_support", "release_support", "park_support", "extract", "place_finished", "reset"],
  notes: "SYNTHETIC EXAMPLE. Six loose user-supplied pre-cut panels form a low-force interlocking instrument enclosure. Panel dimensions and joint access windows must be confirmed from an actual part set. Completed-joint self-retention is an illustrative declared assumption, not an observed pass. No cutting, drilling, adhesive curing, high-force pressing or powered work is supported. The supplied workpiece is not generated by this jig compiler.",
  workpieceWidthMm: 160, workpieceDepthMm: 110, workpieceHeightMm: 75,
  panelThicknessMm: 3, jointInsertionMm: 5,
  maximumAssemblyLiftMm: 8, alignmentToleranceMm: 1,
  releaseDirection: "front", jointFamily: "low_force_interlocking_panels",
  completedJointsSelfRetain: true,
  jointZones: [
    { edge: "left", startMm: 30, endMm: 65, bottomMm: 8, topMm: 30 },
    { edge: "right", startMm: 35, endMm: 65, bottomMm: 8, topMm: 30 },
    { edge: "rear", startMm: 65, endMm: 95, bottomMm: 8, topMm: 30 },
    { edge: "front", startMm: 40, endMm: 80, bottomMm: 12, topMm: 30 },
  ],
};

const jigActions: JigAction[] = [];
let lastJigAction: string | null = null;
const jigStep = (id: string, label: string, operation: JigAction["operation"], partId: string, supportIds: string[], xMm: number, yMm: number, hand: JigAction["hand"] = "active") => {
  jigActions.push({ id, label, operation, partId, supportIds, dependsOn: lastJigAction ? [lastJigAction] : [], hand, xMm, yMm });
  lastJigAction = id;
};
jigStep("take-base", "Take the loose pre-cut enclosure base panel from supply", "take", "base", ["supply"], 40, 60);
jigStep("locate-base", "Slide the base onto the jig baseplate while the removable front gate remains parked", "locate", "base", ["baseplate"], 180, 255);
jigStep("engage-front-gate", "Bring the parked gate into its front registration position after the base is located", "engage_support", "gate", ["front_gate"], 180, 189.5);
for (const [partId, label, supportIds, x, y, supplyY] of [
  ["left_wall", "left wall", ["left_front", "left_rear"], 100, 255, 110],
  ["right_wall", "right wall", ["right_front", "right_rear"], 260, 255, 160],
  ["rear_wall", "rear wall", ["rear_left", "rear_right"], 180, 310, 210],
  ["front_wall", "front wall", ["front_gate"], 180, 200, 260],
] as const) {
  jigStep(`take-${partId}`, `Take the loose pre-cut ${label}`, "take", partId, ["supply"], 40, supplyY);
  jigStep(`locate-${partId}`, `Locate the ${label} against its named exterior braces without covering the measured joint window`, "locate", partId, [...supportIds], x, y);
  jigStep(`join-${partId}`, `Complete the declared low-force ${label}-to-base joints while the jig carries its holding duty`, "join", partId, [...supportIds], x, y);
}
jigStep("take-lid", "Take the loose pre-cut lid after all four walls are joined", "take", "lid", ["supply"], 40, 310);
jigStep("locate-lid", "Locate the lid on the joined walls", "locate", "lid", ["assembly"], 180, 255);
jigStep("join-lid", "Complete the lid joints; the declared finished joints must self-retain before any support is removed", "join", "lid", ["assembly"], 180, 255);
jigStep("release-front-gate", "Disengage and hold the removable front gate only after all six supplied panels are joined", "release_support", "gate", ["front_gate"], 180, 189.5);
jigStep("park-front-gate", "Place the gate in its separate measured parking area and free the hand", "park_support", "gate", ["front_gate"], 440.5, 90);
jigStep("extract-assembly", "Take the complete self-retaining enclosure and slide it forward through the now-open release corridor", "extract", "assembly", [], 180, 255);
jigStep("place-finished", "Place the finished enclosure outside the jig, gate parking area and front release corridor", "place_finished", "assembly", ["finished_area"], 450, 300);
jigStep("reset-jig", "Inspect the empty jig, verify the gate remains parked and make the next loose panel set accessible", "reset", "jig", ["baseplate"], 180, 255, "none");

export const workshopProposal: AnyProposal = {
  outcome: "candidate",
  title: "Let the jig hold the walls. Keep the hand for the joints.",
  summary: "Split exterior cardboard braces locate a supplied six-panel enclosure while leaving its measured joint windows open. A relieved front gate carries the front wall's holding duty, then disengages and parks before forward extraction. This is a synthetic, unadmitted assembly hypothesis.",
  rationale: "Separate holding and alignment from the active hand's joining operations. Compose short braces outside actual insertion windows instead of surrounding the workpiece with an obstructing continuous cradle. Remove the front support only after the completed joints are declared self-retaining, preserving a complete loose-parts-to-finished-output-and-reset cycle.",
  missingFacts: [],
  program: null,
  actions: [],
  jigProgram: {
    baseWidthMm: 240, baseDepthMm: 190, offsetXMm: 60, offsetYMm: 160,
    registrationClearanceMm: 0.5,
    supports: [
      { id: "left_front", edge: "left", startMm: 0, lengthMm: 20, heightMm: 25, footDepthMm: 20, role: "brace" },
      { id: "left_rear", edge: "left", startMm: 80, lengthMm: 30, heightMm: 25, footDepthMm: 20, role: "brace" },
      { id: "right_front", edge: "right", startMm: 0, lengthMm: 25, heightMm: 25, footDepthMm: 20, role: "brace" },
      { id: "right_rear", edge: "right", startMm: 80, lengthMm: 30, heightMm: 25, footDepthMm: 20, role: "brace" },
      { id: "rear_left", edge: "rear", startMm: 0, lengthMm: 45, heightMm: 25, footDepthMm: 20, role: "brace" },
      { id: "rear_right", edge: "rear", startMm: 115, lengthMm: 45, heightMm: 25, footDepthMm: 20, role: "brace" },
    ],
    gate: { id: "front_gate", heightMm: 20, footDepthMm: 20, parkingXMm: 360, parkingYMm: 80, reliefs: [{ startMm: 38, lengthMm: 44, depthMm: 10 }] },
    actions: jigActions,
  },
  assumptions: [
    "The exact pre-cut panel set uses low-force hand-insertable interlocking joints. Actual insertion forces, alignment tolerance and panel springback require physical testing.",
    "Named exterior braces can carry each unfinished wall's holding duty without flexing, sliding or obstructing its measured insertion window.",
    "The relieved front gate remains stable during assembly and can disengage with one hand without transferring an unsupported holding duty back to the person.",
    "The completed joints genuinely self-retain after all walls and lid are joined. The synthetic declaration is not evidence of actual retention.",
    "The complete enclosure slides forward without snagging or requiring lift beyond the operator's confirmed allowance, then leaves the jig empty and ready for the next loose part set.",
  ],
  changes: [],
};

export const workshopObservation: Observation = {
  summary: "Synthetic workshop example: one hand must locate and stabilize loose enclosure panels while joining them. Continuous fences may obstruct joint insertion; a permanent front fence may trap the finished assembly. No actual part set or physical trial has been observed.",
  entities: [
    ...["base", "left_wall", "right_wall", "rear_wall", "front_wall", "lid"].map(id => ({ id, label: id.replaceAll("_", " "), description: "User-supplied loose pre-cut panel; exact joints and access windows must be measured." })),
    { id: "gate", label: "Removable front support", description: "Proposed holding duty during assembly; must park before completed-workpiece extraction." },
  ],
  actions: [
    { id: "hold-wall", label: "Hold a wall upright and aligned with the base", startMs: null, endMs: null, support: "Illustrative hand-held panel, not an observed event", uncertain: true },
    { id: "insert-joint", label: "Apply a separate joining action while preserving alignment", startMs: null, endMs: null, support: "Unknown until actual footage and panel geometry are confirmed", uncertain: true },
  ],
  conflicts: [
    { description: "Holding and alignment can occupy the hand needed to insert a joint.", evidence: "Synthetic hypothesis requiring actual operator footage." },
    { description: "A continuous brace may cover a joint window, and a fixed front support may prevent finished-workpiece extraction.", evidence: "Explicit design concerns, not measured failures." },
  ],
  questions: ["Where are the actual joint insertion/access windows on every wall?", "Which joining actions and extraction lift are available to the operator?", "Do the completed joints genuinely self-retain before any fixture support is removed?"],
  evidenceCompleteness: "incomplete",
  missingSegments: ["Actual original assembly video", "Measured pre-cut panel set and joints", "Jig construction", "Uninterrupted complete assembly, gate parking, extraction and reset trial"],
};
