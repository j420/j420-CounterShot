# Meta flow implementation

3 November 2026. Scope: grounded context, decisions, evidence, recovery, model execution and jig check provenance. No deployment or environment publication is part of this change.

## Implemented sequence

| Action | Implemented behavior |
| --- | --- |
| Request → answer → resume | Durable requests retain their source turn/frame/hash, purpose, phase, scene, facts, plan and check versions. New photos explicitly answer a saved request and must have different pixels. Numeric prerequisite answers require the exact unit and operator confirmation. Unknown facts can be filled; changing an existing confirmed fact requires a deliberate reset. Answers, cancellations and retries do not automatically start inference. |
| Prediction comparison | Every active prediction is immutable. Comparisons name that exact prediction and current evidence, with `supported_by_view`, `contradicted` or `unresolved` conditions. The original root, active child and physical before-view anchor remain separate. Supported comparison never completes a phase. |
| Bounded recovery | A correction names the failed prediction, changed hypothesis, retained failed conditions and next discriminating observation. Its correction must equal the single proposed action. A root permits three recovery attempts; repeating the same evidence information is rejected. Successful bounded actions can have follow-on child predictions without inventing failure. |
| Object and claim memory | The application assigns physical entity identities only after explicit operator binding to a located current observation. Model matches remain hypotheses. Multiple candidate identities hold manipulation/review. Claims and actual failed reports retain exact evidence and version provenance; newer praise does not silently remove counterevidence. |
| Actual rechecks | A person can save actual result readings and confirmations without advancing or calling a model. Null readings do not erase earlier values. Passing a numeric reading alone cannot erase another reported failure. Complete positive operator rechecks can resolve retained claims while preserving their original records. |
| Targeted evidence retrieval | When relevant owned history and allowance exist, Spark may request one earlier camera frame or crop. The resolver accepts owned IDs and bounded regions, verifies the entire source buffer and uses those same bytes for decoding. The finalization receives a labelled historical image and manifest. Retrieval does not refresh its capture time. |
| Checked plan changes | Meta can propose bounded guidance within the current phase or reopen an earlier mandatory phase. The application checks exact parent, state, scene, facts and owned counterevidence. Operator acceptance creates a plan version, invalidates affected progress and requires a fresh view. Mandatory catalog checks cannot be removed, skipped or reordered. |
| Aggregate execution budgets | Actual POSTs reserve a durable allowance before the request. Immediate continuations share it. Tool batches are bounded before their first execution. Trace callbacks do not consume calls. Late responses merge into the latest budget without erasing newer work, cancellation or known usage. Resets do not refill a camera run. |
| Model capability validation | Only the implemented Spark 1.3 binding can serve the camera, observation and planning routes. Unsupported `META_MODEL` settings fail before media uploads or inference. Modality, tool, output and timeout limits are explicit. |
| Jig check provenance | Traces separately hash actual tool candidates and the final proposal, retaining facts/checker versions and actual check results. A changed final proposal is visibly different and receives fresh final checks. Known-response recovery retains tool history and recomputes the final proof. |

## Evidence and execution limits

Jig source allowances remain eight files, 100 MiB and 360 seconds; failed-trial evidence has separate capacity of four files, 50 MiB and 180 seconds. Each file is limited to 50 MiB. Every selected file is verified before the first upload; partial upload IDs remain auditable if a later transfer fails.

Camera historical retrieval has a 20-frame owned catalog, one read per turn, 300 KiB input/output bounds, a 1,600-pixel source bound and a 960-pixel derived-image bound. Crop/resize work uses verified stdin bytes, bounded output and a timeout clamped to the shared deadline. No paths or URLs are model parameters.

| Route | Invocation allowance | Reserved output ceiling | Tool allowance | Elapsed ceiling |
| --- | --- | --- | --- | --- |
| Camera run | 20 shared requests | 120,000 tokens | 20 total, at most one per response | One hour |
| Observation job | One request | 10,000 tokens | None | Two minutes |
| Planning/revision job | Four shared requests | 80,000 tokens | 12 total, at most four per response | Eight minutes |

These are application policies, not billing estimates or provider-capacity claims. Ordinary camera inspections use one request. An owned evidence read permits one finalization, for at most two requests in that turn. Both consume the same run allowance. Known actual usage is deduplicated by response identity; unknown outcomes remain explicit. Media uploads, transforms, model calls and tools share the relevant deadline. No automatic inference retries are enabled.

The current contracts are camera schema/engine `3.0.0`, prompt `camera-decision-3.0.0`, context `camera-context-v3`, model bindings `meta-bindings-v1` and execution records `model-execution-v1`. Older sessions remain readable and require explicit reset before current progression.

## Validation

The final verification record is maintained in [the four-eyes review](meta-flow-four-eyes-review.md).

Six fresh synthetic diagram challenges were sent to Meta Muse Spark 1.3, once each, with expected scoring rules withheld from model input. All six passed: obscured identity, changed workpiece, an actual reported failed reading, visible instruction injection, a supported visible prediction and a hidden reverse relationship. All six known response IDs, inputs, source-image hashes, timings, usage, traces and execution records are preserved in [the evaluation archive](evaluations/meta-flow-v3-2026-11-03/summary.json). Known usage totals 61,746 tokens; observed latency spans 11.6–22.9 seconds.

Offline replay of those exact paid outputs exercises the actual current controller, with no additional inference. It verifies image hashes, immutable predictions, held requests, scene invalidation, retained failed readings and zero automatic phase advances. The ordinary v3 wire was live-tested; the owned-read/crop/finalization path has actual endpoint and mocked SDK integration coverage, rather than a new live transport run.

To replay the archived results without a model call:

```sh
MODEL_API_KEY='' node --import tsx scripts/meta-flow-evaluation.ts --replay=docs/evaluations/meta-flow-v3-2026-11-03
```

## Deliberate boundaries

Only Muse Spark 1.3 is integrated. SAM, Wonder, voice transcription and additional critique calls are not activated. They require an explicit adapter, capability verification and evidence of benefit before joining this budgeted flow.

The live challenges are synthetic diagrams, not photographed physical trials or an independent physical benchmark. Their success does not establish real-object performance, force, fit, stability or physical completion. An image-supported comparison is not a measured physical pass.

Within-phase plan substeps are checked, scoped guidance. They are not an independently verified executable sequence. Existing mandatory phase checks and actual operator readings remain the progression authority. The evidence tool retrieves camera stills/crops; jig source videos retain the existing verified direct-media path.
