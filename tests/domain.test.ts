import assert from "node:assert/strict";
import test from "node:test";
import { checkDesign } from "../src/checks";
import { demoFacts, demoProposal } from "../src/domain/demo";
import { FactsSchema, ObservationSchema, ProposalSchema } from "../src/domain/schema";
import { compileDesign, resolveDimensions } from "../src/geometry";

const errors = (facts = demoFacts, proposal = demoProposal) => checkDesign(facts, proposal).filter(c => c.severity === "error");
const proposal = () => structuredClone(demoProposal);

test("synthetic example has a complete logical cycle while every physical claim remains untested", () => {
  assert.deepEqual(errors(), []);
  const checks = checkDesign(demoFacts, demoProposal);
  assert.ok(checks.filter(c => c.severity === "trial_required").length >= 6);
  assert.ok(checks.some(c => /not been physically admitted/.test(c.message)));
});

test("strict provider schemas reject extra fields and fabricated facts", () => {
  assert.equal(FactsSchema.safeParse({ ...demoFacts, helperHand: true }).success, false);
  assert.equal(ProposalSchema.safeParse({ ...demoProposal, physicallyPassed: true }).success, false);
  assert.equal(ObservationSchema.safeParse({ summary: "missing all structured evidence" }).success, false);
  assert.equal(FactsSchema.safeParse({ ...demoFacts, boardThicknessMm: Number.NaN }).success, false);
});

test("persistent holding occupies the only hand even across separately worded steps", () => {
  const p = proposal();
  p.actions[1].holdAfter = "carton";
  assert.ok(errors(demoFacts, p).some(c => c.ruleId === "PLAN05"));
});

test("dropping a held object without receiving support fails", () => {
  const p = proposal();
  p.actions[1].supportAfter = null;
  assert.ok(errors(demoFacts, p).some(c => c.ruleId === "PLAN07"));
});

test("a no-hand action cannot magically change hand occupancy", () => {
  const p = proposal();
  p.actions[1].hand = "none";
  assert.ok(errors(demoFacts, p).some(c => c.ruleId === "PLAN06"));
});

test("an invented helper or unconfirmed body support is rejected", () => {
  const p = proposal();
  p.actions[1].supportAfter = "helper_left_hand";
  assert.ok(errors(demoFacts, p).some(c => c.ruleId === "PLAN04"));
});

test("the model cannot add an operation the operator did not explicitly permit", () => {
  const f = { ...demoFacts, allowedOperations: demoFacts.allowedOperations.filter(o => o !== "close") };
  assert.ok(errors(f).some(c => c.ruleId === "CAPABILITY01"));
  assert.equal(FactsSchema.safeParse({ ...demoFacts, allowedOperations: [] }).success, false);
});

test("dependency cycles and forward references are rejected in stored order", () => {
  const p = proposal();
  p.actions[0].dependsOn = [p.actions.at(-1)!.id];
  assert.ok(errors(demoFacts, p).some(c => c.ruleId === "PLAN02"));
});

test("duplicate action identities cannot alias another completed action", () => {
  const p = proposal();
  p.actions[1].id = p.actions[0].id;
  assert.ok(errors(demoFacts, p).some(c => c.ruleId === "PLAN01"));
});

test("complete sequence must load both stated contents before closure", () => {
  const p = proposal();
  p.actions[7].operation = "position";
  assert.ok(errors(demoFacts, p).some(c => c.ruleId === "PLAN10"));
});

test("omitting closure, final release or reset cannot pass", () => {
  for (const [operation, rule] of [["close", "PLAN14"], ["release", "PLAN15"], ["reset", "PLAN16"]] as const) {
    const p = proposal();
    p.actions = p.actions.filter(a => a.operation !== operation);
    assert.ok(errors(demoFacts, p).some(c => c.ruleId === rule), `${operation} omission`);
  }
});

test("fresh carton preparation is part of the operating cycle", () => {
  const p = proposal();
  p.actions[0].operation = "position";
  assert.ok(errors(demoFacts, p).some(c => c.ruleId === "PLAN13"));
});

test("a zero measured registration clearance remains a valid explicit value", () => {
  assert.deepEqual(errors({ ...demoFacts, slotClearanceMm: 0 }), []);
});

test("outer carton measurement cannot be inferred as smaller than its interior", () => {
  assert.ok(errors({ ...demoFacts, cartonOuterLengthMm: demoFacts.cartonLengthMm - 1 }).some(c => c.ruleId === "GEOM00"));
});

test("removing previously loaded contents invalidates the final contents predicate", () => {
  const p = proposal();
  p.actions.splice(8, 0, { ...p.actions[6], id: "remove-card", dependsOn: [p.actions[7].id] });
  assert.ok(errors(demoFacts, p).some(c => c.ruleId === "PLAN10"));
});

test("load cannot manufacture contents without a prior take", () => {
  const p = proposal();
  p.actions[6].holdAfter = null;
  p.actions[6].operation = "position";
  p.actions[6].supportAfter = "supply";
  assert.ok(errors(demoFacts, p).some(c => c.ruleId === "PLAN09"));
});

test("an insert cannot support contents before it has been placed in the carton", () => {
  const p = proposal();
  p.actions = p.actions.filter(a => a.objectId !== "insert");
  assert.ok(errors(demoFacts, p).some(c => c.ruleId === "PLAN18"));
});

test("releasing the finished carton requires an actual pickup", () => {
  const p = proposal();
  p.actions = p.actions.filter(a => a.id !== "take-finished");
  assert.ok(errors(demoFacts, p).some(c => c.ruleId === "PLAN11"));
});

test("reachable action coordinates must also refer to the actual carton location", () => {
  const p = proposal();
  p.actions[5].xMm = 1;
  p.actions[5].yMm = 1;
  assert.ok(errors(demoFacts, p).some(c => c.ruleId === "REACH03"));
});

test("final parcel cannot remain at the station", () => {
  const p = proposal();
  p.actions[10].supportAfter = "station";
  assert.ok(errors(demoFacts, p).some(c => c.ruleId === "PLAN11"));
});

test("confirmed planar reach is checked for every operation", () => {
  const p = proposal();
  p.actions[5].xMm = demoFacts.reachWidthMm + 1;
  assert.ok(errors(demoFacts, p).some(c => c.ruleId === "REACH02"));
});

test("material thickness participates in tray-to-carton fit", () => {
  const f = { ...demoFacts, itemWidthMm: 132, boardThicknessMm: 2 };
  assert.ok(errors(f).some(c => c.ruleId === "GEOM02"));
});

test("fractional item dimensions survive the actual cut blank and score coordinates", () => {
  const f = { ...demoFacts, itemLengthMm: 100.04 };
  const p = proposal(); p.program.insertClearanceMm = 0;
  assert.deepEqual(errors(f, p), []);
  const dimensions = resolveDimensions(f, p);
  assert.equal(dimensions.trayInnerLengthMm, 100.04);
  const pack = compileDesign(f, p, "fractional-tray");
  const blankWidth = Number(pack.packageSvg.match(/<rect x="24" y="24" width="([^"]+)"/)?.[1]);
  assert.equal(blankWidth, dimensions.blankLengthMm);
  assert.ok(Math.abs(blankWidth - 133.04) < 1e-10);
  const scoreXs = [...pack.packageSvg.matchAll(/<line x1="([^"]+)" y1="([^"]+)" x2="([^"]+)" y2="([^"]+)" class="score"/g)]
    .filter(match => match[1] === match[3]).map(match => Number(match[1]));
  assert.equal(scoreXs.length, 2);
  assert.ok(Math.abs(scoreXs[1] - scoreXs[0] - 103.04) < 1e-10);
  assert.match(pack.packageSvg, /Digits specify geometry; measure and verify actual part accuracy/);
});

test("a fractional tray overrun cannot round down to a passing carton fit", () => {
  const f = { ...demoFacts, itemLengthMm: demoFacts.cartonLengthMm - 2 * demoFacts.boardThicknessMm + 0.04 };
  const p = proposal(); p.program.insertClearanceMm = 0;
  assert.ok(resolveDimensions(f, p).trayOuterLengthMm > f.cartonLengthMm);
  assert.ok(errors(f, p).some(c => c.ruleId === "GEOM02"));
});

test("tray height includes the base material and detects impossible closure space", () => {
  assert.ok(errors({ ...demoFacts, itemHeightMm: demoFacts.cartonHeightMm }).some(c => c.ruleId === "GEOM03"));
});

test("all cut blanks fit actual sheet dimensions, with rotation allowed", () => {
  assert.ok(errors({ ...demoFacts, sheetWidthMm: 100, sheetHeightMm: 100 }).some(c => c.ruleId === "GEOM07"));
  assert.deepEqual(errors({ ...demoFacts, sheetWidthMm: demoFacts.sheetHeightMm, sheetHeightMm: demoFacts.sheetWidthMm }), []);
});

test("fixture envelope includes its exterior feet rather than only the carton footprint", () => {
  const p = proposal();
  p.program.offsetXMm = demoFacts.workspaceWidthMm - demoFacts.cartonLengthMm;
  assert.ok(errors(demoFacts, p).some(c => c.ruleId === "GEOM09"));
});

test("uncertain required facts prevent construction release", () => {
  const p = proposal();
  p.missingFacts = ["Actual board thickness has not been measured"];
  assert.ok(errors(demoFacts, p).some(c => c.ruleId === "FACT01"));
});

test("shared dimensions are computed once and propagate to connected tray geometry", () => {
  const before = resolveDimensions(demoFacts, demoProposal);
  const after = resolveDimensions({ ...demoFacts, itemWidthMm: demoFacts.itemWidthMm! + 5 }, demoProposal);
  for (const name of ["trayInnerWidthMm", "trayOuterWidthMm", "blankWidthMm"]) {
    assert.equal(after[name] - before[name], 5, name);
  }
});

test("compiler emits deterministic, full-scale drawings bound to the revision", () => {
  const hash = "test-revision-012345";
  const pack = compileDesign(demoFacts, demoProposal, hash);
  assert.deepEqual(pack, compileDesign(demoFacts, demoProposal, hash));
  for (const svg of [pack.packageSvg, pack.stationSvg]) {
    assert.match(svg, /<svg[^>]+width="[\d.]+mm"/);
    assert.match(svg, /height="[\d.]+mm"/);
    assert.match(svg, /viewBox=/);
    assert.match(svg, /50/);
    assert.match(svg, new RegExp(hash));
  }
  assert.ok(pack.instructions.tests.length >= 5);
  assert.match(pack.printHtml, /100%|actual.size/i);
});

test("construction text cannot inject SVG or print HTML", () => {
  const p = proposal();
  p.title = '<script>alert("bad")</script>';
  p.actions[0].label = '<img src=x onerror="alert(1)">';
  p.assumptions.push('<script>alert("bad")</script>');
  const pack = compileDesign(demoFacts, p, '<svg onload="alert(1)">');
  for (const text of [pack.packageSvg, pack.stationSvg, pack.printHtml]) {
    assert.doesNotMatch(text, /<script>|<img src=x|<svg onload=/);
  }
});

test("noncandidate outcomes never produce downloadable construction geometry", () => {
  const p = proposal();
  p.outcome = "unsupported";
  assert.throws(() => compileDesign(demoFacts, p, "revision"));
  assert.ok(checkDesign(demoFacts, p).some(c => c.ruleId === "DESIGN01"));
});
