import { randomUUID } from "node:crypto";
import type { Response as ModelResponse } from "openai/resources/responses/responses";
import type { DesignRevision } from "../contracts";
import { compileDesign } from "../geometry";
import { AppError, safeError } from "./errors";
import { observeJob, planJob } from "./meta";
import { getStore, now, type Store } from "./store";
import { designFingerprint } from "./revisions";

const running = new Map<string, Promise<void>>();
export function kickoffJob(id: string, store = getStore()): void {
  if (running.has(id)) return;
  const promise = runJob(id, store)
    .catch(() => {
      try {
        store.failJob(
          id,
          "The worker could not finish this operation. Saved inputs are preserved; start a new attempt.",
        );
      } catch {
        /* A temporarily unavailable database is recovered on the next authorized poll. */
      }
    })
    .finally(() => {
      running.delete(id);
    });
  running.set(id, promise);
}
export async function runJob(id: string, store: Store): Promise<void> {
  const job = store.claimJob(id);
  if (!job) return;
  const heartbeat = setInterval(() => {
    try {
      const current = store.getJob(id);
      if (current.status === "running") store.stageJob(id, current.stage);
    } catch {
      /* deleted/closed database; final commit still validates ownership */
    }
  }, 30_000);
  heartbeat.unref();
  try {
    if (Date.now() - Date.parse(job.createdAt) > 15 * 60_000)
      throw new AppError(
        "JOB_TIMEOUT",
        "This job exceeded its recovery window. Start a new attempt from current inputs.",
        504,
        true,
      );
    const request = store.jobRequest(id);
    const project = store.getProject(job.projectId);
    if (project.version !== request.expectedVersion) {
      store.finishJob(id, "", () => {});
      return;
    }
    const options = {
      recoverResponseId: store.responseId(id),
      onResponseId: (responseId: string) =>
        store.saveResponseId(id, responseId),
      onComplete: (response: ModelResponse) =>
        store.recordCall(
          id,
          response.id,
          response.status || "unknown",
          response.usage,
        ),
    };
    if (job.kind === "observe") {
      if (!request.assetId)
        throw new AppError("MEDIA_REQUIRED", "Select original job media.", 422);
      store.stageJob(
        id,
        options.recoverResponseId ? "recovering_response" : "observing_media",
      );
      const result = await observeJob(store, project, request.assetId, options);
      store.finishJob(id, result.responseId, (p) => {
        p.observation = result.value;
        p.observationAssetId = request.assetId!;
        p.currentSnapshotId = null;
        p.currentDesignId = null;
      });
      return;
    }
    const snapshot = project.snapshots.find((s) => s.id === request.snapshotId);
    if (!snapshot)
      throw new AppError(
        "CONFIRM_REQUIRED",
        "Confirm current measurements before designing.",
        422,
      );
    const trial = request.sourceTrialId
      ? project.trials.find((t) => t.id === request.sourceTrialId) || null
      : null;
    if (trial && trial.designId !== request.parentDesignId)
      throw new AppError(
        "TRIAL_MISMATCH",
        "The trial and parent revision do not match.",
        422,
      );
    store.stageJob(
      id,
      options.recoverResponseId
        ? "recovering_response"
        : trial
          ? "reviewing_trial_feedback"
          : "planning_method",
    );
    let result = await planJob(
      store,
      project,
      snapshot.constraints,
      trial,
      options,
    );
    let compiled = compileDesign(result.value, snapshot.constraints);
    if (!compiled.report.valid) {
      store.stageJob(id, "correcting_failed_checks");
      const correction = compiled.report.issues
        .filter((i) => i.severity === "error")
        .map((i) => `${i.rule}: ${i.message}`)
        .slice(0, 12)
        .join("\n");
      result = await planJob(
        store,
        project,
        snapshot.constraints,
        trial,
        { ...options, recoverResponseId: null },
        `The previous proposal failed deterministic checks. Fix these without changing confirmed measurements:\n${correction}\nPrevious proposal to correct:\n${JSON.stringify(result.value)}`,
      );
      compiled = compileDesign(result.value, snapshot.constraints);
    }
    if (!compiled.report.valid)
      throw new AppError(
        "DESIGN_CHECKS_FAILED",
        `No buildable candidate passed the declared checks. ${compiled.report.issues
          .filter((i) => i.severity === "error")
          .slice(0, 3)
          .map((i) => i.message)
          .join(" ")}`,
        422,
      );
    const parent = project.designs.find((d) => d.id === request.parentDesignId);
    if (
      parent &&
      designFingerprint(parent.proposal, parent.compiled) ===
        designFingerprint(result.value, compiled)
    )
      throw new AppError(
        "UNCHANGED_REVISION",
        "The proposed revision leaves the hardware and executable sequence unchanged. Retest the existing revision or add specific observed failure evidence before requesting another improvement.",
        422,
      );
    store.stageJob(id, "saving_checked_revision");
    const design: DesignRevision = {
      id: randomUUID(),
      number: project.designs.length + 1,
      parentId: request.parentDesignId || null,
      inputSnapshotId: snapshot.id,
      inputHash: snapshot.hash,
      createdAt: now(),
      proposal: result.value,
      compiled,
      sourceTrialId: trial?.id || null,
      model: result.model,
      responseId: result.responseId,
    };
    store.finishJob(id, design.id, (p) => {
      p.designs.push(design);
      p.currentDesignId = design.id;
    });
  } catch (error) {
    if (
      error instanceof AppError &&
      ["META_STILL_RUNNING", "META_INTERRUPTED"].includes(error.code) &&
      store.responseId(id)
    ) {
      store.deferJob(id, "waiting_for_stored_response");
    } else {
      const safe = safeError(error);
      store.recordCall(id, store.responseId(id), "failed", null);
      store.failJob(id, safe.message);
    }
  } finally {
    clearInterval(heartbeat);
  }
}
