import type { AuditEntry } from "../mcp-proxy/logger.js";
import type { Suggestion, DetectorOptions } from "./types.js";

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
    // The "_blocked" sentinel is a cardinality-defense placeholder used by
    // server.ts when recording blocked tools to metrics — it is not a real
    // tool name and would be a useless suggestion.
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
