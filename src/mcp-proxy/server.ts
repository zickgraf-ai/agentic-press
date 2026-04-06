import express, { type Express, type Request, type Response } from "express";
import type { LogLevel } from "../types.js";
import { checkAllowlist, type AllowlistConfig } from "./allowlist.js";
import { checkPath } from "../security/path-guard.js";
import { sanitize } from "./sanitizer.js";
import { logAuditEntry, type AuditEntry } from "./logger.js";

export interface ProxyServerConfig {
  readonly port: number;
  readonly allowedTools: readonly string[];
  readonly logLevel: LogLevel;
  readonly workspaceRoot?: string;
}

interface JsonRpcRequest {
  jsonrpc: string;
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

function isJsonRpc(body: unknown): body is JsonRpcRequest {
  if (!body || typeof body !== "object") return false;
  const obj = body as Record<string, unknown>;
  return obj.jsonrpc === "2.0" && obj.method !== undefined && obj.id !== undefined;
}

function jsonRpcError(id: number | string | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function extractPathArgs(args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const [key, val] of Object.entries(args)) {
    if (typeof val === "string" && (key === "path" || key === "file" || key === "file_path" || key === "uri")) {
      paths.push(val);
    }
  }
  return paths;
}

export function createProxyServer(config: ProxyServerConfig): Express {
  const app = express();
  app.use(express.json());

  const allowlistConfig: AllowlistConfig = { patterns: [...config.allowedTools] };
  const workspaceRoot = config.workspaceRoot ?? process.env.WORKSPACE_ROOT ?? process.cwd();

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", port: config.port });
  });

  app.post("/mcp", (req: Request, res: Response) => {
    const start = Date.now();
    const body = req.body;

    if (!isJsonRpc(body)) {
      res.status(400).json(jsonRpcError(null, -32700, "Invalid JSON-RPC request"));
      return;
    }

    const { id, method, params } = body;

    // Only handle tools/call — pass through other methods
    if (method !== "tools/call" || !params) {
      res.json(jsonRpcError(id, -32601, `Method not supported: ${method}`));
      return;
    }

    const toolName = params.name as string;
    const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;

    // 1. Allowlist check
    const allowResult = checkAllowlist(toolName, allowlistConfig);
    if (!allowResult.allowed) {
      const entry: AuditEntry = {
        timestamp: new Date().toISOString(),
        tool: toolName,
        args: toolArgs,
        status: "blocked",
        flags: [],
        durationMs: Date.now() - start,
      };
      logAuditEntry(entry);
      res.json(jsonRpcError(id, -32600, allowResult.reason));
      return;
    }

    // 2. Path guard — check any path-like arguments
    const paths = extractPathArgs(toolArgs);
    for (const p of paths) {
      const pathResult = checkPath(p, { workspaceRoot });
      if (!pathResult.allowed) {
        const entry: AuditEntry = {
          timestamp: new Date().toISOString(),
          tool: toolName,
          args: toolArgs,
          status: "blocked",
          flags: [],
          durationMs: Date.now() - start,
        };
        logAuditEntry(entry);
        res.json(jsonRpcError(id, -32600, `Blocked path: ${pathResult.reason}`));
        return;
      }
    }

    // 3. Forward to MCP server (stub — no backend yet, returns error)
    // TODO: Wire to stdio bridge in integration (Issue #8)
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      tool: toolName,
      args: toolArgs,
      status: "allowed",
      flags: [],
      durationMs: Date.now() - start,
    };
    logAuditEntry(entry);

    res.json(jsonRpcError(id, -32603, `No MCP backend configured for tool "${toolName}"`));
  });

  return app;
}
