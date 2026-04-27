#!/usr/bin/env node
/**
 * Address an improvement suggestion — issue #20.
 *
 * Reads `.improvements/<id>.md`, creates a feature branch off main,
 * marks the suggestion as addressed, commits, pushes, and opens a draft
 * PR seeded with the suggestion as the description.
 *
 * Intentionally does NOT make any code changes — it sets up the workspace
 * for the human (or a follow-on Claude Code session) to do the actual work.
 * The draft state means it can't be merged accidentally.
 *
 * Usage:
 *   ./scripts/address-improvement.mjs <id>
 *
 * Example:
 *   ./scripts/address-improvement.mjs 2026-04-26-allowlist-drift-execute
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

const id = process.argv[2];
if (!id) {
  console.error("usage: address-improvement <id>");
  console.error("       <id> is the filename stem of a .improvements/<id>.md file");
  process.exit(2);
}

// SECURITY: validate id strictly before passing it to any subprocess.
// The id is interpolated into branch names and PR titles; even with
// execFileSync (which we use below to avoid the shell entirely), we want
// to reject obviously malicious input early with a clear error.
if (!/^[a-z0-9][a-z0-9.-]*$/i.test(id)) {
  console.error(`error: id "${id}" contains characters not allowed in suggestion ids`);
  console.error(`       (allowed: alphanumerics, dot, hyphen — must start with alphanumeric)`);
  process.exit(2);
}

const dir = resolve(".improvements");
const filePath = join(dir, `${id}.md`);
if (!existsSync(filePath)) {
  console.error(`error: ${filePath} does not exist`);
  process.exit(2);
}

const originalContent = readFileSync(filePath, "utf8");

// Refuse to address an already-addressed or dismissed suggestion.
const statusMatch = originalContent.match(/^status:\s*(\S+)/m);
const status = statusMatch ? statusMatch[1] : "open";
if (status !== "open") {
  console.error(`error: suggestion ${id} has status=${status}, refusing to address again`);
  console.error(`       (change status: open in the frontmatter if you want to re-open it)`);
  process.exit(2);
}

const branchName = `improvement/${id}`;

/** Run a command with execFileSync — no shell interpolation, args passed directly. */
function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

// CLAUDE.md rule: always create a feature branch from main, not HEAD.
console.log(`[address] fetching origin/main and creating branch ${branchName} from it`);
try {
  run("git", ["fetch", "origin", "main"]);
  run("git", ["checkout", "-b", branchName, "origin/main"]);
} catch {
  console.error(`error: failed to create branch ${branchName} from origin/main`);
  console.error(`       check that origin/main exists and you have a clean working tree`);
  process.exit(1);
}

// From here on, we have side effects to roll back on failure.
let stagedFile = false;
let committed = false;

function rollback(reason) {
  console.error(`\n[address] FAILED: ${reason}`);
  console.error(`[address] rolling back local changes...`);
  try {
    if (committed) {
      // Reset the local commit but keep the branch + working tree clean
      run("git", ["reset", "--hard", "origin/main"]);
    }
    // Restore the suggestion file's original frontmatter
    if (existsSync(filePath)) {
      writeFileSync(filePath, originalContent, "utf8");
    }
    // Switch back to main and delete the partial branch
    run("git", ["checkout", "main"]);
    run("git", ["branch", "-D", branchName]);
    console.error(`[address] rolled back. Re-run when the underlying issue is resolved.`);
  } catch (err) {
    console.error(`[address] WARNING: rollback partial — manual cleanup needed`);
    console.error(`         branch: ${branchName}`);
    console.error(`         file:   ${filePath}`);
    console.error(`         error:  ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(1);
}

try {
  // Mark the suggestion as addressed in the file BEFORE committing so the
  // commit captures the status change.
  const updated = originalContent.replace(/^status:\s*open$/m, "status: addressed");
  writeFileSync(filePath, updated, "utf8");
  console.log(`[address] marked ${id} as addressed in frontmatter`);

  console.log(`[address] staging the suggestion file as the seed commit`);
  run("git", ["add", filePath]);
  stagedFile = true;

  run("git", [
    "commit",
    "-m",
    `chore: address improvement ${id}\n\nFiled from .improvements/${id}.md`,
  ]);
  committed = true;
} catch (err) {
  rollback(`commit failed: ${err instanceof Error ? err.message : String(err)}`);
}

// Extract title from the markdown body for the PR title. Fallback if missing.
const titleMatch = originalContent.match(/^# (.+)$/m);
const title = titleMatch ? titleMatch[1] : `Address improvement ${id}`;

const prBody =
  `## Origin\n\n` +
  `This pull request was opened to address an automated improvement suggestion ` +
  `surfaced by the \`sweep-improvements\` script (issue #20). The suggestion was ` +
  `reviewed by a human and dispatched via \`address-improvement\`.\n\n` +
  `## Original suggestion\n\n` +
  originalContent +
  `\n---\n\n` +
  `*This PR is in draft state — no code changes yet. Add the implementation ` +
  `commits, then mark the PR ready for review.*\n`;

console.log(`[address] pushing branch and opening draft PR`);

// Write PR body to a temp file (gh's --body-file accepts arbitrary content
// including backticks, dollar-signs, and other shell metacharacters that
// would otherwise need escaping).
const tmpFile = join(tmpdir(), `pr-body-${id}-${Date.now()}.md`);
writeFileSync(tmpFile, prBody, "utf8");

let pushed = false;
try {
  run("git", ["push", "-u", "origin", branchName]);
  pushed = true;
} catch (err) {
  rollback(`push failed: ${err instanceof Error ? err.message : String(err)}`);
}

try {
  // execFileSync — title and body are passed as args, never interpolated
  // into a shell command. JSON.stringify is NOT a shell-escape function;
  // backticks and $(...) in a JSON-stringified title would still be
  // interpreted if it ever hit a shell. This call never does.
  run("gh", [
    "pr",
    "create",
    "--draft",
    "--title",
    title,
    "--body-file",
    tmpFile,
  ]);
} catch (err) {
  // If PR creation fails, the local commit + remote branch persist. We
  // can't reliably "un-push" without force-push to delete the remote, which
  // would be destructive. Instead, give the user the orphan branch info so
  // they can clean up or retry manually.
  console.error(`\n[address] FAILED: gh pr create — ${err instanceof Error ? err.message : String(err)}`);
  console.error(`[address] local commit and remote branch persist:`);
  console.error(`          branch: ${branchName} (pushed: ${pushed})`);
  console.error(`[address] to retry: gh pr create --draft --title "<title>" --body-file ${tmpFile}`);
  console.error(`[address] to discard: git push origin --delete ${branchName} && git checkout main && git branch -D ${branchName}`);
  process.exit(1);
} finally {
  try {
    unlinkSync(tmpFile);
  } catch {
    // best-effort cleanup
  }
}

console.log(`[address] done — review the draft PR, add code, mark ready`);
