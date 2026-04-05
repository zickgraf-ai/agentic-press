import type { TraceId, SessionId, AuditStatus } from "../types.js";

export interface TraceContext {
  readonly traceId: TraceId;
  readonly sessionId: SessionId;
}

export function startTrace(
  _sessionId: SessionId,
  _metadata?: Readonly<Record<string, unknown>>
): TraceContext {
  throw new Error("Not implemented");
}

export function spanToolCall(
  _ctx: TraceContext,
  _toolName: string,
  _args: unknown,
  _durationMs: number,
  _status: AuditStatus,
  _flags?: readonly string[]
): void {
  throw new Error("Not implemented");
}

export function endTrace(_ctx: TraceContext): void {
  throw new Error("Not implemented");
}
