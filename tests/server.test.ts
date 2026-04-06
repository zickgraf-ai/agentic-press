import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createProxyServer, type ProxyServerConfig } from "../src/mcp-proxy/server.js";
import type { Server } from "node:http";

const TEST_PORT = 19999;

function makeConfig(overrides: Partial<ProxyServerConfig> = {}): ProxyServerConfig {
  return {
    port: TEST_PORT,
    allowedTools: ["Read", "Grep", "Glob"],
    logLevel: "error",
    ...overrides,
  };
}

describe("MCP proxy server", () => {
  let server: Server;

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // ── Server creation ────────────────────────────────────────────────

  describe("createProxyServer", () => {
    it("returns an Express app", () => {
      const app = createProxyServer(makeConfig());
      expect(app).toBeDefined();
      expect(typeof app.listen).toBe("function");
    });
  });

  // ── Health endpoint ────────────────────────────────────────────────

  describe("GET /health", () => {
    beforeAll(async () => {
      const app = createProxyServer(makeConfig());
      server = app.listen(TEST_PORT);
      await new Promise((r) => setTimeout(r, 100));
    });

    it("returns 200 with status ok", async () => {
      const res = await fetch(`http://127.0.0.1:${TEST_PORT}/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ok");
    });
  });

  // ── MCP endpoint ──────────────────────────────────────────────────

  describe("POST /mcp", () => {
    it("rejects non-JSON-RPC requests", async () => {
      const res = await fetch(`http://127.0.0.1:${TEST_PORT}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ not: "jsonrpc" }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects non-POST methods", async () => {
      const res = await fetch(`http://127.0.0.1:${TEST_PORT}/mcp`);
      expect(res.status).toBe(404);
    });

    it("blocks non-allowlisted tool calls", async () => {
      const res = await fetch(`http://127.0.0.1:${TEST_PORT}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "Execute", arguments: {} },
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32600);
      expect(body.error.message).toContain("not in the allowlist");
    });

    it("accepts allowlisted tool calls with valid JSON-RPC", async () => {
      const res = await fetch(`http://127.0.0.1:${TEST_PORT}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "Read", arguments: { path: "./package.json" } },
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      // Without a backend MCP server, this should return an error about no server,
      // but NOT an allowlist error
      if (body.error) {
        expect(body.error.message).not.toContain("allowlist");
      }
    });

    it("returns proper JSON-RPC error structure", async () => {
      const res = await fetch(`http://127.0.0.1:${TEST_PORT}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 42,
          method: "tools/call",
          params: { name: "Delete", arguments: {} },
        }),
      });
      const body = await res.json();
      expect(body.jsonrpc).toBe("2.0");
      expect(body.id).toBe(42);
      expect(body.error).toBeDefined();
      expect(typeof body.error.code).toBe("number");
      expect(typeof body.error.message).toBe("string");
    });
  });

  // ── Path guard integration ─────────────────────────────────────────

  describe("path guard integration", () => {
    it("blocks path traversal in tool arguments", async () => {
      const res = await fetch(`http://127.0.0.1:${TEST_PORT}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "Read", arguments: { path: "../../etc/passwd" } },
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.message).toContain("path");
    });
  });
});
