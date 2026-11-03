# Meta flow implementation — four-eyes review

3 November 2026. Reviewed scope: request/answer resumption, prediction comparison, recovery, identity and claim memory, owned evidence retrieval, scoped plan changes, execution budgets, model capability bindings and jig check provenance.

## Result

**No outstanding findings in the final reviewed source.** An independent state/controller reviewer and an independent model/execution reviewer examined the integrated changes, supplemented by focused cross-reviews and primary integration checks. Reviewers used read-only source inspection and isolated mocked probes; their review did not make live API calls.

The required implementation actions are complete within the boundaries below. Additional models remain optional and inactive. This review does not establish physical success or guarantee model correctness.

## Findings corrected before final verification

All items below were correctness or audit issues, rather than evidence of automatic physical completion bypass.

| Finding | Correction and regression evidence |
| --- | --- |
| The phone could not cancel a view answer while its model request was pending. | A dedicated cancellation mutation preserves stable operation identity and response ordering. Delayed paid work remains historical and cannot overwrite a newer action. Browser cancellation test passes. |
| A passing numeric recheck could erase an overall failed review that also described another failure. | Every failed overall report remains counterevidence until a complete positive operator recheck resolves its claim. Partial readings cannot erase other failures; originals remain recorded. |
| Incomplete operator reports were labelled as failures in the plan evidence catalog. | Classification uses the matching typed review/report outcome. Unknown/incomplete evidence remains unresolved. |
| A new corrective before-view could replace the root prediction in model context. | Root prediction, active child and current before-anchor are exposed separately, as immutable snapshots. |
| Multiple explicitly hypothesized identities could still authorize manipulation or review. | Ambiguous targeted matches hold manipulation/review. Bounded identification inspection and view requests remain possible; model hypotheses never merge confirmed entities. |
| An expired/exhausted budget could still upload videos before the inference reservation failed. | The same controller starts before media work, checks durable preflight state at each upload boundary and preserves partial upload IDs. Tests verify zero uploads and zero generations for rejected budgets. |
| A clock crossing the deadline could be coerced into permission for a one-millisecond request. | Explicit positive remaining time is required immediately before remote work. The mocked deadline edge starts zero POSTs. |
| Media upload and crop timeouts could outlive the shared deadline. | SDK upload timeouts and decoder limits are clamped to the same remaining allowance; zero retries are retained. |
| A known provider response could be lost between durable budget accounting and the next trace checkpoint. | Recovery prefers the latest correctly bound responded invocation. Unknown later continuations cannot fall back to an older response. All known response IDs and usage are retained, with actual final checks recomputed. |
| A continuation trace carrying an earlier response ID could skip the final state check. | The current reserved invocation is distinguished from response-only audit callbacks; metadata is fenced again before POST. |
| Late usage could exhaust a run after reservation but before a later POST. | The final boundary rechecks the latest durable budget. Independent API-path injection produced zero SDK POSTs while retaining both reservations and known usage. |
| A future helper caller could omit the provider's output-token limit. | The shared execution helper requires an explicit valid enforced output limit before reserving or sending. |

## Verification on the final implementation

| Check | Result |
| --- | --- |
| Full unit/API suite | **396 passed**, zero failed or skipped |
| Full browser suite | **38 passed**: 11 workshop and 27 camera journeys |
| Typecheck | Passed |
| Production build | Passed |
| Live Meta ordinary v3 challenge cases | **6/6 passed**, six known responses, no retries or unknown outcomes |
| Replay of exact live outputs through the final controller | **6/6 passed**, zero new model requests and zero automatic phase advances |
| Independent final state/controller review | No outstanding findings |
| Independent final model/execution review | No remaining blocking findings |

Endpoint regressions exercise the actual camera route, adapter and durable store with mocked SDK responses: one owned historical crop followed by finalization, two shared invocation reservations, one tool record, exact source hashes, both response IDs and known usage. They also cover no-refill resets, exhausted budgets before retained media, and an old continuation racing a newer reset/capture. Job regressions verify reservations before actual SDK calls, aggregate tool limits, late-response merging, interruption recovery and final proposal provenance.

The six live challenges use new rendered diagrams with expected rules withheld from model input. They cover obscured identity, changed workpiece, a reported failed reading, visible instruction injection, a supported visible prediction and a hidden relationship. Known usage totals **61,746 tokens**, with **11.6–22.9 seconds** observed latency. Raw inputs, images, responses, execution records and replay evidence are preserved in [the archive](evaluations/meta-flow-v3-2026-11-03/summary.json). The local check manifest also records source and log hashes.

## Limits and deliberate exclusions

- The live run validates ordinary v3 reasoning. Historical read/crop/finalization has mocked endpoint coverage, not a new live tool-transport run.
- Synthetic diagrams are software evidence, not photographed physical trials or an independent physical benchmark. Real-object performance and physical outcomes remain unestablished.
- Plan substeps are checked, operator-approved guidance within mandatory catalog phases. They do not constitute independently verified executable substep ordering or general physical planning.
- Only `muse-spark-1.3` is integrated. SAM, Wonder, voice transcription and additional critique calls require a justified capability and measured benefit before activation.
- Existing explicit ownership, scope, freshness, actual-reading and operator-confirmation gates remain necessary. Model confidence cannot commit identity, overwrite confirmed facts or complete a phase.

See [the implementation record](meta-flow-implementation.md) for contracts and application limits. No deployment, environment publication or unsolicited external messages were performed.
