import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Asset, TrialInput } from "../src/lib/contracts";
import { Store, hash, requireId } from "../src/lib/server/store";
import {
  checkOrigin,
  authenticated,
  isConfiguredKey,
  login,
} from "../src/lib/server/auth";
import { safeFilename, validateMedia } from "../src/lib/server/media";
import { designFingerprint } from "../src/lib/server/revisions";
import { compileDesign } from "../src/lib/geometry";
import { makeConstraints, makeProposal } from "./fixtures";
import { validateTrialEvidence } from "../src/lib/server/trials";

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "countershot-test-"));
  const store = new Store(root);
  const project = store.createProject(
    "Synthetic fixture",
    "Test immutable workflow state.",
  );
  const asset: Asset = {
    id: randomUUID(),
    filename: "fixture.png",
    mime: "image/png",
    byteLength: 30,
    sha256: "fixture-hash",
    createdAt: new Date().toISOString(),
    kind: "image",
    role: "job",
  };
  const saved = store.addAsset(
    project.id,
    project.version,
    asset,
    `${asset.id}.png`,
  );
  return {
    store,
    project: saved,
    asset,
    cleanup: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test("duplicate logical operations deduplicate while changed payload is rejected", () => {
  const x = setup();
  try {
    const operationId = randomUUID();
    const request = { expectedVersion: x.project.version, assetId: x.asset.id };
    const a = x.store.startJob(x.project.id, "observe", operationId, request);
    const b = x.store.startJob(x.project.id, "observe", operationId, request);
    assert.equal(a.id, b.id);
    assert.equal(x.store.listJobs(x.project.id).length, 1);
    assert.throws(
      () =>
        x.store.startJob(x.project.id, "observe", operationId, {
          ...request,
          assetId: randomUUID(),
        }),
      /different request/,
    );
  } finally {
    x.cleanup();
  }
});
test("optimistic versions and a stale job prevent overwriting edited project state", () => {
  const x = setup();
  try {
    const job = x.store.startJob(x.project.id, "observe", randomUUID(), {
      expectedVersion: x.project.version,
      assetId: x.asset.id,
    });
    assert.equal(x.store.claimJob(job.id)?.status, "running");
    assert.equal(x.store.claimJob(job.id), null);
    x.store.mutateProject(x.project.id, x.project.version, (p) => {
      p.goal = "New confirmed objective";
    });
    assert.throws(
      () => x.store.mutateProject(x.project.id, x.project.version, () => {}),
      /changed/,
    );
    const finished = x.store.finishJob(job.id, "stale_result", (p) => {
      p.goal = "Stale model output";
    });
    assert.equal(finished.status, "superseded");
    assert.equal(
      x.store.getProject(x.project.id).goal,
      "New confirmed objective",
    );
  } finally {
    x.cleanup();
  }
});
test("an intentional new operation after failure preserves the failed job", () => {
  const x = setup();
  try {
    const first = x.store.startJob(x.project.id, "observe", randomUUID(), {
      expectedVersion: x.project.version,
      assetId: x.asset.id,
    });
    x.store.claimJob(first.id);
    x.store.failJob(first.id, "Synthetic failure");
    const second = x.store.startJob(x.project.id, "observe", randomUUID(), {
      expectedVersion: x.project.version,
      assetId: x.asset.id,
    });
    assert.notEqual(first.id, second.id);
    assert.equal(x.store.getJob(first.id).status, "failed");
  } finally {
    x.cleanup();
  }
});
test("project ownership and identifier checks reject media traversal and cross-project access", () => {
  const x = setup();
  try {
    assert.throws(() => requireId("../../secret"), /invalid/);
    assert.throws(
      () => x.store.assetFile(x.project.id, "..%2fsecret"),
      /invalid/,
    );
    const other = x.store.createProject("Other", "Other project");
    assert.throws(() => x.store.assetFile(other.id, x.asset.id), /belong/);
    assert.equal(
      safeFilename("../../private\\danger<script>.png"),
      "danger_script_.png",
    );
  } finally {
    x.cleanup();
  }
});
test("snapshot hashing is canonical while preserving action order", () => {
  assert.equal(hash({ a: 1, b: 2 }), hash({ b: 2, a: 1 }));
  assert.notEqual(
    hash({ steps: ["load", "close"] }),
    hash({ steps: ["close", "load"] }),
  );
});
test("setup placeholders never report a configured Meta connection", () => {
  for (const placeholder of [
    undefined,
    "",
    "   ",
    "REPLACE_WITH_YOUR_KEY",
    "your-api-key-here",
    "paste_your_meta_key",
    "placeholder",
    "changeme",
  ])
    assert.equal(isConfiguredKey(placeholder), false);
  assert.equal(
    isConfiguredKey("synthetic-key-for-local-validation-only"),
    true,
  );
});
test("cross-site mutating requests are rejected", () => {
  assert.throws(
    () =>
      checkOrigin(
        new Request("http://localhost:3000/api/projects", {
          method: "POST",
          headers: { origin: "https://attacker.invalid" },
        }),
      ),
    /another website/,
  );
  assert.doesNotThrow(() =>
    checkOrigin(
      new Request("http://localhost:3000/api/projects", {
        method: "POST",
        headers: { origin: "http://localhost:3000" },
      }),
    ),
  );
  assert.doesNotThrow(() =>
    checkOrigin(
      new Request("http://localhost:3011/api/projects", {
        method: "POST",
        headers: { origin: "http://127.0.0.1:3011", host: "127.0.0.1:3011" },
      }),
    ),
  );
  assert.throws(
    () =>
      checkOrigin(
        new Request("http://localhost:3011/api/projects", {
          method: "POST",
          headers: {
            origin: "https://attacker.invalid",
            host: "127.0.0.1:3011",
          },
        }),
      ),
    /another website/,
  );
});
test("session cookies use a signed secret and reject a tampered cookie", () => {
  const oldCode = process.env.COUNTERSHOT_ACCESS_CODE,
    oldSecret = process.env.SESSION_SECRET;
  try {
    process.env.COUNTERSHOT_ACCESS_CODE = "fixture-access-code";
    process.env.SESSION_SECRET =
      "fixture-session-secret-at-least-32-characters";
    const cookie = login("fixture-access-code").split(";")[0];
    assert.equal(
      authenticated(
        new Request("http://localhost:3000", { headers: { cookie } }),
      ),
      true,
    );
    assert.equal(
      authenticated(
        new Request("http://localhost:3000", {
          headers: { cookie: `${cookie}tampered` },
        }),
      ),
      false,
    );
    assert.throws(() => login("wrong-code"), /not accepted/);
  } finally {
    if (oldCode === undefined) delete process.env.COUNTERSHOT_ACCESS_CODE;
    else process.env.COUNTERSHOT_ACCESS_CODE = oldCode;
    if (oldSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = oldSecret;
  }
});
test("unsupported bytes and mismatched file declarations are rejected", () => {
  assert.throws(
    () => validateMedia(Buffer.from("not a video"), "video/mp4"),
    /valid JPEG/,
  );
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=",
    "base64",
  );
  assert.throws(() => validateMedia(png, "video/mp4"), /does not match/);
  assert.equal(validateMedia(png, "image/png").kind, "image");
});

test("revision identity ignores prose, renamed IDs and redundant dependencies but captures hardware changes", () => {
  const constraints = makeConstraints(),
    original = makeProposal();
  const renamed = structuredClone(original);
  renamed.title = "New marketing wording";
  renamed.summary = "Different prose";
  for (const step of renamed.steps) {
    step.id = `renamed_${step.id}`;
    step.dependsOn = step.dependsOn.map((id) => `renamed_${id}`);
    step.label = "New label";
    step.instruction = "New wording";
    step.activeObjectId = `renamed_${step.activeObjectId}`;
    for (const support of [...step.supportsDuring, ...step.supportChangesAfter])
      support.objectId = `renamed_${support.objectId}`;
    step.releaseObjectsAfter = step.releaseObjectsAfter.map(
      (id) => `renamed_${id}`,
    );
  }
  renamed.steps.at(-1)!.dependsOn.push(renamed.steps[0].id);
  assert.equal(
    designFingerprint(original, compileDesign(original, constraints)),
    designFingerprint(renamed, compileDesign(renamed, constraints)),
  );
  const changed = makeProposal({ clearanceMm: original.clearanceMm + 1 });
  assert.notEqual(
    designFingerprint(original, compileDesign(original, constraints)),
    designFingerprint(changed, compileDesign(changed, constraints)),
  );
});

test("full-cycle evidence resolves project-owned videos and rejects reuploaded identical bytes", () => {
  const x = setup();
  try {
    const designId = randomUUID(),
      firstVideoId = randomUUID(),
      duplicateVideoId = randomUUID();
    const proposal = makeProposal(),
      constraints = makeConstraints();
    const project = x.store.mutateProject(
      x.project.id,
      x.project.version,
      (p) => {
        p.designs.push({
          id: designId,
          number: 1,
          parentId: null,
          inputSnapshotId: randomUUID(),
          inputHash: "fixture",
          createdAt: new Date().toISOString(),
          proposal,
          compiled: compileDesign(proposal, constraints),
          sourceTrialId: null,
          model: "fixture-only",
          responseId: null,
        });
        for (const id of [firstVideoId, duplicateVideoId])
          p.assets.push({
            id,
            filename: "synthetic-video-fixture.mp4",
            mime: "video/mp4",
            byteLength: 20,
            sha256: "identical-test-bytes",
            createdAt: new Date().toISOString(),
            kind: "video",
            role: "trial",
          });
      },
    );
    const trial: TrialInput = {
      designId,
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
      durationSeconds: 10,
      notes: "Synthetic contract test, not physical evidence.",
      assetIds: [firstVideoId],
    };
    assert.doesNotThrow(() => validateTrialEvidence(project, trial));
    assert.throws(
      () =>
        validateTrialEvidence(project, { ...trial, assetIds: [randomUUID()] }),
      /from this project/,
    );
    assert.throws(
      () =>
        validateTrialEvidence(project, { ...trial, assetIds: [x.asset.id] }),
      /trial media/,
    );
    project.trials.push({
      ...trial,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      outcome: "observed_complete",
    });
    assert.throws(
      () =>
        validateTrialEvidence(project, {
          ...trial,
          assetIds: [duplicateVideoId],
        }),
      /already belongs/,
    );
  } finally {
    x.cleanup();
  }
});
