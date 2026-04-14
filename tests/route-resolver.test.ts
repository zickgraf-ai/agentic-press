import { describe, it, expect, vi } from "vitest";

const { mockLogger } = vi.hoisted(() => {
  const mockLogger = {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn(),
  };
  mockLogger.child.mockReturnValue(mockLogger);
  return { mockLogger };
});
vi.mock("../src/logger.js", () => ({
  default: mockLogger, childLogger: vi.fn(() => mockLogger),
}));

import { resolveRoute, sortRoutes } from "../src/mcp-proxy/server.js";

// Helper: sort routes then resolve (mirrors production usage)
function resolve(toolName: string, routes: Record<string, string>): string | undefined {
  return resolveRoute(toolName, sortRoutes(routes));
}

describe("resolveRoute", () => {
  it("returns undefined for empty routes", () => {
    expect(resolve("Read", {})).toBeUndefined();
  });

  it("matches exact route", () => {
    expect(resolve("Read", { Read: "fs" })).toBe("fs");
  });

  it("matches wildcard route", () => {
    expect(resolve("echo__read_file", { "echo__*": "echo" })).toBe("echo");
  });

  it("returns undefined when nothing matches", () => {
    expect(resolve("unknown", { "echo__*": "echo" })).toBeUndefined();
  });

  it("exact match wins over wildcard (H-4 specificity)", () => {
    const routes = {
      "*": "default",
      "echo__*": "echo",
      "echo__read_file": "echo-reader",
    };
    expect(resolve("echo__read_file", routes)).toBe("echo-reader");
  });

  it("longer wildcard prefix wins over shorter (H-4)", () => {
    const routes = {
      "*": "default",
      "echo__*": "echo",
    };
    expect(resolve("echo__read", routes)).toBe("echo");
  });

  it("catch-all '*' is last resort", () => {
    const routes = {
      "*": "default",
      "fs__*": "filesystem",
    };
    expect(resolve("fs__read", routes)).toBe("filesystem");
    expect(resolve("unknown_tool", routes)).toBe("default");
  });

  it("multiple wildcards resolve to most specific", () => {
    const routes = {
      "echo__read_*": "echo-reader",
      "echo__*": "echo-general",
    };
    expect(resolve("echo__read_file", routes)).toBe("echo-reader");
    expect(resolve("echo__write_file", routes)).toBe("echo-general");
  });
});

describe("sortRoutes", () => {
  it("puts exact matches before wildcards", () => {
    const sorted = sortRoutes({ "*": "a", "Read": "b" });
    expect(sorted[0][0]).toBe("Read");
    expect(sorted[1][0]).toBe("*");
  });

  it("puts longer wildcards before shorter", () => {
    const sorted = sortRoutes({ "e__*": "short", "echo__read_*": "long", "echo__*": "mid" });
    expect(sorted[0][0]).toBe("echo__read_*");
    expect(sorted[1][0]).toBe("echo__*");
    expect(sorted[2][0]).toBe("e__*");
  });
});
