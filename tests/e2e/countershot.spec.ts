import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { Project } from "../../src/lib/contracts";
import { compileDesign } from "../../src/lib/geometry";
import { makeConstraints, makeProposal } from "../fixtures";

async function createProject(page: Page): Promise<Project> {
  await page.goto("/");
  const health = await (await page.request.get("/api/health")).json();
  // Stop before any model action if the isolated test server is misconfigured.
  expect(health.configured).toBe(false);
  expect(health.authenticated).toBe(true);
  await page
    .getByLabel("Give the job a name")
    .fill(`Browser test ${randomUUID().slice(0, 8)}`);
  await page
    .getByLabel("What needs to be completed?")
    .fill(
      "Pack a notebook and card, close the parcel and reset using my right hand.",
    );
  const response = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/api/projects"),
  );
  await page.getByRole("button", { name: "Create my workflow" }).click();
  const saved = await response;
  expect(saved.status()).toBe(201);
  const { project } = await saved.json();
  await expect(
    page.getByRole("heading", { name: "Show us the whole job" }),
  ).toBeVisible();
  return project;
}

async function uploadJob(
  page: Page,
  project: Project,
  file: { name: string; mimeType: string; buffer: Buffer },
) {
  const result = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.url().endsWith(`/api/projects/${project.id}/assets`),
  );
  await page.getByLabel("Upload a job video or photograph").setInputFiles(file);
  return result;
}

test("real local flow creates a project, validates JPEG upload and reports missing Meta setup", async ({
  page,
}, testInfo) => {
  const project = await createProject(page);
  const invalid = await uploadJob(page, project, {
    name: "not-a-video.mp4",
    mimeType: "video/mp4",
    buffer: Buffer.from("This is not an MP4."),
  });
  expect(invalid.status()).toBe(422);
  await expect(
    page.getByRole("alert").filter({ hasText: /valid JPEG, PNG or MP4/i }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Dismiss error" }).click();

  // Browser-encoded image of this synthetic test workspace: genuine JPEG bytes.
  const jpeg = await page.screenshot({ type: "jpeg", quality: 70 });
  const uploaded = await uploadJob(page, project, {
    name: "synthetic-test-workspace.jpg",
    mimeType: "image/jpeg",
    buffer: jpeg,
  });
  expect(uploaded.status()).toBe(201);
  const { asset } = await uploaded.json();
  await expect(
    page.getByRole("img", { name: "synthetic-test-workspace.jpg" }),
  ).toBeVisible();
  const stored = await page.request.get(
    `/api/projects/${project.id}/assets/${asset.id}`,
  );
  expect(stored.headers()["content-type"]).toBe("image/jpeg");
  expect(await stored.body()).toEqual(jpeg);

  const observe = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.url().endsWith(`/api/projects/${project.id}/observe`),
  );
  await page.getByRole("button", { name: "Observe with Meta" }).click();
  expect((await observe).status()).toBe(202);
  await expect(
    page.getByRole("alert").filter({ hasText: /Add your Meta API key/i }),
  ).toBeVisible();
  const saved = await (
    await page.request.get(`/api/projects/${project.id}`)
  ).json();
  expect(saved.project.observation).toBeNull();
  expect(saved.project.designs).toHaveLength(0);
  expect(saved.jobs[0].status).toBe("failed");
  await page.screenshot({
    path: testInfo.outputPath("keyless-workspace.png"),
    fullPage: true,
  });

  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Show us the whole job" }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: "synthetic-test-workspace.jpg" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Check Meta connection" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: /Add your Meta API key/i }),
  ).toBeVisible();
});

async function browserMp4(page: Page): Promise<Buffer | null> {
  const bytes = await page.evaluate(async () => {
    const mime = ["video/mp4;codecs=avc1.42001E", "video/mp4"].find(
      (candidate) => MediaRecorder.isTypeSupported(candidate),
    );
    if (!mime) return null;
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 120;
    const context = canvas.getContext("2d")!;
    const stream = canvas.captureStream(12);
    const recorder = new MediaRecorder(stream, { mimeType: mime });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    const finished = new Promise<number[]>((resolve, reject) => {
      recorder.onstop = async () =>
        resolve([...new Uint8Array(await new Blob(chunks).arrayBuffer())]);
      recorder.onerror = () =>
        reject(new Error("Installed browser could not encode the test MP4."));
    });
    recorder.start();
    for (let frame = 0; frame < 8; frame++) {
      context.fillStyle = frame % 2 ? "#42649a" : "#d4ba8d";
      context.fillRect(0, 0, 160, 120);
      context.fillStyle = "#000000";
      context.fillText("Synthetic media test", 10, 60);
      await new Promise((resolve) => setTimeout(resolve, 85));
    }
    recorder.stop();
    const result = await finished;
    stream.getTracks().forEach((track) => track.stop());
    return result;
  });
  return bytes ? Buffer.from(bytes) : null;
}

function longerDuration(validMp4: Buffer): Buffer {
  const changed = Buffer.from(validMp4);
  const marker = changed.indexOf(Buffer.from("mvhd"));
  if (marker < 0)
    throw new Error(
      "The browser's MP4 did not include movie duration metadata.",
    );
  const data = marker + 4;
  const version = changed[data];
  const scaleOffset = data + (version === 1 ? 20 : 12);
  const scale = changed.readUInt32BE(scaleOffset);
  if (version === 1)
    changed.writeBigUInt64BE(BigInt(scale) * 61n, scaleOffset + 4);
  else changed.writeUInt32BE(scale * 61, scaleOffset + 4);
  return changed;
}

test("real local upload accepts a browser-encoded MP4 and rejects duration/type mismatches", async ({
  page,
}) => {
  const project = await createProject(page);
  const mp4 = await browserMp4(page);
  test.skip(
    !mp4,
    "This installed Chromium cannot encode MP4; no real MP4-upload result is claimed.",
  );
  const accepted = await uploadJob(page, project, {
    name: "synthetic-cycle.mp4",
    mimeType: "video/mp4",
    buffer: mp4!,
  });
  expect(accepted.status()).toBe(201);
  await expect(
    page.getByText("synthetic-cycle.mp4", { exact: true }),
  ).toBeVisible();
  const overlong = await uploadJob(page, project, {
    name: "overlong-metadata.mp4",
    mimeType: "video/mp4",
    buffer: longerDuration(mp4!),
  });
  expect(overlong.status()).toBe(422);
  await expect(
    page.getByRole("alert").filter({ hasText: /60 seconds or less/i }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Dismiss error" }).click();
  const jpeg = await page.screenshot({ type: "jpeg" });
  const mismatch = await uploadJob(page, project, {
    name: "wrong-type.mp4",
    mimeType: "video/mp4",
    buffer: jpeg,
  });
  expect(mismatch.status()).toBe(422);
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: /does not match its declared media type/i }),
  ).toBeVisible();
});

function mockedProject(): Project {
  const constraints = makeConstraints();
  const proposal = makeProposal({
    title: "EXPLICIT MOCK: generated-view fixture",
  });
  const snapshotId = randomUUID();
  const designId = randomUUID();
  return {
    id: randomUUID(),
    version: 1,
    title: "EXPLICIT MOCK: no model or physical trial",
    goal: "Synthetic browser presentation test.",
    createdAt: "2026-11-02T00:00:00.000Z",
    updatedAt: "2026-11-02T00:00:00.000Z",
    assets: [],
    observation: null,
    observationAssetId: null,
    snapshots: [
      {
        id: snapshotId,
        hash: "synthetic-input-hash",
        constraints,
        observation: null,
        createdAt: "2026-11-02T00:00:00.000Z",
      },
    ],
    currentSnapshotId: snapshotId,
    designs: [
      {
        id: designId,
        number: 1,
        parentId: null,
        inputSnapshotId: snapshotId,
        inputHash: "synthetic-input-hash",
        createdAt: "2026-11-02T00:00:00.000Z",
        proposal,
        compiled: compileDesign(proposal, constraints),
        sourceTrialId: null,
        model: "EXPLICIT_MOCK",
        responseId: null,
      },
    ],
    currentDesignId: designId,
    trials: [],
  };
}

async function installMockedProject(page: Page, project: Project) {
  await page.route("**/api/health", (route) =>
    route.fulfill({
      json: {
        configured: false,
        model: "EXPLICIT_MOCK",
        authenticated: true,
        accessRequired: false,
      },
    }),
  );
  await page.route("**/api/projects", (route) =>
    route.fulfill({
      json: {
        projects: [
          {
            id: project.id,
            title: project.title,
            goal: project.goal,
            updatedAt: project.updatedAt,
            designCount: project.designs.length,
            trialCount: 0,
          },
        ],
      },
    }),
  );
  await page.route(`**/api/projects/${project.id}`, (route) =>
    route.fulfill({ json: { project, jobs: [] } }),
  );
  await page.addInitScript(
    (id) => localStorage.setItem("countershot-project", id),
    project.id,
  );
  await page.goto("/");
}

test("EXPLICIT MOCK: design/trial UI preserves physical-trial requirement and rejects missing video", async ({
  page,
}, testInfo) => {
  const project = mockedProject();
  await installMockedProject(page, project);
  await expect(
    page.getByText("Geometry checks passed", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Physical trial required", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "EXPLICIT MOCK: generated-view fixture",
    }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("explicit-mock-design.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Make this revision" }).click();
  await expect(
    page.getByRole("heading", { name: "Everything should fit the same plan" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Record a physical trial" }).click();
  await expect(
    page.getByRole("heading", { name: "0 of 0 cycles observed complete" }),
  ).toBeVisible();
  await page.getByLabel("The video covers the complete cycle").check();
  let submitted = false;
  await page.route(`**/api/projects/${project.id}/trials`, (route) => {
    submitted = true;
    return route.fulfill({
      status: 500,
      json: {
        error: {
          code: "UNEXPECTED_TEST_REQUEST",
          message: "Should be stopped by client evidence gate.",
        },
      },
    });
  });
  await page.getByRole("button", { name: "Save this trial" }).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: /Select a full-cycle trial video/i }),
  ).toBeVisible();
  expect(submitted).toBe(false);
});

test("EXPLICIT MOCK: stale design is visibly historical and cannot enter the current build flow", async ({
  page,
}) => {
  const project = mockedProject();
  project.currentSnapshotId = randomUUID();
  project.snapshots.push({
    ...project.snapshots[0],
    id: project.currentSnapshotId,
    hash: "changed-synthetic-input",
  });
  await installMockedProject(page, project);
  await expect(
    page.getByText(/These drawings use an earlier input snapshot/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Make this revision" }),
  ).toBeDisabled();
});

test("EXPLICIT MOCK: selected trial photographs and videos can be inspected before judgment", async ({
  page,
}, testInfo) => {
  const project = mockedProject();
  const photographId = randomUUID();
  const videoId = randomUUID();
  project.assets.push(
    {
      id: photographId,
      filename: "EXPLICIT-MOCK-failure.jpg",
      mime: "image/jpeg",
      byteLength: 1,
      sha256: "mock-photo",
      createdAt: project.createdAt,
      kind: "image",
      role: "trial",
    },
    {
      id: videoId,
      filename: "EXPLICIT-MOCK-cycle.mp4",
      mime: "video/mp4",
      byteLength: 1,
      sha256: "mock-video",
      createdAt: project.createdAt,
      kind: "video",
      role: "trial",
    },
  );
  await installMockedProject(page, project);
  await page.getByRole("button", { name: "Make this revision" }).click();
  await page.getByRole("button", { name: "Record a physical trial" }).click();
  const jpeg = await page.screenshot({ type: "jpeg" });
  const mp4 = await browserMp4(page);
  expect(
    mp4,
    "Installed Chromium must encode this synthetic MP4 for preview coverage.",
  ).not.toBeNull();
  await page.route(
    `**/api/projects/${project.id}/assets/${photographId}`,
    (route) => route.fulfill({ contentType: "image/jpeg", body: jpeg }),
  );
  await page.route(`**/api/projects/${project.id}/assets/${videoId}`, (route) =>
    route.fulfill({ contentType: "video/mp4", body: mp4! }),
  );
  await page
    .getByRole("checkbox", { name: /EXPLICIT-MOCK-failure.jpg/ })
    .check();
  await expect(
    page.getByRole("img", { name: "EXPLICIT-MOCK-failure.jpg" }),
  ).toBeVisible();
  await page.getByRole("checkbox", { name: /EXPLICIT-MOCK-cycle.mp4/ }).check();
  const preview = page.locator(".trial-media-preview video");
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute(
    "src",
    `/api/projects/${project.id}/assets/${videoId}`,
  );
  await expect
    .poll(() =>
      preview.evaluate((element) => (element as HTMLVideoElement).readyState),
    )
    .toBeGreaterThanOrEqual(1);
  await expect(
    page.getByRole("heading", { name: "0 of 0 cycles observed complete" }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("explicit-mock-trial-preview.png"),
    fullPage: true,
  });
});

test("EXPLICIT MOCK: mobile navigation closes from its button and backdrop without page overflow", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installMockedProject(page, mockedProject());
  await expect(
    page.getByRole("heading", { name: "A coordinated way forward" }),
  ).toBeVisible();
  const sidebar = page.locator(".sidebar");
  await expect(sidebar).not.toHaveClass(/is-open/);
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await expect(sidebar).toHaveClass(/is-open/);
  await expect(
    page.getByRole("button", { name: "Close navigation", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("explicit-mock-mobile-navigation.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Close navigation", exact: true })
    .click();
  await expect(sidebar).not.toHaveClass(/is-open/);
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await page
    .getByRole("button", { name: "Close navigation overlay", exact: true })
    .click({ position: { x: 370, y: 350 } });
  await expect(sidebar).not.toHaveClass(/is-open/);
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.width + 1);
  await page.screenshot({
    path: testInfo.outputPath("explicit-mock-mobile-design.png"),
    fullPage: true,
  });
});
