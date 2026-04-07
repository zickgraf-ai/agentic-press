import type { AuditStatus } from "../types.js";
import type { LangfuseConfig } from "./config.js";

/**
 * Opaque trace handle. The shape differs between the no-op tracer (which
 * returns a sentinel object) and the real tracer (which returns the SDK's
 * LangfuseTraceClient). Callers must treat it as opaque.
 */
export interface TraceHandle {
  readonly __traceHandle: true;
}

export interface StartTraceParams {
  readonly name: string;
  readonly sessionId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SpanToolCallParams {
  readonly tool: string;
  readonly status: AuditStatus;
  readonly durationMs: number;
  readonly flags?: readonly unknown[];
}

export interface EndTraceParams {
  readonly outcome: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface Tracer {
  startTrace(params: StartTraceParams): TraceHandle;
  spanToolCall(handle: TraceHandle, params: SpanToolCallParams): void;
  endTrace(handle: TraceHandle, params: EndTraceParams): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

const NOOP_HANDLE: TraceHandle = Object.freeze({
  __traceHandle: true as const,
  __noop: true as const,
}) as unknown as TraceHandle;

/**
 * No-op tracer used whenever Langfuse is disabled. Importantly, this code path
 * never imports the `langfuse` module — that keeps Langfuse a true optional
 * dependency for non-observability deployments.
 */
export function createNoopTracer(): Tracer {
  return {
    startTrace: () => NOOP_HANDLE,
    spanToolCall: () => {},
    endTrace: () => {},
    flush: async () => {},
    shutdown: async () => {},
  };
}

/**
 * Build a tracer from a LangfuseConfig.
 *
 * Design note: `createTracer` is async so the `langfuse` SDK can be loaded via
 * dynamic `import("langfuse")` only on the enabled path. Callers in the
 * composition root `await` it once at startup; the tracer methods themselves
 * are synchronous (except flush/shutdown) so they can be called freely from
 * the request hot-path without introducing per-request promise overhead.
 *
 * All SDK calls inside spanToolCall/endTrace are wrapped in try/catch and
 * failures are logged via console.warn — observability MUST NEVER break the
 * request path. This is intentional and tested.
 */
export async function createTracer(config: LangfuseConfig): Promise<Tracer> {
  if (!config.enabled) {
    return createNoopTracer();
  }

  // Dynamic import isolates the langfuse module to the enabled code path.
  const { Langfuse } = (await import("langfuse")) as {
    Langfuse: new (opts: { publicKey: string; secretKey: string; baseUrl: string }) => {
      trace: (body: Record<string, unknown>) => unknown;
      flushAsync: () => Promise<void>;
      shutdownAsync: () => Promise<void>;
    };
  };

  const client = new Langfuse({
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    baseUrl: config.host,
  });

  return {
    startTrace(params) {
      try {
        const trace = client.trace({
          name: params.name,
          sessionId: params.sessionId,
          metadata: params.metadata,
        });
        return trace as unknown as TraceHandle;
      } catch (err) {
        console.warn("[langfuse] startTrace failed:", err);
        return NOOP_HANDLE;
      }
    },
    spanToolCall(handle, params) {
      try {
        const trace = handle as unknown as { span: (body: Record<string, unknown>) => unknown };
        trace.span({
          name: "mcp.tool_call",
          metadata: {
            tool: params.tool,
            status: params.status,
            durationMs: params.durationMs,
            flags: params.flags ?? [],
          },
        });
      } catch (err) {
        console.warn("[langfuse] spanToolCall failed:", err);
      }
    },
    endTrace(handle, params) {
      try {
        const trace = handle as unknown as { update: (body: Record<string, unknown>) => unknown };
        trace.update({
          metadata: { outcome: params.outcome, ...(params.metadata ?? {}) },
        });
      } catch (err) {
        console.warn("[langfuse] endTrace failed:", err);
      }
    },
    async flush() {
      try {
        await client.flushAsync();
      } catch (err) {
        console.warn("[langfuse] flush failed:", err);
      }
    },
    async shutdown() {
      try {
        await client.shutdownAsync();
      } catch (err) {
        console.warn("[langfuse] shutdown failed:", err);
      }
    },
  };
}
