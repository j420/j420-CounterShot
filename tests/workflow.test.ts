/**
 * Mock-provider integration test: real SQLite, job runner, Meta SDK, schemas and
 * geometry compiler. Provider responses and trial flags are synthetic fixtures.
 * This test is neither a live Meta verification nor physical operating evidence.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  Asset,
  InputSnapshot,
  Observation,
  Proposal,
  Trial,
  TrialInput,
} from "../src/lib/contracts";
import { deriveTrialOutcome } from "../src/lib/domain";
import { renderPrintPack } from "../src/lib/geometry";
import { runJob } from "../src/lib/server/jobs";
import { designFingerprint } from "../src/lib/server/revisions";
import { Store, hash, now } from "../src/lib/server/store";
import { validateTrialEvidence } from "../src/lib/server/trials";
import { makeConstraints, makeProposal } from "./fixtures";

function streamedResponse(id: string, value: Observation | Proposal): Response {
  const response = {
    id,
    object: "response",
    created_at: 1,
    status: "completed",
    model: "muse-spark-1.3",
    output: [
      {
        id: `msg_${id}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          { type: "output_text", text: JSON.stringify(value), annotations: [] },
        ],
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
  const events = [
    {
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    },
    { type: "response.completed", response },
  ];
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
      "data: [DONE]\n\n",
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

test("mock-provider full pipeline preserves observation, snapshot, checked drawings and failed-trial revision bindings", async () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "countershot-workflow-test-"),
  );
  const store = new Store(root);
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.MODEL_API_KEY;
  const originalModel = process.env.META_MODEL;
  const providerRequests: Record<string, unknown>[] = [];
  const uploadedFiles: { id: string; filename: string; bytes: number }[] = [];
  const observed: Observation = {
    summary: "Synthetic provider observation used only to test orchestration.",
    objects: [
      {
        name: "package",
        role: "output",
        evidence: "Synthetic fixture, no physical inference.",
      },
    ],
    actions: [
      {
        id: "observed_load",
        label: "Load contents",
        holdingRequirement: "Package needs locating.",
        activeManipulation: "Contents insertion",
        evidence: "Synthetic provider fixture.",
      },
    ],
    conflicts: [
      {
        actionId: "observed_load",
        description: "Fixture holding conflict for contract testing.",
      },
    ],
    questions: [],
    cycleCoverage: {
      preparation: true,
      loading: true,
      closure: true,
      release: true,
      reset: true,
    },
  };
  const initial = makeProposal();
  const invalid = structuredClone(initial);
  invalid.steps.pop();
  const revised = makeProposal({
    title: "Synthetic revised side-guide method",
    arrangement: "side_guides",
    clearanceMm: initial.clearanceMm + 2,
  });
  revised.steps[1].instruction =
    "Locate the fresh blank between the two exterior guides, then load.";
  revised.changes = [
    {
      layer: "workspace",
      change: "Use two exterior side guides.",
      reason: "Synthetic failed-trial feedback.",
    },
    {
      layer: "package",
      change: "Increase the shared clearance.",
      reason: "Generate an actual dimensional change for the integration test.",
    },
  ];
  const responses = [
    { id: "resp_fixture_observe", value: observed },
    { id: "resp_fixture_invalid", value: invalid },
    { id: "resp_fixture_initial", value: initial },
    { id: "resp_fixture_revision", value: revised },
  ];
  let responseIndex = 0;
  try {
    // Fixture-only credentials and fetch transport. No request can leave this handler.
    process.env.MODEL_API_KEY = "workflow-fixture-credential-not-a-real-key";
    process.env.META_MODEL = "muse-spark-1.3";
    globalThis.fetch = async (input, init) => {
      const url =
        typeof input === "string" || input instanceof URL
          ? String(input)
          : input.url;
      assert.ok(
        url.startsWith("https://api.meta.ai/v1/"),
        "Unexpected transport destination in isolated fixture test.",
      );
      if (url === "https://api.meta.ai/v1/files") {
        const request = new Request(url, {
          ...init,
          duplex: "half",
        } as RequestInit);
        const form = await request.formData();
        assert.equal(form.get("purpose"), "user_data");
        const file = form.get("file");
        assert.ok(file instanceof File);
        const bytes = (await file.arrayBuffer()).byteLength;
        assert.ok(bytes > 0);
        const id = `file-workflow-fixture-${uploadedFiles.length + 1}`;
        uploadedFiles.push({ id, filename: file.name, bytes });
        return Response.json({
          id,
          object: "file",
          purpose: "user_data",
          bytes,
          filename: file.name,
          status: "uploaded",
          created_at: 1,
        });
      }
      assert.equal(url, "https://api.meta.ai/v1/responses");
      assert.equal(init?.method, "POST");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(body.response_format, undefined);
      assert.equal(body.model, "muse-spark-1.3");
      assert.equal(
        (body.text as { format: { strict: boolean } }).format.strict,
        true,
      );
      providerRequests.push(body);
      const result = responses[responseIndex++];
      assert.ok(result, "Unexpected extra model generation.");
      return streamedResponse(result.id, result.value);
    };
    let project = store.createProject(
      "Mock-provider integration",
      "Synthetic packing workflow; no actual physical efficacy claimed.",
    );
    const addTransportAsset = (
      role: Asset["role"],
      kind: Asset["kind"],
      bytes: Buffer,
      extension: string,
    ) => {
      const id = randomUUID(),
        filename = `${id}${extension}`;
      writeFileSync(path.join(store.assetRoot, filename), bytes);
      const asset: Asset = {
        id,
        filename,
        mime: kind === "video" ? "video/mp4" : "image/png",
        byteLength: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        createdAt: now(),
        kind,
        role,
      };
      project = store.addAsset(project.id, project.version, asset, filename);
      return asset;
    };
    const source = addTransportAsset(
      "job",
      "image",
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=",
        "base64",
      ),
      ".png",
    );
    const observationJob = store.startJob(project.id, "observe", randomUUID(), {
      expectedVersion: project.version,
      assetId: source.id,
    });
    await runJob(observationJob.id, store);
    assert.equal(store.getJob(observationJob.id).status, "succeeded");
    assert.equal(
      store.getJob(observationJob.id).resultId,
      "resp_fixture_observe",
    );
    project = store.getProject(project.id);
    assert.deepEqual(project.observation, observed);
    assert.equal(project.observationAssetId, source.id);

    const constraints = makeConstraints();
    const snapshot: InputSnapshot = {
      id: randomUUID(),
      constraints,
      observation: project.observation,
      hash: hash({ constraints, observation: project.observation }),
      createdAt: now(),
    };
    project = store.mutateProject(project.id, project.version, (p) => {
      p.snapshots.push(snapshot);
      p.currentSnapshotId = snapshot.id;
    });
    const designJob = store.startJob(project.id, "design", randomUUID(), {
      expectedVersion: project.version,
      snapshotId: snapshot.id,
    });
    await runJob(designJob.id, store);
    assert.equal(store.getJob(designJob.id).status, "succeeded");
    project = store.getProject(project.id);
    assert.equal(project.designs.length, 1);
    const first = project.designs[0];
    assert.equal(first.inputSnapshotId, snapshot.id);
    assert.equal(first.inputHash, snapshot.hash);
    assert.equal(first.responseId, "resp_fixture_initial");
    assert.equal(first.sourceTrialId, null);
    assert.equal(first.parentId, null);
    assert.ok(first.compiled.report.valid);
    assert.ok(first.compiled.drawings.some((d) => d.svg.includes("<svg")));
    assert.ok(
      first.compiled.report.issues.some((i) => i.severity === "trial_required"),
    );
    assert.match(
      JSON.stringify(providerRequests[2]),
      /Previous proposal to correct/,
    );
    assert.match(renderPrintPack(first, snapshot), new RegExp(snapshot.hash));

    // Opaque transport bytes bypass upload validation intentionally: codec checks have separate tests.
    // The mocked provider accepts them; this record is not an actual playable video or physical trial.
    const evidence = addTransportAsset(
      "trial",
      "video",
      Buffer.from("SYNTHETIC PROVIDER TRANSPORT BYTES - NOT PHYSICAL EVIDENCE"),
      ".mp4",
    );
    const trialInput: TrialInput = {
      designId: first.id,
      buildConfirmed: true,
      scaleConfirmed: true,
      materialMatches: true,
      contentsCorrect: true,
      closureComplete: false,
      parcelReleased: false,
      stationReset: false,
      freshPackageStarted: true,
      evidenceComplete: true,
      helperInterventions: 1,
      durationSeconds: 20,
      notes:
        "Synthetic failed-cycle report: package shifted and closure could not finish.",
      assetIds: [evidence.id],
    };
    validateTrialEvidence(project, trialInput);
    const trial: Trial = {
      ...trialInput,
      id: randomUUID(),
      createdAt: now(),
      outcome: deriveTrialOutcome(trialInput),
    };
    assert.equal(trial.outcome, "failed");
    project = store.mutateProject(project.id, project.version, (p) => {
      p.trials.push(trial);
    });
    const revisionJob = store.startJob(project.id, "revise", randomUUID(), {
      expectedVersion: project.version,
      snapshotId: snapshot.id,
      parentDesignId: first.id,
      sourceTrialId: trial.id,
    });
    await runJob(revisionJob.id, store);
    assert.equal(store.getJob(revisionJob.id).status, "succeeded");
    project = store.getProject(project.id);
    assert.equal(project.designs.length, 2);
    const second = project.designs[1];
    assert.equal(second.parentId, first.id);
    assert.equal(second.sourceTrialId, trial.id);
    assert.equal(second.inputSnapshotId, snapshot.id);
    assert.equal(second.inputHash, snapshot.hash);
    assert.equal(second.responseId, "resp_fixture_revision");
    assert.equal(second.number, 2);
    assert.equal(project.currentDesignId, second.id);
    assert.equal(project.trials[0].designId, first.id);
    assert.deepEqual(
      project.designs[0],
      first,
      "The original revision must remain unchanged.",
    );
    assert.notDeepEqual(
      second.compiled.sharedDimensions,
      first.compiled.sharedDimensions,
    );
    assert.notEqual(
      designFingerprint(second.proposal, second.compiled),
      designFingerprint(first.proposal, first.compiled),
    );
    assert.ok(second.compiled.drawings.some((d) => d.svg.includes("<svg")));
    assert.equal(
      uploadedFiles.length,
      2,
      "Original media should reuse its cached provider file ID.",
    );
    assert.equal(
      store.assetFile(project.id, evidence.id).providerFileId,
      uploadedFiles[1].id,
    );
    const revisionRequest = JSON.stringify(providerRequests[3]);
    assert.match(revisionRequest, new RegExp(uploadedFiles[1].id));
    assert.match(revisionRequest, new RegExp(trial.id));
    assert.match(revisionRequest, new RegExp(first.id));
    assert.match(revisionRequest, /humanReportedTrial/);
    assert.equal(responseIndex, responses.length);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.MODEL_API_KEY;
    else process.env.MODEL_API_KEY = originalKey;
    if (originalModel === undefined) delete process.env.META_MODEL;
    else process.env.META_MODEL = originalModel;
    store.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    rmSync(root, { recursive: true, force: true });
  }
});
