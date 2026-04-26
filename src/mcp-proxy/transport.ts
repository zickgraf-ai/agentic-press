import { childLogger } from "../logger.js";

const log = childLogger("transport");

/**
 * Transport-agnostic MCP bridge interface. Both `createStdioBridge` (local
 * subprocess) and `createHttpBridge` (Streamable HTTP) implement this. The
 * proxy server's security pipeline operates on JSON-RPC messages and is
 * indifferent to the transport.
 *
 * `call()` returns the raw `result` field from the upstream JSON-RPC response
 * — the caller treats it as opaque and runs the response sanitizer on it.
 * Failures reject with typed errors:
 *   - `ResponseSizeExceededError` (from stdio-bridge.ts) — re-exported here
 *     for symmetry; HTTP bridge throws the same type so server.ts's existing
 *     `.catch` branch handles both transports identically.
 *   - Generic `Error` — server.ts converts these to `-32603` JSON-RPC errors.
 */
export interface McpTransport {
  call(serverName: string, method: string, params: unknown): Promise<unknown>;
  shutdown(): Promise<void>;
}

/**
 * Server definition discriminated by `transport`. Stdio defs spawn a local
 * subprocess; HTTP defs target a remote URL with optional bearer token.
 */
export type McpServerDef =
  | McpStdioServerDef
  | McpHttpServerDef;

export interface McpStdioServerDef {
  readonly name: string;
  readonly transport: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Record<string, string>;
}

export interface McpHttpServerDef {
  readonly name: string;
  readonly transport: "http";
  readonly url: string;
  readonly bearerToken?: string;
  readonly headers?: Record<string, string>;
}

/**
 * Composite transport — dispatches `call(serverName, ...)` to whichever
 * underlying bridge owns that server name. Used in the composition root
 * when both stdio and http servers are configured.
 *
 * `shutdown()` uses Promise.allSettled so a single bridge's shutdown failure
 * never poisons the proxy's exit path.
 */
export function createCompositeTransport(
  routes: readonly { bridge: McpTransport; owns: readonly string[] }[]
): McpTransport {
  // Build a flat name → bridge map for O(1) dispatch
  const ownerByName = new Map<string, McpTransport>();
  for (const { bridge, owns } of routes) {
    for (const name of owns) {
      if (ownerByName.has(name)) {
        throw new Error(
          `createCompositeTransport: server "${name}" claimed by multiple bridges`
        );
      }
      ownerByName.set(name, bridge);
    }
  }

  return {
    async call(serverName, method, params) {
      const bridge = ownerByName.get(serverName);
      if (!bridge) {
        throw new Error(
          `Server "${serverName}" not configured in any bridge ` +
            `(known: ${[...ownerByName.keys()].join(", ") || "none"})`
        );
      }
      return bridge.call(serverName, method, params);
    },
    async shutdown() {
      const bridges = [...new Set(routes.map((r) => r.bridge))];
      const results = await Promise.allSettled(bridges.map((b) => b.shutdown()));
      for (const r of results) {
        if (r.status === "rejected") {
          log.warn({ err: r.reason }, "transport shutdown failed (ignored)");
        }
      }
    },
  };
}
