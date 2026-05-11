/**
 * Startup probe that confirms Langfuse credentials authenticate against the
 * configured host before the proxy declares "tracing enabled."
 *
 * Defends against a class of silent failure where the SDK accepts a public/
 * secret/host triple that doesn't match (typically a US-region key set with
 * a default EU host), uploads silently 401, and traces never appear in the
 * UI. The probe surfaces this as a loud warn at startup; the SDK is still
 * constructed so the operator can fix env and traces start working without
 * a restart (consistent with the "observability never breaks startup"
 * invariant).
 */

const DEFAULT_TIMEOUT_MS = 3_000;

export interface ProbeLangfuseAuthOptions {
  readonly host: string;
  readonly publicKey: string;
  readonly secretKey: string;
  readonly timeoutMs?: number;
}

export type ProbeResult =
  | { readonly ok: true; readonly projectId?: string }
  | { readonly ok: false; readonly reason: "auth"; readonly status: number }
  | { readonly ok: false; readonly reason: "server"; readonly status: number }
  | { readonly ok: false; readonly reason: "network" }
  | { readonly ok: false; readonly reason: "timeout" };

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || (err as { code?: unknown }).code === "ABORT_ERR");
}

function extractProjectId(text: string): string | undefined {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    // Langfuse's /api/public/projects returns { data: [{ id, name }, ...] }.
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "data" in parsed &&
      Array.isArray((parsed as { data: unknown }).data)
    ) {
      const first = (parsed as { data: unknown[] }).data[0];
      if (first && typeof first === "object" && "id" in first) {
        const id = (first as { id: unknown }).id;
        if (typeof id === "string" && id.length > 0) return id;
      }
    }
  } catch {
    // Body wasn't JSON — fall through. A 200 with non-JSON body is unusual
    // but not failure; we still consider the credentials verified.
  }
  return undefined;
}

export async function probeLangfuseAuth(opts: ProbeLangfuseAuthOptions): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${opts.host.replace(/\/$/, "")}/api/public/projects`;
  const authHeader = "Basic " + Buffer.from(`${opts.publicKey}:${opts.secretKey}`).toString("base64");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Authorization: authHeader, Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (err) {
    if (isAbortError(err)) return { ok: false, reason: "timeout" };
    return { ok: false, reason: "network" };
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    // Drain the body to free the socket; do NOT include in the result —
    // a hostile/buggy server could echo the secret key back in its 401 body.
    try {
      await res.text();
    } catch {
      // best-effort drain
    }
    return { ok: false, reason: "auth", status: res.status };
  }

  if (res.status >= 200 && res.status < 300) {
    let body = "";
    try {
      body = await res.text();
    } catch {
      // unable to read body — still consider 2xx a successful auth probe
    }
    const projectId = extractProjectId(body);
    return projectId !== undefined ? { ok: true, projectId } : { ok: true };
  }

  // Drain
  try {
    await res.text();
  } catch {
    // best-effort
  }
  return { ok: false, reason: "server", status: res.status };
}
