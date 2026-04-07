import { spawn, type ChildProcess } from "node:child_process";

export interface McpServerDef {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** Subset of ChildProcess fields exposed for test introspection. */
export interface ProcessInfo {
  readonly pid: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
}

export interface StdioBridgeOptions {
  /** Milliseconds to wait for graceful exit before SIGKILL. Default: 5000. */
  readonly shutdownGracePeriodMs?: number;
}

export interface StdioBridge {
  call(serverName: string, method: string, params: unknown): Promise<unknown>;
  shutdown(): Promise<void>;
  /** @internal Test-only introspection of a managed child process. */
  getProcessInfo(serverName: string): ProcessInfo | null;
}

interface PendingHandler {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface ManagedProcess {
  def: McpServerDef;
  proc: ChildProcess;
  nextId: number;
  pending: Map<number, PendingHandler>;
  buffer: string;
}

function rejectAllPending(managed: ManagedProcess, error: Error): void {
  for (const [, handler] of managed.pending) {
    clearTimeout(handler.timeout);
    handler.reject(error);
  }
  managed.pending.clear();
}

function spawnServer(def: McpServerDef): ManagedProcess {
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
      managed.buffer += chunk;
      const lines = managed.buffer.split("\n");
      managed.buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        // Only catch JSON parse errors — post-parse logic is outside try (#C-1)
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line);
        } catch {
          console.error(`[stdio-bridge] Non-JSON line from "${def.name}": ${line.slice(0, 200)}`);
          continue;
        }

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

export function createStdioBridge(servers: McpServerDef[], options: StdioBridgeOptions = {}): StdioBridge {
  const gracePeriodMs = options.shutdownGracePeriodMs ?? 5000;
  const processes = new Map<string, ManagedProcess>();
  const definitions = new Map<string, McpServerDef>();

  for (const def of servers) {
    definitions.set(def.name, def);
  }

  function getOrSpawn(name: string): ManagedProcess {
    const existing = processes.get(name);
    if (existing && existing.proc.exitCode === null) return existing;

    // Reject old pending entries before replacing (#H-4)
    if (existing) {
      rejectAllPending(existing, new Error(`Server "${name}" process died, restarting`));
    }

    const def = definitions.get(name);
    if (!def) throw new Error(`Server "${name}" not found or not configured`);

    const managed = spawnServer(def);
    processes.set(name, managed);
    return managed;
  }

  return {
    async call(serverName: string, method: string, params: unknown): Promise<unknown> {
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
        exitPromises.push(shutdownOne(managed, gracePeriodMs));
      }

      try {
        // allSettled — one server's failure must not abort the others
        await Promise.allSettled(exitPromises);
      } finally {
        processes.clear();
      }
    },

    getProcessInfo(serverName: string): ProcessInfo | null {
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

/** Gracefully terminate one managed process. Awaits exit event for both SIGTERM and SIGKILL phases. */
async function shutdownOne(managed: ManagedProcess, gracePeriodMs: number): Promise<void> {
  const proc = managed.proc;
  const name = managed.def.name;

  // Already exited — nothing to do
  if (proc.exitCode !== null || proc.signalCode !== null) return;

  // Wait for exit event (resolves promise once child is fully reaped)
  const exited = new Promise<void>((resolve) => {
    proc.once("exit", () => resolve());
    // Race recheck (#C-2): if exit fired between the early-return check above and
    // this listener attachment, the listener will never fire — check synchronously here.
    if (proc.exitCode !== null || proc.signalCode !== null) resolve();
  });

  // Send SIGTERM (default kill signal). Tolerate ESRCH/EPERM — child may have died.
  try {
    proc.kill();
  } catch (err) {
    console.error(`[stdio-bridge] SIGTERM to "${name}" failed:`, err);
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
  console.error(`[stdio-bridge] Server "${name}" did not exit within ${gracePeriodMs}ms, sending SIGKILL`);
  try {
    proc.kill("SIGKILL");
  } catch (err) {
    console.error(`[stdio-bridge] SIGKILL to "${name}" failed:`, err);
  }

  // SIGKILL is async — wait for the actual exit event before returning (#C-1)
  // Use a hard ceiling to prevent hanging forever if the kernel can't reap the child.
  const HARD_CEILING_MS = 2000;
  const hardTimer = new Promise<"hard-timeout">((resolve) =>
    setTimeout(() => resolve("hard-timeout"), HARD_CEILING_MS)
  );
  const final = await Promise.race([exited.then(() => "exited" as const), hardTimer]);
  if (final === "hard-timeout") {
    console.error(`[stdio-bridge] Server "${name}" still alive ${HARD_CEILING_MS}ms after SIGKILL — leaking`);
  }
}
