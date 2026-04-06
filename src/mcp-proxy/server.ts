import express, { type Express, type Request, type Response, type NextFunction } from "express";
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
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const obj = body as Record<string, unknown>;
  return obj.jsonrpc === "2.0" && obj.method !== undefined && obj.id !== undefined;
}

function jsonRpcError(id: number | string | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// Scan all string values in args for path-like content (#C-5)
// A string is path-like if it contains a slash or starts with a dot
function extractPathArgs(args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const [, val] of Object.entries(args)) {
    if (typeof val === "string" && (val.includes("/") || val.includes("\\") || val.startsWith("."))) {
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

    try {
      const body = req.body;

      if (!isJsonRpc(body)) {
        res.status(400).json(jsonRpcError(null, -32700, "Invalid JSON-RPC request"));
        return;
      }

      const { id, method, params } = body;

      // Only handle tools/call — reject other methods with JSON-RPC error (#H-6)
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

      // 2. Sanitize tool arguments — check for injection patterns (#C-4)
      const argString = JSON.stringify(toolArgs);
      const sanitizeResult = sanitize(argString);
      if (sanitizeResult.flags.length > 0) {
        const entry: AuditEntry = {
          timestamp: new Date().toISOString(),
          tool: toolName,
          args: toolArgs,
          status: "flagged",
          flags: sanitizeResult.flags,
          durationMs: Date.now() - start,
        };
        logAuditEntry(entry);
        res.json(jsonRpcError(id, -32600, `Injection pattern detected in arguments: ${sanitizeResult.flags.map(f => f.pattern).join(", ")}`));
        return;
      }

      // 3. Path guard — check all path-like string values in arguments
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

      // 4. Forward to MCP server (stub — no backend yet)
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
    } catch (err) {
      // Always return JSON-RPC errors, never HTML (#H-5)
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(500).json(jsonRpcError(null, -32603, message));
    }
  });

  // Global error handler — ensures JSON-RPC responses even on unexpected errors (#H-5)
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json(jsonRpcError(null, -32603, err.message));
  });

  return app;
}
