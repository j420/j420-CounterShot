import assert from "node:assert/strict";
import { mock, test } from "node:test";
import OpenAI from "openai";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { completedText, parseStructured, providerSchema, modelToolFeedback, plan, observe, recoverResponse, finalizePlannerChecks, type PlannerCheckProvenance, type ModelTrace } from "../src/meta";
import { demoFacts, demoProposal, workshopFacts, workshopProposal } from "../src/domain/demo";
import { createMetaClient, MetaError } from "../src/meta/client";
import { checkDesign, CHECKER_VERSION } from "../src/checks";
import { compileDesign } from "../src/geometry";
import { FactsSchema, ProposalSchema, upgradeLegacyFacts, upgradeLegacyProposal } from "../src/domain/schema";
import type { Response } from "openai/resources/responses/responses";

function response(status: string, content: unknown[]): Pick<Response, "status" | "output"> {
  return { status, output: [{ type: "message", role: "assistant", id: "test-message", status: "completed", content }] } as Pick<Response, "status" | "output">;
}

test("strict projection closes nested objects and requires nullable fields", () => {
  const schema = providerSchema(z.object({ fact: z.object({ value: z.number().nullable() }).strict() }).strict());
  assert.equal(schema.$schema, undefined);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["fact"]);
  const fact = (schema.properties as Record<string, { additionalProperties: boolean; required: string[] }>).fact;
  assert.equal(fact.additionalProperties, false);
  assert.deepEqual(fact.required, ["value"]);
});

test("incomplete generation cannot become a usable construction plan", () => {
  assert.throws(() => completedText(response("incomplete", [{ type: "output_text", text: '{"value":1}' }])), (error: unknown) => error instanceof MetaError && error.code === "incomplete_output");
});

test("refusal is distinct from malformed output", () => {
  assert.throws(() => completedText(response("completed", [{ type: "refusal", refusal: "Declined" }])), (error: unknown) => error instanceof MetaError && error.code === "refusal");
});

test("local validation rejects syntactically valid unexpected fields", () => {
  const schema = z.object({ value: z.number() }).strict();
  assert.throws(() => parseStructured(response("completed", [{ type: "output_text", text: '{"value":1,"physicalPass":true}' }]), schema), (error: unknown) => error instanceof MetaError && error.code === "invalid_output");
  assert.deepEqual(parseStructured(response("completed", [{ type: "output_text", text: '{"value":1}' }]), schema), { value: 1 });
});

test("recorded real Meta output remains a complete checked construction candidate on its explicit synthetic profile", () => {
  const fixture = JSON.parse(readFileSync(new URL("../fixtures/recorded-meta-plan.json", import.meta.url), "utf8"));
  assert.equal(fixture.synthetic, true);
  assert.equal(fixture.physicalStatus, "untested");
  // Explicit migration for local regression checks only: preserve the original recorded provider payload.
  const facts = FactsSchema.parse(upgradeLegacyFacts(fixture.revalidation.facts));
  const proposal = ProposalSchema.parse(upgradeLegacyProposal(fixture.output));
  assert.equal(proposal.outcome, "candidate");
  assert.deepEqual(checkDesign(facts, proposal).filter(check => check.severity === "error"), []);
  const artifacts = compileDesign(facts, proposal, "synthetic-recorded-contract");
  assert.match(artifacts.packageSvg, /<svg/);
  assert.match(artifacts.stationSvg, /<svg/);
});

test("recorded real Meta kit output keeps individually counted parts in their own closed cells", () => {
  const fixture = JSON.parse(readFileSync(new URL("../fixtures/recorded-meta-kit-plan.json", import.meta.url), "utf8"));
  assert.equal(fixture.synthetic, true);
  assert.equal(fixture.physicalStatus, "untested");
  const facts = FactsSchema.parse(upgradeLegacyFacts(fixture.input.facts));
  const proposal = ProposalSchema.parse(upgradeLegacyProposal(fixture.output));
  assert(facts.workflow === "electronics_kit");
  assert.equal(proposal.outcome, "candidate");
  assert.equal(proposal.actions.length, 38);
  assert.deepEqual(checkDesign(facts, proposal).filter(check => check.severity === "error"), []);
  for (const component of facts.kitComponents) {
    const loads = proposal.actions.filter(action => action.operation === "load" && action.objectId === component.id);
    assert.equal(loads.length, component.requiredCount);
    assert(loads.every(action => action.quantity === 1 && action.compartmentId === component.id && action.supportAfter === `compartment_${component.id}`));
  }
  const artifacts = compileDesign(facts, proposal, "synthetic-recorded-kit-contract");
  assert.match(artifacts.packageSvg, /<svg/);
  assert.match(artifacts.stationSvg, /<svg/);
});

test("recorded actual workshop result preserves supplied parts, checked support duties and gate handoff", () => {
  const fixture = JSON.parse(readFileSync(new URL("../fixtures/recorded-meta-workshop-plan.json", import.meta.url), "utf8"));
  assert.equal(fixture.synthetic, true);
  assert.equal(fixture.physicalStatus, "untested");
  const facts = FactsSchema.parse(fixture.input.facts);
  const proposal = ProposalSchema.parse(fixture.output);
  assert(facts.workflow === "workshop_jig");
  assert.equal(proposal.program, null);
  assert.deepEqual(proposal.actions, []);
  assert(proposal.jigProgram);
  assert.equal(proposal.jigProgram.actions.length, 23);
  assert.deepEqual(checkDesign(facts, proposal).filter(check => check.severity === "error"), []);
  for (const part of ["left_wall", "right_wall", "rear_wall", "front_wall", "lid"]) assert(proposal.jigProgram.actions.some(action => action.operation === "join" && action.partId === part));
  const actions = proposal.jigProgram.actions;
  const released = actions.findIndex(action => action.operation === "release_support");
  const parked = actions.findIndex(action => action.operation === "park_support");
  const extracted = actions.findIndex(action => action.operation === "extract");
  assert(released >= 0 && parked > released && extracted > parked);
  assert.equal(actions.at(-1)?.operation, "reset");
  const pack = compileDesign(facts, proposal, "synthetic-recorded-workshop-contract");
  assert.match(pack.packageSvg, /<svg/);
  assert.match(pack.stationSvg, /<svg/);
});

test("compact model feedback preserves every error, physical test, support duty and target from actual audit results", () => {
  const fixture = JSON.parse(readFileSync(new URL("../fixtures/recorded-meta-workshop-plan.json", import.meta.url), "utf8"));
  const facts = FactsSchema.parse(fixture.input.facts);
  assert(facts.workflow === "workshop_jig");
  const full = fixture.trace.toolExecutions[0].result;
  const compact = modelToolFeedback(full, facts) as { checks: unknown[]; physicalTestsRequired: string[]; geometry: Record<string, unknown>; physicalStatus: string };
  assert.deepEqual(compact.checks, full.checks.filter((check: { severity: string }) => check.severity !== "trial_required"));
  assert.deepEqual(compact.physicalTestsRequired, [...new Set(full.checks.filter((check: { severity: string }) => check.severity === "trial_required").map((check: { message: string }) => check.message))]);
  assert.deepEqual(compact.geometry.targets, full.geometry.targets);
  assert.deepEqual(compact.geometry.expectedSupportIds, full.geometry.expectedSupportIds);
  assert.deepEqual(compact.geometry.measuredJointZones, facts.jointZones);
  assert.equal(compact.physicalStatus, "untested");
  assert(JSON.stringify(compact).length < JSON.stringify(full).length);
});


test("a cancelled plan stops before client authentication or a generation POST", async () => {
  let checkpoints=0;
  await assert.rejects(plan({goal:'Offline cancellation contract',facts:demoFacts,observation:null,parent:null,feedback:null,onTrace:async()=>{checkpoints++;throw new MetaError('Cancelled by the user','cancelled');}}),(error:unknown)=>error instanceof MetaError&&error.code==='cancelled');
  assert.equal(checkpoints,1);
});

test("a cancelled observation stops before reading or uploading its next media file", async () => {
  await assert.rejects(observe({goal:'Offline cancellation contract',notes:'No real media or provider calls',assets:[{id:'cancelled-fixture',mime:'video/mp4',path:'/this-file-must-never-be-read.mp4'}],onTrace:async()=>{throw new MetaError('Cancelled by the user','cancelled');}}),(error:unknown)=>error instanceof MetaError&&error.code==='cancelled');
});

const toolReply = (proposal: unknown, serial: number) => ({ id: `resp_offline_${serial}`, model: "muse-spark-1.3", status: "completed", usage: { total_tokens: 1 }, output: [{ type: "function_call", id: `fc_offline_${serial}`, status: "completed", call_id: `call_offline_${serial}`, name: "check_task_plan", arguments: JSON.stringify(proposal) }] });
const finalReply = (proposal: unknown, serial: number) => ({ id: `resp_offline_${serial}`, model: "muse-spark-1.3", status: "completed", usage: { total_tokens: 1 }, output: [{ type: "message", role: "assistant", id: `message_offline_${serial}`, status: "completed", content: [{ type: "output_text", text: JSON.stringify(proposal) }] }] });
const offlinePost = (respond: (body: Record<string, any>) => unknown) => ((_path: string, options: unknown) => {
  const response = Promise.resolve(options as { body: Record<string, any> }).then(opts => respond(opts.body));
  // The SDK's Responses resource unwraps its APIPromise before returning it.
  return { _thenUnwrap: (transform: (value: any) => unknown) => response.then(transform) };
}) as unknown as typeof OpenAI.prototype.post;

test("successful checker feedback removes tools so a repeat-checking provider must finalize", async () => {
  const previousKey = process.env.MODEL_API_KEY;
  process.env.MODEL_API_KEY ||= "offline-fixture-not-a-credential";
  const bodies: Record<string, any>[] = [];
  const post = mock.method(OpenAI.prototype, "post", offlinePost(body => {
    bodies.push(body);
    // This fake deliberately repeats check calls while a checker tool remains available.
    return bodies.length > 1 && Array.isArray(body.tools) && body.tools.length === 0
      ? finalReply(demoProposal, bodies.length) : toolReply(demoProposal, bodies.length);
  }));
  try {
    const result = await plan({ goal: "Offline orchestration contract", facts: demoFacts, observation: null, parent: null, feedback: null });
    assert.equal(bodies.length, 2);
    assert(bodies[0].tools.length > 0);
    assert.deepEqual(bodies[1].tools, []);
    assert.equal(bodies[1].tool_choice, undefined);
    assert.deepEqual(result.output, demoProposal);
    assert.equal(result.trace.toolExecutions?.length, 1);
  } finally { post.mock.restore(); if (previousKey === undefined) delete process.env.MODEL_API_KEY; else process.env.MODEL_API_KEY = previousKey; }
});

test("a failed workshop check retains repair tools and only a corrected candidate can finalize", async () => {
  const previousKey = process.env.MODEL_API_KEY;
  process.env.MODEL_API_KEY ||= "offline-fixture-not-a-credential";
  const invalid = structuredClone(workshopProposal);
  assert(invalid.jigProgram);
  invalid.jigProgram.registrationClearanceMm = workshopFacts.alignmentToleranceMm + 1;
  const bodies: Record<string, any>[] = [];
  const post = mock.method(OpenAI.prototype, "post", offlinePost(body => {
    bodies.push(body);
    if (bodies.length === 1) return toolReply(invalid.jigProgram, 1);
    if (bodies.length === 2) return toolReply(workshopProposal.jigProgram, 2);
    return finalReply(workshopProposal, 3);
  }));
  try {
    const result = await plan({ goal: "Offline workshop repair contract", facts: workshopFacts, observation: null, parent: null, feedback: null });
    assert.equal(bodies.length, 3);
    assert.equal(bodies[0].tools[0].parameters.properties.program, undefined);
    assert.equal(bodies[0].tools[0].parameters.properties.baseWidthMm.type, "number");
    assert.deepEqual(bodies[0].text.format.schema.properties.program, { type: "null" });
    assert.equal(bodies[0].text.format.schema.properties.actions.maxItems, 0);
    const feedback = JSON.parse(bodies[1].input[0].output);
    assert(feedback.checks.some((check: { severity: string; ruleId: string }) => check.severity === "error" && check.ruleId === "WJ_ALIGNMENT"));
    assert(bodies[1].tools.length > 0);
    assert.equal(bodies[1].tool_choice, "auto");
    assert.deepEqual(bodies[2].tools, []);
    assert.equal(bodies[2].tool_choice, undefined);
    assert.deepEqual(result.output, workshopProposal);
    assert.equal(result.trace.toolExecutions?.length, 2);
    assert.equal(result.trace.plannerChecks?.toolChecks.length, 2);
    assert.equal(result.trace.plannerChecks?.final?.relation, 'matches_tool_checked_candidate');
    assert.deepEqual(result.trace.plannerChecks?.final?.matchedToolChecks, [{ responseId: 'resp_offline_2', callId: 'call_offline_2' }]);
  } finally { post.mock.restore(); if (previousKey === undefined) delete process.env.MODEL_API_KEY; else process.env.MODEL_API_KEY = previousKey; }
});

test("malformed workshop tool values receive precise paths and are never coerced into a candidate", async () => {
  const previousKey = process.env.MODEL_API_KEY;
  process.env.MODEL_API_KEY ||= "offline-fixture-not-a-credential";
  assert(workshopProposal.jigProgram);
  const invalid = { ...workshopProposal.jigProgram, gate: { ...workshopProposal.jigProgram.gate, heightMm: "20" } };
  const bodies: Record<string, any>[] = [];
  const post = mock.method(OpenAI.prototype, "post", offlinePost(body => {
    bodies.push(body);
    return bodies.length === 1 ? toolReply(invalid, 1) : bodies.length === 2 ? toolReply(workshopProposal.jigProgram, 2) : finalReply(workshopProposal, 3);
  }));
  try {
    const result = await plan({ goal: "Offline strict tool contract", facts: workshopFacts, observation: null, parent: null, feedback: null });
    assert.equal(bodies.length, 3);
    const rejected = JSON.parse(bodies[1].input[0].output);
    assert(rejected.issues.some((issue: { path: string[]; code: string }) => issue.path.join(".") === "gate.heightMm" && issue.code === "invalid_type"));
    assert(bodies[1].tools.length > 0);
    assert.deepEqual(bodies[2].tools, []);
    assert.deepEqual(result.output, workshopProposal);
    const checks = result.trace.plannerChecks!;
    assert.equal(checks.toolChecks[0].status, 'schema_rejected');
    assert.match(checks.toolChecks[0].canonicalInputHash!, /^[a-f0-9]{64}$/);
    assert.equal(checks.toolChecks[0].candidateHash, null);
    assert.equal(checks.toolChecks[0].checks, null);
    assert.equal(checks.toolChecks[1].status, 'checked');
    assert.deepEqual(checks.final?.matchedToolChecks, [{ responseId: 'resp_offline_2', callId: 'call_offline_2' }]);
  } finally { post.mock.restore(); if (previousKey === undefined) delete process.env.MODEL_API_KEY; else process.env.MODEL_API_KEY = previousKey; }
});

test("persistent invalid candidates exhaust the same checker budget and preserve paid-attempt trace", async () => {
  const previousKey = process.env.MODEL_API_KEY;
  process.env.MODEL_API_KEY ||= "offline-fixture-not-a-credential";
  const invalid = structuredClone(workshopProposal);
  assert(invalid.jigProgram);
  invalid.jigProgram.registrationClearanceMm = workshopFacts.alignmentToleranceMm + 1;
  let requests = 0;
  const post = mock.method(OpenAI.prototype, "post", offlinePost(() => toolReply(invalid.jigProgram, ++requests)));
  try {
    await assert.rejects(plan({ goal: "Offline failed-budget contract", facts: workshopFacts, observation: null, parent: null, feedback: null }), (error: unknown) => {
      assert(error instanceof MetaError);
      assert.equal(error.code, "tool_limit");
      const trace = error.trace as ModelTrace;
      assert.equal(trace.responseIds?.length, 4);
      assert.equal((trace.usage as unknown[]).length, 4);
      assert.equal(trace.toolExecutions?.length, 3);
      assert.equal(trace.plannerChecks?.toolChecks.length, 3);
      assert.equal(trace.plannerChecks?.final, null);
      assert(trace.plannerChecks?.toolChecks.every(check => check.status === 'checked' && check.checks?.some(check => check.severity === 'error')));
      return true;
    });
    assert.equal(requests, 4);
  } finally { post.mock.restore(); if (previousKey === undefined) delete process.env.MODEL_API_KEY; else process.env.MODEL_API_KEY = previousKey; }
});

test('a valid final jig change remains accepted but cannot inherit an exact checked-candidate claim', async () => {
  const previousKey = process.env.MODEL_API_KEY;
  process.env.MODEL_API_KEY ||= 'offline-fixture-not-a-credential';
  const final = structuredClone(workshopProposal);
  assert(final.jigProgram);
  assert.equal(final.jigProgram.baseWidthMm, 240);
  final.jigProgram.baseWidthMm = 240.01;
  assert.deepEqual(checkDesign(workshopFacts, final).filter(check => check.severity === 'error'), []);
  let requests = 0;
  const checkpoints: ModelTrace[] = [];
  const post = mock.method(OpenAI.prototype, 'post', offlinePost(() => ++requests === 1
    ? toolReply(workshopProposal.jigProgram, 1) : finalReply(final, 2)));
  try {
    const result = await plan({ goal: 'Offline exact-candidate provenance', facts: workshopFacts, observation: null, parent: null, feedback: null,
      onTrace: async trace => {
        checkpoints.push(structuredClone(trace));
        // A consumer cannot rewrite the adapter's retained proof via a snapshot.
        if (trace.plannerChecks?.toolChecks.length) trace.plannerChecks.toolChecks[0].candidateHash = 'forged-by-sink';
      } });
    assert.equal(requests, 2);
    assert.deepEqual(result.output, final);
    const proof = result.trace.plannerChecks!;
    assert.equal(proof.version, 'planner-check-provenance-v1');
    assert.equal(proof.checkerVersion, CHECKER_VERSION);
    assert.equal(proof.physicalStatus, 'untested');
    assert.equal(proof.toolChecks.length, 1);
    assert.equal(proof.toolChecks[0].candidateScope, 'jig_program');
    assert.equal(proof.toolChecks[0].rawArgumentsHash, createHash('sha256').update(JSON.stringify(workshopProposal.jigProgram)).digest('hex'));
    assert.notEqual(proof.toolChecks[0].candidateHash, proof.final?.candidateHash);
    assert.match(proof.toolChecks[0].candidateHash!, /^[a-f0-9]{64}$/);
    assert.equal(proof.final?.relation, 'differs_from_tool_checked_candidates');
    assert.deepEqual(proof.final?.matchedToolChecks, []);
    assert.deepEqual(proof.final?.checks, checkDesign(workshopFacts, final));
    assert.equal(proof.final?.physicalStatus, 'untested');
    assert(checkpoints.some(trace => trace.plannerChecks?.final?.proposalHash === proof.final?.proposalHash), 'Final check provenance must be durable before the result returns.');
    const before = finalizePlannerChecks(workshopFacts, workshopProposal);
    assert.notEqual(before.final?.proposalHash, proof.final?.proposalHash);
  } finally { post.mock.restore(); if (previousKey === undefined) delete process.env.MODEL_API_KEY; else process.env.MODEL_API_KEY = previousKey; }
});

test('canonical candidate identity ignores object-key order and retains separate response/call identities', async () => {
  const previousKey = process.env.MODEL_API_KEY;
  process.env.MODEL_API_KEY ||= 'offline-fixture-not-a-credential';
  assert(workshopProposal.jigProgram);
  const reversed = Object.fromEntries(Object.entries(workshopProposal.jigProgram).reverse());
  let requests = 0;
  const post = mock.method(OpenAI.prototype, 'post', offlinePost(() => {
    requests++;
    if (requests === 1) {
      const first = toolReply(reversed, 1);
      const second = { ...first.output[0], id: 'fc_offline_other', call_id: 'call_offline_other' };
      return { ...first, output: [...first.output, second] };
    }
    return finalReply(workshopProposal, 2);
  }));
  try {
    const result = await plan({ goal: 'Offline canonical candidate identity', facts: workshopFacts, observation: null, parent: null, feedback: null });
    const proof = result.trace.plannerChecks!;
    assert.equal(proof.toolChecks.length, 2);
    assert.equal(proof.toolChecks[0].canonicalInputHash, proof.toolChecks[1].canonicalInputHash);
    assert.equal(proof.toolChecks[0].candidateHash, proof.final?.candidateHash);
    assert.equal(proof.final?.relation, 'matches_tool_checked_candidate');
    assert.deepEqual(proof.final?.matchedToolChecks, [{ responseId: 'resp_offline_1', callId: 'call_offline_1' }, { responseId: 'resp_offline_1', callId: 'call_offline_other' }]);
    const reordered = finalizePlannerChecks(workshopFacts, { ...workshopProposal, jigProgram: reversed } as typeof workshopProposal);
    assert.equal(reordered.final?.candidateHash, proof.final?.candidateHash);
  } finally { post.mock.restore(); if (previousKey === undefined) delete process.env.MODEL_API_KEY; else process.env.MODEL_API_KEY = previousKey; }
});

test('a conflicting repeated tool identity rejects the whole batch with the paid response retained', async () => {
  const previousKey = process.env.MODEL_API_KEY;
  process.env.MODEL_API_KEY ||= 'offline-fixture-not-a-credential';
  const changed = structuredClone(workshopProposal.jigProgram)!;
  changed.baseWidthMm += 0.01;
  let requests = 0;
  const post = mock.method(OpenAI.prototype, 'post', offlinePost(() => {
    requests++;
    const first = toolReply(workshopProposal.jigProgram, 1);
    const second = { ...first.output[0], id: 'fc_conflict', arguments: JSON.stringify(changed) };
    return { ...first, output: [...first.output, second] };
  }));
  try {
    await assert.rejects(plan({ goal: 'Offline conflicting tool identity', facts: workshopFacts, observation: null, parent: null, feedback: null }), (error: unknown) => {
      assert(error instanceof MetaError);
      assert.equal(error.code, 'invalid_tool_identity');
      const trace = error.trace as ModelTrace;
      assert.deepEqual(trace.responseIds, ['resp_offline_1']);
      assert.equal(trace.plannerChecks?.toolChecks.length, 0);
      assert.equal(trace.plannerChecks?.final, null);
      assert.deepEqual(trace.usage, [{ total_tokens: 1 }]);
      return true;
    });
    assert.equal(requests, 1);
  } finally { post.mock.restore(); if (previousKey === undefined) delete process.env.MODEL_API_KEY; else process.env.MODEL_API_KEY = previousKey; }
});

test('known final response recovery checks the actual proposal without inventing a tool history or another generation', async () => {
  const previousKey = process.env.MODEL_API_KEY;
  process.env.MODEL_API_KEY = 'offline-fixture-not-a-credential';
  const client = createMetaClient();
  const retrieve = mock.method(client.responses, 'retrieve', (async () => finalReply(workshopProposal, 42)) as unknown as typeof client.responses.retrieve);
  const create = mock.method(client.responses, 'create', (() => { throw new Error('Recovery cannot generate again'); }) as typeof client.responses.create);
  try {
    const result = await recoverResponse('resp_offline_42', 'proposal', workshopFacts);
    assert.equal(result.trace.recovered, true);
    assert.equal(result.trace.providerResponseId, 'resp_offline_42');
    assert.equal(result.trace.plannerChecks?.final?.relation, 'no_tool_checked_candidate');
    assert.deepEqual(result.trace.plannerChecks?.toolChecks, []);
    assert.deepEqual(result.trace.plannerChecks?.final?.checks, checkDesign(workshopFacts, workshopProposal));
    assert.equal(create.mock.callCount(), 0);
    const legacy = await recoverResponse('resp_offline_42', 'proposal');
    assert.equal(legacy.trace.plannerChecks, undefined, 'Missing confirmed facts cannot be filled with invented check provenance.');
    const mismatch = { ...result.trace.plannerChecks!, factsHash: 'not-these-facts' } as PlannerCheckProvenance;
    assert.throws(() => finalizePlannerChecks(workshopFacts, workshopProposal, mismatch), (error: unknown) => error instanceof MetaError && error.code === 'invalid_planning_provenance');
    retrieve.mock.mockImplementation((async () => finalReply({ malformed: 'not-a-proposal' }, 43)) as unknown as typeof client.responses.retrieve);
    await assert.rejects(recoverResponse('resp_offline_43', 'proposal', workshopFacts), (error: unknown) => {
      assert(error instanceof MetaError);
      assert.equal(error.code, 'invalid_output');
      const trace = error.trace as ModelTrace;
      assert.equal(trace.providerResponseId, 'resp_offline_43');
      assert.deepEqual(trace.usage, { total_tokens: 1 });
      assert.equal(trace.plannerChecks?.final, null, 'Malformed output has no actual-final check proof.');
      assert.equal(create.mock.callCount(), 0);
      return true;
    });
  } finally { retrieve.mock.restore(); create.mock.restore(); if (previousKey === undefined) delete process.env.MODEL_API_KEY; else process.env.MODEL_API_KEY = previousKey; }
});
