import { describe, it, expect } from "vitest";
import { mintSessionId, SESSION_ID_BYTES } from "../../src/orchestrator/session-id.js";
import { validateSessionInput } from "../../src/orchestrator/session-registry.js";

describe("mintSessionId", () => {
  it("returns a 32-character string", () => {
    const id = mintSessionId();
    expect(id).toHaveLength(SESSION_ID_BYTES * 2);
    expect(id).toHaveLength(32);
  });

  it("matches the lowercase hex pattern", () => {
    for (let i = 0; i < 50; i++) {
      expect(mintSessionId()).toMatch(/^[a-f0-9]{32}$/);
    }
  });

  it("produces values that validateSessionInput accepts", () => {
    // Locks the shared-contract invariant: any minted ID must be a valid
    // control-plane sessionId. If validateSessionInput's charset/length
    // envelope ever tightens past 32-char lowercase hex, this test fails loud.
    const id = mintSessionId();
    const result = validateSessionInput({
      sessionId: id,
      agentType: "reviewer",
      allowedTools: ["echo__read_file"],
    });
    expect(result.ok).toBe(true);
  });

  it("produces unique values across 10 000 invocations", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const id = mintSessionId();
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
    expect(seen.size).toBe(10_000);
  });
});
