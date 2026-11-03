"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowRight, ArrowUpRight, Box, Check, ChevronRight, CircleDashed, Clock3, Fingerprint, LoaderCircle, LockKeyhole, Plus, ScanLine, Sparkles, ImagePlus, Video, X } from "lucide-react";
import { CameraIllustration, Mark, Shell, StatusPill } from "../components/shell";
import type { Project, Workflow } from "../components/types";
import styles from "../components/home-intro.module.css";

export default function Home() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [modal, setModal] = useState(false);
  const [error, setError] = useState("");
  const [health, setHealth] = useState<{ meta?: { configured: boolean; model: string }; accessCodeRequired?: boolean; accessGranted?: boolean }>({});
  const [accessCode, setAccessCode] = useState("");
  const [form, setForm] = useState({ workflow: "workshop_jig" as Workflow, title: "", goal: "", finishedDefinition: "" });

  async function load() {
    setLoading(true);
    try {
      const h = await fetch("/api/health").then(r => r.json());
      setHealth(h);
      if (!h.accessCodeRequired || h.accessGranted) {
        const r = await fetch("/api/projects"); const d = await r.json();
        if (!r.ok) throw new Error(d.error || "Could not load projects.");
        setProjects(d.projects || []);
      }
    } catch (e) { setError(e instanceof Error ? e.message : "Connection failed."); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!modal) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setModal(false);
      if (event.key !== "Tab") return;
      const controls = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"] button:not(:disabled), [role="dialog"] input, [role="dialog"] textarea, [role="dialog"] a[href]'));
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); previous?.focus(); };
  }, [modal]);

  async function create(demo = false) {
    setCreating(true); setError("");
    try {
      const r = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(demo ? { workflow:"workshop_jig", title: "A fixture for the next joint.", goal: "Assemble a low-force pre-cut flat-pack instrument enclosure using one available hand. The jig locates the base and braces each wall while the next panel is joined, then clears the finished assembly for front extraction.", finishedDefinition: "Panels registered and joined within the confirmed alignment tolerance, temporary supports released, front gate parked, enclosure extracted intact, and jig reset.", demo: true } : form) });
      const d = await r.json(); if (!r.ok) throw new Error(d.error || "Could not create project.");
      router.push(`/projects/${d.project.id}/${demo ? "design" : "capture"}`);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not create project."); }
    finally { setCreating(false); }
  }

  if (health.accessCodeRequired && !health.accessGranted) return <div className="access-screen"><div className="access-card"><Mark/><span className="eyebrow">COUNTERSHOT STUDIO</span><h1>A space to make<br/>work possible.</h1><p>This demonstration workspace uses an access code. Ask the project team for yours.</p><form onSubmit={async e => { e.preventDefault(); setCreating(true); setError(""); try { const r = await fetch("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accessCode }) }); const d = await r.json(); if (!r.ok) throw new Error(d.error || "Invalid access code."); await load(); } catch (e) { setError((e as Error).message); } finally { setCreating(false); } }}><label>Workspace access code<input type="password" required value={accessCode} onChange={e => setAccessCode(e.target.value)} autoComplete="current-password"/></label>{error && <div className="error-banner" role="alert">{error}</div>}<button className="button primary" disabled={creating}><LockKeyhole size={16}/> Open workspace</button></form></div></div>;

  return <Shell>
    <header className="topbar"><div className="breadcrumb">Workspace <ChevronRight size={13}/><span>Projects</span></div><span className="topbar-label"><span className="live-dot"/> YOUR WORKSPACE</span></header>
    <div className={`page-content dashboard ${styles.intro}`}>
      <div className="page-heading"><div><span className="eyebrow">YOUR WORK</span><h1>Projects</h1></div><button className="button primary" onClick={() => setModal(true)}><Plus size={17}/> New project</button></div>
      {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError("")} aria-label="Dismiss error"><X size={16}/></button></div>}
      <section className="hero-card">
        <div className="hero-copy"><span className="eyebrow"><span className="tiny-cross">+</span> SHOW. REVIEW. TRY.</span><h2>Show the work.<br/>See the <em>next step.</em></h2><p>Use a photo for step-by-step guidance, or a short workshop video to plan a jig.</p><div className="hero-actions"><Link className="button primary" href="/camera">Open camera workbench <ArrowRight size={17}/></Link><button className="button text" disabled={creating} onClick={() => void create(true)}>{creating ? <LoaderCircle className="spin" size={16}/> : <Box size={17}/>} Explore a sample</button></div><div className="hero-footnote"><Fingerprint size={15}/> Meta proposes the next step. You check the result.</div></div>
        <div className="hero-visual"><div className="visual-topline"><span>THE CAMERA WORKSPACE</span><span>FIVE PHYSICAL WORKFLOWS</span></div><CameraIllustration/><div className="visual-bottomline"><span><i className="legend-dot cream"/> Before + after evidence</span><span><i className="legend-dot orange"/> One concrete next move</span></div></div>
      </section>
      <section className={`workflow-strip ${styles.flow}`} id="workflow" aria-label="How CounterShot works">
        {[{icon:<ScanLine size={19}/>,title:"Show the setup",text:"Take a photo or record the workshop task."},{icon:<Sparkles size={19}/>,title:"Review the guidance",text:"See a proposed next step and any missing facts."},{icon:<Check size={19}/>,title:"Try it and check",text:"Show what changed and record the actual result."}].map((s,i) => <div className="workflow-step" key={s.title}><span className="workflow-icon">{s.icon}</span><div><h3>{s.title}</h3><p>{s.text}</p></div>{i < 2 && <ArrowRight className="workflow-arrow" size={17}/>}</div>)}
      </section>
      <section className={styles.expectations} aria-labelledby="upload-expectations-heading">
        <h2 id="upload-expectations-heading">What happens after upload?</h2>
        <div className={styles.paths}>
          <article className={styles.path}>
            <span className={styles.pathIcon}><ImagePlus size={19}/></span>
            <div><h3>Photo · Camera guidance</h3><p>Meta checks the selected view and proposes one next move, what should change, and when to stop.</p><p className={styles.pathHint}>If a detail is unclear, you’ll be asked for a clearer view or a measurement.</p></div>
          </article>
          <article className={styles.path}>
            <span className={styles.pathIcon}><Video size={19}/></span>
            <div><h3>Video · Workshop jig</h3><p>Your clip is saved first. Choose <strong>Analyze the job</strong> to review the task, then confirm measurements before generating a jig plan.</p><details className={styles.more}><summary>See the workshop steps</summary><ul><li>Review the observed actions and holding conflicts.</li><li>Confirm the real measurements and available resources.</li><li>Generate jig drawings and an assembly sequence.</li><li>Build, test and record what happened.</li></ul></details><button type="button" className={`button secondary ${styles.videoButton}`} onClick={() => setModal(true)}>Start with a workshop video <ArrowRight size={15}/></button></div>
          </article>
        </div>
      </section>
      <section className="projects-section"><div className="section-heading"><h2>Your projects <span className="count">{projects.length}</span></h2><span className="muted small">Pick up where you left off.</span></div>
        {loading ? <div className="empty-state"><LoaderCircle size={24} className="spin"/><p>Opening your workspace…</p></div> : projects.length ? <div className="project-grid">{[...projects].reverse().map(project => <Link className="project-card" href={`/projects/${project.id}/${project.currentDesignId ? "design" : "capture"}`} key={project.id}><div className="project-card-top"><span className="project-icon"><Box size={22}/></span><StatusPill tone={project.isDemo ? "sample" : project.currentDesignId ? "green" : "neutral"}>{project.isDemo ? "Synthetic sample" : project.currentDesignId ? "Design available" : "In progress"}</StatusPill><ArrowUpRight size={18}/></div><h3>{project.title}</h3><p>{project.goal}</p><div className="project-card-footer"><span><Clock3 size={13}/> {new Date(project.updatedAt || project.createdAt).toLocaleDateString(undefined,{month:"short",day:"numeric"})}</span><span>Open project <ArrowRight size={14}/></span></div></Link>)}<button className="project-card new-project-card" onClick={() => setModal(true)}><span className="new-project-icon"><Plus size={24}/></span><h3>What could work better?</h3><p>Start with one real holding or alignment conflict.</p></button></div> : <div className="empty-projects"><div className="empty-project-art"><CircleDashed size={64} strokeWidth={1}/><Box size={26}/></div><div><h3>Your first improvement starts here.</h3><p>Show us the task and the person doing it.<br/>We’ll help you explore a workable method.</p></div><button className="button secondary" onClick={() => setModal(true)}>Create your first project <ArrowRight size={16}/></button></div>}
      </section>
      <section className="evidence-note" id="evidence"><div className="evidence-symbol"><Fingerprint size={24}/></div><div><h3>Keep the result with the work.</h3><p>Your plans, measurements and reviewed trial results stay with the project.</p></div><span className="note-label">YOUR PROJECT HISTORY <ArrowDown size={13}/></span></section>
      <footer className="page-footer"><span>CounterShot <span className="separator">/</span> Show. Review. Try.</span><span>Suggestions from Meta. Results reviewed by you.</span></footer>
    </div>
    {modal && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setModal(false); }}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="new-project-heading"><button className="modal-close" onClick={() => setModal(false)} aria-label="Close new project"><X size={20}/></button><span className="eyebrow">START WITH THE WORK</span><h2 id="new-project-heading">Start a workshop task.</h2><p>Describe a low-force enclosure assembly that needs holding or alignment. Next, you can record a video, take photos or choose existing files.</p><form onSubmit={e => { e.preventDefault(); void create(); }}><div className="workflow-scope"><strong>Custom workshop jig</strong><span>For low-force assembly of pre-cut interlocking enclosure panels.</span></div><label>Project name<input autoFocus required maxLength={120} placeholder="e.g. Instrument enclosure, one hand" value={form.title} onChange={e => setForm({...form,title:e.target.value})}/></label><label>What are you trying to do?<textarea required placeholder="Hold each enclosure wall square while I join the next panel using my right hand…" value={form.goal} onChange={e => setForm({...form,goal:e.target.value})}/></label><label>What does finished mean?<textarea required placeholder="Panels aligned and joined; supports released; gate parked; finished enclosure extracted intact; jig reset." value={form.finishedDefinition} onChange={e => setForm({...form,finishedDefinition:e.target.value})}/></label>{error && <div className="error-banner" role="alert">{error}</div>}<button className="button primary full" disabled={creating}>{creating ? <LoaderCircle size={17} className="spin"/> : <Plus size={17}/>} Create project</button><small className="muted">Your draft is saved before you upload any media.</small></form></section></div>}
  </Shell>;
}
