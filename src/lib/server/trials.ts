import type { Project, TrialInput } from "../contracts";
import { AppError } from "./errors";

export function validateTrialEvidence(
  project: Project,
  input: TrialInput,
): void {
  if (!project.designs.some((d) => d.id === input.designId))
    throw new AppError(
      "DESIGN_REQUIRED",
      "Select a design revision from this project.",
      422,
    );
  for (const assetId of input.assetIds) {
    const asset = project.assets.find((a) => a.id === assetId);
    if (!asset || asset.role !== "trial")
      throw new AppError(
        "TRIAL_MEDIA",
        "All trial evidence must be trial media from this project.",
        422,
      );
  }
  if (!input.evidenceComplete) return;
  const videos = project.assets.filter(
    (a) =>
      input.assetIds.includes(a.id) && a.kind === "video" && a.role === "trial",
  );
  if (!videos.length)
    throw new AppError(
      "VIDEO_EVIDENCE_REQUIRED",
      "An uninterrupted trial video is required to mark full-cycle evidence complete.",
      422,
    );
  const hashes = new Set(videos.map((a) => a.sha256));
  const duplicate = project.trials.some(
    (t) =>
      t.designId === input.designId &&
      t.evidenceComplete &&
      t.assetIds.some((id) =>
        project.assets.some(
          (a) => a.id === id && a.kind === "video" && hashes.has(a.sha256),
        ),
      ),
  );
  if (duplicate)
    throw new AppError(
      "DUPLICATE_CYCLE_EVIDENCE",
      "This recording already belongs to a full-cycle trial for this revision. Record a new cycle rather than counting the same video again.",
      409,
    );
}
