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

// Recursively extract path-like strings from args (#N-1)
// Path-like: starts with /, ./, ../, ~, or a drive letter (C:)
// Recurses into nested objects and arrays
function extractPathArgs(value: unknown): string[] {
  if (typeof value === "string") {
    if (/^(\/|\.\/|\.\.\/)/.test(value) || /^~\//.test(value) || /^[A-Za-z]:/.test(value)) {
      return [value];
    }
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(extractPathArgs);
  }
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(extractPathArgs);
  }
  return [];
}

// Sanitize individual string values, not serialized JSON (#N-2)
function sanitizeArgs(args: Record<string, unknown>): ReturnType<typeof sanitize> | null {
  for (const val of collectStrings(args)) {
    const result = sanitize(val);
    if (result.flags.length > 0) return result;
  }
  return null;
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(collectStrings);
  return [];
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
    let requestId: number | string | null = null; // Hoisted for catch block (#N-3)

    try {
      const body = req.body;

      if (!isJsonRpc(body)) {
        res.status(400).json(jsonRpcError(null, -32700, "Invalid JSON-RPC request"));
        return;
      }

      requestId = body.id;
      const { method, params } = body;

      // Only handle tools/call — reject other methods
      if (method !== "tools/call" || !params) {
        res.json(jsonRpcError(requestId, -32601, `Method not supported: ${method}`));
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
        res.json(jsonRpcError(requestId, -32600, allowResult.reason));
        return;
      }

      // 2. Sanitize individual string values in arguments (#N-2)
      const sanitizeResult = sanitizeArgs(toolArgs);
      if (sanitizeResult && sanitizeResult.flags.length > 0) {
        const entry: AuditEntry = {
          timestamp: new Date().toISOString(),
          tool: toolName,
          args: toolArgs,
          status: "flagged",
          flags: sanitizeResult.flags,
          durationMs: Date.now() - start,
        };
        logAuditEntry(entry);
        res.json(jsonRpcError(requestId, -32600, `Injection pattern detected in arguments: ${sanitizeResult.flags.map(f => f.pattern).join(", ")}`));
        return;
      }

      // 3. Path guard — recursively check all path-like strings (#N-1)
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
          res.json(jsonRpcError(requestId, -32600, `Blocked path: ${pathResult.reason}`));
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

      res.json(jsonRpcError(requestId, -32603, `No MCP backend configured for tool "${toolName}"`));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal server error";
      console.error("MCP proxy error:", err); // (#N-4)
      res.status(500).json(jsonRpcError(requestId, -32603, message));
    }
  });

  // Global error handler (#H-5)
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("MCP proxy unhandled error:", err); // (#N-4)
    res.status(500).json(jsonRpcError(null, -32603, err.message));
  });

  return app;
}
