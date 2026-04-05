import { createProxyServer, type ProxyServerConfig } from "./mcp-proxy/server.js";

const config: ProxyServerConfig = {
  port: parseInt(process.env.MCP_PROXY_PORT ?? "18923", 10),
  allowedTools: (process.env.ALLOWED_TOOLS ?? "").split(",").filter(Boolean),
  logLevel: process.env.LOG_LEVEL ?? "info",
};

const app = createProxyServer(config);

app.listen(config.port, "0.0.0.0", () => {
  console.log(`MCP proxy listening on 0.0.0.0:${config.port}`);
});
