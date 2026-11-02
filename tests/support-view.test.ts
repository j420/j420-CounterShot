import test from "node:test";
import assert from "node:assert/strict";
import { effectiveSupportsAtStep } from "../src/lib/support-view";
import { makeProposal } from "./fixtures";

test("support view preserves inherited holding duties when a step omits repeating them", () => {
  const p = makeProposal();
  p.steps[0].supportChangesAfter = [
    { objectId: "parcel", provider: "right_hand", role: "retain" },
  ];
  p.steps[1].supportsDuring = [];
  assert.ok(
    effectiveSupportsAtStep(p.steps, 1).some(
      (s) => s.provider === "right_hand",
    ),
  );
});

test("support view replaces a held duty after an explicit transfer", () => {
  const p = makeProposal();
  p.steps[0].supportChangesAfter = [
    { objectId: "parcel", provider: "station", role: "weight" },
  ];
  p.steps[1].supportsDuring = [];
  const parcelSupports = effectiveSupportsAtStep(p.steps, 1).filter(
    (s) => s.objectId === "parcel",
  );
  assert.deepEqual(parcelSupports, [
    { objectId: "parcel", provider: "station", role: "weight" },
  ]);
});

test("support view removes released objects before a later reset", () => {
  const p = makeProposal();
  const last = p.steps.length - 1;
  p.steps[last - 1].releaseObjectsAfter = ["parcel"];
  p.steps[last].supportsDuring = [];
  assert.ok(
    !effectiveSupportsAtStep(p.steps, last).some(
      (s) => s.objectId === "parcel",
    ),
  );
});
