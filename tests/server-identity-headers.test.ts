import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const { mockLogger } = vi.hoisted(() => {
  const mockLogger = {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn(),
  };
  mockLogger.child.mockReturnValue(mockLogger);
  return { mockLogger };
});
vi.mock("../src/logger.js", () => ({
  default: mockLogger, childLogger: vi.fn(() => mockLogger),
}));

import { createProxyServer, type ProxyServerConfig } from "../src/mcp-proxy/server.js";
import type { Tracer, ActiveTrace } from "../src/observability/langfuse.js";
import type { StdioBridge } from "../src/mcp-proxy/stdio-bridge.js";

interface SpyTracer extends Tracer {
  startTrace: ReturnType<typeof vi.fn>;
  span: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
  shutdown: ReturnType<typeof vi.fn>;
}

function makeSpyTracer(): SpyTracer {
  const span = vi.fn();
  const end = vi.fn();
  const active = { span, end } as unknown as ActiveTrace;
  const startTrace = vi.fn(() => active);
  return {
    startTrace, span, end,
    flush: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
  };
}

function makeBridge(): StdioBridge {
  return {
    call: vi.fn(async () => ({ content: "ok" })),
    shutdown: vi.fn(async () => {}),
  } as unknown as StdioBridge;
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

describe("MCP proxy identity headers (X-Agent-Session-Id, X-Agent-Type)", () => {
  let server: Server;
  let url: string;
  let tracer: SpyTracer;

  beforeEach(async () => {
    tracer = makeSpyTracer();
    const started = await startServer(makeConfig({
      bridge: makeBridge(),
      serverRoutes: { Read: "fs" },
      tracer,
    }));
    server = started.server;
    url = started.url;
    mockLogger.warn.mockClear();
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it("pipes X-Agent-Session-Id to startTrace as sessionId", async () => {
    await mcpCall(url, 1, "Read", { path: "./pkg.json" }, { "X-Agent-Session-Id": "review-001" });
    expect(tracer.startTrace).toHaveBeenCalledTimes(1);
    expect(tracer.startTrace.mock.calls[0]![0].sessionId).toBe("review-001");
  });

  it("pipes X-Agent-Type to startTrace as userId AND tags it as agentType:<value>", async () => {
    await mcpCall(url, 2, "Read", { path: "./pkg.json" }, { "X-Agent-Type": "reviewer" });
    expect(tracer.startTrace).toHaveBeenCalledTimes(1);
    const arg = tracer.startTrace.mock.calls[0]![0];
    expect(arg.userId).toBe("reviewer");
    expect(arg.tags).toEqual(expect.arrayContaining(["agentType:reviewer"]));
  });

  it("includes both identity values in startTrace input for trace UI visibility", async () => {
    await mcpCall(url, 3, "Read", {}, {
      "X-Agent-Session-Id": "sess-3",
      "X-Agent-Type": "coder",
    });
    const arg = tracer.startTrace.mock.calls[0]![0];
    expect(arg.input).toEqual(expect.objectContaining({
      sessionId: "sess-3",
      agentType: "coder",
    }));
    // The whitelist guarantee from sanitizer threat model still holds — raw
    // arguments must NEVER appear in the trace input. Regression backstop.
    expect(arg.input).not.toHaveProperty("arguments");
  });

  it("preserves today's behaviour when no identity headers are sent", async () => {
    await mcpCall(url, 4, "Read", { path: "./pkg.json" });
    const arg = tracer.startTrace.mock.calls[0]![0];
    expect(arg.sessionId).toBeUndefined();
    expect(arg.userId).toBeUndefined();
    expect(arg.tags).toBeUndefined();
    // Headerless input shape unchanged from Phase 1: no sessionId/agentType keys.
    expect(arg.input).toEqual({
      tool: "Read",
      requestId: 4,
      method: "tools/call",
      correlationId: expect.any(String),
    });
  });

  it("warn-logs and ignores X-Agent-Session-Id longer than 128 chars", async () => {
    const tooLong = "a".repeat(129);
    await mcpCall(url, 5, "Read", {}, { "X-Agent-Session-Id": tooLong });
    expect(tracer.startTrace.mock.calls[0]![0].sessionId).toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ header: "X-Agent-Session-Id" }),
      expect.stringMatching(/identity header/i)
    );
  });

  it("warn-logs and ignores X-Agent-Session-Id with disallowed characters", async () => {
    await mcpCall(url, 6, "Read", {}, { "X-Agent-Session-Id": "bad value with spaces!" });
    expect(tracer.startTrace.mock.calls[0]![0].sessionId).toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ header: "X-Agent-Session-Id" }),
      expect.stringMatching(/identity header/i)
    );
  });

  it("warn-logs and ignores X-Agent-Type longer than 32 chars (no agentType tag emitted)", async () => {
    const tooLong = "a".repeat(33);
    await mcpCall(url, 7, "Read", {}, { "X-Agent-Type": tooLong });
    const arg = tracer.startTrace.mock.calls[0]![0];
    expect(arg.userId).toBeUndefined();
    // Reviewer fix #6: assert the absence directly. The previous `if (arg.tags)`
    // guard short-circuited the assertion to a no-op because tags is always
    // undefined when agentType is rejected.
    expect(arg.tags).toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ header: "X-Agent-Type" }),
      expect.stringMatching(/identity header/i)
    );
  });

  it("warn-logs and ignores X-Agent-Type with disallowed characters", async () => {
    await mcpCall(url, 8, "Read", {}, { "X-Agent-Type": "bad type!" });
    const arg = tracer.startTrace.mock.calls[0]![0];
    expect(arg.userId).toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ header: "X-Agent-Type" }),
      expect.stringMatching(/identity header/i)
    );
  });

  it("malformed identity headers do NOT 400 — request still processes (anchor #5)", async () => {
    const res = await mcpCall(url, 9, "Read", { path: "./pkg.json" }, {
      "X-Agent-Session-Id": "a".repeat(200),
      "X-Agent-Type": "x!?",
    });
    expect(res.status).toBe(200);
    expect(tracer.startTrace).toHaveBeenCalledTimes(1);
  });

  it("accepts boundary-length identity values (128 / 32 chars)", async () => {
    const sessionAtLimit = "a".repeat(128);
    const typeAtLimit = "a".repeat(32);
    await mcpCall(url, 10, "Read", {}, {
      "X-Agent-Session-Id": sessionAtLimit,
      "X-Agent-Type": typeAtLimit,
    });
    const arg = tracer.startTrace.mock.calls[0]![0];
    expect(arg.sessionId).toBe(sessionAtLimit);
    expect(arg.userId).toBe(typeAtLimit);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("warn-logs and ignores duplicated identity headers (joined value fails charset)", async () => {
    // Reviewer fix #5: lock in the duplicate-header behaviour. When a reverse
    // proxy or buggy client sends the same header twice, Node delivers a
    // single comma-joined string to `req.header()`. The comma fails our
    // charset regex, so the value degrades to undefined and the request
    // still processes. This is "accidentally correct" today; the test makes
    // the behaviour intentional.
    const headers = new Headers({ "Content-Type": "application/json" });
    headers.append("X-Agent-Session-Id", "first-value");
    headers.append("X-Agent-Session-Id", "second-value");
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: { name: "Read", arguments: {} },
      }),
    });
    expect(res.status).toBe(200);
    expect(tracer.startTrace).toHaveBeenCalledTimes(1);
    expect(tracer.startTrace.mock.calls[0]![0].sessionId).toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ header: "X-Agent-Session-Id" }),
      expect.stringMatching(/identity header/i)
    );
  });

  it("warn log includes a bounded value sample for operator diagnostics", async () => {
    // Reviewer fix #4: warn log carries a truncated value sample so operators
    // can identify which dispatch CLI / connector is misconfigured without
    // having to reproduce the request. Truncated to IDENTITY_LOG_SAMPLE_LEN
    // (32) so a megabyte-long header doesn't blow up the log line size.
    const tooLong = "a".repeat(200);
    await mcpCall(url, 12, "Read", {}, { "X-Agent-Session-Id": tooLong });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        header: "X-Agent-Session-Id",
        valueSample: expect.stringMatching(/^a{32}…$/),
      }),
      expect.stringMatching(/identity header/i)
    );
  });
});
