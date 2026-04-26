import type { McpServerDef, McpStdioServerDef, McpHttpServerDef } from "./mcp-proxy/transport.js";
import { DEFAULT_MAX_RESPONSE_BYTES } from "./mcp-proxy/stdio-bridge.js";
import { childLogger } from "./logger.js";

const log = childLogger("server-config");

/**
 * Parse the MAX_RESPONSE_BYTES env var into a non-negative integer cap on
 * upstream response line size. `undefined` (var unset) returns the default
 * cap. Any non-canonical numeric form throws — silently coercing "1e7",
 * "+10", "010", "0x10", or "100abc" into a number would mask config typos
 * and quietly re-expose the OOM surface this guard exists to close.
 *
 * Accepted: a string of one or more decimal digits (no leading "+", no
 * leading zeros except a bare "0", no exponent, no hex). 0 is allowed and
 * disables the cap.
 *
 * @throws on any non-canonical numeric form, negative numbers, or text.
 */
export function parseMaxResponseBytes(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_MAX_RESPONSE_BYTES;
  const n = parseInt(raw, 10);
  // Round-trip the parsed integer back to its decimal string; if the trimmed
  // input doesn't match exactly we reject. This catches "100abc" (parseInt
  // succeeds at 100), "1e7" (succeeds at 1), "+10" (succeeds at 10),
  // "010" (succeeds at 10), "0x10" (succeeds at 0), and "-1" (negative).
  if (isNaN(n) || n < 0 || String(n) !== raw.trim()) {
    throw new Error(
      `Invalid MAX_RESPONSE_BYTES: "${raw}" — must be a non-negative integer (0 disables)`
    );
  }
  return n;
}

/** Hostnames that are allowed to use http:// (everything else must use https://). */
const LOCALHOST_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Validate an HTTP server URL: must be a parseable URL with http or https scheme,
 * and http:// is only allowed for localhost (CVE-class defence — plain HTTP to
 * a remote MCP server exposes the bearer token and request/response payloads to
 * any on-path attacker).
 */
function validateHttpUrl(url: string, idx: number): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `MCP_SERVERS[${idx}].url is not a valid URL: ${JSON.stringify(url)}`
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `MCP_SERVERS[${idx}].url must use http:// or https:// scheme, got ${parsed.protocol}`
    );
  }
  // Strip IPv6 brackets if present (URL parser leaves them in place)
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (parsed.protocol === "http:" && !LOCALHOST_HOSTNAMES.has(host)) {
    throw new Error(
      `MCP_SERVERS[${idx}].url uses http:// for non-localhost host "${host}". ` +
        `Only localhost / 127.0.0.1 / ::1 may use http://; use https:// for remote servers.`
    );
  }
}

/**
 * Parse MCP server definitions from an env-var string.
 *
 * Expected format: JSON array of objects discriminated by `transport`:
 *   - stdio (default if `command` present): { name, command, args, env? }
 *   - http: { name, transport: "http", url, bearerToken?, headers? }
 *
 * Examples:
 *   `[{"name":"fs","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem"]}]`
 *   `[{"name":"remote","transport":"http","url":"https://mcp.example.com/mcp","bearerToken":"..."}]`
 *
 * For backward compatibility, entries with `command` and no `transport` field
 * default to `transport: "stdio"`.
 *
 * @param raw - Value of `process.env.MCP_SERVERS`. Returns `[]` if falsy or whitespace-only.
 * @throws On invalid JSON, wrong shape, or HTTPS policy violations.
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

  const result: McpServerDef[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    if (typeof entry !== "object" || entry === null || typeof entry.name !== "string") {
      throw new Error(
        `MCP_SERVERS[${i}] is invalid — each entry must be an object with a string "name". ` +
          `Got: ${JSON.stringify(entry)}`
      );
    }

    // Discriminate on transport field (default to "stdio" for back-compat)
    const transport = entry.transport;
    if (transport !== undefined && transport !== "stdio" && transport !== "http") {
      throw new Error(
        `MCP_SERVERS[${i}].transport must be "stdio" or "http", got ${JSON.stringify(transport)}`
      );
    }

    const isHttp = transport === "http";

    if (isHttp) {
      if (typeof entry.url !== "string") {
        throw new Error(
          `MCP_SERVERS[${i}] is invalid — http transport requires string "url". ` +
            `Got: ${JSON.stringify(entry)}`
        );
      }
      if ("command" in entry || "args" in entry) {
        throw new Error(
          `MCP_SERVERS[${i}] mixes http and stdio fields — http transport must not have "command" or "args".`
        );
      }
      validateHttpUrl(entry.url, i);
      const def: McpHttpServerDef = {
        name: entry.name,
        transport: "http",
        url: entry.url,
        ...(typeof entry.bearerToken === "string" ? { bearerToken: entry.bearerToken } : {}),
        ...(entry.headers && typeof entry.headers === "object"
          ? { headers: entry.headers as Record<string, string> }
          : {}),
      };
      result.push(def);
    } else {
      // stdio (explicit or defaulted)
      if (typeof entry.command !== "string" || !Array.isArray(entry.args)) {
        throw new Error(
          `MCP_SERVERS[${i}] is invalid — stdio transport requires string "command" and array "args". ` +
            `Got: ${JSON.stringify(entry)}`
        );
      }
      const def: McpStdioServerDef = {
        name: entry.name,
        transport: "stdio",
        command: entry.command,
        args: entry.args,
        ...(entry.env && typeof entry.env === "object"
          ? { env: entry.env as Record<string, string> }
          : {}),
      };
      result.push(def);
    }
  }

  return result;
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
