# CounterShot — a camera workbench for physical problems

**See the state. Make one concrete move. Check what changed.** CounterShot uses a phone camera to work through branching routes, irregular-piece reconstruction, hidden-side threading, compliant seating and gravity-flow problems. Meta assesses requested frames, identifies a grounded next action, and states the visible result and stop condition. Before/after evidence, actual measurements and an operator review control progress.

Five iterations add distinct physical reasoning problems:

| Iteration | Camera workflow | Consequential reasoning |
| --- | --- | --- |
| 1 | Disconnected sensor-harness routing | Branch-to-port graph, reversible rerouting, measured bend/service-loop constraints. |
| 2 | Dry-fit fragment reconstruction | Labelled adjacency/orientation hypotheses, whole-pattern contradictions and reversible support. |
| 3 | Instrument-pouch webbing threading | Exact entry/exit and marked-face sequence, hidden rear paths and local unthread/rethread recovery. |
| 4 | Dry gasket seating | Quadrant deformation, a buckle that displaces an earlier section, measured standing-proud limit. |
| 5 | Gravity-fed water manifold | Labelled connections, observed progression, head changes and actual timed collection. |

These are implemented exploration profiles, not claims of new-to-world invention or demonstrated physical success. See the [five-iteration build/evaluation record](docs/camera-iterations.md) and [independent credibility review](docs/camera-credibility-review.md).

The earlier **custom-jig design companion** remains available: passive supports and an explicit sequence for low-force assembly of supplied pre-cut enclosure panels, with exact construction drawings and build/trial records.

This is a working software prototype for the Meta Global AI Developer Hackathon. Physical admission and comparative advantage remain to be established. The [jig build brief](docs/workshop-build-brief.md) applies to that separate construction profile.

## Run

Prerequisites: **Node 24**, npm, **ffmpeg and ffprobe**. Upload validation decodes visual frames rather than trusting media headers. Use the existing checkout; cloud tasks do not need a separate Git worktree.

```sh
npm ci
# Optional outside the managed environment:
cp .env.example .env.local
# Add MODEL_API_KEY securely to .env.local or the host's secret settings.
npm run dev
```

`npm run dev` starts Next.js and the durable worker. Open the port printed by Next.js. The managed environment supplies the Meta key, HTTPS proxy and CA trust; do not copy its credential into a file. The labelled sample, geometry and evidence records work without a provider key. AI jobs need it.

For a persistent production Node host:

```sh
npm ci
npm run build
npm run start
```

The web server and worker share persistent `DATA_ROOT` (default `./data`). Both processes are required. `npm run dev:web` starts only the web application; `npm run worker` processes queued jobs. Live processes must restart in a new cloud task. No environment publication or external deployment is performed by these commands.

## Use from a phone

The [simplified phone and desktop interface](docs/ui-simplification.md) keeps the flow diagrams and explains what follows a photo or video upload. Longer instructions, advanced options and history are expandable. Workshop uploads save first; **Analyze the job** explicitly requests the analysis.

Open `/camera` from the home page in Safari or Chrome over HTTPS. Choose a workflow, confirm the real target/resources and open the rear-camera preview. Leave genuinely unknown measurements blank. The preview stays local; an explicit inspection sends the selected snapshot and labelled comparison when available. Meta returns one evidence request, action proposal, operator-review request, checked plan-change proposal or hold. A saved request can be answered with its explicitly linked photo or confirmed reading. Saving a reading starts no inference and never counts as passing a result check.

Action proposals carry an expected result and stop condition on the frozen assessed image. Comparisons name the exact active prediction; the original root remains immutable when a correction creates a child prediction. A person can save actual recheck readings before a fresh comparison, then confirm the required phase checks. Failed or incomplete reports remain historical, and a new model hypothesis cannot erase a person's failed reading. Physical identities and plan changes need explicit operator acceptance. Mandatory phase checks cannot be removed or skipped. Within-phase substeps are scoped guidance, not an independently verified executable sequence.

When needed, Meta may retrieve one owned historical frame or crop, then finalize the decision. Ordinary inspections use one model request; a retrieval uses at most two, within the same visible run allowance. Captures, tools, uploads and continuations share bounded budgets and deadlines; facts resets do not refill them. Changed setup, ambiguous identities, stale evidence and exhausted allowance hold progress. Older decision contracts remain readable and require explicit reset before current progression. See [the implementation and validation record](docs/meta-flow-implementation.md).

An explicit **Watch this step** option sends at most three sequential after-view checks, with a visible budget and stop control. It never confirms a step automatically. This is camera-led turn-taking, not a continuously streamed model feed, precision AR or a guaranteed realtime controller. Static JPEG/PNG stills are a fallback; animated PNG is rejected. An assessed image that cannot load pauses actionable guidance. Uploaded stills’ actual capture time remains unknown.

The jig companion additionally supports **Record video**, **Take photo** and existing-file uploads for original-task and complete-trial evidence. See the [phone workflow and current access limits](docs/phone-access.md). The same phone browser owns its sessions; account/device handoff is not implemented.

Vercel is the public frontend host. The user's Render backend is deployed at `https://countershot-api.onrender.com`; the Vercel frontend is being configured. The root [vercel.json](vercel.json) supplies that public backend URL to Vercel's build and runtime. SQLite, media, ffmpeg, the worker and credentials stay on the persistent backend. See the [Vercel deployment guide](docs/vercel-deployment.md).

The selected setup is Vercel plus one persistent backend. API routing and short-lived direct media uploads are implemented so large phone recordings bypass the frontend's upload limit. Local HTTPS/container tests passed; production host configuration and a real-phone check remain.

Render is the selected persistent backend. The root [Render Blueprint](render.yaml) creates one Docker service with a disk and manual deploys; see [the Render/Vercel setup guide](docs/render-deployment.md). Once Vercel's stable production address is known, configure both trusted origins on Render together. Production secrets belong only on Render.

## The jig-design companion

1. Create a jig project and define the operation and finished condition.
2. Record/select consented original phone footage and JPEG/PNG checkpoints. Workshop application limits are initially 180 seconds and 50 MiB per clip; `MAX_CLIP_SECONDS` can change duration policy. Actual long-video provider performance still needs testing.
3. Inspect Meta-inferred parts, actions, holding conflicts and missing evidence. Include initial loose-part loading, joining, output release and reset.
4. Confirm the supplied workpiece envelope, panel thickness, joining travel, measured access windows on all four edges, fixture material/fit/fold calibration, workspace/reach, available actions, alignment criterion and completed-joint retention. Missing critical measurements remain missing.
5. Generate a coordinated jig and assembly sequence. The planner composes a base, split exterior locating/bracing strips and a removable front gate with explicit top-edge reliefs. Local checks reject blocked joint windows, occupied-hand conflicts, lost support duties, unsafe gate sequencing, material inconsistencies and blocked declared release/reset.
6. Download **jig parts**, **assembly setup**, and the print/construction pack. Verify the **50 mm square** on an actual-size print. Oversize parts include a dimensioned ruler-marking route.
7. Record the exact build, maker assistance and deviations. Confirm loading, datum registration, joint access, support transfer, finished-object release and reset readiness.
8. Upload a separate trial clip. A person reviews registration, alignment, assembly completion, release, reset and allowed resources, and records the actual maximum alignment error. Unknown measurements/evidence remain incomplete; an error above the built revision's tolerance fails alignment.
9. Revise from an actual failed/incomplete trial. Meta receives the exact previous proposal, prior/current facts, evidence, measured result and feedback. Historic designs/builds/trials remain intact. A new build requires a pack that still passes current checks and matches the current compiler; otherwise regenerate the design. Export the complete evidence record.

**Explore a sample** uses synthetic dimensions and a proposed support hypothesis. It contains no fabricated physical success or performance numbers, and does not call Meta automatically. Existing earlier prototype projects remain readable as historical records.

## Meta and engineering responsibilities

- **Meta Muse Spark 1.3:** assess current/reference camera frames, identify scene-specific conflicts and propose the next move; separately observe task videos and compose jig designs with checker-guided revision.
- **Camera state engine:** strict assessment schemas, owned frame/session binding, before/after ordering, receipt freshness, scene/revision fences, measured-result comparisons and explicit operator reviews. It never advances because the model says a physical task is complete.
- **Jig compiler/checker:** hand occupancy, temporary support/joint state, joint-window intersections, material/sheet bounds, gate/extraction/reset rules and exact SVG construction output for the jig profile.
- **People:** state capabilities, measure, construct, assess actual force/fit/stability, inspect alignment and confirm trial outcomes.

Camera actions are frame-linked proposed instructions, not executable symbolic jig programs. Resource descriptions inform the model and the operator; the jig hand/support/geometry checks do not validate these new free-text actions. No verified one-hand method, force/reach/support proof or new construction CAD is implied by a camera assessment.

The OpenAI SDK provides compatible transport pointed at **Meta's endpoint**; inference runs on Meta. The key remains server-side. The client retains the cloud HTTPS proxy and TLS/CA verification. See [actual Meta integration evidence](docs/meta-integration.md).

Only `muse-spark-1.3` has a validated application binding. An incompatible `META_MODEL` fails before uploads or inference; catalog availability does not activate a different adapter. SAM, Wonder, voice transcription and extra critique calls remain optional and inactive.

## Bounded jig-design scope

The first workshop grammar represents one six-panel family whose actual kit permits base-first, wall-by-wall low-force joining and a final lid. It assumes the complete joints can self-retain before the gate is removed; this is an operator-confirmed input and still requires observation. The jig is an **unadmitted physical hypothesis** until the exact materials and operations are tested.

The first admission test releases the hand after each panel is located, then performs the actual next hand movement. An exterior L-brace's declared role does not prove that a wall stays upright or withstands insertion. Actual joint compatibility, force, friction, material bending, hand access, gate retention, extraction and next-cycle supply access require physical evidence. The planar/static checker does not establish a complete 3D human motion path or ergonomic benefit.

One meaningful adaptation changes a relationship: split/relocate a brace obstructing a measured joint window, add a real gate relief, or change support release and joining dependencies. A resized fixture alone does not demonstrate that capability. A simpler aid can be the correct model outcome.

## Verification

```sh
npm run typecheck
npm test
npm run build
# With production or dev web+worker running on port 3001 and Chromium installed:
BROWSER_BASE_URL=http://127.0.0.1:3001 npm run test:browser
# No provider request: actual application records, artifacts and ownership checks.
npm run smoke:workflow
# Optional actual Meta usage on synthetic measured inputs:
npm run smoke:meta -- --workshop
# Media decode/retrieval smoke; no provider request.
node --env-file-if-exists=.env.local --import tsx scripts/media-smoke.ts
# For a configured HTTPS frontend/backend pair; creates synthetic records, no inference:
SMOKE_BASE_URL=https://your-frontend.example node --env-file-if-exists=.env.local --import tsx scripts/hybrid-smoke.ts
# Render the five explicitly synthetic camera scenes without a model request:
npm run smoke:camera
# Optional explicit paid image inspection once per selected profile:
npm run smoke:camera -- --live
# Replay the six archived v3 results through the current controller, with no inference:
MODEL_API_KEY='' node --import tsx scripts/meta-flow-evaluation.ts --replay=docs/evaluations/meta-flow-v3-2026-11-03
```

Tests exercise consequential failure cases and preserve older prototype regression coverage. Live model results and synthetic screenshots are software evidence; see the [verification record](docs/verification.md) for observed counts and limits.

The [3 November independent review](docs/four-eyes-review-2026-11-03.md) records the camera, model, browser, media and construction findings and regression evidence. The [earlier jig review](docs/four-eyes-review.md) remains historical.

The [Meta flow four-eyes review](docs/meta-flow-four-eyes-review.md) covers the implemented request, comparison, recovery, memory, retrieval, plan, budget and provenance changes, with six new live synthetic challenges and actual controller replay.

## Persistence, access and deployment

SQLite stores projects, immutable snapshots, designs, builds/trials, audit events and a leased job queue. Complete provider results are cached before artifact publication. Known final responses can be retrieved; pending tool continuations and unknown interrupted requests are reported without blind replay. Cancellation stops future continuation/publication, and stale inputs cannot overwrite the current design.

Each queued operation freezes the model and prompt/schema/checker/compiler versions. A worker running different versions rejects that operation before inference or cached publication; start a deliberate new operation after an upgrade. Earlier completed records remain historical. Camera sessions also retain a versioned workflow definition; changed or unrecorded checks require an explicit facts reset before further actions. New physical reviews preserve their original criterion and facts. Late provider usage is retained in attempt-specific traces and included in private project exports. Confirmation/build/trial requests with a repeated operation ID return their original saved record; the UI retains IDs for uncertain retries within the current page, not across a full reload.

Jig analysis lets the operator choose the exact source uploads. Their frozen fingerprints follow the observation into planning and the exact parent into revision; failed-trial media has separate capacity. Every selected file is verified before any upload, and the same verified bytes reach Meta. Cached or retrieved media-bearing proposals must match the recorded evidence manifest. Candidate and final-proposal hashes retain actual checker provenance. See [current model-flow implementation](docs/meta-flow-implementation.md) for limits and historical compatibility.

Deploy to a **persistent Node host** with the web process, worker and shared volume. Configure `MODEL_API_KEY` independently on that host. Set a private **`APP_ACCESS_CODE`** before public exposure. Browser projects use HttpOnly random session ownership. This is prototype access control; session loss requires backups/exports, not an account-recovery promise.

Back up SQLite/media, use HTTPS, and use consented footage. Raw media requires project authorization. Provider file IDs are tracked for lifecycle management; automated project deletion/provider cleanup is not implemented. The Docker image built and ran in an isolated local verification with persistent media surviving restart; an external production deployment is still outstanding. Managed Docker builds must preserve proxy and CA configuration; the Dockerfile accepts the optional `proxy_ca` BuildKit secret without baking that session certificate into the image.

## What earns the final claim

A measured real panel set, a built generated jig, complete trials, a consequential tested revision, and comparison against ordinary corner blocks/clamps and an equally informed direct assistant. Freeze prompts, geometry grammar, supported material/joint envelope and test budget before a held-out adaptation. Include construction time and every engineering correction. Full participant Official Rules and portal requirements still determine the submission format and eligibility.
