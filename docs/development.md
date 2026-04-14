# Development Guide

This guide covers how we ship changes to agentic-press. Follow it to get your first PR merged. If your setup is not yet working, start with [./setup.md](./setup.md). For sbx commands, see [./sbx-reference.md](./sbx-reference.md). For security-sensitive work, see [./security.md](./security.md).

## The Workflow in One Sentence

Open a GitHub issue, spin up a fresh sbx sandbox bound to a new worktree and branch, write failing tests, make them pass, open a PR, address review, let the maintainer merge, then clean up.

## 1. Open an Issue First

Every piece of work starts with a GitHub issue. No exceptions for features, fixes, refactors, or docs. The issue is where scope is agreed and where the PR will link back.

```bash
gh issue create --title "Short imperative title" --body "..."
```

Note the issue number. You will need it for the branch name and commit trailers.

## 2. Fresh Sandbox Per Issue (Dogfooding)

Never reuse an existing sandbox (like `dev`) for new work. Every issue gets its own sbx sandbox bound to its own git worktree on its own branch. This is how we test sbx in the course of building agentic-press, and how we keep parallel issues isolated so rebases stay clean.

See [./sbx-reference.md](./sbx-reference.md) for the exact `sbx create` and `sbx exec` commands. The short version: create the sandbox with `--branch <type>/<issue>-<desc>`, then run `npm install` inside the container.

Reason: host `node_modules` are built for darwin-arm64 and will not load in the linux-arm64 container. The worktree is bind-mounted, so files appear in both places, but the `node_modules` tree must be the Linux one.

## 3. Edit on the Host, Run in the Sandbox

- **Edits** (your editor, Claude Code on the host): on the host, in the worktree. Changes are visible inside the container instantly via the bind mount.
- **Execution** (`npm test`, `npm run build`, `npm run typecheck`, `./scripts/sandbox-run.sh`): always through `sbx exec`. Never run these on the host.

Why: node_modules architecture mismatch (above), and because running the MCP proxy and stdio bridge under real sandbox constraints is the point.

The npm scripts you will use most:

```bash
npm test          # vitest run
npm run typecheck # tsc --noEmit
npm run build     # tsc
npm run dev       # tsx src/index.ts (starts the MCP proxy)
```

## 4. TDD: Red, Green, Refactor

TDD is required for application logic, MCP proxy behavior, allowlist rules, sanitizer rules, and anything in `src/security/` or `src/mcp-proxy/`.

1. **Red.** Write a failing test in `tests/` named `*.test.ts`. Commit it. Real example: commit `e50576c test: security tests — injection patterns, sanitizer, allowlist, path guard (TDD Red)`.
2. **Green.** Write the minimum code to make the test pass. Commit.
3. **Refactor.** Clean up. Tests stay green. Commit.

Exempt from TDD: infra scripts under `scripts/`, one-off data migrations, throwaway spikes explicitly marked as such. When in doubt, write the test.

## 5. Branch Naming

Format: `<type>/<issue-number>-<short-description>`.

Types: `feat`, `fix`, `chore`, `refactor`, `docs`, `test`.

Examples (real branches from this repo's history):

```
feat/23-mcp-proxy-server
feat/25-stdio-bridge-diagnostics
fix/24-await-child-process-exit
docs/12-docs-split-merge
```

`sbx create --branch <name>` creates the worktree for you. If you branch by hand, branch from an up-to-date `main`.

## 6. Conventional Commits

Every commit message uses `<type>: <summary>`. Types match the branch prefixes. Keep commits atomic, one logical change each.

Recent examples from `git log` you can model:

```
feat: MCP proxy server, stdio bridge, and audit logger (#23)
feat: log-level-aware stdio bridge diagnostics with fail-fast (#25) (#29)
fix: await child process exit in bridge shutdown (#24) (#28)
docs: add mandatory code review step to dev workflow
test: security tests — injection patterns, sanitizer, allowlist, path guard (TDD Red) (#14)
chore: restructure project config — slim CLAUDE.md, add skills, agents, hooks (#17)
```

Reference the issue in the body when it is not already in the title: `Closes #23`.

Commits and `gh pr` commands run from the host session against the worktree. Sub-agents inside sandboxes cannot run `git commit` or `git push`.

## 7. Pull Requests

When tests are green and the branch is rebased on `main`:

```bash
gh pr create --title "<conventional commit style>" --body "<summary + test plan>"
```

The PR body must contain a **Summary** and a **Test plan**. The test plan is a checklist of what was verified (unit tests, integration script, manual sandbox run).

Do not merge your own PRs. The maintainer merges after review.

## 8. Code Review

Every PR is reviewed using the `pr-review-toolkit` before merge. Expect findings on security, tests, and conventions. Address every finding, push follow-up commits, and re-request review. Merge happens after approval.

## 9. Security Gating

Changes under `src/security/` or `src/mcp-proxy/` (including the sanitizer, allowlist, and stdio bridge) require **Plan Mode first**. Write the plan, get it reviewed, then implement under TDD. Run the full security test suite after any change to these paths.

Clean-room rule: injection patterns and security logic are derived from public sources only (OWASP Top 10 for LLM Apps, the MCP spec, published CVEs). Do not port code from Ren or Wake. See [./security.md](./security.md) for CVE references and the threat model.

## 10. Cleanup After Merge

After the PR is merged, tear down the sandbox and any stray branches:

```bash
sbx rm ap-<short-slug>
git worktree list                 # identify stale worktrees
git worktree remove <path>        # if any are left over
git branch -D pr-NN               # gh pr checkout leaves these behind
git fetch --prune                 # drop deleted remote branches locally
```

Do this before starting the next issue. Leftover worktrees and `pr-NN` branches cause confusing rebases later.

## Quick Checklist for Your First PR

1. `gh issue create` — open the issue.
2. `sbx create --name ap-<slug> --branch <type>/<issue>-<desc> shell .` — fresh sandbox and worktree. See [./sbx-reference.md](./sbx-reference.md).
3. `sbx exec ap-<slug> bash -c 'cd /workspace && npm install'`.
4. Write failing tests in `tests/`. Commit (Red).
5. Implement until `npm test` passes inside the sandbox. Commit (Green).
6. Refactor. Commit.
7. Rebase on `main` from the host.
8. `gh pr create` from the host with Summary and Test plan.
9. Address review. Push fixes.
10. Maintainer merges. Run cleanup.

If any step surprises you, the source of truth is `CLAUDE.md` in the repo root. This guide distills it; that file governs.
