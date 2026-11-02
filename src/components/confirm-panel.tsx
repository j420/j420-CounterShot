"use client";

import { useState } from "react";
import {
  ArrowRight,
  Check,
  Hand,
  LoaderCircle,
  Package,
  Ruler,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import {
  constraintsSchema,
  type Constraints,
  type Project,
} from "@/lib/contracts";

const numberFields = [
  "workspaceWidthMm",
  "workspaceDepthMm",
  "itemLengthMm",
  "itemWidthMm",
  "itemHeightMm",
  "cardboardThicknessMm",
  "sheetWidthMm",
  "sheetHeightMm",
  "cartonLengthMm",
  "cartonWidthMm",
  "cartonHeightMm",
] as const;
type NumberField = (typeof numberFields)[number];

export function ConfirmPanel({
  project,
  busy,
  onSave,
}: {
  project: Project;
  busy: boolean;
  onSave: (constraints: Constraints) => void;
}) {
  const existing = project.snapshots.find(
    (s) => s.id === project.currentSnapshotId,
  )?.constraints;
  const [activeHand, setActiveHand] = useState<Constraints["activeHand"]>(
    existing?.activeHand ?? "right",
  );
  const [actions, setActions] = useState<Constraints["allowedActions"]>(
    existing?.allowedActions ?? ["grasp", "press", "fold"],
  );
  const [family, setFamily] = useState<Constraints["packageFamily"]>(
    existing?.packageFamily ?? "wraparound",
  );
  const [numbers, setNumbers] = useState<Record<NumberField, string>>(
    () =>
      Object.fromEntries(
        numberFields.map((f) => [
          f,
          existing?.[f] == null ? "" : String(existing[f]),
        ]),
      ) as Record<NumberField, string>,
  );
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [confirmed, setConfirmed] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const measurement = (
    field: NumberField,
    label: string,
    placeholder: string,
    help?: string,
  ) => (
    <div className="measure-field">
      <label className="field-label" htmlFor={field}>
        {label}
      </label>
      <div className={`unit-input ${errors[field] ? "invalid" : ""}`}>
        <input
          id={field}
          type="number"
          min="0"
          step="0.1"
          value={numbers[field]}
          placeholder={placeholder}
          onChange={(e) =>
            setNumbers((current) => ({ ...current, [field]: e.target.value }))
          }
          required={family === "tuck_carton" || !field.startsWith("carton")}
          aria-invalid={!!errors[field]}
          aria-describedby={errors[field] ? `${field}-error` : undefined}
        />
        <span>mm</span>
      </div>
      {help && <small>{help}</small>}
      {errors[field] && (
        <span className="field-error" id={`${field}-error`}>
          {errors[field]}
        </span>
      )}
    </div>
  );

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const values = Object.fromEntries(
      numberFields.map((f) => [
        f,
        f.startsWith("carton") && family !== "tuck_carton"
          ? null
          : numbers[f].trim() === ""
            ? undefined
            : Number(numbers[f]),
      ]),
    );
    const result = constraintsSchema.safeParse({
      ...values,
      activeHand,
      allowedActions: actions,
      packageFamily: family,
      measurementsConfirmed: confirmed,
      notes,
    });
    if (!result.success) {
      const fields: Record<string, string> = {};
      for (const issue of result.error.issues)
        fields[String(issue.path[0])] =
          issue.path[0] === "measurementsConfirmed"
            ? "Confirm your measurements and functional permissions."
            : issue.message;
      setErrors(fields);
      return;
    }
    setErrors({});
    onSave(result.data);
  };

  return (
    <form className="confirm-form" onSubmit={submit}>
      <div className="panel">
        <div className="panel-title">
          <div className="section-title">
            <span className="soft-icon small">
              <Hand size={20} />
            </span>
            <div>
              <h2>How you can work</h2>
              <p>State the actions you can comfortably use.</p>
            </div>
          </div>
          <span className="subtle-badge">Your confirmation</span>
        </div>
        <label className="field-label">Available hand</label>
        <div className="choice-row">
          {(["right", "left", "both"] as const).map((h) => (
            <button
              key={h}
              type="button"
              className={`choice ${activeHand === h ? "chosen" : ""}`}
              onClick={() => setActiveHand(h)}
            >
              <Hand size={17} />
              {h === "both"
                ? "Both hands"
                : `${h[0].toUpperCase() + h.slice(1)} hand`}
              {activeHand === h && <Check size={14} />}
            </button>
          ))}
        </div>
        <label className="field-label spaced">Permitted actions</label>
        <div className="action-options">
          {(
            [
              { id: "grasp", label: "Grasp" },
              { id: "press", label: "Press" },
              { id: "pull", label: "Pull" },
              { id: "fold", label: "Fold" },
              { id: "palm_support", label: "Palm support" },
            ] as const
          ).map((a) => (
            <label
              key={a.id}
              className={`check-chip ${actions.includes(a.id) ? "checked" : ""}`}
            >
              <input
                type="checkbox"
                checked={actions.includes(a.id)}
                onChange={(e) =>
                  setActions((current) =>
                    e.target.checked
                      ? [...current, a.id]
                      : current.filter((x) => x !== a.id),
                  )
                }
              />
              {a.label}
            </label>
          ))}
        </div>
        <p className="form-note">
          Capabilities come from your statements. Appearance in footage does not
          establish them.
        </p>
        <div className="measure-grid two">
          <div>
            {measurement(
              "workspaceWidthMm",
              "Working area width",
              "e.g. 600",
              "Measure the area within your comfortable reach.",
            )}
          </div>
          <div>
            {measurement(
              "workspaceDepthMm",
              "Working area depth",
              "e.g. 400",
              "From the front edge away from you.",
            )}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">
          <div className="section-title">
            <span className="soft-icon small">
              <Package size={20} />
            </span>
            <div>
              <h2>The contents and package</h2>
              <p>Measure the complete bundle, including its card.</p>
            </div>
          </div>
        </div>
        <div className="measure-grid three">
          {measurement("itemLengthMm", "Bundle length", "148")}
          {measurement("itemWidthMm", "Bundle width", "105")}
          {measurement("itemHeightMm", "Bundle height", "12")}
        </div>
        <label className="field-label spaced">Package family</label>
        <div className="package-choices">
          <button
            type="button"
            className={`package-choice ${family === "wraparound" ? "chosen" : ""}`}
            onClick={() => setFamily("wraparound")}
          >
            <span className="package-sketch wrap-sketch" />
            <div>
              <strong>Cardboard wrap</strong>
              <small>A flat blank formed around the goods.</small>
            </div>
            {family === "wraparound" && <Check size={17} />}
          </button>
          <button
            type="button"
            className={`package-choice ${family === "tuck_carton" ? "chosen" : ""}`}
            onClick={() => setFamily("tuck_carton")}
          >
            <span className="package-sketch carton-sketch" />
            <div>
              <strong>Existing tuck carton</strong>
              <small>A top-opening carton with its own closure.</small>
            </div>
            {family === "tuck_carton" && <Check size={17} />}
          </button>
        </div>
        {family === "tuck_carton" && (
          <div className="carton-measurements">
            <p>
              Use the usable inside dimensions. The first scope is a top-opening
              hinged-lid/tuck carton; other closures need a separate admission
              test.
            </p>
            <div className="measure-grid three">
              {measurement("cartonLengthMm", "Inside length", "190")}
              {measurement("cartonWidthMm", "Inside width", "135")}
              {measurement("cartonHeightMm", "Inside height", "30")}
            </div>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-title">
          <div className="section-title">
            <span className="soft-icon small">
              <Ruler size={20} />
            </span>
            <div>
              <h2>Materials on your table</h2>
              <p>Use actual measurements rather than camera estimates.</p>
            </div>
          </div>
        </div>
        <div className="measure-grid three">
          {measurement("cardboardThicknessMm", "Board thickness", "1.5")}
          {measurement("sheetWidthMm", "Available sheet width", "600")}
          {measurement("sheetHeightMm", "Available sheet height", "450")}
        </div>
        <label className="field-label spaced" htmlFor="constraint-notes">
          Anything else the design needs to respect?
        </label>
        <textarea
          id="constraint-notes"
          rows={3}
          maxLength={2000}
          placeholder="For example: loading must be from the front; no clips available; pulling narrow tabs is difficult."
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
        <p className="form-note">
          Fold, friction and joint-fit assumptions remain physical tests for
          this material.
        </p>
      </div>

      <div className="confirmation-box">
        <ShieldCheck size={22} />
        <label>
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          <span>
            I have measured these values and confirmed the actions I can use. I
            understand that a generated design still needs a physical trial.
          </span>
        </label>
      </div>
      {errors.measurementsConfirmed && (
        <p className="field-error" role="alert">
          {errors.measurementsConfirmed}
        </p>
      )}
      {errors.allowedActions && (
        <p className="field-error" role="alert">
          Select at least one permitted action.
        </p>
      )}
      <div className="bottom-actions">
        <span className="form-note">
          <Settings2 size={14} /> Saving creates a new, preserved input
          snapshot.
        </span>
        <button className="button primary" disabled={busy} type="submit">
          {busy ? (
            <LoaderCircle className="spin" size={17} />
          ) : (
            <>
              Save confirmed facts <ArrowRight size={17} />
            </>
          )}
        </button>
      </div>
    </form>
  );
}
