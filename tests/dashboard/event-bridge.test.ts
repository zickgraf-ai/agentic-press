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
  createNoopEventBridge,
  createEventBridge,
  getNoopEventBridge,
  type EventBridge,
} from "../../src/dashboard/event-bridge.js";
import type { DashboardAdapter, ActivityEvent } from "../../src/dashboard/adapter.js";
import type { AuditEntry } from "../../src/mcp-proxy/logger.js";

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    timestamp: "2026-04-25T00:00:00.000Z",
    tool: "Read",
    args: { path: "./file.ts" },
    status: "allowed",
    flags: [],
    durationMs: 10,
    ...overrides,
  };
}

function makeMockAdapter(): DashboardAdapter & {
  pushActivity: ReturnType<typeof vi.fn>;
  shutdown: ReturnType<typeof vi.fn>;
} {
  return {
    registerSession: vi.fn(async () => ({
      id: "sess-1" as any,
      sandboxName: "test" as any,
      startedAt: new Date().toISOString(),
      status: "active" as const,
    })),
    updateSessionStatus: vi.fn(async () => {}),
    pushActivity: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
  };
}

describe("createNoopEventBridge", () => {
  it("emit does nothing and does not throw", () => {
    const bridge = createNoopEventBridge();
    expect(() => bridge.emit(makeEntry())).not.toThrow();
  });

  it("flush resolves without throwing", async () => {
    const bridge = createNoopEventBridge();
    await expect(bridge.flush()).resolves.toBeUndefined();
  });

  it("shutdown resolves without throwing", async () => {
    const bridge = createNoopEventBridge();
    await expect(bridge.shutdown()).resolves.toBeUndefined();
  });

  it("returns the same singleton instance", () => {
    const a = createNoopEventBridge();
    const b = getNoopEventBridge();
    expect(a).toBe(b);
  });
});

describe("createEventBridge", () => {
  let adapter: ReturnType<typeof makeMockAdapter>;
  let bridge: EventBridge;

  beforeEach(() => {
    mockLogger.warn.mockClear();
    adapter = makeMockAdapter();
    bridge = createEventBridge(adapter);
  });

  it("maps status=allowed to activity type tool_call", async () => {
    bridge.emit(makeEntry({ status: "allowed", tool: "Read" }));
    // flush to ensure async pushActivity is called
    await bridge.flush();

    expect(adapter.pushActivity).toHaveBeenCalledTimes(1);
    const event: ActivityEvent = adapter.pushActivity.mock.calls[0]![0];
    expect(event.type).toBe("tool_call");
    expect(event.tool).toBe("Read");
    expect(event.status).toBe("allowed");
  });

  it("maps status=flagged to activity type injection_flag", async () => {
    bridge.emit(makeEntry({
      status: "flagged",
      tool: "Read",
      flags: [{ pattern: "ignore_instructions", match: "ignore previous", position: 0 }],
    }));
    await bridge.flush();

    expect(adapter.pushActivity).toHaveBeenCalledTimes(1);
    const event: ActivityEvent = adapter.pushActivity.mock.calls[0]![0];
    expect(event.type).toBe("injection_flag");
    expect(event.flags).toContain("ignore_instructions");
  });

  it("maps status=blocked to activity type blocked", async () => {
    bridge.emit(makeEntry({ status: "blocked", tool: "Execute" }));
    await bridge.flush();

    expect(adapter.pushActivity).toHaveBeenCalledTimes(1);
    const event: ActivityEvent = adapter.pushActivity.mock.calls[0]![0];
    expect(event.type).toBe("blocked");
  });

  it("maps status=error to activity type error", async () => {
    bridge.emit(makeEntry({ status: "error", tool: "Read", errorMessage: "bridge boom" }));
    await bridge.flush();

    expect(adapter.pushActivity).toHaveBeenCalledTimes(1);
    const event: ActivityEvent = adapter.pushActivity.mock.calls[0]![0];
    expect(event.type).toBe("error");
    expect(event.errorMessage).toBe("bridge boom");
  });

  it("swallows adapter errors without throwing from emit", async () => {
    adapter.pushActivity.mockRejectedValueOnce(new Error("adapter down"));

    expect(() => bridge.emit(makeEntry())).not.toThrow();
    // flush should also not throw even though adapter failed
    await expect(bridge.flush()).resolves.toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("passes durationMs through to the activity event", async () => {
    bridge.emit(makeEntry({ durationMs: 99 }));
    await bridge.flush();

    const event: ActivityEvent = adapter.pushActivity.mock.calls[0]![0];
    expect(event.durationMs).toBe(99);
  });

  it("passes timestamp through to the activity event", async () => {
    bridge.emit(makeEntry({ timestamp: "2026-04-25T12:34:56.789Z" }));
    await bridge.flush();

    const event: ActivityEvent = adapter.pushActivity.mock.calls[0]![0];
    expect(event.timestamp).toBe("2026-04-25T12:34:56.789Z");
  });

  it("shutdown delegates to adapter.shutdown", async () => {
    await bridge.shutdown();
    expect(adapter.shutdown).toHaveBeenCalledTimes(1);
  });
});
