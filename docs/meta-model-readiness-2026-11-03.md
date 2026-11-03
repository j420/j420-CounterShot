# Meta models and agent-flow readiness — 3 November 2026

**Historical review, superseded for implementation status:** request/answer resumption, structured comparison/recovery, entity memory, bounded owned evidence retrieval, scoped plan changes, shared budgets, model capability validation and jig provenance are now implemented. See [current implementation](meta-flow-implementation.md) and [four-eyes review](meta-flow-four-eyes-review.md). The v3 ordinary reasoning contract has six successful new live synthetic cases. Additional models remain unintegrated.

**The current development Meta connection is configured and authenticated. The expanded agent flow is not fully implemented.** Only Muse Spark 1.3 is wired into the application today. Model catalog availability, application integration and validated end-to-end reasoning are separate states.

Implementation update: original source media now survives observation, planning and parent-bound revision. Camera turns now use an exclusive decision contract and canonical context that retains the original prediction. See [grounded-context implementation progress](meta-grounded-context-progress.md). The source-media and mixed-decision gaps below describe the earlier review state; explicit request/answer resumption, structured comparison/recovery, aggregate role budgeting and additional model integrations remain pending. The new v2 decision wire has offline coverage and has not been live-retested.

Scope: model choice, integration and agent-flow readiness only. Two independent source reviews and a primary cross-review checked the actual runtime against the proposed flow. No application behavior or environment configuration was changed.

**Fresh checks**

- Managed environment observations were current: `MODEL_API_KEY` was ready for `api.meta.ai`, with the network policy enforced.
- The existing SDK client successfully read Meta's authenticated model catalog at **2026-11-03 06:31:04 UTC**. The selected `muse-spark-1.3` was listed. No inference request was made during this check.
- The catalog also listed `muse-wonder-1.0`, `sam-3.1`, `muse-voice-transcribe-1.0`, `muse-image-1.0`, older Spark versions and Contributor variants. Listing alone does not validate each model's inference permission, quota, response contract or quality for our use.
- **25 existing model integration/schema tests passed offline**, zero failed or skipped. They use mocked SDK responses and recorded fixtures; they are not new live generations.
- The current [Meta model documentation](https://dev.meta.ai/docs/models) was read to check the proposed role mapping. Documented capabilities are not CounterShot-specific measured performance.

**Recommended model stack and exact current status**

| Model | Recommended role | Integration status |
| --- | --- | --- |
| **Muse Spark 1.3 — `muse-spark-1.3`** | Required default reasoning model: requested image/video interpretation, next-decision planning, ordinary comparisons and routine recovery. | Implemented. Existing recorded live requests cover images, video, structured output and checker-tool continuations. The latest camera prompt has offline coverage; it was not live-retested during this review. |
| **SAM 3.1 — `sam-3.1`** | On-demand perception tool when object masks or clip tracking materially help ground the selected target. | Catalog-listed, **not integrated**. No SAM adapter, segmentation parser dependency or model binding exists. Masks do not establish dimensions, semantic identity or task completion. |
| **Muse Wonder — `muse-wonder-1.0`** | Candidate selective escalation for difficult multi-step replanning or a consequential contradiction. | Catalog-listed and documented for agentic reasoning, tools and multimodal input, but **not integrated or compared with Spark here**. Introduce only after a matched flow-level comparison justifies its latency/usage. It is not automatically a more accurate verifier for this domain. |
| **Muse Voice Transcribe — `muse-voice-transcribe-1.0`** | Optional spoken operator input. | Catalog-listed, **not integrated**. It returns transcripts, not synthesized speech or speech-to-speech conversation. Existing read-aloud is browser speech synthesis. |
| **Muse Image — `muse-image-1.0`** | No dependency in the current reasoning/construction flow. | Catalog-listed, **not integrated**. Construction geometry and SVG output remain the checked compiler's responsibility. |
| **Open-weight Meta models** | No selected role in this implementation. | No local/provider runtime binding exists; they are unnecessary for defining multiple agent responsibilities. |

The model strategy remains conditional. A normal camera turn should use one combined Spark observation/decision request plus local checks. Spark can request a SAM-backed tool when target segmentation is useful. A subsequent evidence turn compares the original prediction. Wonder is a proposed selective escalation, not an extra mandatory step in every interaction. Voice is optional input, not a prerequisite for the reasoning loop.

**What is already working**

- The server-side client points at `https://api.meta.ai/v1`; the compatible SDK is transport, not another inference provider. Proxy and TLS trust are preserved. See [client](../src/meta/client.ts:5).
- Camera assessment sends a current image, a selected comparison, confirmed facts and recent same-phase/scene operator reviews. It returns strict observations, next action, expected result, stop condition and questions. That path explicitly rejects model function calls. See [camera adapter](../src/camera/meta.ts:69).
- Jig planning already supports the `check_task_plan` function loop, specific checker feedback, bounded revision and strict final output. The worker rechecks the actual final proposal before compilation/publication. See [planner](../src/meta/index.ts:93) and [final validation](../src/jobs/process.ts:106).
- Response identity, known usage, tool results, cancellation and execution-version fences are established integration strengths. Suspected media-upload trace loss was investigated and not confirmed: upload IDs are retained through trace callbacks and worker trace merging.

**Critical remaining gaps**

| Priority | Finding | Consequence |
| --- | --- | --- |
| P1 | There is one global arbitrary `META_MODEL` string, not a capability-checked model router. | Replacing it with SAM, Muse Image or another catalog entry would send that model the existing Spark-oriented schema/tool/media assumptions. Each capability needs an explicit binding and adapter. |
| P1 | The proposed decision controller is documentation, not runtime code. | Typed evidence requests, waiting/answer semantics, stable entity memory, prediction records and selective role routing still need implementation. |
| P1 | Initial planning receives observation text without original media. Only `trialAssets` are attached by `plan()`. | A relation omitted by observation can be lost at the handoff. Add source references and bounded relevant evidence retrieval. See [plan input](../src/meta/index.ts:245). |
| P1 | Current limits apply to individual requests or tool rounds. | They do not impose one aggregate deadline/token/tool/call budget across future role invocations. A response can also request several tools within one round. |
| P1 | Additional models and new agent decisions lack current contract/reasoning evaluation. | Successful catalog access and existing Spark mocks cannot establish that SAM parsing, Wonder escalation or the expanded flow works. |
| P2 | Tool-checked candidate identity is not bound to the final model proposal. | A mocked-SDK review accepted a tool-checked base width of `240`, followed by a valid final width of `240.01`. Retain candidate/final hashes and final-validation provenance if promising exact checked-candidate fidelity. This is **not a constraint bypass**: final checks run again on the actual final proposal. |

P1/P2 here describe model-flow design/readiness work, not newly discovered security-vulnerability severity. These findings do not justify loosening the current state, evidence or outcome gates.

**What “all set up” must mean for this flow**

The exact model assignment, allowed modalities, structured-output schema, tools, reasoning settings, request/token allowance and failure policy must be explicit for each route. Capability availability must not be inferred only from a model name. Additional model calls need independent invocation IDs and traces while sharing the same run budget and canonical task context.

The following remain required for the expanded flow:

- An explicit decision contract for requesting a view/measurement, proposing an action/change, requesting operator review or holding.
- Source-evidence retrieval across reasoning handoffs, with exact IDs/hashes and current versus historical provenance.
- Stable entity identity, original predictions and negative history separated from confirmed facts and model hypotheses.
- Completed model decisions that persist an application waiting state; answers begin fresh bounded turns.
- Evidence-based comparison and recovery that changes a hypothesis or asks for new information rather than repeating advice.
- Aggregate budgets, role-specific versions and context fences before every additional model request or continuation.
- Contract checks for each added model and measured comparisons establishing whether specialist calls improve the particular reasoning failure they target.

There is no model-callable authority to rewrite confirmed measurements, relax constraints or commit completion. A second model opinion remains advisory. The more detailed [model-flow review](meta-agent-flow-review.md) specifies the proposed decision and context boundaries.

**Readiness conclusion:** the existing Spark integration has a working authenticated development connection and earlier live contract evidence. The current camera assessment and jig tool loop are implemented. The fuller agent orchestration and all additional-model adapters remain proposed work. No new generation, extra model integration, production change or claimed new reasoning result was performed by this review.
