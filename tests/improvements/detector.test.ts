import { describe, it, expect } from "vitest";
import { detectImprovements } from "../../src/improvements/detector.js";
import type { AuditEntry } from "../../src/mcp-proxy/logger.js";

function entry(overrides: Partial<AuditEntry>): AuditEntry {
  return {
    timestamp: "2026-04-26T18:00:00.000Z",
    tool: "Read",
    args: {},
    status: "allowed",
    flags: [],
    durationMs: 10,
    direction: "request",
    ...overrides,
  };
}

describe("detector — A1 allowlist drift", () => {
  it("does not fire below the threshold", () => {
    const entries: AuditEntry[] = [
      entry({ tool: "Execute", status: "blocked" }),
      entry({ tool: "Execute", status: "blocked" }),
    ];
    const out = detectImprovements(entries, { allowlistDriftThreshold: 3 });
    expect(out.filter((s) => s.category === "allowlist-drift")).toHaveLength(0);
  });

  it("fires when the same tool is blocked at or above threshold", () => {
    const entries: AuditEntry[] = Array.from({ length: 5 }, () =>
      entry({ tool: "Execute", status: "blocked" })
    );
    const out = detectImprovements(entries, { allowlistDriftThreshold: 3 });
    const drift = out.filter((s) => s.category === "allowlist-drift");
    expect(drift).toHaveLength(1);
    expect(drift[0]!.evidence.tool).toBe("Execute");
    expect(drift[0]!.evidence.count).toBeGreaterThanOrEqual(5);
  });

  it("fires per-tool, not aggregated", () => {
    const entries: AuditEntry[] = [
      ...Array.from({ length: 3 }, () => entry({ tool: "Execute", status: "blocked" })),
      ...Array.from({ length: 3 }, () => entry({ tool: "Delete", status: "blocked" })),
    ];
    const out = detectImprovements(entries, { allowlistDriftThreshold: 3 });
    const drift = out.filter((s) => s.category === "allowlist-drift");
    expect(drift).toHaveLength(2);
    const tools = drift.map((s) => s.evidence.tool).sort();
    expect(tools).toEqual(["Delete", "Execute"]);
  });

  it("ignores _blocked sentinel (cardinality-defense placeholder, not a real tool)", () => {
    const entries: AuditEntry[] = Array.from({ length: 5 }, () =>
      entry({ tool: "_blocked", status: "blocked" })
    );
    const out = detectImprovements(entries, { allowlistDriftThreshold: 3 });
    expect(out.filter((s) => s.category === "allowlist-drift")).toHaveLength(0);
  });

  it("evidence carries first-seen and last-seen timestamps from the entries", () => {
    const entries: AuditEntry[] = [
      entry({ tool: "Execute", status: "blocked", timestamp: "2026-04-20T00:00:00.000Z" }),
      entry({ tool: "Execute", status: "blocked", timestamp: "2026-04-22T00:00:00.000Z" }),
      entry({ tool: "Execute", status: "blocked", timestamp: "2026-04-26T00:00:00.000Z" }),
    ];
    const out = detectImprovements(entries, { allowlistDriftThreshold: 3 });
    const drift = out.find((s) => s.category === "allowlist-drift")!;
    expect(drift.evidence.firstSeen).toBe("2026-04-20T00:00:00.000Z");
    expect(drift.evidence.lastSeen).toBe("2026-04-26T00:00:00.000Z");
  });
});

describe("detector — A3 tool failure pattern", () => {
  it("fires when a tool returns error status at or above threshold", () => {
    const entries: AuditEntry[] = Array.from({ length: 4 }, () =>
      entry({
        tool: "fs__write_file",
        status: "error",
        direction: "response",
        errorMessage: "EACCES: permission denied",
      })
    );
    const out = detectImprovements(entries, { toolFailureThreshold: 3 });
    const failures = out.filter((s) => s.category === "tool-failure");
    expect(failures).toHaveLength(1);
    expect(failures[0]!.evidence.tool).toBe("fs__write_file");
    expect(failures[0]!.evidence.count).toBeGreaterThanOrEqual(4);
  });

  it("does not fire below threshold", () => {
    const entries: AuditEntry[] = [
      entry({ tool: "fs__write_file", status: "error", errorMessage: "x" }),
      entry({ tool: "fs__write_file", status: "error", errorMessage: "x" }),
    ];
    const out = detectImprovements(entries, { toolFailureThreshold: 3 });
    expect(out.filter((s) => s.category === "tool-failure")).toHaveLength(0);
  });

  it("ignores blocked entries (those are A1, not A3)", () => {
    const entries: AuditEntry[] = Array.from({ length: 5 }, () =>
      entry({ tool: "Execute", status: "blocked" })
    );
    const out = detectImprovements(entries, { toolFailureThreshold: 3 });
    expect(out.filter((s) => s.category === "tool-failure")).toHaveLength(0);
  });

  it("captures sample error messages in evidence", () => {
    const entries: AuditEntry[] = [
      entry({ tool: "fs__write", status: "error", errorMessage: "EACCES: /a" }),
      entry({ tool: "fs__write", status: "error", errorMessage: "EACCES: /b" }),
      entry({ tool: "fs__write", status: "error", errorMessage: "EACCES: /c" }),
    ];
    const out = detectImprovements(entries, { toolFailureThreshold: 3 });
    const failure = out.find((s) => s.category === "tool-failure")!;
    expect(failure.evidence.sampleErrors).toBeDefined();
    expect(failure.evidence.sampleErrors!.length).toBeGreaterThan(0);
    expect(failure.evidence.sampleErrors![0]).toContain("EACCES");
  });
});

describe("detector — confidence levels", () => {
  it("medium confidence at 1x to 2x threshold", () => {
    const entries: AuditEntry[] = Array.from({ length: 4 }, () =>
      entry({ tool: "X", status: "blocked" })
    );
    const out = detectImprovements(entries, { allowlistDriftThreshold: 3 });
    expect(out[0]!.confidence).toBe("medium");
  });

  it("high confidence at >= 2x threshold", () => {
    const entries: AuditEntry[] = Array.from({ length: 6 }, () =>
      entry({ tool: "X", status: "blocked" })
    );
    const out = detectImprovements(entries, { allowlistDriftThreshold: 3 });
    expect(out[0]!.confidence).toBe("high");
  });

  it("tool-failure also escalates to high at >= 2x threshold", () => {
    const entries: AuditEntry[] = Array.from({ length: 6 }, () =>
      entry({ tool: "Y", status: "error", errorMessage: "boom" })
    );
    const out = detectImprovements(entries, { toolFailureThreshold: 3 });
    expect(out[0]!.confidence).toBe("high");
  });
});

describe("detector — sampleErrors dedup and cap", () => {
  it("dedupes duplicate error messages", () => {
    const entries: AuditEntry[] = Array.from({ length: 5 }, () =>
      entry({ tool: "Z", status: "error", errorMessage: "EACCES denied" })
    );
    const out = detectImprovements(entries, { toolFailureThreshold: 3 });
    expect(out[0]!.evidence.sampleErrors).toEqual(["EACCES denied"]);
  });

  it("caps sampleErrors at 3 even with more distinct messages", () => {
    const entries: AuditEntry[] = [
      entry({ tool: "Z", status: "error", errorMessage: "err 1" }),
      entry({ tool: "Z", status: "error", errorMessage: "err 2" }),
      entry({ tool: "Z", status: "error", errorMessage: "err 3" }),
      entry({ tool: "Z", status: "error", errorMessage: "err 4" }),
      entry({ tool: "Z", status: "error", errorMessage: "err 5" }),
    ];
    const out = detectImprovements(entries, { toolFailureThreshold: 3 });
    expect(out[0]!.evidence.sampleErrors).toHaveLength(3);
  });

  it("filters out missing errorMessage entries from samples", () => {
    const entries: AuditEntry[] = [
      entry({ tool: "Z", status: "error", errorMessage: "real error" }),
      entry({ tool: "Z", status: "error" }), // no errorMessage
      entry({ tool: "Z", status: "error", errorMessage: "another error" }),
    ];
    const out = detectImprovements(entries, { toolFailureThreshold: 3 });
    expect(out[0]!.evidence.sampleErrors).toEqual(["real error", "another error"]);
  });
});

describe("detector — defaults", () => {
  it("uses sensible defaults when no thresholds passed", () => {
    // Default thresholds should require enough evidence that one-off issues
    // don't trigger noise. Spec: defaults must be >= 3.
    const entries: AuditEntry[] = [
      entry({ tool: "X", status: "blocked" }),
      entry({ tool: "X", status: "blocked" }),
    ];
    const out = detectImprovements(entries);
    expect(out).toHaveLength(0);
  });
});

describe("detector — empty input", () => {
  it("returns empty array on empty input", () => {
    expect(detectImprovements([])).toEqual([]);
  });
});
