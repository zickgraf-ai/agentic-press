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

      // Header precedence: custom headers FIRST (lowest priority), then our
      // Content-Type/Accept defaults, then Authorization. A malicious or
      // misconfigured `headers: { "Content-Type": "text/plain" }` cannot
      // override the JSON content type and break upstream parsing, and
      // `headers: { "Authorization": "..." }` cannot override the bearer
      // token (it would otherwise be a way to bypass the bearerToken field).
      const headers: Record<string, string> = {
        ...server.headers,
        "Content-Type": "application/json",
        Accept: "application/json",
      };
      if (server.bearerToken) {
        headers["Authorization"] = `Bearer ${server.bearerToken}`;
      }

      // Single AbortController covers the FULL request lifecycle: send,
      // headers, body read. A malicious upstream that sends headers fast
      // then drip-feeds the body would otherwise stall the proxy
      // indefinitely (the original timeout was cleared after fetch resolved).
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), requestTimeoutMs);

      try {
        let response: Response;
        try {
          response = await fetchImpl(server.url, {
            method: "POST",
            headers,
            body,
            signal: controller.signal,
            // SECURITY: Do not follow redirects. A compromised or hostile
            // upstream could 301/302 to attacker.com and fetch would replay
            // the Authorization: Bearer header, exfiltrating the token.
            // Same vulnerability class as CVE-2025-6514.
            redirect: "error",
          });
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") {
            throw new Error(
              `HTTP server "${serverName}" timed out after ${requestTimeoutMs}ms`
            );
          }
          // Wrap with server context so operators can identify which upstream
          // failed (DNS errors, TLS errors, connection refused all land here).
          const msg = err instanceof Error ? err.message : String(err);
          log.warn({ server: serverName, url: server.url, error: msg }, "HTTP request failed");
          throw new Error(`HTTP server "${serverName}" request failed: ${msg}`);
        }

        if (!response.ok) {
          log.warn(
            { server: serverName, status: response.status, statusText: response.statusText },
            "HTTP server returned non-2xx"
          );
          throw new Error(
            `HTTP server "${serverName}" returned ${response.status} ${response.statusText}`
          );
        }

        // STREAM the body and enforce the byte cap incrementally — abort the
        // moment we exceed it. This bounds memory at maxResponseBytes (plus
        // one chunk's worth of overhead) instead of letting the full body
        // buffer first. Multi-GB responses can no longer OOM the proxy.
        let text: string;
        try {
          text = await readBodyWithCap(response, serverName, maxResponseBytes);
        } catch (err) {
          if (err instanceof ResponseSizeExceededError) throw err;
          if (err instanceof Error && err.name === "AbortError") {
            throw new Error(
              `HTTP server "${serverName}" timed out after ${requestTimeoutMs}ms while reading body`
            );
          }
          const msg = err instanceof Error ? err.message : String(err);
          log.warn({ server: serverName, error: msg }, "Failed to read response body");
          throw new Error(`HTTP server "${serverName}" body read failed: ${msg}`);
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`HTTP server "${serverName}" returned non-JSON response: ${msg}`);
        }

        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error(`HTTP server "${serverName}" returned malformed JSON-RPC envelope`);
        }
        const env = parsed as { id?: unknown; result?: unknown; error?: { message?: string; code?: number } };

        if (env.error) {
          const msg = env.error.message ?? "unknown error";
          throw new Error(`HTTP server "${serverName}" returned JSON-RPC error: ${msg}`);
        }

        // JSON-RPC 2.0 spec: a successful response MUST contain a `result`
        // member. Missing both `result` and `error` is a malformed envelope.
        if (!("result" in env)) {
          throw new Error(`HTTP server "${serverName}" returned envelope with neither result nor error`);
        }

        return env.result;
      } finally {
        clearTimeout(timeoutHandle);
      }
    },

    async shutdown() {
      // Plain fetch has no persistent state to clean up. Future work: if we
      // adopt connection pooling via undici Agents, dispose them here.
      log.debug("HTTP bridge shutdown — no persistent state");
    },
  };
}

/**
 * Read the response body as text, enforcing a byte cap during the stream
 * read. Aborts the stream and throws ResponseSizeExceededError as soon as
 * the accumulated bytes exceed `maxBytes`. With `maxBytes <= 0`, the cap
 * is disabled and we fall back to the standard `response.text()` (still
 * bounded by Node's HTTP impl, but no early abort).
 */
async function readBodyWithCap(
  response: Response,
  serverName: string,
  maxBytes: number
): Promise<string> {
  if (maxBytes <= 0 || !response.body) {
    return response.text();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      // Cancel the underlying connection so the upstream stops sending.
      // Fire-and-forget: we already have what we need to throw.
      void reader.cancel().catch(() => {});
      throw new ResponseSizeExceededError(serverName, maxBytes, totalBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
