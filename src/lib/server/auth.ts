import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { Health } from "../contracts";
import { AppError } from "./errors";

const localSecret = randomBytes(32).toString("hex");
const cookieName = "countershot_session";
const production = () => process.env.NODE_ENV === "production";
export const modelName = () =>
  process.env.META_MODEL?.trim() || "muse-spark-1.3";
export function isConfiguredKey(value: string | undefined): boolean {
  const key = value?.trim();
  return Boolean(
    key &&
    !/placeholder|^changeme$|^(?:replace|your|paste|insert)(?:[_ -]|$)/i.test(
      key,
    ),
  );
}
export function configured(): boolean {
  return isConfiguredKey(process.env.MODEL_API_KEY);
}
function authConfiguration() {
  const accessCode = process.env.COUNTERSHOT_ACCESS_CODE?.trim();
  const secret = process.env.SESSION_SECRET?.trim();
  return { accessCode, secret, required: production() || Boolean(accessCode) };
}
function equal(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
}
function signature(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}
export function authenticated(request: Request): boolean {
  const config = authConfiguration();
  if (!config.required) return true;
  if (
    !config.accessCode ||
    (production() && (!config.secret || config.secret.length < 32))
  )
    return false;
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
  if (!cookie) return false;
  const [payload, mac, extra] = cookie.split(".");
  if (
    !payload ||
    !mac ||
    extra ||
    !equal(mac, signature(payload, config.secret || localSecret))
  )
    return false;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString());
    return (
      typeof session.expiresAt === "number" && session.expiresAt > Date.now()
    );
  } catch {
    return false;
  }
}
export function health(request: Request): Health {
  return {
    configured: configured(),
    model: modelName(),
    authenticated: authenticated(request),
    accessRequired: authConfiguration().required,
  };
}
export function requireAuth(request: Request) {
  const config = authConfiguration();
  if (
    production() &&
    (!config.accessCode || !config.secret || config.secret.length < 32)
  )
    throw new AppError(
      "AUTH_SETUP_REQUIRED",
      "Configure an access code and a session secret of at least 32 characters on the server.",
      503,
    );
  if (!authenticated(request))
    throw new AppError(
      "AUTH_REQUIRED",
      "Enter the application access code to continue.",
      401,
    );
}
export function checkOrigin(request: Request) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  const origin = request.headers.get("origin");
  if (request.headers.get("sec-fetch-site") === "cross-site")
    throw new AppError(
      "ORIGIN_REJECTED",
      "Open CounterShot directly before submitting this request.",
      403,
    );
  if (!origin) {
    if (production())
      throw new AppError(
        "ORIGIN_REQUIRED",
        "Submit this request from the CounterShot application.",
        403,
      );
    return;
  }
  let source: URL;
  try {
    source = new URL(origin);
  } catch {
    throw new AppError(
      "ORIGIN_REJECTED",
      "The request origin is invalid.",
      403,
    );
  }
  const target = new URL(request.url);
  // Next can normalize Request.url to localhost even when the browser uses 127.0.0.1.
  // Host is the actual incoming authority; browsers cannot override it from script.
  const authority = request.headers.get("host") || target.host;
  const forwardedProtocol = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    .trim();
  const protocol =
    forwardedProtocol === "https" || forwardedProtocol === "http"
      ? `${forwardedProtocol}:`
      : target.protocol;
  if (source.host !== authority || source.protocol !== protocol)
    throw new AppError(
      "ORIGIN_REJECTED",
      "This request came from another website.",
      403,
    );
}
export function login(accessCode: string): string {
  const config = authConfiguration();
  if (!config.required)
    return `${cookieName}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`;
  if (
    !config.accessCode ||
    (production() && (!config.secret || config.secret.length < 32))
  )
    throw new AppError(
      "AUTH_SETUP_REQUIRED",
      "The server access controls have not been configured.",
      503,
    );
  if (!equal(accessCode, config.accessCode))
    throw new AppError(
      "INVALID_ACCESS_CODE",
      "The access code was not accepted.",
      401,
    );
  const payload = Buffer.from(
    JSON.stringify({ expiresAt: Date.now() + 12 * 60 * 60_000 }),
  ).toString("base64url");
  return `${cookieName}=${payload}.${signature(payload, config.secret || localSecret)}; Path=/; Max-Age=43200; HttpOnly; SameSite=Strict${production() ? "; Secure" : ""}`;
}
