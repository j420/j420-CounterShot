import { ArrowRight, Check, ScanLine, Upload } from "lucide-react";
import styles from "./upload-journey.module.css";

export function UploadJourney({ workshop = true }: { workshop?: boolean }) {
  const steps = [
    { icon: Upload, title: "Upload", text: "Your video or photo is saved to this project." },
    { icon: ScanLine, title: "Review", text: "Choose Analyze the job for the visible steps, holding problems and open questions." },
    { icon: Check, title: "Confirm & design", text: `Confirm real measurements, then generate ${workshop ? "jig" : "construction"} drawings and an action flow.` },
  ];
  return <section className={styles.journey} aria-label="What to expect after upload">
    <h3>What happens next?</h3>
    <ol className={styles.steps}>
      {steps.map(({ icon: Icon, title, text }, index) => <li key={title}>
        <span className={styles.icon} aria-hidden="true"><Icon size={18}/></span>
        <div><strong>{title}</strong><p>{text}</p></div>
        {index < steps.length - 1 && <ArrowRight className={styles.arrow} size={16} aria-hidden="true"/>}
      </li>)}
    </ol>
    <p className={styles.note}>A photo shows the setup; a video can also show movement. If something is unclear, you’ll be asked for another view or a measurement.</p>
  </section>;
}
