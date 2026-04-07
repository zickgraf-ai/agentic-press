import { describe, it, expect, vi, beforeEach } from "vitest";
import { logAuditEntry, type AuditEntry } from "../src/mcp-proxy/logger.js";

describe("audit logger", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("writes JSON to stdout", () => {
    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    const entry: AuditEntry = {
      timestamp: "2026-04-05T20:00:00.000Z",
      tool: "Read",
      args: { path: "/workspace/file.ts" },
      status: "allowed",
      flags: [],
      durationMs: 42,
    };

    logAuditEntry(entry);

    expect(spy).toHaveBeenCalledOnce();
    const output = spy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.tool).toBe("Read");
    expect(parsed.status).toBe("allowed");
    expect(parsed.durationMs).toBe(42);
    expect(parsed.timestamp).toBe("2026-04-05T20:00:00.000Z");
  });

  it("includes flags when present", () => {
    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    const entry: AuditEntry = {
      timestamp: "2026-04-05T20:00:00.000Z",
      tool: "Read",
      args: {},
      status: "flagged",
      flags: [{ pattern: "zero_width_chars", match: "\u200B", position: 5 }],
    };

    logAuditEntry(entry);

    const output = spy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.status).toBe("flagged");
    expect(parsed.flags).toHaveLength(1);
    expect(parsed.flags[0].pattern).toBe("zero_width_chars");
  });

  it("round-trips the optional errorMessage field", () => {
    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    const entry: AuditEntry = {
      timestamp: "2026-04-05T20:00:00.000Z",
      tool: "Read",
      args: { path: "./x.ts" },
      status: "error",
      flags: [],
      durationMs: 7,
      errorMessage: "bridge connection refused",
    };

    logAuditEntry(entry);

    const output = spy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.status).toBe("error");
    expect(parsed.errorMessage).toBe("bridge connection refused");
  });

  it("omits errorMessage when not provided (entries stay lean)", () => {
    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    logAuditEntry({
      timestamp: "2026-04-05T20:00:00.000Z",
      tool: "Read",
      args: {},
      status: "allowed",
      flags: [],
    });

    const output = spy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect("errorMessage" in parsed).toBe(false);
  });

  it("outputs newline-delimited JSON (one line per entry)", () => {
    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    logAuditEntry({
      timestamp: new Date().toISOString(),
      tool: "Grep",
      args: {},
      status: "allowed",
      flags: [],
    });

    const output = spy.mock.calls[0][0] as string;
    expect(output.endsWith("\n")).toBe(true);
    expect(output.split("\n").filter(Boolean)).toHaveLength(1);
  });
});
