import type { McpServerDef } from "./mcp-proxy/stdio-bridge.js";

export function parseServerDefs(raw: string | undefined): McpServerDef[] {
  if (!raw) return [];
  try {
    return JSON.parse(raw) as McpServerDef[];
  } catch (err) {
    throw new Error(`Failed to parse MCP_SERVERS: ${err instanceof Error ? err.message : err}`);
  }
}

export function parseServerRoutes(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch (err) {
    throw new Error(`Failed to parse SERVER_ROUTES: ${err instanceof Error ? err.message : err}`);
  }
}

export function validateServerConfig(
  serverDefs: McpServerDef[],
  routes: Record<string, string> | undefined
): void {
  const haveServers = serverDefs.length > 0;
  const haveRoutes = routes !== undefined && Object.keys(routes).length > 0;

  if (haveServers && !haveRoutes) {
    throw new Error(
      "MCP_SERVERS is set but SERVER_ROUTES is unset — the proxy would accept tool calls but never route them. " +
        "Set SERVER_ROUTES to a JSON object mapping tool-name globs to server names, " +
        'e.g. SERVER_ROUTES=\'{"fs__*":"fs"}\'. See docs/setup.md.'
    );
  }

  if (haveRoutes && !haveServers) {
    throw new Error(
      "SERVER_ROUTES is set but MCP_SERVERS is unset — routes reference servers that do not exist. " +
        "Set MCP_SERVERS to a JSON array of server definitions. See docs/setup.md."
    );
  }

  if (haveServers && haveRoutes) {
    const declared = new Set(serverDefs.map((s) => s.name));
    for (const [pattern, serverName] of Object.entries(routes!)) {
      if (!declared.has(serverName)) {
        throw new Error(
          `SERVER_ROUTES entry "${pattern}" → "${serverName}" references a server not declared in MCP_SERVERS. ` +
            `Declared servers: ${[...declared].join(", ") || "(none)"}.`
        );
      }
    }
  }
}
