import { describe, it, expect, vi } from "vitest";

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

vi.mock("../src/logger.js", () => ({
  default: mockLogger,
  childLogger: vi.fn(() => mockLogger),
}));

import { createStdioBridge, type McpServerDef } from "../src/mcp-proxy/stdio-bridge.js";

describe("stdio bridge", () => {
  describe("createStdioBridge", () => {
    it("returns an object with call and shutdown methods", () => {
      const bridge = createStdioBridge([]);
      expect(typeof bridge.call).toBe("function");
      expect(typeof bridge.shutdown).toBe("function");
    });

    it("shutdown resolves cleanly with no servers", async () => {
      const bridge = createStdioBridge([]);
      await expect(bridge.shutdown()).resolves.toBeUndefined();
    });
  });

  describe("call", () => {
    it("rejects when calling a non-existent server", async () => {
      const bridge = createStdioBridge([]);
      await expect(
        bridge.call("nonexistent", "tools/list", {})
      ).rejects.toThrow(/not found|not configured/i);
    });

    it("can spawn and communicate with a simple echo server", async () => {
      // Use node to create a minimal JSON-RPC stdio server
      const servers: McpServerDef[] = [
        {
          name: "echo",
          command: "node",
          args: [
            "-e",
            `
            process.stdin.setEncoding("utf8");
            let buf = "";
            process.stdin.on("data", (chunk) => {
              buf += chunk;
              const lines = buf.split("\\n");
              buf = lines.pop() || "";
              for (const line of lines) {
                if (!line.trim()) continue;
                try {
                  const req = JSON.parse(line);
                  const res = { jsonrpc: "2.0", id: req.id, result: { echo: req.params } };
                  process.stdout.write(JSON.stringify(res) + "\\n");
                } catch {}
              }
            });
            `,
          ],
        },
      ];

      const bridge = createStdioBridge(servers);
      try {
        const result = await bridge.call("echo", "test/echo", { hello: "world" });
        expect(result).toEqual({ echo: { hello: "world" } });
      } finally {
        await bridge.shutdown();
      }
    }, 10000);

    it("handles server crash gracefully", async () => {
      const servers: McpServerDef[] = [
        {
          name: "crasher",
          command: "node",
          args: ["-e", "process.exit(1)"],
        },
      ];

      const bridge = createStdioBridge(servers);
      try {
        await expect(
          bridge.call("crasher", "test", {})
        ).rejects.toThrow();
      } finally {
        await bridge.shutdown();
      }
    }, 10000);
  });

  describe("shutdown", () => {
    // Server that traps SIGTERM and delays exit by 200ms (graceful shutdown path)
    const slowGracefulServer: McpServerDef = {
      name: "slow-graceful",
      command: "node",
      args: [
        "-e",
        `
        process.on("SIGTERM", () => {
          setTimeout(() => process.exit(0), 200);
        });
        setInterval(() => {}, 60000);
        `,
      ],
    };

    // Server that ignores SIGTERM completely — only SIGKILL will stop it
    const sigtermIgnoreServer: McpServerDef = {
      name: "sigterm-ignore",
      command: "node",
      args: [
        "-e",
        `
        process.on("SIGTERM", () => {}); // swallow SIGTERM
        setInterval(() => {}, 60000);
        `,
      ],
    };

    async function spawnAndGetProcessInfo(bridge: ReturnType<typeof createStdioBridge>, name: string) {
      // Force spawn by issuing a call. For these test servers the call will never
      // resolve (no JSON response), so we swallow the eventual rejection. We only
      // need the spawn side effect to populate the bridge's process map.
      bridge.call(name, "ping", {}).catch(() => {});
      // Wait for spawn to settle
      await new Promise((r) => setTimeout(r, 100));
      const info = bridge._getProcessInfo(name);
      expect(info).not.toBeNull();
      return info!;
    }

    it("awaits child exit — exitCode is non-null after shutdown resolves (graceful path)", async () => {
      const bridge = createStdioBridge([slowGracefulServer]);
      const beforeInfo = await spawnAndGetProcessInfo(bridge, "slow-graceful");
      expect(beforeInfo.exitCode).toBeNull(); // running
      expect(beforeInfo.pid).toBeDefined();

      const startedAt = Date.now();
      await bridge.shutdown();
      const elapsed = Date.now() - startedAt;

      // Bug-reproduction proof (S-4): shutdown must have actually waited ≥ ~190ms,
      // not coincidentally observed an exited process.
      expect(elapsed).toBeGreaterThanOrEqual(150); // 50ms slack for slow CI
    }, 10000);

    it("escalates to SIGKILL when child ignores SIGTERM (I-1: SIGKILL fallback)", async () => {
      // Short grace period (50ms) so this test runs in milliseconds, not seconds (S-2)
      const bridge = createStdioBridge([sigtermIgnoreServer], { shutdownGracePeriodMs: 50 });
      const info = await spawnAndGetProcessInfo(bridge, "sigterm-ignore");
      expect(info.exitCode).toBeNull();

      const startedAt = Date.now();
      await bridge.shutdown();
      const elapsed = Date.now() - startedAt;

      // Must have exceeded the grace period (proving SIGKILL was reached)
      expect(elapsed).toBeGreaterThanOrEqual(50);
      // But must not have exceeded grace + hard ceiling (2000ms) by much
      expect(elapsed).toBeLessThan(2500);
    }, 10000);

    it("shuts down multiple servers concurrently (I-2)", async () => {
      // Three slow-graceful servers — must run in parallel, total time ~ max(delays), not sum.
      const servers: McpServerDef[] = [
        { ...slowGracefulServer, name: "slow-1" },
        { ...slowGracefulServer, name: "slow-2" },
        { ...slowGracefulServer, name: "slow-3" },
      ];

      const bridge = createStdioBridge(servers);
      await spawnAndGetProcessInfo(bridge, "slow-1");
      await spawnAndGetProcessInfo(bridge, "slow-2");
      await spawnAndGetProcessInfo(bridge, "slow-3");

      const startedAt = Date.now();
      await bridge.shutdown();
      const elapsed = Date.now() - startedAt;

      // Three 200ms delays in parallel ≈ 200-400ms; serialized would be ≥600ms.
      expect(elapsed).toBeGreaterThanOrEqual(150); // 50ms slack for slow CI
      expect(elapsed).toBeLessThan(600);
    }, 10000);

    it("handles already-exited process without waiting (I-5)", async () => {
      // Server that exits immediately
      const fastExitServer: McpServerDef = {
        name: "fast-exit",
        command: "node",
        args: ["-e", "process.exit(0)"],
      };

      const bridge = createStdioBridge([fastExitServer]);
      // Force spawn
      bridge.call("fast-exit", "ping", {}).catch(() => {});
      // Wait long enough for child to exit on its own
      await new Promise((r) => setTimeout(r, 200));

      const info = bridge._getProcessInfo("fast-exit");
      expect(info).not.toBeNull();
      expect(info!.exitCode).not.toBeNull(); // already dead

      const startedAt = Date.now();
      await bridge.shutdown();
      const elapsed = Date.now() - startedAt;
      // Should be near-instant (no grace period wait)
      expect(elapsed).toBeLessThan(50);
    }, 10000);

    it("_getProcessInfo returns null for unknown server", () => {
      const bridge = createStdioBridge([]);
      expect(bridge._getProcessInfo("nonexistent")).toBeNull();
    });

    it("rejectAllPending — pending calls reject with 'Bridge shutting down' on shutdown (S-5)", async () => {
      const bridge = createStdioBridge([slowGracefulServer], { shutdownGracePeriodMs: 100 });
      // Issue a call that will never get a response
      const callPromise = bridge.call("slow-graceful", "ping", {});
      // Wait for spawn
      await new Promise((r) => setTimeout(r, 100));

      // Shutdown should reject the pending call
      const shutdownPromise = bridge.shutdown();
      await expect(callPromise).rejects.toThrow(/shutting down/i);
      await shutdownPromise;
    }, 10000);
  });

  // Helper: a server that emits a banner line on stdout, then echoes JSON-RPC requests.
  function makeBannerServer(name: string, banner = "Starting up..."): McpServerDef {
    return {
      name,
      command: "node",
      args: [
        "-e",
        `
        process.stdout.write(${JSON.stringify(banner)} + "\\n");
        process.stdin.setEncoding("utf8");
        let buf = "";
        process.stdin.on("data", (chunk) => {
          buf += chunk;
          const lines = buf.split("\\n");
          buf = lines.pop() || "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const req = JSON.parse(line);
              const res = { jsonrpc: "2.0", id: req.id, result: { ok: true } };
              process.stdout.write(JSON.stringify(res) + "\\n");
            } catch {}
          }
        });
        `,
      ],
    };
  }

  /** Returns logger calls that mention the bridge's "Non-JSON" diagnostic. */
  function nonJsonLogs(): unknown[][] {
    // After structured logger migration: debug-level logs go to mockLogger.debug,
    // one-shot warnings go to mockLogger.warn. Check both.
    const debugCalls = mockLogger.debug.mock.calls.filter(
      (args: unknown[]) => typeof args[1] === "string" && args[1].includes("Non-JSON")
    );
    const warnCalls = mockLogger.warn.mock.calls.filter(
      (args: unknown[]) => typeof args[1] === "string" && args[1].includes("Non-JSON")
    );
    return [...debugCalls, ...warnCalls];
  }

  describe("non-JSON stdout logging", () => {
    it("logs every non-JSON line at debug level", async () => {
      mockLogger.debug.mockClear();
      mockLogger.warn.mockClear();
      const bridge = createStdioBridge([makeBannerServer("debug-banner")], { logLevel: "debug" });
      try {
        await bridge.call("debug-banner", "test/ping", {});
        await new Promise((r) => setTimeout(r, 100));
        const debugCalls = mockLogger.debug.mock.calls.filter(
          (args: unknown[]) => typeof args[1] === "string" && args[1].includes("Non-JSON")
        );
        expect(debugCalls.length).toBeGreaterThanOrEqual(1);
        expect(debugCalls[0][1]).toContain("Starting up...");
      } finally {
        await bridge.shutdown();
      }
    }, 10000);

    // Parametrized test: at info/warn/error, the one-shot warning MUST still fire
    // (covers the original silent-failure regression and the level-ordering bug).
    it.each(["info", "warn", "error"] as const)(
      "emits one-shot warning at logLevel=%s (loud by default)",
      async (logLevel) => {
        mockLogger.warn.mockClear();
        mockLogger.debug.mockClear();
        const bridge = createStdioBridge([makeBannerServer(`${logLevel}-banner`)], { logLevel });
        try {
          await bridge.call(`${logLevel}-banner`, "test/ping", {});
          await new Promise((r) => setTimeout(r, 100));
          const warnCalls = mockLogger.warn.mock.calls.filter(
            (args: unknown[]) => typeof args[1] === "string" && args[1].includes("Non-JSON")
          );
          // Exactly one warning per server, regardless of how many non-JSON lines come through
          expect(warnCalls.length).toBe(1);
          expect((warnCalls[0][0] as Record<string, unknown>).server).toBe(`${logLevel}-banner`);
        } finally {
          await bridge.shutdown();
        }
      },
      10000
    );

    it("one-shot warning fires only once even with many non-JSON lines", async () => {
      mockLogger.warn.mockClear();
      const noisyServer: McpServerDef = {
        name: "noisy",
        command: "node",
        args: [
          "-e",
          `
          // Emit 3 non-JSON lines (under the fail-fast threshold of 5), then echo JSON
          process.stdout.write("line 1\\n");
          process.stdout.write("line 2\\n");
          process.stdout.write("line 3\\n");
          process.stdin.setEncoding("utf8");
          let buf = "";
          process.stdin.on("data", (chunk) => {
            buf += chunk;
            const lines = buf.split("\\n");
            buf = lines.pop() || "";
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const req = JSON.parse(line);
                process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: true } }) + "\\n");
              } catch {}
            }
          });
          `,
        ],
      };
      const bridge = createStdioBridge([noisyServer], { logLevel: "info" });
      try {
        await bridge.call("noisy", "test/ping", {});
        await new Promise((r) => setTimeout(r, 100));
        const logs = nonJsonLogs();
        expect(logs.length).toBe(1); // one-shot, not three
      } finally {
        await bridge.shutdown();
      }
    }, 10000);

    it("fail-fast: rejects pending calls when spawn emits only non-JSON lines", async () => {
      const brokenServer: McpServerDef = {
        name: "broken-spawn",
        command: "node",
        args: [
          "-e",
          `
          // Pretend we're a misconfigured binary writing diagnostic text
          for (let i = 1; i <= 6; i++) process.stdout.write("error line " + i + "\\n");
          // Never read stdin or emit JSON-RPC
          setInterval(() => {}, 60000);
          `,
        ],
      };
      const bridge = createStdioBridge([brokenServer], { logLevel: "info" });
      try {
        await expect(bridge.call("broken-spawn", "test/ping", {})).rejects.toThrow(
          /misconfigured spawn|non-JSON lines/i
        );
      } finally {
        await bridge.shutdown();
      }
    }, 10000);

    it("fail-fast: subsequent calls to a broken server reject promptly without re-spawning", async () => {
      const brokenServer: McpServerDef = {
        name: "broken-spawn-repeat",
        command: "node",
        args: [
          "-e",
          `
          for (let i = 1; i <= 6; i++) process.stdout.write("error line " + i + "\\n");
          setInterval(() => {}, 60000);
          `,
        ],
      };
      const bridge = createStdioBridge([brokenServer], { logLevel: "info" });
      try {
        // First call triggers fail-fast and marks the process as broken
        await expect(bridge.call("broken-spawn-repeat", "ping", {})).rejects.toThrow(
          /misconfigured spawn|non-JSON lines/i
        );

        // Second call must reject SYNCHRONOUSLY (no waiting for new non-JSON lines).
        const startedAt = Date.now();
        await expect(bridge.call("broken-spawn-repeat", "ping", {})).rejects.toThrow(
          /misconfigured spawn|non-JSON lines/i
        );
        expect(Date.now() - startedAt).toBeLessThan(50);

        // Third call: same fast rejection
        const startedAt2 = Date.now();
        await expect(bridge.call("broken-spawn-repeat", "ping", {})).rejects.toThrow(
          /misconfigured spawn|non-JSON lines/i
        );
        expect(Date.now() - startedAt2).toBeLessThan(50);
      } finally {
        await bridge.shutdown();
      }
    }, 10000);

    it("fail-fast can be disabled with failFastNonJsonLines=0", async () => {
      const slowStartServer: McpServerDef = {
        name: "slow-start",
        command: "node",
        args: [
          "-e",
          `
          for (let i = 1; i <= 10; i++) process.stdout.write("preamble " + i + "\\n");
          process.stdin.setEncoding("utf8");
          let buf = "";
          process.stdin.on("data", (chunk) => {
            buf += chunk;
            const lines = buf.split("\\n");
            buf = lines.pop() || "";
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const req = JSON.parse(line);
                process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: true } }) + "\\n");
              } catch {}
            }
          });
          `,
        ],
      };
      const bridge = createStdioBridge([slowStartServer], {
        logLevel: "info",
        failFastNonJsonLines: 0,
      });
      try {
        const result = await bridge.call("slow-start", "test/ping", {});
        expect(result).toEqual({ ok: true });
      } finally {
        await bridge.shutdown();
      }
    }, 10000);
  });
});
