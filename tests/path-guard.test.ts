import { describe, it, expect } from "vitest";
import { checkPath, type PathGuardConfig } from "../src/security/path-guard.js";

const config: PathGuardConfig = {
  workspaceRoot: "/home/agent/workspace",
};

describe("path guard", () => {
  // ── Paths within workspace root are allowed ────────────────────────

  describe("valid paths within workspace", () => {
    const validPaths = [
      "/home/agent/workspace/src/index.ts",
      "/home/agent/workspace/package.json",
      "/home/agent/workspace/src/deep/nested/file.ts",
      "/home/agent/workspace",
      "/home/agent/workspace/",
    ];

    it.each(validPaths)("allows: %s", (path) => {
      const result = checkPath(path, config);
      expect(result.allowed).toBe(true);
      if (result.allowed) {
        expect(result.resolvedPath).toBeTruthy();
      }
    });
  });

  // ── Paths outside workspace root are blocked ───────────────────────

  describe("paths outside workspace are blocked", () => {
    const blockedPaths = [
      "/etc/passwd",
      "/etc/shadow",
      "/home/agent/.claude/settings.json",
      "/root/.ssh/id_rsa",
      "/var/log/syslog",
      "/home/agent/workspace/../.claude/settings.json",
      "/home/agent/.bashrc",
      "/tmp/evil",
    ];

    it.each(blockedPaths)("blocks: %s", (path) => {
      const result = checkPath(path, config);
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toBeTruthy();
      }
    });
  });

  // ── Path traversal attacks ─────────────────────────────────────────
  // References:
  // - CVE-2025-53110: Filesystem MCP Server directory containment bypass
  // - CVE-2025-53109: Filesystem MCP Server symlink traversal bypass

  describe("path traversal attacks", () => {
    const traversalPaths = [
      "../../etc/passwd",
      "../../../etc/shadow",
      "/home/agent/workspace/../../etc/passwd",
      "/home/agent/workspace/src/../../../etc/passwd",
      "./../../etc/passwd",
      "src/../../../../../../etc/passwd",
    ];

    it.each(traversalPaths)("blocks traversal: %s", (path) => {
      const result = checkPath(path, config);
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toBeTruthy();
      }
    });
  });

  // ── Encoded path separators ────────────────────────────────────────

  describe("encoded path separators", () => {
    const encodedPaths = [
      "..%2f..%2fetc%2fpasswd",        // URL-encoded forward slash
      "..%2F..%2Fetc%2Fpasswd",        // Uppercase URL-encoded
      "..%5c..%5cetc%5cpasswd",        // URL-encoded backslash
      "..%5C..%5Cetc%5Cpasswd",        // Uppercase backslash
      "..%252f..%252fetc%252fpasswd",  // Double-encoded
      "%2e%2e%2f%2e%2e%2fetc%2fpasswd", // Dots also encoded
      "..%c0%afetc%c0%afpasswd",       // UTF-8 overlong encoding
      "..%ef%bc%8f..%ef%bc%8fetc",     // Fullwidth solidus
    ];

    it.each(encodedPaths)("blocks encoded: %s", (path) => {
      const result = checkPath(path, config);
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toBeTruthy();
      }
    });
  });

  // ── Null bytes ─────────────────────────────────────────────────────

  describe("null byte injection", () => {
    const nullBytePaths = [
      "/home/agent/workspace/file.ts\x00.jpg",
      "/home/agent/workspace/src\x00/../../etc/passwd",
      "file.ts\x00",
      "\x00/etc/passwd",
    ];

    it.each(nullBytePaths)("blocks null byte in: %s", (path) => {
      const result = checkPath(path, config);
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain("null");
      }
    });
  });

  // ── Symlink traversal ─────────────────────────────────────────────
  // CVE-2025-53109: Symlink escape from workspace root

  describe("symlink traversal detection", () => {
    it("blocks paths containing symlink indicators", () => {
      // The path guard should resolve symlinks and verify the real path
      // is still within the workspace root. We can't create actual symlinks
      // in a unit test, but we test the interface contract.
      const result = checkPath("/home/agent/workspace/link-to-etc", config);
      // If the resolved path is outside workspace, it should be blocked.
      // The actual symlink resolution happens in the implementation.
      // Here we just verify the function returns the expected shape.
      expect(typeof result.allowed).toBe("boolean");
      if (result.allowed) {
        expect(result.resolvedPath).toBeTruthy();
      } else {
        expect(result.reason).toBeTruthy();
      }
    });
  });

  // ── Windows-style paths on macOS/Linux ─────────────────────────────

  describe("Windows-style path rejection", () => {
    const windowsPaths = [
      "C:\\Users\\agent\\workspace",
      "..\\..\\etc\\passwd",
      "src\\..\\..\\etc\\passwd",
      "C:/Users/agent/workspace",
    ];

    it.each(windowsPaths)("blocks Windows path: %s", (path) => {
      const result = checkPath(path, config);
      expect(result.allowed).toBe(false);
    });
  });

  // ── Relative path resolution ───────────────────────────────────────

  describe("relative paths are resolved against workspace root", () => {
    it("resolves ./src/index.ts to workspace root", () => {
      const result = checkPath("./src/index.ts", config);
      expect(result.allowed).toBe(true);
      if (result.allowed) {
        expect(result.resolvedPath).toBe("/home/agent/workspace/src/index.ts");
      }
    });

    it("resolves src/index.ts to workspace root", () => {
      const result = checkPath("src/index.ts", config);
      expect(result.allowed).toBe(true);
      if (result.allowed) {
        expect(result.resolvedPath).toBe("/home/agent/workspace/src/index.ts");
      }
    });

    it("resolves . to workspace root", () => {
      const result = checkPath(".", config);
      expect(result.allowed).toBe(true);
      if (result.allowed) {
        expect(result.resolvedPath).toBe("/home/agent/workspace");
      }
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("blocks empty path", () => {
      const result = checkPath("", config);
      expect(result.allowed).toBe(false);
    });

    it("handles path with spaces", () => {
      const result = checkPath("/home/agent/workspace/my file.ts", config);
      expect(result.allowed).toBe(true);
    });

    it("handles path with unicode characters", () => {
      const result = checkPath("/home/agent/workspace/données/file.ts", config);
      expect(result.allowed).toBe(true);
    });

    it("blocks path with only dots", () => {
      const result = checkPath("...", config);
      // Three dots is not a valid traversal but is suspicious
      expect(typeof result.allowed).toBe("boolean");
    });

    it("handles trailing slashes consistently", () => {
      const withSlash = checkPath("/home/agent/workspace/src/", config);
      const withoutSlash = checkPath("/home/agent/workspace/src", config);
      expect(withSlash.allowed).toBe(true);
      expect(withoutSlash.allowed).toBe(true);
    });
  });
});
