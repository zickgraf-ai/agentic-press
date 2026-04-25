import type { AuditEntry, AuditDirection } from "../mcp-proxy/logger.js";
import type { DashboardAdapter, ActivityEvent } from "./adapter.js";
import { childLogger } from "../logger.js";

const log = childLogger("dashboard");

export interface EventBridge {
  emit(entry: AuditEntry): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * Singleton no-op EventBridge. Returned when the dashboard is disabled.
 * The frozen sentinel is allocated once at module load — the disabled path
 * allocates nothing per request.
 */
const NOOP_EVENT_BRIDGE: EventBridge = Object.freeze({
  emit: () => {},
  flush: async () => {},
  shutdown: async () => {},
});

export function createNoopEventBridge(): EventBridge {
  return NOOP_EVENT_BRIDGE;
}

/** Exposed for tests that want to assert the disabled path returns the sentinel. */
export function getNoopEventBridge(): EventBridge {
  return NOOP_EVENT_BRIDGE;
}

function mapStatusToType(status: AuditEntry["status"]): ActivityEvent["type"] {
  switch (status) {
    case "allowed": return "tool_call";
    case "flagged": return "injection_flag";
    case "blocked": return "blocked";
    case "error": return "error";
  }
}

/**
 * Event bridge that transforms AuditEntry records into Mission Control
 * activity events and pushes them via the adapter. `emit` is fire-and-forget:
 * it queues the push internally and catches all errors — the dashboard
 * MUST NEVER break the request path.
 */
export function createEventBridge(adapter: DashboardAdapter): EventBridge {
  // Track in-flight pushes so flush() can wait for them
  const pending: Promise<void>[] = [];

  function emit(entry: AuditEntry): void {
    const event: ActivityEvent = {
      type: mapStatusToType(entry.status),
      tool: entry.tool,
      timestamp: entry.timestamp,
      status: entry.status,
      ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
      ...(entry.flags.length > 0
        ? { flags: entry.flags.map((f) => f.pattern) }
        : {}),
      ...(entry.errorMessage ? { errorMessage: entry.errorMessage } : {}),
    };

    const p = adapter.pushActivity(event).catch((err) => {
      log.warn({ err }, "EventBridge push failed (ignored)");
    });
    pending.push(p);
  }

  async function flush(): Promise<void> {
    await Promise.allSettled(pending.splice(0));
  }

  async function shutdown(): Promise<void> {
    await flush();
    await adapter.shutdown();
  }

  return { emit, flush, shutdown };
}
