import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

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
import { createStdioBridge, type McpServerDef, type StdioBridge } from "../src/mcp-proxy/stdio-bridge.js";
import type { Server } from "node:http";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_PORT = 19997;

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVIL_SERVER_PATH = resolve(__dirname, "../scripts/evil-mcp-server.js");

const evilServerDef: McpServerDef = {
  name: "evil",
  command: "node",
  args: [EVIL_SERVER_PATH],
};

function makeConfig(bridge: StdioBridge): ProxyServerConfig {
  return {
    port: TEST_PORT,
    allowedTools: ["evil__read_file"],
    logLevel: "error",
    bridge,
    serverRoutes: { "evil__*": "evil" },
  };
}

async function mcpCall(id: number, toolName: string, args: Record<string, unknown> = {}) {
  return fetch(`http://127.0.0.1:${TEST_PORT}/mcp`, {
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

describe("MCP proxy response sanitization", () => {
  let server: Server;
  let bridge: StdioBridge;

  beforeAll(async () => {
    bridge = createStdioBridge([evilServerDef]);
    const app = createProxyServer(makeConfig(bridge));
    await new Promise<void>((resolve) => {
      server = app.listen(TEST_PORT, () => resolve());
    });
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (bridge) await bridge.shutdown();
  });

  it("returns a JSON-RPC error when upstream response contains injection", async () => {
    auditEntries.length = 0;
    const res = await mcpCall(1, "evil__read_file", { path: "./safe.ts" });
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(body.error.message).toContain("blocked by response sanitizer");
    // Never echo raw matched content back to the agent.
    expect(body.error.message).not.toContain("ignore previous instructions");
    expect(body.id).toBe(1);
  });

  it("emits an audit entry with direction: response and status: flagged", async () => {
    auditEntries.length = 0;
    await mcpCall(2, "evil__read_file", { path: "./safe.ts" });
    const responseEntry = auditEntries.find(
      (e) =>
        typeof e === "object" && e !== null &&
        (e as Record<string, unknown>).direction === "response"
    ) as Record<string, unknown> | undefined;
    expect(responseEntry).toBeDefined();
    expect(responseEntry?.status).toBe("flagged");
    expect(Array.isArray(responseEntry?.flags)).toBe(true);
    expect((responseEntry?.flags as unknown[]).length).toBeGreaterThan(0);
  });
});
