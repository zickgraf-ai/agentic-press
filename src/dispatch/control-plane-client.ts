import { childLogger } from "../logger.js";
import type { SessionId } from "../orchestrator/session-id.js";

const log = childLogger("dispatch-client");

const DEFAULT_BASE_URL = "http://127.0.0.1:18924";
const DEFAULT_RETRY_DELAYS_MS = [100, 400] as const;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

export type ControlPlaneFailure =
  | { readonly kind: "auth" }
  | { readonly kind: "validation"; readonly serverMessage: string }
  | { readonly kind: "server"; readonly status: number; readonly attempts: number }
  | { readonly kind: "connect"; readonly detail: string };

function formatFailure(f: ControlPlaneFailure): string {
  switch (f.kind) {
    case "auth":
      return "Control-plane rejected our bearer token (HTTP 401). Check MCP_CONTROL_TOKEN.";
    case "validation":
      return `Control-plane rejected the registration payload (HTTP 400): ${f.serverMessage}`;
    case "server":
      return `Control-plane returned HTTP ${f.status} after ${f.attempts} attempt(s). Is the proxy / control plane healthy?`;
    case "connect":
      return `Cannot reach the control plane (${f.detail}). Is the proxy running with MCP_CONTROL_TOKEN set?`;
  }
}

export class ControlPlaneError extends Error {
  public readonly failure: ControlPlaneFailure;
  constructor(failure: ControlPlaneFailure) {
    super(formatFailure(failure));
    this.name = "ControlPlaneError";
    this.failure = failure;
  }
}

export interface RegisterPayload {
  readonly sessionId: SessionId;
  readonly agentType: string;
  readonly allowedTools: readonly string[];
}

export interface ControlPlaneClient {
  register(payload: RegisterPayload): Promise<void>;
  deregister(sessionId: SessionId): Promise<void>;
}

export interface ControlPlaneClientOptions {
  readonly token: string;
  readonly baseUrl?: string;
  readonly retryDelaysMs?: readonly number[];
  readonly requestTimeoutMs?: number;
}

const CONNECT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "EAI_AGAIN"]);

function extractCode(value: unknown): string | undefined {
  if (value && typeof value === "object" && "code" in value) {
    const code = (value as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

// Node's fetch implementation wraps connection failures as AggregateError
// under cause.errors[]. We walk all the documented and observed shapes; if a
// future implementation rearranges them, the last-resort TypeError fallback
// below classifies "fetch failed" as a connect error.
function classifyFetchError(err: unknown): ControlPlaneFailure | undefined {
  if (!(err instanceof Error)) return undefined;
  const direct = extractCode(err);
  if (direct && CONNECT_CODES.has(direct)) return { kind: "connect", detail: direct };
  const cause = (err as { cause?: unknown }).cause;
  const causeCode = extractCode(cause);
  if (causeCode && CONNECT_CODES.has(causeCode)) return { kind: "connect", detail: causeCode };
  if (cause && typeof cause === "object" && "errors" in cause) {
    const inner = (cause as { errors?: unknown }).errors;
    if (Array.isArray(inner)) {
      for (const sub of inner) {
        const subCode = extractCode(sub);
        if (subCode && CONNECT_CODES.has(subCode)) return { kind: "connect", detail: subCode };
      }
    }
  }
  // Last-resort fallback: Node's fetch raises TypeError for all network-layer
  // failures. If we couldn't extract a code from any of the standard shapes,
  // a bare "fetch failed" TypeError is overwhelmingly a connectivity issue
  // and giving the operator the connect-error message is more useful than a
  // generic "unexpected".
  if (err.name === "TypeError" && /fetch failed/i.test(err.message)) {
    return { kind: "connect", detail: "fetch failed (no error code surfaced — check that the proxy is running)" };
  }
  return undefined;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || (err as { code?: unknown }).code === "ABORT_ERR");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createControlPlaneClient(opts: ControlPlaneClientOptions): ControlPlaneClient {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const retryDelays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  // Closure-scoped — must never appear in logs or thrown errors.
  const authHeader = `Bearer ${opts.token}`;

  async function singleAttempt(input: RequestInfo, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function callWithRetry(
    label: string,
    fn: () => Promise<Response>
  ): Promise<Response> {
    const maxAttempts = retryDelays.length + 1;
    let lastStatus = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res: Response;
      try {
        res = await fn();
      } catch (err) {
        if (isAbortError(err)) {
          throw new ControlPlaneError({
            kind: "connect",
            detail: `request timed out after ${timeoutMs}ms`,
          });
        }
        const classified = classifyFetchError(err);
        if (classified) throw new ControlPlaneError(classified);
        // Unexpected — log enriched details (no token) so a future undici drift
        // is diagnosable from the log, then re-throw.
        log.warn(
          {
            label,
            attempt,
            errName: err instanceof Error ? err.name : "unknown",
            causeName: err instanceof Error && err.cause instanceof Error ? err.cause.name : undefined,
            causeCode: extractCode(err instanceof Error ? err.cause : undefined),
          },
          "control-plane fetch errored — unclassified"
        );
        throw err;
      }
      if (res.status === 401) {
        throw new ControlPlaneError({ kind: "auth" });
      }
      if (res.status >= 400 && res.status < 500) {
        return res;
      }
      if (res.status >= 500) {
        lastStatus = res.status;
        if (attempt < maxAttempts) {
          const delay = retryDelays[attempt - 1] ?? 0;
          log.warn({ label, attempt, status: res.status, nextDelayMs: delay }, "control-plane 5xx — will retry");
          await sleep(delay);
          continue;
        }
        throw new ControlPlaneError({ kind: "server", status: res.status, attempts: attempt });
      }
      return res;
    }
    throw new ControlPlaneError({ kind: "server", status: lastStatus, attempts: maxAttempts });
  }

  return {
    async register(payload: RegisterPayload): Promise<void> {
      const res = await callWithRetry("register", () =>
        singleAttempt(`${baseUrl}/sessions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: authHeader,
          },
          body: JSON.stringify(payload),
        })
      );
      if (res.status === 201) return;
      if (res.status === 400) {
        throw new ControlPlaneError({ kind: "validation", serverMessage: await extractServerMessage(res) });
      }
      throw new ControlPlaneError({ kind: "server", status: res.status, attempts: 1 });
    },

    async deregister(sessionId: SessionId): Promise<void> {
      // On deregister, log loud BEFORE rethrowing so the CLI's leak-detection
      // can convert it to exit 70.
      const res = await callWithRetry("deregister", () =>
        singleAttempt(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}`, {
          method: "DELETE",
          headers: { Authorization: authHeader },
        })
      ).catch((err) => {
        if (err instanceof ControlPlaneError) {
          log.warn({ sessionId, failure: err.failure }, "deregister failed — registration may leak");
        }
        throw err;
      });
      if (res.status === 204) return;
      if (res.status === 404) {
        log.warn({ sessionId }, "deregister returned 404 — session was not in registry");
        return;
      }
      if (res.status === 400) {
        throw new ControlPlaneError({ kind: "validation", serverMessage: await extractServerMessage(res) });
      }
      throw new ControlPlaneError({ kind: "server", status: res.status, attempts: 1 });
    },
  };
}

// Pull the operator-readable diagnostic out of a 4xx response. Prefer the
// server's `{ error }` field; if the body isn't JSON, fall back to the raw text
// so the operator still sees what the server said. Logs the raw body on JSON
// parse failure so unexpected response shapes are diagnosable.
async function extractServerMessage(res: Response): Promise<string> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return "(could not read response body)";
  }
  if (!text) return "(no message)";
  try {
    const body = JSON.parse(text) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
    log.warn({ status: res.status, body: text.slice(0, 200) }, "control-plane 4xx returned JSON without a string error field");
    return text;
  } catch {
    log.warn({ status: res.status, body: text.slice(0, 200) }, "control-plane 4xx body was not JSON");
    return text;
  }
}
