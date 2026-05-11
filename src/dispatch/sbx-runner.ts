import { spawn } from "node:child_process";
import { childLogger } from "../logger.js";

const log = childLogger("sbx-runner");

// Positive env allow-list. Only these names plus operator-declared safe vars
// reach the `sbx` child process. Defense-in-depth on top of sbx's own env
// isolation: the host-side MCP_CONTROL_TOKEN must never leak even if a future
// sbx version forwards parent env into the container.
const ALLOWED_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TZ",
  "SHELL",
  // Common Node tooling
  "NODE_OPTIONS",
  "NPM_CONFIG_PREFIX",
  "NVM_DIR",
]);

// Test-stub plumbing: any var prefixed with SBX_STUB_ is forwarded. These
// names exist only in the test harness's stub script — production sbx invocations
// don't use them. Cheaper than dependency-injecting the env into every test.
const ALLOWED_ENV_PREFIXES = ["SBX_STUB_"];

// Belt-and-braces: explicitly drop any key that looks like a sensitive credential
// even if (somehow) it got added to the allow-list.
const FORBIDDEN_ENV_PREFIXES = ["MCP_CONTROL", "AP_TOKEN"];

function filterEnv(host: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(host)) {
    if (v === undefined) continue;
    if (FORBIDDEN_ENV_PREFIXES.some((p) => k.startsWith(p))) continue;
    const allowed =
      ALLOWED_ENV_KEYS.has(k) || ALLOWED_ENV_PREFIXES.some((p) => k.startsWith(p));
    if (!allowed) continue;
    out[k] = v;
  }
  return out;
}

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runSbx(
  binary: string,
  args: readonly string[],
  env: Record<string, string>,
  options: { inheritStdio?: boolean } = {}
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      env,
      stdio: options.inheritStdio ? "inherit" : ["ignore", "pipe", "pipe"],
    });
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
    child.on("error", (err) => reject(err));
    child.on("exit", (code) => {
      resolve({ exitCode: code ?? -1, stdout, stderr });
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
}

export interface ExecAgentResult {
  readonly exitCode: number;
}

export interface TearDownOptions {
  readonly name: string;
  readonly policyIds: readonly string[];
}

export interface SbxRunner {
  createSandbox(opts: CreateSandboxOptions): Promise<void>;
  allowNetwork(port: number): Promise<AllowNetworkResult>;
  execAgent(opts: ExecAgentOptions): Promise<ExecAgentResult>;
  tearDown(opts: TearDownOptions): Promise<void>;
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
      const env = filterEnv(hostEnv);
      const result = await runSbx(binary, args, env);
      if (result.exitCode !== 0) {
        throw new SbxCommandError("create", result.exitCode, result.stderr);
      }
    },

    async allowNetwork(port) {
      const spec = `host.docker.internal:${port},localhost:${port}`;
      const args = ["policy", "allow", "network", spec];
      const env = filterEnv(hostEnv);
      const result = await runSbx(binary, args, env);
      if (result.exitCode !== 0) {
        throw new SbxCommandError("policy allow network", result.exitCode, result.stderr);
      }
      const combined = result.stdout + result.stderr;
      const matches = combined.match(UUID_PATTERN) ?? [];
      return { policyIds: matches };
    },

    async execAgent({ name, command }) {
      const args = ["exec", name, ...command];
      const env = filterEnv(hostEnv);
      // Inherit stdio so the operator sees what the agent says in real time.
      // Tests use the stub which writes via fs.appendFileSync — stdio is not
      // consulted by the stub for capturing call info.
      const inheritStdio = !process.env.SBX_STUB_CALLS;
      const result = await runSbx(binary, args, env, { inheritStdio });
      return { exitCode: result.exitCode };
    },

    async tearDown({ name, policyIds }) {
      const env = filterEnv(hostEnv);
      // Each tear-down step is best-effort: log on failure but never throw,
      // so a single failure doesn't mask the others.
      const safe = async (label: string, args: string[]) => {
        try {
          const r = await runSbx(binary, args, env);
          if (r.exitCode !== 0) {
            log.warn({ label, exitCode: r.exitCode, stderr: r.stderr.trim() }, "tearDown step exited non-zero");
          }
        } catch (err) {
          log.warn({ label, err: err instanceof Error ? err.message : String(err) }, "tearDown step threw");
        }
      };
      await safe("stop", ["stop", name]);
      await safe("rm", ["rm", name]);
      for (const id of policyIds) {
        await safe("policy rm", ["policy", "rm", "network", "--id", id]);
      }
    },
  };
}
