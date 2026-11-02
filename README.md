# CounterShot

CounterShot observes a physical packing job, accepts the operator's stated constraints and confirmed measurements, and proposes a coordinated package or insert, workstation and operating sequence. Physical trials supply the evidence for revisions.

This repository is a **bounded hackathon prototype**, not a validated assistive device or a general physical-design system. Its proposed contribution is completing and adapting an entire job, including empty-package preparation, closure, release and reset. Drawings, masks and logically consistent plans are intermediate outputs.

## Run locally

Use **Node.js 24 or later**. The server uses the built-in `node:sqlite` module and needs persistent, writable storage.

```sh
npm ci
```

Copy `.env.example` to `.env.local` in the repository root. For example, in PowerShell:

```powershell
Copy-Item .env.example .env.local
```

Open `.env.local` locally and enter the Meta Model API key:

```dotenv
MODEL_API_KEY=your-local-meta-key
META_MODEL=muse-spark-1.3
COUNTERSHOT_DATA_DIR=./data
```

Keep the key on the server. Do not paste it into the browser interface, screenshots, commits, issue reports or chat. `.env.local` and the example `data/` directory are ignored by Git.

```sh
npm run dev
```

Open the local address printed by Next.js, normally `http://localhost:3000`. The application can open without a Meta key; model-dependent actions must report that setup is missing rather than simulate a model response.

## Verify the actual Meta connection

```sh
npm run meta:smoke
```

This makes two small, real requests to `https://api.meta.ai/v1/responses`: an exact-text response and strict JSON output. It consumes account usage. The script reports structured results, exits nonzero for missing credentials or a failed check, and never prints the key or raw provider error headers.

To test a photograph as a third request:

```sh
npm run meta:smoke -- --image "C:\path\to\packing-photo.jpg"
```

Use an image you are entitled to upload. The optional image check confirms that a completed, nonempty image-understanding response is returned; it does not verify physical measurements or factual accuracy. Check [Meta's current model and account availability](https://dev.meta.ai/docs/models) if authentication, quota or model access fails.

The application uses Meta's endpoint. The `openai` package is an API-compatible client library; its presence does not mean that the application calls an OpenAI runtime model.

## Build and checks

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm start
```

The automated checks and production build must work without a real API key. Fixtures and mocked contract tests are not evidence that a real provider request or physical task worked. CI uses Node 24 and runs type checking, lint, unit tests and the production build. `npm run test:e2e` is available for browser tests when their browser dependencies are installed.

```sh
npx playwright install chromium
npm run test:e2e
```

Browser tests start a separate server on `127.0.0.1:3011`, force an unconfigured placeholder key and use an isolated ignored data directory. They do not spend Meta credits. The generated-design and trial-presentation cases explicitly mock their routes; the creation, upload and missing-setup cases use the actual local server. Neither category is a real-model or physical-completion test.

## Deployment

Use a persistent Node host that supports long requests and a writable persistent volume. Point `COUNTERSHOT_DATA_DIR` at that volume. The server's default is `.data/countershot` under the working directory if no override is set; the example configuration deliberately uses the ignored `data/` path.

For a public production deployment, configure these server-only values:

```dotenv
COUNTERSHOT_ACCESS_CODE=choose-a-private-access-code
SESSION_SECRET=choose-a-random-secret-of-at-least-32-characters
```

The access code establishes an HttpOnly session cookie. Keep the application behind HTTPS. Do not expose raw footage, exported designs or jobs through public asset URLs. A production deployment with missing authentication configuration should refuse access, rather than silently become public.

`SESSION_SECRET` must contain **at least 32 characters** in production. Generate a private random value locally; do not reuse the example text.

An ephemeral serverless filesystem is unsuitable for the SQLite database and footage. External storage and durable execution would be a separate deployment change. Do not run multiple independent application instances against unrelated local databases and expect shared project state.

## Dependency audit

The current lockfile's audit reports 16 moderate findings in development tooling associated with the `minimatch` advisory [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249). The production-only audit (`npm audit --omit=dev`) reports zero vulnerabilities. These are audit results for this dependency snapshot, not a guarantee of security. Review compatible tooling updates separately; do not use `npm audit fix --force`, which proposes a disruptive ESLint downgrade.

## Prototype scope and evidence status

- Supported planning vocabulary: wraparound packaging and measured tuck cartons; a small set of cardboard inserts and passive registration/support arrangements.
- The operator declares the available hand, actions and work area. The application must not infer disability, strength, reach or functional ability from appearance.
- Dimensions and material inputs are confirmed by the user. Segmentation or video reasoning does not establish millimetre accuracy, force, friction or material strength.
- Local checks establish consistency within the implemented geometry and action model. A passing check is **not a successful physical trial**.
- Trial outcomes belong to the exact generated revision and built materials. Every operating cycle includes a fresh package and next-cycle reset. Initial maker assistance is recorded separately from operating assistance.
- The shared insert/station design remains a physical hypothesis until material calibration, loading, fold clearance, closure, extraction and reset have passed actual trials.
- No shipped-device, transport-protection, clinical, fatigue-reduction or broad accessibility claim is established by this repository.

Real Meta account access, image/video behaviour, latency and quota must be verified on the participant account. Physical feasibility and the comparative advantage over existing aids require the protocols below. **No real API success or physical completion should be claimed solely because an automated build or test passes.**

## Build and evaluation documents

- [Implementation boundaries and build order](docs/implementation.md)
- [Material calibration and complete-cycle physical tests](docs/physical-protocol.md)
- [Baselines, frozen cases and honest claims](docs/evaluation.md)
- [Official rules, model documentation and closest prior art](docs/sources.md)

## Hackathon alignment

The [official contest rules](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver) score Impact **30%**, Use of Meta AI Tooling **25%**, Technical Depth & Execution **20%**, and Demo **25%**. CounterShot targets the physical-systems theme through observed work, coordinated design and test-driven adaptation. A competitive claim requires a working demonstration and fair comparison, not merely an ambitious description.

The published rules permit third-party technical assistance subject to ownership requirements. They do not name Claude or Codex or require Muse Code as the exclusive coding assistant. Treat that as a reading of the published rules, and check later accepted-participant notices before submission. Development assistance is separate from the project's substantive runtime use of Meta models. The rules and instructions may change.
