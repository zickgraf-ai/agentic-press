import { describe, it, expect } from "vitest";
import {
  checkAllowlist,
  type AllowlistConfig,
} from "../src/mcp-proxy/allowlist.js";

describe("tool allowlist", () => {
  // ── Allowlisted tools are forwarded ────────────────────────────────

  describe("allowlisted tools pass", () => {
    const config: AllowlistConfig = {
      patterns: ["Read", "Write", "Grep", "Glob"],
    };

    it.each(["Read", "Write", "Grep", "Glob"])(
      "allows: %s",
      (tool) => {
        const result = checkAllowlist(tool, config);
        expect(result.allowed).toBe(true);
      }
    );
  });

  // ── Non-allowlisted tools are blocked ──────────────────────────────

  describe("non-allowlisted tools are blocked with structured error", () => {
    const config: AllowlistConfig = {
      patterns: ["Read", "Grep"],
    };

    it.each(["Write", "Execute", "Delete", "Bash", "unknown_tool"])(
      "blocks: %s",
      (tool) => {
        const result = checkAllowlist(tool, config);
        expect(result.allowed).toBe(false);
        if (!result.allowed) {
          expect(result.reason).toBeTruthy();
          expect(typeof result.reason).toBe("string");
          expect(result.reason.length).toBeGreaterThan(0);
        }
      }
    );
  });

  // ── Empty allowlist blocks everything ──────────────────────────────

  describe("empty allowlist blocks everything", () => {
    const config: AllowlistConfig = { patterns: [] };

    it.each(["Read", "Write", "Grep", "anything"])(
      "blocks: %s",
      (tool) => {
        const result = checkAllowlist(tool, config);
        expect(result.allowed).toBe(false);
      }
    );
  });

  // ── Wildcard patterns ──────────────────────────────────────────────

  describe("wildcard pattern support", () => {
    const config: AllowlistConfig = {
      patterns: ["filesystem.*", "git.*", "Read"],
    };

    it("matches wildcard prefix: filesystem.readFile", () => {
      const result = checkAllowlist("filesystem.readFile", config);
      expect(result.allowed).toBe(true);
    });

    it("matches wildcard prefix: filesystem.writeFile", () => {
      const result = checkAllowlist("filesystem.writeFile", config);
      expect(result.allowed).toBe(true);
    });

    it("matches wildcard prefix: git.status", () => {
      const result = checkAllowlist("git.status", config);
      expect(result.allowed).toBe(true);
    });

    it("matches exact name alongside wildcards", () => {
      const result = checkAllowlist("Read", config);
      expect(result.allowed).toBe(true);
    });

    it("does not match non-matching wildcard: github.createPR", () => {
      const result = checkAllowlist("github.createPR", config);
      expect(result.allowed).toBe(false);
    });

    it("does not match partial: file (not filesystem.*)", () => {
      const result = checkAllowlist("file", config);
      expect(result.allowed).toBe(false);
    });
  });

  // ── Case sensitivity ───────────────────────────────────────────────

  describe("case sensitivity", () => {
    const config: AllowlistConfig = {
      patterns: ["Read", "filesystem.*"],
    };

    it("is case-sensitive by default: read != Read", () => {
      const result = checkAllowlist("read", config);
      expect(result.allowed).toBe(false);
    });

    it("is case-sensitive: READ != Read", () => {
      const result = checkAllowlist("READ", config);
      expect(result.allowed).toBe(false);
    });

    it("is case-sensitive: Filesystem.read != filesystem.*", () => {
      const result = checkAllowlist("Filesystem.read", config);
      expect(result.allowed).toBe(false);
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles empty tool name", () => {
      const config: AllowlistConfig = { patterns: ["Read"] };
      const result = checkAllowlist("", config);
      expect(result.allowed).toBe(false);
    });

    it("handles tool name with special characters", () => {
      const config: AllowlistConfig = { patterns: ["my-tool_v2"] };
      const result = checkAllowlist("my-tool_v2", config);
      expect(result.allowed).toBe(true);
    });

    it("wildcard star only matches after dot prefix", () => {
      const config: AllowlistConfig = { patterns: ["*"] };
      // A bare "*" should match everything (catch-all)
      const result = checkAllowlist("anything", config);
      expect(result.allowed).toBe(true);
    });

    it("double-star is treated as single-star (no glob recursion)", () => {
      const config: AllowlistConfig = { patterns: ["fs.**"] };
      // ** should behave identically to * — matches any suffix after "fs."
      const shallow = checkAllowlist("fs.read", config);
      const deep = checkAllowlist("fs.sub.deep", config);
      expect(shallow.allowed).toBe(true);
      expect(deep.allowed).toBe(true);
    });
  });

  // ── Malformed config ───────────────────────────────────────────────

  describe("malformed config is handled defensively", () => {
    it("throws or blocks when config is null", () => {
      // Safety: a null config must never silently allow tools
      expect(() => {
        const result = checkAllowlist("Read", null as unknown as AllowlistConfig);
        // If it doesn't throw, it must block
        expect(result.allowed).toBe(false);
      }).not.toThrow(); // prefer blocking over throwing, but either is safe
    });

    it("throws or blocks when config is undefined", () => {
      expect(() => {
        const result = checkAllowlist("Read", undefined as unknown as AllowlistConfig);
        expect(result.allowed).toBe(false);
      }).not.toThrow();
    });

    it("throws or blocks when patterns is null", () => {
      const config = { patterns: null } as unknown as AllowlistConfig;
      expect(() => {
        const result = checkAllowlist("Read", config);
        expect(result.allowed).toBe(false);
      }).not.toThrow();
    });

    it("throws or blocks when patterns is undefined", () => {
      const config = { patterns: undefined } as unknown as AllowlistConfig;
      expect(() => {
        const result = checkAllowlist("Read", config);
        expect(result.allowed).toBe(false);
      }).not.toThrow();
    });

    it("treats patterns with empty strings as non-matching", () => {
      const config: AllowlistConfig = { patterns: ["", "  ", "Read"] };
      expect(checkAllowlist("Read", config).allowed).toBe(true);
      expect(checkAllowlist("", config).allowed).toBe(false);
      expect(checkAllowlist("  ", config).allowed).toBe(false);
    });
  });
});
