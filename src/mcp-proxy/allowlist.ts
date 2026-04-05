export interface AllowlistConfig {
  readonly patterns: readonly string[];
}

export type AllowlistResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

export function checkAllowlist(
  _toolName: string,
  _config: AllowlistConfig
): AllowlistResult {
  throw new Error("Not implemented");
}
