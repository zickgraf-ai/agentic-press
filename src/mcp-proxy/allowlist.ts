export interface AllowlistConfig {
  readonly patterns: readonly string[];
}

export type AllowlistResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

function matchesPattern(toolName: string, pattern: string): boolean {
  // Empty or whitespace-only patterns never match
  if (!pattern || !pattern.trim()) return false;

  // Catch-all: bare "*" matches everything
  if (pattern === "*") return true;

  // Wildcard suffix: "prefix.*" or "prefix.**" matches "prefix.anything"
  if (pattern.endsWith(".*") || pattern.endsWith(".**")) {
    const prefix = pattern.replace(/\.\*{1,2}$/, ".");
    return toolName.startsWith(prefix);
  }

  // Exact match
  return toolName === pattern;
}

export function checkAllowlist(
  toolName: string,
  config: AllowlistConfig
): AllowlistResult {
  // Defensive: malformed config blocks everything
  if (!config || !config.patterns) {
    return { allowed: false, reason: "Invalid allowlist configuration" };
  }

  // Empty tool name is never valid
  if (!toolName) {
    return { allowed: false, reason: "Empty tool name" };
  }

  for (const pattern of config.patterns) {
    if (matchesPattern(toolName, pattern)) {
      return { allowed: true };
    }
  }

  return {
    allowed: false,
    reason: `Tool "${toolName}" is not in the allowlist`,
  };
}
