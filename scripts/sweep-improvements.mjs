#!/usr/bin/env -S npx tsx
/**
 * Self-improvement sweep — issue #20.
 *
 * NOTE: shebang uses `npx tsx` because this script imports .ts modules
 * directly. Run via `npm run sweep-improvements` (recommended) or
 * `npx tsx scripts/sweep-improvements.mjs` (also works).
 *
 * Reads NDJSON audit log lines from a file (or stdin), analyzes them for
 * patterns that warrant human review, and writes new markdown files to
 * `.improvements/`. Idempotent — re-running on the same day with the same
 * audit log is a no-op.
 *
 * Usage:
 *   ./scripts/sweep-improvements.mjs [--input <audit.ndjson>] [--dir <improvements-dir>] [--max <N>]
 *   cat audit.ndjson | ./scripts/sweep-improvements.mjs
 *
 * Defaults:
 *   --input    stdin
 *   --dir      .improvements
 *   --max      3   (hard cap on suggestions written per run; bail-out so a
 *                   bad trigger can't flood the directory)
 *
 * Security: this script writes files to the repo. It does not commit, push,
 * or modify any other files. Output is reviewed by the human before any
 * effect propagates further.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Imported as .ts — requires tsx (see shebang and the npm script wrapper).
const { detectImprovements } = await import("../src/improvements/detector.ts");
const { writeSuggestion, isDuplicate, generateSuggestionId } = await import(
  "../src/improvements/writer.ts"
);

const args = process.argv.slice(2);
const opts = {
  input: argValue("--input"),
  dir: argValue("--dir") ?? ".improvements",
  max: parseInt(argValue("--max") ?? "3", 10),
};

function argValue(name) {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function readInput() {
  if (opts.input) return readFileSync(resolve(opts.input), "utf8");
  // stdin
  return readFileSync(0, "utf8");
}

function parseEntries(text) {
  const entries = [];
  let malformedCount = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // pino diagnostics may interleave with audit entries on the same
      // stdout stream — those are expected to fail JSON parse and we skip
      // them. We still count them so we can warn if EVERY line is bad
      // (likely a corrupt file or wrong input).
      malformedCount++;
    }
  }
  if (entries.length === 0 && malformedCount > 0) {
    console.warn(
      `[sweep] WARNING: input contained ${malformedCount} non-JSON lines and 0 parseable entries. ` +
        `Did you pipe in the audit stream, or a different file?`
    );
  } else if (malformedCount > entries.length) {
    console.warn(
      `[sweep] note: ${malformedCount} non-JSON lines skipped (vs ${entries.length} JSON entries) — ` +
        `usually pino diagnostics interleaved with audit; verify if unexpected`
    );
  }
  // Filter to actual audit entries (have status + tool fields)
  return entries.filter((e) => e && typeof e === "object" && "status" in e && "tool" in e);
}

const text = readInput();
const entries = parseEntries(text);
console.log(`[sweep] read ${entries.length} audit entries`);

const suggestions = detectImprovements(entries);
console.log(`[sweep] detected ${suggestions.length} candidate suggestions`);

const dir = resolve(opts.dir);
const now = new Date();
let written = 0;
let skipped = 0;

for (const s of suggestions) {
  if (written >= opts.max) {
    console.log(`[sweep] reached --max=${opts.max} cap, stopping`);
    break;
  }
  const id = generateSuggestionId(s, now);
  if (isDuplicate(dir, id)) {
    skipped++;
    continue;
  }
  writeSuggestion(dir, s, now);
  console.log(`[sweep] wrote ${id}.md  (${s.category}, ${s.confidence})`);
  written++;
}

console.log(`[sweep] done — wrote ${written}, skipped ${skipped} (duplicates)`);
