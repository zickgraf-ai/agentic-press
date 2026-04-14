import type { SanitizeFlag } from "./sanitizer.js";
import type { AuditStatus } from "../types.js";

export type AuditDirection = "request" | "response";

export interface AuditEntry {
  readonly timestamp: string;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly status: AuditStatus;
  readonly flags: readonly SanitizeFlag[];
  readonly durationMs?: number;
  /**
   * Which pipeline stage produced this entry. "request" covers allowlist,
   * request-arg sanitization, and path guard. "response" covers upstream
   * MCP server response sanitization. Defaults to "request" when omitted.
   */
  readonly direction?: AuditDirection;
  /**
   * Optional operator-facing error message. Set on the error path so later
   * audit-log searches can correlate failures without joining against
   * separate diagnostic log output. Always scrubbed to a plain string (never a raw
   * Error object or stack trace).
   */
  readonly errorMessage?: string;
}

export function logAuditEntry(entry: AuditEntry): void {
  process.stdout.write(JSON.stringify(entry) + "\n");
}
