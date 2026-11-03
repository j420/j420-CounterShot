import assert from "node:assert/strict";
import test from "node:test";
import { checkDesign } from "../src/checks";
import { workshopFacts, workshopProposal } from "../src/domain/demo";
import { FactsSchema, ProposalSchema, WorkshopFactsSchema, type WorkshopFacts, type Proposal } from "../src/domain/schema";
import { compileDesign, resolveWorkshopGeometry, COMPILER_VERSION } from "../src/geometry";

const facts = () => structuredClone(workshopFacts);
const proposal = () => structuredClone(workshopProposal);
const errors = (f: WorkshopFacts = workshopFacts, p: Proposal = workshopProposal) => checkDesign(f, p).filter(check => check.severity === "error");
function rechain(p: Proposal) { p.jigProgram!.actions.forEach((action, index, actions) => { action.dependsOn = index ? [actions[index - 1].id] : []; }); return p; }
const step = (p: Proposal, id: string) => p.jigProgram!.actions.find(action => action.id === id)!;

test("workshop example assembles six loose supplied panels, parks gate, extracts and resets", () => {
  assert.deepEqual(errors(), []);
  assert.equal(workshopProposal.program, null);
  assert.deepEqual(workshopProposal.actions, []);
  const actions = workshopProposal.jigProgram!.actions;
  for (const id of ["base", "left_wall", "right_wall", "rear_wall", "front_wall", "lid"]) assert.equal(actions.filter(action => action.operation === "take" && action.partId === id).length, 1);
  assert.equal(actions.at(-1)!.operation, "reset");
  assert.equal(actions.at(-1)!.partId, "jig");
});

test("workshop input schema is a measured profile and provider proposal remains an object", () => {
  assert.equal(FactsSchema.parse(workshopFacts).workflow, "workshop_jig");
  assert.equal(WorkshopFactsSchema.safeParse({ ...workshopFacts, jointZones: [] }).success, false);
  const parsed = ProposalSchema.parse(workshopProposal);
  assert.ok(parsed.jigProgram);
  assert.equal(parsed.program, null);
});

test("workshop joint force and actual support retention never become a physical pass", () => {
  const checks = checkDesign(workshopFacts, workshopProposal);
  assert.ok(checks.filter(check => check.severity === "trial_required").length >= 4);
  assert.ok(checks.some(check => /self-retention/.test(check.message) && check.severity === "trial_required"));
  assert.ok(checks.some(check => /motion path|three-dimensional/.test(check.message)));
});

test("taking another panel while a hand is occupied cannot overwrite the hold", () => {
  const p = proposal(); const taking = step(p, "take-left_wall");
  const index = p.jigProgram!.actions.indexOf(taking);
  p.jigProgram!.actions.splice(index + 1, 0, { ...taking, id: "duplicate-held-part" });
  rechain(p);
  assert.ok(errors(workshopFacts, p).some(check => check.ruleId === "WJ_HAND_OCCUPIED"));
});

test("a panel cannot appear located without its loose-part pickup", () => {
  const p = proposal(); p.jigProgram!.actions = p.jigProgram!.actions.filter(action => action.id !== "take-left_wall"); rechain(p);
  assert.ok(errors(workshopFacts, p).some(check => check.ruleId === "WJ_LOCATE"));
});

test("manual locating, joining and support release cannot be passive automation", () => {
  for (const id of ["locate-left_wall", "join-left_wall", "release-front-gate"]) {
    const p = proposal(); step(p, id).hand = "none";
    assert.ok(errors(workshopFacts, p).some(check => check.ruleId === "WJ_HAND"));
  }
});

test("the planner cannot add an unavailable joining operation", () => {
  const f = facts(); f.allowedOperations = f.allowedOperations.filter(operation => operation !== "join");
  assert.ok(errors(f).some(check => check.ruleId === "WJ_CAPABILITY"));
});

test("the initially parked gate engages only after fresh base placement", () => {
  const p = proposal();
  const actions = p.jigProgram!.actions;
  const engage = actions.splice(actions.findIndex(action => action.operation === "engage_support"), 1)[0];
  actions.unshift(engage); rechain(p);
  assert.ok(errors(workshopFacts, p).some(check => check.ruleId === "WJ_GATE_ENGAGE"));
});

test("the front wall cannot transfer holding duty to a parked gate", () => {
  const p = proposal(); p.jigProgram!.actions = p.jigProgram!.actions.filter(action => action.operation !== "engage_support"); rechain(p);
  assert.ok(errors(workshopFacts, p).some(check => check.ruleId === "WJ_GATE_DUTY"));
});

test("every unfinished wall retains its exact matching-edge brace duty through joining", () => {
  const p = proposal(); step(p, "join-left_wall").supportIds = ["right_front", "right_rear"];
  assert.ok(errors(workshopFacts, p).some(check => check.ruleId === "WJ_SUPPORT_DUTY"));
  const phantom = proposal(); step(phantom, "locate-left_wall").supportIds.push("lid");
  assert.ok(errors(workshopFacts, phantom).some(check => check.severity === "error" && /support/i.test(check.message)));
});

test("a locate-only feature cannot silently count as a stabilising brace", () => {
  const p = proposal(); p.jigProgram!.supports.filter(support => support.edge === "left").forEach(support => { support.role = "locate"; });
  assert.ok(errors(workshopFacts, p).some(check => check.ruleId === "WJ_SUPPORT_COVERAGE"));
});

test("a missing wall join cannot be replaced by describing a complete assembly", () => {
  const p = proposal(); p.jigProgram!.actions = p.jigProgram!.actions.filter(action => action.id !== "join-right_wall"); rechain(p);
  assert.ok(errors(workshopFacts, p).some(check => check.ruleId === "WJ_INCOMPLETE"));
});

test("lid location requires all four walls to be explicitly joined first", () => {
  const p = proposal(); const actions = p.jigProgram!.actions;
  const locate = actions.splice(actions.findIndex(action => action.id === "locate-lid"), 1)[0];
  actions.splice(actions.findIndex(action => action.id === "join-front_wall"), 0, locate); rechain(p);
  assert.ok(errors(workshopFacts, p).some(check => check.ruleId === "WJ_LID"));
});

test("gate release before complete self-retaining joints creates a blocking failure", () => {
  const p = proposal(); const actions = p.jigProgram!.actions;
  const release = actions.splice(actions.findIndex(action => action.operation === "release_support"), 1)[0];
  actions.splice(actions.findIndex(action => action.id === "join-lid"), 0, release); rechain(p);
  assert.ok(errors(workshopFacts, p).some(check => check.ruleId === "WJ_EARLY_RELEASE"));
  assert.ok(errors({ ...workshopFacts, completedJointsSelfRetain: false }).some(check => check.ruleId === "WJ_EARLY_RELEASE"));
});

test("extraction requires actual gate release and parking with the hand free", () => {
  const p = proposal(); p.jigProgram!.actions = p.jigProgram!.actions.filter(action => action.operation !== "park_support"); rechain(p);
  assert.ok(errors(workshopFacts, p).some(check => check.ruleId === "WJ_EXTRACT"));
});

test("reset cannot omit finished-output placement or leave the fixture occupied", () => {
  const p = proposal(); p.jigProgram!.actions = p.jigProgram!.actions.filter(action => action.operation !== "place_finished"); rechain(p);
  assert.ok(errors(workshopFacts, p).some(check => check.ruleId === "WJ_RESET" || check.ruleId === "WJ_CYCLE"));
});

test("continuous side rails block measured joint windows while split braces clear them", () => {
  const p = proposal();
  const left = p.jigProgram!.supports.find(support => support.id === "left_front")!;
  left.lengthMm = workshopFacts.workpieceDepthMm;
  assert.ok(errors(workshopFacts, p).some(check => check.ruleId === "WJ_JOINT_BLOCK"));
  assert.deepEqual(errors(), []);
});

test("serialized support cuts and scores preserve clearance before a measured joint window", () => {
  const f = facts(), p = proposal();
  p.jigProgram!.supports[0].lengthMm = 29.96;
  p.jigProgram!.supports[0].footDepthMm = 20.04;
  f.jointZones[0].startMm = 29.97;
  assert.deepEqual(errors(f, p), []);
  const pack = compileDesign(f, p, "precise-support");
  const supportSection = pack.packageSvg.slice(pack.packageSvg.indexOf("left_front /"));
  const cut = supportSection.match(/<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)" class="cut"\/>/)!;
  assert.ok(cut, "support has a serialized cut rectangle");
  const cutLength = Number(cut[3]);
  assert.equal(cutLength, 29.96);
  assert.ok(cutLength < f.jointZones[0].startMm);
  const score = supportSection.match(/<line x1="([^"]+)" y1="([^"]+)" x2="([^"]+)" y2="([^"]+)" class="score"\/>/)!;
  assert.ok(score, "support has a serialized score line");
  assert.ok(Math.abs(Number(score[3]) - Number(score[1]) - cutLength) < 1e-12);
  assert.ok(Math.abs(Number(score[2]) - Number(cut[2]) - 20.04) < 1e-12);
  assert.ok(pack.instructions.assembly.some(instruction => /Make left_front: cut 29\.96 mm/.test(instruction)));
  assert.ok(pack.instructions.assembly.some(instruction => /digits do not establish measurement or manufacturing accuracy/.test(instruction)));
  p.jigProgram!.supports[0].lengthMm = 29.98;
  assert.ok(errors(f, p).some(check => check.ruleId === "WJ_JOINT_BLOCK"));
});

test("serialized gate cuts preserve the checked material web between decimal reliefs", () => {
  const f = facts(), p = proposal();
  f.boardThicknessMm = 2.025;
  p.jigProgram!.gate.reliefs.push({ startMm: 0, lengthMm: 33.94, depthMm: 5 });
  assert.deepEqual(errors(f, p), []);
  const pack = compileDesign(f, p, "precise-notch-web");
  const path = pack.packageSvg.match(/<path d="([^"]+)" class="cut"\/>/)!;
  assert.ok(path, "gate has a serialized cut path");
  const points = [...path[1].matchAll(/[ML]([^, ]+),([^ ]+)/g)].map(match => [Number(match[1]), Number(match[2])]);
  // Following the descending top-edge path, these two corners bound the web
  // between the original right notch and the added left notch.
  const web = points[6][0] - points[7][0];
  assert.equal(points[6][1], points[7][1]);
  assert.ok(web >= 2 * f.boardThicknessMm, `serialized web ${web} preserves the measured-material minimum`);
  assert.ok(Math.abs(web - 4.06) < 1e-12);
  assert.ok(pack.instructions.assembly.some(instruction => /33\.94 mm wide/.test(instruction)));
  p.jigProgram!.gate.reliefs[1].lengthMm = 33.96;
  assert.ok(errors(f, p).some(check => check.ruleId === "WJ_GATE_RELIEF"));
  assert.throws(() => compileDesign(f, p, "too-small-decimal-web"));
});

test("front-gate relief is consequential geometry, not a cosmetic explanation", () => {
  const solid = proposal(); solid.jigProgram!.gate.reliefs = [];
  assert.ok(errors(workshopFacts, solid).some(check => check.ruleId === "WJ_GATE_JOINT_BLOCK"));
  assert.deepEqual(errors(), []);
});

test("gate relief cannot destroy the continuous lower material web", () => {
  const p = proposal(); p.jigProgram!.gate.reliefs[0].depthMm = 18;
  assert.ok(errors(workshopFacts, p).some(check => check.ruleId === "WJ_GATE_RELIEF"));
  assert.throws(() => compileDesign(workshopFacts, p, "invalid-relief"));
});

test("adjacent gate notches preserve the same material web required by the compiler", () => {
  const p = proposal(); p.jigProgram!.gate.reliefs.push({ startMm: 83, lengthMm: 10, depthMm: 5 });
  assert.ok(errors(workshopFacts, p).some(check => check.ruleId === "WJ_GATE_RELIEF"));
  assert.throws(() => compileDesign(workshopFacts, p, "invalid-notch-gap"));
  const decimal = proposal(); decimal.jigProgram!.gate.reliefs.push({ startMm: 0.2, lengthMm: 0.1, depthMm: 5 }, { startMm: 4.3, lengthMm: 10, depthMm: 5 });
  assert.ok(errors(workshopFacts, decimal).some(check => check.ruleId === "WJ_GATE_RELIEF"));
  assert.throws(() => compileDesign(workshopFacts, decimal, "matching-decimal-web"));
});

test("gate relief lower web includes signed cut-blank fold calibration", () => {
  const p = proposal(); p.jigProgram!.gate.heightMm = 10;
  p.jigProgram!.gate.reliefs = [{ startMm: 38, lengthMm: 44, depthMm: 6 }];
  assert.ok(errors({ ...workshopFacts, foldAllowanceMm: -3 }, p).some(check => check.ruleId === "WJ_GATE_RELIEF"));
  assert.throws(() => compileDesign({ ...workshopFacts, foldAllowanceMm: -3 }, p, "invalid-calibrated-notch"));
});

test("joint access measurements must cover every edge and remain on the panel", () => {
  const missing = facts(); missing.jointZones[3].edge = "rear";
  assert.ok(errors(missing).some(check => check.ruleId === "WJ_JOINT_FACT"));
  const outside = facts(); outside.jointZones[0].endMm = 200;
  assert.ok(errors(outside).some(check => check.ruleId === "WJ_JOINT_FACT"));
});

test("registration clearance cannot exceed the confirmed alignment tolerance", () => {
  const p = proposal(); p.jigProgram!.registrationClearanceMm = 2;
  assert.ok(errors(workshopFacts, p).some(check => check.ruleId === "WJ_ALIGNMENT"));
});

test("parked gate cannot block fresh base loading or the front release corridor", () => {
  const p = proposal(); p.jigProgram!.gate.parkingXMm = 110; p.jigProgram!.gate.parkingYMm = 80;
  assert.ok(errors(workshopFacts, p).some(check => check.ruleId === "WJ_GATE_PARK"));
});

test("complete gate and jig footprints must fit reachable workspace and actual sheets", () => {
  const p = proposal(); p.jigProgram!.gate.parkingXMm = 500;
  assert.ok(errors(workshopFacts, p).some(check => check.ruleId === "WJ_GATE_PARK"));
  assert.ok(errors({ ...workshopFacts, sheetWidthMm: 200, sheetHeightMm: 200 }).some(check => check.ruleId === "WJ_SHEET"));
});

test("tiny braces or gates cannot evade joint access by becoming unbuildable geometry", () => {
  for (const field of ["heightMm", "footDepthMm", "lengthMm"] as const) {
    const p = proposal(); p.jigProgram!.supports[0][field] = 0.1;
    assert.ok(errors(workshopFacts, p).some(check => check.ruleId === "WJ_MATERIAL"));
  }
  for (const field of ["heightMm", "footDepthMm"] as const) {
    const p = proposal(); p.jigProgram!.gate[field] = 0.1; p.jigProgram!.gate.reliefs = [];
    assert.ok(errors(workshopFacts, p).some(check => check.ruleId === "WJ_MATERIAL"));
  }
});

test("a calibrated score cannot leave an unbuildably small upright on the cut strip", () => {
  const p = proposal(); p.jigProgram!.supports[0].heightMm = 4;
  assert.ok(errors({ ...workshopFacts, foldAllowanceMm: -3 }, p).some(check => check.ruleId === "WJ_MATERIAL"));
});

test("action locations must correspond to their actual supplied panel edges", () => {
  const p = proposal(); step(p, "locate-left_wall").xMm = 10; step(p, "locate-left_wall").yMm = 10;
  assert.ok(errors(workshopFacts, p).some(check => check.ruleId === "WJ_TARGET"));
});

test("loose-part supply cannot secretly be located in the jig or release corridor", () => {
  const p = proposal(); step(p, "take-base").xMm = 180; step(p, "take-base").yMm = 100;
  assert.ok(errors(workshopFacts, p).some(check => check.ruleId === "WJ_SUPPLY_REGION"));
});

test("finished output cannot occupy the next cycle's declared loose-panel pickup points", () => {
  const p = proposal();
  p.jigProgram!.actions.filter(action => action.operation === "take").forEach(action => { action.xMm = 450; action.yMm = 300; });
  assert.ok(errors(workshopFacts, p).some(check => check.ruleId === "WJ_SUPPLY_REGION"));
});

test("finished output cannot occupy the next cycle's extraction corridor", () => {
  const p = proposal(); step(p, "place-finished").xMm = 180; step(p, "place-finished").yMm = 100;
  assert.ok(errors(workshopFacts, p).some(check => check.ruleId === "WJ_FINISHED_AREA"));
});

test("gate IDs and operation dependencies cannot alias hidden resources", () => {
  const p = proposal(); p.jigProgram!.gate.id = "assembly";
  assert.ok(errors(workshopFacts, p).some(check => check.ruleId === "WJ_SUPPORT_ID"));
  const cyclic = proposal(); cyclic.jigProgram!.actions[0].dependsOn = [cyclic.jigProgram!.actions.at(-1)!.id];
  assert.ok(errors(workshopFacts, cyclic).some(check => check.ruleId === "WJ_ORDER"));
});

test("gate and support names cannot duplicate the fixed jig-base cut blank", () => {
  const gate = proposal(); gate.jigProgram!.gate.id = "jig_base";
  gate.jigProgram!.actions.forEach(action => { action.supportIds = action.supportIds.map(id => id === "front_gate" ? "jig_base" : id); });
  assert.ok(errors(workshopFacts, gate).some(check => check.ruleId === "WJ_SUPPORT_ID"));
  assert.ok(errors(workshopFacts, gate).some(check => check.ruleId === "WJ_BLANK_ID"));
  assert.throws(() => compileDesign(workshopFacts, gate, "duplicate-gate-base"));
  const support = proposal(); support.jigProgram!.supports[0].id = "jig_base";
  assert.ok(errors(workshopFacts, support).some(check => check.ruleId === "WJ_SUPPORT_ID"));
  assert.ok(errors(workshopFacts, support).some(check => check.ruleId === "WJ_BLANK_ID"));
  assert.throws(() => compileDesign(workshopFacts, support, "duplicate-brace-base"));
});

test("the zero-lift nominal front release remains a physical test, not a universal motion proof", () => {
  const g = resolveWorkshopGeometry(workshopFacts, workshopProposal.jigProgram!);
  assert.equal(g.dimensions.nominalRequiredAssemblyLiftMm, 0);
  assert.deepEqual(errors({ ...workshopFacts, maximumAssemblyLiftMm: 0 }), []);
});

test("workshop export contains jig parts and setup, not a renamed package", () => {
  const pack = compileDesign(workshopFacts, workshopProposal, "workshop-exact-revision");
  assert.equal(COMPILER_VERSION, "3.0.2");
  for (const svg of [pack.packageSvg, pack.stationSvg]) {
    assert.match(svg, /width="[\d.]+mm"/);
    assert.match(svg, /50 × 50 mm/);
    assert.match(svg, /workshop-exact-revision/);
    assert.match(svg, /3\.0\.1/);
    assert.doesNotMatch(svg, /carton|parcel|compartment/i);
  }
  assert.match(pack.packageSvg, /LOCATION ONLY/);
  assert.match(pack.packageSvg, /RELIEF|relief/);
  assert.match(pack.stationSvg, /FRONT RELEASE/);
  assert.match(pack.printHtml, /100%|Actual size/);
});

test("workshop labels and instructions cannot inject SVG/HTML", () => {
  const p = proposal(); p.title = '<script>alert("jig")</script>'; step(p, "take-base").label = '<img src=x onerror="alert(1)">';
  const pack = compileDesign(workshopFacts, p, '<svg onload="bad()">');
  for (const artifact of [pack.packageSvg, pack.stationSvg, pack.printHtml]) assert.doesNotMatch(artifact, /<script>|<img src=x|<svg onload=/);
});

test("unsupported workshop outcome produces no construction pack", () => {
  const p = proposal(); p.outcome = "unsupported"; p.jigProgram = null;
  assert.ok(checkDesign(workshopFacts, p).some(check => check.ruleId === "WJ_OUTCOME"));
  assert.throws(() => compileDesign(workshopFacts, p, "unsupported"));
});
