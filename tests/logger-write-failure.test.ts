import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Tests for the writeSync-failure fallback path in logAuditEntry.
 *
 * Isolated to its own file because mocking `node:fs` via `vi.mock` is
 * module-wide — we don't want it leaking into the rest of the logger
 * tests, which depend on real filesystem behavior. The hoisted spy lets
 * us simulate ENOSPC / ESTALE / EBADF runtime failures cleanly.
 */

const { writeSyncSpy, openSyncSpy, closeSyncSpy } = vi.hoisted(() => {
  return {
    writeSyncSpy: vi.fn(),
    openSyncSpy: vi.fn(),
    closeSyncSpy: vi.fn(),
  };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    writeSync: writeSyncSpy,
    openSync: openSyncSpy,
    closeSync: closeSyncSpy,
  };
});

import {
  logAuditEntry,
  configureAuditLog,
  closeAuditLog,
  type AuditEntry,
} from "../src/mcp-proxy/logger.js";

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

describe("audit logger — writeSync runtime failure (ENOSPC/ESTALE/EBADF)", () => {
  let tmpDir: string;
  let logFile: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "audit-fail-"));
    logFile = join(tmpDir, "audit.ndjson");
    // Open returns a deterministic fd (3 — first non-stdio fd).
    openSyncSpy.mockReturnValue(3);
    closeSyncSpy.mockImplementation(() => {});
    writeSyncSpy.mockReset();
  });

  afterEach(() => {
    closeAuditLog();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("falls back to stdout if writeSync throws (request path must not crash)", () => {
    writeSyncSpy.mockImplementation(() => {
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    configureAuditLog({ filePath: logFile });
    expect(() => logAuditEntry(entry({ tool: "WriteFails" }))).not.toThrow();

    // The entry must still reach SOMEWHERE — stdout is the fallback. It's
    // written by stdoutSpy (1) AND nothing else.
    expect(stdoutSpy).toHaveBeenCalled();
    const written = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(written).toContain('"tool":"WriteFails"');
    expect(warnSpy).toHaveBeenCalled();
  });

  it("warns ONCE per fd lifetime, not once per failed write", () => {
    writeSyncSpy.mockImplementation(() => {
      throw new Error("ENOSPC");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockReturnValue(true);

    configureAuditLog({ filePath: logFile });
    logAuditEntry(entry({ tool: "A" }));
    logAuditEntry(entry({ tool: "B" }));
    logAuditEntry(entry({ tool: "C" }));

    // After the first failure the fd is closed and revertedto stdout, so
    // subsequent writeSync isn't called at all. The warn count should be 1.
    // (Plus possibly the closeSync warning if that errored — but closeSync
    // was mocked to succeed, so it shouldn't.)
    const writeFailureWarnings = warnSpy.mock.calls.filter((c) =>
      typeof c[0] === "string" && c[0].includes("writeSync failed")
    );
    expect(writeFailureWarnings).toHaveLength(1);
  });

  it("closes the stale fd when writeSync fails (no fd leak)", () => {
    writeSyncSpy.mockImplementation(() => {
      throw new Error("EBADF");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockReturnValue(true);

    configureAuditLog({ filePath: logFile });
    logAuditEntry(entry({ tool: "X" }));

    expect(closeSyncSpy).toHaveBeenCalledWith(3);
  });

  it("subsequent entries after writeSync failure go straight to stdout (no further fd attempts)", () => {
    let failOnce = true;
    writeSyncSpy.mockImplementation(() => {
      if (failOnce) {
        failOnce = false;
        throw new Error("ENOSPC");
      }
      // The fd should be closed after the first failure — if writeSync
      // gets called again, the test will see this no-op succeed and we'd
      // miss the regression. But the assertion below catches the leak.
      return 42;
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    configureAuditLog({ filePath: logFile });
    logAuditEntry(entry({ tool: "First" }));   // fails, falls back to stdout
    logAuditEntry(entry({ tool: "Second" }));  // straight to stdout

    // writeSync should only have been called once (the failing call).
    // If the second call hit writeSync, the fd wasn't closed properly.
    expect(writeSyncSpy).toHaveBeenCalledTimes(1);
    expect(stdoutSpy).toHaveBeenCalledTimes(2);
  });
});
