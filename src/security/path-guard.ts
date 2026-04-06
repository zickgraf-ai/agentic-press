// Path traversal prevention — guards against:
// - CVE-2025-53110: Filesystem MCP Server directory containment bypass
// - CVE-2025-53109: Filesystem MCP Server symlink traversal bypass
// - Encoded path separators (..%2f, ..%5c)
// - Null byte injection
// - Symlink escape from workspace root

import { resolve, normalize, isAbsolute } from "node:path";
import { realpathSync } from "node:fs";

export interface PathGuardConfig {
  readonly workspaceRoot: string;
}

export type PathCheckResult =
  | { readonly allowed: true; readonly resolvedPath: string }
  | { readonly allowed: false; readonly reason: string };

const NULL_BYTE = /\0/;
const BACKSLASH = /\\/;
const DRIVE_LETTER = /^[A-Za-z]:/;

// Target actual traversal sequences, not individual encoded chars (#8)
// Covers: single-encoded, double-encoded (%25xx), overlong UTF-8, fullwidth
const ENCODED_TRAVERSAL = /(%2e%2e|%252e|%252f|%255c|\.\.%2f|\.\.%5c|%2e%2e%2f|%2e%2e%5c|%c0%ae|%c0%af|%ef%bc%8f)/i;

function isWithinRoot(resolvedPath: string, normalizedRoot: string): boolean {
  return resolvedPath === normalizedRoot || resolvedPath.startsWith(normalizedRoot + "/");
}

function resolveRealPath(path: string): string {
  // Resolve symlinks with realpathSync (#1 — CVE-2025-53109)
  try {
    return realpathSync(path);
  } catch {
    // Path doesn't exist yet — resolve parent to catch symlink escapes
    const lastSlash = path.lastIndexOf("/");
    if (lastSlash > 0) {
      const parent = path.slice(0, lastSlash);
      const child = path.slice(lastSlash);
      try {
        return realpathSync(parent) + child;
      } catch {
        return normalize(path);
      }
    }
    return normalize(path);
  }
}

export function checkPath(
  path: string,
  config: PathGuardConfig
): PathCheckResult {
  if (!path) {
    return { allowed: false, reason: "Empty path" };
  }

  // Validate workspace root (#9)
  if (!config.workspaceRoot || !isAbsolute(config.workspaceRoot)) {
    return { allowed: false, reason: "Invalid workspace root configuration" };
  }

  if (NULL_BYTE.test(path)) {
    return { allowed: false, reason: "Path contains null byte" };
  }

  if (BACKSLASH.test(path)) {
    return { allowed: false, reason: "Path contains backslash (Windows-style path)" };
  }

  if (DRIVE_LETTER.test(path)) {
    return { allowed: false, reason: "Path contains drive letter (Windows-style path)" };
  }

  if (ENCODED_TRAVERSAL.test(path)) {
    return { allowed: false, reason: "Path contains encoded traversal sequence" };
  }

  const root = normalize(config.workspaceRoot);
  let resolved: string;

  if (path.startsWith("/")) {
    resolved = normalize(path);
  } else {
    resolved = resolve(root, path);
  }

  const normalizedRoot = root.endsWith("/") ? root.slice(0, -1) : root;
  let normalizedResolved = resolved.endsWith("/") && resolved !== "/"
    ? resolved.slice(0, -1)
    : resolved;

  // Check logical path first
  if (!isWithinRoot(normalizedResolved, normalizedRoot)) {
    return {
      allowed: false,
      reason: `Path resolves outside workspace root: ${normalizedResolved}`,
    };
  }

  // Resolve symlinks and re-check (#1)
  normalizedResolved = resolveRealPath(normalizedResolved);

  if (!isWithinRoot(normalizedResolved, normalizedRoot)) {
    return {
      allowed: false,
      reason: `Path escapes workspace root via symlink: ${normalizedResolved}`,
    };
  }

  return { allowed: true, resolvedPath: normalizedResolved };
}
