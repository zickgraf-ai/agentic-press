import type { SessionId, SandboxId, AuditStatus } from "../types.js";
import { childLogger } from "../logger.js";

const log = childLogger("dashboard");

export type SessionStatus = "active" | "completed" | "failed";

export interface DashboardSession {
  readonly id: SessionId;
  readonly sandboxName: SandboxId;
  readonly startedAt: string;
  readonly status: SessionStatus;
}

export interface ActivityEvent {
  readonly type: "tool_call" | "injection_flag" | "blocked" | "error";
  readonly tool: string;
  readonly timestamp: string;
  readonly status: AuditStatus;
  readonly durationMs?: number;
  readonly flags?: readonly string[];
  readonly errorMessage?: string;
  /**
   * Phase 2 Tier 1.2 (#53): per-agent identity. Both optional. When set,
   * `agentType` becomes MC's `agent_name` so the Tasks / Activity panels can
   * demultiplex per agent role; `sessionId` is included in the event payload
   * so MC can group activity by session.
   */
  readonly sessionId?: string;
  readonly agentType?: string;
}

/**
 * Default agent name MC sees when an event has no agentType. Kept here as a
 * single export so the upcoming MC connection adapter (Tier 2.A) can register
 * with the same name and the kanban board attribution stays consistent.
 */
export const DEFAULT_AGENT_NAME = "agentic-press-proxy";

export interface DashboardAdapter {
  registerSession(sandboxName: SandboxId, taskDescription?: string): Promise<DashboardSession>;
  updateSessionStatus(sessionId: SessionId, status: SessionStatus): Promise<void>;
  pushActivity(event: ActivityEvent): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * No-op adapter returned when the dashboard is disabled. Methods resolve
 * immediately with stub values; no network I/O occurs.
 */
export function createNoopAdapter(): DashboardAdapter {
  return {
    async registerSession(sandboxName: SandboxId): Promise<DashboardSession> {
      return {
        id: "noop" as SessionId,
        sandboxName,
        startedAt: new Date().toISOString(),
        status: "active",
      };
    },
    async updateSessionStatus(): Promise<void> {},
    async pushActivity(): Promise<void> {},
    async shutdown(): Promise<void> {},
  };
}

/**
 * Mission Control REST adapter. Calls the MC REST API to register agents,
 * update status, and push activity events. Every `fetch` is wrapped in
 * try/catch — dashboard errors MUST NEVER break the request path.
 *
 * Accepts an optional `fetchImpl` parameter for dependency injection in tests.
 */
export function createMissionControlAdapter(
  config: { url: string; apiKey?: string },
  fetchImpl: typeof fetch = globalThis.fetch
): DashboardAdapter {
  function headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (config.apiKey) {
      h["Authorization"] = `Bearer ${config.apiKey}`;
    }
    return h;
  }

  async function safeFetch(url: string, init: RequestInit): Promise<Response | undefined> {
    try {
      const res = await fetchImpl(url, init);
      if (!res.ok) {
        log.warn({ url, status: res.status, statusText: res.statusText }, "Mission Control request failed");
      }
      return res;
    } catch (err) {
      log.warn({ err, url }, "Mission Control request error");
      return undefined;
    }
  }

  return {
    async registerSession(sandboxName: SandboxId, taskDescription?: string): Promise<DashboardSession> {
      const body = {
        name: sandboxName,
        role: "agent",
        ...(taskDescription ? { description: taskDescription } : {}),
      };

      const res = await safeFetch(`${config.url}/api/agents/register`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(body),
      });

      let id: string;
      try {
        const parsed = res?.ok ? (await res.json()) as Record<string, unknown> : undefined;
        id = typeof parsed?.id === "string" ? parsed.id : `fallback-${Date.now()}`;
      } catch {
        log.warn("Failed to parse registerSession response — using fallback ID");
        id = `fallback-${Date.now()}`;
      }
      if (id.startsWith("fallback-")) {
        log.warn({ sandboxName }, "Mission Control session registration degraded — using fallback ID");
      }

      return {
        id: id as SessionId,
        sandboxName,
        startedAt: new Date().toISOString(),
        status: "active",
      };
    },

    async updateSessionStatus(sessionId: SessionId, status: SessionStatus): Promise<void> {
      await safeFetch(`${config.url}/api/agents/${sessionId}`, {
        method: "PUT",
        headers: headers(),
        body: JSON.stringify({ status }),
      });
    },

    async pushActivity(event: ActivityEvent): Promise<void> {
      // MC's /api/hermes/events is the write endpoint for agent lifecycle
      // events — it persists to the activities table and broadcasts via SSE.
      // /api/activities is read-only (405 on POST).
      //
      // Tier 1.2 identity propagation:
      //   - agent_name uses event.agentType when set so MC's panels show
      //     per-role activity (e.g. all "reviewer" activity grouped). Falls
      //     back to DEFAULT_AGENT_NAME when no agent type was passed —
      //     preserves Phase 1 behaviour for headerless callers.
      //   - data.session_id carries event.sessionId when set so MC can group
      //     events by task/session in its Activity views. Omitted entirely
      //     when absent (no `session_id: undefined` noise).
      await safeFetch(`${config.url}/api/hermes/events`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          event: `tool:${event.type}`,
          agent_name: event.agentType ?? DEFAULT_AGENT_NAME,
          source: "mcp-proxy",
          timestamp: event.timestamp,
          data: {
            tool: event.tool,
            status: event.status,
            durationMs: event.durationMs,
            flags: event.flags,
            errorMessage: event.errorMessage,
            ...(event.sessionId !== undefined ? { session_id: event.sessionId } : {}),
          },
        }),
      });
    },

    async shutdown(): Promise<void> {},
  };
}
