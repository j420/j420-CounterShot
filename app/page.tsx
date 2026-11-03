"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, ArrowUpRight, Box, Check, ChevronRight, Clock3, LoaderCircle, LockKeyhole, Plus, ScanLine, Sparkles, Video, X } from "lucide-react";
import { Mark, Shell, StatusPill } from "../components/shell";
import type { Project } from "../components/types";
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
  const [form, setForm] = useState({ goal: "", finishedDefinition: "" });

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
      const r = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(demo ? { workflow:"workshop_jig", title: "A fixture for the next joint.", goal: "Assemble a low-force pre-cut flat-pack instrument enclosure using one available hand. The jig locates the base and braces each wall while the next panel is joined, then clears the finished assembly for front extraction.", finishedDefinition: "Panels registered and joined within the confirmed alignment tolerance, temporary supports released, front gate parked, enclosure extracted intact, and jig reset.", demo: true } : { workflow: "workshop_jig", title: form.goal.trim().split(/\s+/).slice(0, 8).join(" ").slice(0, 120), ...form }) });
      const d = await r.json(); if (!r.ok) throw new Error(d.error || "Could not create project.");
      router.push(`/projects/${d.project.id}/${demo ? "design" : "capture"}`);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not create project."); }
    finally { setCreating(false); }
  }

  if (health.accessCodeRequired && !health.accessGranted) return <div className="access-screen"><div className="access-card"><Mark/><span className="eyebrow">COUNTERSHOT STUDIO</span><h1>A space to make<br/>work possible.</h1><p>This demonstration workspace uses an access code. Ask the project team for yours.</p><form onSubmit={async e => { e.preventDefault(); setCreating(true); setError(""); try { const r = await fetch("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accessCode }) }); const d = await r.json(); if (!r.ok) throw new Error(d.error || "Invalid access code."); await load(); } catch (e) { setError((e as Error).message); } finally { setCreating(false); } }}><label>Workspace access code<input type="password" required value={accessCode} onChange={e => setAccessCode(e.target.value)} autoComplete="current-password"/></label>{error && <div className="error-banner" role="alert">{error}</div>}<button className="button primary" disabled={creating}><LockKeyhole size={16}/> Open workspace</button></form></div></div>;

  return <Shell>
    <header className="topbar"><div className="breadcrumb">Workspace <ChevronRight size={13}/><span>Projects</span></div></header>
    <div className={`page-content dashboard ${styles.intro}`}>
      <div className="page-heading"><h1>Projects</h1><button className="button secondary" onClick={() => setModal(true)}><Plus size={17}/> New project</button></div>
      {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError("")} aria-label="Dismiss error"><X size={16}/></button></div>}
      <section className="hero-card">
        <div className="hero-copy"><h2>Show the work.</h2><p>Open the camera. Tell Meta the goal.</p><div className="hero-actions"><Link className="button primary" href="/camera"><ScanLine size={18}/> Open camera <ArrowRight size={17}/></Link><button className="button secondary" onClick={() => setModal(true)}><Video size={17}/> Workshop video</button></div></div>
      </section>
      <section className={`workflow-strip ${styles.flow}`} id="workflow" aria-label="How CounterShot works">
        {[{icon:<ScanLine size={19}/>,title:"Show"},{icon:<Sparkles size={19}/>,title:"Understand"},{icon:<Check size={19}/>,title:"Try & check"}].map((s,i) => <div className="workflow-step" key={s.title}><span className="workflow-icon">{s.icon}</span><h3>{s.title}</h3>{i < 2 && <ArrowRight className="workflow-arrow" size={17}/>}</div>)}
      </section>
      <details className={styles.expectations}>
        <summary>What happens next?</summary>
        <h2>What happens after upload?</h2>
        <p>Camera: Meta reads the selected view. Confirm missing details, then follow one reviewed action at a time.</p>
        <p>Workshop: your clip is saved first. Choose <strong>Analyze the job</strong>, confirm measurements, then create and test a jig plan.</p>
      </details>
      <section className="projects-section"><div className="section-heading"><h2>Your projects <span className="count">{projects.length}</span></h2><button className="button text" disabled={creating} onClick={() => void create(true)}>{creating ? <LoaderCircle className="spin" size={16}/> : <Box size={17}/>} Explore a sample</button></div>
        {loading ? <div className="empty-state"><LoaderCircle size={24} className="spin"/><p>Opening workspace…</p></div> : projects.length ? <div className="project-grid">{[...projects].reverse().map(project => <Link className="project-card" href={`/projects/${project.id}/${project.currentDesignId ? "design" : "capture"}`} key={project.id}><div className="project-card-top"><span className="project-icon"><Box size={22}/></span><StatusPill tone={project.isDemo ? "sample" : project.currentDesignId ? "green" : "neutral"}>{project.isDemo ? "Synthetic sample" : project.currentDesignId ? "Design available" : "In progress"}</StatusPill><ArrowUpRight size={18}/></div><h3>{project.title}</h3><div className="project-card-footer"><span><Clock3 size={13}/> {new Date(project.updatedAt || project.createdAt).toLocaleDateString(undefined,{month:"short",day:"numeric"})}</span><span>Continue <ArrowRight size={14}/></span></div></Link>)}</div> : <p className="muted">Your saved work appears here.</p>}
      </section>
    </div>
    {modal && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setModal(false); }}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="new-project-heading"><button className="modal-close" onClick={() => setModal(false)} aria-label="Close new project"><X size={20}/></button><h2 id="new-project-heading">Start a workshop task.</h2><p>Custom workshop jig · low-force, pre-cut interlocking panels.</p><form onSubmit={e => { e.preventDefault(); void create(); }}><label>What are you trying to do?<textarea autoFocus required minLength={10} maxLength={3000} placeholder="Hold the enclosure walls while I join the next panel…" value={form.goal} onChange={e => setForm({...form,goal:e.target.value})}/></label><label>What does finished mean?<textarea required minLength={5} maxLength={2000} placeholder="Aligned, joined, released and ready to repeat." value={form.finishedDefinition} onChange={e => setForm({...form,finishedDefinition:e.target.value})}/></label>{error && <div className="error-banner" role="alert">{error}</div>}<button className="button primary full" disabled={creating}>{creating ? <LoaderCircle size={17} className="spin"/> : <Video size={17}/>} Create project</button></form></section></div>}
  </Shell>;
}
