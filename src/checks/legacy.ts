import { LegacyFactsSchema as FactsSchema, LegacyProposalSchema as ProposalSchema, PHYSICAL_TESTS, SUPPORTED_SUPPORTS, KIT_COMPONENT_IDS, type CheckResult, type LegacyFacts as Facts, type LegacyProposal as Proposal } from "../domain/schema";
import { getKitCells, resolveLegacyDimensions as resolveDimensions } from "../geometry/legacy";

export type { CheckResult } from "../domain/schema";
export const CHECKER_VERSION = "2";

/** A bounded symbolic checker. A pass is never a claim of physical admission. */
export function checkLegacyDesign(facts: Facts, proposal: Proposal): CheckResult[] {
  const results: CheckResult[] = [];
  const add = (ruleId: string, severity: CheckResult["severity"], message: string, affectedIds: string[] = []) =>
    results.push({ ruleId, severity, message, affectedIds });
  const parsedFacts = FactsSchema.safeParse(facts);
  const parsedProposal = ProposalSchema.safeParse(proposal);
  if (!parsedFacts.success || !parsedProposal.success) {
    for (const result of [parsedFacts, parsedProposal]) {
      if (!result.success) for (const issue of result.error.issues) add("SCHEMA01", "error", `${issue.path.join(".")}: ${issue.message}`);
    }
    return results;
  }
  if (proposal.outcome !== "candidate") {
    add("DESIGN01", "warning", proposal.outcome === "simpler_aid_sufficient"
      ? "The model recommends a simpler aid. No custom construction pack is released."
      : proposal.outcome === "needs_measurement"
        ? "More facts are required before a construction candidate can be checked."
        : "This task is outside the current top-opening tuck-carton component library.");
    return results;
  }
  for (const fact of proposal.missingFacts) add("FACT01", "error", `Unresolved input: ${fact}`);
  const p = proposal.program;
  const kit = facts.workflow === "electronics_kit";
  const groupIds: readonly string[] = KIT_COMPONENT_IDS;
  const groups = new Map(facts.kitComponents.map(c => [c.id as string, c]));
  if (kit) {
    if (facts.kitComponents.length !== 4 || groups.size !== 4 || !KIT_COMPONENT_IDS.every(id => groups.has(id))) add("KIT01", "error", "Confirm one measured group for each supported type: screws, washers, spacers and grommets. Full target-group bundle dimensions cannot be inferred.");
    if (!p.kitLayout || new Set(p.kitLayout.cellOrder).size !== 4 || !KIT_COMPONENT_IDS.every(id => p.kitLayout!.cellOrder.includes(id))) add("KIT02", "error", "An explicit two-by-two layout must include each canonical group exactly once.");
    if (results.some(c => c.ruleId === "KIT01" || c.ruleId === "KIT02")) return results;
  } else {
    if (facts.itemLengthMm === null || facts.itemWidthMm === null || facts.itemHeightMm === null) add("FACT01", "error", "Confirm actual item length, width and height for the carton workflow.");
    if (p.kitLayout || facts.kitComponents.length) add("KIT02", "error", "Kit compartments require the electronics-kit workflow.");
    if (results.some(c => c.severity === "error")) return results;
  }
  const d = resolveDimensions(facts, proposal);
  const cells = kit ? getKitCells(facts, proposal) : [];
  if (facts.cartonOuterLengthMm < facts.cartonLengthMm || facts.cartonOuterWidthMm < facts.cartonWidthMm) {
    add("GEOM00", "error", "Measured carton outside dimensions cannot be smaller than its usable interior. Recheck the independent exterior measurements.", ["carton"]);
  }
  if (Object.entries(d).some(([key, value]) => !Number.isFinite(value) || (key === "registrationGapMm" ? value < 0 : value <= 0))) {
    add("GEOM01", "error", "Derived geometry must be finite and positive. Recheck the signed fold calibration and dimensions.", ["insert"]);
  }
  if (d.trayOuterLengthMm > facts.cartonLengthMm || d.trayOuterWidthMm > facts.cartonWidthMm) {
    add("GEOM02", "error", "The tray's outside finished footprint exceeds the measured carton interior. Reduce a design clearance or use a larger measured carton.", ["insert", "carton"]);
  }
  if (!kit && facts.itemHeightMm! + facts.boardThicknessMm > facts.cartonHeightMm) {
    add("GEOM03", "error", "Item/bundle height plus tray base thickness exceeds the measured carton interior height.", ["item", "insert", "carton"]);
  }
  if (p.wallHeightMm + facts.boardThicknessMm > facts.cartonHeightMm) {
    add("GEOM04", "error", "Tray walls exceed the carton interior height after allowing for the base material.", ["insert"]);
  }
  if (p.wallHeightMm < 2 * facts.boardThicknessMm) {
    add("GEOM05", "error", "Tray walls are too short for the bounded folded-wall construction. Use at least twice the material thickness.", ["insert"]);
  }
  if (d.fixtureBlankWidthMm <= d.footDepthMm) {
    add("GEOM05", "error", "The signed fold correction leaves no positive fixture upright beyond its score line.", ["station"]);
  }
  if (p.stopHeightMm > facts.cartonHeightMm) {
    add("GEOM06", "error", "Stops exceed the supported below-lid registration envelope. This tall-stop composition is not supported.", ["station"]);
  }
  const fitsSheet = (length: number, width: number) =>
    (length <= facts.sheetWidthMm && width <= facts.sheetHeightMm) ||
    (width <= facts.sheetWidthMm && length <= facts.sheetHeightMm);
  if (!fitsSheet(d.blankLengthMm, d.blankWidthMm)) {
    add("GEOM07", "error", "The complete tray blank does not fit the confirmed sheet in either supported orientation.", ["insert"]);
  }
  if (!fitsSheet(d.fixtureBlankLengthMm, d.fixtureBlankWidthMm)) {
    add("GEOM08", "error", "A fixture blank does not fit the confirmed sheet. Joining smaller sheets is outside this compiler.", ["station"]);
  }
  if (kit) for (const cell of cells) {
    const group = groups.get(cell.componentId)!;
    if (group.bundleHeightMm + 2 * facts.boardThicknessMm > p.kitLayout!.dividerHeightMm) add("KIT03", "error", `The measured ${group.label} group height plus base/lid allowance exceeds the cell height.`, [cell.componentId]);
    if (d.kitClosedStackHeightMm > facts.cartonHeightMm) add("KIT04", "error", "Cell height, cell/carrier bases and lid stack exceed the carton interior height.", [cell.componentId]);
    if (!fitsSheet(cell.blankLengthMm, cell.blankWidthMm)) add("KIT05", "error", `The full ${group.label} hinged-cell diecut exceeds the confirmed sheet.`, [cell.componentId]);
    if (cell.insideLengthMm < group.bundleLengthMm || cell.insideWidthMm < group.bundleWidthMm) add("KIT06", "error", "The measured full-group envelope exceeds its assigned cell interior.", [cell.componentId]);
    const web = Math.max(3, 2 * facts.boardThicknessMm);
    if (cell.tabWidthMm <= 2 * facts.boardThicknessMm || cell.tabDepthMm >= cell.heightMm || cell.slotWidthMm > cell.scoreLengthMm - 2 * web || cell.slotFromTopMm - cell.slotHeightMm / 2 < web || cell.lidDepthMm - cell.slotFromTopMm - cell.slotHeightMm / 2 < web) add("KIT19", "error", "The chosen cell/material does not preserve a usable tuck tongue and material web around its top-accessible lid slot.", [cell.componentId]);
  }
  if (p.offsetXMm + d.stationLengthMm > facts.workspaceWidthMm || p.offsetYMm + d.stationWidthMm > facts.workspaceDepthMm) {
    add("GEOM09", "error", "The exterior registration envelope lies outside the confirmed work surface.", ["station"]);
  }
  if (facts.reachWidthMm > facts.workspaceWidthMm || facts.reachDepthMm > facts.workspaceDepthMm) {
    add("REACH01", "error", "The confirmed reachable rectangle extends beyond the declared work surface.", ["workspace"]);
  }
  const ids = new Set<string>();
  let holding: string | null = null;
  let closedAt = -1;
  let releasedAt = -1;
  let resetAt = -1;
  let packageTaken = false;
  let packagePositioned = false;
  let insertPlaced = false;
  const loaded = new Set<string>();
  const counts = new Map(KIT_COMPONENT_IDS.map(id => [id as string, 0]));
  const closedCells = new Set<string>();
  const knownObjects = new Set(["carton", "card", "station", "insert", ...(kit ? [...KIT_COMPONENT_IDS, ...KIT_COMPONENT_IDS.map(id => `compartment_${id}`)] : ["item"])]);
  const loadedInto = new Map<string, string>();
  const actions = proposal.actions;
  if (!actions.length) add("PLAN00", "error", "A construction candidate needs a complete operating sequence.");
  if (actions.length && (actions[0].operation !== "take" || actions[0].objectId !== "carton")) add("PLAN13", "error", "The first action must take fresh carton packaging from the declared supply, without helper preload.", [actions[0].id]);
  for (let index = 0; index < actions.length; index++) {
    const action = actions[index];
    if (action.hand !== "active" && ["take", "position", "load", "fold", "close", "release"].includes(action.operation)) add("CAPABILITY02", "error", "This passive-cardboard grammar has no actuator or helper: each manipulation, load, closure and release must use the declared active hand.", [action.id]);
    const groupAction = kit && groupIds.includes(action.objectId);
    const cellClose = kit && action.operation === "close" && action.objectId.startsWith("compartment_");
    if (!kit && (action.quantity !== null || action.compartmentId !== null || action.supportAfter?.startsWith("compartment_"))) add("KIT07", "error", "Quantity/local-cell claims require the electronics-kit workflow.", [action.id]);
    if (action.supportAfter?.startsWith("compartment_") && !(kit && groupAction && action.operation === "load" && insertPlaced && action.compartmentId === action.objectId && action.supportAfter === `compartment_${action.objectId}`)) add("KIT20", "error", "A compartment is available only for its matching individual-component load after the empty insert has been placed. It is not an arbitrary parking or helper support.", [action.id]);
    if (groupAction) {
      if (!["take", "load"].includes(action.operation) || action.quantity !== 1 || action.compartmentId !== action.objectId) add("KIT08", "error", "Take/load each individual loose part with quantity 1 and its matching compartment ID. Hidden pre-counted batches are unsupported.", [action.id]);
      if (action.operation === "take" && holding !== null) add("KIT18", "error", "The hand already contains a loose component. Load that individual part before taking another, even if both have the same group ID.", [action.id]);
    } else if (kit && (action.quantity !== null || (!cellClose && action.compartmentId !== null))) add("KIT08", "error", "Only individual part take/load actions carry quantities; only local cell closures additionally identify a compartment.", [action.id]);
    if (!facts.allowedOperations.includes(action.operation)) add("CAPABILITY01", "error", `Operation ${action.operation} is not explicitly permitted in the operator-confirmed capability profile. Change the sequence or confirm the actual capability.`, [action.id]);
    if (ids.has(action.id)) add("PLAN01", "error", `Duplicate action ID ${action.id}.`, [action.id]);
    for (const dependency of action.dependsOn) {
      if (!ids.has(dependency)) add("PLAN02", "error", `Action ${action.id} depends on ${dependency}, which does not precede it. The selected sequence must be acyclic and complete.`, [action.id, dependency]);
    }
    ids.add(action.id);
    if (!knownObjects.has(action.objectId)) add("PLAN03", "error", `Unknown object ${action.objectId}. The P0 grammar contains carton, item, card, insert and station.`, [action.id]);
    if (action.holdAfter && !knownObjects.has(action.holdAfter)) add("PLAN03", "error", `Unknown held object ${action.holdAfter}.`, [action.id]);
    if (action.supportAfter && !(SUPPORTED_SUPPORTS as readonly string[]).includes(action.supportAfter)) {
      add("PLAN04", "error", `Support ${action.supportAfter} is not in the declared component library. Do not invent helper or body support.`, [action.id]);
    }
    if (action.supportAfter === action.objectId) add("PLAN04", "error", "An object cannot serve as its own receiving support.", [action.id]);
    if (action.xMm > facts.reachWidthMm || action.yMm > facts.reachDepthMm) {
      add("REACH02", "error", `Action “${action.label}” lies outside the operator-confirmed reachable rectangle.`, [action.id]);
    }
    const manipulatesInStation = action.operation === "load" || action.operation === "close" ||
      (action.operation === "position" && ["carton", "insert"].includes(action.objectId)) ||
      (action.operation === "take" && action.objectId === "carton" && closedAt >= 0);
    const cartonX = p.offsetXMm + d.footDepthMm + d.registrationGapMm;
    const cartonY = p.offsetYMm + d.footDepthMm + d.registrationGapMm;
    if (manipulatesInStation && (action.xMm < cartonX || action.xMm > cartonX + facts.cartonOuterLengthMm || action.yMm < cartonY || action.yMm > cartonY + facts.cartonOuterWidthMm)) {
      add("REACH03", "error", "A carton loading, positioning, closure or pickup action must target the actual resolved carton footprint in the station, not an unrelated reachable point.", [action.id]);
    }
    if (kit && ((groupAction && action.operation === "load") || cellClose)) {
      const cell = cells.find(c => c.componentId === action.compartmentId);
      const originX = cartonX + (facts.cartonOuterLengthMm - d.trayOuterLengthMm) / 2 + facts.boardThicknessMm;
      const originY = cartonY + (facts.cartonOuterWidthMm - d.trayOuterWidthMm) / 2 + facts.boardThicknessMm;
      if (!cell || action.xMm < originX + cell.xMm || action.xMm > originX + cell.xMm + cell.outerLengthMm || action.yMm < originY + cell.yMm || action.yMm > originY + cell.yMm + cell.outerWidthMm) add("KIT09", "error", "Part loads and local closures must target the actual mapped cell footprint, not another well or arbitrary reachable point.", [action.id]);
    }
    if (action.hand === "active" && holding && holding !== action.objectId) {
      add("PLAN05", "error", `The ${facts.activeHand} hand still holds ${holding} when asked to act on ${action.objectId}. An explicit support transfer must happen first.`, [action.id]);
    }
    if (action.hand === "none" && action.holdAfter !== holding) {
      add("PLAN06", "error", "An action using no hand cannot acquire or release the hand's object.", [action.id]);
    }
    if (action.holdAfter && action.holdAfter !== holding && action.holdAfter !== action.objectId) {
      add("PLAN06", "error", "An action cannot acquire a different, unrelated object.", [action.id]);
    }
    if (holding && action.holdAfter !== holding && (!action.supportAfter || action.objectId !== holding)) {
      add("PLAN07", "error", `Releasing ${holding} requires an action on that object and an explicit receiving support.`, [action.id]);
    }
    if (action.hand === "active" && !action.holdAfter && !action.supportAfter) {
      add("PLAN07", "error", "The manipulated object is left without a declared support or hand hold.", [action.id]);
    }
    if (action.operation === "take" && (action.hand !== "active" || action.holdAfter !== action.objectId)) {
      add("PLAN08", "error", "Taking an object must acquire it in the declared active hand.", [action.id]);
    }
    if (action.operation === "take" && action.objectId === "carton" && closedAt < 0) { packageTaken = true; packagePositioned = false; }
    if (action.operation === "take" && action.objectId === "insert") {
      if (kit && [...counts.values()].some(count => count > 0)) add("KIT10", "error", "The partly loaded insert cannot be removed and silently retain its contents state. Fulfil this kit in its stationed carton.", [action.id]);
      insertPlaced = false;
    }
    if (action.operation === "take" && loaded.has(action.objectId)) {
      if (closedAt >= 0) add("PLAN09", "error", "Contents inside the closed carton are inaccessible until a supported opening operation; this grammar does not include one.", [action.id]);
      loaded.delete(action.objectId);
      loadedInto.delete(action.objectId);
    }
    if (action.operation === "position" && action.objectId === "carton" && action.supportAfter === "station" && !action.holdAfter) {
      if (holding !== "carton") add("PLAN13", "error", "Positioning fresh packaging requires a preceding take of that carton.", [action.id]);
      packagePositioned = true;
    }
    if (action.operation === "position" && action.objectId === "insert" && action.supportAfter === "carton" && !action.holdAfter) {
      if (holding !== "insert" || !packagePositioned) add("PLAN18", "error", "Placing the retaining tray requires taking it first and positioning the carton in the station.", [action.id]);
      insertPlaced = true;
    }
    if (action.operation === "load") {
      if (!(groupAction || action.objectId === "card" || (!kit && action.objectId === "item"))) add("PLAN09", "error", "Loading must name a defined kit component or item/card.", [action.id]);
      if (action.holdAfter !== null || (!groupAction && !["carton", "insert"].includes(action.supportAfter ?? ""))) add("PLAN09", "error", "Loaded contents must transfer from the hand to a declared receiving compartment or package.", [action.id]);
      if (!packagePositioned) add("PLAN09", "error", "Position fresh packaging in the station before loading contents.", [action.id]);
      if (holding !== action.objectId) add("PLAN09", "error", "Loading contents requires taking and holding that object first. A load cannot conjure contents into the carton.", [action.id]);
      if ((groupAction || action.supportAfter === "insert") && !insertPlaced) add("PLAN18", "error", "The prepared empty insert must be taken from supply and placed in the carton before loading contents.", [action.id]);
      if (closedAt >= 0) add("PLAN09", "error", "Contents cannot be loaded after the carton has been closed.", [action.id]);
      if (groupAction) {
        if (action.compartmentId !== action.objectId || action.supportAfter !== `compartment_${action.objectId}`) add("KIT11", "error", "A component must enter its own labelled compartment; mixing cannot satisfy kit contents.", [action.id]);
        if (closedCells.has(action.objectId)) add("KIT12", "error", "A closed cell cannot accept more parts without a supported reopening operation.", [action.id]);
        const count = (counts.get(action.objectId) ?? 0) + (action.quantity ?? 0);
        counts.set(action.objectId, count);
        if (count > groups.get(action.objectId)!.requiredCount) add("KIT13", "error", "The declared quantity exceeds the required count. Extra parts cannot be silently ignored.", [action.id]);
      } else {
        loaded.add(action.objectId);
        if (action.supportAfter) loadedInto.set(action.objectId, action.supportAfter);
      }
    }
    if (cellClose) {
      const groupId = action.objectId.slice("compartment_".length);
      if (action.compartmentId !== groupId || !groupIds.includes(groupId) || action.quantity !== null) add("KIT14", "error", "Local closure must name its own actual compartment with no quantity claim.", [action.id]);
      if (!insertPlaced || action.holdAfter !== null || action.supportAfter !== "insert") add("KIT14", "error", "Close the local lid while the cell is supported by its insert and leave the hand free.", [action.id]);
      if (counts.get(groupId) !== groups.get(groupId)?.requiredCount) add("KIT15", "error", "A local compartment cannot close before its exact required part count has been loaded.", [action.id]);
      if (closedCells.has(groupId)) add("KIT14", "error", "The same local compartment cannot be closed twice.", [action.id]);
      closedCells.add(groupId);
    } else if (action.operation === "close") {
      if (action.objectId !== "carton") add("PLAN10", "error", "The defined finished output requires closing the carton.", [action.id]);
      if (!loaded.has("card") || (!kit && !loaded.has("item"))) add("PLAN10", "error", kit ? "Load the inventory slip before final carton closure." : "Both the item and accompanying card must be loaded before closure.", [action.id]);
      if (kit && (!KIT_COMPONENT_IDS.every(id => closedCells.has(id)) || !KIT_COMPONENT_IDS.every(id => counts.get(id) === groups.get(id)!.requiredCount))) add("KIT16", "error", "All four labelled cells need their exact counts and individual closures before the outer carton closes.", [action.id]);
      if (!packagePositioned) add("PLAN10", "error", "The supported closure method requires the carton to remain positioned in the station.", [action.id]);
      closedAt = index;
    }
    if (action.operation === "release" && action.objectId === "carton") {
      if (closedAt < 0) add("PLAN11", "error", "The finished carton cannot be released before closure.", [action.id]);
      if (action.holdAfter !== null || action.supportAfter !== "finished_area") add("PLAN11", "error", "Final parcel release must leave the hand free and the parcel in the finished area, clear of the station.", [action.id]);
      if (holding !== "carton") add("PLAN11", "error", "Removing and releasing the finished parcel requires first taking that carton from the station.", [action.id]);
      releasedAt = index;
    }
    if (action.operation === "reset") {
      if (releasedAt < 0 || action.objectId !== "station" || action.holdAfter !== null) add("PLAN12", "error", "Reset follows finished-parcel release, names the station, and leaves the hand available.", [action.id]);
      resetAt = index;
    }
    holding = action.holdAfter;
  }
  if (!packageTaken || !packagePositioned) add("PLAN13", "error", "The cycle must start with fresh packaging taken from supply and transferred into the station.", ["carton"]);
  if (closedAt < 0) add("PLAN14", "error", "The operating sequence omits the actual carton closure.", ["carton"]);
  if (releasedAt <= closedAt) add("PLAN15", "error", "The operating sequence omits finished-parcel removal and release after closure.", ["carton"]);
  if (resetAt <= releasedAt || resetAt !== actions.length - 1 || holding !== null) add("PLAN16", "error", "The final action must reset the station after release and leave the active hand free.", ["station"]);
  if (!loadedInto.has("card") || (!kit && !loadedInto.has("item"))) add("PLAN17", "error", kit ? "The fulfilled kit requires its inventory slip." : "The sequence must explicitly load both defined contents.");
  if ([...loadedInto.values()].includes("insert") && !insertPlaced) add("PLAN18", "error", "Contents assigned to the tray cannot be counted inside the carton after the tray has been removed.", ["insert"]);
  if (kit && (!KIT_COMPONENT_IDS.every(id => counts.get(id) === groups.get(id)!.requiredCount && closedCells.has(id)) || !insertPlaced)) add("KIT17", "error", "The complete kit requires every exact group count, segregation, all four local closures and the placed insert.", ["insert"]);
  add("PHYS01", "trial_required", "Static dimensions and hand-resource checks do not establish physical operation. This component assembly has not been physically admitted.", ["insert", "station"]);
  for (let index = 0; index < PHYSICAL_TESTS.length; index++) add(`PHYS${String(index + 2).padStart(2, "0")}`, "trial_required", PHYSICAL_TESTS[index], ["insert", "station"]);
  add("PHYS07", "trial_required", `Perform the actual closure (${facts.closure}) with the ${facts.activeHand} hand and the declared permitted supports. Force, peeling, flap springback and simultaneous palm/finger actions remain unverified.`, ["carton"]);
  for (const assumption of proposal.assumptions) add("ASSUME01", "trial_required", assumption);
  if (kit) {
    add("KIT_PHYS01", "trial_required", "The four independently lidded cells are unadmitted physical hypotheses. Test fresh empty/open insert loading, individual part handling, rolling/spillage, label matching, local flap sweep, tuck force, neighbour interference, mixing, carton closure, extraction and reset.", ["insert"]);
    add("KIT_PHYS02", "trial_required", "Symbolic quantities are proposed operations, not verified physical counts. A human must inspect actual group counts, segregation and every local closure. No ESD, electrical compatibility, repair performance or transport protection is established.", ["insert"]);
  }
  return results;
}
