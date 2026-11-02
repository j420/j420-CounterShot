import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Asset, Job, Project, ProjectSummary } from "../contracts";
import { AppError } from "./errors";

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export const hash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export const now = () => new Date().toISOString();
export function validId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    id,
  );
}
export function requireId(id: string): string {
  if (!validId(id))
    throw new AppError(
      "INVALID_ID",
      "That resource identifier is invalid.",
      400,
    );
  return id;
}
export interface JobRequest {
  expectedVersion: number;
  assetId?: string;
  snapshotId?: string;
  parentDesignId?: string;
  sourceTrialId?: string;
}
interface JobRow {
  payload: string;
  request: string;
  request_hash: string;
  lease_until: number;
  provider_response_id: string | null;
}

export class Store {
  readonly db: DatabaseSync;
  readonly assetRoot: string;
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true });
    this.assetRoot = path.join(root, "assets");
    mkdirSync(this.assetRoot, { recursive: true });
    this.db = new DatabaseSync(path.join(root, "countershot.sqlite"));
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, version INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), storage_key TEXT NOT NULL, provider_file_id TEXT);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), operation_id TEXT NOT NULL, request_hash TEXT NOT NULL, payload TEXT NOT NULL, request TEXT NOT NULL, lease_until INTEGER NOT NULL DEFAULT 0, provider_response_id TEXT, UNIQUE(project_id,operation_id));
      CREATE INDEX IF NOT EXISTS jobs_project ON jobs(project_id);
      CREATE TABLE IF NOT EXISTS model_calls(id TEXT PRIMARY KEY, job_id TEXT, response_id TEXT, status TEXT NOT NULL, usage TEXT, created_at TEXT NOT NULL);
    `);
  }
  close() {
    this.db.close();
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  createProject(title: string, goal: string): Project {
    const date = now();
    const project: Project = {
      id: randomUUID(),
      version: 1,
      title,
      goal,
      createdAt: date,
      updatedAt: date,
      assets: [],
      observation: null,
      observationAssetId: null,
      snapshots: [],
      currentSnapshotId: null,
      designs: [],
      currentDesignId: null,
      trials: [],
    };
    this.db
      .prepare("INSERT INTO projects VALUES(?,?,?)")
      .run(project.id, project.version, JSON.stringify(project));
    return project;
  }
  getProject(id: string): Project {
    requireId(id);
    const row = this.db
      .prepare("SELECT payload FROM projects WHERE id=?")
      .get(id) as { payload: string } | undefined;
    if (!row)
      throw new AppError("NOT_FOUND", "This project does not exist.", 404);
    return JSON.parse(row.payload);
  }
  listProjects(): ProjectSummary[] {
    const rows = this.db
      .prepare("SELECT payload FROM projects ORDER BY rowid DESC")
      .all() as { payload: string }[];
    return rows.map((row) => {
      const p: Project = JSON.parse(row.payload);
      return {
        id: p.id,
        title: p.title,
        goal: p.goal,
        updatedAt: p.updatedAt,
        designCount: p.designs.length,
        trialCount: p.trials.length,
      };
    });
  }
  mutateProject(
    id: string,
    expectedVersion: number,
    update: (project: Project) => void,
  ): Project {
    return this.transaction(() =>
      this.mutateInside(id, expectedVersion, update),
    );
  }
  private mutateInside(
    id: string,
    expectedVersion: number,
    update: (project: Project) => void,
  ): Project {
    const p = this.getProject(id);
    if (p.version !== expectedVersion)
      throw new AppError(
        "VERSION_CONFLICT",
        "The project changed. Refresh it before continuing.",
        409,
      );
    update(p);
    p.version++;
    p.updatedAt = now();
    const result = this.db
      .prepare(
        "UPDATE projects SET version=?,payload=? WHERE id=? AND version=?",
      )
      .run(p.version, JSON.stringify(p), id, expectedVersion);
    if (result.changes !== 1)
      throw new AppError(
        "VERSION_CONFLICT",
        "The project changed. Refresh it before continuing.",
        409,
      );
    return p;
  }
  addAsset(
    projectId: string,
    expectedVersion: number,
    asset: Asset,
    storageKey: string,
  ): Project {
    return this.transaction(() => {
      const p = this.mutateInside(projectId, expectedVersion, (project) => {
        project.assets.push(asset);
      });
      this.db
        .prepare("INSERT INTO assets VALUES(?,?,?,NULL)")
        .run(asset.id, projectId, storageKey);
      return p;
    });
  }
  assetFile(
    projectId: string,
    assetId: string,
  ): { asset: Asset; filePath: string; providerFileId: string | null } {
    requireId(assetId);
    const p = this.getProject(projectId);
    const asset = p.assets.find((a) => a.id === assetId);
    const row = this.db
      .prepare(
        "SELECT storage_key,provider_file_id FROM assets WHERE id=? AND project_id=?",
      )
      .get(assetId, projectId) as
      { storage_key: string; provider_file_id: string | null } | undefined;
    if (!asset || !row)
      throw new AppError(
        "NOT_FOUND",
        "This media does not belong to the project.",
        404,
      );
    if (path.basename(row.storage_key) !== row.storage_key)
      throw new AppError(
        "INVALID_PATH",
        "The stored media path is invalid.",
        500,
      );
    const filePath = path.resolve(this.assetRoot, row.storage_key);
    if (path.dirname(filePath) !== path.resolve(this.assetRoot))
      throw new AppError(
        "INVALID_PATH",
        "The stored media path is invalid.",
        500,
      );
    return { asset, filePath, providerFileId: row.provider_file_id };
  }
  readAsset(projectId: string, assetId: string) {
    const result = this.assetFile(projectId, assetId);
    return { ...result, bytes: readFileSync(result.filePath) };
  }
  setProviderFile(assetId: string, providerFileId: string) {
    this.db
      .prepare("UPDATE assets SET provider_file_id=? WHERE id=?")
      .run(providerFileId, assetId);
  }
  startJob(
    projectId: string,
    kind: Job["kind"],
    operationId: string,
    request: JobRequest,
  ): Job {
    requireId(operationId);
    const requestHash = hash({ kind, request });
    return this.transaction(() => {
      const old = this.db
        .prepare("SELECT * FROM jobs WHERE project_id=? AND operation_id=?")
        .get(projectId, operationId) as JobRow | undefined;
      if (old) {
        if (old.request_hash !== requestHash)
          throw new AppError(
            "OPERATION_CONFLICT",
            "This operation ID was already used for a different request.",
            409,
          );
        return JSON.parse(old.payload);
      }
      const p = this.getProject(projectId);
      if (p.version !== request.expectedVersion)
        throw new AppError(
          "VERSION_CONFLICT",
          "The project changed. Refresh it before starting.",
          409,
        );
      const active = this.listJobs(projectId).find(
        (j) => j.status === "queued" || j.status === "running",
      );
      if (active)
        throw new AppError(
          "JOB_ACTIVE",
          "A job is already processing this project.",
          409,
        );
      const snapshot = p.snapshots.find((s) => s.id === request.snapshotId);
      if (
        kind !== "observe" &&
        (!snapshot || p.currentSnapshotId !== snapshot.id)
      )
        throw new AppError(
          "CONFIRM_REQUIRED",
          "Confirm current measurements and constraints before designing.",
          422,
        );
      if (
        kind === "observe" &&
        !p.assets.some((a) => a.id === request.assetId && a.role === "job")
      )
        throw new AppError(
          "MEDIA_REQUIRED",
          "Select job media belonging to this project.",
          422,
        );
      if (
        request.parentDesignId &&
        !p.designs.some((d) => d.id === request.parentDesignId)
      )
        throw new AppError(
          "DESIGN_REQUIRED",
          "The parent design does not belong to this project.",
          422,
        );
      if (
        request.sourceTrialId &&
        !p.trials.some(
          (t) =>
            t.id === request.sourceTrialId &&
            t.designId === request.parentDesignId,
        )
      )
        throw new AppError(
          "TRIAL_MISMATCH",
          "Revision feedback must belong to its exact parent design.",
          422,
        );
      if (request.sourceTrialId) {
        const trial = p.trials.find((t) => t.id === request.sourceTrialId)!;
        if (
          !trial.assetIds.length ||
          trial.assetIds.some(
            (id) => !p.assets.some((a) => a.id === id && a.role === "trial"),
          )
        )
          throw new AppError(
            "TRIAL_MEDIA",
            "Attach actual trial media from this project before revising from evidence.",
            422,
          );
      }
      const job: Job = {
        id: randomUUID(),
        projectId,
        kind,
        status: "queued",
        stage: "queued",
        inputHash: hash({
          version: p.version,
          snapshot: snapshot?.hash,
          asset: p.assets.find((a) => a.id === request.assetId)?.sha256,
        }),
        operationId,
        createdAt: now(),
        completedAt: null,
        error: null,
        resultId: null,
      };
      this.db
        .prepare(
          "INSERT INTO jobs(id,project_id,operation_id,request_hash,payload,request) VALUES(?,?,?,?,?,?)",
        )
        .run(
          job.id,
          projectId,
          operationId,
          requestHash,
          JSON.stringify(job),
          JSON.stringify(request),
        );
      return job;
    });
  }
  getJob(id: string): Job {
    requireId(id);
    const row = this.db
      .prepare("SELECT payload FROM jobs WHERE id=?")
      .get(id) as { payload: string } | undefined;
    if (!row) throw new AppError("NOT_FOUND", "This job does not exist.", 404);
    return JSON.parse(row.payload);
  }
  listJobs(projectId: string): Job[] {
    this.getProject(projectId);
    return (
      this.db
        .prepare(
          "SELECT payload FROM jobs WHERE project_id=? ORDER BY rowid DESC",
        )
        .all(projectId) as { payload: string }[]
    ).map((r) => JSON.parse(r.payload));
  }
  jobRequest(id: string): JobRequest {
    return JSON.parse(
      (
        this.db
          .prepare("SELECT request FROM jobs WHERE id=?")
          .get(requireId(id)) as { request: string }
      ).request,
    );
  }
  claimJob(id: string): Job | null {
    return this.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM jobs WHERE id=?")
        .get(requireId(id)) as JobRow | undefined;
      if (!row) return null;
      const job: Job = JSON.parse(row.payload);
      if (
        job.status !== "queued" &&
        !(job.status === "running" && row.lease_until < Date.now())
      )
        return null;
      job.status = "running";
      job.stage = row.provider_response_id
        ? "recovering_response"
        : "reading_inputs";
      this.db
        .prepare("UPDATE jobs SET payload=?,lease_until=? WHERE id=?")
        .run(JSON.stringify(job), Date.now() + 180_000, id);
      return job;
    });
  }
  stageJob(id: string, stage: string) {
    const job = this.getJob(id);
    if (job.status !== "running") return;
    job.stage = stage;
    this.db
      .prepare("UPDATE jobs SET payload=?,lease_until=? WHERE id=?")
      .run(JSON.stringify(job), Date.now() + 180_000, id);
  }
  deferJob(id: string, stage: string) {
    const job = this.getJob(id);
    if (job.status !== "running") return;
    job.stage = stage;
    this.db
      .prepare("UPDATE jobs SET payload=?,lease_until=? WHERE id=?")
      .run(JSON.stringify(job), Date.now() + 3000, id);
  }
  saveResponseId(id: string, responseId: string) {
    this.db
      .prepare("UPDATE jobs SET provider_response_id=? WHERE id=?")
      .run(responseId, id);
  }
  responseId(id: string): string | null {
    return (
      this.db
        .prepare("SELECT provider_response_id FROM jobs WHERE id=?")
        .get(id) as { provider_response_id: string | null }
    ).provider_response_id;
  }
  recordCall(
    jobId: string,
    responseId: string | null,
    status: string,
    usage: unknown,
  ) {
    this.db
      .prepare("INSERT INTO model_calls VALUES(?,?,?,?,?,?)")
      .run(
        randomUUID(),
        jobId,
        responseId,
        status,
        JSON.stringify(usage ?? null),
        now(),
      );
  }
  finishJob(
    id: string,
    resultId: string,
    update: (project: Project) => void,
  ): Job {
    return this.transaction(() => {
      const job = this.getJob(id);
      const request = this.jobRequest(id);
      const p = this.getProject(job.projectId);
      if (job.status !== "running") return job;
      if (p.version !== request.expectedVersion) {
        job.status = "superseded";
        job.stage = "inputs_changed";
        job.error =
          "The project changed while this job ran. Generate again from current inputs.";
      } else {
        this.mutateInside(p.id, p.version, update);
        job.status = "succeeded";
        job.stage = "complete";
        job.resultId = resultId;
      }
      job.completedAt = now();
      this.db
        .prepare("UPDATE jobs SET payload=?,lease_until=0 WHERE id=?")
        .run(JSON.stringify(job), id);
      return job;
    });
  }
  failJob(id: string, message: string): Job {
    const job = this.getJob(id);
    if (job.status !== "running") return job;
    job.status = "failed";
    job.stage = "failed";
    job.error = message;
    job.completedAt = now();
    this.db
      .prepare("UPDATE jobs SET payload=?,lease_until=0 WHERE id=?")
      .run(JSON.stringify(job), id);
    return job;
  }
}
let cached: Store | undefined;
export function getStore(): Store {
  const root = path.resolve(
    process.env.COUNTERSHOT_DATA_DIR ||
      path.join(process.cwd(), ".data", "countershot"),
  );
  if (!cached || cached.root !== root) {
    cached?.close();
    cached = new Store(root);
  }
  return cached;
}
