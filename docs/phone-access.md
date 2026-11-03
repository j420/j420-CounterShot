# Using CounterShot from a phone

The intended entry point is one **HTTPS web address**, opened in the phone's normal Safari or Chrome browser. Open the **Camera workbench** for interactive frame-guided work. A run can stay on that phone from target confirmation through checks and failed-attempt recovery; no computer transfer or app installation is required.

## Camera workbench

The [simplified interface](ui-simplification.md) keeps a three-step diagram and a short explanation of the expected photo or video result. Longer instructions and history are expandable; the next action, expected change and stop condition stay visible.

1. Open `/camera`, choose one of the five workflows and confirm the actual target, permitted resources and measurements. Unknown facts stay unknown.
2. Start the rear-camera preview. It stays on the device; inspect the selected setup frame when ready. A JPEG/PNG checkpoint is a fallback with unknown actual capture time.
3. Review the model's proposed next move, expected visible result and stop condition beside the preview. Its boxes belong to the saved assessed image, not the moving camera feed.
4. Perform the permitted action and inspect a new after-view. Under **Watch options**, the optional **Watch this step** sends at most three sequential checks and stops on uncertainty, an error or a scene change. You can stop it; an already running request may still finish.
5. Enter actual numeric readings and physical checks. Above/below-limit results cannot pass because a checkbox is checked. Record a failed or incomplete attempt, correct the specific issue and obtain new evidence before retrying.
6. Complete each phase with an explicit operator review. Undo and fact/scene reset retain the earlier review history. The final status records the reviews; it does not certify physical performance.

Response age uses the server's receipt clock plus monotonic elapsed time, so a phone wall-clock change cannot extend guidance freshness. Stale, occluded, uncertain or changed views hold actions and confirmation. Actual returned synthetic-image checks took 6.7–11.2 seconds; this is not instantaneous tracking or a latency guarantee.

The five profiles are branching harness routing, dry-fit fragment reconstruction, non-loadbearing webbing threading, dry gasket seating and an open gravity-fed water manifold. See the [iteration record](camera-iterations.md) for their exact scope and first real trial.

## Jig-design companion and full trial videos

1. Open the hosted link, enter the workspace access code and create a project.
2. In Observe, use **Record video**, **Take photo** or **Choose existing files**. Native camera buttons ask the browser to open the rear camera where supported; other browsers may show a file chooser. The application does not start a live stream or silently record.
3. Film the original method and its actual holding/alignment conflict. A generated jig is not required for this first recording. If the original operation is blocked, show that blockage and identify any separately assisted demonstration.
4. Upload the clip. The saved confirmation points to **Analyze the job**; uploading alone does not request inference. Review the inferred actions and open questions, then confirm actual measurements and permitted operations. Meta inference runs on the server with its configured key.
5. Review the proposed jig and sequence. Download/print the templates at actual size, then record the exact physical build and readiness checks.
6. In Test, record or select one uninterrupted video of the actual attempt. Use a mounted phone or a person filming so operating help is not hidden. Inspect alignment and all required criteria, then save the review or revise from the selected failed/incomplete attempt.

The workshop upload policy is initially 180 seconds and 50 MiB per file. Lower the phone recording resolution if necessary; do not cut out a failed step to fit the policy. A still photo does not establish completion of a physical cycle. Existing HEIC photos may need JPEG/PNG export.

MOV, M4V, WebM and incompatible MP4 recordings are converted to a playable MP4 copy when necessary. The original recording is retained unchanged with its hash and can be downloaded privately. Conversion must preserve the video frame count and duration; it cannot trim an incomplete copy into acceptable evidence. Both retained copies count toward the project storage limit.

## Current project access

Keep using the **same browser profile** on the phone. The access code opens the application; project ownership additionally uses that browser's private session cookie. Opening a project URL on another phone or computer does not transfer ownership. Account login, device pairing and project sharing have not been implemented. Export evidence and drawings before clearing browser data.

Phone layout and camera-input wiring can be checked in Chromium automation. Native camera behavior, codec handling and playback still need a real iPhone/Safari and Android/Chrome check on the final HTTPS deployment.

[Phone capture preview](screenshots/phone-capture.png) shows the running interface on a synthetic project. Its test server deliberately has no provider key; it is not a live public link or a recorded physical trial.

[Camera workbench preview](screenshots/camera-workbench-mobile.png) shows the new primary interface with an explicitly synthetic browser-test scene. Its hypothetical action is an offline UI fixture, not a result from a photographed operation.

## URL and hosting status

Vercel is the requested public host. **No public deployment or working phone URL has been created.** The current development environment supplies no public preview endpoint or deployment identity.

The selected arrangement is Vercel plus one persistent Node backend for SQLite, private media, ffmpeg and the job worker. Small API requests use the frontend; large recordings go directly to the backend with a short-lived project-scoped, one-use upload ticket. The phone does not need a second login or a Meta key for that transfer. The exact frontend origin and upload authorization are checked by the backend.

Routing and direct uploads are implemented and locally verified over HTTPS with the Docker backend, including a recording exceeding the frontend upload limit and persistence after restart. An actual Vercel/backend deployment still needs connected hosting accounts and its final URL checks. See the [deployment settings](vercel-deployment.md). The Meta key must be configured on the actual inference backend and must never be exposed in the phone page.
