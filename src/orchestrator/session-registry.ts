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
  deregister(sessionId: string): void;
  lookup(sessionId: string): SessionRegistryEntry | undefined;
  list(): SessionRegistryEntry[];
  size(): number;
}

function validate(params: RegisterParams): void {
  if (typeof params.sessionId !== "string" || params.sessionId.length === 0) {
    throw new Error("Invalid sessionId — must be a non-empty string");
  }
  if (typeof params.agentType !== "string" || params.agentType.length === 0) {
    throw new Error("Invalid agentType — must be a non-empty string");
  }
  if (!params.allowlist || !Array.isArray(params.allowlist.patterns)) {
    throw new Error("Invalid allowlist — patterns must be an array");
  }
  if (params.allowlist.patterns.length === 0) {
    throw new Error("Invalid allowlist — patterns must be a non-empty array");
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
      entries.delete(sessionId);
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
