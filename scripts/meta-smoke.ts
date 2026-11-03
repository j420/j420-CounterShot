import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { createMetaClient, metaStatus, normalizeMetaError } from "../src/meta/client";
import { observe, plan, parseStructured, providerSchema, deleteProviderFile, type ModelTrace } from "../src/meta";

// Explicit integration check. It sends only synthetic evidence and incurs real API usage.
// It never creates a physical Trial, and its outputs are not physical success evidence.
const client = createMetaClient();
const model = metaStatus().model;
const resultSchema = z.object({ value: z.number(), source: z.enum(["tool"]) }).strict();
const inputSchema = z.object({ value: z.number() }).strict();
const instructions = "This is a synthetic CounterShot integration smoke test. Call verify_number with value 41, then return the tool's value and source=tool in the specified schema. Do not invent the tool result.";
const started = Date.now();
const verificationDir = path.resolve(process.env.DATA_ROOT || "data", "verification");
let temp: string | undefined;
const uploaded: string[] = [];
const collectUploads = async (trace: ModelTrace) => {
  for (const fileId of trace.uploadedFileIds || []) if (!uploaded.includes(fileId)) uploaded.push(fileId);
};
async function kitProbe() {
  const { kitFacts } = await import("../src/domain/demo");
  assert(kitFacts.workflow === "electronics_kit");
  const { checkDesign } = await import("../src/checks");
  const { compileDesign } = await import("../src/geometry");
  const input = {
    goal: "Synthetic contract fixture: fulfil a small electronics repair kit from the confirmed quantities of screws, washers, spacers and grommets, keeping each group in its own matching labelled compartment. Use only the confirmed right hand, measured complete-group envelopes and declared supplies. Include staged local compartment closure, final carton closure, extraction and reset. No physical success or ESD/electrical protection is asserted.",
    facts: kitFacts, observation: null, parent: null, feedback: null,
  };
  const candidate = await plan(input);
  const checks = checkDesign(kitFacts, candidate.output);
  assert.equal(candidate.output.outcome, "candidate", "The synthetic complete-input profile did not produce a candidate; inspect its honest boundary before changing anything.");
  assert.deepEqual(checks.filter(check => check.severity === "error"), [], "The returned candidate still has hard check errors.");
  const artifacts = compileDesign(kitFacts, candidate.output, "synthetic-kit-api-contract");
  assert.match(artifacts.packageSvg, /<svg/);
  assert.match(artifacts.stationSvg, /<svg/);
  for (const component of kitFacts.kitComponents) {
    const loads = candidate.output.actions.filter(action => action.operation === "load" && action.objectId === component.id);
    assert.equal(loads.length, component.requiredCount, `${component.id} does not have one explicit load per required part.`);
    assert(loads.every(action => action.quantity === 1 && action.compartmentId === component.id && action.supportAfter === `compartment_${component.id}`), `${component.id} has an ambiguous count or receiver.`);
    assert(candidate.output.actions.some(action => action.operation === "close" && action.objectId === `compartment_${component.id}` && action.compartmentId === component.id), `${component.id} has no local closure.`);
  }
  const fixture = { schemaVersion: 2, kind: "recorded_meta_api_contract_fixture", synthetic: true, physicalStatus: "untested", recordedAt: new Date().toISOString(), input, output: candidate.output, trace: candidate.trace, checks };
  await mkdir(new URL("../fixtures/", import.meta.url), { recursive: true });
  await writeFile(new URL("../fixtures/recorded-meta-kit-plan.json", import.meta.url), JSON.stringify(fixture, null, 2) + "\n");
  console.log(JSON.stringify({ check: "kit_fulfilment_and_dispatch", passed: true, model: candidate.trace.model, outcome: candidate.output.outcome, actions: candidate.output.actions.length, toolRounds: candidate.trace.toolExecutions?.length, responseId: candidate.trace.providerResponseId, latencyMs: candidate.trace.latencyMs, usage: candidate.trace.usage, physicalStatus: "untested", fixture: "fixtures/recorded-meta-kit-plan.json" }));
}
async function workshopProbe() {
  const { workshopFacts } = await import("../src/domain/demo");
  assert(workshopFacts.workflow === "workshop_jig");
  const { checkDesign } = await import("../src/checks");
  const { compileDesign } = await import("../src/geometry");
  const input = {
    goal: "Synthetic contract fixture: design a passive workshop jig for staged one-handed assembly of the supplied low-force interlocking instrument-enclosure mockup. The supplied base, four walls and lid keep their measured geometry and joint family. Transfer persistent panel holding/alignment duties to exterior braces while preserving every measured joint-access window. Start with the front gate parked, load fresh base, engage the gate when appropriate, locate/join all walls and lid, release and park the gate only after declared completed-joint retention, extract forward, place finished and reset. No physical insertion-force, retention or stability success has been observed.",
    facts: workshopFacts, observation: null, parent: null, feedback: null,
  };
  await mkdir(verificationDir, { recursive: true });
  const progressPath = path.join(verificationDir, `meta-workshop-progress-${started}.json`);
  const candidate = await plan({ ...input, onTrace: async trace => {
    await writeFile(progressPath, JSON.stringify({ synthetic: true, physicalStatus: "untested", input, trace }, null, 2) + "\n");
    const last = trace.toolExecutions?.at(-1);
    const result = last?.result as { checks?: { severity: string; ruleId: string; message: string }[] } | undefined;
    console.log(JSON.stringify({ check: "workshop_progress", responseId: trace.providerResponseId, completedToolRounds: trace.toolExecutions?.length || 0, lastHardErrors: result?.checks?.filter(check => check.severity === "error"), progressPath }));
  } });
  const checks = checkDesign(workshopFacts, candidate.output);
  assert.equal(candidate.output.outcome, "candidate", "The synthetic complete-input workshop profile did not produce a candidate; inspect its honest boundary before changing anything.");
  assert.equal(candidate.output.program, null);
  assert.deepEqual(candidate.output.actions, []);
  assert(candidate.output.jigProgram, "A workshop candidate must contain its own jig programme.");
  assert.deepEqual(checks.filter(check => check.severity === "error"), [], "The returned jig still has blocking access/support/release errors.");
  const actions = candidate.output.jigProgram.actions;
  for (const partId of ["left_wall", "right_wall", "rear_wall", "front_wall", "lid"]) assert(actions.some(action => action.operation === "join" && action.partId === partId), `The supplied ${partId} was not explicitly joined.`);
  const released = actions.findIndex(action => action.operation === "release_support");
  const parked = actions.findIndex(action => action.operation === "park_support");
  const extracted = actions.findIndex(action => action.operation === "extract");
  assert(released >= 0 && parked > released && extracted > parked, "The gate must be released into the hand, parked, then the assembly extracted.");
  assert.equal(actions.at(-1)?.operation, "reset");
  const artifacts = compileDesign(workshopFacts, candidate.output, "synthetic-workshop-api-contract");
  assert.match(artifacts.packageSvg, /<svg/);
  assert.match(artifacts.stationSvg, /<svg/);
  const fixture = { schemaVersion: 3, kind: "recorded_meta_api_contract_fixture", synthetic: true, physicalStatus: "untested", recordedAt: new Date().toISOString(), input, output: candidate.output, trace: candidate.trace, checks };
  await mkdir(new URL("../fixtures/", import.meta.url), { recursive: true });
  await writeFile(new URL("../fixtures/recorded-meta-workshop-plan.json", import.meta.url), JSON.stringify(fixture, null, 2) + "\n");
  console.log(JSON.stringify({ check: "workshop_jig_assembly_and_release", passed: true, model: candidate.trace.model, outcome: candidate.output.outcome, actions: actions.length, supports: candidate.output.jigProgram.supports.length, toolRounds: candidate.trace.toolExecutions?.length, responseId: candidate.trace.providerResponseId, latencyMs: candidate.trace.latencyMs, usage: candidate.trace.usage, physicalStatus: "untested", fixture: "fixtures/recorded-meta-workshop-plan.json" }));
}
try {
  const unknownFlags = process.argv.slice(2).filter(flag => !["--plan", "--kit", "--workshop"].includes(flag));
  if (unknownFlags.length) throw new Error(`Unsupported smoke option: ${unknownFlags.join(", ")}. Use --plan, --kit or --workshop.`);
  if (process.argv.includes("--workshop")) {
    await workshopProbe();
  } else if (process.argv.includes("--kit")) {
    await kitProbe();
  } else {
  const models = await client.models.list();
  assert(models.data.some(entry => entry.id === model), `Configured model ${model} is not available to this account.`);
  console.log(JSON.stringify({ check: "model_access", passed: true, model }));
  const shared = { model, store: true, instructions,
    tools: [{ type: "function" as const, name: "verify_number", description: "Return value plus one.", parameters: providerSchema(inputSchema), strict: true }],
    text: { format: { type: "json_schema" as const, name: "countershot_smoke", schema: providerSchema(resultSchema), strict: true } },
    max_output_tokens: 1500,
  };
  const first = await client.responses.create({ ...shared, input: "Run the synthetic integration check.", tool_choice: "auto" });
  assert.equal(first.status, "completed");
  const calls = first.output.filter(item => item.type === "function_call");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "verify_number");
  const args = inputSchema.parse(JSON.parse(calls[0].arguments));
  assert.equal(args.value, 41);
  const second = await client.responses.create({ ...shared, previous_response_id: first.id, input: [{ type: "function_call_output", call_id: calls[0].call_id, output: JSON.stringify({ value: args.value + 1 }) }], tool_choice: "auto" });
  const output = parseStructured(second, resultSchema);
  assert.deepEqual(output, { value: 42, source: "tool" });
  console.log(JSON.stringify({ check: "strict_schema_and_tool_continuation", passed: true, responseIds: [first.id, second.id], usage: [first.usage, second.usage] }));

  temp = await mkdtemp(path.join(tmpdir(), "countershot-meta-smoke-"));
  const image = path.join(temp, "synthetic-checkpoint.png");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=white:s=320x240", "-vf", "drawbox=x=60:y=60:w=180:h=120:color=brown:t=fill", "-frames:v", "1", image]);
  const observedImage = await observe({ goal: "Synthetic input-format check, not a packing trial", notes: "This generated still contains a flat colored rectangle. No physical packing operation occurred. Do not infer a complete cycle.", assets: [{ id: "synthetic-image", mime: "image/png", path: image }] });
  assert.equal(observedImage.output.evidenceCompleteness, "incomplete");
  console.log(JSON.stringify({ check: "image_and_observation_schema", passed: true, responseId: observedImage.trace.providerResponseId, usage: observedImage.trace.usage }));

  const video = path.join(temp, "synthetic-clip.mp4");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=white:s=320x240:r=5:d=1", "-vf", "drawbox=x=60:y=60:w=180:h=120:color=brown:t=fill", "-c:v", "libx264", "-pix_fmt", "yuv420p", video]);
  const observedVideo = await observe({ goal: "Synthetic MP4 API acceptance check", notes: "This is a generated 1 second rectangle clip; no real person, item, or packing cycle exists. Mark evidence incomplete.", assets: [{ id: "synthetic-video", mime: "video/mp4", path: video }], onTrace: collectUploads });
  assert.equal(observedVideo.output.evidenceCompleteness, "incomplete");
  console.log(JSON.stringify({ check: "mp4_upload_and_reference", passed: true, responseId: observedVideo.trace.providerResponseId, usage: observedVideo.trace.usage }));
  if (process.argv.includes("--plan")) {
    const { demoFacts } = await import("../src/domain/demo");
    const candidate = await plan({ goal: "Synthetic contract fixture: notebook and loose card in an existing top-opening tuck carton", facts: demoFacts, observation: null, parent: null, feedback: null });
    const { checkDesign } = await import("../src/checks");
    const checks = checkDesign(demoFacts, candidate.output);
    const hardErrors = checks.filter(check => check.severity === "error");
    assert.equal(candidate.output.outcome, "candidate");
    assert.deepEqual(hardErrors, []);
    const { compileDesign } = await import("../src/geometry");
    compileDesign(demoFacts, candidate.output, "synthetic-packing-api-contract");
    console.log(JSON.stringify({ check: "real_planning_with_tools", passed: true, outcome: candidate.output.outcome, hardErrors, trace: candidate.trace }));
  }
  }
  console.log(JSON.stringify({ check: "complete", passed: true, elapsedMs: Date.now() - started, evidence: "synthetic_contract_test_only" }));
} catch (error) {
  const normalized = normalizeMetaError(error);
  const diagnostic = error instanceof Error ? error.message.replaceAll(process.env.MODEL_API_KEY || "__no_secret__", "[redacted]").slice(0, 1500) : undefined;
  if (process.argv.includes("--workshop")) {
    await mkdir(verificationDir, { recursive: true });
    await writeFile(path.join(verificationDir, `meta-workshop-error-${started}.json`), JSON.stringify({ synthetic: true, physicalStatus: "untested", code: normalized.code, status: normalized.status, message: normalized.message, trace: normalized.trace }, null, 2) + "\n");
  }
  console.error(JSON.stringify({ check: "failed", code: normalized.code, status: normalized.status, message: normalized.message, diagnostic, trace: normalized.trace }));
  process.exitCode = 1;
} finally {
  for (const id of uploaded) {
    try { await deleteProviderFile(id); }
    catch { console.error(JSON.stringify({ check: "provider_file_cleanup", failed: true, fileId: id })); process.exitCode = 1; }
  }
  if (temp) await rm(temp, { recursive: true, force: true });
}
