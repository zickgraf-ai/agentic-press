import { childLogger } from "../logger.js";
import {
  ResponseSizeExceededError,
  DEFAULT_MAX_RESPONSE_BYTES,
} from "./stdio-bridge.js";
import type { McpHttpServerDef, McpTransport } from "./transport.js";

const log = childLogger("http-bridge");

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface HttpBridgeOptions {
  /**
   * Per-request timeout in milliseconds. Default 30s — matches the stdio
   * bridge's per-request timeout so the two transports have symmetric
   * client-visible behavior.
   */
  readonly requestTimeoutMs?: number;
  /**
   * Hard cap on the byte size of an HTTP response body. The check runs on the
   * already-received body string (post-fetch, pre-JSON.parse where possible)
   * so a hostile or runaway upstream cannot OOM the proxy through unbounded
   * responses. Set to 0 to disable.
   *
   * Note: unlike stdio (where the cap fires at the read layer before the full
   * line is buffered), HTTP buffers the full response body before we can
   * measure it. The OOM defence here is weaker but still meaningful — fetch's
   * default body buffering is bounded by Node's HTTP implementation.
   *
   * Default: DEFAULT_MAX_RESPONSE_BYTES (10 MiB).
   */
  readonly maxResponseBytes?: number;
  /** Optional fetch impl — pass for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Streamable HTTP transport for remote MCP servers. Speaks raw JSON-RPC over
 * HTTP POST — does not perform the MCP `initialize` handshake (the proxy is
 * stateless per request, matching how `createStdioBridge` works against
 * subprocess MCP servers).
 *
 * For each `call(serverName, method, params)`:
 *   1. POST `{ jsonrpc, id, method, params }` to the server's URL with
 *      Authorization: Bearer (if configured) + custom headers
 *   2. Read response body as text
 *   3. Enforce response size cap
 *   4. Parse JSON; reject on `error` field; resolve with `result`
 *
 * Streaming responses (text/event-stream) are out of scope for this PR.
 * Servers that respond with SSE will fail at the JSON.parse step — file an
 * issue if needed.
 */
export function createHttpBridge(
  servers: readonly McpHttpServerDef[],
  opts: HttpBridgeOptions = {}
): McpTransport {
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const fetchImpl = opts.fetchImpl ?? fetch;

  // Index servers by name for O(1) lookup
  const byName = new Map<string, McpHttpServerDef>();
  for (const s of servers) {
    if (byName.has(s.name)) {
      throw new Error(`createHttpBridge: duplicate server name "${s.name}"`);
    }
    byName.set(s.name, s);
  }

  // Monotonic per-bridge request id. JSON-RPC requires the id to round-trip
  // so the client can correlate responses; we use a simple counter rather
  // than relying on the proxy's request id (which is exposed to the agent).
  let nextId = 1;

  return {
    async call(serverName, method, params) {
      const server = byName.get(serverName);
      if (!server) {
        throw new Error(
          `HTTP server "${serverName}" not configured (known: ${[...byName.keys()].join(", ") || "none"})`
        );
      }

      const id = nextId++;
      const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...server.headers,
      };
      if (server.bearerToken) {
        headers["Authorization"] = `Bearer ${server.bearerToken}`;
      }

      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), requestTimeoutMs);

      let response: Response;
      try {
        response = await fetchImpl(server.url, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timeoutHandle);
        if (err instanceof Error && err.name === "AbortError") {
          throw new Error(
            `HTTP server "${serverName}" timed out after ${requestTimeoutMs}ms`
          );
        }
        throw err;
      }
      clearTimeout(timeoutHandle);

      if (!response.ok) {
        throw new Error(
          `HTTP server "${serverName}" returned ${response.status} ${response.statusText}`
        );
      }

      const text = await response.text();

      // Enforce response size cap. Same error type as stdio so server.ts's
      // existing -32001 indistinguishable-rejection branch handles both.
      if (maxResponseBytes > 0) {
        const observed = Buffer.byteLength(text, "utf8");
        if (observed > maxResponseBytes) {
          throw new ResponseSizeExceededError(serverName, maxResponseBytes, observed);
        }
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`HTTP server "${serverName}" returned non-JSON response: ${msg}`);
      }

      if (typeof parsed !== "object" || parsed === null) {
        throw new Error(`HTTP server "${serverName}" returned malformed JSON-RPC envelope`);
      }
      const env = parsed as { id?: unknown; result?: unknown; error?: { message?: string; code?: number } };

      if (env.error) {
        const msg = env.error.message ?? "unknown error";
        throw new Error(`HTTP server "${serverName}" returned JSON-RPC error: ${msg}`);
      }

      return env.result;
    },

    async shutdown() {
      // Plain fetch has no persistent state to clean up. Future work: if we
      // adopt connection pooling via undici Agents, dispose them here.
      log.debug("HTTP bridge shutdown — no persistent state");
    },
  };
}
