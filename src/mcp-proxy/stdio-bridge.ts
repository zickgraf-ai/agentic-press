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
}

interface ManagedProcess {
  proc: ChildProcess;
  nextId: number;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  buffer: string;
}

function spawnServer(def: McpServerDef): ManagedProcess {
  const proc = spawn(def.command, def.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...def.env },
  });

  const managed: ManagedProcess = {
    proc,
    nextId: 1,
    pending: new Map(),
    buffer: "",
  };

  proc.stdout!.setEncoding("utf8");
  proc.stdout!.on("data", (chunk: string) => {
    managed.buffer += chunk;
    const lines = managed.buffer.split("\n");
    managed.buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && managed.pending.has(msg.id)) {
          const handler = managed.pending.get(msg.id)!;
          managed.pending.delete(msg.id);
          if (msg.error) {
            handler.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
          } else {
            handler.resolve(msg.result);
          }
        }
      } catch {
        // Ignore non-JSON lines
      }
    }
  });

  proc.on("exit", () => {
    for (const [, handler] of managed.pending) {
      handler.reject(new Error(`Server process exited`));
    }
    managed.pending.clear();
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
    let managed = processes.get(name);
    if (managed && managed.proc.exitCode === null) return managed;

    const def = definitions.get(name);
    if (!def) throw new Error(`Server "${name}" not found or not configured`);

    managed = spawnServer(def);
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
          reject(new Error(`Request ${id} to "${serverName}" timed out`));
        }, 30000);

        managed.pending.set(id, {
          resolve: (v) => { clearTimeout(timeout); resolve(v); },
          reject: (e) => { clearTimeout(timeout); reject(e); },
        });

        const request = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
        managed.proc.stdin!.write(request);
      });
    },

    async shutdown(): Promise<void> {
      for (const [, managed] of processes) {
        managed.proc.kill();
        for (const [, handler] of managed.pending) {
          handler.reject(new Error("Bridge shutting down"));
        }
        managed.pending.clear();
      }
      processes.clear();
    },
  };
}
