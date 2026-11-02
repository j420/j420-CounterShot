"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  ClipboardCheck,
  Eye,
  FileVideo,
  Focus,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  Package,
  Plus,
  RefreshCw,
  ScanLine,
  Settings2,
  ShieldCheck,
  Sparkles,
  Upload,
  X,
  AlertCircle,
  Ruler,
  Circle,
  ExternalLink,
  Hand,
  PanelTop,
  SquareDashed,
} from "lucide-react";
import { api, errorMessage, post } from "@/lib/api-client";
import { effectiveSupportsAtStep } from "@/lib/support-view";
import type {
  DesignRevision,
  Health,
  Job,
  Phase,
  Project,
  ProjectSummary,
} from "@/lib/contracts";
import { ConfirmPanel } from "./confirm-panel";
import { TrialPanel } from "./trial-panel";

const stageInfo: {
  id: Phase;
  label: string;
  short: string;
  icon: typeof Eye;
  title: string;
  description: string;
}[] = [
  {
    id: "observe",
    label: "Observe the job",
    short: "Observe",
    icon: Eye,
    title: "Show us the whole job",
    description:
      "Capture the task as it happens, including the parts that get difficult.",
  },
  {
    id: "confirm",
    label: "Confirm the facts",
    short: "Confirm",
    icon: Settings2,
    title: "Start with what you know",
    description:
      "Your abilities, materials and measurements shape every part of the redesign.",
  },
  {
    id: "design",
    label: "Redesign together",
    short: "Design",
    icon: Layers3,
    title: "A coordinated way forward",
    description:
      "The package, workspace and action sequence are designed together.",
  },
  {
    id: "build",
    label: "Make the parts",
    short: "Build",
    icon: Ruler,
    title: "Take the design to your table",
    description:
      "Build this exact revision, check the scale and test the physical fit.",
  },
  {
    id: "test",
    label: "Try and improve",
    short: "Test",
    icon: ClipboardCheck,
    title: "The real world gets the final say",
    description:
      "Record a complete cycle, inspect what happened and improve from the evidence.",
  },
];

const projectPath = (id: string) => `/api/projects/${encodeURIComponent(id)}`;
const assetPath = (projectId: string, assetId: string) =>
  `${projectPath(projectId)}/assets/${encodeURIComponent(assetId)}`;

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand ${compact ? "compact" : ""}`}>
      <span className="brand-mark">
        <Focus size={24} strokeWidth={1.8} />
      </span>
      <span>
        Counter<span className="brand-light">Shot</span>
        <span className="brand-dot">.</span>
      </span>
    </div>
  );
}

function Blueprint() {
  return (
    <div
      className="blueprint"
      aria-label="Illustration of a package, exterior supports and a single-hand operating sequence"
    >
      <div className="blueprint-top">
        <span>
          <SquareDashed size={15} /> A COORDINATED REDESIGN
        </span>
        <span>01 / 03</span>
      </div>
      <svg
        viewBox="0 0 570 340"
        role="img"
        aria-label="A cardboard insert aligns with an exterior workspace support"
      >
        <defs>
          <pattern
            id="grid"
            width="24"
            height="24"
            patternUnits="userSpaceOnUse"
          >
            <path
              d="M 24 0 L 0 0 0 24"
              fill="none"
              stroke="currentColor"
              strokeWidth=".6"
              opacity=".13"
            />
          </pattern>
        </defs>
        <rect width="570" height="340" fill="url(#grid)" />
        <g stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
          <path d="M95 204 273 106 472 215 294 316Z" fill="#e8eef9" />
          <path d="m95 204 0-24 178-99 0 25Z" fill="#c8d9ef" />
          <path d="m273 106 0-25 199 109 0 25Z" fill="#d6e3f4" />
          <path d="m181 177 92-51 110 61-92 51Z" fill="#f4e6cf" />
          <path d="m181 177 0-55 110 61 0 55Z" fill="#e5cba0" />
          <path d="m291 238 92-51 0-55-92 51Z" fill="#d4b181" />
          <path d="m181 122 92-51 110 61-92 51Z" fill="#f7eddd" />
          <path d="m202 126 70-38 87 47-70 39Z" fill="#faf9f5" />
          <path d="m202 126 87 48 0 21-87-47Z" fill="#e8e6df" />
          <path d="m289 174 70-39 0 21-70 39Z" fill="#d3d2cd" />
          <path d="m143 219 43 24 0 37-43-24Z" fill="#bed2ee" />
          <path d="m186 243 21-11 0 37-21 11Z" fill="#9bb8df" />
          <path d="m334 274 66-36 0 24-66 37Z" fill="#b2cae9" />
          <path d="m95 204 199 112 178-101" fill="none" strokeDasharray="5 5" />
        </g>
        <g fill="none" stroke="#5773a2" strokeWidth="1.1">
          <path d="M360 115 415 74 487 74" />
          <path d="m162 245-53 23H53" />
          <path d="m300 188 84 36h90" />
        </g>
        <g fill="#45618a" fontSize="10" fontFamily="inherit">
          <text x="424" y="66">
            PACKAGE + INSERT
          </text>
          <text x="34" y="287">
            EXTERIOR SUPPORT
          </text>
          <text x="398" y="240">
            ROOM TO RELEASE
          </text>
        </g>
      </svg>
      <div className="blueprint-bottom">
        <span>
          <Package size={15} /> Package
        </span>
        <span>
          <PanelTop size={15} /> Workspace
        </span>
        <span>
          <Hand size={15} /> Sequence
        </span>
      </div>
      <p className="illustration-note">
        Concept illustration. Every generated design needs a physical trial.
      </p>
    </div>
  );
}

export function CounterShotApp() {
  const [health, setHealth] = useState<Health | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [phase, setPhase] = useState<Phase>("observe");
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [connection, setConnection] = useState(false);
  const [newJob, setNewJob] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [selectedDesign, setSelectedDesign] = useState<string | null>(null);
  const pollErrors = useRef(0);

  const refreshList = useCallback(async () => {
    const data = await api<{ projects: ProjectSummary[] }>("/api/projects");
    setProjects(data.projects);
  }, []);

  const openProject = useCallback(async (id: string, selectPhase = true) => {
    const data = await api<{ project: Project; jobs: Job[] }>(projectPath(id));
    setProject(data.project);
    setNewJob(false);
    setSidebar(false);
    localStorage.setItem("countershot-project", id);
    if (selectPhase)
      setPhase(
        data.project.currentDesignId
          ? "design"
          : data.project.currentSnapshotId
            ? "confirm"
            : "observe",
      );
    const running = data.jobs.find((j) =>
      ["queued", "running"].includes(j.status),
    );
    setJob(running ?? null);
    return data.project;
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const h = await api<Health>("/api/health");
        if (!mounted) return;
        setHealth(h);
        if (!h.authenticated) return;
        await refreshList();
        const id = localStorage.getItem("countershot-project");
        if (id)
          await openProject(id).catch(() =>
            localStorage.removeItem("countershot-project"),
          );
      } catch (e) {
        if (mounted) setError(errorMessage(e));
      }
    })();
    return () => {
      mounted = false;
    };
  }, [openProject, refreshList]);

  useEffect(() => {
    if (!job || !["queued", "running"].includes(job.status)) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const result = await api<{ job: Job }>(`/api/jobs/${job.id}`);
        if (cancelled) return;
        pollErrors.current = 0;
        setJob(result.job);
        if (["succeeded", "failed", "superseded"].includes(result.job.status)) {
          await openProject(result.job.projectId, false);
          await refreshList();
          if (result.job.status === "succeeded") {
            setNotice(
              result.job.kind === "observe"
                ? "Observation ready. Review what the camera could establish."
                : "Your redesign is ready to inspect. Physical testing comes next.",
            );
            if (result.job.kind !== "observe") {
              setPhase("design");
              setSelectedDesign(null);
            }
          } else
            setError(
              result.job.error ??
                "The input changed while this was running. Generate again from the current facts.",
            );
        }
      } catch (e) {
        if (!cancelled && ++pollErrors.current === 3)
          setError(
            `${errorMessage(e)} Your job is preserved; refresh to reconnect.`,
          );
      }
    }, 1800);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [job, openProject, refreshList]);

  const perform = async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const saveProject = (p: Project) => {
    setProject(p);
    void refreshList().catch(() => {});
  };
  const activeDesign =
    project?.designs.find(
      (d) => d.id === (selectedDesign ?? project.currentDesignId),
    ) ??
    project?.designs.at(-1) ??
    null;
  const snapshot =
    project?.snapshots.find((s) => s.id === project.currentSnapshotId) ?? null;
  const isRunning = !!job && ["queued", "running"].includes(job.status);
  const currentStage = stageInfo.find((s) => s.id === phase)!;

  const generate = async (sourceTrialId?: string) => {
    if (!project) return;
    await perform("design", async () => {
      const data = await post<{ job: Job }>(
        `${projectPath(project.id)}/designs`,
        {
          operationId: crypto.randomUUID(),
          expectedVersion: project.version,
          ...(sourceTrialId
            ? { sourceTrialId, parentDesignId: activeDesign?.id }
            : {}),
        },
      );
      setJob(data.job);
      setPhase("design");
    });
  };

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebar ? "is-open" : ""}`}>
        <button
          className="sidebar-close icon-button"
          onClick={() => setSidebar(false)}
          aria-label="Close navigation"
        >
          <X size={21} />
        </button>
        <Brand />
        <div className="workspace-label">YOUR WORKSPACE</div>
        <button className="project-switch" onClick={() => setNewJob(!newJob)}>
          <span className="project-icon">
            <Package size={18} />
          </span>
          <span>
            {project?.title ?? "New physical workflow"}
            <small>Tabletop packing</small>
          </span>
          <ChevronDown size={15} />
        </button>
        {!!projects.length && (
          <div className="project-list">
            {projects.slice(0, 4).map((p) => (
              <button
                key={p.id}
                className={project?.id === p.id ? "selected" : ""}
                onClick={() =>
                  void perform("open", async () => {
                    await openProject(p.id);
                  })
                }
              >
                <span className="project-list-dot" />
                {p.title}
              </button>
            ))}
          </div>
        )}
        <button
          className="new-project"
          onClick={() => {
            setNewJob(true);
            setSidebar(false);
          }}
        >
          <Plus size={16} /> New job
        </button>
        <div className="nav-label">THE WORKFLOW</div>
        <nav aria-label="Workflow">
          {stageInfo.map((s, index) => {
            const complete =
              project &&
              (index === 0
                ? !!project.observation
                : index === 1
                  ? !!project.currentSnapshotId
                  : index === 2
                    ? !!project.currentDesignId
                    : index === 3
                      ? project.trials.some((t) => t.buildConfirmed)
                      : project.trials.some(
                          (t) => t.outcome === "observed_complete",
                        ));
            return (
              <button
                key={s.id}
                className={`nav-item ${phase === s.id && project && !newJob ? "active" : ""}`}
                onClick={() => {
                  setPhase(s.id);
                  setNewJob(false);
                  setSidebar(false);
                }}
                disabled={!project}
              >
                <s.icon size={18} />
                <span>{s.label}</span>
                {complete ? (
                  <Check size={14} className="nav-check" />
                ) : (
                  <span className="nav-number">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <ShieldCheck size={18} />
            <p>
              Designed around your constraints.
              <br />
              Proven through your trials.
            </p>
          </div>
          <span className="provider-label">
            <span
              className={health?.configured ? "status-dot amber" : "status-dot"}
            />
            {connection
              ? "Meta connection verified"
              : health?.configured
                ? "Meta key configured"
                : "Meta setup required"}
          </span>
        </div>
      </aside>
      {sidebar && (
        <button
          className="sidebar-backdrop"
          onClick={() => setSidebar(false)}
          aria-label="Close navigation overlay"
        />
      )}

      <div className="main-shell">
        <header className="topbar">
          <button
            className="mobile-menu icon-button"
            onClick={() => setSidebar(!sidebar)}
            aria-label="Toggle navigation"
          >
            <Layers3 size={22} />
          </button>
          <div className="breadcrumb">
            <span>Workspace</span>
            <span>/</span>
            <strong>
              {project && !newJob ? project.title : "Start a job"}
            </strong>
          </div>
          <div className="top-actions">
            <span className="prototype-label">PHYSICAL WORKFLOW STUDIO</span>
            <button
              className="button connection-button"
              disabled={busy === "connection" || !health?.authenticated}
              onClick={() =>
                void perform("connection", async () => {
                  const r = await post<{ text: string; model: string }>(
                    "/api/meta/test",
                    {},
                  );
                  setConnection(true);
                  setNotice(`Meta responded successfully using ${r.model}.`);
                  setHealth(await api<Health>("/api/health"));
                })
              }
            >
              {busy === "connection" ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <Sparkles size={15} />
              )}
              <span>Check Meta connection</span>
            </button>
          </div>
        </header>

        <main>
          {error && (
            <div className="message error" role="alert">
              <AlertCircle size={18} />
              <span>{error}</span>
              <button
                className="icon-button"
                onClick={() => setError(null)}
                aria-label="Dismiss error"
              >
                <X size={16} />
              </button>
            </div>
          )}
          {notice && (
            <div className="message success" role="status">
              <CheckCircle2 size={18} />
              <span>{notice}</span>
              <button
                className="icon-button"
                onClick={() => setNotice(null)}
                aria-label="Dismiss message"
              >
                <X size={16} />
              </button>
            </div>
          )}

          {health && !health.authenticated ? (
            <AccessPanel
              onUnlock={async (code) => {
                await post("/api/session", { accessCode: code });
                setHealth(await api<Health>("/api/health"));
                await refreshList();
              }}
              onError={setError}
            />
          ) : !health ? (
            <div className="initial-loading">
              <LoaderCircle className="spin" />
              <p>Opening your workspace…</p>
            </div>
          ) : !project || newJob ? (
            <Welcome
              busy={!!busy}
              onCreate={(title, goal) =>
                void perform("create", async () => {
                  const { project: p } = await post<{ project: Project }>(
                    "/api/projects",
                    { title, goal },
                  );
                  setProject(p);
                  setJob(null);
                  setNewJob(false);
                  setPhase("observe");
                  localStorage.setItem("countershot-project", p.id);
                  await refreshList();
                })
              }
            />
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">
                    STEP {stageInfo.findIndex((s) => s.id === phase) + 1} OF 5{" "}
                    <span /> {currentStage.short.toUpperCase()}
                  </span>
                  <h1>{currentStage.title}</h1>
                  <p>{currentStage.description}</p>
                </div>
                <span className="job-badge">
                  <Package size={15} />{" "}
                  {snapshot?.constraints.packageFamily === "tuck_carton"
                    ? "Tuck carton"
                    : "Tabletop packing"}
                </span>
              </div>
              <div className="progress-track" aria-label="Workflow progress">
                {stageInfo.map((s, i) => (
                  <button
                    key={s.id}
                    className={`${phase === s.id ? "current" : ""} ${stageInfo.findIndex((x) => x.id === phase) > i ? "past" : ""}`}
                    onClick={() => setPhase(s.id)}
                  >
                    <span>{i + 1}</span>
                    {s.short}
                    {i < 4 && <span className="track-line" />}
                  </button>
                ))}
              </div>
              {isRunning && (
                <div className="job-progress" role="status" aria-live="polite">
                  <div className="job-progress-icon">
                    <LoaderCircle className="spin" size={21} />
                  </div>
                  <div>
                    <strong>
                      {job.kind === "observe"
                        ? "Looking closely at the job"
                        : "Working through the redesign"}
                    </strong>
                    <p>
                      {job.stage.replaceAll("_", " ")}. You can keep this page
                      open while Meta works.
                    </p>
                  </div>
                  <span className="quiet-label">IN PROGRESS</span>
                </div>
              )}
              <div
                className={`work-layout ${phase === "design" || phase === "build" || phase === "test" ? "full-work" : ""}`}
              >
                <section className="work-main">
                  {phase === "observe" && (
                    <ObservePanel
                      project={project}
                      busy={busy}
                      running={isRunning}
                      onUpload={(file) =>
                        void perform("upload", async () => {
                          const form = new FormData();
                          form.set("file", file);
                          form.set("role", "job");
                          const data = await api<{ project: Project }>(
                            `${projectPath(project.id)}/assets`,
                            { method: "POST", body: form },
                          );
                          saveProject(data.project);
                        })
                      }
                      onAnalyze={(assetId) =>
                        void perform("observe", async () => {
                          const result = await post<{ job: Job }>(
                            `${projectPath(project.id)}/observe`,
                            {
                              assetId,
                              operationId: crypto.randomUUID(),
                              expectedVersion: project.version,
                            },
                          );
                          setJob(result.job);
                        })
                      }
                      onContinue={() => setPhase("confirm")}
                    />
                  )}
                  {phase === "confirm" && (
                    <ConfirmPanel
                      key={`${project.id}-${project.currentSnapshotId ?? "new"}`}
                      project={project}
                      busy={busy === "confirm"}
                      onSave={(constraints) =>
                        void perform("confirm", async () => {
                          const result = await post<{ project: Project }>(
                            `${projectPath(project.id)}/confirm`,
                            { constraints, expectedVersion: project.version },
                          );
                          saveProject(result.project);
                          setPhase("design");
                          setNotice("Confirmed facts saved as a new snapshot.");
                        })
                      }
                    />
                  )}
                  {phase === "design" && (
                    <DesignPanel
                      key={activeDesign?.id ?? "new"}
                      project={project}
                      design={activeDesign}
                      generating={isRunning || busy === "design"}
                      onGenerate={() => void generate()}
                      onBuild={() => setPhase("build")}
                      onSelect={setSelectedDesign}
                      onConfirm={() => setPhase("confirm")}
                    />
                  )}
                  {phase === "build" && (
                    <BuildPanel
                      project={project}
                      design={activeDesign}
                      onTest={() => setPhase("test")}
                      onDesign={() => setPhase("design")}
                    />
                  )}
                  {phase === "test" && (
                    <TrialPanel
                      key={activeDesign?.id ?? "new"}
                      project={project}
                      design={activeDesign}
                      busy={busy}
                      running={isRunning}
                      onSave={async (trial) => {
                        let saved = false;
                        await perform("trial", async () => {
                          const result = await post<{ project: Project }>(
                            `${projectPath(project.id)}/trials`,
                            { trial, expectedVersion: project.version },
                          );
                          saveProject(result.project);
                          setNotice(
                            "Trial recorded against its exact design revision.",
                          );
                          saved = true;
                        });
                        return saved;
                      }}
                      onUpload={(file) =>
                        perform("trial-upload", async () => {
                          const form = new FormData();
                          form.set("file", file);
                          form.set("role", "trial");
                          const result = await api<{ project: Project }>(
                            `${projectPath(project.id)}/assets`,
                            { method: "POST", body: form },
                          );
                          saveProject(result.project);
                        })
                      }
                      onRevise={(trialId) => void generate(trialId)}
                    />
                  )}
                </section>
                {(phase === "observe" || phase === "confirm") && (
                  <aside className="context-column">
                    <div className="context-card">
                      <span className="eyebrow">THE JOB BRIEF</span>
                      <h3>{project.title}</h3>
                      <p>{project.goal}</p>
                      <div className="thin-divider" />
                      <div className="context-meta">
                        <Package size={17} />
                        <span>
                          {
                            project.assets.filter((a) => a.role === "job")
                              .length
                          }{" "}
                          source files
                        </span>
                      </div>
                      <div className="context-meta">
                        <Layers3 size={17} />
                        <span>{project.designs.length} design revisions</span>
                      </div>
                      <div className="context-meta">
                        <ClipboardCheck size={17} />
                        <span>{project.trials.length} recorded trials</span>
                      </div>
                    </div>
                    <div className="tip-card">
                      <CircleHelp size={20} />
                      <h4>
                        {phase === "observe"
                          ? "Include the beginning and end"
                          : "A measurement is worth a guess"}
                      </h4>
                      <p>
                        {phase === "observe"
                          ? "Show taking a fresh package and resetting for the next one. Hidden setup can hide the hardest part."
                          : "Use a ruler for dimensions and tell us how you can comfortably work. The camera supplies observations."}
                      </p>
                    </div>
                  </aside>
                )}
              </div>
            </>
          )}
          <footer className="page-footer">
            <span>
              CounterShot <span>·</span> Make the job fit the person.
            </span>
            <span>
              <Sparkles size={13} /> Built with Meta AI
            </span>
          </footer>
        </main>
      </div>
    </div>
  );
}

function Welcome({
  busy,
  onCreate,
}: {
  busy: boolean;
  onCreate: (title: string, goal: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  return (
    <div className="welcome">
      <div className="welcome-heading">
        <span className="eyebrow">
          <span className="tiny-spark" /> PHYSICAL WORK, REIMAGINED
        </span>
        <h1>
          Make the job fit
          <br />
          the <span>person.</span>
        </h1>
        <p>
          Show us a physical task. Tell us how you can work.
          <br className="desktop-break" /> Redesign the package, workspace and
          steps together.
        </p>
      </div>
      <div className="welcome-grid">
        <div>
          <form
            className="create-card"
            onSubmit={(e) => {
              e.preventDefault();
              onCreate(title.trim(), goal.trim());
            }}
          >
            <div className="card-heading">
              <div className="soft-icon">
                <Package size={21} />
              </div>
              <div>
                <h2>Start with a real job</h2>
                <p>One task. Your materials. Your constraints.</p>
              </div>
            </div>
            <label className="field-label" htmlFor="job-title">
              Give the job a name
            </label>
            <input
              id="job-title"
              value={title}
              maxLength={100}
              required
              minLength={2}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Packing notebook orders"
            />
            <label className="field-label" htmlFor="job-goal">
              What needs to be completed?
            </label>
            <textarea
              id="job-goal"
              value={goal}
              maxLength={2000}
              required
              minLength={10}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="Pack a notebook and card, close the parcel and reset for the next order using my right hand."
              rows={4}
            />
            <button
              className="button primary wide"
              disabled={busy}
              type="submit"
            >
              {busy ? (
                <LoaderCircle size={17} className="spin" />
              ) : (
                <>
                  Create my workflow <ArrowRight size={17} />
                </>
              )}
            </button>
            <p className="form-note">
              <LockKeyhole size={13} /> Your footage and key stay out of the Git
              repository.
            </p>
          </form>
          <div className="scope-note">
            <span>STARTING DOMAIN</span>
            <p>
              Tabletop packing with passive cardboard supports. Each design
              needs a real-world trial.
            </p>
          </div>
        </div>
        <div className="welcome-visual">
          <Blueprint />
          <div className="workflow-preview">
            <div>
              <span>01</span>
              <h4>See the conflict</h4>
              <p>Find what needs holding.</p>
            </div>
            <ArrowRight size={16} />
            <div>
              <span>02</span>
              <h4>Change the method</h4>
              <p>Coordinate parts and steps.</p>
            </div>
            <ArrowRight size={16} />
            <div>
              <span>03</span>
              <h4>Prove it physically</h4>
              <p>Build, try and improve.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function AccessPanel({
  onUnlock,
  onError,
}: {
  onUnlock: (code: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="access-wrap">
      <form
        className="create-card access-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await onUnlock(code);
          } catch (err) {
            onError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="soft-icon">
          <LockKeyhole />
        </div>
        <h1>Open your workspace</h1>
        <p>Enter the access code supplied by the workspace owner.</p>
        <label className="field-label" htmlFor="access-code">
          Access code
        </label>
        <input
          id="access-code"
          type="password"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="current-password"
          required
        />
        <button className="button primary wide" disabled={busy}>
          {busy ? (
            <LoaderCircle className="spin" size={16} />
          ) : (
            "Open workspace"
          )}
        </button>
      </form>
    </div>
  );
}

function ObservePanel({
  project,
  busy,
  running,
  onUpload,
  onAnalyze,
  onContinue,
}: {
  project: Project;
  busy: string | null;
  running: boolean;
  onUpload: (file: File) => void;
  onAnalyze: (assetId: string) => void;
  onContinue: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const assets = project.assets.filter((a) => a.role === "job");
  const asset = assets.find((a) => a.id === selected) ?? assets.at(-1);
  const observation = project.observation;
  const observationSource = assets.find(
    (a) => a.id === project.observationAssetId,
  );
  const differentSource =
    !!observation && !!asset && asset.id !== project.observationAssetId;
  return (
    <>
      <div className="panel">
        <div className="panel-title">
          <div>
            <h2>The original job</h2>
            <p>A short MP4 or a clear photograph of the task.</p>
          </div>
          <span className="subtle-badge">MP4 · JPG · PNG</span>
        </div>
        <input
          ref={input}
          type="file"
          accept="image/jpeg,image/png,video/mp4"
          className="sr-only"
          aria-label="Upload a job video or photograph"
          onChange={(e) => {
            if (e.target.files?.[0]) {
              onUpload(e.target.files[0]);
              e.target.value = "";
            }
          }}
        />
        {asset ? (
          <div className="media-area">
            {asset.kind === "video" ? (
              <video
                key={asset.id}
                src={assetPath(project.id, asset.id)}
                controls
                preload="metadata"
              />
            ) : (
              <div
                className="uploaded-image"
                style={{
                  backgroundImage: `url("${assetPath(project.id, asset.id)}")`,
                }}
                role="img"
                aria-label={asset.filename}
              />
            )}
            <div className="media-caption">
              <span>
                {asset.kind === "video" ? (
                  <FileVideo size={16} />
                ) : (
                  <ScanLine size={16} />
                )}{" "}
                {asset.filename}
              </span>
              <button
                className="text-button"
                onClick={() => input.current?.click()}
                disabled={!!busy}
              >
                Add another
              </button>
            </div>
          </div>
        ) : (
          <button
            className="upload-zone"
            onClick={() => input.current?.click()}
            disabled={!!busy}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (!busy && e.dataTransfer.files[0])
                onUpload(e.dataTransfer.files[0]);
            }}
          >
            <span className="upload-icon">
              {busy === "upload" ? (
                <LoaderCircle className="spin" size={27} />
              ) : (
                <Upload size={27} />
              )}
            </span>
            <strong>
              {busy === "upload"
                ? "Saving your source…"
                : "Drop your job footage here"}
            </strong>
            <span>or choose a file from your device</span>
            <small>Use a short MP4, JPEG or PNG. Maximum 50 MB.</small>
          </button>
        )}
        {assets.length > 1 && (
          <div className="asset-tabs">
            {assets.map((a) => (
              <button
                key={a.id}
                className={asset?.id === a.id ? "active" : ""}
                onClick={() => setSelected(a.id)}
              >
                {a.filename}
              </button>
            ))}
          </div>
        )}
        <div className="panel-bottom">
          <span>
            <Eye size={15} /> Observations stay open to correction.
          </span>
          <button
            className="button primary"
            disabled={!asset || !!busy || running}
            onClick={() => asset && onAnalyze(asset.id)}
          >
            <Sparkles size={16} />
            {running ? "Observing…" : "Observe with Meta"}
          </button>
        </div>
      </div>
      {observation && (
        <div className="panel observation-panel">
          <div className="panel-title">
            <div>
              <span className="eyebrow">
                SOURCE: {observationSource?.filename ?? "Earlier job media"}
              </span>
              <h2>What the job appears to require</h2>
            </div>
            <span className="subtle-badge">AI observation</span>
          </div>
          {differentSource && (
            <div className="message warning">
              <AlertCircle size={16} />
              <span>
                This observation belongs to{" "}
                {observationSource?.filename ?? "an earlier file"}. Observe the
                selected source or select the original file before confirming.
              </span>
            </div>
          )}
          <p className="observation-summary">{observation.summary}</p>
          <div className="observed-steps">
            {observation.actions.map((action, i) => (
              <div className="observed-step" key={action.id}>
                <span className="step-circle">{i + 1}</span>
                <div>
                  <h4>{action.label}</h4>
                  <p>{action.holdingRequirement}</p>
                  <small>{action.evidence}</small>
                </div>
              </div>
            ))}
          </div>
          {!!observation.conflicts.length && (
            <div className="conflict-area">
              <h3>
                <Hand size={18} /> Where support may be missing
              </h3>
              {observation.conflicts.map((c, i) => (
                <p key={i}>{c.description}</p>
              ))}
            </div>
          )}
          <div className="coverage-row">
            {Object.entries(observation.cycleCoverage).map(([name, seen]) => (
              <span key={name} className={seen ? "seen" : "unseen"}>
                {seen ? <CheckCircle2 size={14} /> : <Circle size={14} />}{" "}
                {name}
              </span>
            ))}
          </div>
          <p className="form-note">
            Missing stages need a further clip or your description. These
            observations do not establish ability or physical feasibility.
          </p>
          <div className="panel-bottom">
            <span>{observation.objects.length} objects identified</span>
            <button
              className="button primary"
              disabled={differentSource}
              onClick={onContinue}
            >
              Confirm the facts <ArrowRight size={16} />
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function DesignPanel({
  project,
  design,
  generating,
  onGenerate,
  onBuild,
  onSelect,
  onConfirm,
}: {
  project: Project;
  design: DesignRevision | null;
  generating: boolean;
  onGenerate: () => void;
  onBuild: () => void;
  onSelect: (id: string) => void;
  onConfirm: () => void;
}) {
  const [tab, setTab] = useState("workspace");
  const [step, setStep] = useState(0);
  const stale = design && design.inputSnapshotId !== project.currentSnapshotId;
  if (!design)
    return (
      <div className="design-empty">
        <div className="empty-orbit">
          <Layers3 size={38} />
        </div>
        <span className="eyebrow">PACKAGE + WORKSPACE + SEQUENCE</span>
        <h2>One job. A coordinated redesign.</h2>
        <p>
          Meta will work from your observations and confirmed measurements, then
          the drawing engine will check the declared geometry and support plan.
        </p>
        <div className="three-outcomes">
          <span>
            <Package />
            Package or insert
          </span>
          <Plus size={16} />
          <span>
            <PanelTop />
            Workspace supports
          </span>
          <Plus size={16} />
          <span>
            <Hand />
            Operating steps
          </span>
        </div>
        {project.currentSnapshotId ? (
          <button
            className="button primary large"
            disabled={generating}
            onClick={onGenerate}
          >
            {generating ? (
              <LoaderCircle className="spin" size={18} />
            ) : (
              <Sparkles size={18} />
            )}
            Generate coordinated redesign
          </button>
        ) : (
          <button className="button primary large" onClick={onConfirm}>
            Confirm measurements first <ArrowRight size={17} />
          </button>
        )}
        <p className="form-note">
          A generated plan must be built and tried before its physical
          performance is known.
        </p>
      </div>
    );
  const drawings = design.compiled.drawings;
  const drawing = drawings.find((d) =>
    tab === "workspace"
      ? d.id === "S01"
      : tab === "package"
        ? d.id === "P01" || d.id === "P00"
        : d.id === "I01",
  );
  const action =
    design.proposal.steps[Math.min(step, design.proposal.steps.length - 1)];
  const effectiveSupports = effectiveSupportsAtStep(
    design.proposal.steps,
    Math.min(step, design.proposal.steps.length - 1),
  );
  return (
    <>
      <div className="design-toolbar">
        <div className="revision-select">
          <Layers3 size={16} />
          <label className="sr-only" htmlFor="revision-select">
            Design revision
          </label>
          <select
            id="revision-select"
            value={design.id}
            onChange={(e) => onSelect(e.target.value)}
          >
            {project.designs.map((d) => (
              <option key={d.id} value={d.id}>
                Revision {d.number} · {d.proposal.title}
              </option>
            ))}
          </select>
        </div>
        <span
          className={`check-badge ${design.compiled.report.valid ? "" : "has-errors"}`}
        >
          <ShieldCheck size={15} />
          {design.compiled.report.valid
            ? "Geometry checks passed"
            : "Checks need attention"}
        </span>
        <span className="trial-required">
          <Circle size={11} /> Physical trial required
        </span>
      </div>
      {stale && (
        <div className="message warning">
          <AlertCircle size={17} />
          <span>
            These drawings use an earlier input snapshot. Generate a revision
            from your current confirmed facts.
          </span>
          <button
            className="text-button"
            disabled={generating}
            onClick={onGenerate}
          >
            Generate revision
          </button>
        </div>
      )}
      <div className="design-overview">
        <div className="panel drawing-panel">
          <div
            className="drawing-tabs"
            role="tablist"
            aria-label="Drawing view"
          >
            {["workspace", "package", "insert"].map((t) => (
              <button
                key={t}
                className={tab === t ? "active" : ""}
                onClick={() => setTab(t)}
                role="tab"
                aria-selected={tab === t}
              >
                {t === "workspace" ? (
                  <PanelTop size={16} />
                ) : t === "package" ? (
                  <Package size={16} />
                ) : (
                  <SquareDashed size={16} />
                )}{" "}
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
          <div className="drawing-grid">
            {drawing ? (
              <div
                className="generated-drawing"
                dangerouslySetInnerHTML={{ __html: drawing.svg }}
              />
            ) : (
              <div className="drawing-empty">
                <Package size={28} />
                <p>This revision uses no insert.</p>
                <small>
                  Its package and workspace are shown in the other views.
                </small>
              </div>
            )}
          </div>
          <div className="drawing-caption">
            <span>
              <Ruler size={14} />{" "}
              {drawing
                ? `${drawing.widthMm} × ${drawing.heightMm} mm`
                : "No part specified"}
            </span>
            <span>REV {design.number} · DIMENSIONED PLAN</span>
          </div>
        </div>
        <div className="design-explanation">
          <span className="eyebrow">THE PROPOSED METHOD</span>
          <h2>{design.proposal.title}</h2>
          <p>{design.proposal.summary}</p>
          <div className="conflict-mini">
            <Hand size={18} />
            <div>
              <strong>The coordination problem</strong>
              <p>{design.proposal.originalConflict}</p>
            </div>
          </div>
          <div className="change-list">
            {design.proposal.changes.map((change, i) => (
              <div key={i}>
                <span className={`layer-icon ${change.layer}`}>
                  {change.layer === "package" ? (
                    <Package size={17} />
                  ) : change.layer === "workspace" ? (
                    <PanelTop size={17} />
                  ) : (
                    <Hand size={17} />
                  )}
                </span>
                <div>
                  <span className="tiny-label">{change.layer}</span>
                  <h4>{change.change}</h4>
                  <p>{change.reason}</p>
                </div>
              </div>
            ))}
          </div>
          <p className="alternative-note">
            <strong>Simpler option considered</strong>
            {design.proposal.simplerAlternative}
          </p>
        </div>
      </div>
      <div className="support-panel panel">
        <div className="panel-title">
          <div>
            <span className="eyebrow">OPERATING SEQUENCE</span>
            <h2>What holds this now?</h2>
          </div>
          <span className="subtle-badge">
            Step {step + 1} / {design.proposal.steps.length}
          </span>
        </div>
        <div className="sequence-selector">
          {design.proposal.steps.map((a, i) => (
            <button
              key={a.id}
              className={step === i ? "active" : ""}
              onClick={() => setStep(i)}
            >
              <span>{i + 1}</span>
              {a.label}
            </button>
          ))}
        </div>
        <div className="active-step">
          <div>
            <h3>{action.label}</h3>
            <p>{action.instruction}</p>
            <span className="hand-badge">
              <Hand size={14} />{" "}
              {action.activeHand === "none"
                ? "No active hand required"
                : `${action.activeHand} hand`}
            </span>
          </div>
          <div className="support-assignments">
            {effectiveSupports.map((s, i) => (
              <span key={i}>
                <span className="support-dot" />
                <strong>{s.objectId.replaceAll("_", " ")}</strong>
                <ArrowRight size={13} />
                {s.provider.replaceAll("_", " ")}
                <small>{s.role.replaceAll("_", " ")}</small>
              </span>
            ))}
            {!effectiveSupports.length && (
              <p>
                No continuous support is declared at this step. Check this
                during the trial.
              </p>
            )}
          </div>
        </div>
      </div>
      <Checks issues={design.compiled.report.issues} />
      <div className="bottom-actions">
        <button className="button" disabled={generating} onClick={onGenerate}>
          <RefreshCw size={16} /> Generate another candidate
        </button>
        <button
          className="button primary"
          disabled={!design.compiled.report.valid || !!stale}
          onClick={onBuild}
        >
          Make this revision <ArrowRight size={17} />
        </button>
      </div>
    </>
  );
}

function Checks({
  issues,
}: {
  issues: DesignRevision["compiled"]["report"]["issues"];
}) {
  const checks = issues.filter((issue) => issue.severity !== "trial_required");
  const physical = issues.filter(
    (issue) => issue.severity === "trial_required",
  );
  return (
    <>
      <div className="checks-list">
        {checks.map((issue, i) => (
          <div className={issue.severity} key={`${issue.rule}-${i}`}>
            <AlertCircle size={16} />
            <span>{issue.message}</span>
            <small>
              {issue.severity === "error" ? "REQUIRES CORRECTION" : "CHECK"}
            </small>
          </div>
        ))}
      </div>
      {!!physical.length && (
        <details className="physical-check-details">
          <summary>
            <ShieldCheck size={17} />
            <span>
              {physical.length} physical assumptions to inspect and test
            </span>
            <ChevronDown size={16} />
          </summary>
          <div className="checks-list">
            {physical.map((issue, i) => (
              <div className="trial_required" key={`${issue.rule}-${i}`}>
                <AlertCircle size={15} />
                <span>{issue.message}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </>
  );
}

function BuildPanel({
  project,
  design,
  onTest,
  onDesign,
}: {
  project: Project;
  design: DesignRevision | null;
  onTest: () => void;
  onDesign: () => void;
}) {
  if (!design)
    return (
      <EmptyState
        icon={Ruler}
        title="Choose a design first"
        description="The construction pack is generated from a specific design revision."
        action="Go to design"
        onAction={onDesign}
      />
    );
  const stale = design.inputSnapshotId !== project.currentSnapshotId;
  const exportUrl = `${projectPath(project.id)}/designs/${design.id}/export?format=print`;
  const downloadSvg = (
    drawing: DesignRevision["compiled"]["drawings"][number],
  ) => {
    const url = URL.createObjectURL(
      new Blob([drawing.svg], { type: "image/svg+xml" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `countershot-r${design.number}-${drawing.id}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <>
      <div className="build-heading panel">
        <div className="soft-icon">
          <Ruler size={26} />
        </div>
        <div>
          <span className="eyebrow">
            CONSTRUCTION PACK · REVISION {design.number}
          </span>
          <h2>Everything should fit the same plan</h2>
          <p>
            Check the scale and material before making the parts. Software
            checks do not establish physical strength or usability.
          </p>
        </div>
        <a
          className={`button primary ${stale || !design.compiled.report.valid ? "disabled-link" : ""}`}
          href={exportUrl}
          target="_blank"
          rel="noreferrer"
        >
          <ExternalLink size={16} /> Open print pack
        </a>
      </div>
      {stale && (
        <div className="message warning">
          <AlertCircle size={17} />
          This revision uses earlier facts. Return to Design to generate a
          current pack.
        </div>
      )}
      <div className="build-grid">
        <div className="panel">
          <div className="panel-title">
            <div>
              <h2>Dimensioned parts</h2>
              <p>SVG drawings retain their physical dimensions.</p>
            </div>
          </div>
          <div className="drawing-downloads">
            {design.compiled.drawings.map((d) => (
              <div key={d.id}>
                <span className="file-icon">
                  <SquareDashed size={22} />
                </span>
                <div>
                  <strong>{d.title}</strong>
                  <p>
                    {d.widthMm} × {d.heightMm} mm · {d.purpose}
                  </p>
                </div>
                <button
                  className="icon-button download-button"
                  onClick={() => downloadSvg(d)}
                  aria-label={`Download ${d.title}`}
                >
                  <ArrowDownToLine size={19} />
                </button>
              </div>
            ))}
          </div>
          <div className="print-note">
            <Ruler size={18} />
            <div>
              <strong>Measure the 50 mm check square</strong>
              <p>
                Print at actual size. Large parts need a ruler-marking or tiled
                route; do not shrink them to fit.
              </p>
            </div>
          </div>
        </div>
        <div className="panel materials-panel">
          <div className="panel-title">
            <h2>Materials and cut list</h2>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Part</th>
                  <th>Qty</th>
                  <th>Flat size</th>
                </tr>
              </thead>
              <tbody>
                {design.compiled.cutList.map((p, i) => (
                  <tr key={i}>
                    <td>
                      {p.part}
                      <small>{p.material}</small>
                    </td>
                    <td>{p.quantity}</td>
                    <td>
                      {p.widthMm} × {p.heightMm} mm
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div className="panel">
        <div className="panel-title">
          <h2>Assembly order</h2>
          <span className="subtle-badge">Maker preparation</span>
        </div>
        <ol className="assembly-list">
          {design.compiled.assembly.map((s, i) => (
            <li key={i}>
              <span>{i + 1}</span>
              <p>{s}</p>
            </li>
          ))}
        </ol>
      </div>
      <div className="physical-warning">
        <ShieldCheck size={22} />
        <div>
          <h3>Check the whole physical cycle</h3>
          <p>
            Place a fresh blank, exercise every fold, complete closure, remove
            the finished parcel and reset. Record any changes you make to the
            drawings.
          </p>
        </div>
      </div>
      <div className="bottom-actions">
        <button className="button" onClick={onDesign}>
          <ArrowLeft size={16} /> Review design
        </button>
        <button
          className="button primary"
          onClick={onTest}
          disabled={!!stale || !design.compiled.report.valid}
        >
          Record a physical trial <ArrowRight size={16} />
        </button>
      </div>
    </>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  onAction,
}: {
  icon: typeof Eye;
  title: string;
  description: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="empty-state panel">
      <div className="soft-icon">
        <Icon size={28} />
      </div>
      <h2>{title}</h2>
      <p>{description}</p>
      {action && (
        <button className="button primary" onClick={onAction}>
          {action}
          <ArrowRight size={16} />
        </button>
      )}
    </div>
  );
}
