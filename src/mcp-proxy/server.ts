import type { Express } from "express";

export interface ProxyServerConfig {
  port: number;
  allowedTools: string[];
  logLevel: string;
}

export function createProxyServer(_config: ProxyServerConfig): Express {
  throw new Error("Not implemented");
}
