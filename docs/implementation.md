# Implementation boundaries and build order

CounterShot's demonstrable unit is one complete physical packing job: observe, confirm, jointly design, build, operate, inspect and revise. The preferred mechanism is an insert that supports goods during work and remains in the parcel, paired with exterior supports. Keep the insert only if physical tests show a practical benefit over a simpler aid.

## Source of truth

`src/lib/contracts.ts` defines the implemented data model. The larger product specification is design intent; it must not be described as implemented functionality merely because it exists on paper. Current models describe constraints, observations, ordered steps, support transitions, bounded proposals, deterministic drawing output, immutable input/design records, jobs and trial criteria.

The package/work product means the **package or insert**, not the seller's merchandise. An existing carton remains an existing carton, even when CounterShot generates its insert and workstation.

## User flow

1. Start a job and state what a finished parcel contains.
2. Upload a clip or photographs of the original work. Include fresh packaging and reset; label missing segments or a genuinely blocked attempt.
3. Confirm functional constraints, supplies and measurements. Preserve observed facts separately from inferred interpretation.
4. Generate a coordinated proposal. Inspect package/insert geometry, station arrangement, support duties and operating steps together.
5. Run schema, resource and geometry checks. A candidate with hard errors cannot become a construction-ready pack. Uncertain physical properties become tests.
6. Download the exact revision's dimensioned drawings and instructions. Check print scale; record actual materials and construction corrections.
7. Record a complete physical cycle and human-reviewed outcome criteria.
8. Feed a specific failure into a revision. Show the changed geometry, support relationship or operation and repeat the actual test.

Do not require touching the phone during the packing cycle. Keep large controls, keyboard access and a recording countdown or independent camera operator available.

## Server and model boundary

The browser handles presentation and explicit confirmations. The server owns credentials, provider calls, storage, job state and access. Model output must be parsed and validated before becoming a design. User media and extracted text are evidence, not authority to change tools, keys or operator constraints.

Uploads receive content-signature, type, size and structural-metadata prechecks, including MP4 duration. These checks are not a full codec decode and cannot establish that a clip shows the intended physical task. Actual codec acceptance and human inspection of trial coverage remain separate.

Use Muse Spark for observations and bounded planning/revision. SAM overlays are optional aids; they cannot supply physical dimensions or functional-ability judgments. Deterministic code produces geometry and checks the declared action/support model. A model critic may find omissions but cannot establish physical success.

The official API base is `https://api.meta.ai/v1`. Responses structured output uses `text.format`. Complete tool outputs are paired by `call_id`. Check actual pinned SDK behaviour before relying on a snippet. The smoke script tests text/strict output and optional image input; video and tool-continuation integration need their own actual-account evidence.

## Persistence and truthful states

An input snapshot binds confirmed measurements, constraints and observations. A design binds that input, proposal, local checks and drawings. A trial binds the actual built revision. Edits create a new snapshot; old outcomes remain historical.

Protect against duplicate starts and stale generation results. Save a result for inspection when appropriate, but do not promote it over a newer input. Do not convert missing credentials, provider errors or incomplete output into sample designs. The user should distinguish setup missing, generating, checks failed, physical trial required, incomplete evidence and observed completion.

## Build priorities

| Priority    | Deliverable                                                   | Evidence of completion                                                      |
| ----------- | ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| First       | Actual API path and a physically credible supported mechanism | Real account smoke result; complete loading/closure/release/reset trial     |
| Core        | Confirmed input → joint proposal → checked drawing pack       | Exact same revision across proposal, geometry and instructions              |
| Core        | Trial and revision loop                                       | Failed assumption, meaningful change and actual subsequent trial            |
| Core        | Persistence and integrity                                     | Refresh recovery, duplicate request and stale-input tests                   |
| Competitive | Second admitted configuration and held-out adaptation         | Frozen case, all attempts and structural change evidence                    |
| Competitive | Fair comparison                                               | Sensible low-cost aid, fixed template and equally informed direct assistant |
| Later       | Segmentation polish, extra export formats and additional jobs | Add only after physical and evidence loops work                             |

## Known physical and validation gaps

Code can reject declared unavailable-hand use and incompatible dimensions. It cannot establish cardboard friction, slot strength, fold springback, closure force, comfortable human motion or shipment protection. Numeric input bounds are software bounds until the exact material/configuration and tested range are physically admitted. Follow the [physical protocol](physical-protocol.md).
