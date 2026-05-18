# Dispatch CLI (`apd`) — Manifest Contract

`apd` (the **a**gentic-**p**ress **d**ispatch CLI) takes a manifest describing one agent, spins up a fresh sbx sandbox, allow-lists the proxy port, writes a per-session `.mcp.json` into the workspace, and runs the agent inside the sandbox until it exits. This page documents the contract between manifest authors and what `apd` guarantees at runtime.

For the broader development workflow, see [./development.md](./development.md). For the security boundary, see [./security.md](./security.md).

## Manifest shape

A manifest is a JSON file with an `agents` array of exactly one entry (multi-agent dispatch is a planned extension). The required fields are:

| Field          | Type             | Notes |
|----------------|------------------|-------|
| `agentType`    | string           | Identifier sent to the control plane on `register`; bound to the per-session allowlist. |
| `allowedTools` | string[]         | Tool names this session may call through the MCP proxy. Anything else is denied. |
| `agentCommand` | string[]         | The command (argv-style) executed inside the sandbox. **Starts in the workspace cwd — see below.** |
| `workspace`    | absolute path    | Bind-mounted into the sandbox at the same path. Must exist on the host and be a directory. |

Optional fields: `sandboxName` (override the generated `ap-<type>-<id>` name), `extraSbxArgs` (forwarded to `sbx create shell`).

## Cwd contract (issue #75)

> **`agentCommand` starts with `cwd = <workspace>`.**

`sbx exec` itself has no `--cwd` flag and defaults the agent process to `/home/agent/workspace`, a *separate empty directory* unrelated to the bind-mounted host workspace. Most MCP clients (Claude Code, Codex, etc.) look for `.mcp.json` in the current working directory — without a cd into the workspace they silently fall back to default tool behaviour and never pick up the proxy config that `apd` writes.

To make this work transparently, `apd` wraps every `agentCommand` in:

```bash
bash -lc 'cd "$1" && shift && exec "$@"' -- <workspace> <agentCommand...>
```

The workspace rides as a positional argument (consumed via `cd "$1" && shift`) so paths with spaces or quotes don't need shell-escaping. `exec "$@"` replaces the wrapper shell with the agent process, so SIGTERM/SIGINT and the agent's exit code propagate unchanged.

**Practical consequence for manifest authors:** write `agentCommand` as if your shell is already in the workspace. Don't prefix it with `cd <workspace> && …`. Relative paths in `agentCommand` are resolved against the workspace.

### Example

```json
{
  "agents": [
    {
      "agentType": "reviewer",
      "allowedTools": ["echo__read_file"],
      "workspace": "/tmp/ap-review-ws",
      "agentCommand": ["bash", "-c", "ls -la .mcp.json && cat .mcp.json | head -20"]
    }
  ]
}
```

Inside the sandbox, the agent sees `pwd` = `/tmp/ap-review-ws` and `.mcp.json` is right there in the cwd.

## Environment scoping

`apd` filters the host environment before invoking `sbx exec` — only a positive allow-list (PATH, HOME, locale, proxy and TLS vars, npm/node tooling) reaches the sandbox. Notably, `MCP_CONTROL_TOKEN` and any `AP_TOKEN_*` are stripped to keep the control-plane trust boundary intact. See `src/dispatch/sbx-runner.ts` for the canonical list.

## Exit codes

| Code | Meaning |
|------|---------|
| 0    | Agent exited 0; sandbox torn down cleanly. |
| 64   | Manifest invalid or bad CLI invocation. |
| 65   | `MCP_CONTROL_TOKEN` not set. |
| 66   | Control-plane `register` failed. |
| 67   | `sbx create` / `sbx policy allow` / `sbx exec` failed. |
| 68   | Workspace path invalid (missing, not absolute, not a directory). |
| 69   | `.mcp.json` already exists in workspace (pass `--force` to overwrite). |
| 70   | Cleanup leak — sandbox or policy may still exist (`sbx ls`, `sbx policy ls`). |
| 71   | Internal error. |
| *N*  | Otherwise: the agent's own exit code, unmodified by the wrapper. |
