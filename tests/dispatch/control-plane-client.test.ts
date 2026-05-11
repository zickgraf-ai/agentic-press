import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";

/**
 * Tier 1.4 — control-plane HTTP client tests.
 *
 * The client is invoked by the dispatch CLI to register and deregister sessions
 * on the host-side control plane. Security-critical invariants locked here:
 *   - Bearer token NEVER appears in any error message, thrown payload, or
 *     captured log line (threat row 3).
 *   - 401 surfaces a typed ControlPlaneAuthError so the CLI can exit 66.
 *   - 400 preserves the server's validation message so the operator sees it.
 *   - 5xx retried with bounded budget; exhausting retries throws a typed error.
 *   - ECONNREFUSED throws a typed ControlPlaneConnectError with operator hint.
 *   - Deregister tolerates ECONNREFUSED (proxy may already be tearing down).
 */

const { mockLogger } = vi.hoisted(() => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  mockLogger.child.mockReturnValue(mockLogger);
  return { mockLogger };
});
vi.mock("../../src/logger.js", () => ({
  default: mockLogger,
  childLogger: vi.fn(() => mockLogger),
}));

import { createSessionRegistry } from "../../src/orchestrator/session-registry.js";
import { createControlPlaneServer } from "../../src/orchestrator/control-plane.js";
import {
  createControlPlaneClient,
  ControlPlaneAuthError,
  ControlPlaneValidationError,
  ControlPlaneServerError,
  ControlPlaneConnectError,
} from "../../src/dispatch/control-plane-client.js";

const TOKEN = "a".repeat(64);
const FAST_DELAYS = [1, 1] as const;

async function startRealControlPlane(): Promise<{ server: Server; baseUrl: string }> {
  const registry = createSessionRegistry();
  const app = createControlPlaneServer({ registry, token: TOKEN });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function startFlakyServer(plan: Array<"5xx" | "ok-register" | "ok-deregister">): Promise<{
  server: Server;
  baseUrl: string;
  callCount: () => number;
}> {
  let callIdx = 0;
  const app = express();
  app.use(express.json());
  app.post("/sessions", (_req, res) => {
    const step = plan[callIdx++] ?? plan[plan.length - 1];
    if (step === "5xx") return res.status(503).json({ error: "down" });
    return res.status(201).json({ sessionId: "ok" });
  });
  app.delete("/sessions/:id", (_req, res) => {
    const step = plan[callIdx++] ?? plan[plan.length - 1];
    if (step === "5xx") return res.status(503).json({ error: "down" });
    return res.status(204).send();
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return { server, baseUrl: `http://127.0.0.1:${port}`, callCount: () => callIdx };
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server || !server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("createControlPlaneClient", () => {
  let server: Server | undefined;
  let baseUrl: string;

  beforeEach(() => {
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();
  });

  afterEach(async () => {
    await closeServer(server);
    server = undefined;
  });

  it("register: happy path returns void on 201", async () => {
    ({ server, baseUrl } = await startRealControlPlane());
    const client = createControlPlaneClient({ token: TOKEN, baseUrl });
    await expect(
      client.register({
        sessionId: "abc123",
        agentType: "reviewer",
        allowedTools: ["echo__read_file"],
      })
    ).resolves.toBeUndefined();
  });

  it("register: wrong token throws ControlPlaneAuthError", async () => {
    ({ server, baseUrl } = await startRealControlPlane());
    const client = createControlPlaneClient({ token: "b".repeat(64), baseUrl });
    await expect(
      client.register({ sessionId: "abc", agentType: "x", allowedTools: ["echo__read_file"] })
    ).rejects.toBeInstanceOf(ControlPlaneAuthError);
  });

  it("register: 400 throws ControlPlaneValidationError preserving server message", async () => {
    ({ server, baseUrl } = await startRealControlPlane());
    const client = createControlPlaneClient({ token: TOKEN, baseUrl });
    // bare "*" is rejected by validateSessionInput → 400
    let caught: unknown;
    try {
      await client.register({
        sessionId: "abc",
        agentType: "reviewer",
        allowedTools: ["*"],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ControlPlaneValidationError);
    expect((caught as Error).message).toMatch(/catch-all/);
  });

  it("register: 5xx retried until success", async () => {
    const flaky = await startFlakyServer(["5xx", "5xx", "ok-register"]);
    server = flaky.server;
    const client = createControlPlaneClient({
      token: TOKEN,
      baseUrl: flaky.baseUrl,
      retryDelaysMs: [...FAST_DELAYS],
    });
    await expect(
      client.register({ sessionId: "abc", agentType: "x", allowedTools: ["echo__read_file"] })
    ).resolves.toBeUndefined();
    expect(flaky.callCount()).toBe(3);
  });

  it("register: 5xx exhausting retries throws ControlPlaneServerError", async () => {
    const flaky = await startFlakyServer(["5xx", "5xx", "5xx"]);
    server = flaky.server;
    const client = createControlPlaneClient({
      token: TOKEN,
      baseUrl: flaky.baseUrl,
      retryDelaysMs: [...FAST_DELAYS],
    });
    await expect(
      client.register({ sessionId: "abc", agentType: "x", allowedTools: ["echo__read_file"] })
    ).rejects.toBeInstanceOf(ControlPlaneServerError);
    expect(flaky.callCount()).toBe(3);
  });

  it("register: connection refused throws ControlPlaneConnectError with hint", async () => {
    // Bind an ephemeral port, capture it, then close the server — gives us
    // a known port that nothing is listening on (real ECONNREFUSED, not
    // undici's "bad port" guard which trips on low-numbered reserved ports).
    const tmp = await startRealControlPlane();
    const closedPort = (tmp.server.address() as AddressInfo).port;
    await closeServer(tmp.server);
    const client = createControlPlaneClient({
      token: TOKEN,
      baseUrl: `http://127.0.0.1:${closedPort}`,
      retryDelaysMs: [],
    });
    let caught: unknown;
    try {
      await client.register({ sessionId: "abc", agentType: "x", allowedTools: ["echo__read_file"] });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ControlPlaneConnectError);
    expect((caught as Error).message).toMatch(/control plane|proxy/i);
  });

  it("deregister: happy path returns void on 204", async () => {
    ({ server, baseUrl } = await startRealControlPlane());
    const client = createControlPlaneClient({ token: TOKEN, baseUrl });
    await client.register({ sessionId: "abc", agentType: "x", allowedTools: ["echo__read_file"] });
    await expect(client.deregister("abc")).resolves.toBeUndefined();
  });

  it("token NEVER appears in any error message or captured log line", async () => {
    ({ server, baseUrl } = await startRealControlPlane());
    const sneaky = TOKEN; // wrong token of same length to trigger 401
    const wrong = "z".repeat(64);
    const client = createControlPlaneClient({ token: wrong, baseUrl });
    let caught: unknown;
    try {
      await client.register({ sessionId: "abc", agentType: "x", allowedTools: ["echo__read_file"] });
    } catch (err) {
      caught = err;
    }
    const messageBlob = JSON.stringify(caught);
    expect(messageBlob).not.toContain(wrong);
    expect(messageBlob).not.toContain(sneaky);
    const allLogCalls = [
      ...mockLogger.info.mock.calls,
      ...mockLogger.warn.mock.calls,
      ...mockLogger.error.mock.calls,
      ...mockLogger.debug.mock.calls,
    ];
    const logBlob = JSON.stringify(allLogCalls);
    expect(logBlob).not.toContain(wrong);
    expect(logBlob).not.toContain(sneaky);
  });
});
