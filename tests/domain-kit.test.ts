import assert from "node:assert/strict";
import test from "node:test";
import { checkDesign } from "../src/checks";
import { demoFacts, demoProposal, kitFacts, kitProposal } from "../src/domain/demo";
import { FactsSchema, LegacyFactsSchema, KIT_COMPONENT_IDS, LegacyProposalSchema, ProposalSchema, upgradeLegacyFacts, upgradeLegacyProposal, type LegacyFacts as Facts, type LegacyProposal as Proposal } from "../src/domain/schema";
import { compileDesign, getKitCells, resolveDimensions } from "../src/geometry";

const proposal = () => structuredClone(kitProposal);
const facts = () => structuredClone(kitFacts);
const errors = (f: Facts = kitFacts, p: Proposal = kitProposal) => checkDesign(f, p).filter(check => check.severity === "error");
function rechain(p: Proposal) { p.actions.forEach((action, index) => { action.dependsOn = index ? [p.actions[index - 1].id] : []; }); return p; }

test("kit example fulfils four exact group counts using individual unrolled parts and independent closures", () => {
  assert.deepEqual(errors(), []);
  assert.equal(kitProposal.actions.length, 38);
  assert.equal(kitFacts.itemLengthMm, null);
  assert.equal(kitFacts.itemWidthMm, null);
  assert.equal(kitFacts.itemHeightMm, null);
  for (const group of kitFacts.kitComponents) {
    const loads = kitProposal.actions.filter(action => action.operation === "load" && action.objectId === group.id);
    assert.equal(loads.length, group.requiredCount);
    assert.ok(loads.every(action => action.quantity === 1 && action.compartmentId === group.id && action.supportAfter === `compartment_${group.id}`));
    assert.equal(kitProposal.actions.filter(action => action.operation === "close" && action.objectId === `compartment_${group.id}`).length, 1);
  }
});

test("kit has no geometry-only or synthetic physical admission", () => {
  const checks = checkDesign(kitFacts, kitProposal);
  assert.ok(checks.some(check => check.ruleId === "KIT_PHYS01" && check.severity === "trial_required"));
  assert.ok(checks.some(check => check.ruleId === "KIT_PHYS02" && /not verified physical counts/.test(check.message)));
});

test("missing, duplicate or unmeasured target groups block a kit candidate", () => {
  const missing = facts(); missing.kitComponents.pop();
  assert.ok(errors(missing).some(check => check.ruleId === "KIT01"));
  const duplicate = facts(); duplicate.kitComponents[3].id = "screws";
  assert.ok(errors(duplicate).some(check => check.ruleId === "KIT01"));
  const unmeasured = facts(); (unmeasured.kitComponents[0] as unknown as Record<string, unknown>).bundleHeightMm = null;
  assert.ok(errors(unmeasured).some(check => check.ruleId === "SCHEMA01"));
});

test("the layout cannot silently omit or double-assign a component", () => {
  const p = proposal(); p.program.kitLayout!.cellOrder[3] = "screws";
  assert.ok(errors(kitFacts, p).some(check => check.ruleId === "KIT02"));
  p.program.kitLayout = null;
  assert.ok(errors(kitFacts, p).some(check => check.ruleId === "KIT02"));
});

test("omitting a part creates an undercount at local closure and final completion", () => {
  const p = proposal();
  p.actions = p.actions.filter(action => action.id !== "take-screws-4" && action.id !== "load-screws-4");
  rechain(p);
  assert.ok(errors(kitFacts, p).some(check => check.ruleId === "KIT15"));
  assert.ok(errors(kitFacts, p).some(check => check.ruleId === "KIT17"));
});

test("quantity batches cannot hide counting or a helper preload", () => {
  const p = proposal();
  p.actions.find(action => action.id === "take-screws-1")!.quantity = 4;
  p.actions.find(action => action.id === "load-screws-1")!.quantity = 4;
  assert.ok(errors(kitFacts, p).some(check => check.ruleId === "KIT08"));
});

test("taking another part of the same group while already holding one is rejected", () => {
  const p = proposal();
  const first = p.actions.find(action => action.id === "take-screws-1")!;
  const index = p.actions.indexOf(first);
  p.actions.splice(index + 1, 0, { ...first, id: "extra-same-group-take" });
  rechain(p);
  assert.ok(errors(kitFacts, p).some(check => check.ruleId === "KIT18"));
});

test("an extra individually loaded part is an overcount, not ignored inventory", () => {
  const p = proposal();
  const pickup = { ...p.actions.find(action => action.id === "take-screws-1")!, id: "take-extra-screw" };
  const load = { ...p.actions.find(action => action.id === "load-screws-1")!, id: "load-extra-screw" };
  p.actions.splice(p.actions.findIndex(action => action.id === "close-screws"), 0, pickup, load);
  rechain(p);
  assert.ok(errors(kitFacts, p).some(check => check.ruleId === "KIT13"));
});

test("cross-mixing and wrong-compartment metadata cannot satisfy exact contents", () => {
  const p = proposal();
  const load = p.actions.find(action => action.id === "load-screws-1")!;
  load.supportAfter = "compartment_washers";
  assert.ok(errors(kitFacts, p).some(check => check.ruleId === "KIT11"));
  load.compartmentId = "washers";
  assert.ok(errors(kitFacts, p).some(check => check.ruleId === "KIT08"));
});

test("phantom compartments cannot support a carton-only workflow", () => {
  const p = structuredClone(demoProposal);
  p.actions[1].supportAfter = "compartment_screws";
  assert.ok(errors(demoFacts, p).some(check => check.ruleId === "KIT07"));
});

test("a compartment cannot become an arbitrary card-parking or pre-insert support", () => {
  const p = proposal();
  const card = p.actions.find(action => action.id === "load-inventory-slip")!;
  card.operation = "position"; card.supportAfter = "compartment_screws";
  assert.ok(errors(kitFacts, p).some(check => check.ruleId === "KIT20"));
  const beforeInsert = proposal();
  beforeInsert.actions[1].supportAfter = "compartment_washers";
  assert.ok(errors(kitFacts, beforeInsert).some(check => check.ruleId === "KIT20"));
});

test("component quantities cannot be smuggled into position or fold actions", () => {
  for (const operation of ["position", "fold"] as const) {
    const p = proposal(); p.actions.find(action => action.id === "load-screws-1")!.operation = operation;
    assert.ok(errors(kitFacts, p).some(check => check.ruleId === "KIT08"));
  }
});

test("a cell cannot close before its full target count", () => {
  const p = proposal();
  const closing = p.actions.splice(p.actions.findIndex(action => action.id === "close-screws"), 1)[0];
  p.actions.splice(4, 0, closing);
  rechain(p);
  assert.ok(errors(kitFacts, p).some(check => check.ruleId === "KIT15"));
});

test("a locally closed cell cannot accept a later loose component", () => {
  const p = proposal();
  const pickup = { ...p.actions.find(action => action.id === "take-screws-1")!, id: "take-after-close" };
  const load = { ...p.actions.find(action => action.id === "load-screws-1")!, id: "load-after-close" };
  p.actions.splice(p.actions.findIndex(action => action.id === "close-screws") + 1, 0, pickup, load);
  rechain(p);
  assert.ok(errors(kitFacts, p).some(check => check.ruleId === "KIT12"));
});

test("outer carton closure cannot substitute for four local closures", () => {
  const p = proposal(); p.actions = p.actions.filter(action => action.id !== "close-grommets"); rechain(p);
  assert.ok(errors(kitFacts, p).some(check => check.ruleId === "KIT16"));
});

test("passive fixtures cannot secretly perform manual cell closures or component loads", () => {
  for (const id of ["close-screws", "load-screws-1", "close-carton"]) {
    const p = proposal(); p.actions.find(action => action.id === id)!.hand = "none";
    assert.ok(errors(kitFacts, p).some(check => check.ruleId === "CAPABILITY02"));
  }
});

test("the inventory slip remains part of the exact finished kit", () => {
  const p = proposal(); p.actions = p.actions.filter(action => action.objectId !== "card"); rechain(p);
  assert.ok(errors(kitFacts, p).some(check => check.ruleId === "PLAN17"));
});

test("load coordinates must resolve into the actual assigned cell", () => {
  const p = proposal();
  const screw = p.actions.find(action => action.id === "load-screws-1")!;
  const washer = p.actions.find(action => action.id === "load-washers-1")!;
  screw.xMm = washer.xMm; screw.yMm = washer.yMm;
  assert.ok(errors(kitFacts, p).some(check => check.ruleId === "KIT09"));
});

test("changing cell mapping requires the matching action locations to change", () => {
  const p = proposal();
  p.program.kitLayout!.cellOrder = ["washers", "screws", "grommets", "spacers"];
  assert.ok(errors(kitFacts, p).some(check => check.ruleId === "KIT09"));
});

test("part-group height, closed stack and full diecut sheets are grounded", () => {
  const tall = facts(); tall.kitComponents[0].bundleHeightMm = 30;
  assert.ok(errors(tall).some(check => check.ruleId === "KIT03"));
  assert.ok(errors({ ...kitFacts, cartonHeightMm: 20 }).some(check => check.ruleId === "KIT04"));
  assert.ok(errors({ ...kitFacts, sheetWidthMm: 110, sheetHeightMm: 90 }).some(check => check.ruleId === "KIT05"));
});

test("fractional closed-stack overrun cannot round down to a passing carton height", () => {
  const f = { ...facts(), boardThicknessMm: 2.014, cartonHeightMm: 28.02 };
  const p = proposal(); p.program.kitLayout!.dividerHeightMm = 22.004;
  assert.equal(resolveDimensions(f, p).kitClosedStackHeightMm, 28.046);
  assert.ok(errors(f, p).some(check => check.ruleId === "KIT04"));
});

test("fractional cell cut paths and receiving slots preserve the measured dimensions", () => {
  const f = { ...facts(), boardThicknessMm: 2.014 };
  const p = proposal(); p.program.kitLayout!.dividerHeightMm = 22.004;
  const first = getKitCells(f, p)[0];
  assert.equal(first.outerLengthMm, 43.028);
  const pack = compileDesign(f, p, "fractional-cells");
  const firstPath = pack.packageSvg.match(/<path d="M([^,]+),([^ ]+) L([^,]+),([^ ]+)[^"]*" class="cut"/);
  assert.ok(firstPath);
  assert.ok(Math.abs(Number(firstPath[3]) - Number(firstPath[1]) - 43.028) < 1e-10);
  const slots = [...pack.packageSvg.matchAll(/<rect x="[^"]+" y="[^"]+" width="([^"]+)" height="([^"]+)" class="cut"/g)];
  assert.ok(slots.some(match => Number(match[1]) === first.slotWidthMm && Number(match[2]) === 2.514));
});

test("slot-web and tongue checks reject geometry the compiler cannot construct", () => {
  const p = proposal(); p.program.kitLayout!.dividerHeightMm = 4;
  assert.ok(errors(kitFacts, p).some(check => check.ruleId === "KIT19"));
});

test("individual cell rectangles are disjoint and fit the shared carrier", () => {
  const cells = getKitCells(kitFacts, kitProposal);
  const dimensions = resolveDimensions(kitFacts, kitProposal);
  for (const cell of cells) {
    assert.ok(cell.xMm >= 0 && cell.yMm >= 0);
    assert.ok(cell.xMm + cell.outerLengthMm <= dimensions.trayInnerLengthMm);
    assert.ok(cell.yMm + cell.outerWidthMm <= dimensions.trayInnerWidthMm);
  }
  for (const a of cells) for (const b of cells) if (a.id !== b.id) {
    const overlap = a.xMm < b.xMm + b.outerLengthMm && a.xMm + a.outerLengthMm > b.xMm && a.yMm < b.yMm + b.outerWidthMm && a.yMm + a.outerWidthMm > b.yMm;
    assert.equal(overlap, false, `${a.id} overlaps ${b.id}`);
  }
});

test("capacity derives from actual full-group envelopes rather than invented per-part volume", () => {
  const before = resolveDimensions(kitFacts, kitProposal);
  const sameEnvelope = facts(); sameEnvelope.kitComponents[0].requiredCount = 8;
  assert.deepEqual(resolveDimensions(sameEnvelope, kitProposal), before);
  const changedEnvelope = facts(); changedEnvelope.kitComponents[0].bundleLengthMm += 20;
  assert.ok(resolveDimensions(changedEnvelope, kitProposal).trayInnerLengthMm > before.trayInnerLengthMm);
});

test("kit exports include all actual cell IDs, group labels, counts and full-scale geometry", () => {
  const pack = compileDesign(kitFacts, kitProposal, "kit-test-exact-revision");
  for (const cell of getKitCells(kitFacts, kitProposal)) {
    assert.ok(pack.packageSvg.includes(cell.id));
    assert.ok(pack.packageSvg.includes(cell.label));
    assert.ok(pack.stationSvg.includes(cell.label));
  }
  assert.match(pack.packageSvg, /hinge|HINGE|lid|LID/);
  assert.match(pack.packageSvg, /slot|SLOT/);
  assert.match(pack.packageSvg, /width="[\d.]+mm"/);
  assert.match(pack.packageSvg, /50 × 50 mm/);
  assert.match(pack.printHtml, /EMPTY|empty/);
  assert.match(pack.printHtml, /physical|Physical/);
});

test("component labels and instructions cannot inject SVG or print HTML", () => {
  const f = facts(); f.kitComponents[0].label = '<script>alert("component")</script>';
  const p = proposal(); p.actions[5].label = '<img src=x onerror="alert(1)">';
  const pack = compileDesign(f, p, "escaping-test");
  assert.doesNotMatch(pack.packageSvg, /<script>/);
  assert.doesNotMatch(pack.stationSvg, /<script>/);
  assert.doesNotMatch(pack.printHtml, /<script>|<img src=x/);
});

test("legacy migration fills only absent carton metadata and never adds kit capability", () => {
  const legacyFacts: Record<string, unknown> = structuredClone(demoFacts);
  delete legacyFacts.workflow; delete legacyFacts.kitComponents;
  const original = structuredClone(legacyFacts);
  const upgraded = LegacyFactsSchema.parse(upgradeLegacyFacts(legacyFacts));
  assert.equal(upgraded.workflow, "carton_packing");
  assert.deepEqual(upgraded.kitComponents, []);
  assert.deepEqual(upgraded.allowedOperations, demoFacts.allowedOperations);
  assert.deepEqual(legacyFacts, original);
  const legacyProposal = structuredClone(demoProposal) as unknown as Record<string, unknown>;
  const program = legacyProposal.program as Record<string, unknown>; delete program.kitLayout;
  for (const action of legacyProposal.actions as Record<string, unknown>[]) { delete action.quantity; delete action.compartmentId; }
  const migrated = LegacyProposalSchema.parse(upgradeLegacyProposal(legacyProposal));
  assert.equal(migrated.program.kitLayout, null);
  assert.ok(migrated.actions.every(action => action.quantity === null && action.compartmentId === null));
  assert.deepEqual(errors(upgraded, migrated), []);
});

test("legacy carton requires actual item dimensions while kit derives them from groups", () => {
  assert.ok(errors({ ...demoFacts, itemLengthMm: null }, demoProposal).some(check => check.ruleId === "FACT01"));
  assert.deepEqual(errors(kitFacts, kitProposal), []);
  assert.deepEqual([...KIT_COMPONENT_IDS].sort(), kitFacts.kitComponents.map(component => component.id).sort());
});
