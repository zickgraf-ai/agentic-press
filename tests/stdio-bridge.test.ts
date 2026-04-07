import { describe, it, expect, vi } from "vitest";
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
      // Force spawn by issuing a no-reply call
      bridge.call(name, "ping", {}).catch(() => {});
      // Wait for spawn to settle
      await new Promise((r) => setTimeout(r, 100));
      const info = bridge.getProcessInfo(name);
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
      expect(elapsed).toBeGreaterThanOrEqual(180);
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
      expect(elapsed).toBeGreaterThanOrEqual(180);
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

      const info = bridge.getProcessInfo("fast-exit");
      expect(info).not.toBeNull();
      expect(info!.exitCode).not.toBeNull(); // already dead

      const startedAt = Date.now();
      await bridge.shutdown();
      const elapsed = Date.now() - startedAt;
      // Should be near-instant (no grace period wait)
      expect(elapsed).toBeLessThan(50);
    }, 10000);

    it("getProcessInfo returns null for unknown server", () => {
      const bridge = createStdioBridge([]);
      expect(bridge.getProcessInfo("nonexistent")).toBeNull();
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
});
