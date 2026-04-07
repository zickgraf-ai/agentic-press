import { createProxyServer, type ProxyServerConfig } from "./mcp-proxy/server.js";
import { createStdioBridge, type McpServerDef, type StdioBridge } from "./mcp-proxy/stdio-bridge.js";
import type { LogLevel } from "./types.js";

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

const serverDefs = parseServerDefs();
const serverRoutes = parseServerRoutes();
let bridge: StdioBridge | undefined;

if (serverDefs.length > 0) {
  bridge = createStdioBridge(serverDefs);
  console.log(`Stdio bridge created with ${serverDefs.length} server(s): ${serverDefs.map((s) => s.name).join(", ")}`);
}

const config: ProxyServerConfig = {
  port: parseInt(process.env.MCP_PROXY_PORT ?? "18923", 10),
  allowedTools: (process.env.ALLOWED_TOOLS ?? "").split(",").filter(Boolean),
  logLevel: (process.env.LOG_LEVEL ?? "info") as LogLevel,
  bridge,
  serverRoutes,
};

const app = createProxyServer(config);

// Bind 0.0.0.0 so the proxy is reachable from sbx sandboxes via host.docker.internal
const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(`MCP proxy listening on 0.0.0.0:${config.port}`);
  if (!bridge) {
    console.log("No MCP_SERVERS configured — running in stub mode (no forwarding)");
  }
});

// Graceful shutdown: close HTTP server first, then bridge
function shutdown() {
  server.close(() => {
    if (bridge) {
      bridge.shutdown().then(() => process.exit(0)).catch((err) => {
      console.error("Bridge shutdown failed:", err);
      process.exit(1);
    });
    } else {
      process.exit(0);
    }
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
