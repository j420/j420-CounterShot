import test from "node:test";
import assert from "node:assert/strict";
import { validatePlan, deriveTrialOutcome } from "../src/lib/domain";
import type { TrialInput } from "../src/lib/contracts";
import { makeConstraints, makeProposal } from "./fixtures";

test("complete declared cycle passes logical checks while retaining physical uncertainty", () => {
  const report = validatePlan(makeProposal(), makeConstraints());
  assert.equal(report.valid, true, JSON.stringify(report.issues));
  assert.ok(
    report.issues.some(
      (i) => i.rule === "PHYSICAL_PROOF" && i.severity === "trial_required",
    ),
  );
});

test("a hand remains occupied across superficially sequential instructions", () => {
  const p = makeProposal();
  p.steps[0].supportChangesAfter = [
    { objectId: "flap", provider: "right_hand", role: "hold_open" },
  ];
  const report = validatePlan(p, makeConstraints());
  assert.equal(report.valid, false);
  assert.ok(report.issues.some((i) => i.rule === "PLAN_HAND_CONFLICT"));
});

test("an explicit earlier support transfer frees the hand", () => {
  const p = makeProposal();
  p.steps[0].activeObjectId = "flap";
  p.steps[0].supportChangesAfter = [
    { objectId: "flap", provider: "right_hand", role: "hold_open" },
  ];
  p.steps[1].activeObjectId = "flap";
  p.steps[1].supportChangesAfter.push({
    objectId: "flap",
    provider: "station",
    role: "hold_open",
  });
  const report = validatePlan(p, makeConstraints());
  assert.equal(
    report.valid,
    true,
    JSON.stringify(report.issues.filter((i) => i.severity === "error")),
  );
});

test("one-handed profile cannot silently use left hand or two hands", () => {
  const p = makeProposal();
  p.steps[2].activeHand = "both";
  p.steps[3].supportsDuring.push({
    objectId: "flap",
    provider: "left_hand",
    role: "retain",
  });
  assert.ok(
    validatePlan(p, makeConstraints()).issues.some(
      (i) => i.rule === "PLAN_HAND",
    ),
  );
});

test("missing reset and release effects cannot pass", () => {
  const p = makeProposal();
  p.steps.pop();
  p.steps.at(-1)!.releaseObjectsAfter = [];
  const report = validatePlan(p, makeConstraints());
  assert.equal(report.valid, false);
  assert.ok(report.issues.some((i) => i.rule === "PLAN_FULL_CYCLE"));
  assert.ok(report.issues.some((i) => i.rule === "PLAN_RELEASE"));
});

test("dependency graph, not labels alone, establishes stage order", () => {
  const p = makeProposal();
  p.steps[5].dependsOn = [];
  assert.ok(
    validatePlan(p, makeConstraints()).issues.some(
      (i) => i.rule === "PLAN_PHASE_DEPENDENCY",
    ),
  );
  p.steps[0].dependsOn = ["reset"];
  p.steps[5].dependsOn = ["retain"];
  assert.ok(
    validatePlan(p, makeConstraints()).issues.some(
      (i) => i.rule === "PLAN_CYCLE",
    ),
  );
});

test("checker cannot silently reorder a different displayed operating sequence", () => {
  const p = makeProposal();
  [p.steps[1], p.steps[2]] = [p.steps[2], p.steps[1]];
  const report = validatePlan(p, makeConstraints());
  assert.equal(report.valid, false);
  assert.ok(report.issues.some((i) => i.rule === "PLAN_DISPLAY_ORDER"));
});

test("out-of-workspace action and missing declared capability are rejected", () => {
  const p = makeProposal();
  p.steps[2].xMm = 900;
  const report = validatePlan(
    p,
    makeConstraints({ allowedActions: ["grasp"] }),
  );
  assert.ok(report.issues.some((i) => i.rule === "PLAN_REACH"));
  assert.ok(report.issues.some((i) => i.rule === "PLAN_CAPABILITY"));
});

test("a plan cannot rely on an insert it does not include", () => {
  assert.ok(
    validatePlan(
      makeProposal({ insert: "none" }),
      makeConstraints(),
    ).issues.some((i) => i.rule === "PLAN_SUPPORT"),
  );
});

test("omitting all parcel support cannot hide the original holding duty", () => {
  const p = makeProposal();
  p.steps.forEach((s) => {
    s.supportsDuring = [];
    s.supportChangesAfter = [];
  });
  const report = validatePlan(p, makeConstraints());
  assert.equal(report.valid, false);
  assert.ok(report.issues.some((i) => i.rule === "PLAN_MISSING_SUPPORT"));
});

test("releasing an unrelated object cannot satisfy parcel extraction", () => {
  const p = makeProposal();
  p.steps.find((s) => s.operation === "release")!.releaseObjectsAfter = [
    "unused_scrap",
  ];
  const report = validatePlan(p, makeConstraints());
  assert.equal(report.valid, false);
  assert.ok(report.issues.some((i) => i.rule === "PLAN_RELEASE"));
});

test("blank active object cannot evade a manipulation resource check", () => {
  const p = makeProposal();
  p.steps[2].activeObjectId = " ";
  assert.ok(
    validatePlan(p, makeConstraints()).issues.some(
      (i) => i.rule === "PLAN_ACTIVE_OBJECT",
    ),
  );
});

test("invalid measurements are rejected without crashing", () => {
  assert.equal(
    validatePlan(makeProposal(), makeConstraints({ itemLengthMm: Number.NaN }))
      .valid,
    false,
  );
  assert.equal(
    validatePlan(
      makeProposal(),
      makeConstraints({ measurementsConfirmed: false } as never),
    ).valid,
    false,
  );
});

const completeTrial = (): TrialInput => ({
  designId: "design-1",
  buildConfirmed: true,
  scaleConfirmed: true,
  materialMatches: true,
  contentsCorrect: true,
  closureComplete: true,
  parcelReleased: true,
  stationReset: true,
  freshPackageStarted: true,
  evidenceComplete: true,
  helperInterventions: 0,
  durationSeconds: 40,
  notes: "Synthetic software fixture only.",
  assetIds: ["backend-validated-trial-video"],
});

test("trial needs build, scale, material and evidence readiness", () => {
  assert.equal(deriveTrialOutcome(completeTrial()), "observed_complete");
  for (const key of [
    "buildConfirmed",
    "scaleConfirmed",
    "materialMatches",
    "evidenceComplete",
  ] as const) {
    assert.equal(
      deriveTrialOutcome({ ...completeTrial(), [key]: false }),
      "incomplete",
      key,
    );
  }
  assert.equal(
    deriveTrialOutcome({ ...completeTrial(), assetIds: [] }),
    "incomplete",
  );
});

test("a complete recording does not turn failed physical criteria into success", () => {
  assert.equal(
    deriveTrialOutcome({ ...completeTrial(), helperInterventions: 1 }),
    "failed",
  );
  assert.equal(
    deriveTrialOutcome({ ...completeTrial(), stationReset: false }),
    "failed",
  );
  assert.equal(
    deriveTrialOutcome({ ...completeTrial(), freshPackageStarted: false }),
    "failed",
  );
  assert.equal(
    deriveTrialOutcome({ ...completeTrial(), closureComplete: false }),
    "failed",
  );
});
