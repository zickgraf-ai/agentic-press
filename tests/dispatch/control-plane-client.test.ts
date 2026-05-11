import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";

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
  ControlPlaneError,
} from "../../src/dispatch/control-plane-client.js";
import { asSessionId } from "../../src/orchestrator/session-id.js";

const TOKEN = "a".repeat(64);
const FAST_DELAYS = [1, 1] as const;
const SAMPLE_ID = asSessionId("abc");

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

async function expectFailure(p: Promise<unknown>, kind: string): Promise<ControlPlaneError> {
  let caught: unknown;
  try {
    await p;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ControlPlaneError);
  const err = caught as ControlPlaneError;
  expect(err.failure.kind).toBe(kind);
  return err;
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
        sessionId: asSessionId("abc123"),
        agentType: "reviewer",
        allowedTools: ["echo__read_file"],
      })
    ).resolves.toBeUndefined();
  });

  it("register: wrong token throws ControlPlaneError(auth)", async () => {
    ({ server, baseUrl } = await startRealControlPlane());
    const client = createControlPlaneClient({ token: "b".repeat(64), baseUrl });
    await expectFailure(
      client.register({ sessionId: SAMPLE_ID, agentType: "x", allowedTools: ["echo__read_file"] }),
      "auth"
    );
  });

  it("register: 400 throws ControlPlaneError(validation) preserving server message", async () => {
    ({ server, baseUrl } = await startRealControlPlane());
    const client = createControlPlaneClient({ token: TOKEN, baseUrl });
    const err = await expectFailure(
      client.register({
        sessionId: SAMPLE_ID,
        agentType: "reviewer",
        // bare "*" is rejected by validateSessionInput → 400
        allowedTools: ["*"],
      }),
      "validation"
    );
    expect(err.message).toMatch(/catch-all/);
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
      client.register({ sessionId: SAMPLE_ID, agentType: "x", allowedTools: ["echo__read_file"] })
    ).resolves.toBeUndefined();
    expect(flaky.callCount()).toBe(3);
  });

  it("register: 5xx exhausting retries throws ControlPlaneError(server)", async () => {
    const flaky = await startFlakyServer(["5xx", "5xx", "5xx"]);
    server = flaky.server;
    const client = createControlPlaneClient({
      token: TOKEN,
      baseUrl: flaky.baseUrl,
      retryDelaysMs: [...FAST_DELAYS],
    });
    const err = await expectFailure(
      client.register({ sessionId: SAMPLE_ID, agentType: "x", allowedTools: ["echo__read_file"] }),
      "server"
    );
    expect((err.failure as { kind: "server"; status: number }).status).toBe(503);
    expect(flaky.callCount()).toBe(3);
  });

  it("register: connection refused throws ControlPlaneError(connect) with hint", async () => {
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
    const err = await expectFailure(
      client.register({ sessionId: SAMPLE_ID, agentType: "x", allowedTools: ["echo__read_file"] }),
      "connect"
    );
    expect(err.message).toMatch(/control plane|proxy/i);
  });

  it("register: request timeout throws ControlPlaneError(connect)", async () => {
    // Hung server — accepts the connection but never responds.
    const app = express();
    app.post("/sessions", () => {
      /* never responds */
    });
    const hung: Server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    server = hung;
    const port = (hung.address() as AddressInfo).port;
    const client = createControlPlaneClient({
      token: TOKEN,
      baseUrl: `http://127.0.0.1:${port}`,
      retryDelaysMs: [],
      requestTimeoutMs: 50,
    });
    const err = await expectFailure(
      client.register({ sessionId: SAMPLE_ID, agentType: "x", allowedTools: ["echo__read_file"] }),
      "connect"
    );
    expect(err.message).toMatch(/timed out|timeout/i);
  });

  it("deregister: happy path returns void on 204", async () => {
    ({ server, baseUrl } = await startRealControlPlane());
    const client = createControlPlaneClient({ token: TOKEN, baseUrl });
    await client.register({ sessionId: SAMPLE_ID, agentType: "x", allowedTools: ["echo__read_file"] });
    await expect(client.deregister(SAMPLE_ID)).resolves.toBeUndefined();
  });

  it("deregister: 404 returns without throwing and warn-logs", async () => {
    ({ server, baseUrl } = await startRealControlPlane());
    // 404 isn't reachable through the real control plane (DELETE is idempotent
    // and returns 204 for unknown ids), so use a stub that returns 404.
    const app = express();
    app.delete("/sessions/:id", (_req, res) => res.status(404).send());
    const stub: Server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const port = (stub.address() as AddressInfo).port;
    try {
      const client = createControlPlaneClient({
        token: TOKEN,
        baseUrl: `http://127.0.0.1:${port}`,
      });
      await expect(client.deregister(SAMPLE_ID)).resolves.toBeUndefined();
      const warnBlob = JSON.stringify(mockLogger.warn.mock.calls);
      expect(warnBlob).toMatch(/404/);
    } finally {
      await closeServer(stub);
    }
  });

  it("token NEVER appears in any error message or captured log line", async () => {
    ({ server, baseUrl } = await startRealControlPlane());
    const sneaky = TOKEN;
    const wrong = "z".repeat(64);
    const client = createControlPlaneClient({ token: wrong, baseUrl });
    let caught: unknown;
    try {
      await client.register({ sessionId: SAMPLE_ID, agentType: "x", allowedTools: ["echo__read_file"] });
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
