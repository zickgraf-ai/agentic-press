import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { childLogger } from "../logger.js";
import { logAuditEntry } from "../mcp-proxy/logger.js";
import {
  SESSION_ID_PATTERN,
  SESSION_ID_MAX_LEN,
  validateSessionInput,
  type SessionRegistry,
} from "./session-registry.js";

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
  } catch (err) {
    // timingSafeEqual is virtually unreachable on this path — same-length
    // Buffers built from utf-8 strings shouldn't throw — but a silent `false`
    // on an unexpected error would hide a real bug. Surface it via warn-log
    // so operators see the failure mode if it ever fires. Still return false
    // (treat as wrong token) so the auth contract is preserved.
    log.warn({ err }, "tokenMatches: timingSafeEqual threw unexpectedly — treating as wrong token");
    return false;
  }
}

/**
 * Discriminated union for control-plane audit calls (F8). The compiler now
 * enforces that register entries carry `allowedToolsCount` + `agentType`,
 * and deregister entries do NOT. Previously a single Omit-based type
 * accepted optional fields uniformly, so a deregister caller could mistakenly
 * pass `allowedToolsCount` (or omit it on register) and TypeScript wouldn't
 * catch it.
 */
export interface RegisterAuditFields {
  readonly action: "register";
  readonly sessionId: string;
  readonly agentType: string;
  readonly allowedToolsCount: number;
  readonly remoteAddress: string;
  readonly remotePort: number;
}

export interface DeregisterAuditFields {
  readonly action: "deregister";
  readonly sessionId: string;
  readonly remoteAddress: string;
  readonly remotePort: number;
}

export type ControlPlaneAuditFields = RegisterAuditFields | DeregisterAuditFields;

function emitControlPlaneAudit(fields: ControlPlaneAuditFields): void {
  try {
    if (fields.action === "register") {
      logAuditEntry({
        timestamp: new Date().toISOString(),
        tool: "",
        args: {},
        status: "allowed",
        flags: [],
        direction: "control-plane",
        action: "register",
        sessionId: fields.sessionId,
        agentType: fields.agentType,
        allowedToolsCount: fields.allowedToolsCount,
        remoteAddress: fields.remoteAddress,
        remotePort: fields.remotePort,
      });
    } else {
      logAuditEntry({
        timestamp: new Date().toISOString(),
        tool: "",
        args: {},
        status: "allowed",
        flags: [],
        direction: "control-plane",
        action: "deregister",
        sessionId: fields.sessionId,
        remoteAddress: fields.remoteAddress,
        remotePort: fields.remotePort,
      });
    }
  } catch (err) {
    // Audit-log failures must never break the request path (#C5).
    log.warn({ err }, "control-plane audit write failed (ignored)");
  }
}

function parseRegisterPayload(body: unknown): { ok: true; value: RegisterPayload } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Body must be a JSON object" };
  }
  const obj = body as Record<string, unknown>;
  // Single source of truth for the contract (`validateSessionInput` in
  // session-registry.ts) — same rules apply whether the registration arrives
  // over HTTP or via a future in-process caller.
  const validation = validateSessionInput({
    sessionId: obj.sessionId,
    agentType: obj.agentType,
    allowedTools: obj.allowedTools,
  });
  if (!validation.ok) return validation;
  return {
    ok: true,
    value: {
      sessionId: obj.sessionId as string,
      agentType: obj.agentType as string,
      allowedTools: obj.allowedTools as string[],
    },
  };
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
    const parsed = parseRegisterPayload(req.body);
    if (!parsed.ok) {
      log.warn(
        { ...remoteIdentity(req), reason: "validation", detail: parsed.error },
        "control-plane register rejected"
      );
      res.status(400).json({ error: parsed.error });
      return;
    }
    const { sessionId, agentType, allowedTools } = parsed.value;
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
    const removed = config.registry.deregister(sessionId);
    if (removed) {
      // Audit only on actual state change. A no-op DELETE (session id not
      // present) is a bug signal (operator thinks the session existed) but
      // not a real state mutation — recording it would let a buggy CLI in
      // a retry loop flood the audit NDJSON, mirroring the 401/400 probe-
      // flood rationale. Warn-log so operators see the mismatch.
      emitControlPlaneAudit({
        action: "deregister",
        sessionId,
        ...remoteIdentity(req),
      });
    } else {
      log.warn(
        { ...remoteIdentity(req), sessionId, reason: "session_not_found" },
        "control-plane deregister: session not found (no-op, idempotent 204)"
      );
    }
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
