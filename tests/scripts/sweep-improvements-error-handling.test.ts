import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..");
const SCRIPT = "scripts/sweep-improvements.mjs";

function runSweep(args: string[]): ReturnType<typeof spawnSync> {
  // Invoked via `npx tsx` so transpilation matches `npm run sweep-improvements`.
  const result = spawnSync("npx", ["tsx", SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  // Surface OS-level launcher failures (PATH issue, sandbox restriction,
  // tsx network pull) as a loud throw instead of `result.status === null`
  // silently satisfying `expect(...).not.toBe(0)`.
  if (result.error) throw result.error;
  if (result.status === null) {
    throw new Error(
      `spawnSync returned null status (signal=${result.signal}); stderr was: ${result.stderr}`
    );
  }
  return result;
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

  it("logs the audit failure in the structured `FAILED (<name> <code>): <message>` shape", () => {
    const missingInput = join(tmpRoot, "does-not-exist.ndjson");
    const result = runSweep([
      "--input", missingInput,
      "--dir", outDir,
      "--skills-dir", emptySkillsDir,
      "--session-log-dir", emptySessionDir,
    ]);

    const combined = result.stderr + result.stdout;
    // FAILED keyword + (name code) parens + colon + non-empty message —
    // pinning the full shape so a regression that drops the parens, the
    // FAILED keyword, or the message slips no further.
    expect(combined).toMatch(/\[sweep:audit\] FAILED \(\S+ ENOENT\): \S+/);
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

  it("exits non-zero and logs the structured failure when the skill-metrics phase throws", () => {
    // Trigger phase 2 to throw ENOTDIR: pass a populated skillsDir (so the
    // `if (skills.length === 0) skip` short-circuit doesn't fire) and a
    // --session-log-dir that points at a regular file rather than a dir,
    // so `collectInvocations`'s `readdirSync` throws ENOTDIR.
    const skillsRoot = join(tmpRoot, "skills");
    mkdirSync(join(skillsRoot, "trial-skill"), { recursive: true });
    writeFileSync(
      join(skillsRoot, "trial-skill", "SKILL.md"),
      "---\nname: trial-skill\n---\n\n## Provenance\n\nVendored.\n"
    );
    const sessionAsFile = join(tmpRoot, "not-a-dir.txt");
    writeFileSync(sessionAsFile, "not a directory\n");

    const result = runSweep([
      "--skip-audit",
      "--dir", outDir,
      "--skills-dir", skillsRoot,
      "--session-log-dir", sessionAsFile,
    ]);

    expect(result.status).not.toBe(0);
    const combined = result.stderr + result.stdout;
    expect(combined).toMatch(/\[sweep:skill\] FAILED \(\S+ ENOTDIR\): \S+/);
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
