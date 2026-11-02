"use client";

import { useRef, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Circle,
  ClipboardCheck,
  FileVideo,
  LoaderCircle,
  RefreshCw,
  Upload,
} from "lucide-react";
import type { DesignRevision, Project, TrialInput } from "@/lib/contracts";

const criteria = [
  [
    "buildConfirmed",
    "The built parts match this exact revision",
    "Record deviations in the notes; a design change requires a new revision.",
  ],
  [
    "scaleConfirmed",
    "The printed scale was checked",
    "The scale square measures the stated 50 mm.",
  ],
  [
    "materialMatches",
    "The material matches the confirmed input",
    "Thickness and available sheet match the design's snapshot.",
  ],
  [
    "freshPackageStarted",
    "Started from fresh packaging",
    "Empty-package loading was included without a hidden helper.",
  ],
  [
    "contentsCorrect",
    "All intended contents were loaded",
    "The actual contents match the job's finished definition.",
  ],
  [
    "closureComplete",
    "The defined closure was completed",
    "Inspect the closure; this is not transport certification.",
  ],
  [
    "parcelReleased",
    "The finished parcel was removed",
    "No support is trapped inside and no extra assistance was needed.",
  ],
  [
    "stationReset",
    "The station is ready for another order",
    "Include the next-cycle reset in the evidence.",
  ],
  [
    "evidenceComplete",
    "The video covers the complete cycle",
    "One uninterrupted recording shows preparation through release and reset.",
  ],
] as const;
type Criterion = (typeof criteria)[number][0];

export function TrialPanel({
  project,
  design,
  busy,
  running,
  onSave,
  onUpload,
  onRevise,
}: {
  project: Project;
  design: DesignRevision | null;
  busy: string | null;
  running: boolean;
  onSave: (trial: TrialInput) => Promise<boolean>;
  onUpload: (file: File) => Promise<void>;
  onRevise: (trialId: string) => void;
}) {
  const [checks, setChecks] = useState<Record<Criterion, boolean>>(
    () =>
      Object.fromEntries(criteria.map(([id]) => [id, false])) as Record<
        Criterion,
        boolean
      >,
  );
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
  const [duration, setDuration] = useState("");
  const [helpers, setHelpers] = useState("0");
  const [notes, setNotes] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const [formError, setFormError] = useState<string | null>(null);
  if (!design)
    return (
      <div className="panel empty-state">
        <div className="soft-icon">
          <ClipboardCheck size={28} />
        </div>
        <h2>A physical trial needs a design</h2>
        <p>
          Generate and construct a revision before recording its complete
          operating cycle.
        </p>
      </div>
    );
  const assets = project.assets.filter((a) => a.role === "trial");
  const previewAsset =
    assets.find((a) => selectedAssetIds.includes(a.id) && a.kind === "video") ??
    assets.find((a) => selectedAssetIds.includes(a.id));
  const trials = project.trials.filter((t) => t.designId === design.id);
  const successful = trials.filter(
    (t) => t.outcome === "observed_complete",
  ).length;
  const stale = design.inputSnapshotId !== project.currentSnapshotId;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setFormError(null);
    if (
      checks.evidenceComplete &&
      !selectedAssetIds.some(
        (id) => assets.find((a) => a.id === id)?.kind === "video",
      )
    ) {
      setFormError(
        "Select a full-cycle trial video before confirming complete evidence.",
      );
      return;
    }
    const saved = await onSave({
      ...checks,
      designId: design.id,
      helperInterventions: Number(helpers),
      durationSeconds: duration.trim() ? Number(duration) : null,
      notes,
      assetIds: selectedAssetIds,
    });
    if (saved) {
      setChecks(
        Object.fromEntries(criteria.map(([id]) => [id, false])) as Record<
          Criterion,
          boolean
        >,
      );
      setSelectedAssetIds([]);
      setDuration("");
      setHelpers("0");
      setNotes("");
    }
  };
  return (
    <>
      <div className="trial-summary">
        <div>
          <span className="eyebrow">
            OBSERVED EVIDENCE · REVISION {design.number}
          </span>
          <h2>
            <span>{successful}</span> of {trials.length} cycles observed
            complete
          </h2>
          <p>
            Results apply to this revision, material and declared constraints.
          </p>
        </div>
        <div className="trial-summary-icon">
          <ClipboardCheck size={32} />
        </div>
      </div>
      {stale && (
        <div className="message warning">
          <AlertCircle size={17} />
          This is a historical revision. Any trial here records evidence for
          that exact earlier build.
        </div>
      )}
      <div className="trial-layout">
        <form onSubmit={submit} className="panel trial-form">
          <div className="panel-title">
            <div>
              <h2>Record a complete cycle</h2>
              <p>
                Inspect the result yourself. Keep failed and incomplete trials.
              </p>
            </div>
            <span className="subtle-badge">Human review</span>
          </div>
          <input
            type="file"
            ref={fileInput}
            className="sr-only"
            accept="video/mp4,image/jpeg,image/png"
            aria-label="Upload trial evidence"
            onChange={(e) => {
              if (e.target.files?.[0]) {
                void onUpload(e.target.files[0]);
                e.target.value = "";
              }
            }}
          />
          <button
            className="trial-upload"
            type="button"
            disabled={!!busy}
            onClick={() => fileInput.current?.click()}
          >
            {busy === "trial-upload" ? (
              <LoaderCircle className="spin" size={22} />
            ) : (
              <Upload size={22} />
            )}
            <div>
              <strong>Upload the trial recording</strong>
              <span>
                MP4 for full-cycle evidence; photos can show a specific failure.
              </span>
            </div>
          </button>
          {!!assets.length && (
            <div className="evidence-picker">
              {assets.map((asset) => (
                <label key={asset.id}>
                  <input
                    type="checkbox"
                    checked={selectedAssetIds.includes(asset.id)}
                    onChange={(e) =>
                      setSelectedAssetIds((current) =>
                        e.target.checked
                          ? [...current, asset.id]
                          : current.filter((id) => id !== asset.id),
                      )
                    }
                  />
                  <FileVideo size={16} />
                  <span>{asset.filename}</span>
                  <small>{asset.kind}</small>
                </label>
              ))}
            </div>
          )}
          {previewAsset && (
            <div className="media-area trial-media-preview">
              {previewAsset.kind === "video" ? (
                <video
                  key={previewAsset.id}
                  src={`/api/projects/${project.id}/assets/${previewAsset.id}`}
                  controls
                  preload="metadata"
                />
              ) : (
                <div
                  className="uploaded-image"
                  role="img"
                  aria-label={previewAsset.filename}
                  style={{
                    backgroundImage: `url("/api/projects/${project.id}/assets/${previewAsset.id}")`,
                  }}
                />
              )}
              <div className="media-caption">
                Review selected evidence: {previewAsset.filename}
              </div>
            </div>
          )}
          <div className="trial-checklist">
            {criteria.map(([id, title, help]) => (
              <label key={id} className={checks[id] ? "is-checked" : ""}>
                <input
                  type="checkbox"
                  checked={checks[id]}
                  onChange={(e) =>
                    setChecks((current) => ({
                      ...current,
                      [id]: e.target.checked,
                    }))
                  }
                />
                <span>
                  <strong>{title}</strong>
                  <small>{help}</small>
                </span>
              </label>
            ))}
          </div>
          <div className="measure-grid two">
            <div>
              <label className="field-label" htmlFor="trial-helpers">
                Helper / undeclared-resource interventions
              </label>
              <input
                type="number"
                id="trial-helpers"
                min={0}
                max={100}
                value={helpers}
                onChange={(e) => setHelpers(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="field-label" htmlFor="trial-duration">
                Complete cycle time <small>(seconds, optional)</small>
              </label>
              <input
                type="number"
                id="trial-duration"
                min={0}
                max={7200}
                value={duration}
                placeholder="Measured elapsed time"
                onChange={(e) => setDuration(e.target.value)}
              />
            </div>
          </div>
          <label className="field-label spaced" htmlFor="trial-notes">
            What happened? Where did the method fail?
          </label>
          <textarea
            id="trial-notes"
            rows={4}
            maxLength={3000}
            value={notes}
            placeholder="Describe the observable difficulty, any material changes and what happened during release or reset."
            onChange={(e) => setNotes(e.target.value)}
          />
          {formError && (
            <p className="field-error" role="alert">
              {formError}
            </p>
          )}
          <div className="panel-bottom">
            <span>
              <ClipboardCheck size={15} /> Outcome is derived from these
              criteria.
            </span>
            <button className="button primary" type="submit" disabled={!!busy}>
              {busy === "trial" ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <>
                  Save this trial <ArrowRight size={16} />
                </>
              )}
            </button>
          </div>
        </form>
        <aside className="trial-history">
          <div className="panel">
            <div className="panel-title">
              <h2>Revision {design.number} trials</h2>
              <span className="subtle-badge">{trials.length}</span>
            </div>
            {!trials.length ? (
              <div className="history-empty">
                <ClipboardCheck size={28} />
                <p>
                  Your first trial will appear here, including failures and
                  incomplete evidence.
                </p>
              </div>
            ) : (
              [...trials].reverse().map((trial, i) => (
                <div className="history-trial" key={trial.id}>
                  <div className="history-trial-heading">
                    <strong>Trial {trials.length - i}</strong>
                    <span className={`outcome ${trial.outcome}`}>
                      {trial.outcome === "observed_complete" ? (
                        <CheckCircle2 size={13} />
                      ) : (
                        <Circle size={13} />
                      )}{" "}
                      {trial.outcome.replaceAll("_", " ")}
                    </span>
                  </div>
                  <p>{trial.notes || "No additional observations recorded."}</p>
                  <div className="trial-meta">
                    <span>{trial.helperInterventions} interventions</span>
                    <span>
                      {trial.durationSeconds == null
                        ? "Time not recorded"
                        : `${trial.durationSeconds}s`}
                    </span>
                  </div>
                  <button
                    className="button small wide"
                    type="button"
                    disabled={
                      !!busy || running || !trial.notes.trim() || !!stale
                    }
                    onClick={() => onRevise(trial.id)}
                  >
                    <RefreshCw size={14} /> Improve from this evidence
                  </button>
                </div>
              ))
            )}
          </div>
          <div className="tip-card">
            <AlertCircle size={20} />
            <h4>Record engineering changes</h4>
            <p>
              If the maker changes dimensions or material, create a matching
              revision before presenting the result as evidence for that design.
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}
