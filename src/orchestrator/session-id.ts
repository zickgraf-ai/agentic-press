import { randomBytes } from "node:crypto";

// 16 bytes = 128 bits of entropy. Threat-model row 4 (identity spoofing)
// requires session IDs unguessable by a colocated sandbox; this provides
// the floor on which that defence rests. Bumping above 16 is safe; below is not.
export const SESSION_ID_BYTES = 16;

export function mintSessionId(): string {
  return randomBytes(SESSION_ID_BYTES).toString("hex");
}
