import { describe, it, expect } from "vitest";
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
    it("awaits child process exit — proc.exitCode is set after shutdown resolves", async () => {
      // Spawn a server that traps SIGTERM and delays exit by 200ms
      const servers: McpServerDef[] = [
        {
          name: "slow-exit",
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
        },
      ];

      const bridge = createStdioBridge(servers);

      // Fire a call to force the process to spawn; don't await (it will never get a reply)
      const callPromise = bridge.call("slow-exit", "ping", {}).catch(() => {});

      // Wait for process to be running
      await new Promise((r) => setTimeout(r, 100));

      // Grab a reference to the child process before shutdown clears the map
      const proc = bridge.getProcess("slow-exit");
      expect(proc).toBeDefined();
      expect(proc!.exitCode).toBeNull(); // still running

      await bridge.shutdown();

      // After shutdown resolves, the child MUST have exited
      expect(proc!.exitCode).not.toBeNull();

      await callPromise; // clean up pending promise
    }, 10000);
  });
});
