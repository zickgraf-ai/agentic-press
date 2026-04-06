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

// Patterns that use regex can report match position; function-based ones report 0.
function findFlags(content: string, patterns: readonly InjectionPattern[]): SanitizeFlag[] {
  const flags: SanitizeFlag[] = [];

  for (const p of patterns) {
    if (!p.test(content)) continue;

    // Try to extract match details using the pattern's internal regex
    // We reconstruct a search to find position and matched text
    const matchInfo = findMatchInfo(content, p);
    flags.push({
      pattern: p.name,
      match: matchInfo.match,
      position: matchInfo.position,
    });
  }

  return flags;
}

function findMatchInfo(
  content: string,
  pattern: InjectionPattern
): { match: string; position: number } {
  // For regex-based patterns, we can try common injection substrings to locate them
  // For the zero-width pattern, find the first zero-width char
  if (pattern.name === "zero_width_chars") {
    const zwMatch = content.match(/[\u200B\u200C\u200D\uFEFF\u2060]+/);
    if (zwMatch && zwMatch.index !== undefined) {
      return { match: zwMatch[0], position: zwMatch.index };
    }
  }

  // For base64, find the dangerous base64 block
  if (pattern.name === "dangerous_base64") {
    const b64Match = content.match(/[A-Za-z0-9+/]{20,}={0,2}/);
    if (b64Match && b64Match.index !== undefined) {
      return { match: b64Match[0], position: b64Match.index };
    }
  }

  // Generic: try to find the pattern by testing substrings
  // Use a sliding window approach for short content, or pattern-specific regex
  const regexMap: Record<string, RegExp> = {
    ignore_instructions: /\bignore\s+(all\s+)?(previous|prior|above|your)\s+(instructions?|directives?|rules?)\b/i,
    disregard_instructions: /\bdisregard\s+(all\s+)?(previous|prior|above|your)?\s*(instructions?|directives?|rules?)\b/i,
    forget_instructions: /\bforget\s+(everything\s+)?(above|previous|your)\s*(instructions?)?\b/i,
    role_assumption: /\b(you\s+are\s+now|act\s+as\s+if|pretend\s+you\s+are|from\s+now\s+on\s+you\s+will\s+act\s+as)\b/i,
    system_marker: /(<\|system\|>|<\|assistant\|>|<\|human\|>|\[SYSTEM\]|###SYSTEM###|<<SYS>>|```system\b)/i,
    system_colon_prefix: /^system\s*:\s/im,
    tool_definition_injection: /\{\s*"tools"\s*:\s*\[/,
    function_call_injection: /\{\s*"function_call"\s*:\s*\{/,
    tool_result_escape: /<\/tool_result\s*>/i,
    script_tag: /<script[\s>]/i,
    event_handler: /\bon\w+\s*=\s*["']/i,
    iframe_tag: /<iframe[\s>]/i,
    style_url: /<style[^>]*>[^<]*url\s*\(/i,
    javascript_protocol: /javascript\s*:/i,
    markdown_image_exfil: /!\[[^\]]*\]\(https?:\/\//,
  };

  const regex = regexMap[pattern.name];
  if (regex) {
    const m = content.match(regex);
    if (m && m.index !== undefined) {
      return { match: m[0], position: m.index };
    }
  }

  return { match: content.slice(0, 50), position: 0 };
}

function stripMatches(content: string, flags: readonly SanitizeFlag[]): string {
  let result = content;

  // Strip zero-width characters
  result = result.replace(/[\u200B\u200C\u200D\uFEFF\u2060]/g, "");

  // Strip other matched patterns by their match text
  for (const flag of flags) {
    if (flag.pattern === "zero_width_chars") continue; // already handled
    if (flag.match) {
      result = result.replace(flag.match, "");
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
