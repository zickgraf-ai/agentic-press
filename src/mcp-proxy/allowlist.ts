export interface AllowlistConfig {
  patterns: string[];
}

export interface AllowlistResult {
  allowed: boolean;
  reason?: string;
}

export function checkAllowlist(
  _toolName: string,
  _config: AllowlistConfig
): AllowlistResult {
  throw new Error("Not implemented");
}
