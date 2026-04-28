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
 * fine for development, awkward for capture). When stdout is redirected to a
 * pipe or file, Node block-buffers writes (see `process.stdout._handle` —
 * synchronous to a TTY, buffered to a file/pipe), and the buffer can be lost
 * on a forced exit before it flushes.
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
 * small appends in the page cache. The cost is microseconds and is bounded.
 */
let auditFd: number | null = null;
let writeFailureWarned = false;

export interface AuditLogOptions {
  /** Absolute or relative path. If omitted, audit entries go to stdout. */
  readonly filePath?: string;
}

/**
 * Configure where `logAuditEntry` writes. Pass `{ filePath }` to direct
 * entries to a dedicated file with synchronous writes. Pass `{}` (or call
 * `closeAuditLog`) to revert to stdout.
 *
 * Returns `true` when the file destination is active (caller can log "writing
 * to file"), `false` when the call fell back to stdout (caller should NOT
 * claim file logging is active). Calling repeatedly is safe — any previously
 * open fd is closed before the new one is opened. If the file cannot be
 * opened (permission denied, non-existent parent, etc.) the call falls back
 * to stdout with a `console.warn`. Audit-log destination failure must never
 * break the request path.
 */
export function configureAuditLog(opts: AuditLogOptions): boolean {
  if (auditFd !== null) {
    safeCloseFd(auditFd, "configureAuditLog: closing previous fd");
    auditFd = null;
  }
  // Reset the per-fd warning gate — a fresh open deserves a fresh chance
  // to warn on its first failure.
  writeFailureWarned = false;
  const filePath = opts.filePath?.trim();
  if (!filePath) return false;
  try {
    auditFd = openSync(filePath, "a");
    return true;
  } catch (err) {
    // Use console.warn rather than the structured logger here — this is a
    // bootstrap-time call (configureAuditLog runs before the request path
    // is exercised), and reaching for the pino instance from this module
    // would couple logger to logger ordering. console.warn is the
    // logger-of-last-resort for bootstrap failures across this codebase
    // (see also parseLogLevel in src/types.ts).
    console.warn(
      `[audit-log] failed to open ${filePath} — falling back to stdout: ${err instanceof Error ? err.message : String(err)}`
    );
    auditFd = null;
    return false;
  }
}

/**
 * Close the audit-log file fd if open. Safe to call multiple times. After
 * calling, subsequent `logAuditEntry` calls write to stdout.
 */
export function closeAuditLog(): void {
  if (auditFd !== null) {
    safeCloseFd(auditFd, "closeAuditLog");
    auditFd = null;
  }
}

function safeCloseFd(fd: number, context: string): void {
  try {
    closeSync(fd);
  } catch (err) {
    // The OS will reap the fd on process exit, so this is non-fatal —
    // but log it so operators have a breadcrumb when investigating leaks.
    console.warn(
      `[audit-log] ${context}: closeSync failed (non-fatal, OS will reap on exit): ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export function logAuditEntry(entry: AuditEntry): void {
  const line = JSON.stringify(entry) + "\n";
  if (auditFd !== null) {
    try {
      writeSync(auditFd, line);
      return;
    } catch (err) {
      // CRITICAL invariant: audit-log destination failure must NEVER break
      // the request path. ENOSPC (disk full), ESTALE (fd revoked), EDQUOT
      // (quota exceeded), etc. — all surface here as a thrown exception
      // from writeSync. Catch, fall back to stdout, close the now-stale fd,
      // and warn ONCE per fd-lifetime so operators see the failure without
      // flooding logs with one warning per request.
      if (!writeFailureWarned) {
        writeFailureWarned = true;
        console.warn(
          `[audit-log] writeSync failed — reverting to stdout for the rest of this fd lifetime: ` +
            `${err instanceof Error ? err.message : String(err)}`
        );
      }
      safeCloseFd(auditFd, "logAuditEntry: closing stale fd after write failure");
      auditFd = null;
      // Don't lose THIS entry — fall through to stdout.
    }
  }
  process.stdout.write(line);
}
