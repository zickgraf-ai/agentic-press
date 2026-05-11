import { childLogger } from "../logger.js";

const log = childLogger("dispatch-client");

const DEFAULT_BASE_URL = "http://127.0.0.1:18924";
const DEFAULT_RETRY_DELAYS_MS = [100, 400] as const;

export class ControlPlaneAuthError extends Error {
  constructor(message = "Control-plane rejected our bearer token (HTTP 401). Check MCP_CONTROL_TOKEN.") {
    super(message);
    this.name = "ControlPlaneAuthError";
  }
}

export class ControlPlaneValidationError extends Error {
  constructor(serverMessage: string) {
    super(`Control-plane rejected the registration payload (HTTP 400): ${serverMessage}`);
    this.name = "ControlPlaneValidationError";
  }
}

export class ControlPlaneServerError extends Error {
  constructor(status: number, attempts: number) {
    super(
      `Control-plane returned HTTP ${status} after ${attempts} attempt(s). ` +
        `Is the proxy / control plane healthy?`
    );
    this.name = "ControlPlaneServerError";
  }
}

export class ControlPlaneConnectError extends Error {
  constructor(detail: string) {
    super(
      `Cannot reach the control plane (${detail}). ` +
        `Is the proxy running with MCP_CONTROL_TOKEN set?`
    );
    this.name = "ControlPlaneConnectError";
  }
}

export interface RegisterPayload {
  readonly sessionId: string;
  readonly agentType: string;
  readonly allowedTools: readonly string[];
}

export interface ControlPlaneClient {
  register(payload: RegisterPayload): Promise<void>;
  deregister(sessionId: string): Promise<void>;
}

export interface ControlPlaneClientOptions {
  readonly token: string;
  readonly baseUrl?: string;
  readonly retryDelaysMs?: readonly number[];
}

const CONNECT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "EAI_AGAIN"]);

function extractCode(value: unknown): string | undefined {
  if (value && typeof value === "object" && "code" in value) {
    const code = (value as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

function isConnectionRefused(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const direct = extractCode(err);
  if (direct && CONNECT_CODES.has(direct)) return true;
  const cause = (err as { cause?: unknown }).cause;
  const causeCode = extractCode(cause);
  if (causeCode && CONNECT_CODES.has(causeCode)) return true;
  // undici wraps connection failures as AggregateError under cause.errors[]
  if (cause && typeof cause === "object" && "errors" in cause) {
    const inner = (cause as { errors?: unknown }).errors;
    if (Array.isArray(inner)) {
      for (const sub of inner) {
        const subCode = extractCode(sub);
        if (subCode && CONNECT_CODES.has(subCode)) return true;
      }
    }
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createControlPlaneClient(opts: ControlPlaneClientOptions): ControlPlaneClient {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const retryDelays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  // Token held in closure; never logged, never returned.
  const token = opts.token;
  const authHeader = `Bearer ${token}`;

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
        if (isConnectionRefused(err)) {
          const code =
            err instanceof Error && err.cause && typeof err.cause === "object" && "code" in err.cause
              ? String((err.cause as { code?: unknown }).code)
              : "network error";
          throw new ControlPlaneConnectError(code);
        }
        // Unexpected fetch error — re-throw bare; caller logs without token.
        log.warn({ label, attempt, errName: err instanceof Error ? err.name : "unknown" }, "control-plane request errored");
        throw err;
      }
      if (res.status === 401) {
        throw new ControlPlaneAuthError();
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
        throw new ControlPlaneServerError(res.status, attempt);
      }
      return res;
    }
    // Unreachable; the loop returns or throws.
    throw new ControlPlaneServerError(lastStatus, maxAttempts);
  }

  return {
    async register(payload: RegisterPayload): Promise<void> {
      const res = await callWithRetry("register", () =>
        fetch(`${baseUrl}/sessions`, {
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
        let serverMsg = "(no message)";
        try {
          const body = (await res.json()) as { error?: unknown };
          if (typeof body.error === "string") serverMsg = body.error;
        } catch {
          // Swallow body-parse error — server response shape diverges, not fatal.
        }
        throw new ControlPlaneValidationError(serverMsg);
      }
      throw new ControlPlaneServerError(res.status, 1);
    },

    async deregister(sessionId: string): Promise<void> {
      try {
        const res = await callWithRetry("deregister", () =>
          fetch(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}`, {
            method: "DELETE",
            headers: { Authorization: authHeader },
          })
        );
        if (res.status === 204 || res.status === 404) return;
        if (res.status === 400) {
          let serverMsg = "(no message)";
          try {
            const body = (await res.json()) as { error?: unknown };
            if (typeof body.error === "string") serverMsg = body.error;
          } catch {
            // swallow
          }
          throw new ControlPlaneValidationError(serverMsg);
        }
        throw new ControlPlaneServerError(res.status, 1);
      } catch (err) {
        // On deregister, ECONNREFUSED is tolerated — the proxy may be shutting
        // down. Log loud (operator should know the registration is in a
        // partial state) but do not throw — the CLI's cleanup path already
        // counts this as a leak via the outer exit code.
        if (err instanceof ControlPlaneConnectError) {
          log.warn({ sessionId, err: err.message }, "deregister: control plane unreachable — registration may leak");
          throw err;
        }
        throw err;
      }
    },
  };
}
