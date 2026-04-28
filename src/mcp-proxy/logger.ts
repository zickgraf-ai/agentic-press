import { closeSync, openSync, writeSync } from "node:fs";
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

/**
 * Module-level audit-log destination state.
 *
 * Default: writes to `process.stdout` (interleaves with pino diagnostics —
 * fine for development, awkward for capture).
 *
 * When `configureAuditLog({ filePath })` is called, opens the file in append
 * mode and switches `logAuditEntry` to use synchronous `fs.writeSync`. This
 * bypasses Node's stream buffering entirely so each entry hits disk before
 * `logAuditEntry` returns — operators tailing the file (or the
 * `sweep-improvements` script reading it) see entries immediately, with no
 * Ctrl+C race or pino interleave.
 *
 * Why synchronous writes are OK on the request hot path: each audit entry is
 * a single line of JSON (typically <2 KiB), and modern filesystems buffer
 * small appends in the page cache. The cost is microseconds and is bounded —
 * unlike the pino path which is async-batched and can lose entries on a
 * forced exit.
 */
let auditFd: number | null = null;

export interface AuditLogOptions {
  /** Absolute or relative path. If omitted, audit entries go to stdout. */
  readonly filePath?: string;
}

/**
 * Configure where `logAuditEntry` writes. Pass `{ filePath }` to direct
 * entries to a dedicated file with synchronous writes. Pass `{}` (or call
 * `closeAuditLog`) to revert to stdout.
 *
 * Calling repeatedly is safe — any previously open fd is closed before the
 * new one is opened. If the file cannot be opened (permission denied,
 * non-existent parent, etc.) the call falls back to stdout with a
 * `console.warn`. Audit-log destination failure must never break the
 * request path.
 */
export function configureAuditLog(opts: AuditLogOptions): void {
  if (auditFd !== null) {
    try {
      closeSync(auditFd);
    } catch {
      // best-effort — if close fails, the OS will reap on process exit
    }
    auditFd = null;
  }
  const filePath = opts.filePath?.trim();
  if (!filePath) return;
  try {
    auditFd = openSync(filePath, "a");
  } catch (err) {
    // Use console.warn — childLogger here would create a circular import,
    // and this is a one-shot bootstrap-time failure. Falling back to stdout
    // is safe; the request path keeps working.
    console.warn(
      `[audit-log] failed to open ${filePath} — falling back to stdout: ${err instanceof Error ? err.message : String(err)}`
    );
    auditFd = null;
  }
}

/**
 * Close the audit-log file fd if open. Safe to call multiple times. After
 * calling, subsequent `logAuditEntry` calls write to stdout.
 */
export function closeAuditLog(): void {
  if (auditFd !== null) {
    try {
      closeSync(auditFd);
    } catch {
      // best-effort
    }
    auditFd = null;
  }
}

export function logAuditEntry(entry: AuditEntry): void {
  const line = JSON.stringify(entry) + "\n";
  if (auditFd !== null) {
    writeSync(auditFd, line);
  } else {
    process.stdout.write(line);
  }
}
