export interface ObservabilityConfig {
  langfuse: {
    enabled: boolean;
    publicKey?: string;
    secretKey?: string;
    host?: string;
  };
  metrics: {
    enabled: boolean;
    port: number;
  };
}

export function loadObservabilityConfig(): ObservabilityConfig {
  throw new Error("Not implemented");
}
