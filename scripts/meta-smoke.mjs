import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";

const BASE_URL = "https://api.meta.ai/v1";
const TIMEOUT_MS = 90_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const checks = [];

class SmokeError extends Error {
  constructor(kind, details = {}) {
    super(kind);
    this.kind = kind;
    this.details = details;
  }
}

function outputText(response) {
  return (response.output ?? [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text ?? "")
    .join("");
}

async function request(key, body) {
  const started = Date.now();
  let response;
  try {
    response = await fetch(`${BASE_URL}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new SmokeError(
      error?.name === "TimeoutError" ? "timeout" : "network_error",
    );
  }

  if (!response.ok) {
    // Never print provider bodies or headers: they may contain sensitive details.
    throw new SmokeError("provider_http_error", {
      httpStatus: response.status,
      retryable: response.status === 429 || response.status >= 500,
    });
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new SmokeError("invalid_provider_json");
  }
  if (data.status !== "completed") {
    throw new SmokeError("response_not_completed");
  }
  return { data, text: outputText(data), latencyMs: Date.now() - started };
}

function record(name, result) {
  checks.push({ name, status: "passed", latencyMs: result.latencyMs });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("Usage: npm run meta:smoke -- [--image path-to-jpg-png-webp]");
    console.log(
      "Makes real Meta requests and consumes usage. Put MODEL_API_KEY in .env.local.",
    );
    return;
  }
  if (args.length !== 0 && !(args.length === 2 && args[0] === "--image")) {
    throw new SmokeError("invalid_arguments", {
      usage: "meta:smoke -- [--image path]",
    });
  }

  const model = process.env.META_MODEL || "muse-spark-1.3";
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(model))
    throw new SmokeError("invalid_model_name");
  const key = process.env.MODEL_API_KEY?.trim();
  if (
    !key ||
    /placeholder|^replace(?:[_ -]|$)|^your(?:[_ -]|$)|^changeme$/i.test(key)
  ) {
    console.log(
      JSON.stringify(
        {
          status: "not_run",
          reason: "missing_credentials",
          required: ["MODEL_API_KEY"],
          model,
          checks,
        },
        null,
        2,
      ),
    );
    process.exitCode = 2;
    return;
  }

  let imageInput = null;
  if (args.length) {
    const path = resolve(args[1]);
    const mime = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".webp": "image/webp",
    }[extname(path).toLowerCase()];
    if (!mime) throw new SmokeError("unsupported_image_type");
    let bytes;
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size <= 0 || info.size > MAX_IMAGE_BYTES)
        throw new SmokeError("image_size_out_of_range");
      bytes = await readFile(path);
    } catch (error) {
      if (error instanceof SmokeError) throw error;
      throw new SmokeError("image_unreadable");
    }
    imageInput = {
      mime,
      bytes: bytes.length,
      dataUrl: `data:${mime};base64,${bytes.toString("base64")}`,
    };
  }

  const text = await request(key, {
    model,
    input: "Return exactly COUNTERSHOT_META_READY. No other text.",
  });
  if (text.text.trim() !== "COUNTERSHOT_META_READY")
    throw new SmokeError("text_check_failed");
  record("text", text);

  const structured = await request(key, {
    model,
    input: "Return ready true and provider meta in the required JSON object.",
    text: {
      format: {
        type: "json_schema",
        name: "countershot_smoke",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ready: { type: "boolean" },
            provider: { type: "string", enum: ["meta"] },
          },
          required: ["ready", "provider"],
        },
      },
    },
  });
  let value;
  try {
    value = JSON.parse(structured.text);
  } catch {
    throw new SmokeError("structured_json_parse_failed");
  }
  if (
    !value ||
    value.ready !== true ||
    value.provider !== "meta" ||
    Object.keys(value).sort().join(",") !== "provider,ready"
  ) {
    throw new SmokeError("structured_json_check_failed");
  }
  record("strict_json", structured);

  if (imageInput) {
    const result = await request(key, {
      model,
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Describe visible objects in one sentence. Do not infer physical dimensions or human abilities.",
            },
            { type: "input_image", image_url: imageInput.dataUrl },
          ],
        },
      ],
    });
    if (!result.text.trim()) throw new SmokeError("image_response_empty");
    record("image_response", result);
  }

  console.log(
    JSON.stringify(
      {
        status: "passed",
        model,
        endpoint: BASE_URL,
        checks,
        image: imageInput
          ? { mime: imageInput.mime, bytes: imageInput.bytes }
          : "not_requested",
        scope:
          "Provider connectivity and response contracts; not physical accuracy or completion.",
      },
      null,
      2,
    ),
  );
}

try {
  await main();
} catch (error) {
  const safe =
    error instanceof SmokeError
      ? error
      : new SmokeError("unexpected_local_error");
  console.log(
    JSON.stringify(
      { status: "failed", checks, error: { kind: safe.kind, ...safe.details } },
      null,
      2,
    ),
  );
  process.exitCode = 1;
}
