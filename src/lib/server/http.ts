import { randomUUID, createHash } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  constraintsSchema,
  trialInputSchema,
  type Asset,
  type InputSnapshot,
  type Trial,
} from "../contracts";
import { deriveTrialOutcome } from "../domain";
import { renderPrintPack } from "../geometry";
import { checkOrigin, health, login, requireAuth } from "./auth";
import { AppError, safeError } from "./errors";
import { kickoffJob } from "./jobs";
import { testMeta } from "./meta";
import {
  boundedBytes,
  MAX_CLIP_BYTES,
  safeFilename,
  validateMedia,
} from "./media";
import { getStore, hash, now, requireId } from "./store";
import { validateTrialEvidence } from "./trials";

const version = z.number().int().positive();
const operation = z.string().uuid();
const projectCreate = z
  .object({
    title: z.string().trim().min(1).max(160),
    goal: z.string().trim().min(1).max(3000),
  })
  .strict();
const observeInput = z
  .object({
    assetId: z.string().uuid(),
    operationId: operation,
    expectedVersion: version,
  })
  .strict();
const designInput = z
  .object({
    operationId: operation,
    expectedVersion: version,
    parentDesignId: z.string().uuid().optional(),
    sourceTrialId: z.string().uuid().optional(),
  })
  .strict();
export function json(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}
async function body<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const bytes = await boundedBytes(request, 100_000);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new AppError(
      "INVALID_JSON",
      "This request must contain valid JSON.",
      400,
    );
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new AppError(
      "INVALID_INPUT",
      `Check the submitted fields: ${[...new Set(parsed.error.issues.map((i) => i.path.join(".") || "request"))].slice(0, 8).join(", ")}.`,
      422,
    );
  return parsed.data;
}
function routeSegments(request: Request): string[] {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(request.url).pathname);
  } catch {
    throw new AppError("INVALID_PATH", "This address is invalid.", 400);
  }
  if (!pathname.startsWith("/api/"))
    throw new AppError("NOT_FOUND", "This endpoint does not exist.", 404);
  return pathname.slice(5).split("/").filter(Boolean);
}
export async function handleApi(request: Request): Promise<Response> {
  try {
    checkOrigin(request);
    const parts = routeSegments(request);
    const method = request.method;
    if (parts.length === 1 && parts[0] === "health" && method === "GET")
      return json(health(request));
    if (parts.length === 1 && parts[0] === "session" && method === "POST") {
      const input = await body(
        request,
        z.object({ accessCode: z.string().max(512) }).strict(),
      );
      return json({ authenticated: true }, 200, {
        "Set-Cookie": login(input.accessCode),
      });
    }
    requireAuth(request);
    if (parts.join("/") === "meta/test" && method === "POST")
      return json(await testMeta());
    const store = getStore();
    if (parts.length === 1 && parts[0] === "projects") {
      if (method === "GET") return json({ projects: store.listProjects() });
      if (method === "POST") {
        const input = await body(request, projectCreate);
        return json(
          { project: store.createProject(input.title, input.goal) },
          201,
        );
      }
    }
    if (parts.length === 2 && parts[0] === "jobs" && method === "GET") {
      const job = store.getJob(requireId(parts[1]));
      kickoffJob(job.id, store);
      return json({ job });
    }
    if (parts[0] !== "projects" || parts.length < 2)
      throw new AppError("NOT_FOUND", "This endpoint does not exist.", 404);
    const projectId = requireId(parts[1]);
    if (parts.length === 2 && method === "GET") {
      const project = store.getProject(projectId);
      const jobs = store.listJobs(projectId);
      for (const job of jobs) kickoffJob(job.id, store);
      return json({ project, jobs });
    }
    if (parts[2] === "assets" && parts.length === 3 && method === "POST") {
      const bytes = await boundedBytes(request, MAX_CLIP_BYTES + 1_000_000);
      let form: FormData;
      try {
        form = await new Request(request.url, {
          method: "POST",
          headers: {
            "content-type": request.headers.get("content-type") || "",
          },
          body: new Uint8Array(bytes),
        }).formData();
      } catch {
        throw new AppError("INVALID_UPLOAD", "Choose a file to upload.", 422);
      }
      const file = form.get("file");
      const role = form.get("role");
      if (!(file instanceof File) || (role !== "job" && role !== "trial"))
        throw new AppError(
          "INVALID_UPLOAD",
          "Choose a file and its job or trial role.",
          422,
        );
      const data = Buffer.from(await file.arrayBuffer());
      const media = validateMedia(data, file.type);
      const project = store.getProject(projectId);
      const submittedVersion = form.get("expectedVersion");
      const expectedVersion =
        submittedVersion === null ? project.version : Number(submittedVersion);
      if (!Number.isInteger(expectedVersion) || expectedVersion < 1)
        throw new AppError(
          "INVALID_VERSION",
          "Refresh the project before uploading.",
          422,
        );
      const asset: Asset = {
        id: randomUUID(),
        filename: safeFilename(file.name),
        mime: media.mime,
        byteLength: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
        createdAt: now(),
        kind: media.kind,
        role,
      };
      const key = `${asset.id}${media.extension}`;
      const filePath = path.join(store.assetRoot, key);
      writeFileSync(filePath, data, { flag: "wx" });
      try {
        return json(
          {
            asset,
            project: store.addAsset(projectId, expectedVersion, asset, key),
          },
          201,
        );
      } catch (error) {
        unlinkSync(filePath);
        throw error;
      }
    }
    if (parts[2] === "assets" && parts.length === 4 && method === "GET") {
      const file = store.readAsset(projectId, requireId(parts[3]));
      return new Response(new Uint8Array(file.bytes), {
        headers: {
          "Content-Type": file.asset.mime,
          "Content-Length": String(file.bytes.length),
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Disposition": `inline; filename="${file.asset.filename.replace(/"/g, "_")}"`,
        },
      });
    }
    if (parts[2] === "confirm" && parts.length === 3 && method === "POST") {
      const input = await body(
        request,
        z
          .object({ constraints: constraintsSchema, expectedVersion: version })
          .strict(),
      );
      if (
        input.constraints.packageFamily === "tuck_carton" &&
        (!input.constraints.cartonLengthMm ||
          !input.constraints.cartonWidthMm ||
          !input.constraints.cartonHeightMm)
      )
        throw new AppError(
          "CARTON_MEASUREMENTS",
          "Confirm all three interior carton dimensions.",
          422,
        );
      const project = store.mutateProject(
        projectId,
        input.expectedVersion,
        (p) => {
          if (!p.observation)
            throw new AppError(
              "OBSERVATION_REQUIRED",
              "Analyze job media before confirming its design inputs.",
              422,
            );
          const snapshot: InputSnapshot = {
            id: randomUUID(),
            hash: hash({
              constraints: input.constraints,
              observation: p.observation,
            }),
            constraints: input.constraints,
            observation: p.observation,
            createdAt: now(),
          };
          p.snapshots.push(snapshot);
          p.currentSnapshotId = snapshot.id;
          p.currentDesignId = null;
        },
      );
      return json({ project });
    }
    if (parts[2] === "observe" && parts.length === 3 && method === "POST") {
      const input = await body(request, observeInput);
      const job = store.startJob(projectId, "observe", input.operationId, {
        expectedVersion: input.expectedVersion,
        assetId: input.assetId,
      });
      kickoffJob(job.id, store);
      return json({ job }, 202);
    }
    if (parts[2] === "designs" && parts.length === 3 && method === "POST") {
      const input = await body(request, designInput);
      const project = store.getProject(projectId);
      const trial = input.sourceTrialId
        ? project.trials.find((t) => t.id === input.sourceTrialId)
        : null;
      if (input.sourceTrialId && !trial)
        throw new AppError(
          "TRIAL_MISMATCH",
          "This feedback trial does not belong to the project.",
          422,
        );
      const parentDesignId = input.parentDesignId || trial?.designId;
      const job = store.startJob(
        projectId,
        input.sourceTrialId ? "revise" : "design",
        input.operationId,
        {
          expectedVersion: input.expectedVersion,
          snapshotId: project.currentSnapshotId || undefined,
          parentDesignId,
          sourceTrialId: input.sourceTrialId,
        },
      );
      kickoffJob(job.id, store);
      return json({ job }, 202);
    }
    if (parts[2] === "trials" && parts.length === 3 && method === "POST") {
      const input = await body(
        request,
        z
          .object({ trial: trialInputSchema, expectedVersion: version })
          .strict(),
      );
      const project = store.getProject(projectId);
      validateTrialEvidence(project, input.trial);
      const trial: Trial = {
        ...input.trial,
        id: randomUUID(),
        createdAt: now(),
        outcome: deriveTrialOutcome(input.trial),
      };
      const saved = store.mutateProject(
        projectId,
        input.expectedVersion,
        (p) => {
          p.trials.push(trial);
        },
      );
      return json({ trial, project: saved }, 201);
    }
    if (
      parts[2] === "designs" &&
      parts[4] === "export" &&
      parts.length === 5 &&
      method === "GET"
    ) {
      const project = store.getProject(projectId);
      const design = project.designs.find((d) => d.id === requireId(parts[3]));
      if (!design)
        throw new AppError(
          "NOT_FOUND",
          "This design revision does not belong to the project.",
          404,
        );
      const snapshot = project.snapshots.find(
        (s) => s.id === design.inputSnapshotId,
      );
      if (!snapshot)
        throw new AppError(
          "SNAPSHOT_MISSING",
          "The construction pack's input snapshot is unavailable.",
          500,
        );
      if (new URL(request.url).searchParams.get("format") === "json")
        return json({ design, snapshot }, 200, {
          "Content-Disposition": `attachment; filename="countershot-r${design.number}.json"`,
        });
      const printHandlerHash = createHash("sha256")
        .update("window.print()")
        .digest("base64");
      return new Response(renderPrintPack(design, snapshot), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": `default-src 'none'; script-src 'unsafe-hashes' 'sha256-${printHandlerHash}'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; frame-ancestors 'self'`,
        },
      });
    }
    throw new AppError("NOT_FOUND", "This endpoint does not exist.", 404);
  } catch (error) {
    const safe = safeError(error);
    return json(
      {
        error: {
          code: safe.code,
          message: safe.message,
          retryable: safe.retryable,
        },
      },
      safe.status,
    );
  }
}
