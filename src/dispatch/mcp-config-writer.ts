import { existsSync, readFileSync, realpathSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import type { SessionId } from "../orchestrator/session-id.js";

export const MCP_CONFIG_FILENAME = ".mcp.json";

export interface WriteMcpConfigOptions {
  readonly workspace: string;
  readonly sessionId: SessionId;
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
  // realpathSync first — a symlinked workspace must not steer the write outside.
  const realWs = realpathSync(opts.workspace);
  const target = join(realWs, MCP_CONFIG_FILENAME);
  const desired = JSON.stringify(buildConfig(opts), null, 2) + "\n";

  if (existsSync(target)) {
    const existing = readFileSync(target, "utf8");
    if (existing === desired) {
      // Force mode even on the idempotent path — operators sometimes chmod the
      // file by hand and we promise 0o644 regardless.
      chmodSync(target, 0o644);
      return target;
    }
    if (!opts.force) {
      throw new Error(
        `Refusing to overwrite existing ${MCP_CONFIG_FILENAME} at ${target} — pass --force to overwrite.`
      );
    }
  }

  writeFileSync(target, desired, { encoding: "utf8", mode: 0o644 });
  // writeFileSync only sets mode on create — chmod here so the --force overwrite
  // path also lands at 0o644.
  chmodSync(target, 0o644);
  return target;
}
