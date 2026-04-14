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
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVIL_SERVER_PATH = resolve(__dirname, "../scripts/evil-mcp-server.js");
const ECHO_SERVER_PATH = resolve(__dirname, "../scripts/echo-mcp-server.js");

const evilServerDef: McpServerDef = {
  name: "evil",
  command: "node",
  args: [EVIL_SERVER_PATH],
};
const echoServerDef: McpServerDef = {
  name: "echo",
  command: "node",
  args: [ECHO_SERVER_PATH],
};

function makeConfig(bridge: StdioBridge): ProxyServerConfig {
  return {
    port: 0,
    allowedTools: ["evil__read_file", "echo__read_file"],
    logLevel: "error",
    bridge,
    serverRoutes: { "evil__*": "evil", "echo__*": "echo" },
  };
}

describe("MCP proxy response sanitization", () => {
  let server: Server;
  let bridge: StdioBridge;
  let port: number;

  async function mcpCall(id: number, toolName: string, args: Record<string, unknown> = {}) {
    return fetch(`http://127.0.0.1:${port}/mcp`, {
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

  beforeAll(async () => {
    bridge = createStdioBridge([evilServerDef, echoServerDef]);
    const app = createProxyServer(makeConfig(bridge));
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
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
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toContain("blocked by response sanitizer");
    // correlationId is 16-hex-char (8 random bytes) — lock the shape.
    expect(body.error.message).toMatch(/ref: [0-9a-f]{16}/);
    // Never echo raw matched content or pattern names back to the agent.
    expect(body.error.message).not.toContain("ignore previous instructions");
    expect(body.error.message).not.toContain("ignore_instructions");
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
    // errorMessage gives operators a searchable summary without joining
    // against the flags array.
    expect(responseEntry?.errorMessage).toBeDefined();
    expect(typeof responseEntry?.errorMessage).toBe("string");
    expect(responseEntry?.errorMessage as string).toContain("response sanitizer");
  });

  it("passes clean upstream responses through and audits as allowed/response", async () => {
    auditEntries.length = 0;
    const res = await mcpCall(3, "echo__read_file", { path: "./safe.ts" });
    const body = await res.json();
    expect(body.result).toBeDefined();
    expect(body.error).toBeUndefined();
    const responseEntry = auditEntries.find(
      (e) =>
        typeof e === "object" && e !== null &&
        (e as Record<string, unknown>).direction === "response"
    ) as Record<string, unknown> | undefined;
    expect(responseEntry).toBeDefined();
    expect(responseEntry?.status).toBe("allowed");
  });
});
