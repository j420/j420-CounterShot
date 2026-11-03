# Meta integration and observed verification

CounterShot's live observation and planning provider is **Meta Model API**, endpoint `https://api.meta.ai/v1`, model **`muse-spark-1.3`**. The `openai` npm package supplies compatible client transport; requests are sent to Meta, not OpenAI. `META_MODEL` can select a different account-enabled model, but only the model above was tested here.

## Credential and network setup

Set **`MODEL_API_KEY` on the server** through the host's secret settings. Do not commit a key, put it in a `NEXT_PUBLIC_` variable, send it to the browser, or paste it into application diagnostics. The managed development environment has a destination-bound secret for `api.meta.ai`. That does not automatically configure another deployment host.

`src/meta/client.ts` uses `undici`'s `EnvHttpProxyAgent` when the inherited `HTTPS_PROXY`/`HTTP_PROXY` is present. This is required for the managed environment's proxy-injected credential. It preserves configured TLS verification and inherited CA trust (`NODE_EXTRA_CA_CERTS` in this environment). No certificate checks are disabled. A host without those proxy variables uses its normal network path.

The non-contributor `muse-spark-1.3` model ID is the Standard-mode selection documented by Meta. CounterShot does not send a fabricated training/privacy flag. Content handling and account terms must be checked for the actual deployment and chosen model; using this client does not independently establish every account-level privacy setting. The prototype should use consented task media.

## What the models do

The primary camera workbench uses **Muse Spark 1.3** for one requested frame assessment at a time, with the previous owned view attached when available. It returns visible observations, normalized snapshot regions, one proposed action, its expected result, a stop condition and unresolved questions. A separate deterministic engine binds the result to its frame/phase/revision and requires before/after views, actual operator readings and explicit review. It does not apply the jig compiler's physical support/hand rules to these free-text actions.

The calibrated request uses strict `text.format`, documented `reasoning: { effort: "low" }`, a 6,000-output-token ceiling, a 90-second request timeout and zero automatic retries. The first 1,600-token attempt exhausted its budget on reasoning and was rejected. Five returned profiles and that failure are retained in [recorded camera assessments](../fixtures/recorded-meta-camera-assessments.json). A separate [paired-image check](../fixtures/recorded-meta-camera-comparison.json) correctly recognized a diagrammed route correction and still withheld physical admission. All seven known request IDs/usage are retained across those files. Five returned profile inspections took 6,679–11,165 ms; all remained nonactionable/nonconfirmable under uncertainty guards. These are real API calls on rendered diagrams, not five successful physical tasks. See the [reasoning documentation](https://dev.meta.ai/docs/reasoning).

Camera preview stays local. Manual checks send selected reduced frames; the explicit watch option sends at most three sequential checks. No continuous video stream, precision AR registration or hard realtime performance is claimed. The following construction/video responsibilities additionally apply to the separate jig companion:

- **Observation:** typed, evidence-linked parts, actions, holding/alignment conflicts and questions from MP4/JPEG/PNG evidence. Missing loose-part loading, joining, support transfer, finished-object release or reset remains incomplete evidence. Still-only observation is forcibly incomplete locally.
- **Planning:** a coordinated jig base, split exterior braces, removable front gate and full assembly/release sequence within the disclosed workshop grammar. Confirmed workpiece measurements and operator capabilities are immutable inputs. Earlier packaging profiles retain their separate historical component grammar.
- **Checker feedback:** the model receives concrete symbolic/geometry check results through `check_task_plan` and can correct the candidate or ask for measurements. Pure tool results are cached by provider response ID and call ID.
- **Revision:** the previous proposal, human-reviewed failed-trial feedback and actual failed-trial media are supplied to the planning call. The result proposes changes; it cannot record a physical pass.

The current primary profile is **`workshop_jig`**: a custom passive jig for staged low-force assembly of a supplied pre-cut flatpack instrument-enclosure mockup. Meta observes panel holding/alignment/stabilisation conflicts and proposes exterior supports, split/relocated braces, a removable front gate and an explicit assembly/release sequence. The workpiece and its joint family are supplied facts; the model designs the jig only, not a new enclosure or replacement panel geometry.

The staged cycle starts with the front gate parked for fresh base loading. Supports must keep installed non-self-retaining walls located while the active hand fetches/inserts other parts, and must leave the measured joint-access/approach windows clear. The completed wall/lid assembly may self-retain only when that capability is explicitly operator-confirmed; it is not invented by the model. Gate release acquires the gate in the hand, parking frees the hand, and forward extraction/finished placement precede reset. Local checks address declared support duties, access-window obstruction and release paths; actual joint retention, insertion force, friction and fixture stability remain physical admission tests.

For workshop calls, `check_task_plan` accepts the **jig programme directly**, using `JigProgramSchema`. A deterministic validation-only envelope supplies the local checker's metadata fields; that envelope is never published. The final outer proposal remains model-authored and must contain literal JSON `program: null`, an empty legacy `actions` array and its complete `jigProgram`. Provider schemas narrow those unused legacy branches accordingly. No string `"null"`, numeric string or other malformed value is coerced into a valid candidate. Tool failures identify exact Zod field paths and types. Geometry feedback includes shared resolver rectangles/anchors, exact support duties and source/output exclusion regions.

Earlier `carton_packing` and `electronics_kit` records and actual API fixtures are retained as historical software evidence. They do not describe the newly selected primary workflow. The kit fixture represents individually counted inert mechanical parts and independent cell closures; it establishes no ESD/electrical/transport protection or physical performance. Historical requests are not relabelled as tests of the workshop schema.

SAM, Muse Image, Muse Wonder and open-weight models are not required by this first implementation. No claim is made that those APIs were exercised.

## Verified API contracts

Official documentation reviewed on 2 November 2026:

- [Models](https://dev.meta.ai/docs/models)
- [Responses](https://dev.meta.ai/docs/protocols/responses)
- [Structured output](https://dev.meta.ai/docs/structured-output)
- [Tool calling](https://dev.meta.ai/docs/tool-calling)
- [Video understanding](https://dev.meta.ai/docs/video-understanding)
- [Files](https://dev.meta.ai/docs/file-handling)

Responses schemas use **`text.format`**, not top-level `response_format`. Zod projects a closed JSON schema with all object fields required; returned data is validated again locally. MP4 is uploaded with `purpose: "user_data"` and referenced through `input_file`. PNG/JPEG use `input_image` data URLs. The application owns size/type/decode validation.

The reviewed Meta video guide does not state a maximum clip duration. The Files guide documents a 1 GiB Files API upload maximum, a 50,000,000-byte inline-file maximum and 100 GiB team storage. The app's shorter duration/size policies are application choices, not Meta duration guarantees. In particular, allowing an uninterrupted workshop trial up to 180 seconds does not mean a real 180-second inference was tested: the integration video here was a generated one-second MP4. An assembly-and-release trial must not be represented as a complete cycle by joining separate clips or assuming completion within 60 seconds.

The live endpoint rejected a named function `tool_choice` with HTTP 400 and explicitly reported that only **`"auto"`** is supported. The adapter was corrected to use `auto`; it does not use `required`, named choices, or `none`. All completed function calls are paired with `function_call_output` using **`call_id`**, and instructions are resent on continuation.

The SDK has automatic retries disabled. A three-tool-round budget bounds continued inference. When all requested checker calls return valid results with no hard errors, the next continuation explicitly removes available tools and requests the checked proposal as final strict JSON. Failed checks keep the repair tool available within the same budget. Local final checks still run even if the model does not call a tool or changes its final output. Schema-valid output does not imply physical feasibility.

## Actual integration checks

The real participant-account run, using only generated synthetic assets, established:

| Check | Observed result |
| --- | --- |
| Authenticated model catalog | HTTP 200; `muse-spark-1.3` available |
| Strict structured output and function continuation | Returned the locally computed tool result in the required schema |
| Generated PNG input | Valid observation; marked incomplete |
| Generated one-second MP4 upload/reference | Valid observation; marked incomplete |
| Initial constrained candidate | Two checker tool rounds corrected initial plan failures; final candidate had no hard errors under the then-current checker |
| Four-group repair-kit candidate | 38 explicit actions; 4 screws, 4 washers, 2 spacers and 2 grommets individually loaded into matching cells; all local closures and dispatch/reset present; current hard checks and compiler passed |
| Current workshop jig candidate | 23 actions, six split exterior braces, explicit gate engagement/release/parking and forward extraction/reset; model corrections passed final local checks and jig construction compilation |

The initial candidate generation took **84,741 ms** across three provider responses. The complete catalog/tool/image/video/planning smoke took **120,094 ms**. These are observations from one synthetic case, not latency guarantees or a benchmark. Actual returned usage was recorded rather than estimating a price from undocumented assumptions.

The checker was subsequently hardened to require explicit insert placement, a held finished carton before release, and station interactions at measured station coordinates. A second planning-only run passed those checks and compiled successfully: **12 actions, two checker tool rounds, 83,673 ms**. Retrieving its known provider response returned the identical proposal without another generation POST. Its reviewed output is recorded in `fixtures/recorded-meta-plan.json`.

An explicit `allowedOperations` capability field was added while that request was in flight. The fixture preserves the exact request facts without that field, and separately records successful local revalidation against the new all-allowed synthetic profile. It does **not** claim that this provider request tested a restricted operation profile. Subsequent live requests include and respect that field.

This fixture is an explicitly recorded response on synthetic facts, not evidence of real construction or successful operation. It must remain visibly labelled if replayed in a demonstration.

An earlier electronics-kit workflow was separately exercised once using synthetic complete-group measurements and the current schema. Spark returned **38 explicit actions across two checker tool rounds in 119,838 ms**. The first checker result identified a self-supporting reset; the model corrected it, checked again and returned a candidate with no hard errors. Each required part has its own quantity-one take/load pair, each matching cell closes after its declared count, and the outer carton closes after all cells and the inventory slip. Construction compilation passed. The reviewed actual input, output, usage and tool feedback are saved in **`fixtures/recorded-meta-kit-plan.json`**. Later capability hardening was checked locally against that same response without another paid request. This validates the software/API contract; actual counts, separation, closures and one-handed performance still require physical trials.

## Recovery and honest limits

`onTrace` lets the worker persist provider response IDs, uploads, usage and tool results as completed stages arrive. `recoverResponse` can retrieve a known final response without another paid generation POST. It refuses a response still waiting for tool continuation; it does not blindly re-execute tools or claim unknown interrupted requests were free. Files uploaded by smoke tests are deleted, and application upload IDs remain available for recorded cleanup.

`npm run smoke:meta -- --plan` sends actual requests and incurs actual account usage. It is optional for ordinary offline tests. No test here proves carton loading, fixture stability, closure force, extraction, reset, operator benefit, segmentation behavior, every SDK feature, or hackathon compliance. Those claims require their respective evidence.

`npm run smoke:meta -- --kit` runs only a synthetic multi-part kit planning case against the current checker and compiler, without repeating the image/video tests. It writes a recorded fixture only after the candidate includes the required group/compartment transitions and passes hard checks. A recorded response remains software/API evidence, never a physical trial.

`npm run smoke:meta -- --workshop` is the focused workshop planning check. It uses synthetic supplied-panel measurements and tests model output against the current jig/support/access/release checker and compiler. Its output is saved as a recorded API fixture only after successful checks; this is never a physical assembly trial. A workshop API result must be reported separately from historical packing/kit smoke results.

The first live workshop planning attempt exhausted the three-round checker budget and was rejected. It created no accepted final candidate or construction fixture. That initial CLI did not persist its intermediate response IDs and usage before exiting, so those details remain **unknown**, not zero-cost or a recorded success. The application worker already persisted per-stage traces; the CLI now does too (`data/verification/meta-workshop-progress-*.json`), and generation errors retain safe response/usage/tool trace metadata. Safe local attempt summaries are retained in the ignored durable folder at `data/verification/meta-workshop-attempts.json`. The finalization correction above is covered by offline SDK mocks: a repeat-checking provider must finish after a successful check; an invalid candidate retains repair tools; persistently invalid candidates still fail the unchanged budget.

A subsequent traced attempt exposed a concrete contract failure: a retrieved completed tool call contained `program: "null"` as a **string**, rejected by local validation. Other calls also failed schema validation, but the initial generic tool error did not identify their fields. A read-only retrieval confirmed the quoted-null case; no generated value was manually repaired. That attempt ended with HTTP 503 on a further continuation and no accepted candidate. Its three known responses account for **50,937 returned usage tokens**; usage/outcome of the failed final request remains unknown. This motivated the direct-jig tool contract, precise error feedback and narrowed final schema described above. Offline orchestration tests verify those contracts and preserve rejection of invalid output. Historical packing/kit successes do not establish workshop readiness.

The contract-corrected workshop attempt **passed**: Spark produced a real final candidate with **23 actions and six exterior braces in 149,724 ms**, across three checker rounds and four completed provider responses (**69,891 returned usage tokens**, including reasoning and repeated context; no monetary-cost estimate). The model corrected front staging/part/gate/supply targets, then a self-dependency, using local feedback. Its final proposal passed current support/access/material/release checks and construction compilation without manual editing. The actual synthetic input, final output, complete usage and checker history are preserved in [the recorded workshop API fixture](../fixtures/recorded-meta-workshop-plan.json). This is evidence of the software/API loop, not a physical trial, a tested insertion force or a demonstrated adaptation from physical failure.

After that successful run, model-bound feedback was compacted offline: every error/warning and required physical test remains, along with the base/workpiece/gate/release/finished rectangles, exact target anchors, support IDs, measured joint zones and material minimum. Full local checks/geometry remain in audit traces. On the recorded run's three tool results, model-feedback JSON shrank from 10,199/7,964/7,771 bytes to 5,666/3,422/3,230 bytes. Offline tests prove the errors, uncertainties and required targets are preserved. Those byte reductions are not a measured latency or billing improvement; no additional paid request was made for this optimization.
