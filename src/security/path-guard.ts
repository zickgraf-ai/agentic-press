export interface PathGuardConfig {
  workspaceRoot: string;
}

export interface PathCheckResult {
  allowed: boolean;
  reason?: string;
  resolvedPath?: string;
}

export function checkPath(
  _path: string,
  _config: PathGuardConfig
): PathCheckResult {
  throw new Error("Not implemented");
}
