/**
 * Skill-usage metrics report — issue #55.
 *
 * Always-regenerated markdown dashboard for the 3-week trial. Sits alongside
 * the anti-signal Suggestion pipeline (`detectSkillUsageImprovements`):
 * Suggestions surface actionable problems; this report shows the underlying
 * counts so the user can read the full picture week-over-week.
 *
 * Produced by the sweep script. Regenerated each run; the on-disk file is
 * the truth, no dedup logic.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  ClassifiedInvocation,
  VendoredSkill,
} from "./types.js";
import type { ParseStats } from "./skill-transcript.js";

/**
 * Canonical trial end date. Referenced by report templates and CLAUDE.md /
 * README narrative. Code only consumes this constant; non-TS files (plist,
 * install script) cite it as documentation rather than embedding a literal.
 */
export const TRIAL_END_DATE = "2026-05-30";

export interface PerSkillMetrics {
  readonly skillName: string;
  readonly skillAgeDays: number;
  readonly invocations: number;
  readonly completed: number;
  readonly abandoned: number;
  readonly unknown: number;
  readonly sessionsUsedIn: number;
  /** completed / (completed + abandoned), or 0 if denominator is 0. */
  readonly completionRate: number;
  readonly verdict: "KEEP" | "DROP" | "MEASURE" | "UNDECIDED";
}

export interface SkillUsageMetrics {
  readonly windowStart: string;
  readonly windowEnd: string;
  /** All `Skill` tool invocations observed in window (trial + non-trial). */
  readonly totalInvocations: number;
  /** Total invocations of vendored / trial skills (sum of all `perSkill[].invocations`). */
  readonly trialInvocations: number;
  /** Distinct sessions containing any `Skill` tool invocation. */
  readonly totalSessionsWithSkillActivity: number;
  /** Distinct sessions where at least one trial skill was invoked. */
  readonly trialSessionsUsedIn: number;
  readonly perSkill: readonly PerSkillMetrics[];
  /** Optional — surfaced from collectInvocations so the report flags transcript drift. */
  readonly parseStats?: ParseStats;
}

interface VerdictRule {
  /** Skill is exempt from KEEP/DROP — always reports MEASURE. */
  readonly measureOnly?: boolean;
  /** KEEP if invocations >= this. */
  readonly minInvocationsForKeep?: number;
  /** KEEP if distinct sessions used >= this. */
  readonly minSessionsForKeep?: number;
  /** KEEP requires completionRate at or above this. */
  readonly minCompletionRateForKeep?: number;
  /** DROP if invocations is strictly below this threshold AFTER grace period. */
  readonly dropBelowInvocations?: number;
  /** Days a skill must exist before DROP can fire. */
  readonly graceDays?: number;
}

const DEFAULT_GRACE_DAYS = 14;

/**
 * Per-skill verdict rules. Mirrors the trial framework documented in
 * `.improvements/README.md`. The `dropBelowInvocations` threshold is
 * read as "DROP if invocations < this AFTER the grace period" — uniform
 * 2 across all auto-dropping skills (matches the README's "<2" wording).
 *
 * If a vendored skill is not listed here, it falls through to UNDECIDED.
 */
const VERDICT_RULES: Record<string, VerdictRule> = {
  "systematic-debugging": {
    minSessionsForKeep: 3,
    minCompletionRateForKeep: 0.7,
    dropBelowInvocations: 2,
    graceDays: DEFAULT_GRACE_DAYS,
  },
  "brainstorming": {
    minSessionsForKeep: 2,
    minCompletionRateForKeep: 0.7,
    dropBelowInvocations: 2,
    graceDays: DEFAULT_GRACE_DAYS,
  },
  "verification-before-completion": {
    minInvocationsForKeep: 5,
    dropBelowInvocations: 2,
    graceDays: DEFAULT_GRACE_DAYS,
  },
  "writing-skills": {
    measureOnly: true,
  },
  "subagent-driven-development": {
    minSessionsForKeep: 2,
    minCompletionRateForKeep: 0.7,
    dropBelowInvocations: 2,
    graceDays: DEFAULT_GRACE_DAYS,
  },
};

const PROVENANCE_MARKER = "## Provenance";

/**
 * Scan `.claude/skills/` for vendored skills — those whose SKILL.md carries
 * the provenance footer marker. Project-authored skills (without the marker)
 * are excluded so the trial's metrics stay scoped to the cherry-picked set.
 */
export function readVendoredSkills(skillsDir: string): VendoredSkill[] {
  if (!existsSync(skillsDir)) return [];
  const out: VendoredSkill[] = [];
  for (const name of readdirSync(skillsDir)) {
    const skillDir = join(skillsDir, name);
    let isDir = false;
    try {
      isDir = statSync(skillDir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const skillMd = join(skillDir, "SKILL.md");
    if (!existsSync(skillMd)) continue;
    let content: string;
    let mtime: Date;
    try {
      content = readFileSync(skillMd, "utf8");
      mtime = statSync(skillMd).mtime;
    } catch {
      continue;
    }
    if (!content.includes(PROVENANCE_MARKER)) continue;
    out.push({ name, skillMdPath: skillMd, skillMdMtime: mtime });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function computeMetrics(
  invocations: readonly ClassifiedInvocation[],
  skills: readonly VendoredSkill[],
  windowStart: string,
  windowEnd: string,
  now: Date = new Date(),
  parseStats?: ParseStats
): SkillUsageMetrics {
  const trialSkillNames = new Set(skills.map((s) => s.name));
  const trialInvocationList = invocations.filter((i) => trialSkillNames.has(i.skillName));

  const totalInvocations = invocations.length;
  const trialInvocations = trialInvocationList.length;
  const totalSessionsWithSkillActivity = new Set(invocations.map((i) => i.sessionId)).size;
  const trialSessionsUsedIn = new Set(trialInvocationList.map((i) => i.sessionId)).size;

  const byName = new Map<string, ClassifiedInvocation[]>();
  for (const inv of trialInvocationList) {
    const list = byName.get(inv.skillName) ?? [];
    list.push(inv);
    byName.set(inv.skillName, list);
  }

  const perSkill = [...skills]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map<PerSkillMetrics>((skill) => {
      const skillInvocations = byName.get(skill.name) ?? [];
      const completed = skillInvocations.filter((i) => i.outcome === "completed").length;
      const abandoned = skillInvocations.filter((i) => i.outcome === "abandoned").length;
      const unknown = skillInvocations.filter((i) => i.outcome === "unknown").length;
      const classifiedTotal = completed + abandoned;
      const completionRate = classifiedTotal === 0 ? 0 : completed / classifiedTotal;
      const sessionsUsedIn = new Set(skillInvocations.map((i) => i.sessionId)).size;
      const ageDays = Math.floor(
        (now.getTime() - skill.skillMdMtime.getTime()) / (24 * 60 * 60 * 1000)
      );
      return {
        skillName: skill.name,
        skillAgeDays: ageDays,
        invocations: skillInvocations.length,
        completed,
        abandoned,
        unknown,
        sessionsUsedIn,
        completionRate,
        verdict: deriveVerdict(skill.name, {
          invocations: skillInvocations.length,
          sessionsUsedIn,
          completionRate,
          ageDays,
        }),
      };
    });

  return {
    windowStart,
    windowEnd,
    totalInvocations,
    trialInvocations,
    totalSessionsWithSkillActivity,
    trialSessionsUsedIn,
    perSkill,
    parseStats,
  };
}

function deriveVerdict(
  skillName: string,
  m: { invocations: number; sessionsUsedIn: number; completionRate: number; ageDays: number }
): PerSkillMetrics["verdict"] {
  const rule = VERDICT_RULES[skillName];
  if (!rule) return "UNDECIDED";
  if (rule.measureOnly) return "MEASURE";

  const grace = rule.graceDays ?? DEFAULT_GRACE_DAYS;
  if (
    m.ageDays >= grace &&
    rule.dropBelowInvocations !== undefined &&
    m.invocations < rule.dropBelowInvocations
  ) {
    return "DROP";
  }

  const meetsSessions = rule.minSessionsForKeep === undefined
    ? true
    : m.sessionsUsedIn >= rule.minSessionsForKeep;
  const meetsInvocations = rule.minInvocationsForKeep === undefined
    ? true
    : m.invocations >= rule.minInvocationsForKeep;
  const meetsCompletion = rule.minCompletionRateForKeep === undefined
    ? true
    : m.completionRate >= rule.minCompletionRateForKeep;

  if (
    meetsSessions &&
    meetsInvocations &&
    meetsCompletion &&
    (rule.minSessionsForKeep !== undefined || rule.minInvocationsForKeep !== undefined)
  ) {
    return "KEEP";
  }
  return "UNDECIDED";
}

export function renderReport(metrics: SkillUsageMetrics): string {
  const lines: string[] = [];
  lines.push("# Skill Usage — Trial Metrics");
  lines.push("");
  lines.push(`**Window:** ${metrics.windowStart} → ${metrics.windowEnd}`);
  if (metrics.parseStats) {
    const ps = metrics.parseStats;
    const malformedNote =
      ps.malformedLines === 0
        ? `${ps.totalLines} lines, 0 malformed`
        : `${ps.totalLines} lines, ${ps.malformedLines} malformed ⚠️ — investigate transcript-format drift`;
    lines.push(`**Transcripts scanned:** ${ps.filesScanned} (${malformedNote})`);
  }
  // Distinguish trial-subset activity (counts in the per-skill table) from
  // total Skill-tool activity (includes non-trial skills like pr-review-toolkit,
  // /loop, /schedule). Without this split a reader could see high total counts
  // alongside a table of zeros and assume the table is broken.
  lines.push(
    `**Trial-skill activity:** ${metrics.trialInvocations} invocation${metrics.trialInvocations === 1 ? "" : "s"} across ${metrics.trialSessionsUsedIn} session${metrics.trialSessionsUsedIn === 1 ? "" : "s"}`
  );
  lines.push(
    `**All Skill-tool activity in window:** ${metrics.totalInvocations} invocation${metrics.totalInvocations === 1 ? "" : "s"} across ${metrics.totalSessionsWithSkillActivity} session${metrics.totalSessionsWithSkillActivity === 1 ? "" : "s"} (includes non-trial skills — only trial skills appear in the table below)`
  );
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Per-skill metrics");
  lines.push("");
  lines.push("| Skill | Age (d) | Invocations | Completed | Abandoned | Unknown | Sessions | Completion rate | Verdict |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---|");
  for (const row of metrics.perSkill) {
    const completionDisplay =
      row.completed + row.abandoned === 0 ? "—" : `${Math.round(row.completionRate * 100)}%`;
    lines.push(
      `| ${row.skillName} | ${row.skillAgeDays} | ${row.invocations} | ${row.completed} | ${row.abandoned} | ${row.unknown} | ${row.sessionsUsedIn} | ${completionDisplay} | **${row.verdict}** |`
    );
  }
  lines.push("");
  lines.push("## Verdict");
  lines.push("");
  lines.push("Per-skill recommendation derived from the trial criteria in `.improvements/README.md`:");
  lines.push("");
  for (const row of metrics.perSkill) {
    lines.push(`- **${row.skillName}** — ${row.verdict}${verdictHint(row)}`);
  }
  lines.push("");
  lines.push("## How to read this report");
  lines.push("");
  lines.push("- **KEEP** — invocations and completion meet the trial criterion; the skill is paying off.");
  lines.push("- **DROP** — zero or near-zero invocations after the grace period, or sustained high abandonment. Consider removing the skill from `.claude/skills/`.");
  lines.push("- **MEASURE** — meta-skill exempted from auto-drop signal; use only the raw counts to judge.");
  lines.push("- **UNDECIDED** — neither threshold met; let the trial run further.");
  lines.push("");
  lines.push(
    `Decision date: **${TRIAL_END_DATE}**. Review the third-week report and update \`.claude/skills/\` and \`CLAUDE.md\` accordingly.`
  );
  lines.push("");
  return lines.join("\n");
}

function verdictHint(row: PerSkillMetrics): string {
  switch (row.verdict) {
    case "KEEP":
      return ` — ${row.invocations} invocations across ${row.sessionsUsedIn} sessions, ${Math.round(row.completionRate * 100)}% completion. Trial criterion met.`;
    case "DROP":
      return ` — ${row.invocations} invocation${row.invocations === 1 ? "" : "s"} in ${row.skillAgeDays} days. Consider removing the skill or revising its description.`;
    case "MEASURE":
      return ` — meta-skill, no auto-drop. Raw counts: ${row.invocations} invocations across ${row.sessionsUsedIn} sessions.`;
    case "UNDECIDED":
      return ` — ${row.invocations} invocations across ${row.sessionsUsedIn} sessions. Trial threshold not yet reached.`;
    default: {
      // Exhaustiveness check — adding a new verdict will fail compilation here.
      const _exhaustive: never = row.verdict;
      void _exhaustive;
      return "";
    }
  }
}

export function reportFileName(now: Date = new Date()): string {
  return `skill-usage-${now.toISOString().slice(0, 10)}.md`;
}
