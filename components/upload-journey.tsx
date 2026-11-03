import { ArrowRight, Check, ScanLine, Upload } from "lucide-react";
import styles from "./upload-journey.module.css";

export function UploadJourney({ workshop = true }: { workshop?: boolean }) {
  const steps = [
    { icon: Upload, title: "Capture" },
    { icon: ScanLine, title: "Understand" },
    { icon: Check, title: "Confirm & design" },
  ];
  return <section className={styles.journey} aria-label="What to expect after upload">
    <ol className={styles.steps}>
      {steps.map(({ icon: Icon, title }, index) => <li key={title}>
        <span className={styles.icon} aria-hidden="true"><Icon size={18}/></span>
        <strong>{title}</strong>
        {index < steps.length - 1 && <ArrowRight className={styles.arrow} size={16} aria-hidden="true"/>}
      </li>)}
    </ol>
    <details className={styles.note}><summary>About the result</summary><p>Confirm real measurements before generating {workshop ? "jig" : "construction"} drawings. A photo shows the setup; video also shows movement.</p></details>
  </section>;
}
