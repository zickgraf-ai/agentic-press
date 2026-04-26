import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const { mockLogger, auditEntries } = vi.hoisted(() => {
  const mockLogger = {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn(),
  };
  mockLogger.child.mockReturnValue(mockLogger);
  const auditEntries: unknown[] = [];
  return { mockLogger, auditEntries };
});
vi.mock("../src/logger.js", () => ({
  default: mockLogger,
  childLogger: vi.fn(() => mockLogger),
}));
vi.mock("../src/mcp-proxy/logger.js", () => ({
  logAuditEntry: vi.fn((entry: unknown) => {
    auditEntries.push(entry);
  }),
}));

import { createProxyServer, type ProxyServerConfig } from "../src/mcp-proxy/server.js";
import { ResponseSizeExceededError, type StdioBridge } from "../src/mcp-proxy/stdio-bridge.js";
import type { Tracer, ActiveTrace } from "../src/observability/langfuse.js";

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
    startTrace,
    span,
    end,
    flush: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
  };
}

/** Bridge stub whose .call() rejects with ResponseSizeExceededError. */
function makeOversizedBridge(): StdioBridge {
  return {
    call: vi.fn(
      async () =>
        Promise.reject(
          new ResponseSizeExceededError("upstream", 512, 4096)
        )
    ),
    shutdown: vi.fn(async () => {}),
  } as unknown as StdioBridge;
}

function makeConfig(overrides: Partial<ProxyServerConfig> = {}): ProxyServerConfig {
  return {
    port: 0,
    allowedTools: ["Read"],
    logLevel: "error",
    serverRoutes: { Read: "upstream" },
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

async function mcpCall(url: string, id: number, toolName: string, args: Record<string, unknown> = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });
}

describe("MCP proxy — response size cap mapping", () => {
  let server: Server;
  let url: string;
  let tracer: SpyTracer;

  beforeEach(async () => {
    auditEntries.length = 0;
    tracer = makeSpyTracer();
    const started = await startServer(
      makeConfig({ bridge: makeOversizedBridge(), tracer })
    );
    server = started.server;
    url = started.url;
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it("returns JSON-RPC error code -32001", async () => {
    const res = await mcpCall(url, 1, "Read", { path: "./safe.ts" });
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe(-32001);
    expect(body.id).toBe(1);
  });

  it("error message matches the response sanitizer's reject shape (no distinct DoS signal)", async () => {
    const res = await mcpCall(url, 2, "Read", { path: "./safe.ts" });
    const body = await res.json();
    expect(body.error.message).toMatch(
      /^Response blocked by response sanitizer \(ref: [0-9a-f]{16}\)$/
    );
    // Must NOT leak any of the size-exceeded error's internal details.
    expect(body.error.message).not.toContain("size");
    expect(body.error.message).not.toContain("limit");
    expect(body.error.message).not.toContain("upstream");
    expect(body.error.message).not.toContain("bytes");
  });

  it("emits an audit entry with direction=response, status=blocked, errorMessage='response size cap exceeded'", async () => {
    await mcpCall(url, 3, "Read", { path: "./safe.ts" });
    const responseEntry = auditEntries.find(
      (e) =>
        typeof e === "object" && e !== null &&
        (e as Record<string, unknown>).direction === "response"
    ) as Record<string, unknown> | undefined;
    expect(responseEntry).toBeDefined();
    expect(responseEntry?.status).toBe("blocked");
    expect(responseEntry?.errorMessage).toBe("response size cap exceeded");
  });

  it("records tracer span/end with status=blocked", async () => {
    await mcpCall(url, 4, "Read", { path: "./safe.ts" });
    expect(tracer.span).toHaveBeenCalled();
    const last = tracer.span.mock.calls.at(-1)!;
    expect(last[0].status).toBe("blocked");
    expect(tracer.end).toHaveBeenCalled();
    expect(tracer.end.mock.calls.at(-1)![0].outcome).toBe("blocked");
  });
});
