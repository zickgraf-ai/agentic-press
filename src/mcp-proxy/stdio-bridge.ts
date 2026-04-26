import { spawn, type ChildProcess } from "node:child_process";
import { levelAtLeast, type LogLevel } from "../types.js";
import { childLogger } from "../logger.js";

const log = childLogger("stdio-bridge");

/**
 * Default upper bound on the byte length of a single JSON-RPC response line
 * read from a child server's stdout. Configurable via the `maxResponseBytes`
 * option / `MAX_RESPONSE_BYTES` env var. 10 MiB is a deliberate compromise:
 * large enough that legitimate file-content responses fit comfortably, small
 * enough that a hostile or runaway upstream cannot quietly OOM the proxy
 * through unbounded buffering.
 */
export const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MiB

/**
 * Thrown when the stdio bridge rejects a response because the byte length of
 * the response line exceeds `maxResponseBytes`. The check runs at the read
 * layer, before JSON parsing, so the offending payload is never fully
 * buffered. Exposed so the server layer can pattern-match on the error type
 * (rather than string-matching on a message) and translate it into a
 * sanitizer-style JSON-RPC -32001 reply.
 */
export class ResponseSizeExceededError extends Error {
  readonly serverName: string;
  readonly limitBytes: number;
  readonly observedBytes: number;
  constructor(serverName: string, limitBytes: number, observedBytes: number) {
    super(
      `Server "${serverName}" response exceeded size cap ` +
        `(limit=${limitBytes} bytes, observed≥${observedBytes} bytes)`
    );
    this.name = "ResponseSizeExceededError";
    this.serverName = serverName;
    this.limitBytes = limitBytes;
    this.observedBytes = observedBytes;
  }
}

// McpServerDef and McpStdioServerDef are now defined in transport.ts and
// re-exported here for backward compatibility. New code should import from
// "./transport.js".
export type { McpServerDef, McpStdioServerDef, McpHttpServerDef, McpTransport } from "./transport.js";
import type { McpStdioServerDef as _StdioDef } from "./transport.js";

/**
 * Stdio bridge accepts only stdio server defs. The composition root narrows
 * the discriminated union before passing servers to this constructor.
 */
type StdioServerDef = _StdioDef;

/** Subset of ChildProcess fields exposed for test introspection. */
export interface ProcessInfo {
  readonly pid: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
}

export interface StdioBridgeOptions {
  /** Minimum severity of bridge diagnostic logs. Default: "info". */
  readonly logLevel?: LogLevel;
  /**
   * Number of initial non-JSON stdout lines to tolerate before assuming the spawn
   * is misconfigured (wrong binary, wrong fd, etc.) and rejecting pending calls.
   * Default: 5. Set to 0 to disable.
   */
  readonly failFastNonJsonLines?: number;
  /** Milliseconds to wait for graceful exit (SIGTERM) before SIGKILL. Default: 5000. */
  readonly shutdownGracePeriodMs?: number;
  /**
   * Hard ceiling after SIGKILL — milliseconds to wait for the kernel to reap the
   * child before giving up and logging a leak. Default: 2000.
   */
  readonly shutdownHardCeilingMs?: number;
  /**
   * Hard cap on the byte size of a single JSON-RPC line read from a child
   * server's stdout. Enforced at the read layer — once the buffered bytes for
   * one line exceed this, the in-flight request is rejected with
   * ResponseSizeExceededError before JSON parsing runs, so an unbounded
   * upstream response cannot OOM the proxy. Set to 0 to disable.
   * Default: DEFAULT_MAX_RESPONSE_BYTES (10 MiB).
   */
  readonly maxResponseBytes?: number;
}

export interface StdioBridge {
  call(serverName: string, method: string, params: unknown): Promise<unknown>;
  shutdown(): Promise<void>;
  /**
   * @internal Test-only introspection of a managed child process.
   * Underscore prefix marks this as not part of the supported public API.
   */
  _getProcessInfo(serverName: string): ProcessInfo | null;
}

interface PendingHandler {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface ManagedProcess {
  def: StdioServerDef;
  proc: ChildProcess;
  nextId: number;
  pending: Map<number, PendingHandler>;
  buffer: string;
  // Counters for non-JSON stdout (used for one-shot warning + fail-fast)
  nonJsonLinesSeen: number;
  jsonLinesSeen: number;
  warnedAboutNonJson: boolean;
  // Set when fail-fast triggered: the spawn is permanently broken and should
  // never be reused. Subsequent call() attempts will reject synchronously.
  brokenReason: string | null;
  // Set immediately after a mid-flight cap rejection. Bytes flowing in until
  // the next "\n" are part of the SAME oversized line that already cost us
  // one rejection — discarding them prevents a second innocent caller from
  // being rejected by check #2 when the orphan tail finally arrives.
  // Strictly bounds rejections to one per oversized line.
  discardingUntilNewline: boolean;
}

function rejectAllPending(managed: ManagedProcess, error: Error): void {
  for (const [, handler] of managed.pending) {
    clearTimeout(handler.timeout);
    handler.reject(error);
  }
  managed.pending.clear();
}

/**
 * Reject the oldest pending call (FIFO) with the given error. Used by the
 * response-size cap path: when an oversized response arrives we can't parse
 * the line to recover the request id (parsing it is exactly what we are
 * trying to avoid), so we reject the earliest in-flight call. MCP/stdio
 * upstreams answer requests in submission order, so the oversized line almost
 * always corresponds to the oldest pending entry. The fallback hazard — an
 * upstream emitting an oversized notification (no `id`) — is the same hazard
 * the bridge already accepts on any malformed line and is bounded to one
 * incorrect rejection per oversized event.
 */
function rejectOldestPending(managed: ManagedProcess, error: Error): void {
  const first = managed.pending.entries().next();
  if (first.done) return;
  const [id, handler] = first.value;
  clearTimeout(handler.timeout);
  managed.pending.delete(id);
  handler.reject(error);
}

/**
 * Handle a non-JSON line from a child server's stdout. Non-JSON on stdout is a
 * protocol violation on the bridge's transport channel — stderr is inherited
 * separately, so anything that lands here is wrong-fd output, a crash dump, or
 * a misconfigured spawn. Behavior:
 *  - At "debug" level: log every non-JSON line in full.
 *  - At any level (info/warn/error): emit a ONE-SHOT warning the first time
 *    non-JSON is seen for a given server. This is the highest-value diagnostic
 *    in the bridge — it converts mystery 30s timeouts into actionable signal.
 *  - If the first N stdout lines are all non-JSON (no JSON seen yet), assume
 *    the spawn is broken and reject all pending calls with an actionable error.
 */
function handleNonJsonLine(
  managed: ManagedProcess,
  line: string,
  logLevel: LogLevel,
  failFastNonJsonLines: number
): void {
  const name = managed.def.name;
  const truncated = line.slice(0, 200);

  if (levelAtLeast(logLevel, "debug")) {
    log.debug({ server: name, nonJsonLine: truncated }, "Non-JSON line from server");
  } else if (!managed.warnedAboutNonJson) {
    // One-shot per-server warning — always emitted regardless of log level.
    // A protocol violation on the transport channel is never something an
    // operator wants silently dropped. Uses error level so it is never
    // filtered, even at LOG_LEVEL=error.
    log.error(
      { server: name, nonJsonLine: truncated },
      "Non-JSON output detected on stdout (set LOG_LEVEL=debug for all lines)"
    );
    managed.warnedAboutNonJson = true;
  }

  // Fail-fast: if we've seen N non-JSON lines and zero JSON lines, the spawn is broken.
  // Mark the process as permanently broken, kill it, and reject pending calls.
  // getOrSpawn() checks brokenReason and rejects subsequent call() attempts
  // synchronously instead of letting them accumulate against a zombie process.
  if (
    !managed.brokenReason &&
    failFastNonJsonLines > 0 &&
    managed.nonJsonLinesSeen >= failFastNonJsonLines &&
    managed.jsonLinesSeen === 0
  ) {
    managed.brokenReason =
      `Server "${name}" emitted ${managed.nonJsonLinesSeen} non-JSON lines and no valid JSON-RPC frames — ` +
      `likely a misconfigured spawn (wrong binary, wrong fd, or crash on startup). ` +
      `Set LOG_LEVEL=debug to see the raw output.`;
    rejectAllPending(managed, new Error(managed.brokenReason));
    // Kill the broken process. Tolerate ESRCH/EPERM — child may have already died.
    try {
      managed.proc.kill();
    } catch (err) {
      log.error({ server: name, err }, "Failed to kill broken server");
    }
  }
}

function spawnServer(
  def: StdioServerDef,
  logLevel: LogLevel,
  failFastNonJsonLines: number,
  maxResponseBytes: number
): ManagedProcess {
  const proc = spawn(def.command, def.args, {
    stdio: ["pipe", "pipe", "inherit"], // stderr → inherit, not piped (#H-1)
    env: { ...process.env, ...def.env },
  });

  const managed: ManagedProcess = {
    def,
    proc,
    nextId: 1,
    pending: new Map(),
    buffer: "",
    nonJsonLinesSeen: 0,
    jsonLinesSeen: 0,
    warnedAboutNonJson: false,
    brokenReason: null,
    discardingUntilNewline: false,
  };

  // Handle spawn errors (ENOENT, permission denied) (#C-3)
  proc.on("error", (err) => {
    rejectAllPending(managed, new Error(`Server "${def.name}" spawn error: ${err.message}`));
  });

  // Handle stdin write errors (broken pipe if child dies) (#C-2)
  if (proc.stdin) {
    proc.stdin.on("error", (err) => {
      rejectAllPending(managed, new Error(`Server "${def.name}" stdin error: ${err.message}`));
    });
  }

  if (proc.stdout) {
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      // If we are still draining the orphan tail of a previously over-cap
      // line, drop bytes until we hit the next newline. This bounds rejections
      // to ONE per oversized line — without it, a chunk shaped like
      //   "<oversized-tail>\n<small valid sibling>\n"
      // would re-trip cap check #2 against the orphan and reject an innocent
      // pending call. After consuming through the newline we resume normal
      // processing on whatever follows.
      let working = chunk;
      if (managed.discardingUntilNewline) {
        const nl = working.indexOf("\n");
        if (nl === -1) {
          // Whole chunk is still part of the oversized line. Drop and wait.
          return;
        }
        working = working.slice(nl + 1);
        managed.discardingUntilNewline = false;
      }

      managed.buffer += working;

      const lines = managed.buffer.split("\n");
      managed.buffer = lines.pop() || "";

      // Cap check #2 (per complete line): a line whose byte length exceeds
      // the cap is rejected before JSON.parse runs — JSON.parse on a 1 GB
      // string is exactly the OOM we are guarding against. A line of
      // length == cap is allowed (boundary inclusive).
      //
      // Process complete lines FIRST. Sibling complete lines that arrived in
      // the same chunk carry valid ids and must be delivered to their callers
      // even if the trailing partial buffer trips the mid-flight cap below —
      // dropping them silently was the original bug (oversized line co-located
      // with a small valid response would time out the innocent caller at 30s).
      //
      // Use Buffer.byteLength(..., "utf8") rather than .length: the cap is
      // specified in BYTES and the wire protocol is UTF-8. JS strings are
      // UTF-16 internally — `s.length` counts UTF-16 code units, not bytes,
      // so multi-byte chars (e.g. emoji, "𝄞") would be undercounted by length
      // and overcounted by code-unit measurement of the source string. Always
      // measure with Buffer.byteLength when comparing against a byte cap.
      for (const line of lines) {
        if (!line.trim()) continue;
        if (
          maxResponseBytes > 0 &&
          Buffer.byteLength(line, "utf8") > maxResponseBytes
        ) {
          rejectOldestPending(
            managed,
            new ResponseSizeExceededError(
              def.name,
              maxResponseBytes,
              Buffer.byteLength(line, "utf8")
            )
          );
          continue; // drop the oversized line, keep processing siblings
        }
        // Only catch JSON parse errors — post-parse logic is outside try (#C-1)
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line);
        } catch {
          managed.nonJsonLinesSeen++;
          handleNonJsonLine(managed, line, logLevel, failFastNonJsonLines);
          continue;
        }

        managed.jsonLinesSeen++;
        if (msg.id !== undefined && managed.pending.has(msg.id as number)) {
          const handler = managed.pending.get(msg.id as number)!;
          managed.pending.delete(msg.id as number);
          clearTimeout(handler.timeout);
          if (msg.error) {
            const errObj = msg.error as Record<string, unknown>;
            handler.reject(new Error((errObj.message as string) ?? JSON.stringify(msg.error)));
          } else {
            handler.resolve(msg.result);
          }
        }
      }

      // Cap check #1 (mid-flight): the trailing partial line in
      // managed.buffer carries no newline yet. If its byte length already
      // exceeds the cap we are watching a hostile upstream stream an
      // unbounded line — reject the oldest pending call and discard further
      // bytes until the next newline so the orphan tail doesn't trigger a
      // second (innocent) rejection on the next data event.
      //
      // This MUST run after the complete-line loop above (see C1 above).
      if (
        maxResponseBytes > 0 &&
        Buffer.byteLength(managed.buffer, "utf8") > maxResponseBytes
      ) {
        const observed = Buffer.byteLength(managed.buffer, "utf8");
        managed.buffer = "";
        managed.discardingUntilNewline = true;
        rejectOldestPending(
          managed,
          new ResponseSizeExceededError(def.name, maxResponseBytes, observed)
        );
      }
    });
  }

  proc.on("exit", (code, signal) => {
    // Include server name, exit code, and signal in error message (#H-2)
    rejectAllPending(
      managed,
      new Error(`Server "${def.name}" exited (code=${code}, signal=${signal})`)
    );
  });

  return managed;
}

export function createStdioBridge(servers: StdioServerDef[], options: StdioBridgeOptions = {}): StdioBridge {
  // Resolve defaults once at construction time so all consumers see the same values
  const logLevel: LogLevel = options.logLevel ?? "info";
  const failFastNonJsonLines = options.failFastNonJsonLines ?? 5;
  const gracePeriodMs = options.shutdownGracePeriodMs ?? 5000;
  const hardCeilingMs = options.shutdownHardCeilingMs ?? 2000;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const processes = new Map<string, ManagedProcess>();
  const definitions = new Map<string, StdioServerDef>();

  for (const def of servers) {
    definitions.set(def.name, def);
  }

  function getOrSpawn(name: string): ManagedProcess {
    const existing = processes.get(name);
    // A broken process is permanently dead — refuse to use it. The caller will
    // see the brokenReason in their rejection. We deliberately do NOT respawn:
    // a misconfigured spawn won't fix itself, and respawning would waste time.
    if (existing && existing.brokenReason) {
      throw new Error(existing.brokenReason);
    }
    if (existing && existing.proc.exitCode === null) return existing;

    // Reject old pending entries before replacing (#H-4)
    if (existing) {
      rejectAllPending(existing, new Error(`Server "${name}" process died, restarting`));
    }

    const def = definitions.get(name);
    if (!def) throw new Error(`Server "${name}" not found or not configured`);

    const managed = spawnServer(def, logLevel, failFastNonJsonLines, maxResponseBytes);
    processes.set(name, managed);
    return managed;
  }

  return {
    async call(serverName: string, method: string, params: unknown): Promise<unknown> {
      // getOrSpawn throws synchronously for broken/missing servers — let it propagate
      // as a rejected promise via the async function wrapper.
      const managed = getOrSpawn(serverName);
      const id = managed.nextId++;

      return new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(() => {
          managed.pending.delete(id);
          reject(new Error(`Request ${id} to "${serverName}" timed out after 30s`));
        }, 30000);

        managed.pending.set(id, { resolve, reject, timeout });

        if (!managed.proc.stdin || managed.proc.stdin.destroyed) {
          clearTimeout(timeout);
          managed.pending.delete(id);
          reject(new Error(`Server "${serverName}" stdin not available`));
          return;
        }

        const request = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
        managed.proc.stdin.write(request);
      });
    },

    async shutdown(): Promise<void> {
      const exitPromises: Promise<void>[] = [];
      for (const [, managed] of processes) {
        rejectAllPending(managed, new Error("Bridge shutting down")); // clears timeouts (#H-3)
        exitPromises.push(shutdownOne(managed, gracePeriodMs, hardCeilingMs));
      }

      try {
        // allSettled — one server's failure must not abort the others
        await Promise.allSettled(exitPromises);
      } finally {
        processes.clear();
      }
    },

    _getProcessInfo(serverName: string): ProcessInfo | null {
      const managed = processes.get(serverName);
      if (!managed) return null;
      return {
        pid: managed.proc.pid,
        exitCode: managed.proc.exitCode,
        signalCode: managed.proc.signalCode,
      };
    },
  };
}

/**
 * Gracefully terminate one managed process. Three phases:
 *   1. SIGTERM, race against gracePeriodMs
 *   2. If grace expires, SIGKILL and race against hardCeilingMs
 *   3. If hard ceiling expires, log a leak and return (the process is wedged)
 *
 * Exported for testing the timer logic in isolation.
 */
export async function shutdownOne(
  managed: ManagedProcess,
  gracePeriodMs: number,
  hardCeilingMs: number
): Promise<void> {
  const proc = managed.proc;
  const name = managed.def.name;

  // Already exited — nothing to do
  if (proc.exitCode !== null || proc.signalCode !== null) return;

  // Listener attached BEFORE kill so we can't miss the exit event.
  // Stored as a named handler so we can remove it on the leak path.
  let onExit: (() => void) | undefined;
  const exited = new Promise<void>((resolve) => {
    onExit = () => resolve();
    proc.once("exit", onExit);
    // Race recheck (#C-2): if exit fired between the early-return check above and
    // this listener attachment, the listener will never fire — check synchronously here.
    if (proc.exitCode !== null || proc.signalCode !== null) resolve();
  });

  // Send SIGTERM (default kill signal). Tolerate ESRCH/EPERM — child may have died.
  try {
    proc.kill();
  } catch (err) {
    log.error({ server: name, err }, "SIGTERM failed");
  }

  // Race graceful exit against the grace period
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const graceExpired = new Promise<"timeout">((resolve) => {
    graceTimer = setTimeout(() => resolve("timeout"), gracePeriodMs);
  });

  const result = await Promise.race([exited.then(() => "exited" as const), graceExpired]);
  if (graceTimer) clearTimeout(graceTimer);

  if (result === "exited") return;

  // Grace period exceeded — escalate to SIGKILL and wait for actual exit
  log.error({ server: name, gracePeriodMs }, "Server did not exit within grace period, sending SIGKILL");
  try {
    proc.kill("SIGKILL");
  } catch (err) {
    log.error({ server: name, err }, "SIGKILL failed");
  }

  // SIGKILL is async — wait for the actual exit event before returning (#C-1)
  // Hard ceiling prevents hanging forever if the kernel can't reap the child.
  let hardTimerHandle: ReturnType<typeof setTimeout> | undefined;
  const hardExpired = new Promise<"hard-timeout">((resolve) => {
    hardTimerHandle = setTimeout(() => resolve("hard-timeout"), hardCeilingMs);
  });
  const final = await Promise.race([exited.then(() => "exited" as const), hardExpired]);
  if (hardTimerHandle) clearTimeout(hardTimerHandle);

  if (final === "hard-timeout") {
    // Process is wedged — clean up the listener we never collected from to avoid
    // a leaked listener on a stale ChildProcess reference.
    if (onExit) proc.removeListener("exit", onExit);
    log.error({ server: name, hardCeilingMs }, "Server still alive after SIGKILL — leaking");
  }
}
