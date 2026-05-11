// Startup probe — informational only; never disables tracing on failure.

const DEFAULT_TIMEOUT_MS = 3_000;
// Cap body reads at startup so a hostile endpoint cannot OOM the proxy
// before tracing even comes online.
const MAX_BODY_BYTES = 64 * 1024;

export interface ProbeLangfuseAuthOptions {
  readonly host: string;
  readonly publicKey: string;
  readonly secretKey: string;
  readonly timeoutMs?: number;
}

export type ProbeResult =
  | { readonly ok: true; readonly projectId?: string }
  | { readonly ok: false; readonly reason: "auth"; readonly status: 401 | 403 }
  | { readonly ok: false; readonly reason: "server"; readonly status: number }
  | { readonly ok: false; readonly reason: "unexpected-shape"; readonly status: number }
  | { readonly ok: false; readonly reason: "network" }
  | { readonly ok: false; readonly reason: "timeout" };

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  return err instanceof Error && (err.name === "AbortError" || (err as { code?: unknown }).code === "ABORT_ERR");
}

async function readBoundedText(res: Response): Promise<string> {
  // Stream-aware cap so a 10 GB body doesn't allocate 10 GB before we check.
  // Falls back to res.text() if the body is unavailable (test stubs, mocks).
  if (!res.body) {
    try {
      const text = await res.text();
      return text.length > MAX_BODY_BYTES ? text.slice(0, MAX_BODY_BYTES) : text;
    } catch {
      return "";
    }
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
        if (total >= MAX_BODY_BYTES) {
          try {
            await reader.cancel();
          } catch {
            // ignore — we already have enough
          }
          break;
        }
      }
    }
  } catch {
    return "";
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c)) as unknown as Uint8Array[]).slice(0, MAX_BODY_BYTES));
}

interface LangfuseProjectsBody {
  readonly data: readonly { readonly id: string }[];
}

function parseProjectsBody(text: string): LangfuseProjectsBody | null {
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || !("data" in parsed)) return null;
  const data = (parsed as { data: unknown }).data;
  if (!Array.isArray(data)) return null;
  return { data: data as LangfuseProjectsBody["data"] };
}

function isJsonContentType(res: Response): boolean {
  const ct = res.headers.get("content-type") ?? "";
  return /\bapplication\/json\b/i.test(ct);
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
      // Refuse redirects so the Basic-auth header cannot leak to a third-party host.
      redirect: "error",
    });
  } catch (err) {
    if (isAbortError(err)) return { ok: false, reason: "timeout" };
    return { ok: false, reason: "network" };
  } finally {
    clearTimeout(timer);
  }

  // Drain the body for any branch we don't otherwise consume. Bounded so a
  // hostile server cannot stall startup or balloon memory.
  if (res.status === 401 || res.status === 403) {
    await readBoundedText(res);
    return { ok: false, reason: "auth", status: res.status as 401 | 403 };
  }

  if (res.status >= 200 && res.status < 300) {
    // Lenient success was the original bug. Require the response to actually
    // look like a Langfuse /api/public/projects payload — JSON content-type
    // AND a parseable { data: [...] } envelope — before declaring credentials
    // verified. A captive portal or wrong-service host returning 200/HTML
    // surfaces as `unexpected-shape`, not as a false positive.
    if (!isJsonContentType(res)) {
      await readBoundedText(res);
      return { ok: false, reason: "unexpected-shape", status: res.status };
    }
    const text = await readBoundedText(res);
    const body = parseProjectsBody(text);
    if (body === null) return { ok: false, reason: "unexpected-shape", status: res.status };
    const first = body.data[0];
    if (first && typeof first.id === "string" && first.id.length > 0) {
      // Cap projectId length defensively; never echo a megabyte from the wire.
      const id = first.id.length > 128 ? first.id.slice(0, 128) : first.id;
      return { ok: true, projectId: id };
    }
    return { ok: true };
  }

  await readBoundedText(res);
  return { ok: false, reason: "server", status: res.status };
}
