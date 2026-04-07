import { spawn, type ChildProcess } from "node:child_process";

export interface McpServerDef {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface StdioBridge {
  call(serverName: string, method: string, params: unknown): Promise<unknown>;
  shutdown(): Promise<void>;
  /** Expose child process for testing. Returns null if not spawned. */
  getProcess(serverName: string): ChildProcess | null;
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

export function createStdioBridge(servers: McpServerDef[]): StdioBridge {
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

        // If already exited, no need to wait
        if (managed.proc.exitCode !== null) {
          continue;
        }

        // Wait for exit event with a timeout to avoid hanging forever
        const exitPromise = new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            // Force kill if graceful shutdown didn't work
            managed.proc.kill("SIGKILL");
            resolve();
          }, 5000);

          managed.proc.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });

        managed.proc.kill();
        exitPromises.push(exitPromise);
      }

      await Promise.all(exitPromises);
      processes.clear();
    },

    getProcess(serverName: string): ChildProcess | null {
      const managed = processes.get(serverName);
      return managed ? managed.proc : null;
    },
  };
}
