#!/usr/bin/env node
/**
 * Address an improvement suggestion — issue #20.
 *
 * Reads `.improvements/<id>.md`, creates a feature branch, and opens a
 * draft PR seeded with the suggestion as the description so reviewers can
 * see exactly where the change originated.
 *
 * Intentionally does NOT make any code changes — it just sets up the
 * workspace for the human (or a follow-on Claude Code session) to do the
 * actual work. The draft state means it can't be merged accidentally.
 *
 * Usage:
 *   ./scripts/address-improvement.mjs <id>
 *
 * Example:
 *   ./scripts/address-improvement.mjs 2026-04-26-allowlist-drift-execute
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, join } from "node:path";

const id = process.argv[2];
if (!id) {
  console.error("usage: address-improvement <id>");
  console.error("       <id> is the filename stem of a .improvements/<id>.md file");
  process.exit(2);
}

const dir = resolve(".improvements");
const filePath = join(dir, `${id}.md`);
if (!existsSync(filePath)) {
  console.error(`error: ${filePath} does not exist`);
  process.exit(2);
}

const content = readFileSync(filePath, "utf8");

// Refuse to address an already-addressed or dismissed suggestion. The
// addressed status indicates a PR was already filed; reopening from the
// same suggestion is almost always a mistake.
const statusMatch = content.match(/^status:\s*(\S+)/m);
const status = statusMatch ? statusMatch[1] : "open";
if (status !== "open") {
  console.error(`error: suggestion ${id} has status=${status}, refusing to address again`);
  console.error(`       (change status: open in the frontmatter if you want to re-open it)`);
  process.exit(2);
}

const branchName = `improvement/${id}`;
console.log(`[address] creating branch ${branchName}`);
try {
  execSync(`git checkout -b ${branchName}`, { stdio: "inherit" });
} catch {
  console.error(`error: failed to create branch ${branchName}`);
  process.exit(1);
}

// Mark the suggestion as addressed so a re-sweep doesn't re-emit it
const updated = content.replace(/^status:\s*open$/m, "status: addressed");
writeFileSync(filePath, updated, "utf8");
console.log(`[address] marked ${id} as addressed in frontmatter`);

console.log(`[address] staging the suggestion file as the seed commit`);
execSync(`git add "${filePath}"`, { stdio: "inherit" });
execSync(
  `git commit -m "chore: address improvement ${id}\n\nFiled from .improvements/${id}.md"`,
  { stdio: "inherit" }
);

// Push and open a draft PR. Use the suggestion content as the PR body so
// reviewers see exactly where the change originated and why.
const titleMatch = content.match(/^# (.+)$/m);
const title = titleMatch ? titleMatch[1] : `Address improvement ${id}`;

const prBody =
  `## Origin\n\n` +
  `This pull request was opened to address an automated improvement suggestion ` +
  `surfaced by the \`sweep-improvements\` script (issue #20). The suggestion was ` +
  `reviewed by a human and dispatched via \`address-improvement\`.\n\n` +
  `## Original suggestion\n\n` +
  content +
  `\n---\n\n` +
  `*This PR is in draft state — no code changes yet. Add the implementation ` +
  `commits, then mark the PR ready for review.*\n`;

console.log(`[address] pushing branch and opening draft PR`);
execSync(`git push -u origin ${branchName}`, { stdio: "inherit" });

// gh pr create needs the body as a heredoc to preserve formatting
const tmpFile = `/tmp/pr-body-${id}.md`;
writeFileSync(tmpFile, prBody, "utf8");
try {
  execSync(
    `gh pr create --draft --title ${JSON.stringify(title)} --body-file ${tmpFile}`,
    { stdio: "inherit" }
  );
} finally {
  try {
    execSync(`rm -f ${tmpFile}`);
  } catch {
    // best-effort cleanup
  }
}

console.log(`[address] done — review the draft PR, add code, mark ready`);
