import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * Tier 1.3 — proxy-side integration of the SessionRegistry.
 *
 * The proxy consults the registry at the existing allowlist-check call site
 * (src/mcp-proxy/server.ts). When the request has a sessionId AND the
 * registry has an entry for it, the per-session allowlist is used; otherwise
 * the request falls through to the global allowlist (Phase 1 behaviour).
 *
 * Locked-in invariants:
 *   - Lookup precedence: per-session > global. A registered session NEVER
 *     uses the global allowlist.
 *   - Lookup miss is silent: a sessionId that the registry doesn't know about
 *     falls through to global, never blocks the request.
 *   - Audit entries on per-session blocks carry the sessionId so operators
 *     can demux per-agent post-incident.
 *   - Malformed sessionId headers (which Tier 1.1 turns into undefined) NEVER
 *     accidentally use a registered allowlist.
 */

const { mockLogger, auditEntries } = vi.hoisted(() => {
  const mockLogger = {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn(),
  };
  mockLogger.child.mockReturnValue(mockLogger);
  const auditEntries: unknown[] = [];
  return { mockLogger, auditEntries };
});
vi.mock("../src/logger.js", () => ({
  default: mockLogger, childLogger: vi.fn(() => mockLogger),
}));
vi.mock("../src/mcp-proxy/logger.js", async () => {
  const actual = await vi.importActual<typeof import("../src/mcp-proxy/logger.js")>(
    "../src/mcp-proxy/logger.js"
  );
  return {
    ...actual,
    logAuditEntry: vi.fn((entry: unknown) => {
      auditEntries.push(entry);
    }),
  };
});

import { createProxyServer, type ProxyServerConfig } from "../src/mcp-proxy/server.js";
import { createSessionRegistry, type SessionRegistry } from "../src/orchestrator/session-registry.js";
import type { StdioBridge } from "../src/mcp-proxy/stdio-bridge.js";
import type { AuditEntry } from "../src/mcp-proxy/logger.js";
import type { MetricsRecorder } from "../src/observability/metrics.js";

interface SpyRecorder extends MetricsRecorder {
  recordRequest: ReturnType<typeof vi.fn>;
  recordBlockedRequest: ReturnType<typeof vi.fn>;
}

function makeBridge(): StdioBridge {
  return {
    call: vi.fn(async () => ({ content: "ok" })),
    shutdown: vi.fn(async () => {}),
  } as unknown as StdioBridge;
}

function makeSpyRecorder(): SpyRecorder {
  return {
    recordRequest: vi.fn(),
    recordInjectionFlag: vi.fn(),
    recordBlockedRequest: vi.fn(),
    metricsText: vi.fn(async () => ({ contentType: "text/plain", body: "" })),
    shutdown: vi.fn(async () => {}),
  };
}

function makeConfig(overrides: Partial<ProxyServerConfig> = {}): ProxyServerConfig {
  return {
    port: 0,
    // Global allowlist matches what Phase 1 deployments use — exact tool names.
    allowedTools: ["Read", "Grep"],
    logLevel: "error",
    ...overrides,
  };
}

async function startServer(config: ProxyServerConfig): Promise<{ server: Server; url: string }> {
  const app = createProxyServer(config);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${addr.port}/mcp` };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function mcpCall(
  url: string,
  id: number,
  toolName: string,
  args: Record<string, unknown> = {},
  headers: Record<string, string> = {}
) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });
}

describe("Tier 1.3 — proxy uses per-session allowlist when registered", () => {
  let server: Server;
  let url: string;
  let registry: SessionRegistry;
  let recorder: SpyRecorder;

  beforeEach(async () => {
    auditEntries.length = 0;
    registry = createSessionRegistry();
    recorder = makeSpyRecorder();
    const started = await startServer(makeConfig({
      bridge: makeBridge(),
      serverRoutes: { Read: "fs", Write: "fs", Grep: "fs" },
      registry,
      recorder,
    }));
    server = started.server;
    url = started.url;
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it("session A registered with [Read] → Read is allowed, Write is blocked (uses A's allowlist)", async () => {
    registry.register({ sessionId: "A", agentType: "reviewer", allowlist: { patterns: ["Read"] } });
    const allowed = await mcpCall(url, 1, "Read", {}, { "X-Agent-Session-Id": "A" });
    expect(allowed.status).toBe(200);
    const allowedJson = (await allowed.json()) as { result?: unknown; error?: unknown };
    expect(allowedJson.result).toBeDefined();
    expect(allowedJson.error).toBeUndefined();

    const blocked = await mcpCall(url, 2, "Write", {}, { "X-Agent-Session-Id": "A" });
    const blockedJson = (await blocked.json()) as { error?: { code: number; message: string } };
    expect(blockedJson.error?.code).toBe(-32600);
    expect(blockedJson.error?.message).toMatch(/allowlist/i);
  });

  it("session B registered with [Write] → Write is allowed, Read is blocked (independent of A)", async () => {
    registry.register({ sessionId: "A", agentType: "reviewer", allowlist: { patterns: ["Read"] } });
    registry.register({ sessionId: "B", agentType: "coder", allowlist: { patterns: ["Write"] } });
    const allowed = await mcpCall(url, 1, "Write", {}, { "X-Agent-Session-Id": "B" });
    const allowedJson = (await allowed.json()) as { result?: unknown; error?: unknown };
    expect(allowedJson.result).toBeDefined();

    const blocked = await mcpCall(url, 2, "Read", {}, { "X-Agent-Session-Id": "B" });
    const blockedJson = (await blocked.json()) as { error?: { code: number; message: string } };
    expect(blockedJson.error?.code).toBe(-32600);
  });

  it("sessionId is set but registry has no entry → falls through to global ALLOWED_TOOLS", async () => {
    // Global allowlist is ["Read", "Grep"]. Session "C" not registered.
    const readRes = await mcpCall(url, 1, "Read", {}, { "X-Agent-Session-Id": "C" });
    const readJson = (await readRes.json()) as { result?: unknown; error?: unknown };
    expect(readJson.result).toBeDefined();

    const writeRes = await mcpCall(url, 2, "Write", {}, { "X-Agent-Session-Id": "C" });
    const writeJson = (await writeRes.json()) as { error?: { code: number } };
    expect(writeJson.error?.code).toBe(-32600);
  });

  it("no X-Agent-Session-Id header → uses global allowlist (Phase 1 backward compat)", async () => {
    const readRes = await mcpCall(url, 1, "Read", {});
    const readJson = (await readRes.json()) as { result?: unknown };
    expect(readJson.result).toBeDefined();

    const writeRes = await mcpCall(url, 2, "Write", {});
    const writeJson = (await writeRes.json()) as { error?: { code: number } };
    expect(writeJson.error?.code).toBe(-32600);
  });

  it("audit entry on per-session block carries sessionId AND reason='allowlist'", async () => {
    registry.register({ sessionId: "audit-sess", agentType: "reviewer", allowlist: { patterns: ["Read"] } });
    await mcpCall(url, 1, "Write", {}, { "X-Agent-Session-Id": "audit-sess", "X-Agent-Type": "reviewer" });
    const blockedEntry = (auditEntries as AuditEntry[]).find((e) => e.status === "blocked");
    expect(blockedEntry).toBeDefined();
    expect(blockedEntry!.sessionId).toBe("audit-sess");
    expect(blockedEntry!.agentType).toBe("reviewer");
    // Reason is "allowlist" regardless of which list blocked it. Operators
    // distinguish per-session vs global blocks via the sessionId field.
    expect(recorder.recordBlockedRequest).toHaveBeenCalledWith("allowlist");
  });

  it("global block (no sessionId) records the same block reason as a per-session block", async () => {
    await mcpCall(url, 1, "Write", {});
    expect(recorder.recordBlockedRequest).toHaveBeenCalledWith("allowlist");
  });

  it("malformed sessionId header (Tier 1.1 strips it) → falls through to global, NOT to a coincidentally-registered entry", async () => {
    // Strongest version of this guard: register an entry under the EXACT
    // string the malformed header carries. A buggy proxy that keyed registry
    // lookups off the raw req.header() value (instead of the Tier 1.1-parsed
    // sessionId) would match this entry and allow Write. The correct
    // behaviour: identity-header parser rejects the header (charset violation),
    // sessionId becomes undefined, registry is NOT consulted, request falls
    // through to global allowlist — Write is blocked.
    registry.register({ sessionId: "bad value!", agentType: "reviewer", allowlist: { patterns: ["Write"] } });
    const writeRes = await mcpCall(url, 1, "Write", {}, { "X-Agent-Session-Id": "bad value!" });
    const writeJson = (await writeRes.json()) as { error?: { code: number } };
    expect(writeJson.error?.code).toBe(-32600);
    const readRes = await mcpCall(url, 2, "Read", {}, { "X-Agent-Session-Id": "bad value!" });
    const readJson = (await readRes.json()) as { result?: unknown };
    expect(readJson.result).toBeDefined();
  });
});
