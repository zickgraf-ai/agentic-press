export type SanitizeMode = "flag" | "strip" | "block";

export interface SanitizeResult {
  clean: boolean;
  content: string;
  flags: SanitizeFlag[];
}

export interface SanitizeFlag {
  pattern: string;
  match: string;
  position: number;
}

export function sanitize(
  _content: string,
  _mode?: SanitizeMode
): SanitizeResult {
  throw new Error("Not implemented");
}
