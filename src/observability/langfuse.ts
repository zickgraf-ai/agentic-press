export interface TraceContext {
  traceId: string;
  sessionId: string;
}

export function startTrace(
  _sessionId: string,
  _metadata?: Record<string, unknown>
): TraceContext {
  throw new Error("Not implemented");
}

export function spanToolCall(
  _ctx: TraceContext,
  _toolName: string,
  _args: unknown,
  _durationMs: number,
  _status: string,
  _flags?: string[]
): void {
  throw new Error("Not implemented");
}

export function endTrace(_ctx: TraceContext): void {
  throw new Error("Not implemented");
}
