import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Suggestion } from "./types.js";

/**
 * Write a Suggestion as a markdown file with YAML frontmatter to the
 * improvements directory. Returns the suggestion id (also the filename stem).
 *
 * Idempotent: if a file with the same id already exists in the directory,
 * the function returns the id without rewriting. This protects user edits
 * to the file from being clobbered by a subsequent sweep.
 */
export function writeSuggestion(dir: string, suggestion: Suggestion, now: Date = new Date()): string {
  const id = generateSuggestionId(suggestion, now);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const filePath = join(dir, `${id}.md`);
  if (existsSync(filePath)) {
    return id;
  }
  writeFileSync(filePath, buildSuggestionFile(id, suggestion, now), "utf8");
  return id;
}

/**
 * Deterministic per-day per-evidence id. Two sweeps on the same day with
 * the same evidence key produce the same id, so re-running the sweep is
 * a no-op rather than a duplicate-write.
 */
export function generateSuggestionId(suggestion: Suggestion, now: Date = new Date()): string {
  const date = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const slug = slugify(getEvidenceSlug(suggestion));
  return `${date}-${suggestion.category}-${slug}`;
}

function getEvidenceSlug(suggestion: Suggestion): string {
  // Tool-keyed categories use the tool name as the discriminator.
  // Future non-tool categories will need their own discriminator logic.
  switch (suggestion.category) {
    case "allowlist-drift":
    case "tool-failure":
    case "bridge-timeout":
      return String(suggestion.evidence.tool ?? "unknown");
    default:
      return "unknown";
  }
}

function slugify(input: string): string {
  // Preserve information about double-underscores (common in MCP tool naming
  // like fs__write_file) by mapping them to "--" before single-underscore
  // collapse. This keeps the slug readable and avoids collisions between
  // "fs_write" (single tool) and "fs__write" (server__tool).
  return input
    .replace(/__/g, "--")
    .replace(/_/g, "-")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Render a Suggestion as the body of a markdown file with YAML frontmatter.
 * Format is intentionally minimal and human-editable — this is the surface
 * humans triage in (via Mission Control's Memory Browser, GitHub's directory
 * view, or `cat`).
 */
export function buildSuggestionFile(id: string, suggestion: Suggestion, now: Date = new Date()): string {
  const evidenceLines = formatEvidenceYaml(suggestion.evidence);
  return `---
id: ${id}
category: ${suggestion.category}
confidence: ${suggestion.confidence}
status: open
created: ${now.toISOString()}
---

# ${suggestion.title}

${suggestion.summary}

## Evidence

\`\`\`yaml
${evidenceLines}
\`\`\`

## How this was generated

This file was written by the \`sweep-improvements\` script (see \`scripts/sweep-improvements.mjs\`),
which analyzes the proxy's audit log NDJSON for patterns that warrant human attention. Nothing in
\`.improvements/\` is auto-loaded into agent context — review, edit, dismiss, or dispatch from
Mission Control or run \`address-improvement ${id}\` to start a draft PR.

## Triage

- **To dismiss**: change \`status: open\` to \`status: dismissed\` in the frontmatter, or delete this file.
- **To address**: run \`npm run address-improvement -- ${id}\` (or click "Address" in Mission Control's Memory Browser).
  This creates a feature branch and a draft PR seeded with this suggestion as the description.
`;
}

function formatEvidenceYaml(evidence: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(evidence)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) {
        lines.push(`  - ${yamlScalar(item)}`);
      }
    } else {
      lines.push(`${key}: ${yamlScalar(value)}`);
    }
  }
  return lines.join("\n");
}

function yamlScalar(v: unknown): string {
  if (typeof v === "string") {
    // Quote if contains special chars that would break inline YAML
    if (/[:#\[\]{}&*!|>'"%@`]/.test(v) || v.includes("\n")) {
      return JSON.stringify(v);
    }
    return v;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null || v === undefined) return "null";
  return JSON.stringify(v);
}

/**
 * Detect whether a suggestion id already corresponds to an existing
 * non-dismissed file in the directory. Dismissed files do not block
 * re-detection — if the same pattern returns, surface it again so the
 * human can decide whether the dismissal was wrong.
 */
export function isDuplicate(dir: string, id: string): boolean {
  if (!existsSync(dir)) return false;
  const filename = `${id}.md`;
  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  if (!files.includes(filename)) return false;
  const content = readFileSync(join(dir, filename), "utf8");
  const status = parseStatusFromFrontmatter(content);
  // Re-surface dismissed suggestions; addressed and open count as duplicates.
  return status !== "dismissed";
}

function parseStatusFromFrontmatter(content: string): string | null {
  const match = content.match(/^status:\s*(\S+)/m);
  return match ? match[1]! : null;
}
