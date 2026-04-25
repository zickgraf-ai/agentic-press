import type { McpServerDef } from "./mcp-proxy/stdio-bridge.js";
import { childLogger } from "./logger.js";

const log = childLogger("server-config");

/**
 * Parse MCP server definitions from an env-var string.
 *
 * Expected format: JSON array of objects with `name`, `command`, `args`, and optional `env`.
 * Example: `[{"name":"fs","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem"]}]`
 *
 * @param raw - Value of `process.env.MCP_SERVERS`. Returns `[]` if falsy or whitespace-only.
 * @throws On invalid JSON or wrong runtime shape (not an array, or entries missing required fields).
 */
export function parseServerDefs(raw: string | undefined): McpServerDef[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse MCP_SERVERS: ${err instanceof Error ? err.message : err}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `MCP_SERVERS must be a JSON array, got ${typeof parsed}. ` +
        'Example: MCP_SERVERS=\'[{"name":"fs","command":"npx","args":["-y","pkg"]}]\''
    );
  }
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.name !== "string" ||
      typeof entry.command !== "string" ||
      !Array.isArray(entry.args)
    ) {
      throw new Error(
        `MCP_SERVERS[${i}] is invalid — each entry must have string "name", string "command", and array "args". ` +
          `Got: ${JSON.stringify(entry)}`
      );
    }
  }
  return parsed as McpServerDef[];
}

/**
 * Parse tool→server routing from an env-var string.
 *
 * Expected format: JSON object mapping tool-name globs to server names.
 * Example: `{"fs__*":"fs","echo__*":"echo"}`
 *
 * @param raw - Value of `process.env.SERVER_ROUTES`. Returns `undefined` if falsy or whitespace-only.
 * @throws On invalid JSON or wrong runtime shape (not a plain object, or values aren't strings).
 */
export function parseServerRoutes(raw: string | undefined): Record<string, string> | undefined {
  if (!raw?.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse SERVER_ROUTES: ${err instanceof Error ? err.message : err}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `SERVER_ROUTES must be a JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}. ` +
        'Example: SERVER_ROUTES=\'{"fs__*":"fs"}\''
    );
  }
  for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof val !== "string") {
      throw new Error(
        `SERVER_ROUTES["${key}"] must be a string (server name), got ${typeof val}.`
      );
    }
  }
  return parsed as Record<string, string>;
}

/**
 * Validate that MCP_SERVERS and SERVER_ROUTES are either both configured or both absent,
 * that every route points at a declared server, and that every server is reachable by
 * at least one route.
 *
 * @throws On half-configured state, dangling route references, or duplicate server names.
 */
export function validateServerConfig(
  serverDefs: McpServerDef[],
  routes: Record<string, string> | undefined
): void {
  const haveServers = serverDefs.length > 0;
  const haveRoutes = routes !== undefined && Object.keys(routes).length > 0;

  // Detect half-config: one set, the other missing or empty
  if (haveServers && !haveRoutes) {
    throw new Error(
      "MCP_SERVERS is set but SERVER_ROUTES is unset or empty — the proxy would accept tool calls but never route them. " +
        "Set SERVER_ROUTES to a JSON object mapping tool-name globs to server names, " +
        'e.g. SERVER_ROUTES=\'{"fs__*":"fs"}\'. See docs/setup.md.'
    );
  }

  if (haveRoutes && !haveServers) {
    throw new Error(
      "SERVER_ROUTES is set but MCP_SERVERS is unset or empty — routes reference servers that do not exist. " +
        "Set MCP_SERVERS to a JSON array of server definitions. See docs/setup.md."
    );
  }

  if (haveServers && haveRoutes) {
    // Detect duplicate server names
    const names = serverDefs.map((s) => s.name);
    const seen = new Set<string>();
    for (const name of names) {
      if (seen.has(name)) {
        throw new Error(
          `Duplicate server name "${name}" in MCP_SERVERS. Each server must have a unique name.`
        );
      }
      seen.add(name);
    }

    // Detect routes pointing at undeclared servers
    const declared = new Set(names);
    const routed = new Set<string>();
    for (const [pattern, serverName] of Object.entries(routes!)) {
      if (!declared.has(serverName)) {
        throw new Error(
          `SERVER_ROUTES entry "${pattern}" → "${serverName}" references a server not declared in MCP_SERVERS. ` +
            `Declared servers: ${[...declared].join(", ")}.`
        );
      }
      routed.add(serverName);
    }

    // Warn about declared servers with no route (spawned but unreachable)
    for (const name of declared) {
      if (!routed.has(name)) {
        log.warn(
          { server: name },
          `Server "${name}" is declared in MCP_SERVERS but has no matching route in SERVER_ROUTES — it will be spawned but never receive traffic.`
        );
      }
    }
  }
}
