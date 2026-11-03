# Simpler phone and desktop flow

Updated on 3 November 2026. The home page offers **Open camera** and **Workshop video**, a compact **show → understand → try & check** diagram, and saved work. Longer explanations are collapsed. Starting a workshop task asks for a goal and a finished outcome; the project title is drafted from the goal.

Step numbering has been removed from the home, camera and workshop flows. Arrows and stage icons communicate the sequence. Measurements, review budgets and exact revision identities retain their meaning.

The camera workbench opens the rear preview and asks for one goal, with optional context. After analysis, the exact assessed photo occupies the same stage. An explicit retake restores the live view. The proposed workflow, next missing detail or next action appears in the same workspace. Detailed observations, model information, watch options and history are expandable. Expected change, stop condition and actionable warnings stay visible. Required facts and physical-review gates remain in place.

Workshop camera buttons open an inline rear preview for photo or video. Captures stay local until explicitly accepted; a failed save retains the capture for retry. Recording duration and bytes are bounded. Permission failures, unsupported recorders and existing files have explicit fallbacks. A successful upload points to **Analyze the job**. Uploading alone starts no inference. Trial recording still requires an uninterrupted video and an actual outcome review.

Recording instructions, file-format help, saved uploads and project details are expandable. Main navigation shows Camera and Projects; Workbench and Evidence appear within a project.

## Verification

The current changes passed 40 camera browser journeys and 17 workshop/capture journeys, including real JPEG/MediaRecorder capture from Chromium's synthetic camera, local backend validation, explicit save/analysis, failed-save retry, camera permission races and stream cleanup. A focused check also loaded and played the captured clip. Responsive checks cover narrow phone layouts and confirm that the preview stays inside its panel. See the [camera-first verification record](camera-first-experience.md) for the separate live Meta check and current previews. Real-device and production transport checks remain pending.

## Earlier UI previews

These screenshots show the running application using isolated local storage and clearly labelled interface/test inputs. They are interface previews, not physical results or live Meta evaluations.

| Screen | Phone | Desktop |
| --- | --- | --- |
| Home and upload expectations | [Phone](screenshots/simple-home-phone.png) | [Desktop](screenshots/simple-home-desktop.png) |
| Camera setup | [Phone](screenshots/simple-camera-start-phone.png) | [Desktop](screenshots/simple-camera-start-desktop.png) |
| Workshop upload | [Phone](screenshots/simple-upload-phone.png) | [Desktop](screenshots/simple-upload-desktop.png) |

## Colour directions

The current [bold comparison](screenshots/bold-color-directions.png) and [interactive concept preview](bold-color-directions.html) explore saturated foundations and less conventional accents. **Oxblood & Volt** is recommended: deep burgundy, electric citron actions, warm chalk text and small coral details. Ultramarine & Papaya and Sulfur & Grape provide saturated and bold daylight alternatives. These remain appearance proposals; the application theme has not been changed.

The [larger Oxblood workspace preview](screenshots/bold-oxblood-preview.png) shows the colours in a proposed interface. Camera imagery remains neutral. All three palette switches and five responsive widths (320, 390, 768, 1024 and 1500 pixels) passed local browser checks. The specified body and button text/surface pairs exceed 4.5:1 contrast. The artifact has no camera, upload or inference functionality.

The earlier [four-palette study](color-palettes.html) remains available as historical design exploration.
