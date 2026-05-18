import { childLogger } from "../logger.js";
import { mintSessionId as defaultMintSessionId, type SessionId } from "../orchestrator/session-id.js";
import { parseManifestFile, validateWorkspace, type AgentManifestEntry } from "./manifest.js";
import {
  createControlPlaneClient,
  ControlPlaneError,
  type ControlPlaneClient,
} from "./control-plane-client.js";
import { createSbxRunner, type SbxRunner } from "./sbx-runner.js";
import { writeMcpConfig, McpConfigConflictError } from "./mcp-config-writer.js";

const log = childLogger("dispatch");

export const EXIT_CODES = {
  OK: 0,
  MANIFEST_INVALID: 64,
  MISSING_TOKEN: 65,
  REGISTER_FAIL: 66,
  SBX_FAIL: 67,
  WORKSPACE_INVALID: 68,
  MCP_CONFIG_CONFLICT: 69,
  CLEANUP_LEAK: 70,
  INTERNAL_ERROR: 71,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES] | number;

const DEFAULT_PROXY_PORT = 18923;
const SANDBOX_NAME_SLICE = 10;

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
      if (!Number.isFinite(p) || String(p) !== v || p < 1 || p > 65535) {
        return { error: `Invalid --proxy-port "${v}"` };
      }
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
  readonly mintSessionId?: () => SessionId;
  /** AbortSignal that fires on SIGINT/SIGTERM; plumbed into execAgent. */
  readonly signal?: AbortSignal;
}

export async function runDispatch(argv: readonly string[], signal?: AbortSignal): Promise<ExitCode> {
  return runDispatchWithDeps(argv, { signal });
}

export async function runDispatchWithDeps(argv: readonly string[], deps: DispatchDeps): Promise<ExitCode> {
  const hostEnv = deps.hostEnv ?? (process.env as Record<string, string | undefined>);
  const mintId = deps.mintSessionId ?? defaultMintSessionId;

  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    log.error({ err: parsed.error }, "dispatch: bad invocation");
    process.stderr.write(`${parsed.error}\n`);
    return EXIT_CODES.MANIFEST_INVALID;
  }

  const token = hostEnv.MCP_CONTROL_TOKEN;
  if (typeof token !== "string" || token.length === 0) {
    process.stderr.write(
      "MCP_CONTROL_TOKEN is not set. The dispatch CLI needs the host-side control-plane token. " +
        "See docs/security.md#control-plane-trust-boundary.\n"
    );
    return EXIT_CODES.MISSING_TOKEN;
  }

  let entry: AgentManifestEntry;
  try {
    const manifest = parseManifestFile(parsed.manifestPath);
    if (manifest.agents.length !== 1) {
      process.stderr.write(
        `The dispatch CLI accepts exactly one agent per manifest; got ${manifest.agents.length}. ` +
          "Multi-agent dispatch is a planned extension.\n"
      );
      return EXIT_CODES.MANIFEST_INVALID;
    }
    entry = manifest.agents[0];
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT_CODES.MANIFEST_INVALID;
  }

  // Workspace override goes through the same validation as the manifest's
  // workspace field — must be absolute, exist, be a directory.
  let workspace: string;
  try {
    workspace =
      parsed.workspaceOverride !== undefined
        ? validateWorkspace(parsed.workspaceOverride, "--workspace")
        : entry.workspace;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT_CODES.WORKSPACE_INVALID;
  }

  const proxyPortRaw =
    parsed.proxyPort ??
    (hostEnv.MCP_PROXY_PORT ? parseInt(hostEnv.MCP_PROXY_PORT, 10) : DEFAULT_PROXY_PORT);
  if (!Number.isFinite(proxyPortRaw) || proxyPortRaw < 1 || proxyPortRaw > 65535) {
    process.stderr.write(`Invalid proxy port: ${proxyPortRaw}\n`);
    return EXIT_CODES.MANIFEST_INVALID;
  }
  const proxyPort = proxyPortRaw;

  const sessionId = mintId();
  const sandboxName =
    entry.sandboxName ?? `ap-${entry.agentType}-${sessionId.slice(0, SANDBOX_NAME_SLICE)}`;

  const cpClient =
    deps.controlPlaneClient ?? createControlPlaneClient({ token, baseUrl: undefined });
  const sbxRunner = deps.sbxRunner ?? createSbxRunner({ hostEnv });

  try {
    await cpClient.register({
      sessionId,
      agentType: entry.agentType,
      allowedTools: [...entry.allowedTools],
    });
  } catch (err) {
    if (err instanceof ControlPlaneError) {
      process.stderr.write(`${err.message}\n`);
      return EXIT_CODES.REGISTER_FAIL;
    }
    log.error({ err }, "dispatch: unexpected register error");
    process.stderr.write(
      `Unexpected error during register: ${err instanceof Error ? err.message : err}\n`
    );
    return EXIT_CODES.REGISTER_FAIL;
  }

  // Past this point, every exit path must run the finally cleanup.
  let intendedExit: ExitCode = EXIT_CODES.OK;
  let thrownDuringRun: unknown;
  let createdSandbox = false;
  let policyIds: readonly string[] = [];

  try {
    try {
      writeMcpConfig({
        workspace,
        sessionId,
        agentType: entry.agentType,
        proxyUrl: `http://host.docker.internal:${proxyPort}/mcp`,
        force: parsed.force,
      });
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
      // Distinguish "file already exists" (operator can pass --force) from
      // workspace/FS errors (broken symlink, ENOTDIR, etc.) so the exit code
      // points at the right fix.
      intendedExit =
        err instanceof McpConfigConflictError
          ? EXIT_CODES.MCP_CONFIG_CONFLICT
          : EXIT_CODES.WORKSPACE_INVALID;
      return intendedExit;
    }

    try {
      await sbxRunner.createSandbox({
        name: sandboxName,
        workspace,
        extraArgs: entry.extraSbxArgs,
      });
      createdSandbox = true;
    } catch (err) {
      process.stderr.write(`sbx create failed: ${err instanceof Error ? err.message : err}\n`);
      intendedExit = EXIT_CODES.SBX_FAIL;
      return intendedExit;
    }

    try {
      const { policyIds: ids } = await sbxRunner.allowNetwork(proxyPort);
      policyIds = ids;
    } catch (err) {
      process.stderr.write(`sbx policy allow failed: ${err instanceof Error ? err.message : err}\n`);
      intendedExit = EXIT_CODES.SBX_FAIL;
      return intendedExit;
    }

    try {
      const result = await sbxRunner.execAgent({
        name: sandboxName,
        workspace,
        command: entry.agentCommand,
        signal: deps.signal,
      });
      intendedExit = result.exitCode;
      return intendedExit;
    } catch (err) {
      thrownDuringRun = err;
      process.stderr.write(`sbx exec failed: ${err instanceof Error ? err.message : err}\n`);
      intendedExit = EXIT_CODES.SBX_FAIL;
      return intendedExit;
    }
  } finally {
    // Cleanup — best-effort but loud on failure. Leaks exit non-zero (70).
    let cleanupLeak = false;

    if (createdSandbox || policyIds.length > 0) {
      try {
        const { failures } = await sbxRunner.tearDown({ name: sandboxName, policyIds });
        if (failures.length > 0) {
          cleanupLeak = true;
          process.stderr.write(
            `WARNING: ${failures.length} sbx tearDown step(s) failed — sandbox/policy may leak:\n` +
              failures.map((f) => `  - ${f.label}${f.policyId ? ` ${f.policyId}` : ""}: ${f.message}`).join("\n") +
              "\nRecover with `sbx ls`, `sbx rm <name>`, `sbx policy ls`, `sbx policy rm network --id <id>`.\n"
          );
        }
      } catch (err) {
        cleanupLeak = true;
        log.error({ err: err instanceof Error ? err.message : err }, "tearDown threw");
        process.stderr.write(
          `WARNING: sbx tearDown threw: ${err instanceof Error ? err.message : err}\n`
        );
      }
    }

    try {
      await cpClient.deregister(sessionId);
    } catch (err) {
      cleanupLeak = true;
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ sessionId, err: msg }, "deregister FAILED — session may leak in registry");
      process.stderr.write(
        `WARNING: failed to deregister session ${sessionId}: ${msg}\n` +
          "The session may leak until the proxy restarts or you DELETE it manually.\n"
      );
    }

    if (cleanupLeak) {
      // Surface what we WERE going to return before the override discards it —
      // the operator needs to see both the original failure (if any) and the
      // intended exit code, because the leak is what they have to clean up next.
      if (thrownDuringRun !== undefined) {
        log.error(
          { err: thrownDuringRun instanceof Error ? thrownDuringRun.message : thrownDuringRun },
          "original failure preceding cleanup leak"
        );
      }
      if (intendedExit !== EXIT_CODES.OK) {
        process.stderr.write(
          `Original exit code ${intendedExit} overridden to ${EXIT_CODES.CLEANUP_LEAK} due to cleanup leak.\n`
        );
      }
      // eslint-disable-next-line no-unsafe-finally
      return EXIT_CODES.CLEANUP_LEAK;
    }
  }
}
