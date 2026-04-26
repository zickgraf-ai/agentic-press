import { createProxyServer, type ProxyServerConfig } from "./mcp-proxy/server.js";
import { createStdioBridge } from "./mcp-proxy/stdio-bridge.js";
import { createHttpBridge } from "./mcp-proxy/http-bridge.js";
import {
  createCompositeTransport,
  type McpTransport,
  type McpStdioServerDef,
  type McpHttpServerDef,
} from "./mcp-proxy/transport.js";
import { parseLogLevel } from "./types.js";
import { childLogger } from "./logger.js";
import { loadLangfuseConfig, loadMetricsConfig } from "./observability/config.js";
import { createTracer, createNoopTracer, type Tracer } from "./observability/langfuse.js";
import {
  createMetricsRecorder,
  createMetricsServer,
  createNoopRecorder,
  type MetricsRecorder,
} from "./observability/metrics.js";
import { loadDashboardConfig } from "./dashboard/config.js";
import { createNoopAdapter, createMissionControlAdapter } from "./dashboard/adapter.js";
import { createNoopEventBridge, createEventBridge, type EventBridge } from "./dashboard/event-bridge.js";
import {
  parseServerDefs,
  parseServerRoutes,
  validateServerConfig,
  parseMaxResponseBytes,
} from "./server-config.js";

const log = childLogger("main");

const logLevel = parseLogLevel(process.env.LOG_LEVEL);
const serverDefs = parseServerDefs(process.env.MCP_SERVERS);
const serverRoutes = parseServerRoutes(process.env.SERVER_ROUTES);
validateServerConfig(serverDefs, serverRoutes);
let bridge: McpTransport | undefined;

// MAX_RESPONSE_BYTES caps the size of any single upstream MCP response line.
// Stdio enforces it at the read layer (pre-parse); HTTP enforces it after
// receiving the body but before JSON.parse. 0 disables the cap. Parser is
// fail-loud on invalid input — silently falling back to the default would
// mask a typo in env config and re-expose the OOM surface this guard closes.
const maxResponseBytes = parseMaxResponseBytes(process.env.MAX_RESPONSE_BYTES);

// Partition server defs by transport. Each gets its own bridge implementation;
// a composite transport routes call(serverName, ...) to the owning bridge.
const stdioServers = serverDefs.filter((s): s is McpStdioServerDef => s.transport === "stdio");
const httpServers = serverDefs.filter((s): s is McpHttpServerDef => s.transport === "http");

if (serverDefs.length > 0) {
  const routes: { bridge: McpTransport; owns: string[] }[] = [];
  if (stdioServers.length > 0) {
    const stdioBridge = createStdioBridge(stdioServers, { logLevel, maxResponseBytes });
    routes.push({ bridge: stdioBridge, owns: stdioServers.map((s) => s.name) });
    log.info(
      {
        serverCount: stdioServers.length,
        servers: stdioServers.map((s) => s.name),
        maxResponseBytes,
      },
      "Stdio bridge created"
    );
  }
  if (httpServers.length > 0) {
    const httpBridge = createHttpBridge(httpServers, { maxResponseBytes });
    routes.push({ bridge: httpBridge, owns: httpServers.map((s) => s.name) });
    log.info(
      {
        serverCount: httpServers.length,
        servers: httpServers.map((s) => ({ name: s.name, url: s.url })),
        maxResponseBytes,
      },
      "HTTP bridge created"
    );
  }
  bridge = routes.length === 1 ? routes[0]!.bridge : createCompositeTransport(routes);
}

const port = parseInt(process.env.MCP_PROXY_PORT ?? "18923", 10);
if (isNaN(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid MCP_PROXY_PORT: "${process.env.MCP_PROXY_PORT}" — must be 1-65535`);
}

// Build the tracer up-front. createTracer is async because the langfuse SDK
// is loaded via dynamic import on the enabled path; the no-op path resolves
// synchronously so this top-level await is effectively free when disabled.
//
// Startup must never fail because of observability: if createTracer throws
// (e.g. the langfuse SDK fails to load), fall back to the no-op tracer and
// keep the proxy serving. This is consistent with the "observability must
// never break the request path" invariant.
const langfuseConfig = loadLangfuseConfig(process.env);
let tracer: Tracer;
try {
  tracer = await createTracer(langfuseConfig);
  if (langfuseConfig.enabled) {
    log.info({ host: langfuseConfig.host }, "Langfuse tracing enabled");
  }
} catch (err) {
  log.warn({ err }, "createTracer failed at startup — falling back to no-op tracer");
  tracer = createNoopTracer();
}

// Metrics (Prometheus) — same pattern: opt-in via METRICS_PORT, no-op when
// disabled, startup never fails. Metrics expose on a separate Express server
// (typically port 9090) so the scrape surface is isolated from MCP traffic.
const metricsConfig = loadMetricsConfig(process.env);
let recorder: MetricsRecorder;
let metricsHttpServer: import("node:http").Server | undefined;
try {
  recorder = await createMetricsRecorder(metricsConfig);
  if (metricsConfig.enabled) {
    const metricsApp = createMetricsServer(recorder);
    // Default 127.0.0.1 — process metrics (heap, gc, cpu) are sensitive and
    // shouldn't be exposed on every interface by default. Operators who need
    // network-wide scrape (Grafana Alloy in another container) override with
    // METRICS_BIND=0.0.0.0.
    const metricsBind = process.env.METRICS_BIND?.trim() || "127.0.0.1";
    metricsHttpServer = metricsApp.listen(metricsConfig.port, metricsBind, () => {
      log.info({ port: metricsConfig.port, bind: metricsBind }, "Prometheus metrics endpoint listening on /metrics");
    });
    // listen() emits async error events (EADDRINUSE, EACCES) that escape the
    // surrounding try/catch. Without this handler the whole process crashes —
    // breaking the "observability must never break the request path" invariant.
    metricsHttpServer.on("error", (err) => {
      log.warn({ err, port: metricsConfig.port }, "Metrics HTTP server failed to bind — metrics disabled, proxy continues");
      metricsHttpServer = undefined;
    });
  }
} catch (err) {
  log.warn({ err }, "createMetricsRecorder failed at startup — falling back to no-op recorder");
  recorder = createNoopRecorder();
}

// Dashboard (Mission Control) — same pattern as Langfuse: opt-in, no-op when
// not configured, startup must never fail because of the dashboard.
const dashboardConfig = loadDashboardConfig(process.env);
let eventBridge: EventBridge;
try {
  if (dashboardConfig.enabled) {
    const adapter = createMissionControlAdapter({ url: dashboardConfig.url, apiKey: dashboardConfig.apiKey });
    eventBridge = createEventBridge(adapter);
    log.info({ url: dashboardConfig.url }, "Mission Control dashboard enabled");
  } else {
    eventBridge = createNoopEventBridge();
  }
} catch (err) {
  log.warn({ err }, "Dashboard init failed at startup — falling back to no-op event bridge");
  eventBridge = createNoopEventBridge();
}

const config: ProxyServerConfig = {
  port,
  allowedTools: (process.env.ALLOWED_TOOLS ?? "").split(",").filter(Boolean),
  logLevel,
  bridge,
  serverRoutes,
  tracer,
  eventBridge,
  recorder,
};

const app = createProxyServer(config);

// Bind 0.0.0.0 so the proxy is reachable from sbx sandboxes via host.docker.internal
const server = app.listen(config.port, "0.0.0.0", () => {
  log.info({ port: config.port }, "MCP proxy listening on 0.0.0.0");
  if (!bridge) {
    log.warn(
      "No MCP_SERVERS configured — running in STUB MODE. The proxy will accept requests but cannot route any tool call. " +
        "Set MCP_SERVERS and SERVER_ROUTES in .env to enable forwarding. See docs/setup.md."
    );
  }
});

// Graceful shutdown: close HTTP server first, then bridge + tracer, with 5s force-exit
function shutdown(signal: string) {
  log.info({ signal }, "Received signal, shutting down...");

  // Force exit after 5s if graceful shutdown stalls
  const forceTimer = setTimeout(() => {
    log.error("Shutdown timed out after 5s, forcing exit");
    process.exit(1);
  }, 5000);
  forceTimer.unref(); // Don't keep process alive just for the timer

  server.close(() => {
    // Race the tracer shutdown against a 3s timeout so a slow Langfuse flush
    // can never turn a clean SIGTERM into exit(1). Use allSettled so one
    // shutdown rejecting doesn't poison the other's exit status.
    const tracerShutdown = Promise.race([
      tracer.shutdown(),
      new Promise<void>((resolve) =>
        setTimeout(() => {
          log.warn("tracer.shutdown() timed out after 3s — proceeding");
          resolve();
        }, 3000).unref()
      ),
    ]);
    const tasks: Promise<unknown>[] = [];
    if (bridge) tasks.push(bridge.shutdown());
    tasks.push(tracerShutdown);
    tasks.push(eventBridge.shutdown());
    tasks.push(recorder.shutdown());
    if (metricsHttpServer) {
      tasks.push(
        new Promise<void>((resolve) => metricsHttpServer!.close(() => resolve()))
      );
    }
    Promise.allSettled(tasks).then((results) => {
      for (const r of results) {
        if (r.status === "rejected") {
          log.error({ err: r.reason }, "Shutdown task failed");
        }
      }
      process.exit(0);
    });
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
