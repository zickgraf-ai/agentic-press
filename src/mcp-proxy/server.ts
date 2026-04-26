import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { randomBytes } from "node:crypto";
import type { LogLevel } from "../types.js";
import { childLogger } from "../logger.js";
import { checkAllowlist, matchesPattern, type AllowlistConfig } from "./allowlist.js";
import { checkPath } from "../security/path-guard.js";
import { sanitize } from "./sanitizer.js";
import { sanitizeResponse } from "./response-sanitizer.js";
import { logAuditEntry, type AuditEntry } from "./logger.js";
import { ResponseSizeExceededError } from "./stdio-bridge.js";
import type { McpTransport } from "./transport.js";
import {
  createNoopTracer,
  type Tracer,
  type ActiveTrace,
  type SpanToolCallParams,
  type EndTraceParams,
} from "../observability/langfuse.js";
import { createNoopEventBridge, type EventBridge } from "../dashboard/event-bridge.js";
import { createNoopRecorder, type MetricsRecorder, type BlockReason } from "../observability/metrics.js";

const log = childLogger("mcp-proxy");

export interface ProxyServerConfig {
  readonly port: number;
  readonly allowedTools: readonly string[];
  readonly logLevel: LogLevel;
  readonly workspaceRoot?: string;
  readonly bridge?: McpTransport;
  readonly serverRoutes?: Record<string, string>; // tool pattern → server name
  readonly tracer?: Tracer;
  readonly eventBridge?: EventBridge;
  readonly recorder?: MetricsRecorder;
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

/**
 * Single source of truth for the client-facing response-rejection message.
 * Used by every response-side rejection path (size cap, sanitizer flag,
 * sanitizer-throws-during-parse) so an attacker cannot distinguish them by
 * the message body. Centralising this is a defence-in-depth invariant:
 * duplicating the literal across call sites means a future "improvement" to
 * one path silently breaks the indistinguishability property the size-probe
 * defence depends on.
 */
export function responseRejectMessage(correlationId: string): string {
  return `Response blocked by response sanitizer (ref: ${correlationId})`;
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
  const eventBridge: EventBridge = config.eventBridge ?? createNoopEventBridge();
  const recorder: MetricsRecorder = config.recorder ?? createNoopRecorder();

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", port: config.port });
  });

  app.post("/mcp", (req: Request, res: Response) => {
    const start = Date.now();
    // Short, log-correlation-friendly id. Regenerated per request.
    const correlationId = randomBytes(8).toString("hex");
    res.locals.correlationId = correlationId;
    const reqLog = log.child({ correlationId });
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
        reqLog.warn({ err }, "tracer.span threw (ignored)");
      }
    }
    function safeEnd(params: EndTraceParams) {
      if (!activeTrace) return;
      try {
        activeTrace.end(params);
      } catch (err) {
        reqLog.warn({ err }, "tracer.end threw (ignored)");
      }
    }

    function safeEmit(entry: AuditEntry) {
      try {
        eventBridge.emit(entry);
      } catch (err) {
        reqLog.warn({ err }, "eventBridge.emit threw (ignored)");
      }
    }

    function safeRecord(entry: AuditEntry, blockReason?: BlockReason) {
      // Coerce tool name for blocked entries to a sentinel so an attacker
      // submitting many distinct names cannot blow up registry cardinality.
      // The block-reason label still distinguishes WHY it was blocked.
      const toolLabel = entry.status === "blocked" ? "_blocked" : entry.tool;
      try {
        recorder.recordRequest(toolLabel, entry.status, entry.durationMs ?? 0);
      } catch (err) {
        reqLog.warn({ err }, "recorder.recordRequest threw (ignored)");
      }
      if (entry.status === "flagged") {
        for (const f of entry.flags) {
          try {
            recorder.recordInjectionFlag(f.pattern);
          } catch (err) {
            reqLog.warn({ err }, "recorder.recordInjectionFlag threw (ignored)");
          }
        }
      } else if (entry.status === "blocked") {
        try {
          recorder.recordBlockedRequest(blockReason ?? "unknown");
        } catch (err) {
          reqLog.warn({ err }, "recorder.recordBlockedRequest threw (ignored)");
        }
      }
    }

    function audit(
      tool: string,
      args: Record<string, unknown>,
      status: AuditEntry["status"],
      flags: AuditEntry["flags"] = [],
      errorMessage?: string,
      direction: AuditEntry["direction"] = "request",
      blockReason?: BlockReason
    ) {
      const entry: AuditEntry = {
        timestamp: new Date().toISOString(),
        tool,
        args,
        status,
        flags,
        durationMs: Date.now() - start,
        direction,
        ...(errorMessage !== undefined ? { errorMessage } : {}),
      };
      logAuditEntry(entry);
      safeEmit(entry);
      safeRecord(entry, blockReason);
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
        reqLog.warn({ err }, "startTrace failed");
        activeTrace = undefined;
      }

      // 1. Allowlist check
      const allowResult = checkAllowlist(tool, allowlistConfig);
      if (!allowResult.allowed) {
        audit(tool, toolArgs, "blocked", [], undefined, "request", "allowlist");
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
          audit(tool, toolArgs, "blocked", [], undefined, "request", "path_guard");
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
        audit(tool, toolArgs, "blocked", [], undefined, "request", "no_route");
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
          // Response-side sanitization: upstream MCP server output is
          // attacker-controlled (see CVE-2025-6514). Walk string-valued
          // fields; reject the entire response on any flag so raw matched
          // content never reaches the agent. Fail CLOSED: if the walker
          // itself throws (pathological input, e.g. deep/cyclic hostile
          // response), treat it as a rejection, not a pass-through.
          let respFlags;
          try {
            respFlags = sanitizeResponse(result).flags;
          } catch (sanitizeErr) {
            const rawMessage = sanitizeErr instanceof Error ? sanitizeErr.message : String(sanitizeErr);
            reqLog.error({ server: serverName, error: rawMessage }, "Response sanitizer threw");
            audit(tool, toolArgs, "error", [], rawMessage, "response");
            safeSpan({ tool, status: "error", durationMs: Date.now() - start });
            safeEnd({ outcome: "error" });
            res.json(
              jsonRpcError(
                requestId,
                -32001,
                responseRejectMessage(correlationId)
              )
            );
            return;
          }
          if (respFlags.length > 0) {
            const patternStrings = [...new Set(respFlags.map((f) => f.pattern))];
            const operatorSummary = `response sanitizer: ${patternStrings.join(", ")}`;
            audit(tool, toolArgs, "flagged", respFlags, operatorSummary, "response");
            safeSpan({ tool, status: "flagged", durationMs: Date.now() - start, flags: patternStrings });
            safeEnd({ outcome: "flagged" });
            res.json(
              jsonRpcError(
                requestId,
                -32001,
                responseRejectMessage(correlationId)
              )
            );
            return;
          }
          audit(tool, toolArgs, "allowed", [], undefined, "response");
          safeSpan({ tool, status: "allowed", durationMs: Date.now() - start });
          safeEnd({ outcome: "allowed" });
          res.json({ jsonrpc: "2.0", id: requestId, result });
        })
        .catch((err) => {
          if (res.headersSent) return;

          // Response-size cap rejection. We deliberately reuse the response
          // sanitizer's client-facing error message so an attacker cannot
          // distinguish a size-cap rejection from a content-pattern rejection
          // (size-probe defence — leaking a distinct -32001 + "size" signal
          // would let an adversary binary-search the cap value). Operator
          // visibility comes through the audit entry's structured
          // errorMessage field instead.
          if (err instanceof ResponseSizeExceededError) {
            try {
              audit(
                tool,
                toolArgs,
                "blocked",
                [],
                "response size cap exceeded",
                "response"
              );
            } catch (auditErr) {
              reqLog.error({ err: auditErr }, "Audit logging failed");
            }
            reqLog.error(
              {
                server: serverName,
                limitBytes: err.limitBytes,
                observedBytes: err.observedBytes,
              },
              "Upstream response exceeded size cap"
            );
            safeSpan({ tool, status: "blocked", durationMs: Date.now() - start });
            safeEnd({ outcome: "blocked" });
            res.json(
              jsonRpcError(
                requestId,
                -32001,
                responseRejectMessage(correlationId)
              )
            );
            return;
          }

          const rawMessage = err instanceof Error ? err.message : String(err);
          reqLog.error({ server: serverName, error: rawMessage }, "Bridge call failed");
          try {
            // direction="response" — the request passed all filters and was
            // forwarded upstream, so the failure is on the response side.
            // Operators filtering by direction === "response" rely on this.
            audit(tool, toolArgs, "error", [], rawMessage, "response");
          } catch (auditErr) {
            reqLog.error({ err: auditErr }, "Audit logging failed");
          }
          safeSpan({ tool, status: "error", durationMs: Date.now() - start });
          safeEnd({ outcome: "error" });
          res.json(jsonRpcError(requestId, -32603, genericInternalError(correlationId)));
        });
      return; // Response handled in promise callbacks
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      reqLog.error({ error: rawMessage }, "MCP proxy error");
      try {
        audit(toolName ?? "<unknown>", {}, "error", [], rawMessage);
      } catch (auditErr) {
        reqLog.error({ err: auditErr }, "Audit logging failed");
      }
      // Best-effort: close any in-flight trace so we never leak an open trace
      // across requests. end() is idempotent so double-ends are harmless.
      safeSpan({ tool: toolName ?? "<unknown>", status: "error", durationMs: Date.now() - start });
      safeEnd({ outcome: "error" });
      res.status(500).json(jsonRpcError(requestId, -32603, genericInternalError(correlationId)));
    }
  });

  // Global error handler (#H-5). Reuses the per-request correlationId from
  // res.locals so the client-facing ref matches the server-side log entry.
  // Falls back to a fresh id only if the error fires before the request
  // handler stored one (e.g. middleware-level failure).
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    const correlationId = (res.locals.correlationId as string) ?? randomBytes(8).toString("hex");
    log.error({ correlationId, error: err.message }, "MCP proxy unhandled error");
    res.status(500).json(jsonRpcError(null, -32603, genericInternalError(correlationId)));
  });

  return app;
}
