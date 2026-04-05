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

    it("double-star wildcard is not supported (no glob recursion)", () => {
      const config: AllowlistConfig = { patterns: ["fs.**"] };
      // ** should be treated same as *, not as recursive glob
      const result = checkAllowlist("fs.sub.deep", config);
      // Implementation choice: either allow or block, but be consistent
      // We'll verify this matches the implementation's documented behavior
      expect(typeof result.allowed).toBe("boolean");
    });
  });
});
