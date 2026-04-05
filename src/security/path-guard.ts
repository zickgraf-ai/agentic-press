// Path traversal prevention — guards against:
// - CVE-2025-53110: Filesystem MCP Server directory containment bypass
// - CVE-2025-53109: Filesystem MCP Server symlink traversal bypass
// - Encoded path separators (..%2f, ..%5c)
// - Null byte injection
// - Symlink escape from workspace root

export interface PathGuardConfig {
  readonly workspaceRoot: string;
}

export type PathCheckResult =
  | { readonly allowed: true; readonly resolvedPath: string }
  | { readonly allowed: false; readonly reason: string };

export function checkPath(
  _path: string,
  _config: PathGuardConfig
): PathCheckResult {
  throw new Error("Not implemented");
}
