import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { childLogger } from "../logger.js";
import { logAuditEntry, type AuditEntry } from "../mcp-proxy/logger.js";
import type { SessionRegistry } from "./session-registry.js";

const log = childLogger("control-plane");

/**
 * Tier 1.3 (#56) — control-plane HTTP server.
 *
 * Exposes register / deregister / list endpoints for the session registry.
 * Designed to be reachable ONLY from host-side processes (the dispatch CLI /
 * Mission Control connector). Two layers of defence:
 *
 *   1. Loopback bind on 127.0.0.1:18924 — set in `src/index.ts`, NOT here.
 *      Sandboxes cannot reach the host's loopback interface; they reach the
 *      host's Docker bridge IP via `host.docker.internal`. Hard-coded literal
 *      so an operator cannot widen it via env (decision #3 in the plan).
 *   2. Bearer-token gate via `MCP_CONTROL_TOKEN` on every endpoint except
 *      `/health`. Constant-time comparison via `crypto.timingSafeEqual`, with
 *      explicit length check first (timingSafeEqual throws on length mismatch).
 *      Length-mismatch is treated as a wrong token (401), not a 400.
 *
 * Audit-log invariants:
 *   - Successful POST/DELETE write a single audit entry with
 *     `direction: "control-plane"` and structured fields capturing the action,
 *     session id, agent type, source remote addr/port, and allowed-tools COUNT.
 *     Tool names themselves are NEVER recorded (operator-private allowlist).
 *   - 401 / 400 rejections do NOT write audit entries — only warn-log — to
 *     prevent a probe burst from flooding the NDJSON file.
 *   - Token value never appears in any log line, audit entry, or response.
 *
 * Input-validation invariants for register: same charset/length envelope as
 * the identity-header parser (#52) so Prometheus / OTEL / NDJSON consumers
 * all see consistently bounded values.
 */

const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const AGENT_TYPE_PATTERN = /^[A-Za-z0-9._-]+$/;
/**
 * Charset for allowedTools entries. Adds `*` (wildcard) on top of the
 * sessionId/agentType charset since matchesPattern() supports prefix-suffix
 * wildcards. Rejecting other characters closes a class of injection
 * vectors — null bytes, newlines, zero-width unicode (U+200B/FEFF/200D),
 * control characters — that would otherwise round-trip through any future
 * code path that logs or serialises pattern values. Today only the count
 * is recorded in audit, but this charset is the contract for future
 * surfaces (e.g. richer audit logging, MC display).
 */
const ALLOWLIST_PATTERN_CHARSET = /^[A-Za-z0-9._*-]+$/;
const SESSION_ID_MAX_LEN = 128;
const AGENT_TYPE_MAX_LEN = 32;
const ALLOWLIST_PATTERN_MAX_LEN = 256;
const ALLOWLIST_MAX_ENTRIES = 256;

export interface ControlPlaneServerConfig {
  readonly registry: SessionRegistry;
  readonly token: string;
}

interface RegisterPayload {
  sessionId: string;
  agentType: string;
  allowedTools: string[];
}

function tokenMatches(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}

function emitControlPlaneAudit(entry: Omit<AuditEntry, "timestamp" | "tool" | "args" | "flags" | "status"> & {
  readonly status?: AuditEntry["status"];
}): void {
  try {
    logAuditEntry({
      timestamp: new Date().toISOString(),
      tool: "",
      args: {},
      status: entry.status ?? "allowed",
      flags: [],
      direction: "control-plane",
      ...(entry.action !== undefined ? { action: entry.action } : {}),
      ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
      ...(entry.agentType !== undefined ? { agentType: entry.agentType } : {}),
      ...(entry.remoteAddress !== undefined ? { remoteAddress: entry.remoteAddress } : {}),
      ...(entry.remotePort !== undefined ? { remotePort: entry.remotePort } : {}),
      ...(entry.allowedToolsCount !== undefined ? { allowedToolsCount: entry.allowedToolsCount } : {}),
    });
  } catch (err) {
    // Audit-log failures must never break the request path (#C5).
    log.warn({ err }, "control-plane audit write failed (ignored)");
  }
}

function validateRegisterPayload(body: unknown): { ok: true; value: RegisterPayload } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Body must be a JSON object" };
  }
  const obj = body as Record<string, unknown>;
  const sessionId = obj.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > SESSION_ID_MAX_LEN || !SESSION_ID_PATTERN.test(sessionId)) {
    return { ok: false, error: `Invalid sessionId — must be 1..${SESSION_ID_MAX_LEN} chars matching [A-Za-z0-9._-]+` };
  }
  const agentType = obj.agentType;
  if (typeof agentType !== "string" || agentType.length === 0 || agentType.length > AGENT_TYPE_MAX_LEN || !AGENT_TYPE_PATTERN.test(agentType)) {
    return { ok: false, error: `Invalid agentType — must be 1..${AGENT_TYPE_MAX_LEN} chars matching [A-Za-z0-9._-]+` };
  }
  const allowedTools = obj.allowedTools;
  if (!Array.isArray(allowedTools)) {
    return { ok: false, error: "Invalid allowedTools — must be an array" };
  }
  if (allowedTools.length === 0) {
    return { ok: false, error: "Invalid allowedTools — must be a non-empty array" };
  }
  if (allowedTools.length > ALLOWLIST_MAX_ENTRIES) {
    return { ok: false, error: `Invalid allowedTools — too many entries (max ${ALLOWLIST_MAX_ENTRIES})` };
  }
  for (const t of allowedTools) {
    if (typeof t !== "string" || t.length === 0 || t.length > ALLOWLIST_PATTERN_MAX_LEN) {
      return { ok: false, error: "Invalid allowedTools — every entry must be a non-empty string within length bounds" };
    }
    if (!ALLOWLIST_PATTERN_CHARSET.test(t)) {
      return {
        ok: false,
        error: "Invalid allowedTools — entries must match [A-Za-z0-9._*-]+ (no whitespace, control chars, null bytes, or unicode)",
      };
    }
    // Reject bare catch-alls. Per-session allowlists exist to enforce
    // least-privilege per agent; a bare "*" / "**" pattern grants unrestricted
    // tool access and supersedes any narrower global ALLOWED_TOOLS list,
    // which is the opposite of the control plane's purpose. Operators who
    // want catch-all behaviour should rely on the global allowlist; the
    // per-session surface accepts only specific names or prefix wildcards
    // (e.g. "echo__*"). This is consistent with allowlist.ts:matchesPattern,
    // which already rejects "**" without a non-empty prefix.
    if (t === "*" || /^\*+$/.test(t)) {
      return {
        ok: false,
        error: `Invalid allowedTools — bare catch-all "${t}" is not allowed in per-session allowlists. Use specific tool names or prefix wildcards (e.g. "echo__*").`,
      };
    }
  }
  return { ok: true, value: { sessionId, agentType, allowedTools: allowedTools as string[] } };
}

function remoteIdentity(req: Request): { remoteAddress: string; remotePort: number } {
  const sock = req.socket;
  return {
    remoteAddress: sock?.remoteAddress ?? "",
    remotePort: sock?.remotePort ?? 0,
  };
}

export function createControlPlaneServer(config: ControlPlaneServerConfig): Express {
  const app = express();
  app.use(express.json({ limit: "64kb" }));

  // Bearer-token middleware — applied to every /sessions* route. /health
  // (declared above this middleware below) is exempt by route registration
  // order and by an explicit guard in the middleware itself.
  function authMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (req.path === "/health") {
      next();
      return;
    }
    const auth = req.header("authorization");
    if (!auth || !auth.startsWith("Bearer ")) {
      log.warn(
        { ...remoteIdentity(req), path: req.path, method: req.method, reason: "missing_or_malformed_authorization" },
        "control-plane request rejected"
      );
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const provided = auth.slice("Bearer ".length);
    if (!tokenMatches(provided, config.token)) {
      log.warn(
        { ...remoteIdentity(req), path: req.path, method: req.method, reason: "wrong_token" },
        "control-plane request rejected"
      );
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  }

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
  });

  app.use(authMiddleware);

  app.post("/sessions", (req: Request, res: Response) => {
    const validation = validateRegisterPayload(req.body);
    if (!validation.ok) {
      log.warn(
        { ...remoteIdentity(req), reason: "validation", detail: validation.error },
        "control-plane register rejected"
      );
      res.status(400).json({ error: validation.error });
      return;
    }
    const { sessionId, agentType, allowedTools } = validation.value;
    try {
      config.registry.register({
        sessionId,
        agentType,
        allowlist: { patterns: allowedTools },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(
        { ...remoteIdentity(req), reason: "registry_rejected", detail: message },
        "control-plane register rejected by registry"
      );
      res.status(400).json({ error: message });
      return;
    }
    emitControlPlaneAudit({
      action: "register",
      sessionId,
      agentType,
      allowedToolsCount: allowedTools.length,
      ...remoteIdentity(req),
    });
    res.status(201).json({ sessionId });
  });

  app.delete("/sessions/:sessionId", (req: Request, res: Response) => {
    const rawSessionId = req.params.sessionId;
    const sessionId = typeof rawSessionId === "string" ? rawSessionId : "";
    if (!sessionId || sessionId.length > SESSION_ID_MAX_LEN || !SESSION_ID_PATTERN.test(sessionId)) {
      log.warn(
        { ...remoteIdentity(req), reason: "invalid_session_id" },
        "control-plane deregister rejected — invalid session id in path"
      );
      res.status(400).json({ error: "Invalid sessionId in path" });
      return;
    }
    config.registry.deregister(sessionId);
    emitControlPlaneAudit({
      action: "deregister",
      sessionId,
      ...remoteIdentity(req),
    });
    res.status(204).end();
  });

  app.get("/sessions", (_req: Request, res: Response) => {
    // Operator-private allowlist contents NEVER leave the registry. Only the
    // session id, agent type, and registration timestamp are returned.
    const list = config.registry.list().map((entry) => ({
      sessionId: entry.sessionId,
      agentType: entry.agentType,
      registeredAt: entry.registeredAt,
    }));
    res.json(list);
  });

  // JSON 404 catch-all. Express's default 404 returns HTML that reflects the
  // requested path in the response body. The control-plane API is otherwise
  // JSON throughout, so an authenticated probe to an undefined route should
  // get a JSON error instead of an HTML page that echoes path content.
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "Not found" });
  });

  // Global error handler — never let an unhandled error leak the token (the
  // bearer-token middleware would already have stripped it from req, but
  // belt-and-braces for any future error path that touches authorization).
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    log.error({ error: err.message }, "control-plane unhandled error");
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal control-plane error" });
    }
  });

  return app;
}
