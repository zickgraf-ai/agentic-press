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
  readonly totalSessionsAnalyzed: number;
  readonly perSkill: readonly PerSkillMetrics[];
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
  /** DROP if invocations is strictly below this AFTER grace period. */
  readonly maxInvocationsForDrop?: number;
  /** Days a skill must exist before DROP can fire. */
  readonly graceDays?: number;
}

const DEFAULT_GRACE_DAYS = 14;

/**
 * Per-skill verdict rules. Mirrors the trial framework documented in
 * `.improvements/README.md`. If a vendored skill is not listed here, it
 * gets a permissive default (UNDECIDED unless 0 invocations after grace).
 */
const VERDICT_RULES: Record<string, VerdictRule> = {
  "systematic-debugging": {
    minSessionsForKeep: 3,
    minCompletionRateForKeep: 0.7,
    maxInvocationsForDrop: 1,
    graceDays: DEFAULT_GRACE_DAYS,
  },
  "brainstorming": {
    minSessionsForKeep: 2,
    minCompletionRateForKeep: 0.7,
    maxInvocationsForDrop: 1,
    graceDays: DEFAULT_GRACE_DAYS,
  },
  "verification-before-completion": {
    minInvocationsForKeep: 5,
    maxInvocationsForDrop: 2,
    graceDays: DEFAULT_GRACE_DAYS,
  },
  "writing-skills": {
    measureOnly: true,
  },
  "subagent-driven-development": {
    minSessionsForKeep: 2,
    minCompletionRateForKeep: 0.7,
    maxInvocationsForDrop: 1,
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
  totalSessionsAnalyzed: number,
  windowStart: string,
  windowEnd: string,
  now: Date = new Date()
): SkillUsageMetrics {
  const byName = new Map<string, ClassifiedInvocation[]>();
  for (const inv of invocations) {
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
    totalSessionsAnalyzed,
    perSkill,
  };
}

function deriveVerdict(
  skillName: string,
  m: { invocations: number; sessionsUsedIn: number; completionRate: number; ageDays: number }
): PerSkillMetrics["verdict"] {
  const rule = VERDICT_RULES[skillName];
  if (!rule) {
    if (m.invocations === 0) return "UNDECIDED";
    return "UNDECIDED";
  }
  if (rule.measureOnly) return "MEASURE";

  const grace = rule.graceDays ?? DEFAULT_GRACE_DAYS;
  if (m.ageDays < grace) {
    if (m.invocations === 0) return "UNDECIDED";
  } else if (
    rule.maxInvocationsForDrop !== undefined &&
    m.invocations < rule.maxInvocationsForDrop
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
  lines.push(`**Sessions analyzed:** ${metrics.totalSessionsAnalyzed}`);
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
  lines.push("Decision date: **2026-05-30**. Review the third-week report and update `.claude/skills/` and `CLAUDE.md` accordingly.");
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
    default:
      return "";
  }
}

export function reportFileName(now: Date = new Date()): string {
  return `skill-usage-${now.toISOString().slice(0, 10)}.md`;
}
