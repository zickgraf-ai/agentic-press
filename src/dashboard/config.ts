export interface DashboardConfig {
  enabled: boolean;
  url?: string;
  apiKey?: string;
}

export function loadDashboardConfig(): DashboardConfig {
  throw new Error("Not implemented");
}
