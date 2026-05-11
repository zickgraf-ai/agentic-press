#!/usr/bin/env -S npx tsx
/**
 * Self-improvement sweep — issue #20 + #55.
 *
 * NOTE: shebang uses `npx tsx` because this script imports .ts modules
 * directly. Run via `npm run sweep-improvements` (recommended) or
 * `npx tsx scripts/sweep-improvements.mjs` (also works).
 *
 * Two phases:
 *  1. Audit: reads NDJSON audit log lines from a file (or piped stdin),
 *     analyzes them for tool-related patterns (allowlist drift, tool
 *     failures), writes Suggestions to `.improvements/`.
 *  2. Skill metrics: reads Claude Code session transcripts under
 *     `~/.claude/projects/<encoded-cwd>/`, computes per-skill usage
 *     metrics for the vendored skills, writes a regenerated dashboard
 *     `.improvements/metrics/skill-usage-YYYY-MM-DD.md`, and writes
 *     anti-signal Suggestions for never-used or high-abandonment skills.
 *
 * The two phases are isolated in try/catch — one failing does not block
 * the other.
 *
 * Usage:
 *   ./scripts/sweep-improvements.mjs [--input <audit.ndjson>] [--dir <improvements-dir>]
 *                                    [--max <N>] [--skip-audit] [--skip-skill-metrics]
 *                                    [--session-log-dir <path>] [--skills-dir <path>]
 *                                    [--lookback-days <N>]
 *   cat audit.ndjson | ./scripts/sweep-improvements.mjs
 *
 * Defaults:
 *   --input             stdin (skipped if no --input AND stdin is a TTY)
 *   --dir               .improvements
 *   --max               3   (hard cap on Suggestions written per run)
 *   --session-log-dir   auto (resolved from process.cwd() encoding)
 *   --skills-dir        .claude/skills
 *   --lookback-days     30
 *
 * Security: this script writes files to the repo. It does not commit, push,
 * or modify any other files. Output is reviewed by the human before any
 * effect propagates further.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Imported as .ts — requires tsx (see shebang and the npm script wrapper).
const { detectImprovements, detectSkillUsageImprovements } = await import(
  "../src/improvements/detector.ts"
);
const { writeSuggestion, isDuplicate, generateSuggestionId } = await import(
  "../src/improvements/writer.ts"
);
const { collectInvocations, findSessionLogDir } = await import(
  "../src/improvements/skill-transcript.ts"
);
const { readVendoredSkills, computeMetrics, renderReport, reportFileName } = await import(
  "../src/improvements/skill-usage-report.ts"
);

const args = process.argv.slice(2);
const opts = {
  input: argValue("--input"),
  dir: argValue("--dir") ?? ".improvements",
  max: parseInt(argValue("--max") ?? "3", 10),
  skipAudit: argFlag("--skip-audit"),
  skipSkillMetrics: argFlag("--skip-skill-metrics"),
  sessionLogDir: argValue("--session-log-dir"),
  skillsDir: argValue("--skills-dir") ?? ".claude/skills",
  lookbackDays: parseInt(argValue("--lookback-days") ?? "30", 10),
};

function argValue(name) {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function argFlag(name) {
  return args.includes(name);
}

const dir = resolve(opts.dir);
const now = new Date();

let auditWritten = 0;
let auditSkipped = 0;
let skillMetricsWritten = 0;
let skillMetricsSkipped = 0;
// Phase-failure escalation: each phase catches its own exceptions so one
// bad phase does not block the other, but any phase failure escalates to
// a non-zero process exit code at the bottom of the script so launchd /
// CI gates can detect it. Each catch must (1) set its *Failed flag and
// (2) call logPhaseFailure to emit a structured stderr line.
let auditFailed = false;
let skillMetricsFailed = false;

/**
 * Emit `[sweep:<phase>] FAILED (<name> <code>): <message>` plus stack
 * (when present) to stderr. Mirrors the catch-narrowing convention in
 * `src/improvements/skill-usage-report.ts:warnSkipped`.
 */
function logPhaseFailure(phase, err) {
  const code = err?.code ?? "UNKNOWN";
  const name = err?.name ?? "Error";
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[sweep:${phase}] FAILED (${name} ${code}): ${message}`);
  if (err?.stack) console.error(err.stack);
}

// ---- Phase 1: Audit ----
if (!opts.skipAudit) {
  const stdinIsTTY = process.stdin.isTTY;
  if (!opts.input && stdinIsTTY) {
    console.log("[sweep] no --input and stdin is a TTY — skipping audit phase. Use --input <file> to enable.");
  } else {
    try {
      const text = opts.input ? readFileSync(resolve(opts.input), "utf8") : readFileSync(0, "utf8");
      const entries = parseEntries(text);
      console.log(`[sweep:audit] read ${entries.length} audit entries`);
      const suggestions = detectImprovements(entries);
      console.log(`[sweep:audit] detected ${suggestions.length} candidate suggestions`);
      for (const s of suggestions) {
        if (auditWritten >= opts.max) {
          console.log(`[sweep:audit] reached --max=${opts.max} cap, stopping`);
          break;
        }
        const id = generateSuggestionId(s, now);
        if (isDuplicate(dir, id)) {
          auditSkipped++;
          continue;
        }
        writeSuggestion(dir, s, now);
        console.log(`[sweep:audit] wrote ${id}.md  (${s.category}, ${s.confidence})`);
        auditWritten++;
      }
    } catch (err) {
      auditFailed = true;
      logPhaseFailure("audit", err);
    }
  }
}

// ---- Phase 2: Skill metrics ----
if (!opts.skipSkillMetrics) {
  try {
    const sessionLogDir = opts.sessionLogDir ?? findSessionLogDir(process.cwd());
    const skillsDir = resolve(opts.skillsDir);
    const lookbackMs = opts.lookbackDays * 24 * 60 * 60 * 1000;
    const windowStart = new Date(now.getTime() - lookbackMs).toISOString();
    const windowEnd = now.toISOString();

    let skippedSkillsCount = 0;
    const skills = readVendoredSkills(skillsDir, {
      onSkip: () => {
        skippedSkillsCount++;
      },
    });
    if (skills.length === 0) {
      console.log(`[sweep:skill] no vendored skills found in ${skillsDir} — skipping skill-metrics phase`);
    } else {
      const { invocations, parseStats } = collectInvocations(sessionLogDir, windowStart);

      // Write the always-regenerated dashboard.
      const metrics = computeMetrics(
        invocations,
        skills,
        windowStart,
        windowEnd,
        now,
        parseStats,
        skippedSkillsCount
      );
      const metricsDir = join(dir, "metrics");
      if (!existsSync(metricsDir)) mkdirSync(metricsDir, { recursive: true });
      const reportPath = join(metricsDir, reportFileName(now));
      writeFileSync(reportPath, renderReport(metrics), "utf8");
      console.log(`[sweep:skill] wrote ${reportPath}`);
      console.log(
        `[sweep:skill] ${skills.length} vendored skills | trial: ${metrics.trialInvocations} invocations / ${metrics.trialSessionsUsedIn} sessions | total Skill activity in window: ${metrics.totalInvocations} / ${metrics.totalSessionsWithSkillActivity}`
      );
      console.log(
        `[sweep:skill] parsed ${parseStats.filesScanned} files, ${parseStats.totalLines} lines, ${parseStats.malformedLines} malformed`
      );
      if (skippedSkillsCount > 0) {
        // Echo the skip count to stdout so a casual sweep log scan flags it
        // alongside the markdown header (#66). The per-skill detail is already
        // in the [readVendoredSkills] warn lines higher in the same log.
        console.log(`[sweep:skill] ${skippedSkillsCount} skill(s) skipped due to fs errors — see warnings above`);
      }

      // Run anti-signal detector.
      const skillSuggestions = detectSkillUsageImprovements(invocations, skills, { now });
      console.log(`[sweep:skill] detected ${skillSuggestions.length} candidate suggestions`);
      for (const s of skillSuggestions) {
        if (skillMetricsWritten + auditWritten >= opts.max) {
          console.log(`[sweep:skill] reached --max=${opts.max} cap (combined with audit), stopping`);
          break;
        }
        const id = generateSuggestionId(s, now);
        if (isDuplicate(dir, id)) {
          skillMetricsSkipped++;
          continue;
        }
        writeSuggestion(dir, s, now);
        console.log(`[sweep:skill] wrote ${id}.md  (${s.category}, ${s.confidence})`);
        skillMetricsWritten++;
      }
    }
  } catch (err) {
    skillMetricsFailed = true;
    logPhaseFailure("skill", err);
  }
}

console.log(
  `[sweep] done — audit: wrote ${auditWritten}, skipped ${auditSkipped} | skill: wrote ${skillMetricsWritten}, skipped ${skillMetricsSkipped}`
);

if (auditFailed || skillMetricsFailed) {
  // process.exitCode (not process.exit) so the event loop drains stdio
  // cleanly. Both phases have already run; this only escalates the code.
  process.exitCode = 1;
}

function parseEntries(text) {
  const entries = [];
  let malformedCount = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // pino diagnostics may interleave with audit entries on the same
      // stdout stream — those are expected to fail JSON parse and we skip
      // them. We still count them so we can warn if EVERY line is bad
      // (likely a corrupt file or wrong input).
      malformedCount++;
    }
  }
  if (entries.length === 0 && malformedCount > 0) {
    console.warn(
      `[sweep] WARNING: input contained ${malformedCount} non-JSON lines and 0 parseable entries. ` +
        `Did you pipe in the audit stream, or a different file?`
    );
  } else if (malformedCount > entries.length) {
    console.warn(
      `[sweep] note: ${malformedCount} non-JSON lines skipped (vs ${entries.length} JSON entries) — ` +
        `usually pino diagnostics interleaved with audit; verify if unexpected`
    );
  }
  // Filter to actual audit entries (have status + tool fields)
  return entries.filter((e) => e && typeof e === "object" && "status" in e && "tool" in e);
}
