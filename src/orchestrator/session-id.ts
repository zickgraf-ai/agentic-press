import { randomBytes } from "node:crypto";

declare const sessionIdBrand: unique symbol;
export type SessionId = string & { readonly [sessionIdBrand]: true };

// 128 bits — unguessable session IDs are the floor of the identity-spoofing
// defence (docs/security.md#identity-spoofing). Safe to raise, not lower.
export const SESSION_ID_BYTES = 16;

export function mintSessionId(): SessionId {
  return randomBytes(SESSION_ID_BYTES).toString("hex") as SessionId;
}

// Cast a known-valid string (e.g. from a validated header on a different
// request path) to the branded type. Use sparingly; mintSessionId is the
// canonical constructor.
export function asSessionId(s: string): SessionId {
  return s as SessionId;
}
