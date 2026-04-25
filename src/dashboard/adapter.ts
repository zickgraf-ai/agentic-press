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
}

export interface DashboardAdapter {
  registerSession(sandboxName: SandboxId, taskDescription?: string): Promise<DashboardSession>;
  updateSessionStatus(sessionId: SessionId, status: SessionStatus): Promise<void>;
  pushActivity(event: ActivityEvent): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * No-op adapter returned when the dashboard is disabled. Every method resolves
 * immediately — zero allocations per call on the hot path.
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
        role: "sandbox-agent",
        ...(taskDescription ? { description: taskDescription } : {}),
      };

      const res = await safeFetch(`${config.url}/api/agents/register`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(body),
      });

      const id = res?.ok
        ? ((await res.json()) as { id: string }).id
        : `fallback-${Date.now()}`;

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
      await safeFetch(`${config.url}/api/activities`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(event),
      });
    },

    async shutdown(): Promise<void> {},
  };
}
