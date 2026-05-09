import { childLogger } from "../logger.js";
import type { AllowlistConfig } from "../mcp-proxy/allowlist.js";

const log = childLogger("session-registry");

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
      return entries.get(sessionId);
    },
    list() {
      return [...entries.values()];
    },
    size() {
      return entries.size;
    },
  };
}
