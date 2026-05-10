import { childLogger } from "../logger.js";
import type { AllowlistConfig } from "../mcp-proxy/allowlist.js";

const log = childLogger("session-registry");

/**
 * Cap on concurrent registrations. Defense-in-depth: even with the bearer
 * token, a buggy or compromised host-side caller in a tight loop should not
 * exhaust process memory. 1024 is well above any realistic single-host
 * orchestrator footprint and well below any Map size that risks GC pressure.
 */
export const MAX_SESSIONS = 1024;

/**
 * Shared validation contract for control-plane register payloads. The registry
 * (this module) and the HTTP layer (`src/orchestrator/control-plane.ts`) both
 * call `validateSessionInput` so there is exactly one source of truth for what
 * counts as a well-formed input. The HTTP layer returns the structured error
 * as a 400 response body; the registry throws so an in-process caller bypassing
 * HTTP still gets the same contract.
 *
 * Charset / length envelopes intentionally match the identity-header parser
 * (#52) so Prometheus / OTEL / NDJSON consumers see consistently bounded
 * values across all surfaces.
 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
export const AGENT_TYPE_PATTERN = /^[A-Za-z0-9._-]+$/;
export const ALLOWLIST_PATTERN_CHARSET = /^[A-Za-z0-9._*-]+$/;
export const SESSION_ID_MAX_LEN = 128;
export const AGENT_TYPE_MAX_LEN = 32;
export const ALLOWLIST_PATTERN_MAX_LEN = 256;
export const ALLOWLIST_MAX_ENTRIES = 256;

export type ValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

export function validateSessionInput(input: {
  readonly sessionId: unknown;
  readonly agentType: unknown;
  readonly allowedTools: unknown;
}): ValidationResult {
  const { sessionId, agentType, allowedTools } = input;
  if (
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    sessionId.length > SESSION_ID_MAX_LEN ||
    !SESSION_ID_PATTERN.test(sessionId)
  ) {
    return {
      ok: false,
      error: `Invalid sessionId — must be 1..${SESSION_ID_MAX_LEN} chars matching [A-Za-z0-9._-]+`,
    };
  }
  if (
    typeof agentType !== "string" ||
    agentType.length === 0 ||
    agentType.length > AGENT_TYPE_MAX_LEN ||
    !AGENT_TYPE_PATTERN.test(agentType)
  ) {
    return {
      ok: false,
      error: `Invalid agentType — must be 1..${AGENT_TYPE_MAX_LEN} chars matching [A-Za-z0-9._-]+`,
    };
  }
  if (!Array.isArray(allowedTools)) {
    return { ok: false, error: "Invalid allowedTools — must be an array" };
  }
  if (allowedTools.length === 0) {
    return { ok: false, error: "Invalid allowedTools — must be a non-empty array" };
  }
  if (allowedTools.length > ALLOWLIST_MAX_ENTRIES) {
    return { ok: false, error: `Invalid allowedTools — too many entries (max ${ALLOWLIST_MAX_ENTRIES})` };
  }
  for (const t of allowedTools) {
    if (typeof t !== "string" || t.length === 0 || t.length > ALLOWLIST_PATTERN_MAX_LEN) {
      return {
        ok: false,
        error: "Invalid allowedTools — every entry must be a non-empty string within length bounds",
      };
    }
    if (!ALLOWLIST_PATTERN_CHARSET.test(t)) {
      return {
        ok: false,
        error: "Invalid allowedTools — entries must match [A-Za-z0-9._*-]+ (no whitespace, control chars, null bytes, or unicode)",
      };
    }
    if (t === "*" || /^\*+$/.test(t)) {
      return {
        ok: false,
        error: `Invalid allowedTools — bare catch-all "${t}" is not allowed in per-session allowlists. Use specific tool names or prefix wildcards (e.g. "echo__*").`,
      };
    }
  }
  return { ok: true };
}

export interface SessionRegistryEntry {
  readonly sessionId: string;
  readonly agentType: string;
  readonly allowlist: AllowlistConfig;
  readonly registeredAt: string;
}

export interface RegisterParams {
  readonly sessionId: string;
  readonly agentType: string;
  readonly allowlist: AllowlistConfig;
}

export interface SessionRegistry {
  register(params: RegisterParams): void;
  /**
   * Remove the session and return whether something was actually removed.
   * Callers (e.g. the control-plane DELETE handler) use the return value to
   * decide whether the deregistration was a real state change worth auditing
   * or a no-op worth warn-logging only.
   */
  deregister(sessionId: string): boolean;
  lookup(sessionId: string): SessionRegistryEntry | undefined;
  list(): SessionRegistryEntry[];
  size(): number;
}

function validate(params: RegisterParams): void {
  const result = validateSessionInput({
    sessionId: params.sessionId,
    agentType: params.agentType,
    allowedTools: params.allowlist?.patterns,
  });
  if (!result.ok) {
    throw new Error(result.error);
  }
}

/**
 * Return a deep-enough copy of an entry that callers cannot mutate the
 * registry's internal state via the returned reference. The `readonly`
 * annotations on `SessionRegistryEntry` are compile-time only — a caller
 * could `(entry.allowlist.patterns as string[]).push("*")` without this
 * defensive copy and silently widen every future allowlist check. Copies
 * the patterns array (the only mutable member); strings and the date string
 * are immutable by JS semantics.
 */
function cloneEntry(entry: SessionRegistryEntry): SessionRegistryEntry {
  return {
    sessionId: entry.sessionId,
    agentType: entry.agentType,
    allowlist: { patterns: [...entry.allowlist.patterns] },
    registeredAt: entry.registeredAt,
  };
}

/**
 * In-memory, in-process registry of per-session allowlists. Constructed once at
 * startup and shared by reference between the proxy server (read-only — looks
 * up entries on the request hot path) and the control-plane server (writer —
 * mutates via register/deregister). No persistence: a process restart loses
 * registrations, and the dispatch CLI is responsible for re-registering.
 *
 * Defensive input validation lives both here and at the HTTP layer; the HTTP
 * layer rejects with structured 400 responses, this layer throws so a buggy
 * in-process caller surfaces the bug at its call site rather than silently
 * registering something invalid.
 */
export function createSessionRegistry(): SessionRegistry {
  const entries = new Map<string, SessionRegistryEntry>();

  return {
    register(params) {
      validate(params);
      const existing = entries.get(params.sessionId);
      if (existing) {
        log.warn(
          { sessionId: params.sessionId, previousAgentType: existing.agentType, newAgentType: params.agentType },
          "session re-register — overwriting prior entry (likely dispatch-CLI bug or restart race)"
        );
      } else if (entries.size >= MAX_SESSIONS) {
        // Capacity check only when the call is a fresh registration, not an
        // overwrite — a re-register is bounded by the existing slot count.
        throw new Error(
          `Session registry is full (max ${MAX_SESSIONS} concurrent sessions). Deregister stale entries before registering new ones.`
        );
      }
      entries.set(params.sessionId, {
        sessionId: params.sessionId,
        agentType: params.agentType,
        allowlist: { patterns: [...params.allowlist.patterns] },
        registeredAt: new Date().toISOString(),
      });
    },
    deregister(sessionId) {
      return entries.delete(sessionId);
    },
    lookup(sessionId) {
      const entry = entries.get(sessionId);
      return entry ? cloneEntry(entry) : undefined;
    },
    list() {
      return [...entries.values()].map(cloneEntry);
    },
    size() {
      return entries.size;
    },
  };
}
