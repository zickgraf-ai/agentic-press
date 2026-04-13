// Branded types for compile-time safety on identity strings
declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

export type SessionId = Brand<string, "SessionId">;
export type TraceId = Brand<string, "TraceId">;
export type SandboxId = Brand<string, "SandboxId">;

export type LogLevel = "debug" | "info" | "warn" | "error";
export type AuditStatus = "allowed" | "blocked" | "flagged" | "error";

const LOG_LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Validate and parse a string into a LogLevel, falling back to "info" with a warning. */
export function parseLogLevel(value: string | undefined): LogLevel {
  if (!value) return "info";
  const normalized = value.toLowerCase();
  // Use Object.hasOwn — the `in` operator walks the prototype chain, so
  // values like "constructor", "toString", "hasOwnProperty" would otherwise
  // be returned as if they were valid log levels.
  if (Object.hasOwn(LOG_LEVEL_RANK, normalized)) return normalized as LogLevel;
  // console.warn is intentional here — this runs during bootstrap before the
  // structured logger exists. It is the one legitimate use of console in this
  // codebase (logger-of-last-resort for the log-level parser itself).
  console.warn(`[parseLogLevel] Unknown LOG_LEVEL "${value}", falling back to "info"`);
  return "info";
}

/**
 * Returns true if a message at `threshold` severity would be emitted given the
 * current minimum log level. Standard logger semantics:
 *   levelAtLeast("info", "warn")  → true   (warns pass info filter)
 *   levelAtLeast("warn", "info")  → false  (infos filtered by warn min)
 *   levelAtLeast("info", "debug") → false  (debug filtered by info min)
 */
export function levelAtLeast(current: LogLevel, threshold: LogLevel): boolean {
  return LOG_LEVEL_RANK[threshold] >= LOG_LEVEL_RANK[current];
}
