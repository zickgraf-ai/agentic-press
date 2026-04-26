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

import {
  createCompositeTransport,
  type McpTransport,
} from "../src/mcp-proxy/transport.js";

function makeTransport(name: string, owns: readonly string[]): McpTransport & {
  call: ReturnType<typeof vi.fn>;
  shutdown: ReturnType<typeof vi.fn>;
} {
  const call = vi.fn(async (server: string, _method: string, _params: unknown) => {
    if (!owns.includes(server)) throw new Error(`${name}: not configured for ${server}`);
    return { ok: true, from: name, server };
  });
  return { call, shutdown: vi.fn(async () => {}) };
}

describe("createCompositeTransport", () => {
  it("dispatches call() to the bridge that owns the server name", async () => {
    const stdio = makeTransport("stdio", ["fs", "git"]);
    const http = makeTransport("http", ["remote"]);
    const composite = createCompositeTransport([
      { bridge: stdio, owns: ["fs", "git"] },
      { bridge: http, owns: ["remote"] },
    ]);

    const fsResult = await composite.call("fs", "tools/call", {});
    expect(fsResult).toMatchObject({ from: "stdio", server: "fs" });
    expect(stdio.call).toHaveBeenCalledTimes(1);
    expect(http.call).not.toHaveBeenCalled();

    const remoteResult = await composite.call("remote", "tools/call", {});
    expect(remoteResult).toMatchObject({ from: "http", server: "remote" });
    expect(http.call).toHaveBeenCalledTimes(1);
  });

  it("rejects with a clear error for an unknown server name", async () => {
    const stdio = makeTransport("stdio", ["fs"]);
    const composite = createCompositeTransport([{ bridge: stdio, owns: ["fs"] }]);
    await expect(composite.call("nope", "tools/call", {})).rejects.toThrow(/not configured|nope/i);
  });

  it("shutdown calls each underlying bridge's shutdown exactly once", async () => {
    const stdio = makeTransport("stdio", ["fs"]);
    const http = makeTransport("http", ["remote"]);
    const composite = createCompositeTransport([
      { bridge: stdio, owns: ["fs"] },
      { bridge: http, owns: ["remote"] },
    ]);
    await composite.shutdown();
    expect(stdio.shutdown).toHaveBeenCalledTimes(1);
    expect(http.shutdown).toHaveBeenCalledTimes(1);
  });

  it("shutdown waits for all bridges even if one rejects (Promise.allSettled semantics)", async () => {
    const ok = makeTransport("ok", ["a"]);
    const broken: McpTransport = {
      call: vi.fn(),
      shutdown: vi.fn(async () => { throw new Error("shutdown boom"); }),
    };
    const composite = createCompositeTransport([
      { bridge: ok, owns: ["a"] },
      { bridge: broken, owns: ["b"] },
    ]);
    // Composite shutdown must not reject — observability/transport teardown
    // must never break the proxy's exit path.
    await expect(composite.shutdown()).resolves.toBeUndefined();
    expect(ok.shutdown).toHaveBeenCalledTimes(1);
    expect(broken.shutdown).toHaveBeenCalledTimes(1);
  });

  it("with no bridges configured, shutdown resolves and call rejects on any server name", async () => {
    const composite = createCompositeTransport([]);
    await expect(composite.shutdown()).resolves.toBeUndefined();
    await expect(composite.call("anything", "tools/call", {})).rejects.toThrow();
  });
});
