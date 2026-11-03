import { ProposalSchema, WorkshopFactsSchema, type CheckResult, type Proposal, type WorkshopFacts } from "../domain/schema";
import { resolveWorkshopGeometry } from "../geometry/workshopJig";

type Rect = { xMm: number; yMm: number; widthMm: number; depthMm: number; zMinMm?: number; zMaxMm?: number };
const within = (point: { xMm: number; yMm: number }, rect: Rect, tolerance = 0) => point.xMm >= rect.xMm - tolerance && point.xMm <= rect.xMm + rect.widthMm + tolerance && point.yMm >= rect.yMm - tolerance && point.yMm <= rect.yMm + rect.depthMm + tolerance;
const overlaps = (a: Rect, b: Rect) => a.xMm < b.xMm + b.widthMm - .001 && a.xMm + a.widthMm > b.xMm + .001 && a.yMm < b.yMm + b.depthMm - .001 && a.yMm + a.depthMm > b.yMm + .001;
const contains = (outer: Rect, inner: Rect) => inner.xMm >= outer.xMm - .001 && inner.yMm >= outer.yMm - .001 && inner.xMm + inner.widthMm <= outer.xMm + outer.widthMm + .001 && inner.yMm + inner.depthMm <= outer.yMm + outer.depthMm + .001;

/** Checks the declared passive jig and explicit human action sequence, never force or physical success. */
export function checkWorkshopDesign(facts: WorkshopFacts, proposal: Proposal): CheckResult[] {
  const results: CheckResult[] = [];
  const add = (ruleId: string, severity: CheckResult["severity"], message: string, affectedIds: string[] = []) => results.push({ ruleId, severity, message, affectedIds });
  const fail = (ruleId: string, message: string, affectedIds: string[] = []) => add(ruleId, "error", message, affectedIds);
  for (const parsed of [WorkshopFactsSchema.safeParse(facts), ProposalSchema.safeParse(proposal)]) if (!parsed.success) for (const issue of parsed.error.issues) fail("WJ_SCHEMA", `${issue.path.join(".")}: ${issue.message}`);
  if (results.length) return results;
  if (proposal.outcome !== "candidate") {
    add("WJ_OUTCOME", "warning", proposal.outcome === "simpler_aid_sufficient" ? "A simpler aid is sufficient; no custom jig construction is released." : proposal.outcome === "needs_measurement" ? "Confirm the named measurements before generating a jig." : "This case is outside the low-force pre-cut panel assembly grammar.");
    return results;
  }
  for (const fact of proposal.missingFacts) fail("WJ_FACT", `Unresolved critical input: ${fact}`);
  if (proposal.program !== null || proposal.actions.length || !proposal.jigProgram) {
    fail("WJ_PROGRAM", "A workshop candidate requires only jigProgram; legacy package program must be null and legacy actions empty.");
    return results;
  }
  const p = proposal.jigProgram;
  // Resolver and construction coordinates preserve the input/arithmetic numbers;
  // presentation rounding must never change the geometry checked here.
  const geometry = resolveWorkshopGeometry(facts, p);
  const table: Rect = { xMm: 0, yMm: 0, widthMm: facts.workspaceWidthMm, depthMm: facts.workspaceDepthMm };
  const reach: Rect = { xMm: 0, yMm: 0, widthMm: facts.reachWidthMm, depthMm: facts.reachDepthMm };
  if (!contains(table, reach)) fail("WJ_REACH", "The confirmed reach rectangle extends outside the measured work surface.");
  if (!contains(table, geometry.base) || !contains(reach, geometry.base)) fail("WJ_BASE", "The complete jig base must lie inside the measured work surface and confirmed planar reach.", ["baseplate"]);
  if (!contains(geometry.base, geometry.workpiece)) fail("WJ_BASE", "The workpiece footprint exceeds the jig base.", ["baseplate"]);
  if (!contains(table, geometry.extractedArea) || !contains(reach, geometry.extractedArea)) fail("WJ_EXTRACT_AREA", "The full nominal front-extracted assembly footprint must remain on the measured table and inside the confirmed planar reach. Output overhang is not an implicit release solution.", ["assembly"]);
  if (p.registrationClearanceMm > facts.alignmentToleranceMm) fail("WJ_ALIGNMENT", "The designed registration gap exceeds the operator-confirmed alignment tolerance.");
  if (facts.panelThicknessMm >= Math.min(facts.workpieceWidthMm, facts.workpieceDepthMm, facts.workpieceHeightMm)) fail("WJ_FACT", "Panel thickness cannot equal or exceed the enclosure's outer dimensions.");
  const minimumWeb = Math.max(3, 2 * facts.boardThicknessMm);
  const reservedNames = ["jig_base", "baseplate", "table", "supply", "finished_area", "assembly", "gate", "jig", "base", "left_wall", "right_wall", "rear_wall", "front_wall", "lid"];
  if (reservedNames.includes(p.gate.id)) fail("WJ_SUPPORT_ID", "The gate needs its own unique fixture ID, distinct from the supplied panels and reserved support names.", [p.gate.id]);
  const supportIds = new Set<string>();
  for (const support of p.supports) {
    if ([...reservedNames, p.gate.id].includes(support.id) || supportIds.has(support.id)) fail("WJ_SUPPORT_ID", "Fixed support IDs must be unique and distinct from the gate, parts and reserved support names.", [support.id]);
    supportIds.add(support.id);
    const edgeLength = support.edge === "rear" ? facts.workpieceWidthMm : facts.workpieceDepthMm;
    if (support.startMm + support.lengthMm > edgeLength + .001) fail("WJ_SUPPORT_SPAN", "A brace segment extends beyond its declared workpiece edge.", [support.id]);
    if (support.lengthMm < minimumWeb || support.heightMm < minimumWeb || support.footDepthMm < minimumWeb) fail("WJ_MATERIAL", "The selected brace segment, upright and foot must each preserve the bounded material feature minimum of max(3 mm, twice board thickness). This is a geometry limit, not a force rating.", [support.id]);
    const resolved = geometry.supports.find(s => s.id === support.id);
    if (!resolved || !contains(geometry.base, resolved.footprint)) fail("WJ_SUPPORT_BASE", "Every fixed brace foot must lie fully on the declared jig base.", [support.id]);
  }
  for (const edge of ["left", "right", "rear"] as const) if (!p.supports.some(support => support.edge === edge && support.role === "brace")) fail("WJ_SUPPORT_COVERAGE", `The ${edge} wall needs an explicit brace to carry its holding duty. A locate-only feature cannot establish that support.`, [edge]);
  if (!contains(geometry.base, geometry.gateEngaged)) fail("WJ_GATE_BASE", "The engaged front gate and its foot must fit on the jig base.", [p.gate.id]);
  if (p.gate.heightMm < minimumWeb || p.gate.footDepthMm < minimumWeb) fail("WJ_MATERIAL", "The removable gate upright and foot must each preserve max(3 mm, twice board thickness). A near-zero fence cannot evade joint-access checks.", [p.gate.id]);
  if (!contains(table, geometry.gateParked) || !contains(reach, geometry.gateParked)) fail("WJ_GATE_PARK", "The whole parked gate must lie inside the measured work surface and reachable region.", [p.gate.id]);
  if (overlaps(geometry.gateParked, geometry.base) || overlaps(geometry.gateParked, geometry.releaseCorridor) || geometry.supports.some(support => overlaps(geometry.gateParked, support.footprint))) fail("WJ_GATE_PARK", "Park the gate outside the entire jig and the front extraction corridor.", [p.gate.id]);
  for (const support of geometry.supports) {
    if (overlaps(support.footprint, geometry.workpiece)) fail("WJ_INTRUSION", "An exterior support intrudes into the assembled workpiece footprint.", [support.id]);
    if (overlaps(support.footprint, geometry.releaseCorridor)) fail("WJ_RELEASE_CORRIDOR", "A permanent support blocks the declared front extraction corridor.", [support.id]);
    for (const other of geometry.supports) if (support.id < other.id && overlaps(support.footprint, other.footprint)) fail("WJ_SUPPORT_COLLISION", "Two fixed brace feet overlap; resolve their assembly geometry explicitly.", [support.id, other.id]);
  }
  const blankIds = new Set<string>();
  for (const blank of geometry.blanks) {
    if (blankIds.has(blank.id)) fail("WJ_BLANK_ID", "Every physical cut blank needs a distinct identity, including the fixed jig base, braces and removable gate.", [blank.id]);
    blankIds.add(blank.id);
    const fits = (blank.lengthMm <= facts.sheetWidthMm && blank.widthMm <= facts.sheetHeightMm) || (blank.widthMm <= facts.sheetWidthMm && blank.lengthMm <= facts.sheetHeightMm);
    if (!fits) fail("WJ_SHEET", "A complete jig cut blank exceeds the actual material sheet in either supported orientation.", [blank.id]);
    if (![blank.lengthMm, blank.widthMm].every(value => Number.isFinite(value) && value > 0)) fail("WJ_MATERIAL", "All resolved cut-blank dimensions must remain finite and positive after calibration.", [blank.id]);
    if (blank.scoreAtMm !== null && (blank.scoreAtMm < minimumWeb || blank.widthMm - blank.scoreAtMm < minimumWeb)) fail("WJ_MATERIAL", "The calibrated cut blank must retain a buildable foot and upright on both sides of its score line.", [blank.id]);
  }
  const reliefs = [...p.gate.reliefs].sort((a, b) => a.startMm - b.startMm);
  for (const [index, relief] of reliefs.entries()) {
    if (relief.startMm + relief.lengthMm > facts.workpieceWidthMm || relief.depthMm > p.gate.heightMm - minimumWeb || p.gate.heightMm + facts.foldAllowanceMm - relief.depthMm < minimumWeb) fail("WJ_GATE_RELIEF", "A top-edge gate notch exceeds the workpiece span or removes the required continuous lower web in its actual calibrated cut blank.", [p.gate.id]);
    if (index && relief.startMm - reliefs[index - 1].startMm - reliefs[index - 1].lengthMm < minimumWeb) fail("WJ_GATE_RELIEF", "Distinct gate notches must preserve max(3 mm, twice board thickness) of material between them. Merge nearby cuts into one supported relief instead.", [p.gate.id]);
  }
  for (const edge of ["left", "right", "rear", "front"] as const) if (!facts.jointZones.some(zone => zone.edge === edge)) fail("WJ_JOINT_FACT", `Confirm the actual ${edge} joint access window for this four-wall enclosure family; missing access cannot imply clearance.`, [edge]);
  for (const zone of facts.jointZones) {
    const span = zone.edge === "left" || zone.edge === "right" ? facts.workpieceDepthMm : facts.workpieceWidthMm;
    if (zone.endMm <= zone.startMm || zone.endMm > span || zone.topMm <= zone.bottomMm || zone.topMm > facts.workpieceHeightMm) fail("WJ_JOINT_FACT", "A measured joint access rectangle is inverted or outside its actual panel edge.", [zone.edge]);
    for (const support of p.supports.filter(s => s.edge === zone.edge)) {
      if (support.startMm < zone.endMm && support.startMm + support.lengthMm > zone.startMm && support.heightMm > zone.bottomMm && zone.topMm > 0) fail("WJ_JOINT_BLOCK", "The brace occupies a measured joint insertion/access window. Split, lower or relocate it; narrative does not establish clearance.", [support.id, zone.edge]);
    }
    if (zone.edge === "front" && p.gate.heightMm > zone.bottomMm) {
      let coveredTo = zone.startMm;
      for (const relief of reliefs.filter(relief => p.gate.heightMm - relief.depthMm <= zone.bottomMm)) if (relief.startMm <= coveredTo + .001 && relief.startMm + relief.lengthMm > coveredTo) coveredTo = relief.startMm + relief.lengthMm;
      if (coveredTo < zone.endMm - .001) fail("WJ_GATE_JOINT_BLOCK", "The front gate blocks a measured joint path. Its explicit top notch must cover the whole access interval with sufficient remaining vertical clearance.", [p.gate.id]);
    }
  }
  const requiredLift = geometry.dimensions.nominalRequiredAssemblyLiftMm;
  if (requiredLift > facts.maximumAssemblyLiftMm) fail("WJ_LIFT", "This release geometry requires more assembled-object lift than the confirmed limit.", ["assembly"]);

  const walls = ["left_wall", "right_wall", "rear_wall", "front_wall"] as const;
  const parts = ["base", ...walls, "lid"];
  const knownParts = new Set([...parts, "assembly", "gate", "jig"]);
  const knownSupports = new Set(["baseplate", "table", "supply", "finished_area", "assembly", ...parts, p.gate.id, ...supportIds]);
  const located = new Set<string>();
  const joined = new Set<string>();
  const duty = new Map<string, string[]>();
  const seenActions = new Set<string>();
  let holding: string | null = null;
  let gate: "parked" | "engaged" | "held" = "parked";
  let fixtureEmpty = true;
  let extracted = false;
  let finished = false;
  let reset = false;
  const complete = () => located.has("base") && walls.every(wall => joined.has(wall)) && joined.has("lid");
  const edgeFor = (part: string) => part === "left_wall" ? "left" : part === "right_wall" ? "right" : part === "rear_wall" ? "rear" : part === "front_wall" ? "front" : null;
  const neededSupports = (part: string) => part === "base" ? ["baseplate"] : part === "lid" ? ["assembly"] : part === "front_wall" ? [p.gate.id] : p.supports.filter(s => s.edge === edgeFor(part) && s.role === "brace").map(s => s.id);
  const sameSupports = (actual: string[], expected: string[]) => actual.length === expected.length && new Set(actual).size === expected.length && expected.every(support => actual.includes(support));
  const targetForPart = (part: string): Rect => {
    const r = geometry.workpiece;
    const tolerance = Math.max(facts.panelThicknessMm, p.registrationClearanceMm);
    if (part === "left_wall") return { xMm: r.xMm - tolerance, yMm: r.yMm, widthMm: 2 * tolerance, depthMm: r.depthMm };
    if (part === "right_wall") return { xMm: r.xMm + r.widthMm - tolerance, yMm: r.yMm, widthMm: 2 * tolerance, depthMm: r.depthMm };
    if (part === "rear_wall") return { xMm: r.xMm, yMm: r.yMm + r.depthMm - tolerance, widthMm: r.widthMm, depthMm: 2 * tolerance };
    if (part === "front_wall") return { xMm: r.xMm, yMm: r.yMm - tolerance, widthMm: r.widthMm, depthMm: 2 * tolerance };
    return r;
  };
  if (!p.actions.length) fail("WJ_SEQUENCE", "A jig candidate must include the complete loose-part-to-finished-output/reset sequence.");
  for (const [index, action] of p.actions.entries()) {
    if (seenActions.has(action.id)) fail("WJ_ACTION_ID", "Each action ID must be unique.", [action.id]);
    for (const dependency of action.dependsOn) if (!seenActions.has(dependency)) fail("WJ_ORDER", "The selected chronological sequence contains a missing, cyclic or forward dependency.", [action.id, dependency]);
    seenActions.add(action.id);
    if (!knownParts.has(action.partId)) fail("WJ_PART", "The action names a part outside the supplied six-panel enclosure and jig grammar.", [action.id]);
    for (const support of action.supportIds) if (!knownSupports.has(support)) fail("WJ_SUPPORT", "The action invents an undeclared support or helper.", [action.id, support]);
    if (!facts.allowedOperations.includes(action.operation)) fail("WJ_CAPABILITY", `Operation ${action.operation} is not explicitly permitted by the operator.`, [action.id]);
    if (action.operation !== "reset" && action.hand !== "active") fail("WJ_HAND", "Passive cardboard has no actuator: each manipulation, join and support release uses the declared active hand.", [action.id]);
    if (!within(action, reach)) fail("WJ_TARGET_REACH", "The action target lies outside the operator-confirmed planar reach.", [action.id]);
    const expectedSupports = action.operation === "take" ? ["supply"] : ["locate", "join"].includes(action.operation) ? neededSupports(action.partId) : ["engage_support", "release_support", "park_support"].includes(action.operation) ? [p.gate.id] : action.operation === "extract" ? [] : action.operation === "place_finished" ? ["finished_area"] : ["baseplate"];
    if (!sameSupports(action.supportIds, expectedSupports)) fail("WJ_SUPPORT_DUTY", "Use exactly the actual supports for this operation: loose pickups use supply, panels use their matching braces, gate operations use only the gate, extraction has no support, and finished/reset actions use their named areas. Extra or phantom supports are not allowed.", [action.id]);
    if (action.operation === "take" && (within(action, geometry.base) || within(action, geometry.gateParked) || within(action, geometry.releaseCorridor) || within(action, geometry.finishedArea))) fail("WJ_SUPPLY_REGION", "Loose-panel pickup points must be outside the jig, gate parking, front extraction corridor and finished-output footprint so the next cycle remains accessible. Actual stock extents and transfer paths still require physical testing.", [action.id]);
    if (["locate", "join"].includes(action.operation) && !within(action, targetForPart(action.partId))) fail("WJ_TARGET", "The action must target the actual corresponding panel edge/workpiece, not an arbitrary reachable point.", [action.id]);
    if (["engage_support", "release_support"].includes(action.operation) && !within(action, geometry.gateEngaged)) fail("WJ_TARGET", "Front-gate engagement/release must target its actual engaged footprint.", [action.id]);
    if (action.operation === "park_support" && !within(action, geometry.gateParked)) fail("WJ_TARGET", "Gate parking must target its complete measured parking region.", [action.id]);
    if (action.operation === "extract" && !within(action, geometry.workpiece)) fail("WJ_TARGET", "Extraction must target the assembled workpiece in the fixture.", [action.id]);
    if (action.operation === "reset" && !within(action, geometry.base)) fail("WJ_TARGET", "Reset inspection must target the actual empty jig.", [action.id]);
    if (finished && action.operation !== "reset") fail("WJ_SEQUENCE", "After placing the finished output, only final jig reset belongs to this cycle.", [action.id]);
    switch (action.operation) {
      case "take": {
        if (holding) fail("WJ_HAND_OCCUPIED", `The hand still holds ${holding}; it cannot take another part, including the same part again.`, [action.id]);
        if (!parts.includes(action.partId) || located.has(action.partId) || joined.has(action.partId) || extracted) fail("WJ_TAKE", "Take each supplied loose panel once; disassembly and hidden preassembly are outside this sequence.", [action.id]);
        if (!action.supportIds.includes("supply")) fail("WJ_SUPPLY", "A fresh loose-part pickup must explicitly reference its declared supply.", [action.id]);
        holding = action.partId;
        break;
      }
      case "locate": {
        if (holding !== action.partId || !parts.includes(action.partId) || located.has(action.partId)) fail("WJ_LOCATE", "Locate the previously held loose panel exactly once before releasing the hand.", [action.id]);
        if (action.partId !== "base" && !located.has("base")) fail("WJ_BASE_FIRST", "The loose base must be placed on the baseplate before wall/lid positioning.", [action.id]);
        if (action.partId === "lid" && !walls.every(wall => joined.has(wall))) fail("WJ_LID", "All four walls must be explicitly joined before the lid is positioned.", [action.id]);
        if (action.partId === "front_wall" && gate !== "engaged") fail("WJ_GATE_DUTY", "Engage the front gate before the front wall can be left supported.", [action.id]);
        const supports = neededSupports(action.partId);
        if (!supports.length || !sameSupports(action.supportIds, supports)) fail("WJ_SUPPORT_DUTY", "The located panel must transfer to exactly its matching-edge braces; base uses baseplate and lid uses assembly.", [action.id]);
        located.add(action.partId); duty.set(action.partId, supports); holding = null; fixtureEmpty = false;
        break;
      }
      case "join": {
        if (holding && holding !== action.partId) fail("WJ_HAND_OCCUPIED", `The active hand still holds ${holding} while asked to join another panel.`, [action.id]);
        if (!(walls as readonly string[]).includes(action.partId) && action.partId !== "lid") fail("WJ_JOIN", "Only supplied walls and lid join the already positioned base; arbitrary parts cannot create completion.", [action.id]);
        if (!located.has(action.partId) || joined.has(action.partId)) fail("WJ_JOIN", "A join requires that exact panel to have been located first and not already joined.", [action.id]);
        if (!sameSupports(action.supportIds, duty.get(action.partId) ?? [])) fail("WJ_SUPPORT_DUTY", "Keep the panel's exact fixture support duties during the join.", [action.id]);
        if (action.partId === "front_wall" && gate !== "engaged") fail("WJ_GATE_DUTY", "The gate must continue supporting the front wall during its join.", [action.id]);
        if (action.partId === "lid" && !walls.every(wall => joined.has(wall))) fail("WJ_LID", "The lid cannot join before all four walls.", [action.id]);
        joined.add(action.partId); holding = null;
        break;
      }
      case "engage_support": {
        if (action.partId !== "gate" || !action.supportIds.includes(p.gate.id) || gate !== "parked" || holding || !located.has("base") || located.has("front_wall")) fail("WJ_GATE_ENGAGE", "With the hand free, engage the initially parked front gate after base placement and before the front wall.", [action.id]);
        gate = "engaged";
        break;
      }
      case "release_support": {
        if (action.partId !== "gate" || !action.supportIds.includes(p.gate.id) || gate !== "engaged" || holding || !complete() || !facts.completedJointsSelfRetain) fail("WJ_EARLY_RELEASE", "The sole hand may release the gate only after all six panels are assembled and completed joints are confirmed self-retaining. Otherwise an unsupported wall is created.", [action.id]);
        gate = "held"; holding = "gate";
        break;
      }
      case "park_support": {
        if (action.partId !== "gate" || !action.supportIds.includes(p.gate.id) || gate !== "held" || holding !== "gate") fail("WJ_GATE_PARK_STATE", "Park the gate actually held after its explicit release, then free the hand.", [action.id]);
        gate = "parked"; holding = null;
        break;
      }
      case "extract": {
        if (action.partId !== "assembly" || holding || !complete() || !facts.completedJointsSelfRetain || gate !== "parked" || extracted) fail("WJ_EXTRACT", "Extract the complete self-retaining assembly only after releasing and parking the gate with the hand available.", [action.id]);
        holding = "assembly"; fixtureEmpty = true; extracted = true;
        break;
      }
      case "place_finished": {
        if (action.partId !== "assembly" || holding !== "assembly" || !extracted || !action.supportIds.includes("finished_area")) fail("WJ_FINISHED", "The hand must transfer the actually extracted assembly into the finished area.", [action.id]);
        const output: Rect = { xMm: action.xMm - facts.workpieceWidthMm / 2, yMm: action.yMm - facts.workpieceDepthMm / 2, widthMm: facts.workpieceWidthMm, depthMm: facts.workpieceDepthMm };
        if (!contains(table, output) || !contains(reach, output) || overlaps(output, geometry.base) || overlaps(output, geometry.gateParked) || overlaps(output, geometry.releaseCorridor)) fail("WJ_FINISHED_AREA", "The complete finished-object footprint must fit a reachable finished area clear of the jig, parked gate and next-cycle extraction corridor.", [action.id]);
        holding = null; finished = true;
        break;
      }
      case "reset": {
        if (action.partId !== "jig" || !action.supportIds.includes("baseplate") || holding || !fixtureEmpty || gate !== "parked" || !finished || index !== p.actions.length - 1) fail("WJ_RESET", "Reset must be the final inspection of an empty jig, parked gate, cleared output and available hand.", [action.id]);
        reset = true;
        break;
      }
    }
  }
  if (!complete()) fail("WJ_INCOMPLETE", "A complete cycle must locate the loose base and explicitly locate/join all four walls and the lid.");
  if (!reset || !finished || !fixtureEmpty || gate !== "parked" || holding) fail("WJ_CYCLE", "The full operating cycle must release/park the gate, extract/place the assembly and reset the empty jig with the hand free.");
  add("WJ_PHYS01", "trial_required", "The jig is an unadmitted physical hypothesis. Static clearance and support duties do not establish alignment, stability, force resistance or one-handed operation.");
  add("WJ_PHYS02", "trial_required", "Test every actual low-force joint with the pre-cut parts, declared hand and permitted supports. Confirm wall support while the hand takes the next part, insertion force, bowing, friction and springback.");
  add("WJ_PHYS03", "trial_required", "The stated completed-joint self-retention remains a physical test requirement. Observe gate removal/parking, horizontal front extraction, actual snagging or lift, finished-output placement and fresh-part/reset accessibility.");
  add("WJ_PHYS04", "trial_required", "The planar model and supply points do not establish full loose-panel stock footprints, complete human transfer paths, three-dimensional insertion sweeps or comfortable vertical reach. Physically verify supply/output separation and next-cycle access; record assistance, undeclared body use, build deviations and failed attempts.");
  proposal.assumptions.forEach(assumption => add("WJ_ASSUMPTION", "trial_required", assumption));
  return results;
}
