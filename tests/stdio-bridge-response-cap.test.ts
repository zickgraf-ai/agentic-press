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

/**
 * Build a server that, on first request, streams `chunkCount` chunks of
 * `chunkBytes` ASCII bytes EACH WITHOUT a newline, with a setImmediate gap
 * between each so the bridge sees them as separate "data" events. This is
 * the only way to exercise the mid-flight cap branch — the existing
 * makeFixedSizeServer emits a complete envelope in one atomic write, so
 * the trailing-buffer check never has any pending bytes.
 *
 * The server never sends a newline on the first response — the bridge is
 * expected to reject before any complete line ever arrives. Subsequent
 * requests (if the test issues them) get a small `{ ok: true }` reply.
 */
function makeStreamingNoNewlineServer(
  name: string,
  chunkBytes: number,
  chunkCount: number
): McpServerDef {
  return {
    name,
    command: "node",
    args: [
      "-e",
      `
      const filler = "x".repeat(${chunkBytes});
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
            JSON.parse(line);
          } catch { continue; }
          if (!firstResponseSent) {
            firstResponseSent = true;
            // Stream chunkCount chunks with no newline, separated by setImmediate
            // so each lands as its own "data" event in the bridge.
            let i = 0;
            const send = () => {
              if (i >= ${chunkCount}) return; // stop without newline
              process.stdout.write(filler);
              i++;
              setImmediate(send);
            };
            send();
          } else {
            // Subsequent calls get a small valid reply (terminated).
            const req = JSON.parse(line);
            process.stdout.write(
              JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: true } }) + "\\n"
            );
          }
        }
      });
      `,
    ],
  };
}

/**
 * Build a server that emits exactly `payload` (whatever bytes the test
 * supplies), with NO trailing newline, in a single write on the first
 * request. The bridge will see one data event whose buffer never sees
 * a "\n". Used for the multi-byte UTF-8 boundary tests where we need
 * byte-precise control of the buffered string.
 */
function makeRawWriteServer(name: string, payload: string): McpServerDef {
  return {
    name,
    command: "node",
    args: [
      "-e",
      `
      const payload = ${JSON.stringify(payload)};
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
            if (!firstResponseSent) {
              firstResponseSent = true;
              // Wrap the multi-byte payload in a valid JSON-RPC envelope
              // and emit it on a single line. The bridge measures the
              // whole line by Buffer.byteLength.
              const envelope = JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: { content: [{ type: "text", text: payload }] },
              });
              process.stdout.write(envelope + "\\n");
            } else {
              process.stdout.write(
                JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: true } }) + "\\n"
              );
            }
          } catch {}
        }
      });
      `,
    ],
  };
}

/**
 * Build a server that, on the second request received, streams an oversized
 * UNTERMINATED line as 3 separate filler chunks (no newline) — total bytes
 * comfortably exceed the cap — and then in a 4th data event emits the
 * orphan tail plus the SIBLING line for the second caller, in the form
 * `"<orphan-tail-bytes>\n<small valid envelope>\n"`. This matches the I1
 * scenario from the PR review verbatim.
 *
 * Without the discardingUntilNewline guard, the bridge would: trip
 * mid-flight on chunk 3 (rejecting A), then on chunk 4 see a complete
 * "line" of `<orphan-tail-bytes>` (still over cap) and re-reject — wrongly
 * blaming B. With the guard, chunk 4's bytes-before-\n are dropped, then
 * the small valid envelope is processed cleanly and B resolves.
 */
function makeChunkedThenSiblingServer(name: string, chunkBytes: number): McpServerDef {
  return {
    name,
    command: "node",
    args: [
      "-e",
      `
      process.on("uncaughtException", (e) => {
        process.stderr.write("uncaught: " + e.stack + "\\n");
        process.exit(2);
      });
      const filler = "x".repeat(${chunkBytes});
      const requests = [];
      let phase = 0;
      process.stdin.setEncoding("utf8");
      let buf = "";
      process.stdin.on("data", (chunk) => {
        buf += chunk;
        const lines = buf.split("\\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let req;
          try { req = JSON.parse(line); } catch { continue; }
          requests.push(req);
          // When we have BOTH requests in hand, kick off the streaming
          // sequence. setImmediate between writes ensures each lands as
          // its own "data" event in the bridge.
          if (requests.length === 2 && phase === 0) {
            phase = 1;
            const second = requests[1];
            // Three filler chunks, no newlines — together exceed the cap.
            setImmediate(() => {
              process.stdout.write(filler);
              setImmediate(() => {
                process.stdout.write(filler);
                setImmediate(() => {
                  process.stdout.write(filler);
                  // Fourth chunk: an "orphan tail" of more filler that
                  // terminates the oversized line, immediately followed
                  // by a SMALL valid envelope for the second caller.
                  // Shape: "<more-filler>\\n<valid-envelope>\\n".
                  setImmediate(() => {
                    const tail = "x".repeat(${chunkBytes});
                    const validB =
                      JSON.stringify({
                        jsonrpc: "2.0",
                        id: second.id,
                        result: { ok: "second" },
                      }) + "\\n";
                    process.stdout.write(tail + "\\n" + validB);
                  });
                });
              });
            });
          }
        }
      });
      process.stdin.on("end", () => process.exit(0));
      `,
    ],
  };
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

  // C2: the OOM-defense-critical branch is the mid-flight check on the
  // trailing partial buffer. All preceding tests use atomic writes
  // (`process.stdout.write(... + "\n")`) where the trailing buffer is empty
  // by the time the data event fires — the mid-flight branch is unreached.
  // This test streams filler chunks with NO newline between them, so the
  // bridge buffer keeps growing across data events and only the mid-flight
  // check can save us.
  it("rejects mid-flight when upstream streams unbounded bytes without a newline", async () => {
    // 4 chunks × 256 bytes = 1024 bytes total; cap at 512. The bridge
    // should reject before the 4th chunk arrives. Server never sends
    // a newline, so the per-line check (#2) cannot fire — only the
    // trailing-buffer check (#1) can produce the rejection.
    const bridge = createStdioBridge(
      [makeStreamingNoNewlineServer("midflight", 256, 4)],
      { maxResponseBytes: 512 }
    );
    try {
      await expect(
        bridge.call("midflight", "tools/call", {})
      ).rejects.toBeInstanceOf(ResponseSizeExceededError);
    } finally {
      await bridge.shutdown();
    }
  }, 10000);

  // C3: existing tests use ASCII (`"x".repeat(N)`) where `.length === byteLength`.
  // A regression that replaced Buffer.byteLength(s, "utf8") with s.length would
  // pass every other test in this file. The U+1D11E musical symbol "𝄞" encodes
  // as 4 bytes in UTF-8 but as 2 UTF-16 code units in JS — so 100 copies are
  // 400 bytes but only 200 .length units. We use it to construct a payload
  // where length-based and byte-based measurements diverge sharply.
  it("under-cap multi-byte UTF-8 response is allowed (byte vs code-unit measurement matters)", async () => {
    const filler = "𝄞".repeat(100); // 400 bytes, but .length === 200
    expect(Buffer.byteLength(filler, "utf8")).toBe(400);
    expect(filler.length).toBe(200);

    // Cap chosen so that .length-based measurement of the full envelope
    // would PASS but byte-length measurement would also pass — we want a
    // healthy margin so the test is robust to envelope-overhead drift.
    // (Tighter byte/length divergence is exercised in the over-cap case.)
    const bridge = createStdioBridge([makeRawWriteServer("utf8-under", filler)], {
      maxResponseBytes: 8192,
    });
    try {
      const result = await bridge.call("utf8-under", "tools/call", {});
      expect(result).toEqual({ content: [{ type: "text", text: filler }] });
    } finally {
      await bridge.shutdown();
    }
  }, 10000);

  it("over-cap multi-byte UTF-8 response is rejected by byte length, not code-unit length", async () => {
    // 1000 copies of "𝄞" = 4000 bytes UTF-8, but .length === 2000.
    // If the bridge used s.length, a cap of 3000 would falsely PASS this
    // (2000 < 3000). The byte-correct check rejects it (4000 > 3000).
    const filler = "𝄞".repeat(1000);
    expect(Buffer.byteLength(filler, "utf8")).toBe(4000);
    expect(filler.length).toBe(2000);

    const bridge = createStdioBridge([makeRawWriteServer("utf8-over", filler)], {
      maxResponseBytes: 3000,
    });
    try {
      await expect(
        bridge.call("utf8-over", "tools/call", {})
      ).rejects.toBeInstanceOf(ResponseSizeExceededError);
    } finally {
      await bridge.shutdown();
    }
  }, 10000);

  // I3: FIFO oldest-pending-rejection contract — issue two concurrent calls,
  // upstream emits oversized for the first; assert A is rejected with
  // ResponseSizeExceededError and B remains pending. Then upstream sends a
  // small valid response for B; B resolves. A regression to "reject all" or
  // "reject newest" would fail this test.
  it("oversized response rejects only the oldest pending call (FIFO), leaves siblings alive", async () => {
    // Two concurrent calls. Server drains both requests, then emits a
    // huge payload as a single complete line for the FIRST id, then a
    // small valid response for the SECOND id. The bridge should reject
    // only A (the oldest pending) and resolve B normally.
    const def: McpServerDef = {
      name: "fifo",
      command: "node",
      args: [
        "-e",
        `
        const requests = [];
        process.stdin.setEncoding("utf8");
        let buf = "";
        process.stdin.on("data", (chunk) => {
          buf += chunk;
          const lines = buf.split("\\n");
          buf = lines.pop() || "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try { requests.push(JSON.parse(line)); } catch {}
          }
          if (requests.length === 2) {
            const [a, b] = requests;
            // Oversized envelope for A on a single line (cap will reject
            // via the per-line check #2).
            const big = "x".repeat(4096);
            process.stdout.write(
              JSON.stringify({ jsonrpc: "2.0", id: a.id, result: { content: [{ type: "text", text: big }] } }) + "\\n"
            );
            // Then a small valid response for B.
            setImmediate(() => {
              process.stdout.write(
                JSON.stringify({ jsonrpc: "2.0", id: b.id, result: { ok: "B" } }) + "\\n"
              );
            });
          }
        });
        `,
      ],
    };
    const bridge = createStdioBridge([def], { maxResponseBytes: 512 });
    try {
      const callA = bridge.call("fifo", "tools/call", { who: "A" });
      const callB = bridge.call("fifo", "tools/call", { who: "B" });
      // A (oldest pending) is the one rejected by the cap.
      await expect(callA).rejects.toBeInstanceOf(ResponseSizeExceededError);
      // B stays in flight and resolves with the second valid response.
      await expect(callB).resolves.toEqual({ ok: "B" });
    } finally {
      await bridge.shutdown();
    }
  }, 10000);

  // C1: when a single chunk carries BOTH a complete valid line AND an
  // oversized trailing partial, the bridge MUST deliver the complete line
  // to its caller before tripping the mid-flight cap. Pre-fix code returned
  // immediately on cap-trip without iterating the complete-lines array,
  // so the innocent caller timed out at 30s.
  it("delivers complete sibling lines that arrive in the same chunk as an oversized partial", async () => {
    // Server holds both requests, then emits one chunk shaped like:
    //   "<small valid for B>\n<oversized partial for A, no newline>"
    // The bridge should: resolve B, then reject A via the mid-flight check.
    // The script keeps stdin open by never explicitly ending — the parent
    // bridge will close stdin during shutdown, at which point the child
    // exits cleanly.
    const def: McpServerDef = {
      name: "sibling",
      command: "node",
      args: [
        "-e",
        `
        process.on("uncaughtException", (e) => {
          process.stderr.write("uncaught: " + e.stack + "\\n");
          process.exit(2);
        });
        const requests = [];
        let written = false;
        process.stdin.setEncoding("utf8");
        let buf = "";
        process.stdin.on("data", (chunk) => {
          buf += chunk;
          const lines = buf.split("\\n");
          buf = lines.pop() || "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try { requests.push(JSON.parse(line)); } catch {}
          }
          if (requests.length >= 2 && !written) {
            written = true;
            // A was issued first (oldest pending), B second.
            const b = requests[1];
            // Single write with both payloads concatenated:
            //   <valid envelope for B>\\n<huge filler with no newline>
            const validB =
              JSON.stringify({ jsonrpc: "2.0", id: b.id, result: { ok: "B" } }) + "\\n";
            const huge = "x".repeat(2048); // > 512-byte cap, no newline
            process.stdout.write(validB + huge);
          }
        });
        process.stdin.on("end", () => process.exit(0));
        `,
      ],
    };
    const bridge = createStdioBridge([def], { maxResponseBytes: 512 });
    try {
      const callA = bridge.call("sibling", "tools/call", { who: "A" });
      const callB = bridge.call("sibling", "tools/call", { who: "B" });
      // B's complete line was processed first → B resolves.
      // Then the oversized trailing partial trips the mid-flight cap → A rejects.
      await expect(callB).resolves.toEqual({ ok: "B" });
      await expect(callA).rejects.toBeInstanceOf(ResponseSizeExceededError);
    } finally {
      await bridge.shutdown();
    }
  }, 10000);

  // I1: when an oversized line arrives chunked across multiple data events,
  // we must reject AT MOST ONE pending call. Without the
  // discardingUntilNewline guard, chunk 1 trips check #1 (rejects A, clears
  // buffer), then chunk 2/3 land carrying "<orphan tail>\n<small valid>\n"
  // — the orphan-tail line would re-trip check #2 and reject B (innocent).
  it("orphan tail of an oversized chunked line does not double-reject pending calls", async () => {
    // 3 × 256-byte chunks = 768 bytes, cap = 512. Chunk 2 trips the
    // mid-flight check — A should be rejected, then bytes are discarded
    // until the next "\n", which arrives at the end of the small valid
    // envelope for B. B should resolve cleanly.
    const bridge = createStdioBridge(
      [makeChunkedThenSiblingServer("orphan", 256)],
      { maxResponseBytes: 512 }
    );
    try {
      const callA = bridge.call("orphan", "tools/call", { who: "A" });
      const callB = bridge.call("orphan", "tools/call", { who: "B" });
      await expect(callA).rejects.toBeInstanceOf(ResponseSizeExceededError);
      await expect(callB).resolves.toEqual({ ok: "second" });
    } finally {
      await bridge.shutdown();
    }
  }, 10000);
});
