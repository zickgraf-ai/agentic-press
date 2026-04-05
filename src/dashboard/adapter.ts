import type { SessionId, SandboxId } from "../types.js";

export type SessionStatus = "active" | "completed" | "failed";

export interface DashboardSession {
  readonly id: SessionId;
  readonly sandboxName: SandboxId;
  readonly startedAt: string;
  readonly status: SessionStatus;
}

export function registerSession(
  _sandboxName: SandboxId,
  _taskDescription?: string
): Promise<DashboardSession> {
  throw new Error("Not implemented");
}

export function updateSessionStatus(
  _sessionId: SessionId,
  _status: SessionStatus
): Promise<void> {
  throw new Error("Not implemented");
}
