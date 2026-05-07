import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * Phase 2 Tier 1.2 — identity (sessionId / agentType) propagated by the proxy
 * through audit, event bridge, and metrics surfaces. Tier 1.1 (#51, merged in
 * #52) wired the headers into Langfuse traces; this file covers the remaining
 * three surfaces so all four observability streams demultiplex per-agent.
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
vi.mock("../src/mcp-proxy/logger.js", () => ({
  logAuditEntry: vi.fn((entry: unknown) => {
    auditEntries.push(entry);
  }),
}));

import { createProxyServer, type ProxyServerConfig } from "../src/mcp-proxy/server.js";
import type { EventBridge } from "../src/dashboard/event-bridge.js";
import type { MetricsRecorder } from "../src/observability/metrics.js";
import type { StdioBridge } from "../src/mcp-proxy/stdio-bridge.js";
import type { AuditEntry } from "../src/mcp-proxy/logger.js";

interface SpyEventBridge extends EventBridge {
  emit: ReturnType<typeof vi.fn>;
}

interface SpyRecorder extends MetricsRecorder {
  recordRequest: ReturnType<typeof vi.fn>;
}

function makeBridge(): StdioBridge {
  return {
    call: vi.fn(async () => ({ content: "ok" })),
    shutdown: vi.fn(async () => {}),
  } as unknown as StdioBridge;
}

function makeSpyEventBridge(): SpyEventBridge {
  return {
    emit: vi.fn(),
    flush: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
  };
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
    allowedTools: ["Read"],
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

describe("Tier 1.2 — identity propagation through audit / events / metrics", () => {
  let server: Server;
  let url: string;
  let eventBridge: SpyEventBridge;
  let recorder: SpyRecorder;

  beforeEach(async () => {
    auditEntries.length = 0;
    eventBridge = makeSpyEventBridge();
    recorder = makeSpyRecorder();
    const started = await startServer(makeConfig({
      bridge: makeBridge(),
      serverRoutes: { Read: "fs" },
      eventBridge,
      recorder,
    }));
    server = started.server;
    url = started.url;
  });

  afterEach(async () => {
    await closeServer(server);
  });

  describe("AuditEntry", () => {
    it("includes sessionId and agentType when both headers are sent", async () => {
      await mcpCall(url, 1, "Read", { path: "./pkg.json" }, {
        "X-Agent-Session-Id": "task-001",
        "X-Agent-Type": "reviewer",
      });
      const lastEntry = auditEntries.at(-1) as AuditEntry;
      expect(lastEntry.sessionId).toBe("task-001");
      expect(lastEntry.agentType).toBe("reviewer");
    });

    it("omits sessionId and agentType when no headers are sent (Phase 1 backward compat)", async () => {
      await mcpCall(url, 2, "Read", { path: "./pkg.json" });
      const lastEntry = auditEntries.at(-1) as AuditEntry;
      expect(lastEntry.sessionId).toBeUndefined();
      expect(lastEntry.agentType).toBeUndefined();
    });

    it("includes only sessionId when only X-Agent-Session-Id is sent", async () => {
      await mcpCall(url, 3, "Read", {}, { "X-Agent-Session-Id": "sess-only" });
      const lastEntry = auditEntries.at(-1) as AuditEntry;
      expect(lastEntry.sessionId).toBe("sess-only");
      expect(lastEntry.agentType).toBeUndefined();
    });

    it("propagates identity to blocked-status audit entries (allowlist reject)", async () => {
      await mcpCall(url, 4, "Forbidden", {}, {
        "X-Agent-Session-Id": "task-002",
        "X-Agent-Type": "coder",
      });
      const blockedEntry = auditEntries.find(
        (e: unknown) => (e as AuditEntry).status === "blocked"
      ) as AuditEntry | undefined;
      expect(blockedEntry).toBeDefined();
      expect(blockedEntry!.sessionId).toBe("task-002");
      expect(blockedEntry!.agentType).toBe("coder");
    });

    it("falls through cleanly when malformed identity headers are sent (Tier 1.1 invariant preserved)", async () => {
      await mcpCall(url, 5, "Read", { path: "./pkg.json" }, {
        "X-Agent-Session-Id": "bad value!",
      });
      const lastEntry = auditEntries.at(-1) as AuditEntry;
      // Malformed header → identity dropped → audit entry has no sessionId.
      // Anchor #C5: malformed identity must not break the request, so the
      // call still produces an audit entry with status=allowed.
      expect(lastEntry.sessionId).toBeUndefined();
      expect(lastEntry.status).toBe("allowed");
    });
  });

  describe("EventBridge ActivityEvent", () => {
    it("emit receives an entry with sessionId and agentType when headers are sent", async () => {
      await mcpCall(url, 10, "Read", {}, {
        "X-Agent-Session-Id": "task-100",
        "X-Agent-Type": "tester",
      });
      const lastEmit = eventBridge.emit.mock.calls.at(-1)![0] as AuditEntry;
      expect(lastEmit.sessionId).toBe("task-100");
      expect(lastEmit.agentType).toBe("tester");
    });

    it("emit omits sessionId/agentType when no headers (Phase 1 shape)", async () => {
      await mcpCall(url, 11, "Read", { path: "./pkg.json" });
      const lastEmit = eventBridge.emit.mock.calls.at(-1)![0] as AuditEntry;
      expect(lastEmit.sessionId).toBeUndefined();
      expect(lastEmit.agentType).toBeUndefined();
    });
  });

  describe("MetricsRecorder agentType label", () => {
    it("recordRequest receives agentType as the 4th positional arg when X-Agent-Type is sent", async () => {
      await mcpCall(url, 20, "Read", { path: "./pkg.json" }, { "X-Agent-Type": "reviewer" });
      const lastCall = recorder.recordRequest.mock.calls.at(-1)!;
      expect(lastCall[3]).toBe("reviewer");
    });

    it("recordRequest receives undefined agentType when no header is sent (recorder maps to sentinel internally)", async () => {
      await mcpCall(url, 21, "Read", { path: "./pkg.json" });
      const lastCall = recorder.recordRequest.mock.calls.at(-1)!;
      expect(lastCall[3]).toBeUndefined();
    });

    it("two requests with distinct agentTypes record distinct label values", async () => {
      await mcpCall(url, 30, "Read", {}, { "X-Agent-Type": "reviewer" });
      await mcpCall(url, 31, "Read", {}, { "X-Agent-Type": "coder" });
      const calls = recorder.recordRequest.mock.calls;
      const reviewer = calls.find((c) => c[3] === "reviewer");
      const coder = calls.find((c) => c[3] === "coder");
      expect(reviewer).toBeDefined();
      expect(coder).toBeDefined();
    });
  });
});
