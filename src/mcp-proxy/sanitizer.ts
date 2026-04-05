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

export function sanitize(
  _content: string,
  _mode?: SanitizeMode
): SanitizeResult {
  throw new Error("Not implemented");
}
