/** One optional paired-image transport probe; no physical completion is asserted. */
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { assessCameraFrame, CAMERA_PROMPT_VERSION } from '../src/camera/meta';
import { applyCameraAssessment } from '../src/camera/engine';
import type { CameraSession, CameraTurn } from '../src/camera/schema';
import type { ModelTrace } from '../src/meta';
import { MetaError } from '../src/meta/client';

const flags = process.argv.slice(2);
if (flags.some(flag => flag !== '--live')) throw new Error('Use no arguments for offline rendering, or --live for exactly one explicit paired-image request.');
const live = flags.includes('--live');
const fixturePath = path.resolve('fixtures/recorded-meta-camera-comparison.json');
if (live && existsSync(fixturePath)) throw new Error('The recorded comparison already exists. It will not be overwritten or silently billed again.');
const runDir = path.resolve(process.env.DATA_ROOT || 'data', 'verification', `camera-comparison-${live ? 'live' : 'offline'}-${Date.now()}`);
await mkdir(runDir, { recursive: true });
const aggregate = JSON.parse(await readFile('fixtures/recorded-meta-camera-assessments.json', 'utf8'));
const before = aggregate.outcomes.find((outcome: { workflowId: string }) => outcome.workflowId === 'harness_routing');
if (!before || before.status !== 'assessment_returned' || before.input.session.beforeTurn !== null || before.input.session.completedSteps.length)
  throw new Error('The expected unadmitted synthetic before record is unavailable.');
const previousFramePath = path.resolve(before.imageArtifact);
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const previousBytes = await readFile(previousFramePath);
if (hash(previousBytes) !== before.image.sha256) throw new Error('The previous diagram no longer matches its recorded image.');

const text = (x: number, y: number, label: string, size = 20, color = '#182635') => `<text x="${x}" y="${y}" font-size="${size}" fill="${color}">${label}</text>`;
const node = (x: number, y: number, label: string, color = '#cbd5e1') => `<rect x="${x - 35}" y="${y - 24}" width="70" height="48" rx="6" fill="${color}" stroke="#334155"/>${text(x - 25, y + 7, label)}`;
const drawing = node(160, 300, 'TRUNK') + node(760, 180, 'P1') + node(760, 320, 'P2') + node(760, 460, 'P3')
  + `<path d="M195,286L390,180L725,180" fill="none" stroke="#2563eb" stroke-width="12"/>`
  + `<path d="M195,300L390,320L725,320" fill="none" stroke="#c026d3" stroke-width="10"/>`
  + `<path d="M195,316L390,460L725,460" fill="none" stroke="#16a34a" stroke-width="10"/>`
  + text(520, 155, 'BRANCH A', 22, '#2563eb') + text(520, 294, 'BRANCH B', 22, '#a21caf') + text(520, 435, 'BRANCH C', 22, '#15803d')
  + text(250, 540, 'TARGET: A-L-P1; B-M-P2; C-R-P3')
  + node(390, 180, 'L', '#fef3c7') + node(390, 320, 'M', '#fef3c7') + node(390, 460, 'R', '#fef3c7');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640" viewBox="0 0 960 640"><rect width="960" height="640" fill="#f8fafc"/><style>text{font-family:Arial,sans-serif}</style>${text(25, 40, 'SYNTHETIC SOFTWARE FIXTURE / harness_routing', 22)}${text(25, 80, 'Rendered diagram, NOT a photographed or physically tested operation', 19, '#b45309')}${drawing}${text(25, 615, 'No physical pass, manufacturing accuracy or novelty is asserted.', 17, '#64748b')}</svg>`;
const imagePath = path.join(runDir, 'harness-after.png');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 640 }, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0">${svg}</body></html>`);
  await page.screenshot({ path: imagePath, type: 'png' });
} finally { await browser.close(); }
const currentBytes = await readFile(imagePath);
const now = new Date().toISOString();
const session: CameraSession = structuredClone(before.input.session);
const previousTurn: CameraTurn = { ...before.input.frame, frameId: before.input.frame.id, frameSha256: before.input.frame.sha256, assessment: before.output };
session.latestTurn = previousTurn;
// This prior assessment was uncertain. It is comparison data, not an admitted
// before view. Do not fabricate operator history to make this test progress.
session.beforeTurn = null;
session.completedSteps = [];
const frame = { id: randomUUID(), sha256: hash(currentBytes), purpose: 'after' as const, source: 'upload' as const,
  capturedAt: null, receivedAt: now, stepId: session.currentStepId!, revision: session.revision };
const input = { runId: randomUUID(), turnId: randomUUID(), workflow: before.input.workflow, session, frame,
  comparison: { frame: before.input.frame, turnId: previousTurn.id, assessment: before.output },
  operatorNote: 'Synthetic paired-image transport probe: compare the labelled previous and current diagrams. Neither is a photographed or physically tested operation. Do not infer actual bend, slack or retention measurements.' };
const base = { kind: 'recorded_meta_camera_comparison_contract', synthetic: true, sceneSource: 'rendered_diagrams_not_photos', physicalStatus: 'untested',
  inferenceRequested: live, syntheticStageSelection: true, admittedBeforeView: false, earlierOperatorChecksFabricated: false, recordedAt: now,
  disclosure: 'One direct Meta assessor transport/interpretation probe with two images. Production session rules do not admit an after view without a usable before view. This record creates no app session, operator confirmation, physical trial or workflow completion.',
  requestConfiguration: { promptVersion: CAMERA_PROMPT_VERSION, maxOutputTokens: 6000, reasoningEffort: 'low', timeoutMs: 90000, automaticRetries: 0, attachedImages: 2 },
  previous: { aggregate: 'fixtures/recorded-meta-camera-assessments.json', providerResponseId: before.trace.providerResponseId,
    imageArtifact: before.imageArtifact, sha256: before.image.sha256, bytes: previousBytes.length },
  current: { imageArtifact: 'docs/examples/camera-harness-after.png', sha256: frame.sha256, bytes: currentBytes.length },
  expectedDiagramDifferenceNotProvidedAsInstruction: 'A/B swapped routes are changed to A-L-P1 and B-M-P2; C-R-P3 and the declared target remain unchanged.', input };
const progressPath = path.join(runDir, 'comparison.json');
let latestTrace: ModelTrace | null = null;
let record: Record<string, unknown>;
if (!live) record = { ...base, status: 'offline_fixture_only', output: null, trace: null };
else {
  try {
    const result = await assessCameraFrame({ ...input, framePath: imagePath, previousFramePath, onTrace: async trace => {
      latestTrace = trace;
      await writeFile(progressPath, JSON.stringify({ ...base, status: 'pending', output: null, trace }, null, 2) + '\n');
    } });
    const at = new Date(Date.parse(frame.receivedAt) + result.trace.latencyMs).toISOString();
    const assessed = applyCameraAssessment(session, { ...frame, frameId: frame.id, frameSha256: frame.sha256, assessment: result.assessment }, input.workflow, at);
    record = { ...base, status: 'assessment_returned', output: result.assessment, trace: result.trace,
      syntheticEngineGate: assessed.guidance, completedSteps: assessed.completedSteps.length };
  } catch (error) {
    record = { ...base, status: 'failed', output: null, trace: error instanceof MetaError && error.trace ? error.trace : latestTrace,
      error: error instanceof MetaError ? error.code : 'local_comparison_failure' };
    process.exitCode = 1;
  }
}
await writeFile(progressPath, JSON.stringify(record, null, 2) + '\n');
if (live) {
  await copyFile(imagePath, base.current.imageArtifact);
  await writeFile(fixturePath, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
}
console.log(JSON.stringify({ status: record.status, live, physicalStatus: 'untested', admittedBeforeView: false,
  providerResponseId: (record.trace as ModelTrace | null)?.providerResponseId || null,
  latencyMs: (record.trace as ModelTrace | null)?.latencyMs || null, usage: (record.trace as ModelTrace | null)?.usage || null,
  outputFile: live ? fixturePath : progressPath, syntheticEngineGate: record.syntheticEngineGate || null }, null, 2));
