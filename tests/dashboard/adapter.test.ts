import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockLogger } = vi.hoisted(() => {
  const mockLogger = {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn(),
  };
  mockLogger.child.mockReturnValue(mockLogger);
  return { mockLogger };
});
vi.mock("../../src/logger.js", () => ({
  default: mockLogger, childLogger: vi.fn(() => mockLogger),
}));

import {
  createNoopAdapter,
  createMissionControlAdapter,
  type DashboardAdapter,
  type DashboardSession,
} from "../../src/dashboard/adapter.js";
import type { SandboxId, SessionId } from "../../src/types.js";

describe("createNoopAdapter", () => {
  let adapter: DashboardAdapter;

  beforeEach(() => {
    adapter = createNoopAdapter();
  });

  it("registerSession resolves with a stub DashboardSession", async () => {
    const session = await adapter.registerSession("test-sbx" as SandboxId);
    expect(session).toBeDefined();
    expect(session.sandboxName).toBe("test-sbx");
    expect(session.status).toBe("active");
    expect(typeof session.id).toBe("string");
    expect(typeof session.startedAt).toBe("string");
  });

  it("updateSessionStatus resolves without throwing", async () => {
    await expect(
      adapter.updateSessionStatus("sess-1" as SessionId, "completed")
    ).resolves.toBeUndefined();
  });

  it("pushActivity resolves without throwing", async () => {
    await expect(
      adapter.pushActivity({
        type: "tool_call",
        tool: "Read",
        timestamp: new Date().toISOString(),
        status: "allowed",
      })
    ).resolves.toBeUndefined();
  });

  it("shutdown resolves without throwing", async () => {
    await expect(adapter.shutdown()).resolves.toBeUndefined();
  });
});

describe("createMissionControlAdapter", () => {
  let adapter: DashboardAdapter;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockLogger.warn.mockClear();
    fetchSpy = vi.fn();
    adapter = createMissionControlAdapter(
      { url: "http://mc.local:3000", apiKey: "test-key" },
      fetchSpy as typeof fetch
    );
  });

  it("registerSession calls POST /api/agents/register with correct body and auth header", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "agent-42", name: "ap-test" }),
    });

    const session = await adapter.registerSession(
      "ap-test" as SandboxId,
      "Testing dashboard"
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("http://mc.local:3000/api/agents/register");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Authorization"]).toBe("Bearer test-key");
    expect(opts.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(opts.body);
    expect(body.name).toBe("ap-test");
    expect(body.role).toBe("agent");

    expect(session).toBeDefined();
    expect(session.sandboxName).toBe("ap-test");
    expect(session.status).toBe("active");
  });

  it("registerSession works without apiKey (no Authorization header)", async () => {
    const noKeyAdapter = createMissionControlAdapter(
      { url: "http://mc.local:3000" },
      fetchSpy as typeof fetch
    );
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "agent-99" }),
    });

    await noKeyAdapter.registerSession("ap-nokey" as SandboxId);

    const [, opts] = fetchSpy.mock.calls[0]!;
    expect(opts.headers["Authorization"]).toBeUndefined();
  });

  it("updateSessionStatus calls PUT /api/agents/{id} with correct body", async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true });

    await adapter.updateSessionStatus("agent-42" as SessionId, "completed");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("http://mc.local:3000/api/agents/agent-42");
    expect(opts.method).toBe("PUT");
    const body = JSON.parse(opts.body);
    expect(body.status).toBe("completed");
  });

  it("pushActivity calls POST /api/hermes/events with correct payload", async () => {
    fetchSpy.mockResolvedValueOnce({ ok: true });

    await adapter.pushActivity({
      type: "tool_call",
      tool: "Read",
      timestamp: "2026-04-25T00:00:00.000Z",
      status: "allowed",
      durationMs: 42,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("http://mc.local:3000/api/hermes/events");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body);
    expect(body.event).toBe("tool:tool_call");
    expect(body.agent_name).toBe("agentic-press-proxy");
    expect(body.source).toBe("mcp-proxy");
    expect(body.data.tool).toBe("Read");
    expect(body.data.status).toBe("allowed");
    expect(body.data.durationMs).toBe(42);
  });

  it("swallows fetch errors and logs warning on registerSession", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("connection refused"));

    const session = await adapter.registerSession("ap-fail" as SandboxId);

    // Should not throw, should return a fallback session
    expect(session).toBeDefined();
    expect(session.status).toBe("active");
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("swallows fetch errors and logs warning on pushActivity", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("timeout"));

    await expect(
      adapter.pushActivity({
        type: "tool_call",
        tool: "Read",
        timestamp: new Date().toISOString(),
        status: "allowed",
      })
    ).resolves.toBeUndefined();

    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("swallows non-ok responses and logs warning", async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500, statusText: "Internal Server Error" });

    await expect(
      adapter.pushActivity({
        type: "blocked",
        tool: "Execute",
        timestamp: new Date().toISOString(),
        status: "blocked",
      })
    ).resolves.toBeUndefined();

    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("shutdown resolves without throwing", async () => {
    await expect(adapter.shutdown()).resolves.toBeUndefined();
  });
});
