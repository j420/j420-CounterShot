import test from "node:test";
import assert from "node:assert/strict";
import { compileDesign, renderPrintPack } from "../src/lib/geometry";
import type { DesignRevision, InputSnapshot } from "../src/lib/contracts";
import { makeConstraints, makeProposal } from "./fixtures";

test("shared fit graph drives coordinated package, insert and station", () => {
  const c = makeConstraints(),
    p = makeProposal();
  const a = compileDesign(p, c);
  const b = compileDesign(p, { ...c, itemLengthMm: c.itemLengthMm + 20 });
  assert.equal(a.report.valid, true, JSON.stringify(a.report.issues));
  assert.equal(
    b.sharedDimensions.insertLengthMm - a.sharedDimensions.insertLengthMm,
    20,
  );
  assert.equal(
    b.sharedDimensions.packageLengthMm - a.sharedDimensions.packageLengthMm,
    20,
  );
  assert.equal(
    b.sharedDimensions.stationWidthMm - a.sharedDimensions.stationWidthMm,
    20,
  );
  assert.equal(
    a.sharedDimensions.packageLengthMm - a.sharedDimensions.insertLengthMm,
    p.clearanceMm * 2,
  );
  assert.ok(
    a.drawings.every(
      (d) => d.svg.includes("50 mm") && d.svg.includes('width="50"'),
    ),
  );
  assert.ok(
    a.drawings.every(
      (d) =>
        d.svg.includes("CUT") &&
        d.svg.includes("SCORE / FOLD") &&
        d.svg.includes("REFERENCE ONLY"),
    ),
  );
});

test("orientation changes both axes through the same graph", () => {
  const a = compileDesign(makeProposal(), makeConstraints());
  const b = compileDesign(
    makeProposal({ orientation: "portrait" }),
    makeConstraints(),
  );
  assert.equal(
    b.sharedDimensions.packageLengthMm,
    a.sharedDimensions.packageWidthMm,
  );
  assert.equal(
    b.sharedDimensions.insertLengthMm,
    a.sharedDimensions.insertWidthMm,
  );
});

test("existing carton fit is validated against measured usable interior", () => {
  const p = makeProposal({ packageFamily: "tuck_carton" });
  const tooSmall = compileDesign(
    p,
    makeConstraints({
      packageFamily: "tuck_carton",
      cartonLengthMm: 185,
      cartonWidthMm: 125,
      cartonHeightMm: 20,
    }),
  );
  assert.equal(tooSmall.report.valid, false);
  assert.ok(tooSmall.report.issues.some((i) => i.rule === "PACKAGE_FIT"));
  const fits = compileDesign(
    p,
    makeConstraints({
      packageFamily: "tuck_carton",
      cartonLengthMm: 240,
      cartonWidthMm: 180,
      cartonHeightMm: 50,
    }),
  );
  assert.equal(fits.report.valid, true, JSON.stringify(fits.report.issues));
  assert.equal(
    fits.cutList.some((p) => p.part.startsWith("P00")),
    false,
  );
  assert.ok(
    fits.drawings.some((d) => d.id === "P00" && d.title.includes("do not cut")),
  );
});

test("stock sheet and station bounds are hard checks", () => {
  const smallSheet = compileDesign(
    makeProposal(),
    makeConstraints({ sheetWidthMm: 150, sheetHeightMm: 150 }),
  );
  assert.equal(smallSheet.report.valid, false);
  assert.equal(smallSheet.drawings.length, 0);
  assert.ok(smallSheet.report.issues.some((i) => i.rule === "STOCK_SHEET_FIT"));
  const offBoard = compileDesign(
    makeProposal({ stationXMm: 790 }),
    makeConstraints(),
  );
  assert.ok(offBoard.report.issues.some((i) => i.rule === "STATION_BOUNDS"));
});

test("geometry and material corrections preserve physical admission requirements", () => {
  const result = compileDesign(makeProposal(), makeConstraints());
  assert.ok(
    result.report.issues.some(
      (i) =>
        i.rule === "FLAT_BLANK_CLEARANCE" && i.severity === "trial_required",
    ),
  );
  assert.ok(
    result.report.issues.some((i) => i.rule === "MATERIAL_CALIBRATION"),
  );
  const invalidWall = compileDesign(
    makeProposal({ insertWallHeightMm: 1 }),
    makeConstraints(),
  );
  assert.ok(
    invalidWall.report.issues.some(
      (i) => i.rule === "MATERIAL_FIT" && i.severity === "error",
    ),
  );
});

test("arrangements produce distinct exterior support parts", () => {
  const corner = compileDesign(makeProposal(), makeConstraints());
  const sides = compileDesign(
    makeProposal({ arrangement: "side_guides" }),
    makeConstraints(),
  );
  const park = compileDesign(
    makeProposal({ arrangement: "flap_parking" }),
    makeConstraints(),
  );
  assert.notEqual(
    corner.drawings.find((d) => d.id === "S01")!.svg,
    sides.drawings.find((d) => d.id === "S01")!.svg,
  );
  assert.ok(park.drawings.some((d) => d.title.includes("parking")));
  assert.equal(
    park.sharedDimensions.stationWidthMm -
      corner.sharedDimensions.stationWidthMm,
    60,
  );
});

function printFixture() {
  const constraints = makeConstraints();
  const proposal = makeProposal({
    title: '<script>alert("x")</script>',
    steps: makeProposal().steps.map((s) => ({
      ...s,
      instruction: '<img src=x onerror="alert(1)">',
    })),
  });
  const snapshot: InputSnapshot = {
    id: "snapshot-1",
    hash: "input-hash-1",
    constraints,
    observation: null,
    createdAt: "2026-11-02T10:00:00Z",
  };
  const design: DesignRevision = {
    id: "design-1",
    number: 1,
    parentId: null,
    inputSnapshotId: snapshot.id,
    inputHash: snapshot.hash,
    createdAt: snapshot.createdAt,
    proposal,
    compiled: compileDesign(proposal, constraints),
    sourceTrialId: null,
    model: "software-test",
    responseId: null,
  };
  return { design, snapshot };
}

test("model text is escaped in SVG and printable instructions", () => {
  const { design, snapshot } = printFixture();
  assert.ok(design.compiled.drawings.every((d) => !d.svg.includes("<script>")));
  const html = renderPrintPack(design, snapshot);
  assert.equal(html.includes("<script>alert"), false);
  assert.equal(html.includes("<img src=x"), false);
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("&lt;img"));
});

test("A4 print tiles use physical units and overlap without scaling to page", () => {
  const { design, snapshot } = printFixture();
  const html = renderPrintPack(design, snapshot);
  assert.ok(html.includes('width="190mm" height="265mm"'));
  assert.ok(html.includes('viewBox="180 0 190 265"'));
  assert.ok(html.includes("10 mm overlap"));
  assert.ok(html.includes("Never use Fit to page"));
  assert.ok(html.includes("browser Print command"));
  assert.equal(html.includes("onclick="), false);
  assert.ok(html.includes(snapshot.hash));
});

test("print packs reject mismatched snapshots and unsafe stored markup", () => {
  const { design, snapshot } = printFixture();
  assert.throws(
    () => renderPrintPack(design, { ...snapshot, hash: "different" }),
    /do not match/,
  );
  design.compiled.drawings[0].svg = "<svg><script>alert(1)</script></svg>";
  assert.throws(() => renderPrintPack(design, snapshot), /Unsafe/);
});

test("invalid constraints produce no fabricated dimensions or files", () => {
  const result = compileDesign(
    makeProposal(),
    makeConstraints({ cardboardThicknessMm: Infinity }),
  );
  assert.equal(result.report.valid, false);
  assert.equal(result.drawings.length, 0);
  assert.equal(result.cutList.length, 0);
});
