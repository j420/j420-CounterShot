"use client";

import { useEffect, useState } from "react";
import { ArrowRight, Check } from "lucide-react";
import type { WorkflowDefinition } from "../src/camera/schema";
import type { CameraIntakeFactDraft } from "../src/camera/intake-contract";
import styles from "./camera-workbench.module.css";

type Fact = WorkflowDefinition['requiredFacts'][number];
type Props = {
  fact: Fact;
  draft?: CameraIntakeFactDraft;
  operatorContext?: string;
  draftReady?: boolean;
  disabled: boolean;
  onConfirm: (value: string | number | boolean, draftId?: string) => Promise<void>;
};

export default function CameraPrerequisite({ fact, draft, operatorContext, draftReady = true, disabled, onConfirm }: Props) {
  const [value, setValue] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [editing, setEditing] = useState(false);
  useEffect(() => { setValue(""); setConfirmed(false); setEditing(false); }, [fact.id]);
  const context = fact.kind === "text" && /constraints/.test(fact.id) ? operatorContext?.trim() : "";
  const numeric = value.trim() ? Number(value) : NaN;
  const numberValid = Number.isFinite(numeric) && (fact.min === null || numeric >= fact.min) && (fact.max === null || numeric <= fact.max);
  const candidate = fact.kind === "text" && !editing ? draft?.value || context : null;
  const saveValue = fact.kind === "boolean" ? true : fact.kind === "number" ? numeric : value.trim();
  const valid = fact.kind === "boolean" ? confirmed : fact.kind === "number" ? numberValid && confirmed : !!value.trim();

  return <section className={styles.prerequisite} aria-label="Next setup detail">
    <h3>{fact.label}{fact.unit ? ` (${fact.unit})` : ""}</h3>
    {candidate ? <><p className={styles.cameraHelp}>{draft ? "From your photo. Check the actual labels, then confirm." : "Use the context you entered?"}</p><blockquote className={styles.factDraft}>{candidate}</blockquote>{draft && !draftReady && <p className={styles.cameraHelp}>Load the scene photo to confirm, or edit your own checked detail.</p>}<div className={styles.cameraControls}><button type="button" className={`${styles.button} ${styles.primary}`} disabled={disabled || !!draft && !draftReady} onClick={() => void onConfirm(candidate, draft?.id)}><Check size={16}/>{draft ? "Confirm this detail" : "Use the constraints I entered"}</button><button type="button" className={styles.button} disabled={disabled} onClick={() => { setValue(candidate); setEditing(true); }}>Edit this detail</button></div></>
      : <form onSubmit={event => { event.preventDefault(); if (valid) void onConfirm(saveValue); }}>
        {fact.kind === "boolean" ? <><label className={styles.confirm}><input type="checkbox" checked={confirmed} disabled={disabled} onChange={event => setConfirmed(event.target.checked)}/><span>I confirm this is true for the actual setup.</span></label></>
          : <><label className={styles.field}>{fact.kind === "number" ? "Checked value" : "Your confirmed detail"}{fact.unit ? ` (${fact.unit})` : ""}{fact.kind === "number" ? <input type="number" step="any" min={fact.min ?? undefined} max={fact.max ?? undefined} value={value} disabled={disabled} onChange={event => { setValue(event.target.value); setConfirmed(false); }}/>
            : <textarea maxLength={2000} rows={2} value={value} disabled={disabled} onChange={event => setValue(event.target.value)} placeholder="What did you check?"/>}</label>{fact.kind === "number" && <label className={styles.confirm}><input type="checkbox" checked={confirmed} disabled={disabled || !numberValid} onChange={event => setConfirmed(event.target.checked)}/><span>I checked this value and its stated unit.</span></label>}</>}
        <div className={styles.cameraControls}><button className={`${styles.button} ${styles.primary}`} disabled={disabled || !valid}>{fact.kind === "boolean" ? "Confirm this scope" : "Save confirmed detail"}<ArrowRight size={15}/></button>{fact.kind === "boolean" && <button type="button" className={styles.button} disabled={disabled} onClick={() => void onConfirm(false)}>This scope does not match</button>}</div>
      </form>}
  </section>;
}
