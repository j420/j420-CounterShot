# Camera-first scene understanding

The normal `/camera` entry opens a local camera preview after workspace access is checked. It asks for a short goal and, optionally, one context or constraints note. Photo upload remains available when the camera is unavailable or permission is declined. Opening the preview, choosing a photo, stopping the camera and confirming a setup detail make no model request.

**Understand this view** sends one deliberately selected snapshot to Meta. The scene response proposes a supported workflow, locates visible observations, transcribes eligible visible labels or written references into unconfirmed text drafts, and names uncertainties. Unsupported or unclear scenes remain unresolved; the app does not silently select its first workflow.

The operator chooses whether to use that workflow. This creates the usual camera run with unknown prerequisites, retaining the intake's run identity, invocation/token allowance and deadline. The intake image is context, not a before-action prediction or evidence of a completed physical operation.

Only the current phase's next missing prerequisite appears. A visible draft can be confirmed with a tap against its exact saved image or edited as the operator's own checked description. Previously entered constraints can be explicitly reused. Scope, hidden conditions and quantitative readings remain explicit operator reports. Filling a previously unknown prerequisite preserves reviewed phases and recorded failures; changing a known value still requires an explicit setup reset.

After the necessary details are confirmed, the existing fresh before-view → bounded action → after-view comparison → operator review loop applies. Review measurements are presented one at a time. Camera preview is local live video; Meta receives selected still frames, not a continuous stream. Manual workflow setup remains an explicit alternative for known tasks or an unavailable model connection.

## Grounding and recovery

- Intake uses Spark `muse-spark-1.3` with one strict structured image response, no model tools and no automatic retries. It offers only the five existing bounded workflow families.
- Each run permits at most three deliberate intake analyses. Retakes and adopted workflow checks consume the same existing camera execution budget.
- Drafts are text-only, restricted to eligible facts for the suggested workflow and current observation IDs. They cannot confirm scope, numeric measurements, operator constraints, physical identities, actions or success.
- Browser ownership is established before a paid request. Operation identities recover saved results without repeating inference. Cancellation and stale-response fences preserve known paid usage while preventing an older result from becoming current.
- Private image URLs include immutable frame identities. A retake cannot substitute its pixels beneath an earlier result. Confirmed-draft receipts retain the exact source image hash and the operator's explicit confirmation.
- Initial-scene drafts cannot be reused after a physical scene reset. Every ordinary action still needs its own fresh, bound checkpoint.

## Verification

The new API and domain regressions cover ownership, duplicate operations, corrupt and foreign frames, unsupported or malformed results, cancellation and retake races, shared budgets, explicit draft confirmation, numeric units and preservation of reviewed phases. Existing camera guidance and workshop behavior remain part of the regression suite.

Validation on 3 November 2026 includes the unit/API suite, 39 camera browser journeys and 11 workshop browser journeys. Camera browser tests use synthetic camera streams and explicit API/model fixtures. Phone-width screenshots check layout; they do not establish device-camera compatibility.

A [live Meta intake check](evaluations/camera-first-2026-11-03/live-meta-intake.json) used the labelled synthetic harness diagram. One request returned `harness_routing`, read the printed target map, distinguished the diagram from a physical harness, and left physical conditions unconfirmed. It used 4,150 reported tokens and took 11.7 seconds in this environment. No session or confirmed facts were created automatically. This verifies the new API contract, not physical performance, a real phone camera or deployed Vercel-to-Render transport.

## Deploying the two hosts

Deploy the same current code to Render and Vercel. Render's deployment trigger is manual. The frontend checks the backend's `sceneIntake` and `progressivePrerequisites` capabilities before using new endpoints. While an older backend is still running, local preview and the explicit manual alternative remain available; scene understanding displays an update notice instead of sending requests to missing endpoints.

After updating Render, verify through the stable Vercel production URL: camera permission, local preview with no inference, one scene analysis, review of a visible draft, a nonvisual prerequisite, a fresh ordinary checkpoint, and saved ownership after refresh. A production phone trial and physical outcome remain separate acceptance checks.
