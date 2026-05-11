import type { AuditStatus } from "../types.js";
import type { LangfuseConfig } from "./config.js";
import { childLogger } from "../logger.js";
import { probeLangfuseAuth } from "./langfuse-auth-probe.js";

const log = childLogger("langfuse");

// Type-only imports: elided at runtime so the v5 packages do not load when
// tracing is disabled. The packages live in optionalDependencies so a
// non-observability deployment can run without them being installed at all.
import type { LangfuseSpan } from "@langfuse/tracing";
import type { LangfuseClient as LangfuseClientType } from "@langfuse/client";
import type { NodeSDK as NodeSDKType } from "@opentelemetry/sdk-node";

/**
 * Opaque, active trace session returned by `Tracer.startTrace`. Its lifecycle
 * is enforced by construction:
 *
 *   - You cannot call `span()` or `end()` without first calling `startTrace`.
 *   - `end()` is idempotent — the underlying SDK's `update`/`end` are called
 *     at most once on success, so accidental double-ends (e.g. a deep success
 *     branch plus a defensive outer catch) are safe.
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
   * Reserved for sbx-session correlation. Phase 1 leaves this undefined; Phase
   * 2 multi-agent orchestration sets it from the dispatched agent's session.
   * When set, propagates to the trace as `session.id` so operators can group
   * all of an agent's tool-call traces in the Langfuse UI.
   */
  readonly sessionId?: string;
  /**
   * Reserved for agent-identity correlation. Phase 1 leaves this undefined;
   * Phase 2 sets it from the agent type or dispatched agent id. Propagates to
   * the trace as `user.id` for filtering and cost attribution.
   */
  readonly userId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /**
   * Trace-level input snapshot rendered in the Langfuse UI. The caller is
   * responsible for sanitization — never include raw `arguments` (could carry
   * injection text or PII). Recommended fields: `tool`, `requestId`,
   * `correlationId`, `method`.
   */
  readonly input?: unknown;
  /**
   * Initial trace tags. The wrapper appends `status:<status>` (set when
   * `span()` is called) and `outcome:<outcome>` (set when `end()` is called)
   * so operators can filter traces by pipeline outcome without cracking
   * metadata.
   */
  readonly tags?: readonly string[];
}

export interface SpanToolCallParams {
  readonly tool: string;
  readonly status: AuditStatus;
  readonly durationMs: number;
  readonly flags?: readonly string[];
}

export interface EndTraceParams {
  readonly outcome: AuditStatus;
  /** Output snapshot for the Langfuse UI Output column. Echo the outcome and any block reason. */
  readonly output?: unknown;
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
 * never imports any `@langfuse/*` or `@opentelemetry/*` module — that keeps
 * Langfuse a true optional dependency for non-observability deployments.
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
 * Runtime adapter type for the v5 `LangfuseSpan`. Consolidates the assumptions
 * about the SDK's runtime shape into a single place so an upstream change
 * surfaces as one type compile error rather than 15 silent runtime failures
 * scattered across the wrapper.
 */
interface LangfuseSpanRuntime {
  readonly otelSpan?: { setAttribute(key: string, value: unknown): void };
  startObservation(name: string, attrs: Record<string, unknown>): LangfuseSpanRuntime;
  update(attrs: Record<string, unknown>): void;
  end(): void;
}

interface LangfuseClientRuntime {
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * Build a tracer from a LangfuseConfig.
 *
 * Design note: `createTracer` is async so the v5 SDK packages are loaded via
 * dynamic `import()` only on the enabled path. Callers in the composition
 * root `await` it once at startup; the tracer methods themselves are
 * synchronous (except flush/shutdown) so they can be called freely from the
 * request hot-path without introducing per-request promise overhead.
 *
 * v5 SDK changes (versus v3):
 *   - The `langfuse` package is replaced by `@langfuse/tracing` (observation
 *     creation), `@langfuse/client` (lifecycle: flush/shutdown, scoring,
 *     prompts), `@langfuse/otel` (the `LangfuseSpanProcessor`), and
 *     `@langfuse/core` (the OTEL attribute key registry).
 *   - Tracing is OpenTelemetry-based — the SDK requires a registered OTEL
 *     `NodeSDK`. We register one inside this function so consumers don't
 *     need to know about OTEL.
 *   - `client.trace().span().update()` is replaced by `startObservation()`
 *     returning a `LangfuseSpan` with `.update()` and `.end()`.
 *   - Trace-level attributes (sessionId, userId, tags, input, output) are
 *     OTEL span attributes on the root observation, set via the underlying
 *     `otelSpan.setAttribute(...)` using the keys exported by `@langfuse/core`.
 *
 * All SDK calls inside span/end are wrapped in try/catch and failures are
 * logged via the structured logger — observability MUST NEVER break the
 * request path. This is intentional and tested.
 */
export async function createTracer(config: LangfuseConfig): Promise<Tracer> {
  if (!config.enabled) {
    return createNoopTracer();
  }

  // Dynamic imports isolate the v5 packages to the enabled code path.
  const tracingModule = await import("@langfuse/tracing");
  const clientModule = await import("@langfuse/client");
  const otelModule = await import("@langfuse/otel");
  const sdkNodeModule = await import("@opentelemetry/sdk-node");
  // @langfuse/core exposes the OTEL attribute key registry that LangfuseSpanProcessor reads.
  const coreModule = await import("@langfuse/core");

  const { startObservation, setLangfuseTracerProvider } = tracingModule;
  const { LangfuseClient } = clientModule as {
    LangfuseClient: new (opts: { publicKey: string; secretKey: string; baseUrl: string }) => LangfuseClientType;
  };
  const { LangfuseSpanProcessor } = otelModule;
  const { NodeSDK } = sdkNodeModule as { NodeSDK: new (opts: Record<string, unknown>) => NodeSDKType };

  // Trace-level attribute keys from @langfuse/core. Set on the underlying OTEL
  // span so they appear at the trace level in the Langfuse UI without
  // requiring a propagateAttributes() callback wrapper around the request
  // handler (which would force us to restructure server.ts).
  const ATTR = (coreModule as {
    LangfuseOtelSpanAttributes: {
      TRACE_NAME: string;
      TRACE_USER_ID: string;
      TRACE_SESSION_ID: string;
      TRACE_TAGS: string;
      TRACE_INPUT: string;
      TRACE_OUTPUT: string;
      TRACE_METADATA: string;
    };
  }).LangfuseOtelSpanAttributes;

  // Probe is informational; never disables tracing on failure (operator can
  // fix env and the tracer resumes without a restart).
  const probe = await probeLangfuseAuth({
    host: config.host,
    publicKey: config.publicKey,
    secretKey: config.secretKey,
  });
  if (probe.ok) {
    log.info(
      { host: config.host, ...(probe.projectId ? { projectId: probe.projectId } : {}) },
      "Langfuse credentials verified at startup"
    );
  } else if (probe.reason === "auth") {
    log.error(
      { host: config.host, status: probe.status },
      "Langfuse credentials rejected (HTTP " +
        probe.status +
        ") — likely region mismatch. Check that LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY match the region of LANGFUSE_HOST. Traces will not upload until corrected."
    );
  } else if (probe.reason === "unexpected-shape") {
    log.error(
      { host: config.host, status: probe.status },
      "Langfuse host responded 2xx but the body wasn't a recognized projects payload — LANGFUSE_HOST may point at a captive portal or the wrong service. Traces will not upload until corrected."
    );
  } else {
    log.warn(
      { host: config.host, reason: probe.reason },
      "Langfuse credential probe could not complete (" +
        probe.reason +
        ") — proceeding with tracer setup; the probe failure may be transient."
    );
  }

  // OTEL NodeSDK setup. The LangfuseSpanProcessor batches observations and
  // uploads them to Langfuse on flush/shutdown. Failure here means we cannot
  // trace; we throw so the outer try/catch in src/index.ts falls back to the
  // no-op tracer (preserves "observability never breaks startup").
  const spanProcessor = new LangfuseSpanProcessor({
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    baseUrl: config.host,
  });

  const sdk = new NodeSDK({ spanProcessors: [spanProcessor] });
  sdk.start();

  // Wire the SDK's tracer provider into @langfuse/tracing so startObservation()
  // creates spans on our LangfuseSpanProcessor's pipeline.
  //
  // We considered using the public `trace.getTracerProvider()` from
  // `@opentelemetry/api`, but that returns a `ProxyTracerProvider`
  // wrapper rather than the underlying `NodeTracerProvider` that the span
  // processor was attached to. Passing the proxy to setLangfuseTracerProvider
  // produces a hollow tracer and traces silently fail to reach Langfuse —
  // verified empirically. There is no public method on ProxyTracerProvider
  // to unwrap to the delegate.
  //
  // So we read NodeSDK's `_tracerProvider` field directly. The leading
  // underscore signals this is private API; if @opentelemetry/sdk-node renames
  // or removes it in a 0.x bump, we will warn LOUDLY instead of failing
  // silently — operators see "spans will not reach Langfuse" in stdout
  // immediately rather than discovering empty traces hours later.
  const provider = (sdk as unknown as { _tracerProvider?: unknown })._tracerProvider;
  if (provider) {
    setLangfuseTracerProvider(provider as Parameters<typeof setLangfuseTracerProvider>[0]);
  } else {
    log.warn(
      "NodeSDK._tracerProvider is undefined — spans will not reach Langfuse. " +
        "This may indicate an incompatible @opentelemetry/sdk-node version " +
        "(this is a private field; check the upgrade path before bumping the SDK)."
    );
  }

  // The client is only needed for lifecycle (flush, shutdown). Observation
  // creation goes through @langfuse/tracing which uses the OTEL provider.
  const client = new LangfuseClient({
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    baseUrl: config.host,
  }) as unknown as LangfuseClientRuntime;

  // One-shot warning when the runtime SDK shape diverges from our adapter
  // expectations (otelSpan is the only optional field in the adapter and
  // the most common drift point). Keeps the per-request hot path silent.
  let warnedMissingOtelSpan = false;
  function maybeWarnMissingOtelSpan(rootObs: LangfuseSpanRuntime) {
    if (!rootObs.otelSpan && !warnedMissingOtelSpan) {
      log.warn(
        "rootObs.otelSpan is undefined — trace enrichment (input/output/tags/sessionId/userId) " +
          "will not be attached. This may indicate an incompatible @langfuse/tracing version."
      );
      warnedMissingOtelSpan = true;
    }
  }

  return {
    startTrace(params) {
      let rootObs: LangfuseSpanRuntime | undefined;
      try {
        rootObs = startObservation(params.name, {
          input: params.input,
          metadata: params.metadata,
        }) as unknown as LangfuseSpanRuntime;

        maybeWarnMissingOtelSpan(rootObs);

        const otelSpan = rootObs.otelSpan;
        if (otelSpan) {
          otelSpan.setAttribute(ATTR.TRACE_NAME, params.name);
          if (params.sessionId) otelSpan.setAttribute(ATTR.TRACE_SESSION_ID, params.sessionId);
          if (params.userId) otelSpan.setAttribute(ATTR.TRACE_USER_ID, params.userId);
          if (params.tags && params.tags.length > 0) {
            otelSpan.setAttribute(ATTR.TRACE_TAGS, JSON.stringify(params.tags));
          }
          if (params.input !== undefined) {
            otelSpan.setAttribute(ATTR.TRACE_INPUT, safeSerialize(params.input));
          }
        }
      } catch (err) {
        log.warn({ err }, "startTrace failed");
        // Return the no-op sentinel so the caller doesn't need to distinguish
        // "tracing disabled" from "tracing failed to start this request".
        return NOOP_ACTIVE_TRACE;
      }

      let ended = false;
      // Tags accumulated across span() and end() calls; written to TRACE_TAGS
      // at end() time. Initial caller-provided tags seed the array.
      const accumulatedTags: string[] = params.tags ? [...params.tags] : [];

      const active: ActiveTrace = {
        span(spanParams: SpanToolCallParams) {
          if (ended || !rootObs) return;
          try {
            // Create a child observation `mcp.tool_call` with stage decision
            // metadata, then end it immediately. This preserves the v3 trace
            // tree shape (root trace + one child span) operators expect.
            const child = rootObs.startObservation("mcp.tool_call", {
              metadata: {
                tool: spanParams.tool,
                status: spanParams.status,
                durationMs: spanParams.durationMs,
                flags: spanParams.flags ?? [],
              },
            });
            child.end();
            // Track the status as a tag on the trace.
            accumulatedTags.push(`status:${spanParams.status}`);
          } catch (err) {
            log.warn({ err }, "span failed");
          }
        },
        end(endParams: EndTraceParams) {
          if (ended || !rootObs) return;
          // C3 fix: only mark `ended` after the SDK calls succeed. If
          // rootObs.update() succeeds but rootObs.end() throws, leaving
          // `ended = false` allows server.ts's outer catch to retry; OTEL
          // span.end() is idempotent so a retry is safe.
          try {
            rootObs.update({
              output: endParams.output,
              metadata: { outcome: endParams.outcome, ...(endParams.metadata ?? {}) },
            });
            const otelSpan = rootObs.otelSpan;
            if (otelSpan) {
              accumulatedTags.push(`outcome:${endParams.outcome}`);
              otelSpan.setAttribute(ATTR.TRACE_TAGS, JSON.stringify(accumulatedTags));
              if (endParams.output !== undefined) {
                otelSpan.setAttribute(ATTR.TRACE_OUTPUT, safeSerialize(endParams.output));
              }
            }
            rootObs.end();
            ended = true;
          } catch (err) {
            log.warn({ err }, "end failed");
          }
        },
      } as unknown as ActiveTrace;
      return active;
    },
    async flush() {
      try {
        await client.flush();
      } catch (err) {
        log.warn({ err }, "flush failed");
      }
    },
    async shutdown() {
      // Order matters: (1) client.flush() pushes any client-buffered data;
      // (2) sdk.shutdown() force-flushes the OTEL span processor's queue so
      // pending spans reach Langfuse before exit; (3) client.shutdown() closes
      // the LangfuseClient. Each phase has its own per-call timeout so a
      // single hanging upstream cannot starve later phases of the caller's
      // global shutdown budget (reviewer I2). 1s per phase is generous for
      // a healthy network and tight enough that the global 3s window in
      // src/index.ts still has headroom for the other observability layers.
      await raceWithTimeout(
        client.flush().catch((err) => log.warn({ err }, "client.flush failed during shutdown")),
        1000,
        "client.flush timed out during shutdown"
      );
      await raceWithTimeout(
        sdk.shutdown().catch((err) => log.warn({ err }, "OTEL sdk.shutdown failed")),
        1000,
        "OTEL sdk.shutdown timed out"
      );
      await raceWithTimeout(
        client.shutdown().catch((err) => log.warn({ err }, "client.shutdown failed")),
        1000,
        "client.shutdown timed out"
      );
    },
  };
}

/**
 * Best-effort serialization for OTEL attribute values, which must be primitives
 * or arrays of primitives. Strings pass through unchanged; objects get
 * JSON.stringify; circular refs / BigInts / non-serializable values fall
 * through to a string marker so a non-serializable value never breaks the
 * trace path.
 */
function safeSerialize(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch (err) {
    // Debug-level so operators have breadcrumbs without the request path
    // logging on every miss.
    log.debug({ err }, "safeSerialize: JSON.stringify failed");
    return "[unserializable]";
  }
}

/**
 * Race a promise against a timeout. Resolves on whichever finishes first; if
 * the timeout fires first, logs a warning and resolves so the caller is not
 * blocked. Used in shutdown to bound each phase independently — a single
 * hanging upstream must not starve later phases of the global shutdown budget.
 */
async function raceWithTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      log.warn({ timeoutMs: ms }, message);
      resolve();
    }, ms);
    timer.unref();
  });
  try {
    await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
