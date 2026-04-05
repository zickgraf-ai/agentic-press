import type { Express } from "express";
import type { LogLevel } from "../types.js";

export interface ProxyServerConfig {
  readonly port: number;
  readonly allowedTools: readonly string[];
  readonly logLevel: LogLevel;
}

export function createProxyServer(_config: ProxyServerConfig): Express {
  throw new Error("Not implemented");
}
