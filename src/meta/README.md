# Meta integration

CounterShot uses **Meta Muse Spark 1.3** (`muse-spark-1.3`, Standard mode) for evidence-linked observation, constrained co-design, checker feedback and failed-trial revision. The endpoint is `https://api.meta.ai/v1`; the OpenAI TypeScript SDK is a transport client, not the inference provider.

The primary `workshop_jig` profile designs passive exterior supports, split/relocated braces, a removable front gate and a staged assembly sequence for a supplied pre-cut low-force instrument-enclosure mockup. The workpiece/joints are immutable inputs. Supports take over holding/alignment duties while preserving joint access; gate release/parking, forward extraction and reset are explicit. Joint retention, force/friction and actual operation require physical trials. Historical `carton_packing`/`electronics_kit` records and actual API fixtures remain distinct rather than being relabelled as workshop evidence.

The server reads `MODEL_API_KEY`. It never returns that credential to the browser. In the managed cloud environment, `EnvHttpProxyAgent` preserves the inherited HTTPS proxy and CA trust so destination-bound credentials are injected by the platform. On another host, configure the same server-side variable through that host's secret manager. Never use a `NEXT_PUBLIC_` key.

## Contracts checked against official documentation

Reviewed 2 November 2026:

- https://dev.meta.ai/docs/models
- https://dev.meta.ai/docs/protocols/responses
- https://dev.meta.ai/docs/structured-output
- https://dev.meta.ai/docs/tool-calling
- https://dev.meta.ai/docs/video-understanding
- https://dev.meta.ai/docs/file-handling

Responses structured output uses **`text.format`**, with a closed required-field JSON schema and local Zod validation. MP4 uses Files upload (`purpose=user_data`) followed by `input_file`; JPEG/PNG use `input_image`. The application separately validates files before this boundary. The live API currently accepts only **`tool_choice: "auto"`**: named choices, `required` and `none` returned HTTP 400 during integration testing, so these are not used.

The planner can call only `check_task_plan`. Each `function_call_output` matches its `call_id`. A three-round budget bounds tool continuation, and pure checker results are cached per response/call pair. The application runs its own final checks before construction release. SDK retries are disabled so every paid attempt remains explicit.

`onTrace` persists uploaded file IDs, completed provider response IDs, usage and tool results while processing. `recoverResponse` retrieves an already known final response without another generation POST. Pending tool continuations are explicitly reported rather than blindly replayed. Unknown request outcomes remain uncertain; app deduplication is not a provider idempotency guarantee.

Observation without an MP4 is always marked incomplete. Failed-trial media is supplied to revision planning alongside confirmed measurements, the previous design and human feedback. A model response never creates a physical pass. SAM remains optional and is not implemented in this first path; synthetic walkthroughs are explicitly labelled.

## Integration evidence

`npm run smoke:meta -- --plan` makes real paid requests with **synthetic** PNG/MP4 assets. It checks model availability, strict output, a complete function continuation, image observation, MP4 upload/reference, and optionally one constrained plan. Uploaded synthetic files are deleted at the end. Successful execution is API/contract evidence only; it is not packing or accessibility evidence.

The first actual account run passed strict output, tool continuation, PNG input, MP4 file/reference input and a planning candidate that corrected checker errors over two tool rounds. Physical admission, actual operator footage and real-world benefit remain untested until supplied and recorded.

The earlier `electronics_kit` profile also passed one real planning-only run: 38 actions, two checker rounds, 119,838 ms, exact individually declared transfers for 4 screws/4 washers/2 spacers/2 grommets, four local closures, inventory slip, outer closure, extraction/reset, current hard checks and compiler. `fixtures/recorded-meta-kit-plan.json` preserves that actual response on synthetic facts. It is not evidence of a physically fulfilled kit. Use `npm run smoke:meta -- --kit` only when intentionally spending account usage to repeat that integration check.

`npm run smoke:meta -- --workshop` exercises the current jig profile only. Its first live attempt exhausted the checker budget and did not create an accepted fixture; its unpersisted intermediate IDs/usage are unknown. The orchestrator now removes tools after successful checks to require final strict output, keeps repair tools after failures and preserves the same three-round limit. CLI stage/error traces are persisted for diagnosis. Physical joint insertion, support force, completed-joint retention and extraction still need actual parts and trials.

A traced attempt then revealed quoted-string `"null"` in outer tool arguments and ended with HTTP 503 before acceptance. Workshop tools now accept the jig programme directly; only the final response uses the complete proposal, with unused legacy fields narrowed to literal JSON null/empty array. Invalid values receive precise field-path feedback and are never coerced. The validation envelope used around direct tool arguments is never a published design. Offline tests cover repair, finalization and unchanged-budget failure behavior.

The corrected real workshop run passed: **23 actions, six braces, three checker rounds, 149,724 ms**, final strict output plus current local checks/compiler. Actual synthetic input/output/traces are in `fixtures/recorded-meta-workshop-plan.json`; local failed-attempt summaries are in ignored `data/verification`. Full checks/geometry stay in audit traces while future model feedback is compacted to relevant errors, physical tests, rectangles, anchors and support duties. The compaction was verified offline; no extra paid request was made. All physical claims remain untested.
