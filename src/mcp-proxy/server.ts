import express, { type Express, type Request, type Response, type NextFunction } from "express";
import type { LogLevel } from "../types.js";
import { checkAllowlist, matchesPattern, type AllowlistConfig } from "./allowlist.js";
import { checkPath } from "../security/path-guard.js";
import { sanitize } from "./sanitizer.js";
import { logAuditEntry, type AuditEntry } from "./logger.js";
import type { StdioBridge } from "./stdio-bridge.js";

export interface ProxyServerConfig {
  readonly port: number;
  readonly allowedTools: readonly string[];
  readonly logLevel: LogLevel;
  readonly workspaceRoot?: string;
  readonly bridge?: StdioBridge;
  readonly serverRoutes?: Record<string, string>; // tool pattern → server name
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

// Match a tool name against route patterns using the same wildcard logic as the allowlist
function resolveRoute(toolName: string, routes: Record<string, string>): string | undefined {
  for (const [pattern, serverName] of Object.entries(routes)) {
    if (matchesPattern(toolName, pattern)) return serverName;
  }
  return undefined;
}

export function createProxyServer(config: ProxyServerConfig): Express {
  const app = express();
  app.use(express.json());

  const allowlistConfig: AllowlistConfig = { patterns: [...config.allowedTools] };
  const workspaceRoot = config.workspaceRoot ?? process.env.WORKSPACE_ROOT ?? process.cwd();
  const { bridge, serverRoutes } = config;

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", port: config.port });
  });

  app.post("/mcp", (req: Request, res: Response) => {
    const start = Date.now();
    let requestId: number | string | null = null; // Hoisted for catch block (#N-3)

    function audit(tool: string, args: Record<string, unknown>, status: AuditEntry["status"], flags: AuditEntry["flags"] = []) {
      logAuditEntry({ timestamp: new Date().toISOString(), tool, args, status, flags, durationMs: Date.now() - start });
    }

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
        audit(toolName, toolArgs, "blocked");
        res.json(jsonRpcError(requestId, -32600, allowResult.reason));
        return;
      }

      // 2. Sanitize individual string values in arguments (#N-2)
      const sanitizeResult = sanitizeArgs(toolArgs);
      if (sanitizeResult && sanitizeResult.flags.length > 0) {
        audit(toolName, toolArgs, "flagged", sanitizeResult.flags);
        res.json(jsonRpcError(requestId, -32600, `Injection pattern detected in arguments: ${sanitizeResult.flags.map(f => f.pattern).join(", ")}`));
        return;
      }

      // 3. Path guard — recursively check all path-like strings (#N-1)
      const paths = extractPathArgs(toolArgs);
      for (const p of paths) {
        const pathResult = checkPath(p, { workspaceRoot });
        if (!pathResult.allowed) {
          audit(toolName, toolArgs, "blocked");
          res.json(jsonRpcError(requestId, -32600, `Blocked path: ${pathResult.reason}`));
          return;
        }
      }

      // 4. Forward to MCP server via bridge
      if (!bridge || !serverRoutes) {
        audit(toolName, toolArgs, "allowed");
        res.json(jsonRpcError(requestId, -32603, `No MCP backend configured for tool "${toolName}"`));
        return;
      }

      const serverName = resolveRoute(toolName, serverRoutes);
      if (!serverName) {
        audit(toolName, toolArgs, "blocked");
        res.json(jsonRpcError(requestId, -32600, `No route configured for tool "${toolName}"`));
        return;
      }

      // Async forwarding — must handle promise
      bridge
        .call(serverName, "tools/call", params)
        .then((result) => {
          audit(toolName, toolArgs, "allowed");
          res.json({ jsonrpc: "2.0", id: requestId, result });
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : "Bridge call failed";
          console.error(`Bridge call to "${serverName}" failed:`, err);
          audit(toolName, toolArgs, "error");
          res.json(jsonRpcError(requestId, -32603, message));
        });
      return; // Response handled in promise callbacks
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
