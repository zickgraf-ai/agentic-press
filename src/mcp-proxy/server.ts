import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { randomBytes } from "node:crypto";
import type { LogLevel } from "../types.js";
import { checkAllowlist, matchesPattern, type AllowlistConfig } from "./allowlist.js";
import { checkPath } from "../security/path-guard.js";
import { sanitize } from "./sanitizer.js";
import { logAuditEntry, type AuditEntry } from "./logger.js";
import type { StdioBridge } from "./stdio-bridge.js";
import {
  createNoopTracer,
  type Tracer,
  type ActiveTrace,
  type SpanToolCallParams,
  type EndTraceParams,
} from "../observability/langfuse.js";

export interface ProxyServerConfig {
  readonly port: number;
  readonly allowedTools: readonly string[];
  readonly logLevel: LogLevel;
  readonly workspaceRoot?: string;
  readonly bridge?: StdioBridge;
  readonly serverRoutes?: Record<string, string>; // tool pattern → server name
  readonly tracer?: Tracer;
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

/**
 * Generic internal-error message for unexpected exception paths. The raw
 * error message is logged server-side alongside the correlation id so
 * operators can grep; the client sees a reference they can quote when
 * reporting problems. This prevents filesystem paths, stack frames, or
 * backend error strings from leaking through the JSON-RPC envelope.
 */
function genericInternalError(correlationId: string): string {
  return `Internal proxy error (ref: ${correlationId})`;
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

// Sort route entries by specificity: exact matches first, then longest prefix first.
export function sortRoutes(routes: Record<string, string>): [string, string][] {
  return Object.entries(routes).sort(([a], [b]) => {
    const aWild = a.endsWith("*");
    const bWild = b.endsWith("*");
    if (aWild !== bWild) return aWild ? 1 : -1; // Exact matches first
    return b.length - a.length; // Longer patterns first
  });
}

// Match a tool name against pre-sorted route patterns using the same wildcard logic as the allowlist.
export function resolveRoute(toolName: string, sortedRoutes: [string, string][]): string | undefined {
  for (const [pattern, serverName] of sortedRoutes) {
    if (matchesPattern(toolName, pattern)) return serverName;
  }
  return undefined;
}

export function createProxyServer(config: ProxyServerConfig): Express {
  const app = express();
  app.use(express.json());

  const allowlistConfig: AllowlistConfig = { patterns: [...config.allowedTools] };
  const workspaceRoot = config.workspaceRoot ?? process.env.WORKSPACE_ROOT ?? process.cwd();
  const { bridge } = config;
  const sortedRoutes = config.serverRoutes ? sortRoutes(config.serverRoutes) : undefined;
  const tracer: Tracer = config.tracer ?? createNoopTracer();

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", port: config.port });
  });

  app.post("/mcp", (req: Request, res: Response) => {
    const start = Date.now();
    // Short, log-correlation-friendly id. Regenerated per request.
    const correlationId = randomBytes(8).toString("hex");
    let requestId: number | string | null = null; // Hoisted for catch block (#N-3)
    let toolName: string | undefined; // Hoisted so outer catch can emit a span (#C2)
    let activeTrace: ActiveTrace | undefined;

    // Belt-and-braces defense around ActiveTrace calls. The enabled langfuse
    // tracer already isolates SDK errors inside span/end — but a custom
    // user-supplied Tracer implementation could return an ActiveTrace that
    // throws. Observability MUST NEVER break the request path (#C5), so we
    // wrap every call at the server layer too. The ActiveTrace contract
    // still guarantees idempotency for end() regardless of throws.
    function safeSpan(params: SpanToolCallParams) {
      if (!activeTrace) return;
      try {
        activeTrace.span(params);
      } catch (err) {
        console.warn(`[${correlationId}] tracer.span threw (ignored):`, err);
      }
    }
    function safeEnd(params: EndTraceParams) {
      if (!activeTrace) return;
      try {
        activeTrace.end(params);
      } catch (err) {
        console.warn(`[${correlationId}] tracer.end threw (ignored):`, err);
      }
    }

    function audit(
      tool: string,
      args: Record<string, unknown>,
      status: AuditEntry["status"],
      flags: AuditEntry["flags"] = [],
      errorMessage?: string
    ) {
      logAuditEntry({
        timestamp: new Date().toISOString(),
        tool,
        args,
        status,
        flags,
        durationMs: Date.now() - start,
        ...(errorMessage !== undefined ? { errorMessage } : {}),
      });
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

      toolName = params.name as string;
      const tool = toolName; // Narrowed alias for use inside async callbacks
      const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;

      // Start the trace once we know which tool was requested. Note: sessionId
      // is intentionally omitted — there is no real session concept yet, and
      // per-request JSON-RPC ids would defeat Langfuse's session grouping. The
      // request id travels in metadata so it is still searchable.
      //
      // Defensive try/catch even though ActiveTrace.span/end isolate errors:
      // a future Tracer impl could throw from startTrace itself. If it does,
      // we fall through with activeTrace=undefined and every later `?.span`
      // / `?.end` becomes a no-op.
      try {
        activeTrace = tracer.startTrace({
          name: `mcp.request:${tool}`,
          metadata: { method, requestId, correlationId },
        });
      } catch (err) {
        console.warn("[tracer] startTrace failed:", err);
        activeTrace = undefined;
      }

      // 1. Allowlist check
      const allowResult = checkAllowlist(tool, allowlistConfig);
      if (!allowResult.allowed) {
        audit(tool, toolArgs, "blocked");
        safeSpan({ tool, status: "blocked", durationMs: Date.now() - start });
        safeEnd({ outcome: "blocked" });
        res.json(jsonRpcError(requestId, -32600, allowResult.reason));
        return;
      }

      // 2. Sanitize individual string values in arguments (#N-2)
      const sanitizeResult = sanitizeArgs(toolArgs);
      if (sanitizeResult && sanitizeResult.flags.length > 0) {
        const patternStrings = sanitizeResult.flags.map((f) => f.pattern);
        audit(tool, toolArgs, "flagged", sanitizeResult.flags);
        safeSpan({ tool, status: "flagged", durationMs: Date.now() - start, flags: patternStrings });
        safeEnd({ outcome: "flagged" });
        res.json(
          jsonRpcError(
            requestId,
            -32600,
            `Injection pattern detected in arguments: ${patternStrings.join(", ")}`
          )
        );
        return;
      }

      // 3. Path guard — recursively check all path-like strings (#N-1)
      const paths = extractPathArgs(toolArgs);
      for (const p of paths) {
        const pathResult = checkPath(p, { workspaceRoot });
        if (!pathResult.allowed) {
          audit(tool, toolArgs, "blocked");
          safeSpan({ tool, status: "blocked", durationMs: Date.now() - start });
          safeEnd({ outcome: "blocked" });
          res.json(jsonRpcError(requestId, -32600, `Blocked path: ${pathResult.reason}`));
          return;
        }
      }

      // 4. Forward to MCP server via bridge
      if (!bridge || !sortedRoutes) {
        audit(tool, toolArgs, "allowed");
        safeSpan({ tool, status: "allowed", durationMs: Date.now() - start });
        safeEnd({ outcome: "allowed" });
        res.json(jsonRpcError(requestId, -32603, `No MCP backend configured for tool "${tool}"`));
        return;
      }

      const serverName = resolveRoute(tool, sortedRoutes);
      if (!serverName) {
        audit(tool, toolArgs, "blocked");
        safeSpan({ tool, status: "blocked", durationMs: Date.now() - start });
        safeEnd({ outcome: "blocked" });
        res.json(jsonRpcError(requestId, -32600, `No route configured for tool "${tool}"`));
        return;
      }

      // Async forwarding. ActiveTrace.end() is idempotent, so if the outer
      // catch also fires (it shouldn't on the async path, but belt+braces)
      // the second end() call is a no-op at the tracer level.
      bridge
        .call(serverName, "tools/call", params)
        .then((result) => {
          if (res.headersSent) return;
          audit(tool, toolArgs, "allowed");
          safeSpan({ tool, status: "allowed", durationMs: Date.now() - start });
          safeEnd({ outcome: "allowed" });
          res.json({ jsonrpc: "2.0", id: requestId, result });
        })
        .catch((err) => {
          if (res.headersSent) return;
          const rawMessage = err instanceof Error ? err.message : String(err);
          console.error(
            `[${correlationId}] Bridge call to "${serverName}" failed:`,
            rawMessage
          );
          try {
            audit(tool, toolArgs, "error", [], rawMessage);
          } catch (auditErr) {
            console.error(`[${correlationId}] Audit logging failed:`, auditErr);
          }
          safeSpan({ tool, status: "error", durationMs: Date.now() - start });
          safeEnd({ outcome: "error" });
          res.json(jsonRpcError(requestId, -32603, genericInternalError(correlationId)));
        });
      return; // Response handled in promise callbacks
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      console.error(`[${correlationId}] MCP proxy error:`, rawMessage); // (#N-4)
      try {
        audit(toolName ?? "<unknown>", {}, "error", [], rawMessage);
      } catch (auditErr) {
        console.error(`[${correlationId}] Audit logging failed:`, auditErr);
      }
      // Best-effort: close any in-flight trace so we never leak an open trace
      // across requests. end() is idempotent so double-ends are harmless.
      safeSpan({ tool: toolName ?? "<unknown>", status: "error", durationMs: Date.now() - start });
      safeEnd({ outcome: "error" });
      res.status(500).json(jsonRpcError(requestId, -32603, genericInternalError(correlationId)));
    }
  });

  // Global error handler (#H-5). Emits a new correlation id because this path
  // runs outside the per-request handler's closure.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    const correlationId = randomBytes(8).toString("hex");
    console.error(`[${correlationId}] MCP proxy unhandled error:`, err.message); // (#N-4)
    res.status(500).json(jsonRpcError(null, -32603, genericInternalError(correlationId)));
  });

  return app;
}
