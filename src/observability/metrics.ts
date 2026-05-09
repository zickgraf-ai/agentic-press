import express, { type Express, type Request, type Response } from "express";
import type { AuditStatus } from "../types.js";
import type { MetricsConfig } from "./config.js";
import { childLogger } from "../logger.js";
// Type-only import: elided at runtime so it does not pull in `prom-client`
// when metrics are disabled. `prom-client` lives in optionalDependencies.
import type { Counter, Histogram, Registry } from "prom-client";

const log = childLogger("metrics");

/** Block reason categories — closed union so cardinality is bounded and typos fail at compile time. */
export type BlockReason = "allowlist" | "path_guard" | "no_route" | "unknown";

/**
 * Sentinel `agentType` label value used when no X-Agent-Type header was sent.
 * Keeping the label present in every series — rather than emitting two
 * different series shapes depending on whether the header was set — means
 * Prometheus queries can group/sum over `agentType` without special-casing.
 *
 * Cardinality is operator-controlled via the X-Agent-Type charset/length
 * limits enforced by the proxy's identity-header parser, so the label set
 * stays bounded.
 */
export const AGENT_TYPE_UNSPECIFIED = "unspecified";

export interface MetricsRecorder {
  /**
   * Record one terminal pipeline outcome.
   *
   * `agentType` is the optional value of the X-Agent-Type header carried
   * through from the proxy's audit pipeline (Tier 1.2 / #53). When undefined
   * the recorder labels the series with `AGENT_TYPE_UNSPECIFIED` so Prometheus
   * sees the same label set on every emitted series.
   */
  recordRequest(tool: string, status: AuditStatus, durationMs: number, agentType?: string): void;
  recordInjectionFlag(pattern: string): void;
  recordBlockedRequest(reason: BlockReason): void;
  metricsText(): Promise<{ contentType: string; body: string }>;
  /** Idempotent — safe to call more than once during shutdown. */
  shutdown(): Promise<void>;
}

/**
 * Singleton no-op recorder. Returned when metrics are disabled. Frozen so
 * the disabled hot path allocates nothing per request.
 */
const NOOP_RECORDER: MetricsRecorder = Object.freeze({
  recordRequest: () => {},
  recordInjectionFlag: () => {},
  recordBlockedRequest: () => {},
  metricsText: async () => ({ contentType: "text/plain; version=0.0.4; charset=utf-8", body: "" }),
  shutdown: async () => {},
});

export function createNoopRecorder(): MetricsRecorder {
  return NOOP_RECORDER;
}

/** Exposed for tests that want to assert the disabled path returns the sentinel. */
export function getNoopRecorder(): MetricsRecorder {
  return NOOP_RECORDER;
}

/**
 * Build a MetricsRecorder from a MetricsConfig.
 *
 * Async because `prom-client` is loaded via dynamic import on the enabled
 * path only; the no-op path resolves synchronously. Composition root awaits
 * once at startup; record methods themselves are synchronous so they can be
 * called from the request hot path without per-request promise overhead.
 *
 * All prom-client calls inside record methods are wrapped in try/catch and
 * failures are logged via the structured logger — observability MUST NEVER
 * break the request path.
 */
export async function createMetricsRecorder(config: MetricsConfig): Promise<MetricsRecorder> {
  if (!config.enabled) {
    return NOOP_RECORDER;
  }

  // Dynamic import isolates prom-client to the enabled code path.
  const promClient = (await import("prom-client")) as {
    Counter: new (opts: { name: string; help: string; labelNames: readonly string[]; registers: Registry[] }) => Counter<string>;
    Histogram: new (opts: { name: string; help: string; labelNames: readonly string[]; buckets?: number[]; registers: Registry[] }) => Histogram<string>;
    Registry: new () => Registry;
    collectDefaultMetrics: (opts: { register: Registry }) => void;
  };

  const register = new promClient.Registry();

  const requestCounter = new promClient.Counter({
    name: "mcp_proxy_requests_total",
    help: "Total MCP proxy requests, partitioned by tool, status, and agentType",
    labelNames: ["tool", "status", "agentType"],
    registers: [register],
  });

  const requestDuration = new promClient.Histogram({
    name: "mcp_proxy_request_duration_seconds",
    help: "MCP proxy request duration in seconds, partitioned by tool, status, and agentType",
    labelNames: ["tool", "status", "agentType"],
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
    registers: [register],
  });

  const injectionCounter = new promClient.Counter({
    name: "mcp_proxy_injection_flags_total",
    help: "Total injection patterns flagged by the sanitizer, partitioned by pattern",
    labelNames: ["pattern"],
    registers: [register],
  });

  const blockedCounter = new promClient.Counter({
    name: "mcp_proxy_blocked_total",
    help: "Total requests blocked by the proxy, partitioned by block reason",
    labelNames: ["reason"],
    registers: [register],
  });

  // Default Node.js process metrics (cpu, memory, event loop, gc, etc.)
  promClient.collectDefaultMetrics({ register });

  return {
    recordRequest(tool, status, durationMs, agentType) {
      const labels = { tool, status, agentType: agentType ?? AGENT_TYPE_UNSPECIFIED };
      try {
        requestCounter.inc(labels);
        requestDuration.observe(labels, durationMs / 1000);
      } catch (err) {
        log.warn({ err }, "recordRequest failed (ignored)");
      }
    },
    recordInjectionFlag(pattern) {
      try {
        injectionCounter.inc({ pattern });
      } catch (err) {
        log.warn({ err }, "recordInjectionFlag failed (ignored)");
      }
    },
    recordBlockedRequest(reason) {
      try {
        blockedCounter.inc({ reason });
      } catch (err) {
        log.warn({ err }, "recordBlockedRequest failed (ignored)");
      }
    },
    async metricsText() {
      return {
        contentType: register.contentType,
        body: await register.metrics(),
      };
    },
    async shutdown() {
      try {
        register.clear();
      } catch (err) {
        log.warn({ err }, "registry.clear failed (ignored)");
      }
    },
  };
}

/**
 * Build a tiny Express app that exposes `GET /metrics` returning prom-format
 * text. Caller binds it via `.listen(port)`. Bound separately from the MCP
 * proxy so metrics traffic is isolated and can be exposed on a different port
 * (typically 9090, scraped by Grafana Alloy / Prometheus).
 */
export function createMetricsServer(recorder: MetricsRecorder): Express {
  const app = express();
  app.get("/metrics", async (_req: Request, res: Response) => {
    try {
      const out = await recorder.metricsText();
      res.setHeader("Content-Type", out.contentType);
      res.send(out.body);
    } catch (err) {
      log.warn({ err }, "metrics endpoint failed");
      res.status(500).send("# metrics unavailable\n");
    }
  });
  return app;
}
