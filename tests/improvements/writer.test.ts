import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSuggestionFile,
  isDuplicate,
  writeSuggestion,
  generateSuggestionId,
} from "../../src/improvements/writer.js";
import type { Suggestion } from "../../src/improvements/types.js";

function makeSuggestion(overrides: Partial<Suggestion> = {}): Suggestion {
  return {
    category: "allowlist-drift",
    confidence: "high",
    title: "Tool 'Execute' blocked 5 times across recent sessions",
    summary: "Consider adding to ALLOWED_TOOLS or removing it from agent prompts.",
    evidence: { tool: "Execute", count: 5, firstSeen: "2026-04-20T00:00:00.000Z", lastSeen: "2026-04-26T00:00:00.000Z" },
    ...overrides,
  };
}

describe("generateSuggestionId", () => {
  it("includes the date and category", () => {
    const id = generateSuggestionId(makeSuggestion(), new Date("2026-04-26T18:00:00Z"));
    expect(id).toMatch(/^2026-04-26-allowlist-drift-/);
  });

  it("derives a stable slug from category-specific evidence (allowlist-drift uses tool name)", () => {
    const a = generateSuggestionId(
      makeSuggestion({ category: "allowlist-drift", evidence: { tool: "Execute", count: 5 } }),
      new Date("2026-04-26T18:00:00Z")
    );
    const b = generateSuggestionId(
      makeSuggestion({ category: "allowlist-drift", evidence: { tool: "Execute", count: 7 } }),
      new Date("2026-04-26T18:00:00Z")
    );
    // Same tool same day — same id (so two sweeps on same day don't dupe)
    expect(a).toBe(b);
  });

  it("different tools produce different ids", () => {
    const a = generateSuggestionId(
      makeSuggestion({ category: "allowlist-drift", evidence: { tool: "Execute" } }),
      new Date("2026-04-26T18:00:00Z")
    );
    const b = generateSuggestionId(
      makeSuggestion({ category: "allowlist-drift", evidence: { tool: "Delete" } }),
      new Date("2026-04-26T18:00:00Z")
    );
    expect(a).not.toBe(b);
  });

  it("kebab-cases tool names with double-underscores", () => {
    const id = generateSuggestionId(
      makeSuggestion({ category: "tool-failure", evidence: { tool: "fs__write_file" } }),
      new Date("2026-04-26T18:00:00Z")
    );
    expect(id).toContain("fs--write-file");
  });
});

describe("buildSuggestionFile", () => {
  it("produces YAML frontmatter with all required fields", () => {
    const s = makeSuggestion();
    const id = "2026-04-26-allowlist-drift-execute";
    const out = buildSuggestionFile(id, s, new Date("2026-04-26T18:00:00Z"));
    expect(out).toContain("---");
    expect(out).toMatch(/^id: 2026-04-26-allowlist-drift-execute$/m);
    expect(out).toMatch(/^category: allowlist-drift$/m);
    expect(out).toMatch(/^confidence: high$/m);
    expect(out).toMatch(/^status: open$/m);
    expect(out).toMatch(/^created: 2026-04-26T18:00:00\.000Z$/m);
  });

  it("includes the title as an H1 markdown heading", () => {
    const s = makeSuggestion({ title: "Some title here" });
    const out = buildSuggestionFile("id", s, new Date());
    expect(out).toMatch(/^# Some title here$/m);
  });

  it("includes the summary text in the body", () => {
    const s = makeSuggestion({ summary: "This is the rationale." });
    const out = buildSuggestionFile("id", s, new Date());
    expect(out).toContain("This is the rationale.");
  });

  it("renders evidence as a code block of YAML", () => {
    const s = makeSuggestion();
    const out = buildSuggestionFile("id", s, new Date());
    expect(out).toContain("```yaml");
    expect(out).toContain("count: 5");
  });

  it("includes a 'How this was generated' provenance section", () => {
    const out = buildSuggestionFile("id", makeSuggestion(), new Date());
    expect(out.toLowerCase()).toContain("how this was generated");
    expect(out).toContain("sweep-improvements");
  });
});

describe("isDuplicate", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "improvements-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns false when directory is empty", () => {
    expect(isDuplicate(dir, "2026-04-26-allowlist-drift-execute")).toBe(false);
  });

  it("returns true when an open file with the same id exists", () => {
    writeFileSync(
      join(dir, "2026-04-26-allowlist-drift-execute.md"),
      "---\nid: 2026-04-26-allowlist-drift-execute\nstatus: open\n---\n"
    );
    expect(isDuplicate(dir, "2026-04-26-allowlist-drift-execute")).toBe(true);
  });

  it("returns false if a same-id file exists but is dismissed (dismissed entries should not block re-detection)", () => {
    writeFileSync(
      join(dir, "2026-04-26-allowlist-drift-execute.md"),
      "---\nid: 2026-04-26-allowlist-drift-execute\nstatus: dismissed\n---\n"
    );
    expect(isDuplicate(dir, "2026-04-26-allowlist-drift-execute")).toBe(false);
  });

  it("returns true if a same-id file exists with status: addressed", () => {
    writeFileSync(
      join(dir, "2026-04-26-allowlist-drift-execute.md"),
      "---\nid: 2026-04-26-allowlist-drift-execute\nstatus: addressed\n---\n"
    );
    expect(isDuplicate(dir, "2026-04-26-allowlist-drift-execute")).toBe(true);
  });

  it("ignores non-markdown files in the directory", () => {
    writeFileSync(join(dir, "README.md.bak"), "junk");
    writeFileSync(join(dir, ".DS_Store"), "junk");
    expect(isDuplicate(dir, "any-id")).toBe(false);
  });
});

describe("writeSuggestion", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "improvements-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a markdown file named <id>.md in the directory", () => {
    const id = writeSuggestion(dir, makeSuggestion(), new Date("2026-04-26T18:00:00Z"));
    expect(id).toMatch(/^2026-04-26-allowlist-drift-/);
    const files = readdirSync(dir);
    expect(files).toContain(`${id}.md`);
  });

  it("file content includes the YAML frontmatter and rendered body", () => {
    const id = writeSuggestion(dir, makeSuggestion(), new Date("2026-04-26T18:00:00Z"));
    const content = readFileSync(join(dir, `${id}.md`), "utf8");
    expect(content).toMatch(/^---/);
    expect(content).toContain(`id: ${id}`);
    expect(content).toContain("category: allowlist-drift");
  });

  it("creates the directory if it does not exist", () => {
    const newDir = join(dir, "nested", "improvements");
    const id = writeSuggestion(newDir, makeSuggestion(), new Date("2026-04-26T18:00:00Z"));
    expect(readdirSync(newDir)).toContain(`${id}.md`);
  });

  it("does not overwrite an existing file with the same id (returns the id without re-writing)", () => {
    const id = writeSuggestion(dir, makeSuggestion(), new Date("2026-04-26T18:00:00Z"));
    const originalContent = readFileSync(join(dir, `${id}.md`), "utf8");
    // Add a marker so we can detect a rewrite
    writeFileSync(join(dir, `${id}.md`), originalContent + "\n<!-- user-edit -->");

    // Second call with same suggestion + same date — should not clobber
    writeSuggestion(dir, makeSuggestion(), new Date("2026-04-26T18:00:00Z"));
    const after = readFileSync(join(dir, `${id}.md`), "utf8");
    expect(after).toContain("<!-- user-edit -->");
  });
});
