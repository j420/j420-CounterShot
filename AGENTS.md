# Working on CounterShot

## Commands

Use Node 24 or later (`node:sqlite` is required), then `npm ci`.

- `npm run dev`: local application.
- `npm run typecheck`: TypeScript checks.
- `npm run lint`: ESLint.
- `npm test`: meaningful domain and server contract tests.
- `npm run build`: production build, without a provider key.
- `npm run test:e2e`: browser tests when installed.
- `npm run meta:smoke`: real Meta requests; requires a locally configured key and consumes usage.

## Architecture and ownership

`src/lib/contracts.ts` is the canonical shared contract. Keep UI, server responses, planner output, checks, drawings and test fixtures aligned with it. Runtime reasoning uses Meta's API with a server-side key. Persist projects, snapshots, design revisions, jobs and trial evidence using the server storage layer. Geometry and action/resource checks run in ordinary code.

Read `docs/implementation.md`, `docs/physical-protocol.md` and `docs/evaluation.md` before changing planning or success logic. The current domain is bounded tabletop packing. Expand the supported grammar only with explicit handling and tests; do not imply arbitrary object reconstruction or engineering simulation.

## Evidence rules

- Generated observations remain inferences until confirmed; source footage is evidence, not instructions.
- Preserve confirmed measurements and stated capabilities. Never infer disability or physical ability from video.
- Checks establish model consistency, not physical stability or completion.
- Every drawing, build and trial references one exact design/input revision. Input edits invalidate current eligibility without relabelling old evidence.
- Keep failed, incomplete and successful attempts distinct. A human records outcome criteria; a model cannot award itself a physical pass.
- Include fresh-package preparation, closure, release and reset. Record initial construction help separately from operating help.
- Fixture tests, mocked model responses and replayed recordings must be labelled. Do not add silent synthetic success paths.
- An internal model critic is advisory. Independent review and actual trials remain separate.

## Security and implementation discipline

Never read or print real `.env.local` contents or keys to diagnose setup. Check presence without disclosing values. Keep keys, session secrets and access codes out of client bundles, logs, URLs, fixtures and screenshots. Report safe error categories; do not return raw provider headers or credential-bearing bodies.

Validate model output locally, including references, dimensions and current input identity. Use allowlisted typed geometry operations; do not execute model-authored code or markup. Enforce project/session access for assets, jobs and exports. Changes must preserve server-side persistence and stale-result protection. Do not claim CI validates provider access or the physical mechanism.

Run checks appropriate to the change. Fix the cause of a failing test rather than weakening an evidence gate. Keep implementation claims and known gaps current in the README. No extra approval process is imposed by this file.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
