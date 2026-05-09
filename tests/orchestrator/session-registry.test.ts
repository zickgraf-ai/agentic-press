import { describe, it, expect, beforeEach, vi } from "vitest";

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
import type { AllowlistConfig } from "../../src/mcp-proxy/allowlist.js";

const SAMPLE: AllowlistConfig = { patterns: ["echo__read_file"] };

describe("SessionRegistry", () => {
  beforeEach(() => {
    mockLogger.warn.mockClear();
    mockLogger.info.mockClear();
  });

  it("register makes lookup return the registered entry", () => {
    const registry = createSessionRegistry();
    registry.register({ sessionId: "s1", agentType: "reviewer", allowlist: SAMPLE });
    const entry = registry.lookup("s1");
    expect(entry).toBeDefined();
    expect(entry?.agentType).toBe("reviewer");
    expect(entry?.allowlist.patterns).toEqual(["echo__read_file"]);
    expect(typeof entry?.registeredAt).toBe("string");
    expect(() => new Date(entry!.registeredAt).toISOString()).not.toThrow();
  });

  it("lookup of unknown sessionId returns undefined", () => {
    const registry = createSessionRegistry();
    expect(registry.lookup("nope")).toBeUndefined();
  });

  it("deregister removes the session; subsequent lookup returns undefined", () => {
    const registry = createSessionRegistry();
    registry.register({ sessionId: "s2", agentType: "coder", allowlist: SAMPLE });
    expect(registry.lookup("s2")).toBeDefined();
    registry.deregister("s2");
    expect(registry.lookup("s2")).toBeUndefined();
  });

  it("deregister of unknown sessionId is a no-op (does not throw)", () => {
    const registry = createSessionRegistry();
    expect(() => registry.deregister("never-was")).not.toThrow();
    expect(registry.size()).toBe(0);
  });

  it("list() returns shallow copies — mutating the returned array does not affect internal state", () => {
    const registry = createSessionRegistry();
    registry.register({ sessionId: "a", agentType: "reviewer", allowlist: SAMPLE });
    registry.register({ sessionId: "b", agentType: "coder", allowlist: SAMPLE });
    const listed = registry.list();
    expect(listed).toHaveLength(2);
    expect(listed.map((e) => e.sessionId).sort()).toEqual(["a", "b"]);
    listed.length = 0;
    expect(registry.size()).toBe(2);
    expect(registry.lookup("a")).toBeDefined();
    expect(registry.lookup("b")).toBeDefined();
  });

  it("re-register of same sessionId overwrites and warn-logs once", () => {
    const registry = createSessionRegistry();
    registry.register({ sessionId: "dup", agentType: "reviewer", allowlist: { patterns: ["A"] } });
    expect(mockLogger.warn).not.toHaveBeenCalled();
    registry.register({ sessionId: "dup", agentType: "coder", allowlist: { patterns: ["B"] } });
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "dup" }),
      expect.stringMatching(/re-register/i)
    );
    const entry = registry.lookup("dup");
    expect(entry?.agentType).toBe("coder");
    expect(entry?.allowlist.patterns).toEqual(["B"]);
  });

  it("register rejects malformed input (defensive second line of defence)", () => {
    const registry = createSessionRegistry();
    expect(() =>
      registry.register({ sessionId: "", agentType: "x", allowlist: SAMPLE })
    ).toThrow(/sessionId/i);
    expect(() =>
      // @ts-expect-error — runtime check for non-string
      registry.register({ sessionId: 123, agentType: "x", allowlist: SAMPLE })
    ).toThrow(/sessionId/i);
    expect(() =>
      registry.register({ sessionId: "ok", agentType: "x", allowlist: { patterns: [] } })
    ).toThrow(/allowlist|patterns|empty/i);
    expect(() =>
      // @ts-expect-error — runtime check for non-array
      registry.register({ sessionId: "ok", agentType: "x", allowlist: { patterns: "Read" } })
    ).toThrow(/allowlist|patterns|array/i);
    expect(() =>
      registry.register({ sessionId: "ok", agentType: "", allowlist: SAMPLE })
    ).toThrow(/agentType/i);
    expect(registry.size()).toBe(0);
  });

  it("size() returns the number of registered sessions", () => {
    const registry = createSessionRegistry();
    expect(registry.size()).toBe(0);
    registry.register({ sessionId: "x", agentType: "r", allowlist: SAMPLE });
    expect(registry.size()).toBe(1);
    registry.register({ sessionId: "y", agentType: "c", allowlist: SAMPLE });
    expect(registry.size()).toBe(2);
    registry.deregister("x");
    expect(registry.size()).toBe(1);
  });
});
