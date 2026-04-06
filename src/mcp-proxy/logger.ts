import type { SanitizeFlag } from "./sanitizer.js";
import type { AuditStatus } from "../types.js";

export interface AuditEntry {
  readonly timestamp: string;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly status: AuditStatus;
  readonly flags: readonly SanitizeFlag[];
  readonly durationMs?: number;
}

export function logAuditEntry(entry: AuditEntry): void {
  process.stdout.write(JSON.stringify(entry) + "\n");
}
