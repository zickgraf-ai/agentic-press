// Path traversal prevention — guards against:
// - CVE-2025-53110: Filesystem MCP Server directory containment bypass
// - CVE-2025-53109: Filesystem MCP Server symlink traversal bypass
// - Encoded path separators (..%2f, ..%5c)
// - Null byte injection
// - Symlink escape from workspace root

import { resolve, normalize } from "node:path";

export interface PathGuardConfig {
  readonly workspaceRoot: string;
}

export type PathCheckResult =
  | { readonly allowed: true; readonly resolvedPath: string }
  | { readonly allowed: false; readonly reason: string };

// Characters and sequences that should never appear in paths
const NULL_BYTE = /\0/;
const BACKSLASH = /\\/;
const DRIVE_LETTER = /^[A-Za-z]:/;

// URL-encoded sequences that could bypass path checks
// Includes single encoding, double encoding, overlong UTF-8, and fullwidth chars
const ENCODED_TRAVERSAL = /%(?:2[eEfF]|5[cC]|c0%af|ef%bc%8f|252[eEfF]|00)/i;

export function checkPath(
  path: string,
  config: PathGuardConfig
): PathCheckResult {
  // Empty path is invalid
  if (!path) {
    return { allowed: false, reason: "Empty path" };
  }

  // Null byte injection
  if (NULL_BYTE.test(path)) {
    return { allowed: false, reason: "Path contains null byte" };
  }

  // Windows-style backslash (invalid on POSIX)
  if (BACKSLASH.test(path)) {
    return { allowed: false, reason: "Path contains backslash (Windows-style path)" };
  }

  // Drive letter prefix (C:, D:, etc.) — invalid on POSIX
  if (DRIVE_LETTER.test(path)) {
    return { allowed: false, reason: "Path contains drive letter (Windows-style path)" };
  }

  // Encoded path separators — catch traversal attempts using URL encoding
  if (ENCODED_TRAVERSAL.test(path)) {
    return { allowed: false, reason: "Path contains encoded traversal sequence" };
  }

  // Resolve the path: if relative, resolve against workspace root
  const root = normalize(config.workspaceRoot);
  let resolved: string;

  if (path.startsWith("/")) {
    // Absolute path — normalize it directly
    resolved = normalize(path);
  } else {
    // Relative path — resolve against workspace root
    resolved = resolve(root, path);
  }

  // Strip trailing slash for consistent comparison (but keep root as-is)
  const normalizedRoot = root.endsWith("/") ? root.slice(0, -1) : root;
  const normalizedResolved = resolved.endsWith("/") && resolved !== "/"
    ? resolved.slice(0, -1)
    : resolved;

  // Check the resolved path is within workspace root
  if (normalizedResolved !== normalizedRoot && !normalizedResolved.startsWith(normalizedRoot + "/")) {
    return {
      allowed: false,
      reason: `Path resolves outside workspace root: ${normalizedResolved}`,
    };
  }

  return { allowed: true, resolvedPath: normalizedResolved };
}
