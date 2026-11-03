# Render backend and Vercel frontend

The selected deployment uses one Render Docker web service with a persistent disk, and Vercel for the public interface. This document and [render.yaml](../render.yaml) prepare the configuration; they do not mean either service has been created. Neither hosting account is connected from this environment.

## Render setup

Connect the `j420/j420-CounterShot` repository in Render. Create a **Blueprint** from `codex/grounded-meta-loop`, or from `main` after the PR is reviewed and merged. Render should discover the root `render.yaml` and Dockerfile. Preview the resources before creating them.

The Blueprint selects:

| Setting | Value |
| --- | --- |
| Service | Docker web service, `countershot-api` |
| Instance | `standard`, one instance |
| Disk | `countershot-data`, 5 GB at `/app/data` |
| Health path | `/api/health` |
| Automatic deploy trigger | Off |
| Preview generation | Off |
| Start command | The Dockerfile's `npm run start` |

`standard` is a conservative starting selection for the combined Next.js process, worker and bounded media buffers. Its current memory allowance and price must be reviewed in Render's creation screen; no price or capacity guarantee was established here. Choose a region near the operators. Do not horizontally scale this SQLite-backed service. Both processes already run in the same container and use the same mounted directory; do not create a worker service with a separate disk.

Enter the real Meta credential as `MODEL_API_KEY` in Render's secret field. The Blueprint generates a private `APP_ACCESS_CODE`; retrieve it from Render's environment settings for the operator's login. Keep both values out of Git, chat, browser code and Vercel environment settings. The development environment's destination-bound credential does not automatically configure Render.

Use the Dockerfile's commands. Do not override the start command with a frontend-only server, and do not add a separate build command. The image supplies Node 24, `ffmpeg`, `ffprobe`, the web process and worker. `COUNTERSHOT_BACKEND_ORIGIN` must remain absent on Render.

## Bootstrap the real addresses

Create the backend with **both** `APP_PUBLIC_ORIGIN` and `PUBLIC_API_ORIGIN` absent. This is the application's supported single-origin mode, protected by the generated access code. The first deploy establishes the actual Render HTTPS address; do not guess its hostname or put literal `$RENDER_EXTERNAL_URL` into an environment value.

Once that service is healthy:

- In Vercel, import the same repository and reviewed branch as a **Next.js** project. Use `npm run build`, repository root, and the framework's default output settings. Set `COUNTERSHOT_BACKEND_ORIGIN` to the exact assigned Render HTTPS origin before the first Vercel build.
- Obtain the stable Vercel project URL. On Render, set **both** `APP_PUBLIC_ORIGIN=https://your-stable-project.vercel.app` and `PUBLIC_API_ORIGIN=https://your-assigned-service.onrender.com` using their actual values, then manually deploy the configured backend.
- Keep origins bare: HTTPS scheme and host only, with no path, credentials, query or fragment. A temporary Vercel preview hostname is not automatically trusted. Changing the Vercel backend target requires a frontend rebuild.

This sequence avoids requiring a nonexistent self URL when the Blueprint is first applied. A partially configured origin pair fails closed. See [the routing and upload design](vercel-deployment.md) for the exact trust boundary.

## Verify the mounted disk before accepting the deployment

The image creates `/app/data` for the non-root `node` user (UID 1000). A provider mount can replace the image directory's ownership. The official example sources below establish the disk fields, but they do not establish the ownership of this particular Render disk. Treat actual write access as a deployment acceptance check.

Confirm in the Render logs that SQLite opens and both processes start without `EACCES` or read-only errors. If using the service shell, run the following as the configured application user; it prints no credentials:

```sh
node -e 'const fs=require("node:fs"); const p="/app/data/.countershot-storage-check"; fs.writeFileSync(p,"storage-check",{flag:"wx"}); if(fs.readFileSync(p,"utf8")!=="storage-check")process.exit(1); fs.unlinkSync(p); console.log("persistent directory writable")'
```

If this fails, stop before accepting the deployment and resolve the mount ownership using Render's supported configuration. Do not use `chmod 777`, silently run the application as root, or assume image-build ownership proves mounted-volume ownership. No ownership workaround was added without verifying provider behavior.

## Deployment checks

Through the stable Vercel URL, check `/api/health`, enter the private access code, create a labelled test project and save a camera checkpoint. Confirm that a different browser cannot read its frames. A selected photo must remain private and byte-bound to its assessment.

Upload a video larger than 4.5 MB using the direct upload path. Confirm that its ticket is single-use, playback/seeking works, and both the original and normalized media remain available only to the owner. Restart the Render service and verify that the same browser can still retrieve its project and saved media. The disk must survive the restart.

The existing smoke command creates synthetic records without requesting model inference:

Supply the deployed access code as `APP_ACCESS_CODE` in that local process's environment or ignored `.env.local`; the smoke does not need a local Meta key. Do not commit that file or paste the code into chat.

```sh
SMOKE_BASE_URL=https://your-stable-project.vercel.app node --env-file-if-exists=.env.local --import tsx scripts/hybrid-smoke.ts
```

Its temporary checkpoint contains session cookies; keep it private. After storage, ownership and the phone camera flow pass, run the separately bounded live archive-retrieval test. Record actual Meta response IDs and usage; do not label mocked tool coverage as a deployed live result.

## Verified configuration sources

Read on 3 November 2026 from official Render example repositories:

- [OpenClaw Docker Blueprint](https://github.com/render-examples/openclaw-render-template/blob/main/render.yaml): `runtime: docker`, health path, disk fields, secret prompts and generated environment values.
- [iMessage Codex Blueprint](https://github.com/render-examples/imessage-codex-agent-render-template/blob/main/render.yaml): `numInstances: 1`, `autoDeployTrigger: off` and `previews.generation: off`.
- [Codebase researcher Blueprint](https://github.com/render-examples/codebase-researcher/blob/main/render.yaml): the `standard` plan token and direct service secret prompts.
- [Express quickstart Blueprint](https://github.com/render-examples/express-hello-world/blob/main/render.yaml): the flat `services` layout.

SchemaStore's current catalog points to Render's [official Blueprint schema](https://render.com/schema/render.yaml.json). Render.com is outside this environment's allowed network hosts, so remote full-schema validation was not performed. Every field used above was checked against the official example sources, and Render's own Blueprint preview remains the final provider validation before resource creation. No service, billing resource, public URL or deployment was created by this preparation.
