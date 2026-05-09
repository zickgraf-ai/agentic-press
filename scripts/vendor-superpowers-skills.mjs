#!/usr/bin/env node
// Vendor 5 skills from obra/superpowers into .claude/skills/, with cross-reference
// rewrites for the agentic-press environment. Idempotent — re-running with the
// same source produces the same output. Plain Node, no dev deps.
//
// Usage:
//   SUPERPOWERS_SOURCE=/tmp/superpowers-research node scripts/vendor-superpowers-skills.mjs

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, chmodSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";

const REPO_ROOT = process.cwd();
const SOURCE = process.env.SUPERPOWERS_SOURCE ?? "/tmp/superpowers-research";
const DEST = join(REPO_ROOT, ".claude/skills");
const SHA = "f2cbfbefebbfef77321e4c9abc9e949826bea9d7";
const VENDOR_DATE = "2026-05-09";

const PROVENANCE = `\n---\n\n## Provenance\n\nVendored from [obra/superpowers](https://github.com/obra/superpowers) commit \`${SHA}\` on ${VENDOR_DATE}. MIT License — see \`.claude/skills/SUPERPOWERS_LICENSE.md\`. Cross-references rewritten for the agentic-press environment.\n`;

const TDD_REWRITE =
  "the project's TDD requirement (see `CLAUDE.md` *Development Workflow*: \"TDD required\")";

// Generic rewrites applied to any rewritten markdown file.
const GENERIC_REWRITES = [
  // Cross-skill references. Order matters — more specific patterns first.
  [/\bsuperpowers:test-driven-development\b/g, TDD_REWRITE],
  [/\bsuperpowers:verification-before-completion\b/g, "verification-before-completion"],
  [/\bsuperpowers:systematic-debugging\b/g, "systematic-debugging"],
  [
    /\bsuperpowers:writing-plans\b/g,
    "the plan-saving convention (see `CLAUDE.md`): save the plan to `~/Obsidian/claude-workspace/Plans/<2-4-word-kebab>.md` and stop — the user reviews before any execution",
  ],
  [
    /\bsuperpowers:requesting-code-review\b/g,
    "the `pr-review-toolkit:review-pr` skill (already installed) plus the project's `security-reviewer` agent for security-touching changes",
  ],
  [
    /\bsuperpowers:finishing-a-development-branch\b/g,
    "the project's PR workflow per `CLAUDE.md` *Cleanup after merge*: `gh pr create --draft` → `pr-review-toolkit:review-pr` → mark ready → merge → `sbx rm <name>` + worktree prune",
  ],
  [
    /\bsuperpowers:using-git-worktrees\b/g,
    "the `sbx create --branch <type>/<issue>-<desc>` flow per `CLAUDE.md` (creates worktree automatically; one worktree per issue)",
  ],
  [/\bsuperpowers:executing-plans\b/g, "<dropped — single-execution mode for this project>"],
  // Drop any standalone elements-of-style references.
  [/^.*elements-of-style:writing-clearly-and-concisely.*$\n?/gm, ""],
];

// Per-file rewrites layered on top of GENERIC_REWRITES.
const PER_FILE_REWRITES = {
  "skills/systematic-debugging/SKILL.md": [
    // Original: "Use the `superpowers:test-driven-development` skill for writing proper failing tests"
    // Generic rewrite leaves broken nested backticks. Replace the whole line.
    [
      /Use the `the project's TDD requirement[^\n]*for writing proper failing tests/,
      "Use the project's TDD discipline (see `CLAUDE.md` *Development Workflow*) for writing proper failing tests",
    ],
  ],
  "skills/brainstorming/SKILL.md": [
    // Checklist item 9 — terminal state changes from "invoke writing-plans" to "save plan to Plans/".
    // Item 6 — spec path moves from docs/superpowers/specs to ~/Obsidian/.../Plans.
    [
      /6\. \*\*Write design doc\*\* — save to `docs\/superpowers\/specs\/YYYY-MM-DD-<topic>-design\.md` and commit/,
      "6. **Write design doc** — save to `~/Obsidian/claude-workspace/Plans/<2-4-word-kebab>.md` and commit",
    ],
    [
      /9\. \*\*Transition to implementation\*\* — invoke writing-plans skill to create implementation plan/,
      "9. **Save the plan** — write the design as `~/Obsidian/claude-workspace/Plans/<2-4-word-kebab>.md` and stop. The user reviews and triggers execution.",
    ],
    // Flowchart terminal node label.
    [
      /"Invoke writing-plans skill" \[shape=doublecircle\];/,
      '"Save plan to ~/Obsidian/claude-workspace/Plans/" [shape=doublecircle];',
    ],
    [
      /"User reviews spec\?" -> "Invoke writing-plans skill" \[label="approved"\];/,
      '"User reviews spec?" -> "Save plan to ~/Obsidian/claude-workspace/Plans/" [label="approved"];',
    ],
    // Terminal-state paragraph after flowchart.
    [
      /\*\*The terminal state is invoking writing-plans\.\*\* Do NOT invoke frontend-design, mcp-builder, or any other implementation skill\. The ONLY skill you invoke after brainstorming is writing-plans\./,
      "**The terminal state is saving the plan to `~/Obsidian/claude-workspace/Plans/<2-4-word-kebab>.md`.** Do NOT invoke any implementation skill or start coding from this skill. Save the plan, hand off to the user.",
    ],
    // "After the Design" → spec save path.
    [
      /Write the validated design \(spec\) to `docs\/superpowers\/specs\/YYYY-MM-DD-<topic>-design\.md`/,
      "Write the validated design (spec) to `~/Obsidian/claude-workspace/Plans/<2-4-word-kebab>.md`",
    ],
    [
      /  - \(User preferences for spec location override this default\)\n/,
      "",
    ],
    // "Implementation:" subsection.
    [
      /\*\*Implementation:\*\*\n\n- Invoke the writing-plans skill to create a detailed implementation plan\n- Do NOT invoke any other skill\. writing-plans is the next step\.\n/,
      "**Hand-off to user:**\n\n- The plan file in `~/Obsidian/claude-workspace/Plans/` is the deliverable\n- Stop here. The user reviews and triggers execution (typically via a separate Claude Code session)\n",
    ],
    // Delete entire Visual Companion section (heading through end of file or next ##).
    [/\n## Visual Companion\n[\s\S]*$/m, "\n"],
    // Remove the visual-companion checklist item (#2) and renumber the remaining items 3→2 .. 9→8.
    [
      /2\. \*\*Offer visual companion\*\*[^\n]*\n/,
      "",
    ],
    [/^3\. \*\*Ask clarifying questions\*\*/m, "2. **Ask clarifying questions**"],
    [/^4\. \*\*Propose 2-3 approaches\*\*/m, "3. **Propose 2-3 approaches**"],
    [/^5\. \*\*Present design\*\*/m, "4. **Present design**"],
    [/^6\. \*\*Write design doc\*\*/m, "5. **Write design doc**"],
    [/^7\. \*\*Spec self-review\*\*/m, "6. **Spec self-review**"],
    [/^8\. \*\*User reviews written spec\*\*/m, "7. **User reviews written spec**"],
    [/^9\. \*\*Save the plan\*\*/m, "8. **Save the plan**"],
    // Remove the visual-companion flowchart nodes/edges.
    [
      /    "Visual questions ahead\?" \[shape=diamond\];\n    "Offer Visual Companion\\n\(own message, no other content\)" \[shape=box\];\n/,
      "",
    ],
    [
      /    "Explore project context" -> "Visual questions ahead\?";\n    "Visual questions ahead\?" -> "Offer Visual Companion\\n\(own message, no other content\)" \[label="yes"\];\n    "Visual questions ahead\?" -> "Ask clarifying questions" \[label="no"\];\n    "Offer Visual Companion\\n\(own message, no other content\)" -> "Ask clarifying questions";\n/,
      '    "Explore project context" -> "Ask clarifying questions";\n',
    ],
  ],
  "skills/writing-skills/SKILL.md": [
    // Drop the @graphviz-conventions reference paragraph.
    [/See @graphviz-conventions\.dot for graphviz style rules\.\n\n/, ""],
    // Drop the render-graphs.js paragraph block.
    [
      /\*\*Visualizing for your human partner:\*\* Use `render-graphs\.js` in this directory to render a skill's flowcharts to SVG:\n```bash\n[\s\S]*?\n```\n\n/,
      "",
    ],
    // Original: "**REQUIRED BACKGROUND:** The superpowers:test-driven-development skill explains why this matters."
    // Generic rewrite produces "The the project's TDD requirement...skill explains" — awkward.
    [
      /\*\*REQUIRED BACKGROUND:\*\* The the project's TDD requirement \(see `CLAUDE\.md` \*Development Workflow\*: "TDD required"\) skill explains why this matters\./,
      "**REQUIRED BACKGROUND:** the project's TDD discipline (`CLAUDE.md` *Development Workflow*) explains why this matters.",
    ],
    // Cross-reference example block — the original used `superpowers:test-driven-development` and `superpowers:systematic-debugging`
    // as illustrative cross-ref names. Generic rewrite expanded TDD into a verbose phrase, breaking the illustrative point.
    // Restore short, illustrative project-scoped examples.
    [
      /- ✅ Good: `\*\*REQUIRED SUB-SKILL:\*\* Use the project's TDD requirement \(see `CLAUDE\.md` \*Development Workflow\*: "TDD required"\)`/,
      "- ✅ Good: `**REQUIRED SUB-SKILL:** Use verification-before-completion`",
    ],
    [
      /- ✅ Good: `\*\*REQUIRED BACKGROUND:\*\* You MUST understand systematic-debugging`/,
      "- ✅ Good: `**REQUIRED BACKGROUND:** You MUST understand systematic-debugging`",
    ],
  ],
  "skills/writing-skills/testing-skills-with-subagents.md": [],
  "skills/subagent-driven-development/SKILL.md": [
    // Replace the "When to Use" diamond flowchart + the vs.Executing Plans comparison entirely.
    // The parallel-session alternative does not exist in our project.
    [
      /## When to Use\n\n```dot[\s\S]*?```\n\n\*\*vs\. Executing Plans \(parallel session\):\*\*\n[\s\S]*?Faster iteration \(no human-in-loop between tasks\)\n\n/,
      "## When to Use\n\nUse this skill when you have an implementation plan with mostly independent tasks. Skip if tasks are tightly coupled (use manual execution and `brainstorming` first to refine the plan).\n\n",
    ],
    // Flowchart "Use superpowers:..." terminal node was rewritten by the generic rule into a long label.
    // Shorten so the digraph reads cleanly.
    [
      /"the project's PR workflow per `CLAUDE\.md` \*Cleanup after merge\*: `gh pr create --draft` → `pr-review-toolkit:review-pr` → mark ready → merge → `sbx rm <name>` \+ worktree prune"/g,
      '"Finish via project PR workflow (CLAUDE.md cleanup)"',
    ],
    // Drop the "vs. Executing Plans:" subsection within the Advantages block.
    [
      /\*\*vs\. Executing Plans:\*\*\n- Same session \(no handoff\)\n- Continuous progress \(no waiting\)\n- Review checkpoints automatic\n\n/,
      "",
    ],
    // Path references to plan files — Superpowers default → our Plans dir.
    [
      /docs\/superpowers\/plans\/feature-plan\.md/g,
      "~/Obsidian/claude-workspace/Plans/<plan>.md",
    ],
    // Required workflow skills bullet labels — make the rewritten generics read well.
    [
      /- \*\*the `sbx create --branch <type>\/<issue>-<desc>` flow per `CLAUDE\.md` \(creates worktree automatically; one worktree per issue\)\*\* - Ensures isolated workspace[^\n]*/,
      "- **sbx worktree-per-issue flow** — see `CLAUDE.md` *Development Workflow*. The `sbx create --branch <type>/<issue>-<desc>` command creates the isolated worktree automatically.",
    ],
    [
      /- \*\*the plan-saving convention[\s\S]*?\*\* - Creates the plan this skill executes/,
      "- **Plan source** — this skill executes a plan file from `~/Obsidian/claude-workspace/Plans/`",
    ],
    [
      /- \*\*the `pr-review-toolkit:review-pr` skill[\s\S]*?\*\* - Code review template for reviewer subagents/,
      "- **`pr-review-toolkit:review-pr`** — already installed; the spec/quality reviewer subagents in this skill complement it. The toolkit's `code-reviewer` agent runs as the *final* reviewer after all tasks complete.",
    ],
    [
      /- \*\*the project's PR workflow per `CLAUDE\.md`[\s\S]*?\*\* - Complete development after all tasks/,
      "- **PR workflow** — see `CLAUDE.md` *Development Workflow*: `gh pr create --draft` → `pr-review-toolkit:review-pr` → mark ready → merge → `sbx rm <name>` + worktree prune.",
    ],
    // The "Subagents should use:" subsection has the awkward-rewritten TDD bullet — clean it up.
    [
      /- \*\*the project's TDD requirement \(see `CLAUDE\.md` \*Development Workflow\*: "TDD required"\)\*\* - Subagents follow TDD for each task/,
      "- **TDD discipline** — `CLAUDE.md` *Development Workflow* mandates write-failing-test-first. Subagents follow TDD for each task.",
    ],
    // Drop the orphan "Alternative workflow:" subsection (its only bullet was the executing-plans skill we don't have).
    [
      /\n\*\*Alternative workflow:\*\*\n- \*\*<dropped — single-execution mode for this project>\*\* - Use for parallel session instead of same-session execution\n/,
      "\n",
    ],
  ],
};

// Files copied verbatim — no rewrites applied. Listed as [src, dest] relative to SOURCE/DEST.
const VERBATIM_FILES = [
  ["skills/systematic-debugging/root-cause-tracing.md", "systematic-debugging/root-cause-tracing.md"],
  ["skills/systematic-debugging/defense-in-depth.md", "systematic-debugging/defense-in-depth.md"],
  ["skills/systematic-debugging/condition-based-waiting.md", "systematic-debugging/condition-based-waiting.md"],
  ["skills/systematic-debugging/condition-based-waiting-example.ts", "systematic-debugging/condition-based-waiting-example.ts"],
  ["skills/brainstorming/spec-document-reviewer-prompt.md", "brainstorming/spec-document-reviewer-prompt.md"],
  ["skills/writing-skills/anthropic-best-practices.md", "writing-skills/anthropic-best-practices.md"],
  ["skills/writing-skills/persuasion-principles.md", "writing-skills/persuasion-principles.md"],
  ["skills/writing-skills/examples/CLAUDE_MD_TESTING.md", "writing-skills/examples/CLAUDE_MD_TESTING.md"],
  ["skills/subagent-driven-development/implementer-prompt.md", "subagent-driven-development/implementer-prompt.md"],
  ["skills/subagent-driven-development/spec-reviewer-prompt.md", "subagent-driven-development/spec-reviewer-prompt.md"],
  ["skills/subagent-driven-development/code-quality-reviewer-prompt.md", "subagent-driven-development/code-quality-reviewer-prompt.md"],
];

// Files copied with executable bit.
const EXECUTABLE_FILES = [
  ["skills/systematic-debugging/find-polluter.sh", "systematic-debugging/find-polluter.sh"],
];

// Files rewritten via PER_FILE_REWRITES (path under SOURCE → path under DEST).
const REWRITTEN_FILES = [
  ["skills/systematic-debugging/SKILL.md", "systematic-debugging/SKILL.md", true],
  ["skills/brainstorming/SKILL.md", "brainstorming/SKILL.md", true],
  ["skills/verification-before-completion/SKILL.md", "verification-before-completion/SKILL.md", true],
  ["skills/writing-skills/SKILL.md", "writing-skills/SKILL.md", true],
  ["skills/writing-skills/testing-skills-with-subagents.md", "writing-skills/testing-skills-with-subagents.md", false],
  ["skills/subagent-driven-development/SKILL.md", "subagent-driven-development/SKILL.md", true],
];

function rewrite(content, perFile) {
  let out = content;
  for (const [pattern, replacement] of GENERIC_REWRITES) {
    out = out.replace(pattern, replacement);
  }
  for (const [pattern, replacement] of perFile) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function ensureDir(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

function copyVerbatim(src, dst) {
  const srcAbs = join(SOURCE, src);
  const dstAbs = join(DEST, dst);
  ensureDir(dstAbs);
  copyFileSync(srcAbs, dstAbs);
  return dstAbs;
}

function copyExecutable(src, dst) {
  const dstAbs = copyVerbatim(src, dst);
  chmodSync(dstAbs, 0o755);
  return dstAbs;
}

function writeRewritten(src, dst, withProvenance) {
  const srcAbs = join(SOURCE, src);
  const dstAbs = join(DEST, dst);
  ensureDir(dstAbs);
  const content = readFileSync(srcAbs, "utf8");
  const perFile = PER_FILE_REWRITES[src] ?? [];
  let rewritten = rewrite(content, perFile);
  if (withProvenance) {
    rewritten = rewritten.replace(/\s+$/, "") + "\n" + PROVENANCE;
  }
  writeFileSync(dstAbs, rewritten, "utf8");
  return dstAbs;
}

function writeLicense() {
  const sourceLicense = readFileSync(join(SOURCE, "LICENSE"), "utf8");
  const dstAbs = join(DEST, "SUPERPOWERS_LICENSE.md");
  const content = `# Superpowers — Vendored Skills License\n\nThe following skills under \`.claude/skills/\` are vendored (with cross-reference rewrites) from [obra/superpowers](https://github.com/obra/superpowers) commit \`${SHA}\`, retrieved on ${VENDOR_DATE}:\n\n- \`systematic-debugging/\`\n- \`brainstorming/\`\n- \`verification-before-completion/\`\n- \`writing-skills/\`\n- \`subagent-driven-development/\`\n\nUpstream license (MIT) reproduced verbatim below.\n\n---\n\n${sourceLicense}\n`;
  ensureDir(dstAbs);
  writeFileSync(dstAbs, content, "utf8");
  return dstAbs;
}

function verify() {
  const errors = [];
  for (const [, dst, withProvenance] of REWRITTEN_FILES) {
    const dstAbs = join(DEST, dst);
    const content = readFileSync(dstAbs, "utf8");
    if (/\bsuperpowers:[a-z][a-z0-9-]*/.test(content)) {
      const matches = [...content.matchAll(/\bsuperpowers:[a-z][a-z0-9-]*/g)].map((m) => m[0]);
      errors.push(`${dst}: still contains superpowers: namespace strings: ${[...new Set(matches)].join(", ")}`);
    }
    if (withProvenance && !content.includes("## Provenance")) {
      errors.push(`${dst}: missing provenance footer`);
    }
  }
  return errors;
}

function main() {
  if (!existsSync(SOURCE)) {
    console.error(`SOURCE not found: ${SOURCE}`);
    process.exit(1);
  }
  console.log(`Vendoring from ${SOURCE} → ${DEST}`);
  writeLicense();
  for (const [src, dst] of VERBATIM_FILES) copyVerbatim(src, dst);
  for (const [src, dst] of EXECUTABLE_FILES) copyExecutable(src, dst);
  for (const [src, dst, withProvenance] of REWRITTEN_FILES) writeRewritten(src, dst, withProvenance);
  const errors = verify();
  if (errors.length > 0) {
    console.error("Verification failed:");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(2);
  }
  console.log(`OK: vendored ${VERBATIM_FILES.length + EXECUTABLE_FILES.length + REWRITTEN_FILES.length} files + LICENSE`);
}

main();
