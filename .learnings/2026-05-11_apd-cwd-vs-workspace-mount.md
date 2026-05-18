---
date: 2026-05-11
category: architecture
source: dogfood-session
confidence: high
---

## What happened

During Tier 1.4 (`apd`) dogfooding, the dispatch CLI wrote `.mcp.json` into the workspace path on the host (e.g., `/tmp/ap-stage-b-ws/.mcp.json`). `sbx shell` correctly bind-mounted that directory at the same path inside the sandbox. However, the `sbx exec` agent process started with `cwd = /home/agent/workspace` — a different, empty directory — not the workspace mount.

The first attempt at a per-session enforcement test had the agent run `cat .mcp.json` from its default cwd; the file was nowhere, even though the host workspace contained it. Adding `cd /tmp/ap-stage-b-ws` to the agentCommand fixed it.

This matters for real MCP-client agents (Claude Code, Codex, etc.): most look for `.mcp.json` in the **current working directory**, not the mounted workspace path. If `apd` dispatches them without first changing into the workspace, they will silently fail to load the proxy config and may fall through to default tool behavior (or refuse to start).

## Root cause

`sbx exec <name> <cmd>` does not auto-cd into the workspace mount. The exec process inherits the sandbox image's default working directory (`/home/agent/workspace`, which is a separate empty home subdirectory unrelated to the host bind-mount). The workspace is bind-mounted at the host path (matching `sbx`'s "same path as host" semantic).

`apd`'s `execAgent` (`src/dispatch/sbx-runner.ts`) does not currently add a `cd <workspace>` wrapper or pass `--cwd` (sbx exec has no such flag as of this session).

## Rule

When `apd` dispatches an agent that expects to find `.mcp.json` (or any workspace-relative file) in its cwd, either:

1. Wrap the agentCommand to `cd <workspace>` first (operator's responsibility today), or
2. Update `apd` to inject the cwd change automatically before the agent runs (preferred — tracked as a follow-up).

Until #2 lands, every manifest that points at a real MCP client must begin with `["bash", "-lc", "cd <workspace> && <real-cmd>"]` or equivalent. Document this in `docs/dispatch.md` when the help/README for `apd` is written.

## Evidence

- Dogfood session 2026-05-11, fs-probe agent output:
  - `pwd` → `/home/agent/workspace`
  - `ls /home/agent/workspace` → empty (only `.` and `..`)
  - `ls /tmp/ap-stage-b-ws` (the host workspace path) → contains `.mcp.json`
- `sbx create shell --help`: "The workspace path is required and will be mounted inside the sandbox at the same path as on the host."
- Distinct from `2026-04-05_sbx-workspace-mount-scope.md` (which covers mount-point scope for the `claude` agent walking up to a git root).
