import type { AuditEntry } from "../mcp-proxy/logger.js";
import type {
  Suggestion,
  DetectorOptions,
  ClassifiedInvocation,
  VendoredSkill,
  SkillDetectorOptions,
} from "./types.js";

const DEFAULT_SKILL_DETECTOR = {
  neverUsedGraceDays: 14,
  neverUsedHighConfidenceDays: 21,
  abandonmentThreshold: 0.5,
  minInvocationsForAbandonment: 3,
  /**
   * `writing-skills` is a meta-skill — by design it's only invoked when the
   * user is authoring a new skill. Long stretches of zero usage are not
   * signal; flagging it would generate noise. Other skills get the
   * never-used check applied normally.
   */
  neverUsedExemptSkills: ["writing-skills"] as const,
} as const;

const DEFAULT_THRESHOLDS = {
  allowlistDriftThreshold: 3,
  toolFailureThreshold: 3,
} as const;

/**
 * Analyze a sequence of audit entries and return zero-or-more suggestions for
 * the human to review. Pure function — does not touch disk, network, or env.
 *
 * Categories implemented in this MVP (issue #20):
 *  - allowlist-drift: same tool blocked >= threshold times
 *  - tool-failure: same tool returned status=error >= threshold times
 *
 * Future categories (bridge-timeout, token-heavy, stale-setup-command) plug
 * in as additional grouping passes over the same entries.
 */
export function detectImprovements(
  entries: readonly AuditEntry[],
  opts: DetectorOptions = {}
): Suggestion[] {
  const allowlistThreshold = opts.allowlistDriftThreshold ?? DEFAULT_THRESHOLDS.allowlistDriftThreshold;
  const failureThreshold = opts.toolFailureThreshold ?? DEFAULT_THRESHOLDS.toolFailureThreshold;

  const out: Suggestion[] = [];
  out.push(...detectAllowlistDrift(entries, allowlistThreshold));
  out.push(...detectToolFailures(entries, failureThreshold));
  return out;
}

function detectAllowlistDrift(entries: readonly AuditEntry[], threshold: number): Suggestion[] {
  const byTool = new Map<string, AuditEntry[]>();
  for (const e of entries) {
    if (e.status !== "blocked") continue;
    // Defensive guard: the "_blocked" sentinel is used by server.ts ONLY in
    // the metrics-cardinality path (server.ts safeRecord coerces blocked
    // tool names to "_blocked" before passing to recorder.recordRequest).
    // The audit log keeps the real tool name, so this filter shouldn't fire
    // in practice — but if a future refactor accidentally leaks the sentinel
    // into AuditEntry, surfacing it as a suggestion would be useless. Keep
    // the guard as a low-cost belt-and-braces.
    if (e.tool === "_blocked") continue;
    const list = byTool.get(e.tool) ?? [];
    list.push(e);
    byTool.set(e.tool, list);
  }

  const suggestions: Suggestion[] = [];
  for (const [tool, list] of byTool) {
    if (list.length < threshold) continue;
    const sorted = [...list].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    suggestions.push({
      category: "allowlist-drift",
      confidence: list.length >= threshold * 2 ? "high" : "medium",
      title: `Tool "${tool}" blocked ${list.length} times across recent sessions`,
      summary:
        `The proxy's allowlist rejected "${tool}" repeatedly. This usually means one of three things: ` +
        `(a) the agent is being prompted to call a tool the allowlist doesn't permit — update the prompt or ` +
        `add the tool to ALLOWED_TOOLS, (b) docs reference a tool that's not actually configured — fix the docs, ` +
        `or (c) something is repeatedly attempting an unauthorized call — investigate.`,
      evidence: {
        tool,
        count: list.length,
        firstSeen: sorted[0]!.timestamp,
        lastSeen: sorted[sorted.length - 1]!.timestamp,
      },
    });
  }
  return suggestions;
}

/**
 * Analyze classified Skill invocations from session transcripts and the
 * vendored-skills catalog, returning anti-signal suggestions for the
 * skill-usage trial. Pure function — does not touch disk, network, or env.
 *
 * Two signals fire:
 *  - never-used: a vendored skill present for >= grace days with zero
 *    invocations (writing-skills exempted by default — meta-skill, low
 *    expected frequency).
 *  - high-abandonment: a vendored skill with >= min invocations and an
 *    abandoned/(abandoned+completed) rate at or above threshold. Outcomes
 *    classified as "unknown" are excluded from the rate denominator.
 */
export function detectSkillUsageImprovements(
  invocations: readonly ClassifiedInvocation[],
  skills: readonly VendoredSkill[],
  opts: SkillDetectorOptions = {}
): Suggestion[] {
  const grace = opts.neverUsedGraceDays ?? DEFAULT_SKILL_DETECTOR.neverUsedGraceDays;
  const highDays = opts.neverUsedHighConfidenceDays ?? DEFAULT_SKILL_DETECTOR.neverUsedHighConfidenceDays;
  const abandonRate = opts.abandonmentThreshold ?? DEFAULT_SKILL_DETECTOR.abandonmentThreshold;
  const minInvocations = opts.minInvocationsForAbandonment ?? DEFAULT_SKILL_DETECTOR.minInvocationsForAbandonment;
  const exempt = new Set(opts.neverUsedExemptSkills ?? DEFAULT_SKILL_DETECTOR.neverUsedExemptSkills);
  const now = opts.now ?? new Date();

  const byName = new Map<string, ClassifiedInvocation[]>();
  for (const inv of invocations) {
    const list = byName.get(inv.skillName) ?? [];
    list.push(inv);
    byName.set(inv.skillName, list);
  }

  const out: Suggestion[] = [];
  for (const skill of skills) {
    const skillInvocations = byName.get(skill.name) ?? [];
    const ageDays = Math.floor((now.getTime() - skill.skillMdMtime.getTime()) / (24 * 60 * 60 * 1000));

    if (skillInvocations.length === 0) {
      if (exempt.has(skill.name)) continue;
      if (ageDays < grace) continue;
      const confidence = ageDays >= highDays ? "high" : "medium";
      out.push({
        category: "skill-usage",
        confidence,
        title: `Skill "${skill.name}" never used in ${ageDays} days — consider dropping`,
        summary:
          `The vendored skill "${skill.name}" has been present for ${ageDays} days with zero ` +
          `invocations. Either the agent isn't reaching for it when it should ` +
          `(consider revising its description or triggers), or the skill isn't pulling its weight ` +
          `for this project's workload (consider dropping it from \`.claude/skills/\`).`,
        evidence: {
          skillName: skill.name,
          invocations: 0,
          completed: 0,
          abandoned: 0,
          sessionsUsedIn: 0,
          skillAgeDays: ageDays,
        },
      });
      continue;
    }

    const completed = skillInvocations.filter((i) => i.outcome === "completed").length;
    const abandoned = skillInvocations.filter((i) => i.outcome === "abandoned").length;
    const classifiedTotal = completed + abandoned;
    const sessionsUsedIn = new Set(skillInvocations.map((i) => i.sessionId)).size;

    if (classifiedTotal >= minInvocations && abandoned / classifiedTotal >= abandonRate) {
      const ratio = abandoned / classifiedTotal;
      // Strict > (not >=): at 2/3 ratio the signal is borderline, keep at medium.
      // High fires once the rate exceeds the 2/3 boundary (e.g. 3/4 = 75%).
      const confidence = ratio > 2 / 3 ? "high" : "medium";
      const pct = Math.round(ratio * 100);
      out.push({
        category: "skill-usage",
        confidence,
        title: `Skill "${skill.name}" abandoned ${pct}% of the time (${abandoned}/${classifiedTotal} invocations)`,
        summary:
          `The vendored skill "${skill.name}" was invoked ${classifiedTotal} times and abandoned ${abandoned} of those (` +
          `${pct}%). High abandonment usually means the skill's flow doesn't fit how the agent reaches for it ` +
          `— the skill description may pull it in for the wrong situations, or its workflow is too heavy for the ` +
          `cases where it's invoked. Consider revising the trigger conditions, simplifying the workflow, or dropping ` +
          `the skill if neither helps.`,
        evidence: {
          skillName: skill.name,
          invocations: skillInvocations.length,
          completed,
          abandoned,
          sessionsUsedIn,
          skillAgeDays: ageDays,
        },
      });
    }
  }
  return out;
}

function detectToolFailures(entries: readonly AuditEntry[], threshold: number): Suggestion[] {
  const byTool = new Map<string, AuditEntry[]>();
  for (const e of entries) {
    if (e.status !== "error") continue;
    const list = byTool.get(e.tool) ?? [];
    list.push(e);
    byTool.set(e.tool, list);
  }

  const suggestions: Suggestion[] = [];
  for (const [tool, list] of byTool) {
    if (list.length < threshold) continue;
    const sorted = [...list].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const sampleErrors = Array.from(
      new Set(list.map((e) => e.errorMessage).filter((m): m is string => typeof m === "string"))
    ).slice(0, 3);
    suggestions.push({
      category: "tool-failure",
      confidence: list.length >= threshold * 2 ? "high" : "medium",
      title: `Tool "${tool}" returned errors ${list.length} times`,
      summary:
        `The upstream MCP server backing "${tool}" repeatedly errored. Investigate whether the server is ` +
        `misconfigured, the tool's contract has changed, or the agent is calling it with unsupported arguments.`,
      evidence: {
        tool,
        count: list.length,
        firstSeen: sorted[0]!.timestamp,
        lastSeen: sorted[sorted.length - 1]!.timestamp,
        sampleErrors,
      },
    });
  }
  return suggestions;
}
