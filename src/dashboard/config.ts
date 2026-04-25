import { childLogger } from "../logger.js";

const log = childLogger("dashboard");

export type DashboardConfig =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly url: string; readonly apiKey?: string };

/**
 * Build a DashboardConfig from an env-var record. Returns `{ enabled: false }`
 * when `MISSION_CONTROL_URL` is absent or empty — dashboard integration is
 * strictly opt-in. Warns when `MISSION_CONTROL_API_KEY` is set without a URL
 * (likely a misconfiguration).
 */
export function loadDashboardConfig(
  env: Readonly<Record<string, string | undefined>>
): DashboardConfig {
  const rawUrl = env.MISSION_CONTROL_URL;
  const apiKey = env.MISSION_CONTROL_API_KEY;

  // Warn on key-without-URL — a typo in the URL var name would otherwise
  // silently disable the dashboard and leave a dangling API key.
  if (!rawUrl?.trim() && apiKey) {
    log.warn("MISSION_CONTROL_API_KEY is set without MISSION_CONTROL_URL — dashboard disabled");
    return { enabled: false };
  }

  if (!rawUrl || rawUrl.trim().length === 0) {
    return { enabled: false };
  }

  const url = rawUrl.trim().replace(/\/+$/, "");

  if (apiKey) {
    return { enabled: true, url, apiKey };
  }
  return { enabled: true, url };
}
