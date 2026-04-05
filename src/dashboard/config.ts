export type DashboardConfig =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly url: string; readonly apiKey?: string };

export function loadDashboardConfig(): DashboardConfig {
  throw new Error("Not implemented");
}
