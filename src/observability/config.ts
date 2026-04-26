import { childLogger } from "../logger.js";

export type LangfuseConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly publicKey: string;
      readonly secretKey: string;
      readonly host: string;
    };

export type MetricsConfig =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly port: number };

export interface ObservabilityConfig {
  readonly langfuse: LangfuseConfig;
  readonly metrics: MetricsConfig;
}

const log = childLogger("config");
const DEFAULT_LANGFUSE_HOST = "https://cloud.langfuse.com";

/**
 * Build a MetricsConfig from an env-var record. Returns `{ enabled: false }`
 * when `METRICS_PORT` is absent, empty, or invalid (non-numeric, out of
 * range). Warns on invalid values so a typo is loud, never throws — startup
 * must not fail because of observability.
 */
export function loadMetricsConfig(
  env: Readonly<Record<string, string | undefined>>
): MetricsConfig {
  const raw = env.METRICS_PORT?.trim();
  if (!raw) return { enabled: false };
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    log.warn(`METRICS_PORT="${raw}" is not a valid TCP port (1-65535) — metrics disabled`);
    return { enabled: false };
  }
  return { enabled: true, port };
}

/**
 * Build a LangfuseConfig from an env-var record. The function takes its env
 * source as an argument so it is trivially unit-testable; the composition root
 * passes `process.env`. Returns `{ enabled: false }` whenever either credential
 * is missing or empty — agentic-press treats Langfuse as strictly opt-in and
 * must never throw on missing credentials.
 */
export function loadLangfuseConfig(
  env: Readonly<Record<string, string | undefined>>
): LangfuseConfig {
  const publicKey = env.LANGFUSE_PUBLIC_KEY;
  const secretKey = env.LANGFUSE_SECRET_KEY;
  // Warn loudly on half-configured credentials — a typo in one of the env var
  // names would otherwise silently disable tracing and make the misconfig very
  // hard to notice in prod.
  const hasPublic = Boolean(publicKey);
  const hasSecret = Boolean(secretKey);
  if (hasPublic !== hasSecret) {
    log.warn("only one credential is set (LANGFUSE_PUBLIC_KEY or LANGFUSE_SECRET_KEY) — tracing disabled");
    return { enabled: false };
  }
  if (!publicKey || !secretKey) {
    return { enabled: false };
  }
  return {
    enabled: true,
    publicKey,
    secretKey,
    host: env.LANGFUSE_HOST && env.LANGFUSE_HOST.length > 0
      ? env.LANGFUSE_HOST
      : DEFAULT_LANGFUSE_HOST,
  };
}
