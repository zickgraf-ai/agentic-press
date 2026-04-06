import { getInjectionPatterns, type InjectionPattern } from "../security/injection-patterns.js";

export type SanitizeMode = "flag" | "strip" | "block";

export interface SanitizeFlag {
  readonly pattern: string;
  readonly match: string;
  readonly position: number;
}

export interface SanitizeResult {
  readonly content: string;
  readonly flags: readonly SanitizeFlag[];
}

function findFlags(content: string, patterns: readonly InjectionPattern[]): SanitizeFlag[] {
  const flags: SanitizeFlag[] = [];

  for (const p of patterns) {
    if (!p.test(content)) continue;

    // Use the pattern's own find() — single source of truth, no duplicated regexes (#2, #4)
    const matchInfo = p.find(content);
    flags.push({
      pattern: p.name,
      match: matchInfo?.match ?? "",
      position: matchInfo?.position ?? 0,
    });
  }

  return flags;
}

function stripMatches(content: string, flags: readonly SanitizeFlag[]): string {
  let result = content;

  // Strip zero-width characters globally
  result = result.replace(/[\u200B\u200C\u200D\uFEFF\u2060]/g, "");

  // Strip ALL occurrences of each matched pattern (#6 — replaceAll, not replace)
  for (const flag of flags) {
    if (flag.pattern === "zero_width_chars") continue; // already handled
    if (flag.match) {
      result = result.replaceAll(flag.match, "");
    }
  }

  return result;
}

const BLOCKED_MESSAGE = "[Content blocked by MCP proxy: injection pattern detected]";

export function sanitize(content: string, mode: SanitizeMode = "flag"): SanitizeResult {
  const patterns = getInjectionPatterns();
  const flags = findFlags(content, patterns);

  if (flags.length === 0) {
    return { content, flags };
  }

  switch (mode) {
    case "flag":
      return { content, flags };

    case "strip":
      return { content: stripMatches(content, flags), flags };

    case "block":
      return { content: BLOCKED_MESSAGE, flags };
  }
}
