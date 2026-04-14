import { describe, it, expect } from "vitest";
import { parseServerDefs, parseServerRoutes, validateServerConfig } from "../src/server-config.js";

describe("parseServerDefs", () => {
  it("returns empty array when MCP_SERVERS is unset", () => {
    expect(parseServerDefs(undefined)).toEqual([]);
  });

  it("returns empty array when MCP_SERVERS is empty string", () => {
    expect(parseServerDefs("")).toEqual([]);
  });

  it("parses a single server definition", () => {
    const raw = '[{"name":"fs","command":"npx","args":["-y","x"]}]';
    expect(parseServerDefs(raw)).toEqual([{ name: "fs", command: "npx", args: ["-y", "x"] }]);
  });

  it("throws with a clear message on invalid JSON", () => {
    expect(() => parseServerDefs("not json")).toThrow(/MCP_SERVERS/);
  });
});

describe("parseServerRoutes", () => {
  it("returns undefined when SERVER_ROUTES is unset", () => {
    expect(parseServerRoutes(undefined)).toBeUndefined();
  });

  it("returns undefined when SERVER_ROUTES is empty string", () => {
    expect(parseServerRoutes("")).toBeUndefined();
  });

  it("parses a route map", () => {
    expect(parseServerRoutes('{"fs__*":"fs"}')).toEqual({ "fs__*": "fs" });
  });

  it("throws with a clear message on invalid JSON", () => {
    expect(() => parseServerRoutes("not json")).toThrow(/SERVER_ROUTES/);
  });
});

describe("validateServerConfig", () => {
  it("accepts both unset (stub mode)", () => {
    expect(() => validateServerConfig([], undefined)).not.toThrow();
  });

  it("accepts both set", () => {
    expect(() =>
      validateServerConfig([{ name: "fs", command: "x", args: [] }], { "fs__*": "fs" })
    ).not.toThrow();
  });

  it("rejects MCP_SERVERS set with SERVER_ROUTES unset", () => {
    expect(() => validateServerConfig([{ name: "fs", command: "x", args: [] }], undefined))
      .toThrow(/SERVER_ROUTES/);
  });

  it("rejects SERVER_ROUTES set with MCP_SERVERS unset", () => {
    expect(() => validateServerConfig([], { "fs__*": "fs" }))
      .toThrow(/MCP_SERVERS/);
  });

  it("rejects a route pointing at an undeclared server", () => {
    expect(() =>
      validateServerConfig([{ name: "fs", command: "x", args: [] }], { "fs__*": "fs", "echo__*": "echo" })
    ).toThrow(/echo/);
  });

  it("error messages are actionable (mention the env var and the fix)", () => {
    try {
      validateServerConfig([{ name: "fs", command: "x", args: [] }], undefined);
      throw new Error("expected throw");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toMatch(/SERVER_ROUTES/);
      expect(msg).toMatch(/MCP_SERVERS/);
    }
  });
});
