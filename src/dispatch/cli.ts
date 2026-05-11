import { childLogger } from "../logger.js";
import { mintSessionId as defaultMintSessionId } from "../orchestrator/session-id.js";
import { parseManifestFile, type AgentManifestEntry } from "./manifest.js";
import {
  createControlPlaneClient,
  ControlPlaneAuthError,
  ControlPlaneConnectError,
  ControlPlaneServerError,
  ControlPlaneValidationError,
  type ControlPlaneClient,
} from "./control-plane-client.js";
import { createSbxRunner, SbxCommandError, type SbxRunner } from "./sbx-runner.js";
import { writeMcpConfig } from "./mcp-config-writer.js";

const log = childLogger("dispatch");

export const EXIT_CODES = {
  OK: 0,
  MANIFEST_INVALID: 64,
  MISSING_TOKEN: 65,
  REGISTER_FAIL: 66,
  SBX_FAIL: 67,
  MCP_CONFIG_CONFLICT: 69,
  CLEANUP_LEAK: 70,
} as const;

const DEFAULT_PROXY_PORT = 18923;

interface ParsedArgs {
  manifestPath: string;
  workspaceOverride?: string;
  proxyPort?: number;
  force: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs | { error: string } {
  let manifestPath: string | undefined;
  let workspaceOverride: string | undefined;
  let proxyPort: number | undefined;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--workspace") {
      workspaceOverride = argv[++i];
      if (!workspaceOverride) return { error: "--workspace requires a value" };
    } else if (a === "--proxy-port") {
      const v = argv[++i];
      if (!v) return { error: "--proxy-port requires a value" };
      const p = parseInt(v, 10);
      if (!Number.isFinite(p) || p < 1 || p > 65535) return { error: `Invalid --proxy-port "${v}"` };
      proxyPort = p;
    } else if (a === "--force") {
      force = true;
    } else if (a.startsWith("--")) {
      return { error: `Unknown flag: ${a}` };
    } else if (!manifestPath) {
      manifestPath = a;
    } else {
      return { error: `Unexpected positional argument: ${a}` };
    }
  }
  if (!manifestPath) return { error: "Usage: apd <manifest.json> [--workspace <dir>] [--proxy-port <n>] [--force]" };
  return { manifestPath, workspaceOverride, proxyPort, force };
}

export interface DispatchDeps {
  readonly hostEnv?: Record<string, string | undefined>;
  readonly sbxRunner?: SbxRunner;
  readonly controlPlaneClient?: ControlPlaneClient;
  readonly mintSessionId?: () => string;
}

export async function runDispatch(argv: string[]): Promise<number> {
  return runDispatchWithDeps(argv, {});
}

export async function runDispatchWithDeps(argv: readonly string[], deps: DispatchDeps): Promise<number> {
  const hostEnv = deps.hostEnv ?? (process.env as Record<string, string | undefined>);
  const mintId = deps.mintSessionId ?? defaultMintSessionId;

  // 1. Parse argv
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    log.error({ err: parsed.error }, "dispatch: bad invocation");
    process.stderr.write(`${parsed.error}\n`);
    return EXIT_CODES.MANIFEST_INVALID;
  }

  // 2. Token presence
  const token = hostEnv.MCP_CONTROL_TOKEN;
  if (typeof token !== "string" || token.length === 0) {
    process.stderr.write(
      "MCP_CONTROL_TOKEN is not set. The dispatch CLI needs the host-side control-plane token. " +
        "See docs/security.md#control-plane-trust-boundary.\n"
    );
    return EXIT_CODES.MISSING_TOKEN;
  }

  // 3. Manifest
  let entry: AgentManifestEntry;
  try {
    const manifest = parseManifestFile(parsed.manifestPath);
    if (manifest.agents.length !== 1) {
      process.stderr.write(
        `Tier 1.4 supports exactly one agent per manifest; got ${manifest.agents.length}. ` +
          "Tier 1.5 will add parallel dispatch.\n"
      );
      return EXIT_CODES.MANIFEST_INVALID;
    }
    entry = manifest.agents[0];
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT_CODES.MANIFEST_INVALID;
  }

  // 4. Apply CLI overrides
  const workspace = parsed.workspaceOverride ?? entry.workspace;
  const proxyPort =
    parsed.proxyPort ??
    (hostEnv.MCP_PROXY_PORT ? parseInt(hostEnv.MCP_PROXY_PORT, 10) : DEFAULT_PROXY_PORT);
  if (!Number.isFinite(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
    process.stderr.write(`Invalid proxy port: ${proxyPort}\n`);
    return EXIT_CODES.MANIFEST_INVALID;
  }

  // 5. Mint session-id, derive sandbox name
  const sessionId = mintId();
  const sandboxName = entry.sandboxName ?? `ap-${entry.agentType}-${sessionId.slice(0, 6)}`;

  // 6. Build clients (or use injected ones)
  const cpClient =
    deps.controlPlaneClient ??
    createControlPlaneClient({ token, baseUrl: undefined });
  const sbxRunner = deps.sbxRunner ?? createSbxRunner({ hostEnv });

  // 7. Register
  try {
    await cpClient.register({
      sessionId,
      agentType: entry.agentType,
      allowedTools: [...entry.allowedTools],
    });
  } catch (err) {
    if (err instanceof ControlPlaneAuthError) {
      process.stderr.write(`${err.message}\n`);
      return EXIT_CODES.REGISTER_FAIL;
    }
    if (err instanceof ControlPlaneValidationError) {
      process.stderr.write(`${err.message}\n`);
      return EXIT_CODES.REGISTER_FAIL;
    }
    if (err instanceof ControlPlaneServerError || err instanceof ControlPlaneConnectError) {
      process.stderr.write(`${err.message}\n`);
      return EXIT_CODES.REGISTER_FAIL;
    }
    log.error({ err }, "dispatch: unexpected register error");
    process.stderr.write(`Unexpected error during register: ${err instanceof Error ? err.message : err}\n`);
    return EXIT_CODES.REGISTER_FAIL;
  }

  // 8. From here on, every exit path must run cleanup.
  let agentExitCode = 0;
  let sbxError = false;
  let cleanupError = false;
  let policyIds: readonly string[] = [];
  let createdSandbox = false;
  let mcpConfigWritten = false;

  try {
    // 8a. Write .mcp.json (before the sandbox boots so the bind-mount picks it up)
    try {
      writeMcpConfig({
        workspace,
        sessionId,
        agentType: entry.agentType,
        proxyUrl: `http://host.docker.internal:${proxyPort}/mcp`,
        force: parsed.force,
      });
      mcpConfigWritten = true;
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
      sbxError = true;
      return EXIT_CODES.MCP_CONFIG_CONFLICT;
    }

    // 8b. Create sandbox
    try {
      await sbxRunner.createSandbox({
        name: sandboxName,
        workspace,
        extraArgs: entry.extraSbxArgs,
      });
      createdSandbox = true;
    } catch (err) {
      process.stderr.write(`sbx create failed: ${err instanceof Error ? err.message : err}\n`);
      sbxError = true;
      return EXIT_CODES.SBX_FAIL;
    }

    // 8c. Network policy
    try {
      const { policyIds: ids } = await sbxRunner.allowNetwork(proxyPort);
      policyIds = ids;
    } catch (err) {
      process.stderr.write(`sbx policy allow failed: ${err instanceof Error ? err.message : err}\n`);
      sbxError = true;
      return EXIT_CODES.SBX_FAIL;
    }

    // 8d. Run the agent
    const result = await sbxRunner.execAgent({ name: sandboxName, command: entry.agentCommand });
    agentExitCode = result.exitCode;
    return agentExitCode;
  } finally {
    // Cleanup — best-effort but loud on failure.
    if (createdSandbox || policyIds.length > 0) {
      try {
        await sbxRunner.tearDown({ name: sandboxName, policyIds });
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : err }, "tearDown threw (already best-effort inside)");
      }
    }
    void mcpConfigWritten;
    try {
      await cpClient.deregister(sessionId);
    } catch (err) {
      cleanupError = true;
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ sessionId, err: msg }, "deregister FAILED — session may leak in registry");
      process.stderr.write(
        `WARNING: failed to deregister session ${sessionId}: ${msg}\n` +
          "The session may leak until the proxy restarts or you DELETE it manually.\n"
      );
    }
    void sbxError;
    // If cleanup leaked, override the return value via a side channel.
    if (cleanupError) {
      // eslint-disable-next-line no-unsafe-finally
      // The finally block runs after the return; override exit code.
      // eslint-disable-next-line no-unsafe-finally
      return EXIT_CODES.CLEANUP_LEAK;
    }
  }
}

// Silence ts unused warnings — the variables are read inside the finally block.
void SbxCommandError;
