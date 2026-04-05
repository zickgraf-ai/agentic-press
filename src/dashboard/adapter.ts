export interface DashboardSession {
  id: string;
  sandboxName: string;
  startedAt: string;
  status: "active" | "completed" | "failed";
}

export function registerSession(
  _sandboxName: string,
  _taskDescription?: string
): Promise<DashboardSession> {
  throw new Error("Not implemented");
}

export function updateSessionStatus(
  _sessionId: string,
  _status: DashboardSession["status"]
): Promise<void> {
  throw new Error("Not implemented");
}
