import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Integration tests for the .mjs sweep script. Invoked via the same tsx
// wrapper used by `npm run sweep-improvements` so transpilation matches prod.
const REPO_ROOT = resolve(__dirname, "..", "..");
const SCRIPT = "scripts/sweep-improvements.mjs";

function runSweep(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync("npx", ["tsx", SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
}

let tmpRoot: string;
let outDir: string;
let emptySkillsDir: string;
let emptySessionDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "sweep-err-"));
  outDir = join(tmpRoot, "improvements");
  // Both are nonexistent on purpose — phase 2 then exits early via the
  // "no vendored skills found" branch, which keeps the test deterministic
  // (no dependency on host ~/.claude/projects state).
  emptySkillsDir = join(tmpRoot, "skills");
  emptySessionDir = join(tmpRoot, "sessions");
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("sweep-improvements error handling (#64)", () => {
  it("exits non-zero when the audit phase throws on a missing --input file", () => {
    const missingInput = join(tmpRoot, "does-not-exist.ndjson");
    const result = runSweep([
      "--input", missingInput,
      "--dir", outDir,
      "--skills-dir", emptySkillsDir,
      "--session-log-dir", emptySessionDir,
    ]);

    expect(result.status).not.toBe(0);
  });

  it("logs the audit failure with structured context (code + name + message), not just err.message", () => {
    const missingInput = join(tmpRoot, "does-not-exist.ndjson");
    const result = runSweep([
      "--input", missingInput,
      "--dir", outDir,
      "--skills-dir", emptySkillsDir,
      "--session-log-dir", emptySessionDir,
    ]);

    const combined = result.stderr + result.stdout;
    expect(combined).toContain("[sweep:audit]");
    expect(combined).toContain("ENOENT");
  });

  it("still runs phase 2 after phase 1 fails (one-bad-phase invariant preserved)", () => {
    const missingInput = join(tmpRoot, "does-not-exist.ndjson");
    const result = runSweep([
      "--input", missingInput,
      "--dir", outDir,
      "--skills-dir", emptySkillsDir,
      "--session-log-dir", emptySessionDir,
    ]);

    // Phase 2 emits a [sweep:skill] line even when skills dir is empty
    // ("no vendored skills found … — skipping skill-metrics phase"). That
    // line is the evidence that phase 2 ran despite phase 1 throwing.
    expect(result.stdout).toContain("[sweep:skill]");
  });

  it("exits 0 when both phases are skipped (no false-positive non-zero exit)", () => {
    const result = runSweep([
      "--skip-audit",
      "--skip-skill-metrics",
      "--dir", outDir,
    ]);
    expect(result.status).toBe(0);
  });
});
