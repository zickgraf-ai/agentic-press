// Clean-room injection detection patterns sourced from public research:
// - OWASP Top 10 for LLM Applications (2025)
// - MCP specification security considerations
// - invariantlabs.ai MCP attack vector research
// - CVE-2025-6514: mcp-remote arbitrary OS command execution (CVSS 9.6)
// - CVE-2025-53110: Filesystem MCP Server directory containment bypass
// - CVE-2025-53109: Filesystem MCP Server symlink traversal bypass

export type PatternSeverity = "critical" | "high" | "medium" | "low";

export type PatternCategory =
  | "prompt_injection"
  | "unicode_smuggling"
  | "encoded_payload"
  | "markup_injection"
  | "path_traversal"
  | "system_override";

export interface PatternMatch {
  readonly match: string;
  readonly position: number;
}

export interface InjectionPattern {
  readonly name: string;
  readonly description: string;
  readonly severity: PatternSeverity;
  readonly category: PatternCategory;
  test(content: string): boolean;
  find(content: string): PatternMatch | null;
}

function pat(
  name: string,
  description: string,
  severity: PatternSeverity,
  category: PatternCategory,
  regex: RegExp
): InjectionPattern {
  return {
    name,
    description,
    severity,
    category,
    test: (c) => regex.test(c),
    find: (c) => {
      const m = c.match(regex);
      if (!m || m.index === undefined) return null;
      return { match: m[0], position: m.index };
    },
  };
}

// ── Base64 payload detection ───────────────────────────────────────
// Only flags base64 that decodes to known dangerous content, not all base64.

const BASE64_BLOCK = /[A-Za-z0-9+/]{20,}={0,2}/g;

const DANGEROUS_DECODED = [
  /ignore\s+(previous|prior|all)\s+instructions/i,
  /system\s*:\s/i,
  /you\s+are\s+now/i,
  /\beval\s*\(/i,
  /\bexec\s*\(/i,
  /process\.\s*(exit|env|kill)/i,
  /rm\s+-rf/i,
];

function containsDangerousBase64(content: string): boolean {
  const matches = content.match(BASE64_BLOCK);
  if (!matches) return false;

  for (const match of matches) {
    let decoded: string;
    try {
      decoded = Buffer.from(match, "base64").toString("utf-8");
      // Verify it's valid base64 by round-tripping
      const reencoded = Buffer.from(decoded, "utf-8").toString("base64");
      const norm = (s: string) => s.replace(/=+$/, "");
      if (norm(reencoded) !== norm(match)) continue;
    } catch {
      // Only decode errors are caught — skip invalid base64
      continue;
    }

    // Regex matching is outside try/catch so failures propagate (#3)
    if (DANGEROUS_DECODED.some((p) => p.test(decoded))) return true;
  }
  return false;
}

function findDangerousBase64(content: string): PatternMatch | null {
  const matches = content.match(BASE64_BLOCK);
  if (!matches) return null;

  for (const match of matches) {
    let decoded: string;
    try {
      decoded = Buffer.from(match, "base64").toString("utf-8");
      const reencoded = Buffer.from(decoded, "utf-8").toString("base64");
      const norm = (s: string) => s.replace(/=+$/, "");
      if (norm(reencoded) !== norm(match)) continue;
    } catch {
      continue;
    }

    if (DANGEROUS_DECODED.some((p) => p.test(decoded))) {
      const idx = content.indexOf(match);
      return { match, position: idx >= 0 ? idx : 0 };
    }
  }
  return null;
}

// ── Pattern definitions ────────────────────────────────────────────

const PATTERNS: readonly InjectionPattern[] = [
  // Prompt injection — instruction override
  pat(
    "ignore_instructions",
    "Attempts to make the LLM discard its system instructions",
    "critical",
    "prompt_injection",
    /\bignore\s+(all\s+)?(previous|prior|above|your)\s+(instructions?|directives?|rules?)\b/i
  ),
  pat(
    "disregard_instructions",
    "Variant of instruction override using 'disregard'",
    "critical",
    "prompt_injection",
    // Qualifier (previous|prior|above|your) is required — not optional (#5)
    /\bdisregard\s+(all\s+)?(previous|prior|above|your)\s+(instructions?|directives?|rules?)\b/i
  ),
  pat(
    "forget_instructions",
    "Variant of instruction override using 'forget'",
    "critical",
    "prompt_injection",
    /\bforget\s+(everything\s+)?(above|previous|your)\s*(instructions?)?\b/i
  ),

  // Prompt injection — role assumption
  pat(
    "role_assumption",
    "Attempts to assign the LLM a new identity or unrestricted mode",
    "high",
    "prompt_injection",
    /\b(you\s+are\s+now\s+(a\s+|an\s+|in\s+|my\s+|DAN|unrestricted|free|evil)|act\s+as\s+if\s+you|pretend\s+you\s+are|from\s+now\s+on\s+you\s+will\s+act\s+as)\b/i
  ),

  // System override — turn boundary injection
  pat(
    "system_marker",
    "Fake system/assistant/human turn boundary markers",
    "critical",
    "system_override",
    /(<\|system\|>|<\|assistant\|>|<\|human\|>|\[SYSTEM\]|###SYSTEM###|<<SYS>>|```system\b)/i
  ),
  pat(
    "system_colon_prefix",
    "Line starting with 'system:' to inject fake system turn",
    "high",
    "system_override",
    /^system\s*:\s/im
  ),

  // System override — tool/function injection (CVE-2025-6514 related)
  // Lowered to high — {"tools": [...]} can appear in legitimate MCP responses (#7)
  pat(
    "tool_definition_injection",
    "Injected tool definitions in MCP response",
    "high",
    "system_override",
    /\{\s*"tools"\s*:\s*\[/
  ),
  pat(
    "function_call_injection",
    "Injected function_call in MCP response",
    "critical",
    "system_override",
    /\{\s*"function_call"\s*:\s*\{/
  ),
  pat(
    "tool_result_escape",
    "Attempts to close and reopen tool_result XML tags",
    "critical",
    "system_override",
    /<\/tool_result\s*>/i
  ),

  // Unicode smuggling
  pat(
    "zero_width_chars",
    "Zero-width unicode characters that can hide instructions",
    "high",
    "unicode_smuggling",
    /[\u200B\u200C\u200D\uFEFF\u2060]/
  ),

  // Encoded payloads — uses custom test/find functions
  {
    name: "dangerous_base64",
    description: "Base64 that decodes to a known injection pattern",
    severity: "high",
    category: "encoded_payload",
    test: containsDangerousBase64,
    find: findDangerousBase64,
  },

  // Markup injection
  pat(
    "script_tag",
    "HTML script tag that could execute arbitrary JavaScript",
    "critical",
    "markup_injection",
    /<script[\s>]/i
  ),
  pat(
    "event_handler",
    "HTML event handler attribute (onclick, onerror, etc.)",
    "high",
    "markup_injection",
    /\bon\w+\s*=\s*["']/i
  ),
  pat(
    "iframe_tag",
    "HTML iframe that could load external content",
    "high",
    "markup_injection",
    /<iframe[\s>]/i
  ),
  pat(
    "style_url",
    "CSS style tag with url() for potential data exfiltration",
    "medium",
    "markup_injection",
    /<style[^>]*>[^<]*url\s*\(/i
  ),
  pat(
    "javascript_protocol",
    "javascript: protocol in links that could execute code",
    "high",
    "markup_injection",
    /javascript\s*:/i
  ),
  pat(
    "markdown_image_exfil",
    "Markdown image with external URL for potential data exfiltration",
    "medium",
    "markup_injection",
    /!\[[^\]]*\]\(https?:\/\//
  ),
];

export function getInjectionPatterns(): readonly InjectionPattern[] {
  return PATTERNS;
}
