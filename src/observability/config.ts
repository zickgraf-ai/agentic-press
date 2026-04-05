export type LangfuseConfig =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly publicKey: string; readonly secretKey: string; readonly host: string };

export type MetricsConfig =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly port: number };

export interface ObservabilityConfig {
  readonly langfuse: LangfuseConfig;
  readonly metrics: MetricsConfig;
}

export function loadObservabilityConfig(): ObservabilityConfig {
  throw new Error("Not implemented");
}
