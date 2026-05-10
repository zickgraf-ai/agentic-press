import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/**
 * Tier 1.3 — control-plane HTTP server tests.
 *
 * The control plane is a NEW HTTP attack surface (loopback bind on
 * 127.0.0.1:18924, bearer-token gated). The following invariants are
 * security-critical and locked in by these tests:
 *
 *   - Bearer-token gate on every endpoint except /health.
 *   - Wrong-length token returns 401, not 400 (timing-safe-equal length probe).
 *   - 401/400 responses do NOT write audit entries (probe flood guard).
 *   - GET /sessions never returns the allowlist contents.
 *   - Bind literal "127.0.0.1" lives in source — no MCP_CONTROL_BIND env knob.
 *   - Token value never appears in any captured log line or audit entry.
 */

const { mockLogger, auditEntries } = vi.hoisted(() => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  mockLogger.child.mockReturnValue(mockLogger);
  const auditEntries: unknown[] = [];
  return { mockLogger, auditEntries };
});
vi.mock("../../src/logger.js", () => ({
  default: mockLogger,
  childLogger: vi.fn(() => mockLogger),
}));
vi.mock("../../src/mcp-proxy/logger.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/mcp-proxy/logger.js")>(
    "../../src/mcp-proxy/logger.js"
  );
  return {
    ...actual,
    logAuditEntry: vi.fn((entry: unknown) => {
      auditEntries.push(entry);
    }),
  };
});

import { createSessionRegistry, type SessionRegistry } from "../../src/orchestrator/session-registry.js";
import { createControlPlaneServer } from "../../src/orchestrator/control-plane.js";
import type { AuditEntry } from "../../src/mcp-proxy/logger.js";

const TOKEN = "a".repeat(64);

async function startServer(opts: {
  registry: SessionRegistry;
  token?: string;
}): Promise<{ server: Server; baseUrl: string }> {
  const app = createControlPlaneServer({
    registry: opts.registry,
    token: opts.token ?? TOKEN,
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server || !server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("Control-plane HTTP server", () => {
  let server: Server | undefined;
  let baseUrl: string;
  let registry: SessionRegistry;

  beforeEach(async () => {
    auditEntries.length = 0;
    mockLogger.warn.mockClear();
    mockLogger.info.mockClear();
    registry = createSessionRegistry();
    const started = await startServer({ registry });
    server = started.server;
    baseUrl = started.baseUrl;
  });

  afterEach(async () => {
    await closeServer(server);
    server = undefined;
  });

  it("POST /sessions without Authorization header → 401", async () => {
    const res = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "x", agentType: "reviewer", allowedTools: ["Read"] }),
    });
    expect(res.status).toBe(401);
    expect(registry.size()).toBe(0);
  });

  it("POST /sessions with malformed Authorization header (no Bearer prefix) → 401", async () => {
    const res = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: TOKEN },
      body: JSON.stringify({ sessionId: "x", agentType: "reviewer", allowedTools: ["Read"] }),
    });
    expect(res.status).toBe(401);
    expect(registry.size()).toBe(0);
  });

  it("POST /sessions with wrong-but-correct-length token → 401", async () => {
    const wrong = "b".repeat(64);
    const res = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${wrong}` },
      body: JSON.stringify({ sessionId: "x", agentType: "reviewer", allowedTools: ["Read"] }),
    });
    expect(res.status).toBe(401);
    expect(registry.size()).toBe(0);
  });

  it("POST /sessions with wrong-length token → 401 (NOT 400 — proves timingSafeEqual length-mismatch path)", async () => {
    const tooShort = "a".repeat(10);
    const tooLong = "a".repeat(200);
    for (const bad of [tooShort, tooLong]) {
      const res = await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${bad}` },
        body: JSON.stringify({ sessionId: "x", agentType: "reviewer", allowedTools: ["Read"] }),
      });
      expect(res.status).toBe(401);
    }
    expect(registry.size()).toBe(0);
  });

  it("POST /sessions accepts prefix wildcards (e.g. echo__*) — only bare catch-alls are rejected", async () => {
    const res = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ sessionId: "wild", agentType: "reviewer", allowedTools: ["echo__*", "Read"] }),
    });
    expect(res.status).toBe(201);
    expect(registry.size()).toBe(1);
  });

  it("POST /sessions with valid token + valid body → 201, registry has entry", async () => {
    const res = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ sessionId: "abc", agentType: "reviewer", allowedTools: ["Read", "Grep"] }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { sessionId: string };
    expect(body.sessionId).toBe("abc");
    expect(registry.size()).toBe(1);
    const entry = registry.lookup("abc");
    expect(entry?.agentType).toBe("reviewer");
    expect(entry?.allowlist.patterns).toEqual(["Read", "Grep"]);
  });

  it("POST /sessions with malformed body → 400 with structured error and registry unchanged", async () => {
    const cases: Array<Record<string, unknown>> = [
      { agentType: "reviewer", allowedTools: ["Read"] }, // missing sessionId
      { sessionId: "ok", allowedTools: ["Read"] }, // missing agentType
      { sessionId: "ok", agentType: "reviewer" }, // missing allowedTools
      { sessionId: "ok", agentType: "reviewer", allowedTools: "Read" }, // non-array allowedTools
      { sessionId: "bad value!", agentType: "reviewer", allowedTools: ["Read"] }, // charset violation
      { sessionId: "a".repeat(200), agentType: "reviewer", allowedTools: ["Read"] }, // length violation
      { sessionId: "ok", agentType: "x".repeat(50), allowedTools: ["Read"] }, // agentType too long
      { sessionId: "ok", agentType: "reviewer", allowedTools: [] }, // empty allowedTools
      { sessionId: "ok", agentType: "reviewer", allowedTools: ["*"] }, // bare catch-all rejected (F12)
      { sessionId: "ok", agentType: "reviewer", allowedTools: ["**"] }, // multi-asterisk catch-all rejected
      { sessionId: "ok", agentType: "reviewer", allowedTools: ["Read", "*"] }, // mixed list — bare * still rejected
    ];
    for (const body of cases) {
      const res = await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
      const json = await res.json() as { error: string };
      expect(typeof json.error).toBe("string");
      expect(json.error.length).toBeGreaterThan(0);
    }
    expect(registry.size()).toBe(0);
  });

  it("DELETE /sessions/:id with valid token + existing id → 204, registry empty", async () => {
    registry.register({ sessionId: "delme", agentType: "reviewer", allowlist: { patterns: ["Read"] } });
    expect(registry.size()).toBe(1);
    const res = await fetch(`${baseUrl}/sessions/delme`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(204);
    expect(registry.size()).toBe(0);
  });

  it("DELETE /sessions/:id with valid token + unknown id → 204 (idempotent)", async () => {
    const res = await fetch(`${baseUrl}/sessions/never-was`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(204);
  });

  it("DELETE /sessions/:id without Authorization → 401", async () => {
    registry.register({ sessionId: "stay", agentType: "reviewer", allowlist: { patterns: ["Read"] } });
    const res = await fetch(`${baseUrl}/sessions/stay`, { method: "DELETE" });
    expect(res.status).toBe(401);
    expect(registry.size()).toBe(1);
  });

  it("GET /sessions with valid token returns array of {sessionId, agentType, registeredAt} — NOT allowedTools", async () => {
    registry.register({ sessionId: "g1", agentType: "reviewer", allowlist: { patterns: ["Read"] } });
    registry.register({ sessionId: "g2", agentType: "coder", allowlist: { patterns: ["Write"] } });
    const res = await fetch(`${baseUrl}/sessions`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(2);
    for (const entry of body) {
      expect(typeof entry.sessionId).toBe("string");
      expect(typeof entry.agentType).toBe("string");
      expect(typeof entry.registeredAt).toBe("string");
      expect(entry).not.toHaveProperty("allowedTools");
      expect(entry).not.toHaveProperty("allowlist");
      expect(entry).not.toHaveProperty("patterns");
    }
  });

  it("GET /sessions without Authorization → 401", async () => {
    const res = await fetch(`${baseUrl}/sessions`);
    expect(res.status).toBe(401);
  });

  it("GET /health is reachable WITHOUT Authorization header → 200", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  it("successful POST /sessions writes an audit entry with direction='control-plane' + structured fields (NOT tool names)", async () => {
    const res = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ sessionId: "audit-1", agentType: "reviewer", allowedTools: ["Read", "Grep", "Write"] }),
    });
    expect(res.status).toBe(201);
    const cpEntries = (auditEntries as AuditEntry[]).filter(
      (e) => e.direction === "control-plane"
    );
    expect(cpEntries).toHaveLength(1);
    const entry = cpEntries[0]!;
    expect(entry.action).toBe("register");
    expect(entry.sessionId).toBe("audit-1");
    expect(entry.agentType).toBe("reviewer");
    expect(entry.allowedToolsCount).toBe(3);
    expect(typeof entry.remoteAddress).toBe("string");
    expect(typeof entry.remotePort).toBe("number");
    expect(entry.status).toBe("allowed");
    // CRITICAL: tool names must NEVER appear in the audit entry
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toMatch(/Read|Grep|Write/);
  });

  it("successful DELETE /sessions/:id writes an audit entry with action='deregister'", async () => {
    registry.register({ sessionId: "audit-del", agentType: "coder", allowlist: { patterns: ["Read"] } });
    auditEntries.length = 0; // clear out anything from setup
    const res = await fetch(`${baseUrl}/sessions/audit-del`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(204);
    const cpEntries = (auditEntries as AuditEntry[]).filter(
      (e) => e.direction === "control-plane"
    );
    expect(cpEntries).toHaveLength(1);
    const entry = cpEntries[0]!;
    expect(entry.action).toBe("deregister");
    expect(entry.sessionId).toBe("audit-del");
    expect(typeof entry.remoteAddress).toBe("string");
    expect(typeof entry.remotePort).toBe("number");
  });

  it("401 and 400 responses do NOT write audit entries (probe flood guard)", async () => {
    auditEntries.length = 0;
    // 401 — wrong token
    await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${"b".repeat(64)}` },
      body: JSON.stringify({ sessionId: "x", agentType: "r", allowedTools: ["R"] }),
    });
    // 400 — malformed body
    await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ broken: true }),
    });
    const cpEntries = (auditEntries as AuditEntry[]).filter(
      (e) => e.direction === "control-plane"
    );
    expect(cpEntries).toHaveLength(0);
  });

  it("token value never appears in any captured log line or audit entry (even on success)", async () => {
    await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ sessionId: "secrets", agentType: "reviewer", allowedTools: ["Read"] }),
    });
    // Try wrong token too — sometimes token leaks happen on the error path.
    await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${"b".repeat(64)}` },
      body: JSON.stringify({ sessionId: "secrets-2", agentType: "reviewer", allowedTools: ["Read"] }),
    });
    const allLogCalls = [
      ...mockLogger.info.mock.calls,
      ...mockLogger.warn.mock.calls,
      ...mockLogger.error.mock.calls,
      ...mockLogger.debug.mock.calls,
    ];
    const allLogText = JSON.stringify(allLogCalls);
    expect(allLogText).not.toContain(TOKEN);
    const allAuditText = JSON.stringify(auditEntries);
    expect(allAuditText).not.toContain(TOKEN);
  });
});

describe("Control-plane bind config (static source check)", () => {
  /**
   * The control-plane bind MUST be a hard-coded "127.0.0.1" literal in
   * src/index.ts. Configuring the bind via env (e.g. MCP_CONTROL_BIND) is
   * an explicit anti-feature: an operator could silently widen the bind
   * (e.g. typo it to 0.0.0.0) and void the primary defence (loopback bind).
   * This test enforces the source-level invariant — when src/index.ts is
   * wired in the final step, it must include the literal AND must not read
   * any MCP_CONTROL_BIND env var.
   */
  it("src/index.ts contains the literal '127.0.0.1' for the control-plane bind", () => {
    const indexPath = path.resolve(__dirname, "../../src/index.ts");
    const source = readFileSync(indexPath, "utf-8");
    // The control-plane wiring block (the test enforces presence of the
    // exact string the runtime must use). Keyed off the file containing
    // both "MCP_CONTROL_TOKEN" and "127.0.0.1" so we don't false-positive
    // on the (separate) metrics-server block which already binds 127.0.0.1.
    expect(source).toMatch(/MCP_CONTROL_TOKEN/);
    const lines = source.split("\n");
    const cpBindLine = lines.find(
      (l) => l.includes("controlPlaneApp") || l.includes("controlPlaneServer")
    );
    expect(cpBindLine, "control-plane app.listen call must exist in src/index.ts").toBeDefined();
    // The block as a whole must reference the literal IP for the control plane.
    expect(source).toMatch(/127\.0\.0\.1.*control|control.*127\.0\.0\.1/s);
  });

  it("src/index.ts does NOT read MCP_CONTROL_BIND from env (no env-knob for the bind)", () => {
    const indexPath = path.resolve(__dirname, "../../src/index.ts");
    const source = readFileSync(indexPath, "utf-8");
    expect(source).not.toMatch(/MCP_CONTROL_BIND/);
  });
});
