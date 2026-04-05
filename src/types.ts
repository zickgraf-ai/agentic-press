// Branded types for compile-time safety on identity strings
declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

export type SessionId = Brand<string, "SessionId">;
export type TraceId = Brand<string, "TraceId">;
export type SandboxId = Brand<string, "SandboxId">;

export type LogLevel = "debug" | "info" | "warn" | "error";
export type AuditStatus = "allowed" | "blocked" | "flagged";
