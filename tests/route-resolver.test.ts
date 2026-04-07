import { describe, it, expect } from "vitest";
import { resolveRoute } from "../src/mcp-proxy/server.js";

describe("resolveRoute", () => {
  it("returns undefined for empty routes", () => {
    expect(resolveRoute("Read", {})).toBeUndefined();
  });

  it("matches exact route", () => {
    expect(resolveRoute("Read", { Read: "fs" })).toBe("fs");
  });

  it("matches wildcard route", () => {
    expect(resolveRoute("echo__read_file", { "echo__*": "echo" })).toBe("echo");
  });

  it("returns undefined when nothing matches", () => {
    expect(resolveRoute("unknown", { "echo__*": "echo" })).toBeUndefined();
  });

  it("exact match wins over wildcard (H-4 specificity)", () => {
    const routes = {
      "*": "default",
      "echo__*": "echo",
      "echo__read_file": "echo-reader",
    };
    expect(resolveRoute("echo__read_file", routes)).toBe("echo-reader");
  });

  it("longer wildcard prefix wins over shorter (H-4)", () => {
    const routes = {
      "*": "default",
      "echo__*": "echo",
    };
    expect(resolveRoute("echo__read", routes)).toBe("echo");
  });

  it("catch-all '*' is last resort", () => {
    const routes = {
      "*": "default",
      "fs__*": "filesystem",
    };
    expect(resolveRoute("fs__read", routes)).toBe("filesystem");
    expect(resolveRoute("unknown_tool", routes)).toBe("default");
  });

  it("multiple wildcards resolve to most specific", () => {
    const routes = {
      "echo__read_*": "echo-reader",
      "echo__*": "echo-general",
    };
    expect(resolveRoute("echo__read_file", routes)).toBe("echo-reader");
    expect(resolveRoute("echo__write_file", routes)).toBe("echo-general");
  });
});
