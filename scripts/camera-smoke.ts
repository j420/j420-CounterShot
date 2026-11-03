/** Explicit synthetic image/API contract check. Default mode makes NO provider requests. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { assessCameraFrame, CAMERA_PROMPT_VERSION } from '../src/camera/meta';
import { createCameraSession } from '../src/camera/engine';
import { cameraWorkflows, cameraSyntheticFacts } from '../src/camera/workflows';
import type { CameraWorkflowId } from '../src/camera/schema';
import type { ModelTrace } from '../src/meta';
import { MetaError } from '../src/meta/client';

const flags = process.argv.slice(2);
const live = flags.includes('--live');
const selectedId = flags.find(flag => flag.startsWith('--workflow='))?.slice('--workflow='.length);
const unknown = flags.filter(flag => flag !== '--live' && !flag.startsWith('--workflow='));
if (unknown.length) throw new Error('Use --live for at most one explicit request per selected workflow, or --workflow=<id>. Default mode renders synthetic fixtures only.');
if (selectedId && !cameraWorkflows.some(workflow => workflow.id === selectedId)) throw new Error('Unknown camera workflow ID.');
const selected = cameraWorkflows.filter(workflow => !selectedId || workflow.id === selectedId);
const started = new Date().toISOString();
const outputDir = path.resolve(process.env.DATA_ROOT || 'data', 'verification', `camera-${live ? 'live' : 'offline'}-${Date.now()}`);
await mkdir(outputDir, { recursive: true });

const text = (x: number, y: number, value: string, size = 20, fill = '#182635') => `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}">${value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))}</text>`;
const line = (x1: number, y1: number, x2: number, y2: number, color = '#2563eb', width = 10) => `<path d="M${x1},${y1}L${x2},${y2}" stroke="${color}" stroke-width="${width}" fill="none"/>`;
const node = (x: number, y: number, label: string, color = '#cbd5e1') => `<rect x="${x - 35}" y="${y - 24}" width="70" height="48" rx="6" fill="${color}" stroke="#334155"/>${text(x - 25, y + 7, label)}`;
const scenarios: Record<CameraWorkflowId, { stage: string; note: string; drawing: string }> = {
  harness_routing: {
    stage: 'route_harness', note: 'Synthetic diagram: inspect the labelled route conflict. Do not infer measured cable bend or service length from this drawing.',
    drawing: node(160, 300, 'TRUNK') + node(760, 180, 'P1') + node(760, 320, 'P2') + node(760, 460, 'P3')
      + `<path d="M195,300L390,320L725,320" fill="none" stroke="#2563eb" stroke-width="12"/>`
      + `<path d="M195,286L390,180L725,180" fill="none" stroke="#c026d3" stroke-width="10"/>`
      + `<path d="M195,316L390,460L725,460" fill="none" stroke="#16a34a" stroke-width="10"/>`
      + text(520, 294, 'BRANCH A', 22, '#2563eb') + text(520, 155, 'BRANCH B', 22, '#a21caf') + text(520, 435, 'BRANCH C', 22, '#15803d')
      + text(250, 540, 'TARGET: A-L-P1; B-M-P2; C-R-P3')
      + node(390, 180, 'L', '#fef3c7') + node(390, 320, 'M', '#fef3c7') + node(390, 460, 'R', '#fef3c7'),
  },
  fragment_dry_fit: {
    stage: 'test_adjacency', note: 'Synthetic printed-board replicas F1-F6, loose and dry. Compare the candidate adjacency and declared pattern; ask rather than force an uncertain edge.',
    drawing: `<rect x="675" y="155" width="190" height="125" fill="#e0f2fe" stroke="#334155"/>${line(680, 160, 860, 275)}${text(665, 135, 'REFERENCE', 19)}`
      + `<polygon points="120,180 290,180 270,310 140,330" fill="#fef3c7" stroke="#334155"/>${line(140, 200, 265, 300)}${text(180, 245, 'F1')}`
      + `<polygon points="315,175 470,195 500,325 300,310" fill="#dcfce7" stroke="#334155"/>${line(330, 280, 440, 200)}${text(365, 250, 'F2')}`
      + `<polygon points="140,355 270,335 290,490 120,480" fill="#e0f2fe" stroke="#334155"/>${line(150, 370, 265, 470)}${text(180, 420, 'F3')}`
      + node(410, 450, 'F4') + node(570, 420, 'F5') + node(750, 420, 'F6')
      + text(300, 545, 'No adhesive. Candidate join F1-F2 is not confirmed.'),
  },
  webbing_lacing: {
    stage: 'thread_segment', note: 'Synthetic non-loadbearing pouch panel. The next declared entry is S3 from FRONT, with the blue marked face preserved. The rear return path is not shown.',
    drawing: `<rect x="150" y="180" width="650" height="300" rx="20" fill="#e2e8f0" stroke="#334155"/>${text(170, 220, 'FRONT')}`
      + [250, 400, 550, 700].map((x, i) => `<rect x="${x}" y="270" width="25" height="125" rx="8" fill="#334155"/>${text(x - 2, 250, `S${i + 1}`)}`).join('')
      + `<path d="M185,330L300,330Q360,270 425,330Q470,390 520,320" stroke="#2563eb" stroke-width="30" fill="none"/>`
      + `<path d="M475,345Q500,295 520,320L610,345" stroke="#f59e0b" stroke-width="26" fill="none"/>`
      + text(555, 430, 'FREE END') + text(185, 535, 'Blue = marked face. Amber = reverse face at visible twist.'),
  },
  gasket_seating: {
    stage: 'resolve_final_quadrants', note: 'Synthetic matched G1/H1 dry-seating demonstration. Q2 is the visible unresolved section. Actual proud-height and underside checks require a person.',
    drawing: `<rect x="180" y="190" width="600" height="300" rx="65" fill="#dbeafe" stroke="#334155" stroke-width="3"/>`
      + `<rect x="205" y="215" width="550" height="250" rx="45" fill="none" stroke="#0891b2" stroke-width="16"/>`
      + `<path d="M250,225L490,225Q540,130 610,225L710,225Q745,225 745,265L745,420Q745,455 705,455L255,455Q215,455 215,415L215,270Q215,225 250,225" fill="none" stroke="#c026d3" stroke-width="12"/>`
      + text(300, 280, 'Q1') + text(625, 280, 'Q2') + text(620, 420, 'Q3') + text(300, 420, 'Q4')
      + text(340, 350, 'H1 channel / G1 ring') + text(435, 150, 'TOP mark') + text(210, 535, 'Dry reversible seating. No leak-seal evidence.'),
  },
  gravity_fluidics: {
    stage: 'observe_water_progression', note: 'Synthetic water-only gravity circuit. Target R-J-A-C; the image shows a routing discrepancy. A single still cannot establish flow, collected volume or rate.',
    drawing: `<rect x="125" y="175" width="120" height="140" fill="#bae6fd" stroke="#334155"/>${text(155, 215, 'R')}`
      + line(185, 315, 375, 345, '#0284c7') + node(400, 345, 'J') + line(435, 345, 635, 255, '#0284c7')
      + node(680, 250, 'B', '#fecdd3') + node(680, 420, 'A', '#dcfce7')
      + `<path d="M715,250L825,250L825,495" fill="none" stroke="#0284c7" stroke-width="10"/>`
      + `<path d="M775,495L775,555L875,555L875,495" fill="#e0f2fe" stroke="#334155" stroke-width="3"/>${text(800, 540, 'C')}`
      + text(300, 165, 'TARGET GRAPH: R to J to A to C') + text(280, 465, 'Open collector; no pump or sealed source') + text(260, 505, 'Still image: flow and volumes UNKNOWN'),
  },
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
const outcomes: Record<string, unknown>[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 640 }, deviceScaleFactor: 1 });
  for (const workflow of selected) {
    const scenario = scenarios[workflow.id];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640" viewBox="0 0 960 640"><rect width="960" height="640" fill="#f8fafc"/><style>text{font-family:Arial,sans-serif}</style>${text(25, 40, `SYNTHETIC SOFTWARE FIXTURE / ${workflow.id}`, 22)}${text(25, 80, 'Rendered diagram, NOT a photographed or physically tested operation', 19, '#b45309')}${scenario.drawing}${text(25, 615, 'No physical pass, manufacturing accuracy or novelty is asserted.', 17, '#64748b')}</svg>`;
    const imagePath = path.join(outputDir, `${workflow.id}.png`);
    await page.setContent(`<html><body style="margin:0">${svg}</body></html>`);
    await page.screenshot({ path: imagePath, type: 'png' });
    const bytes = await readFile(imagePath);
    const frameHash = createHash('sha256').update(bytes).digest('hex');
    const now = new Date().toISOString();
    const session = createCameraSession(workflow, cameraSyntheticFacts[workflow.id], now);
    // Controlled contract fixture only: select a non-initial stage without
    // inventing earlier operator confirmations or persisting app progression.
    session.currentStepId = scenario.stage;
    const frame = { id: randomUUID(), sha256: frameHash, purpose: 'before' as const, source: 'upload' as const, capturedAt: null,
      receivedAt: now, stepId: scenario.stage, revision: session.revision };
    const input = { runId: randomUUID(), turnId: randomUUID(), workflow, session, frame, operatorNote: scenario.note };
    const fixturePath = path.join(outputDir, `${workflow.id}.json`);
    let latestTrace: ModelTrace | null = null;
    const base = { kind: 'camera_api_contract_fixture', synthetic: true, sceneSource: 'rendered_diagram', physicalStatus: 'untested',
      syntheticStageSelection: true, earlierOperatorChecksFabricated: false, inferenceRequested: live, recordedAt: now,
      image: { file: path.basename(imagePath), sha256: frameHash, bytes: bytes.length }, input };
    if (!live) {
      await writeFile(fixturePath, JSON.stringify({ ...base, status: 'offline_fixture_only', output: null, trace: null }, null, 2) + '\n');
      outcomes.push({ workflowId: workflow.id, status: 'offline_fixture_only', requests: 0, fixture: fixturePath });
      continue;
    }
    try {
      const result = await assessCameraFrame({ ...input, framePath: imagePath, onTrace: async trace => {
        latestTrace = trace;
        await writeFile(fixturePath, JSON.stringify({ ...base, status: 'pending', output: null, trace }, null, 2) + '\n');
      } });
      await writeFile(fixturePath, JSON.stringify({ ...base, status: 'assessment_returned', output: result.assessment, trace: result.trace }, null, 2) + '\n');
      outcomes.push({ workflowId: workflow.id, status: 'assessment_returned', requests: 1, responseId: result.trace.providerResponseId,
        latencyMs: result.trace.latencyMs, usage: result.trace.usage, decisionKind: result.assessment.decisionKind, fixture: fixturePath });
    } catch (error) {
      const trace = error instanceof MetaError && error.trace ? error.trace : latestTrace;
      const errorCode = error instanceof MetaError ? error.code : 'local_smoke_failure';
      await writeFile(fixturePath, JSON.stringify({ ...base, status: 'failed', output: null, trace, error: errorCode }, null, 2) + '\n');
      const knownResponse = !!(trace as ModelTrace | null)?.providerResponseId;
      outcomes.push({ workflowId: workflow.id, status: 'failed', requests: knownResponse ? 1 : errorCode === 'not_configured' ? 0 : null,
        providerOutcome: knownResponse ? 'response_received' : errorCode === 'not_configured' ? 'not_started' : 'unknown_or_not_started', error: errorCode, fixture: fixturePath });
    }
  }
} finally { await browser.close(); }
const report = { startedAt: started, finishedAt: new Date().toISOString(), live, synthetic: true, physicalStatus: 'untested',
  promptVersion: CAMERA_PROMPT_VERSION, requestBudget: live ? selected.length : 0, automaticRetries: 0, outcomes };
await writeFile(path.join(outputDir, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (outcomes.some(result => result.status === 'failed')) process.exitCode = 1;
