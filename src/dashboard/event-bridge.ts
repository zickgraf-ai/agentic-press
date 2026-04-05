export interface ProxyEvent {
  type: "tool_call" | "injection_flag" | "blocked" | "completed";
  timestamp: string;
  data: Record<string, unknown>;
}

export function pushEvent(_sessionId: string, _event: ProxyEvent): Promise<void> {
  throw new Error("Not implemented");
}
