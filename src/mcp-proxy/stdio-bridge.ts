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

export function createStdioBridge(
  _servers: McpServerDef[]
): StdioBridge {
  throw new Error("Not implemented");
}
