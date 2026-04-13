import type { AuditStatus } from "../types.js";
import type { LangfuseConfig } from "./config.js";
import { childLogger } from "../logger.js";

const log = childLogger("langfuse");
// Type-only import: elided at runtime so it does not pull the `langfuse`
// module in when tracing is disabled. `langfuse` lives in optionalDependencies,
// but TypeScript resolves type-only imports against whatever is present in
// node_modules at compile time, so we still get compile-time safety.
import type { LangfuseTraceClient } from "langfuse";

/**
 * Opaque, active trace session returned by `Tracer.startTrace`. Its lifecycle
 * is enforced by construction:
 *
 *   - You cannot call `span()` or `end()` without first calling `startTrace`.
 *   - `end()` is idempotent — the underlying SDK's update is called at most
 *     once, so accidental double-ends (e.g. a deep success branch plus a
 *     defensive outer catch) are safe.
 *   - `span()` and `end()` each catch their own exceptions internally. A
 *     misbehaving tracer cannot surface an error back into the request path.
 *
 * Branded so external modules cannot forge an ActiveTrace by constructing an
 * object literal — only this module produces values that satisfy the type.
 */
declare const activeTraceBrand: unique symbol;
export interface ActiveTrace {
  readonly [activeTraceBrand]: true;
  span(params: SpanToolCallParams): void;
  end(params: EndTraceParams): void;
}

export interface StartTraceParams {
  readonly name: string;
  /**
   * Reserved for future session grouping. Currently unused by the MCP proxy —
   * each request is an independent trace. Kept in the type so we can wire in
   * real session semantics (e.g. sbx session id) without a breaking change.
   */
  readonly sessionId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SpanToolCallParams {
  readonly tool: string;
  readonly status: AuditStatus;
  readonly durationMs: number;
  readonly flags?: readonly string[];
}

export interface EndTraceParams {
  readonly outcome: AuditStatus;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface Tracer {
  startTrace(params: StartTraceParams): ActiveTrace;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * Singleton no-op ActiveTrace. The no-op tracer returns this frozen sentinel
 * from every startTrace call so the disabled path allocates nothing per
 * request. Span/end are unconditional no-ops; the cached identity is also
 * useful for equality assertions in tests.
 */
const NOOP_ACTIVE_TRACE: ActiveTrace = Object.freeze({
  span: () => {},
  end: () => {},
}) as unknown as ActiveTrace;

/**
 * No-op tracer used whenever Langfuse is disabled. Importantly, this code path
 * never imports the `langfuse` module — that keeps Langfuse a true optional
 * dependency for non-observability deployments.
 */
export function createNoopTracer(): Tracer {
  return {
    startTrace: () => NOOP_ACTIVE_TRACE,
    flush: async () => {},
    shutdown: async () => {},
  };
}

/** Exposed for tests that want to assert the disabled path returns the sentinel. */
export function getNoopActiveTrace(): ActiveTrace {
  return NOOP_ACTIVE_TRACE;
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
 * All SDK calls inside span/end are wrapped in try/catch and failures are
 * logged via the structured logger — observability MUST NEVER break the request path.
 * This is intentional and tested.
 */
export async function createTracer(config: LangfuseConfig): Promise<Tracer> {
  if (!config.enabled) {
    return createNoopTracer();
  }

  // Dynamic import isolates the langfuse module to the enabled code path.
  const { Langfuse } = (await import("langfuse")) as {
    Langfuse: new (opts: { publicKey: string; secretKey: string; baseUrl: string }) => {
      trace: (body: Record<string, unknown>) => LangfuseTraceClient;
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
      let traceClient: LangfuseTraceClient | undefined;
      try {
        traceClient = client.trace({
          name: params.name,
          sessionId: params.sessionId,
          metadata: params.metadata,
        });
      } catch (err) {
        log.warn({ err }, "startTrace failed");
        // Return the no-op sentinel so the caller doesn't need to distinguish
        // "tracing disabled" from "tracing failed to start this request".
        return NOOP_ACTIVE_TRACE;
      }

      let ended = false;
      const active: ActiveTrace = {
        span(spanParams: SpanToolCallParams) {
          if (ended) return;
          try {
            // `span` exists on LangfuseTraceClient at runtime; we narrow via a
            // minimal local type so we don't rely on the full SDK surface.
            (traceClient as unknown as {
              span: (body: Record<string, unknown>) => unknown;
            }).span({
              name: "mcp.tool_call",
              metadata: {
                tool: spanParams.tool,
                status: spanParams.status,
                durationMs: spanParams.durationMs,
                flags: spanParams.flags ?? [],
              },
            });
          } catch (err) {
            log.warn({ err }, "span failed");
          }
        },
        end(endParams: EndTraceParams) {
          if (ended) return;
          ended = true;
          try {
            (traceClient as unknown as {
              update: (body: Record<string, unknown>) => unknown;
            }).update({
              metadata: { outcome: endParams.outcome, ...(endParams.metadata ?? {}) },
            });
          } catch (err) {
            log.warn({ err }, "end failed");
          }
        },
      } as unknown as ActiveTrace;
      return active;
    },
    async flush() {
      try {
        await client.flushAsync();
      } catch (err) {
        log.warn({ err }, "flush failed");
      }
    },
    async shutdown() {
      try {
        await client.shutdownAsync();
      } catch (err) {
        log.warn({ err }, "shutdown failed");
      }
    },
  };
}
