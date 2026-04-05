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

export interface InjectionPattern {
  readonly name: string;
  readonly description: string;
  readonly severity: PatternSeverity;
  readonly category: PatternCategory;
  test(content: string): boolean;
}

export function getInjectionPatterns(): readonly InjectionPattern[] {
  throw new Error("Not implemented");
}
