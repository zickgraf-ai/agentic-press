export interface AuditEntry {
  timestamp: string;
  tool: string;
  args: Record<string, unknown>;
  status: "allowed" | "blocked" | "flagged";
  flags: string[];
  durationMs?: number;
}

export function logAuditEntry(_entry: AuditEntry): void {
  throw new Error("Not implemented");
}
