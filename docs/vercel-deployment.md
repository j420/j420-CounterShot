# Phone access through Vercel

**Status: the user's Render screenshots show the backend at `https://countershot-api.onrender.com` Live on commit `8613af3`. The Vercel frontend is being configured; its public URL and the deployed phone workflow have not been verified.** The root [Vercel configuration](../vercel.json) supplies this public backend origin to Vercel's build and runtime. Backend secrets remain on Render.

The intended experience is one HTTPS link in the phone browser: create the project, capture/upload media, confirm facts, generate the jig, inspect the build and upload a trial. Keep the same browser profile: the current access code is an application gate, and project ownership uses a browser cookie, not an account that restores projects on another device.

## Why importing the current app is insufficient

The current application uses local SQLite/WAL and media files under `DATA_ROOT`, an always-running leased worker started by `npm run start`, and installed `ffmpeg`/`ffprobe` binaries. These dependencies require an explicit hosting design; a Next.js build succeeding does not provide their persistent operation on Vercel.

The existing media endpoint also receives uploads of up to 50 MiB through a Route Handler. Vercel's official Blob SDK documentation states that server uploads on a Vercel-hosted website are limited to 4.5 MB and recommends direct client uploads for larger files. The current upload route cannot simply be moved unchanged. Do not assume an external rewrite transparently solves large-upload limits, streaming or processing timeouts.

## Selected setup: Vercel UI plus one persistent backend

The checkout now contains hybrid routing and upload scaffolding. Vercel serves the Next.js interface and HTTPS entry point. The existing API, SQLite, private media storage, ffmpeg and worker run together on a persistent Node 24 host/container with a mounted volume. Keep this backend to one instance using the present SQLite design.

| Deployment | Environment setting | Purpose |
| --- | --- | --- |
| Vercel frontend | `COUNTERSHOT_BACKEND_ORIGIN=https://countershot-api.onrender.com` | Supplied by both `build.env` and `env` in the root `vercel.json`; targets the `/api/:path*` rewrite. |
| Persistent backend | `APP_PUBLIC_ORIGIN=https://your-site.vercel.app` | Exact trusted browser origin for the public app. |
| Persistent backend | `PUBLIC_API_ORIGIN=https://countershot-api.onrender.com` | This backend's public HTTPS origin for direct media uploads. Must match the frontend's backend setting. |
| Persistent backend | `MODEL_API_KEY`, `APP_ACCESS_CODE` | Meta inference credential and private app access code. Keep both server-side. |
| Persistent backend | `DATA_ROOT=/app/data` | Persistent volume shared by the web process and worker. |

Use the actual stable Vercel production address for `APP_PUBLIC_ORIGIN`. Origins must use HTTPS and contain no credentials, path, query or fragment. An optional trailing slash is normalized. Leave `COUNTERSHOT_BACKEND_ORIGIN` unset on the persistent backend so it handles API requests locally. Both backend origin settings may be absent for local single-host use; a partial hybrid pair fails closed. Add the settings to both backend processes, not only the web process.

Vercel reads the checked-in public backend origin from `vercel.json`, so importing this repository does not require manually creating that variable in the dashboard. Both `build.env` and `env` are present because the build and deployed runtime have separate environment settings. To change the backend, update both entries together and rebuild. This file contains no Meta credential or access code and is not consumed by the local or Render Next.js process.

If the dashboard already defines `COUNTERSHOT_BACKEND_ORIGIN`, keep its value consistent with this file. Dashboard-versus-repository precedence was not independently verified; do not use conflicting values.

`next.config.ts` applies configured API rewrites in `beforeFiles`, ahead of local Route Handlers. Page components fetch the API from the browser and do not open the database. A Vercel build whose configuration supplies no backend setting still fails explicitly; malformed targets and known self-proxy loops also fail. Changing the target requires a frontend rebuild. Do not place a Meta key on the frontend deployment.

### Media and browser sessions

Ordinary API requests, access-code submission and project-session cookies use the Vercel origin and the API rewrite. The configured backend accepts the exact public origin; it does not add a wildcard origin or weaken project ownership.

For a large video, the phone first requests a short-lived, project-scoped upload intent through the ordinary API. It then sends the media directly to the returned backend URL with the one-use bearer ticket. This path avoids sending a 50 MiB video through a Vercel Function and does not rely on third-party session cookies. CORS and ticket validation remain restricted to the configured public origin. Local single-host mode uses the original same-origin upload route.

Use the stable production Vercel address for the configured pair. An arbitrary preview address is not automatically trusted by the backend. Keep the same phone browser profile throughout; the access code is not cross-device project sign-in.

### Deployment sequence

1. Import the repository's current `main` branch, including its root `vercel.json`. The application and reviewed deployment fixes have been pushed to `main`.
2. Provision the persistent backend from this repository's Dockerfile on a host with an attached disk, HTTPS, Node 24 and permission to run ffmpeg. Mount storage at `/app/data`. The image's `npm run start` runs the website and worker together; do not configure an additional worker against a different local disk. Leave the frontend rewrite setting unset there.
3. Set the backend credentials securely, choose the intended stable Vercel address, and set both exact backend origin settings. The managed development environment's destination-bound Meta secret does not automatically configure this external host.
4. Import the same branch as a Next.js project in Vercel, using the repository root, Node 24, `npm ci`, `npm run build`, and default output settings. The checked-in `vercel.json` supplies the Render target. Vercel runs the framework deployment; do not use the backend's endless `npm run start` as a Vercel background service.
5. Verify `/api/health` through the Vercel URL reaches the backend. On a phone, enter the code, create a project, capture/upload a clip, inspect playback and generate an explicitly requested model job. Revisit after a backend process restart to confirm records and files persist. Test unauthorized access and expired/replayed tickets.

A real deployment must still verify proxy-forwarded host/origin behavior, secure cookies, protected video playback/seeking and exports through the final public URL. The large upload deliberately uses the direct path; no 50 MiB external-rewrite body guarantee is claimed. The Docker image built and ran locally, and a trusted HTTPS two-origin smoke verified a >5 MiB MOV direct upload, authorization, private original/range retrieval and retained data after restart. This used a local frontend proxy with a 4.5 MiB request limit, not a deployed Vercel edge. See the [verification record](verification.md). These checks do not establish actual host behavior or real-device camera compatibility.

After configuring the real HTTPS pair and an access code in secret settings, run `SMOKE_BASE_URL=https://your-site.vercel.app node --env-file-if-exists=.env.local --import tsx scripts/hybrid-smoke.ts`. The script requires local ffmpeg and creates a labelled synthetic project, not an inference job. It writes a private temporary checkpoint for restart checks; never publish that checkpoint because it contains the test session cookies.

This setup requires both a Vercel account and the selected Render backend. The user has created the Render service; this agent has no hosting-account connection for changing dashboard settings. The screenshots establish service startup, not end-to-end phone, storage-restart or live Meta verification. See [the deployment guide](render-deployment.md) for the initial single-origin bootstrap and subsequent exact two-origin configuration.

## Alternative: migrate the backend to managed services

A Vercel-native design can replace SQLite with a remote transactional database, local files with private object storage and signed direct uploads, and the endless worker with durable workflows. Vercel's Workflow SDK documents managed queuing, storage and observability on Vercel; adopting it requires changes to this application's job execution and recovery code, not merely a start-command change.

The migration must preserve ownership, immutable snapshots, transactional publication, attempt fencing, cancellation, unknown-provider-outcome handling and trace audit. Media verification/normalization also needs a verified execution environment with the required binaries and processing budget. Private uploaded bytes must be verified before becoming model or trial evidence. Select and configure those services before claiming this route is ready.

## Official references read for this assessment

- [Vercel CLI production deployment implementation](https://github.com/vercel/vercel/blob/main/packages/cli/src/commands/deploy/index.ts): parses `vercel.json` runtime `env` and `build.env` separately and passes both to the deployment.
- [Vercel Blob SDK README](https://github.com/vercel/storage/blob/main/packages/blob/README.md): server-upload limit and direct client upload approach.
- [Vercel Blob starter](https://github.com/vercel/examples/tree/main/storage/blob-starter): storage integration and `BLOB_READ_WRITE_TOKEN` configuration.
- [Vercel Workflow SDK README](https://github.com/vercel/workflow/blob/main/packages/workflow/README.md): durable workflow execution and managed Vercel deployment.

No current plan-specific timeout, pricing, private-Blob behavior or proxy upload limit was independently established here. Check the selected services' current settings as part of the concrete deployment.
