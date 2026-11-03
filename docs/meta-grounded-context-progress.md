# Grounded context and decision loop — implementation progress

3 November 2026. Scope: Meta inputs, evidence provenance and the application decision loop.

**Historical progress record:** the pending actions described below have since been implemented. See [current implementation](meta-flow-implementation.md) and [final four-eyes review](meta-flow-four-eyes-review.md) for current behavior, validation and limits.

## Completed action: preserve original visual evidence

The observer-to-planner handoff now carries the exact selected source media as well as the inferred observation. A revision inherits its exact parent design's source evidence and attaches selected failed-trial media under a separate role. Later uploads and later observations cannot replace that source selection.

The application records IDs, canonical-media SHA-256, byte length, MIME type, decoded video duration, upload time and storage identity when analysis is queued. New observations retain that frozen record. Planning binds the selected observation to those recorded media fingerprints; changing a source record after observation requires deliberate reanalysis. Actual capture time remains unknown. The canonical JPEG/PNG/MP4 sent to Meta is distinguished from an optionally retained original phone encoding.

Before sending media, the adapter validates the complete selected bundle, reads bounded buffers and verifies every SHA-256. It sends those same verified buffers as image data or video uploads. A changed or missing later file prevents all uploads for that bundle. Ownership, source/trial purpose, frozen metadata and execution versions are checked by the worker. Proposal traces carry the evidence manifest and its digest; cached/retrieved media-bearing proposals must match that manifest before publication. Existing cancellation, paid-response identity and partial-upload file-ID retention remain in place.

Source selection is explicit in the capture screen and observation API. An explicit selection survives record refreshes; additional uploads stay unselected. The API rejects oversized selections before queueing. No saved evidence is deleted or silently omitted.

| Application allowance | Original sources | Failed-trial evidence | Combined ceiling |
| --- | --- | --- | --- |
| Files | 8 | 4 | 12 |
| Canonical bytes | 100 MiB | 50 MiB | 150 MiB |
| Video duration | 360 seconds | 180 seconds | 540 seconds |

Each file is limited to 50 MiB. Separate trial capacity lets a parent using its full source allowance still be revised without dropping its originals. These are application limits, not a provider capacity claim.

Older media-backed observations without recorded fingerprints require reanalysis. Historical designs without recorded source provenance remain explicitly `historical_unavailable`; revisions do not assign today's latest observation to them. Empty/synthetic observations retain their exact observation reference without invented images. Old queued jobs whose execution versions no longer match require a deliberate new operation.

The evidence record is currently at file level. Claim-level retrieval, stable physical entity memory and the fuller canonical camera context remain later actions.

Validation: **291 unit/API tests, all 11 workshop browser journeys, typecheck and production build passed**. The phone browser regression covers an oversized upload history, explicit source selection, later uploads staying unselected and the exact IDs submitted for analysis. Offline adapter tests verify the actual image/video bytes, complete-bundle validation, per-role bounds and audit retention. Worker tests cover observe→plan binding, selected-parent revision, changed records, legacy provenance, cache and response recovery. An independent follow-up review found no remaining blocking findings for this action after source selection and revision capacity were corrected. These checks validate the evidence path; they do not measure new model reasoning or physical outcomes.

## Completed action: one explicit decision per camera turn

Camera schema and engine version `2.0.0` replace mixed `nextAction`, `questions` and `stepStatus` intent with one explicit decision and exactly one matching payload:

| Decision | Matching payload | Application behavior |
| --- | --- | --- |
| `request_view` | `viewRequest` | Request a specific view and name the uncertainty it resolves; no physical action or confirmation. |
| `request_measurement` | `measurementRequest` | Request a named current-step numeric fact in its exact declared unit; no fact is written by the model. |
| `propose_action` | `actionProposal` | Propose one located action with preconditions, expected result and stop condition, subject to existing local gates. |
| `ready_for_operator_review` | `operatorReview` | Offer explicit inspection and reading checks on a fresh after-view; only the person's required checks can advance. |
| `hold` | `hold` | Explain the blockage and condition for resuming; no movement or confirmation. |

The provider receives a closed, fully required object with nullable payloads. Local validation rejects a missing, mismatched or second payload and foreign observation, step, fact or unit references. IDs for decisions, evidence requests and predictions are assigned from saved application turns, never model output. View requests and holds stop automatic watching. The phone UI renders and speaks only the matching payload.

`camera-context-v2` packages run/turn identity, current revision and scene epoch, workflow/check/prompt versions, confirmed facts, current-step fact definitions and permitted measurement requests, frame identities/hashes and time provenance, and bounded operator-reported history. Its stable hash is retained in model traces. The immutable original before-action prediction and its original target observations are separate from the latest historical comparison image. Repeated after-views cannot rewrite that original expected result. The server checks that the original record belongs to the same run, scene, step, frame and check version.

Requests finish and persist as completed model turns; no provider call remains suspended while waiting for a person. Existing freshness, distinct-frame, scene, location, actual-reading and operator-review gates remain enforced. Old camera assessments remain readable in history and require explicit facts reconfirmation/reset before further progression. They are never silently converted into actionable decisions. The prompt is `camera-decision-2.0.0`; the one-call, 6,000-token, low-reasoning, 90-second, zero-retry baseline is retained. No additional model or agent calls are introduced.

Independent review found a missing input definition for exact measurement units; the context now includes those definitions. An independent exhaustive schema check admitted the five matching single-payload combinations and rejected 155 mismatched or missing combinations. The new provider wire has offline coverage; no live v2 inference was requested, and earlier live v1 fixtures remain historical.

Validation: **311 unit/API tests, all 14 camera browser journeys, typecheck and production build passed**. A stronger focused browser check also verifies that conflicting saved payloads cannot become actions even if supplied with permissive guidance flags. New regressions cover completed/idempotent evidence requests, matching app-generated identities, foreign references, mixed-intent rejection with paid-response audit retention, immutable predictions through repeated after-views, and explicit legacy reset. Independent follow-up review found no remaining blocking findings for this action. These are integration checks using synthetic inputs and mocked model responses, not new live reasoning or physical-outcome results.

## Next action: link requests to answers

Implement explicit request/wait/answer resumption so the requested view or confirmed measurement answers its saved request without losing valid scene state or silently overwriting a fact. After that, add structured comparison outcomes against the original prediction, then bounded recovery and aggregate invocation budgets. These remain pending; this action does not establish that the entire decision loop or new model reasoning has been validated end to end.
