import { spawn, type ChildProcess } from "node:child_process";
import { constants as osConstants } from "node:os";
import { childLogger } from "../logger.js";

const log = childLogger("sbx-runner");

// Positive env allow-list. Defence-in-depth: even if a future sbx forwards
// parent env, MCP_CONTROL_TOKEN must not be in this set. Groups documented
// in docs/security.md so future additions stay scoped.
const ALLOWED_ENV_KEYS = new Set([
  // Process basics
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TMPDIR",
  "TZ",
  // Locale (full LC_* set so non-en_US operators don't see malformed output)
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_NUMERIC",
  "LC_TIME",
  "LC_COLLATE",
  // Terminal / color signaling
  "TERM",
  "COLORTERM",
  "FORCE_COLOR",
  "NO_COLOR",
  "CLICOLOR",
  // Corporate-network HTTP proxy (both cases — Node prefers uppercase;
  // curl/git/most C tools read lowercase first). Without these, anything
  // inside the sandbox doing outbound HTTP fails on corporate networks.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  // Corporate TLS roots (self-signed CAs)
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  // Node tooling
  "NODE_OPTIONS",
  "NPM_CONFIG_PREFIX",
  "NPM_CONFIG_REGISTRY",
  "NVM_DIR",
]);

// SBX_STUB_* forwarded for test plumbing — cheaper than DI'ing env per test.
const ALLOWED_ENV_PREFIXES = ["SBX_STUB_"];

// Belt-and-braces: drop credential-looking names even if accidentally allow-listed.
const FORBIDDEN_ENV_PREFIXES = ["MCP_CONTROL", "AP_TOKEN"];

function filterEnv(host: Readonly<Record<string, string | undefined>>): {
  out: Record<string, string>;
  dropped: string[];
} {
  const out: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(host)) {
    if (v === undefined) continue;
    if (FORBIDDEN_ENV_PREFIXES.some((p) => k.startsWith(p))) {
      dropped.push(k);
      continue;
    }
    const allowed =
      ALLOWED_ENV_KEYS.has(k) || ALLOWED_ENV_PREFIXES.some((p) => k.startsWith(p));
    if (!allowed) {
      dropped.push(k);
      continue;
    }
    out[k] = v;
  }
  return { out, dropped };
}

// Log dropped names at debug level so operators running `LOG_LEVEL=debug`
// can diagnose "sandbox can't reach corporate proxy" without us logging the
// values themselves (only key names).
function emitDropDebug(label: string, dropped: readonly string[]): void {
  if (dropped.length === 0) return;
  log.debug({ label, droppedCount: dropped.length, dropped }, "filtered env keys not forwarded to sbx child");
}

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// Standard POSIX convention: a process killed by a signal exits with 128 + signum.
// Node's exit listener gives us either `code` (clean exit) or `signal` (killed).
function resolveExitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal !== null) {
    const signumMap = osConstants.signals as Record<string, number>;
    const signum = signumMap[signal];
    if (typeof signum === "number") return 128 + signum;
  }
  return -1;
}

function runSbx(
  binary: string,
  args: readonly string[],
  env: Record<string, string>,
  options: { inheritStdio?: boolean; signal?: AbortSignal; onChild?: (c: ChildProcess) => void } = {}
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      env,
      stdio: options.inheritStdio ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    options.onChild?.(child);
    let stdout = "";
    let stderr = "";
    if (!options.inheritStdio) {
      child.stdout?.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
      });
      child.stderr?.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });
    }
    const onAbort = () => {
      if (!child.killed) child.kill("SIGTERM");
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
    child.on("error", (err) => {
      options.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("exit", (code, signal) => {
      options.signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode: resolveExitCode(code, signal), stdout, stderr });
    });
  });
}

export interface CreateSandboxOptions {
  readonly name: string;
  readonly workspace: string;
  readonly extraArgs?: readonly string[];
}

export interface AllowNetworkResult {
  readonly policyIds: readonly string[];
}

export interface ExecAgentOptions {
  readonly name: string;
  readonly command: readonly string[];
  readonly signal?: AbortSignal;
}

export interface ExecAgentResult {
  readonly exitCode: number;
}

export interface TearDownOptions {
  readonly name: string;
  readonly policyIds: readonly string[];
}

export interface TearDownFailure {
  readonly label: "stop" | "rm" | "policy rm";
  readonly name: string;
  readonly policyId?: string;
  readonly message: string;
}

export interface TearDownResult {
  readonly failures: readonly TearDownFailure[];
}

export interface SbxRunner {
  createSandbox(opts: CreateSandboxOptions): Promise<void>;
  allowNetwork(port: number): Promise<AllowNetworkResult>;
  execAgent(opts: ExecAgentOptions): Promise<ExecAgentResult>;
  tearDown(opts: TearDownOptions): Promise<TearDownResult>;
}

export interface SbxRunnerOptions {
  readonly sbxBinary?: string;
  /** Host env. Defaults to `process.env`. Tests inject a controlled object. */
  readonly hostEnv?: Readonly<Record<string, string | undefined>>;
}

export class SbxCommandError extends Error {
  constructor(public readonly subcommand: string, public readonly exitCode: number, public readonly stderr: string) {
    super(`sbx ${subcommand} failed with exit code ${exitCode}: ${stderr.trim()}`);
    this.name = "SbxCommandError";
  }
}

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function createSbxRunner(opts: SbxRunnerOptions = {}): SbxRunner {
  const binary = opts.sbxBinary ?? "sbx";
  const hostEnv = opts.hostEnv ?? process.env;

  return {
    async createSandbox({ name, workspace, extraArgs = [] }) {
      const args = ["create", "--name", name, "shell", workspace, ...extraArgs];
      const { out: env, dropped } = filterEnv(hostEnv);
      emitDropDebug("create", dropped);
      const result = await runSbx(binary, args, env);
      if (result.exitCode !== 0) {
        throw new SbxCommandError("create", result.exitCode, result.stderr);
      }
    },

    async allowNetwork(port) {
      const spec = `host.docker.internal:${port},localhost:${port}`;
      const args = ["policy", "allow", "network", spec];
      const { out: env, dropped } = filterEnv(hostEnv);
      emitDropDebug("allowNetwork", dropped);
      const result = await runSbx(binary, args, env);
      if (result.exitCode !== 0) {
        throw new SbxCommandError("policy allow network", result.exitCode, result.stderr);
      }
      const combined = result.stdout + result.stderr;
      const matches = combined.match(UUID_PATTERN) ?? [];
      if (matches.length === 0) {
        // Exit 0 but no UUIDs extracted — sbx output format may have changed.
        // tearDown can't revoke policies we didn't capture, so they would leak.
        log.warn(
          { port, stdout: result.stdout.slice(0, 200), stderr: result.stderr.slice(0, 200) },
          "allowNetwork extracted zero policy IDs from sbx output — policy cleanup will be skipped"
        );
      }
      return { policyIds: matches };
    },

    async execAgent({ name, command, signal }) {
      const args = ["exec", name, ...command];
      const { out: env, dropped } = filterEnv(hostEnv);
      emitDropDebug("execAgent", dropped);
      // Inherit stdio in production so the operator sees the agent in real
      // time. Tests inject SBX_STUB_CALLS via hostEnv to flip to captured
      // pipes (the stub writes via fs.appendFileSync, so stdio isn't needed).
      const inheritStdio = !hostEnv.SBX_STUB_CALLS;
      const result = await runSbx(binary, args, env, { inheritStdio, signal });
      return { exitCode: result.exitCode };
    },

    async tearDown({ name, policyIds }) {
      const { out: env, dropped } = filterEnv(hostEnv);
      emitDropDebug("tearDown", dropped);
      const failures: TearDownFailure[] = [];
      // Best-effort — one step failing must not mask the others.
      const safe = async (
        label: "stop" | "rm" | "policy rm",
        args: string[],
        policyId?: string
      ) => {
        let message: string | undefined;
        try {
          const r = await runSbx(binary, args, env);
          if (r.exitCode !== 0) {
            message = r.stderr.trim() || `exit ${r.exitCode}`;
          }
        } catch (err) {
          message = err instanceof Error ? err.message : String(err);
        }
        if (message !== undefined) {
          const failure: TearDownFailure = { label, name, ...(policyId ? { policyId } : {}), message };
          failures.push(failure);
          log.warn(failure, "tearDown step failed");
        }
      };
      await safe("stop", ["stop", name]);
      await safe("rm", ["rm", name]);
      for (const id of policyIds) {
        await safe("policy rm", ["policy", "rm", "network", "--id", id], id);
      }
      return { failures };
    },
  };
}
