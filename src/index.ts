import { createProxyServer, type ProxyServerConfig } from "./mcp-proxy/server.js";
import { createStdioBridge, type McpServerDef, type StdioBridge } from "./mcp-proxy/stdio-bridge.js";
import { parseLogLevel } from "./types.js";
import { childLogger } from "./logger.js";
import { loadLangfuseConfig } from "./observability/config.js";
import { createTracer, createNoopTracer, type Tracer } from "./observability/langfuse.js";

const log = childLogger("main");

// Parse MCP server definitions from env: JSON array of {name, command, args, env?}
// Example: MCP_SERVERS='[{"name":"fs","command":"npx","args":["-y","@anthropic-ai/mcp-filesystem"]}]'
function parseServerDefs(): McpServerDef[] {
  const raw = process.env.MCP_SERVERS;
  if (!raw) return [];
  try {
    return JSON.parse(raw) as McpServerDef[];
  } catch (err) {
    throw new Error(`Failed to parse MCP_SERVERS: ${err instanceof Error ? err.message : err}`);
  }
}

// Parse tool→server routing from env: JSON object of pattern→serverName
// Example: SERVER_ROUTES='{"fs__*":"fs","echo__*":"echo"}'
function parseServerRoutes(): Record<string, string> | undefined {
  const raw = process.env.SERVER_ROUTES;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch (err) {
    throw new Error(`Failed to parse SERVER_ROUTES: ${err instanceof Error ? err.message : err}`);
  }
}

const logLevel = parseLogLevel(process.env.LOG_LEVEL);
const serverDefs = parseServerDefs();
const serverRoutes = parseServerRoutes();
let bridge: StdioBridge | undefined;

if (serverDefs.length > 0) {
  bridge = createStdioBridge(serverDefs, { logLevel });
  log.info({ serverCount: serverDefs.length, servers: serverDefs.map((s) => s.name) }, "Stdio bridge created");
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

const config: ProxyServerConfig = {
  port,
  allowedTools: (process.env.ALLOWED_TOOLS ?? "").split(",").filter(Boolean),
  logLevel,
  bridge,
  serverRoutes,
  tracer,
};

const app = createProxyServer(config);

// Bind 0.0.0.0 so the proxy is reachable from sbx sandboxes via host.docker.internal
const server = app.listen(config.port, "0.0.0.0", () => {
  log.info({ port: config.port }, "MCP proxy listening on 0.0.0.0");
  if (!bridge) {
    log.info("No MCP_SERVERS configured — running in stub mode (no forwarding)");
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
