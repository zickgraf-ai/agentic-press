import { existsSync, readFileSync, realpathSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

export const MCP_CONFIG_FILENAME = ".mcp.json";

export interface WriteMcpConfigOptions {
  readonly workspace: string;
  readonly sessionId: string;
  readonly agentType: string;
  readonly proxyUrl: string;
  readonly force?: boolean;
}

function buildConfig(opts: WriteMcpConfigOptions): unknown {
  return {
    mcpServers: {
      "agentic-press": {
        type: "http",
        url: opts.proxyUrl,
        headers: {
          "X-Agent-Session-Id": opts.sessionId,
          "X-Agent-Type": opts.agentType,
        },
      },
    },
  };
}

export function writeMcpConfig(opts: WriteMcpConfigOptions): string {
  // Canonicalize before joining so a symlinked workspace cannot trick us into
  // writing somewhere unexpected.
  const realWs = realpathSync(opts.workspace);
  const target = join(realWs, MCP_CONFIG_FILENAME);
  const desired = JSON.stringify(buildConfig(opts), null, 2) + "\n";

  if (existsSync(target)) {
    const existing = readFileSync(target, "utf8");
    if (existing === desired) {
      // Idempotent — re-run safe; don't churn the file's mtime.
      return target;
    }
    if (!opts.force) {
      throw new Error(
        `Refusing to overwrite existing ${MCP_CONFIG_FILENAME} at ${target} — pass --force to overwrite.`
      );
    }
  }

  writeFileSync(target, desired, { encoding: "utf8", mode: 0o644 });
  // writeFileSync respects mode on create only; chmod to guarantee 0o644 even
  // if the file pre-existed with a different mode.
  chmodSync(target, 0o644);
  return target;
}
