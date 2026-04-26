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
  createStdioBridge,
  DEFAULT_MAX_RESPONSE_BYTES,
  ResponseSizeExceededError,
  type McpServerDef,
} from "../src/mcp-proxy/stdio-bridge.js";

/**
 * Build a server that on first request emits a JSON-RPC envelope whose
 * `result.content[0].text` is `payloadFiller` (a deterministic ASCII string
 * controlled by the test). Subsequent requests echo a small `{ ok: true }`
 * result so we can prove the bridge stays usable after a rejection.
 *
 * The server emits the full envelope as one stdout line (terminated by \n),
 * matching the line-delimited transport the bridge expects.
 */
function makeFixedSizeServer(name: string, payloadFiller: string): McpServerDef {
  return {
    name,
    command: "node",
    args: [
      "-e",
      `
      const filler = ${JSON.stringify(payloadFiller)};
      let firstResponseSent = false;
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
            let result;
            if (!firstResponseSent) {
              firstResponseSent = true;
              // Emit a response whose text content is exactly the filler.
              result = { content: [{ type: "text", text: filler }] };
            } else {
              result = { ok: true };
            }
            process.stdout.write(
              JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\\n"
            );
          } catch {}
        }
      });
      `,
    ],
  };
}

/** Compute the byte length of the JSON-RPC envelope this server will emit
 * (without the trailing newline). The bridge measures byte length per line
 * (excluding the \n delimiter), so this is what the cap is compared against. */
function envelopeByteLength(id: number, payloadFiller: string): number {
  const envelope = JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text: payloadFiller }] },
  });
  return Buffer.byteLength(envelope, "utf8");
}

describe("stdio bridge — response size cap", () => {
  it("exports a sane default of 10 MiB", () => {
    expect(DEFAULT_MAX_RESPONSE_BYTES).toBe(10 * 1024 * 1024);
  });

  it("under-cap response passes through normally", async () => {
    const filler = "x".repeat(20); // tiny payload
    const bridge = createStdioBridge([makeFixedSizeServer("under-cap", filler)], {
      maxResponseBytes: 1024,
    });
    try {
      const result = await bridge.call("under-cap", "tools/call", {});
      expect(result).toEqual({ content: [{ type: "text", text: filler }] });
    } finally {
      await bridge.shutdown();
    }
  }, 10000);

  it("over-cap response rejects with ResponseSizeExceededError", async () => {
    const filler = "x".repeat(2000);
    const bridge = createStdioBridge([makeFixedSizeServer("over-cap", filler)], {
      maxResponseBytes: 512,
    });
    try {
      await expect(bridge.call("over-cap", "tools/call", {})).rejects.toBeInstanceOf(
        ResponseSizeExceededError
      );
    } finally {
      await bridge.shutdown();
    }
  }, 10000);

  it("exact-boundary: response of length N where N == cap is allowed", async () => {
    // Build a payload, measure the exact envelope byte length, set the cap to that.
    const filler = "y".repeat(800);
    const exactLen = envelopeByteLength(1, filler);
    const bridge = createStdioBridge([makeFixedSizeServer("at-cap", filler)], {
      maxResponseBytes: exactLen,
    });
    try {
      const result = await bridge.call("at-cap", "tools/call", {});
      expect(result).toEqual({ content: [{ type: "text", text: filler }] });
    } finally {
      await bridge.shutdown();
    }
  }, 10000);

  it("just-over-boundary: response of length N where cap == N-1 is rejected", async () => {
    const filler = "z".repeat(800);
    const exactLen = envelopeByteLength(1, filler);
    const bridge = createStdioBridge([makeFixedSizeServer("just-over-cap", filler)], {
      maxResponseBytes: exactLen - 1,
    });
    try {
      await expect(
        bridge.call("just-over-cap", "tools/call", {})
      ).rejects.toBeInstanceOf(ResponseSizeExceededError);
    } finally {
      await bridge.shutdown();
    }
  }, 10000);

  it("maxResponseBytes=0 disables the cap entirely", async () => {
    // Use a moderately large payload (~256 KB) — large enough to clearly exceed any
    // accidental small default, small enough not to slow the test suite.
    const filler = "q".repeat(256 * 1024);
    const bridge = createStdioBridge([makeFixedSizeServer("disabled", filler)], {
      maxResponseBytes: 0,
    });
    try {
      const result = await bridge.call("disabled", "tools/call", {});
      expect(result).toEqual({ content: [{ type: "text", text: filler }] });
    } finally {
      await bridge.shutdown();
    }
  }, 15000);

  it("rejects only the in-flight call, not the bridge itself — subsequent calls succeed", async () => {
    const filler = "x".repeat(2000);
    const bridge = createStdioBridge([makeFixedSizeServer("resilient", filler)], {
      maxResponseBytes: 512,
    });
    try {
      // First call: oversized response → rejection
      await expect(
        bridge.call("resilient", "tools/call", {})
      ).rejects.toBeInstanceOf(ResponseSizeExceededError);

      // Second call: server emits a small `{ ok: true }` — bridge must be usable
      const second = await bridge.call("resilient", "tools/call", {});
      expect(second).toEqual({ ok: true });
    } finally {
      await bridge.shutdown();
    }
  }, 10000);

  it("ResponseSizeExceededError exposes serverName, limitBytes, observedBytes", async () => {
    const filler = "x".repeat(2000);
    const bridge = createStdioBridge([makeFixedSizeServer("introspect", filler)], {
      maxResponseBytes: 512,
    });
    try {
      let caught: unknown;
      try {
        await bridge.call("introspect", "tools/call", {});
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ResponseSizeExceededError);
      const err = caught as ResponseSizeExceededError;
      expect(err.serverName).toBe("introspect");
      expect(err.limitBytes).toBe(512);
      expect(err.observedBytes).toBeGreaterThan(512);
      expect(err.message).toMatch(/response/i);
      expect(err.message).toMatch(/size/i);
    } finally {
      await bridge.shutdown();
    }
  }, 10000);
});
