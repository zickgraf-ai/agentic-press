import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  logAuditEntry,
  configureAuditLog,
  closeAuditLog,
  type AuditEntry,
} from "../src/mcp-proxy/logger.js";

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

describe("audit logger — file destination (AUDIT_LOG_FILE)", () => {
  let tmpDir: string;
  let logFile: string;

  function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
    return {
      timestamp: "2026-04-28T01:00:00.000Z",
      tool: "Read",
      args: {},
      status: "allowed",
      flags: [],
      durationMs: 1,
      ...overrides,
    };
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "audit-test-"));
    logFile = join(tmpDir, "audit.ndjson");
  });

  afterEach(() => {
    closeAuditLog();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("writes audit entries to the configured file (not stdout)", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    configureAuditLog({ filePath: logFile });
    logAuditEntry(entry({ tool: "ToolA" }));
    logAuditEntry(entry({ tool: "ToolB" }));

    expect(stdoutSpy).not.toHaveBeenCalled();
    const lines = readFileSync(logFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).tool).toBe("ToolA");
    expect(JSON.parse(lines[1]!).tool).toBe("ToolB");
  });

  it("uses synchronous writes — entries are visible to other readers immediately", () => {
    // The whole point of AUDIT_LOG_FILE: no stream buffering, no pino
    // interleave, no Ctrl+C race. Each writeSync hits disk before
    // logAuditEntry returns.
    configureAuditLog({ filePath: logFile });
    logAuditEntry(entry({ tool: "Synchronous" }));
    // Read immediately, no setTimeout / flush / process exit needed
    const content = readFileSync(logFile, "utf8");
    expect(content).toContain('"tool":"Synchronous"');
  });

  it("appends to an existing file (preserves prior session entries)", () => {
    // Pre-populate the file with one line, then configure and write more.
    // Audit logs are append-only — operators may concatenate sessions.
    writeFileSync(logFile, '{"timestamp":"2026-04-27T00:00:00Z","tool":"Old","args":{},"status":"allowed","flags":[]}\n');
    configureAuditLog({ filePath: logFile });
    logAuditEntry(entry({ tool: "New" }));
    closeAuditLog();

    const lines = readFileSync(logFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).tool).toBe("Old");
    expect(JSON.parse(lines[1]!).tool).toBe("New");
  });

  it("closeAuditLog reverts to stdout for subsequent entries", () => {
    configureAuditLog({ filePath: logFile });
    logAuditEntry(entry({ tool: "ToFile" }));
    closeAuditLog();

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    logAuditEntry(entry({ tool: "ToStdout" }));

    expect(stdoutSpy).toHaveBeenCalledOnce();
    const fileContent = readFileSync(logFile, "utf8");
    expect(fileContent).toContain('"tool":"ToFile"');
    expect(fileContent).not.toContain('"tool":"ToStdout"');
  });

  it("calling configureAuditLog twice closes the previous fd cleanly", () => {
    const logFile2 = join(tmpDir, "audit2.ndjson");
    configureAuditLog({ filePath: logFile });
    logAuditEntry(entry({ tool: "First" }));
    configureAuditLog({ filePath: logFile2 });
    logAuditEntry(entry({ tool: "Second" }));

    expect(readFileSync(logFile, "utf8")).toContain('"tool":"First"');
    expect(readFileSync(logFile, "utf8")).not.toContain('"tool":"Second"');
    expect(readFileSync(logFile2, "utf8")).toContain('"tool":"Second"');
  });

  it("configureAuditLog with no filePath reverts to stdout (and closes any open fd)", () => {
    configureAuditLog({ filePath: logFile });
    logAuditEntry(entry({ tool: "ToFile" }));
    configureAuditLog({}); // no filePath

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    logAuditEntry(entry({ tool: "ToStdout" }));

    expect(stdoutSpy).toHaveBeenCalledOnce();
  });

  it("falls back to stdout if file open fails (operability over correctness)", () => {
    // An unwritable path shouldn't kill the proxy — audit-log destination
    // failure must never break the request path. Fall back to stdout with a
    // console.warn (equivalent to other observability fallback paths).
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const result = configureAuditLog({ filePath: "/this/path/definitely/does/not/exist/audit.ndjson" });
    logAuditEntry(entry({ tool: "Fallback" }));

    expect(result).toBe(false); // signals fallback so caller doesn't lie in logs
    expect(warnSpy).toHaveBeenCalled();
    expect(stdoutSpy).toHaveBeenCalledOnce();
  });

  it("returns true when file destination is successfully active", () => {
    expect(configureAuditLog({ filePath: logFile })).toBe(true);
  });

  it("returns false when no filePath provided (stdout default)", () => {
    expect(configureAuditLog({})).toBe(false);
  });

});
