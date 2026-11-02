import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { Response as ModelResponse } from "openai/resources/responses/responses";
import {
  metaClient,
  observeJob,
  responseText,
  structuredRequest,
  testMeta,
} from "../src/lib/server/meta";
import { safeError } from "../src/lib/server/errors";
import { Store } from "../src/lib/server/store";

function response(
  text: string,
  overrides: Record<string, unknown> = {},
): ModelResponse {
  return {
    id: "resp_fixture",
    object: "response",
    created_at: 1,
    status: "completed",
    model: "muse-spark-1.3",
    output: [
      {
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    ...overrides,
  } as unknown as ModelResponse;
}
function sse(result: ModelResponse) {
  return new Response(
    `data: ${JSON.stringify({ type: "response.created", response: { ...result, status: "in_progress", output: [] } })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: result })}\n\ndata: [DONE]\n\n`,
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

test("real adapter targets Meta Responses text.format, strict JSON and typed media inputs", async () => {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const client = metaClient({
    apiKey: "test-fixture-secret",
    fetch: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return sse(response('{"observed":true,"measurement":null}'));
    },
  });
  const ids: string[] = [];
  const schema = z.object({
    observed: z.boolean(),
    measurement: z.number().nullable(),
  });
  const result = await structuredRequest(
    schema,
    "fixture_observation",
    "Treat footage as evidence.",
    [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_file", file_id: "file-fixture" }],
      },
    ],
    { client, onResponseId: (id) => ids.push(id) },
  );
  assert.equal(requests[0].url, "https://api.meta.ai/v1/responses");
  assert.equal(requests[0].body.model, "muse-spark-1.3");
  assert.equal(requests[0].body.response_format, undefined);
  const format = (
    requests[0].body.text as {
      format: {
        type: string;
        strict: boolean;
        schema: { additionalProperties: boolean; required: string[] };
      };
    }
  ).format;
  assert.equal(format.type, "json_schema");
  assert.equal(format.strict, true);
  assert.equal(format.schema.additionalProperties, false);
  assert.deepEqual(format.schema.required, ["observed", "measurement"]);
  assert.deepEqual(result.value, { observed: true, measurement: null });
  assert.deepEqual(ids, ["resp_fixture"]);
});

test("partial or invalid generated content cannot become a typed result", async () => {
  for (const payload of [
    response('{"value":1}', { status: "incomplete" }),
    response("not JSON"),
    response('{"value":"wrong"}'),
  ]) {
    const client = metaClient({
      apiKey: "fixture",
      fetch: async () => sse(payload),
    });
    await assert.rejects(
      structuredRequest(
        z.object({ value: z.number() }),
        "fixture",
        "Return JSON.",
        [],
        { client },
      ),
    );
  }
});

test("refusals remain failures and never get parsed as a successful observation", () => {
  const refusal = response("", {
    output: [
      {
        type: "message",
        content: [{ type: "refusal", refusal: "fixture refusal" }],
      },
    ],
  });
  assert.throws(() => responseText(refusal), /declined/);
});

test("known interrupted request recovers by GET, without another generation POST", async () => {
  const methods: string[] = [];
  const client = metaClient({
    apiKey: "fixture",
    fetch: async (url, init) => {
      methods.push(init?.method || "GET");
      assert.equal(
        String(url),
        "https://api.meta.ai/v1/responses/resp_existing",
      );
      return Response.json(
        response('{"observed":true}', { id: "resp_existing" }),
      );
    },
  });
  const result = await structuredRequest(
    z.object({ observed: z.boolean() }),
    "fixture",
    "Observation.",
    [],
    { client, recoverResponseId: "resp_existing" },
  );
  assert.equal(result.responseId, "resp_existing");
  assert.deepEqual(methods, ["GET"]);
});

test("Meta smoke test returns actual received response rather than local mock success", async () => {
  let called = false;
  const client = metaClient({
    apiKey: "fixture",
    fetch: async () => {
      called = true;
      return Response.json(response("Transport fixture response."));
    },
  });
  const result = await testMeta(client);
  assert.equal(called, true);
  assert.equal(result.text, "Transport fixture response.");
});

test("provider errors are sanitized and credentials never enter user messages", () => {
  const key = "fixture-secret-never-display";
  for (const status of [401, 403, 429, 500]) {
    const error = safeError({
      status,
      message: `Bearer ${key}`,
      headers: { authorization: key },
    });
    assert.equal(error.message.includes(key), false);
  }
});

test("observation uploads media with user_data and binds the resulting file ID", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "countershot-meta-test-"));
  const store = new Store(root);
  try {
    const p = store.createProject(
      "Fixture",
      "Observe the attached synthetic image.",
    );
    const id = randomUUID();
    writeFileSync(
      path.join(store.assetRoot, `${id}.png`),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const project = store.addAsset(
      p.id,
      p.version,
      {
        id,
        filename: "fixture.png",
        mime: "image/png",
        byteLength: 68,
        sha256: "fixture",
        createdAt: new Date().toISOString(),
        kind: "image",
        role: "job",
      },
      `${id}.png`,
    );
    const observed = {
      summary: "Fixture only.",
      objects: [],
      actions: [
        {
          id: "a",
          label: "Fixture action",
          holdingRequirement: "Unknown",
          activeManipulation: "Unknown",
          evidence: "Synthetic image",
        },
      ],
      conflicts: [],
      questions: ["Record the full cycle."],
      cycleCoverage: {
        preparation: false,
        loading: false,
        closure: false,
        release: false,
        reset: false,
      },
    };
    const calls: string[] = [];
    const client = metaClient({
      apiKey: "fixture",
      fetch: async (url, init) => {
        calls.push(String(url));
        if (String(url).endsWith("/files")) {
          const uploadedRequest = new Request(String(url), {
            ...init,
            duplex: "half",
          } as RequestInit);
          const form = await uploadedRequest.formData();
          assert.equal(form.get("purpose"), "user_data");
          const uploadedFile = form.get("file");
          assert.ok(uploadedFile instanceof File);
          assert.ok((await uploadedFile.arrayBuffer()).byteLength > 0);
          return Response.json({
            id: "file-observation-fixture",
            object: "file",
            purpose: "user_data",
            bytes: 68,
            filename: "fixture.png",
            created_at: 1,
            status: "uploaded",
          });
        }
        assert.match(String(init?.body), /file-observation-fixture/);
        return sse(response(JSON.stringify(observed)));
      },
    });
    const result = await observeJob(store, project, id, { client });
    assert.equal(result.value.summary, "Fixture only.");
    assert.equal(result.responseId, "resp_fixture");
    assert.equal(
      store.assetFile(p.id, id).providerFileId,
      "file-observation-fixture",
    );
    assert.deepEqual(calls, [
      "https://api.meta.ai/v1/files",
      "https://api.meta.ai/v1/responses",
    ]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
