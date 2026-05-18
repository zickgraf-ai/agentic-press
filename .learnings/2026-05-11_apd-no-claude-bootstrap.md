---
date: 2026-05-11
category: tooling
source: dogfood-session
confidence: high
---

## What happened

Tier 1.4 dogfood attempt: the original Stage B plan was to have `apd` dispatch a Claude Code agent at a real TapToSpeak issue. The probe inside a freshly-created `sbx shell` sandbox revealed:

- `which claude` → `NO_CLAUDE` (binary not installed in default sbx shell image)
- `~/.config/claude` does not exist (no OAuth state)
- `ANTHROPIC_API_KEY` IS set inside the sandbox (injected by sbx, not by apd — apd's env allowlist explicitly excludes it). Without `/login`, this maps to API Usage Billing, not the Max subscription.

`apd`'s create path is hard-coded to `sbx create --name <n> shell <workspace>`. There is no path for `sbx claude` (which would bring claude in pre-installed and could be `/login`'d ahead of time per `.learnings/2026-04-05_sbx-login-for-max-auth.md`). There is also no mount of host `~/.config/claude` to seed credentials.

## Root cause

Tier 1.4's scope was the dispatch + per-session header wiring, not agent-runtime bootstrapping. The CLI takes an agentCommand verbatim and runs it; if the binary is missing or unauthed, that's the caller's problem. But in practice this makes apd unusable for the headline use case ("dispatch a Claude Code agent at an issue") without either (a) baking claude into the workspace, (b) supporting `sbx claude` as the create-time agent type, or (c) shipping a host-side credential bridge.

## Rule

When designing a manifest for `apd`, do not assume `claude` (or any other agent CLI) is in the sandbox PATH. Either:

1. Pre-install in the agentCommand (`npm i -g @anthropic-ai/claude-code && claude ...`) — note this triggers per-token billing because OAuth state isn't present and ANTHROPIC_API_KEY is the proxy-managed token.
2. Wait for `apd` to support `sbx claude` create paths (follow-up issue filed).
3. Use a different agent that needs no auth (defeats the Claude-Code dogfood purpose).

For the per-session header / allowlist enforcement story, a bash-with-curl agent that reads `.mcp.json` proves the wiring without burning tokens (validated this session — see Stage B-lite in the session journal).

## Evidence

- Dogfood session 2026-05-11, claude-probe manifest output (`/tmp/ap-claude-probe-manifest.json` run):
  ```
  --- which claude ---
  NO_CLAUDE
  --- claude --version ---
  bash: line 1: claude: command not found
  --- ls ~/.config/claude ---
  ls: cannot access '/home/agent/.config/claude': No such file or directory
  --- env (filtered) ---
  ANTHROPIC_API_KEY=<REDACTED>
  ```
- `src/dispatch/sbx-runner.ts:214` hard-codes `shell` as the sbx agent type.
- `src/dispatch/sbx-runner.ts:10-53` `ALLOWED_ENV_KEYS` does not include `ANTHROPIC_API_KEY`, confirming the in-sandbox value is sbx-injected.
- Related: `.learnings/2026-04-05_sbx-login-for-max-auth.md`.
