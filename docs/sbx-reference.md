# sbx Reference

> **Version warning.** Every command and behaviour in this doc is verified against sbx **v0.23.0** on macOS Apple Silicon. Run `sbx version` before copy-pasting; if the output is newer, re-verify the command against `sbx <subcommand> --help` and update this doc as needed.

Project-local cheatsheet for the Docker Sandbox (sbx) CLI commands agentic-press relies on. Not a full sbx manual — only what is needed for the dogfooding workflow.

For project setup see [./setup.md](./setup.md). For the day-to-day contributor loop see [./development.md](./development.md). For how sbx fits the MCP proxy see [./architecture.md](./architecture.md).

## Tested version

```bash
sbx version
# Client Version:  v0.23.0
# Server Version:  v0.23.0
```

## Command surface used by this project

| Purpose | Command | Notes |
|---|---|---|
| Check version | `sbx version` | Not `--version`. |
| Create sandbox + worktree | `sbx create --name NAME --branch BRANCH shell PATH` | `--branch` provisions a git worktree automatically. Agent types: `shell`, `claude`, `codex`, `copilot`, `gemini`, etc. |
| Execute in sandbox | `sbx exec [-it] [-e K=V] NAME CMD...` | `-e` injects env vars. `-it` for interactive TTY. |
| Publish sandbox port to host | `sbx ports NAME --publish PORT` | Assigns an ephemeral host port. Only needed when host calls into the sandbox. |
| Network policy (global) | `sbx policy allow network "HOST:PORT"` | Policies are global, not per-sandbox. Capture the returned UUID for later removal. |
| Set default policy | `sbx policy set-default {allow-all\|balanced\|deny-all}` | Default is `balanced`. |
| Remove a policy | `sbx policy rm network --id UUID` | Or `--resource HOST:PORT`. |
| Snapshot sandbox as image | `sbx save NAME TAG` | The way to create reusable templates. |
| List sandboxes | `sbx ls` | Shows name, agent, status, ports, workspace path. |
| Stop | `sbx stop NAME` | |
| Remove | `sbx rm NAME` | Also cleans up the managed git worktree. |

### sbx CLI reality vs common assumptions

| Often assumed | Actual sbx v0.23.0 |
|---|---|
| `sbx --version` | `sbx version` |
| `sbx create --template NAME` | `sbx create -t IMAGE AGENT PATH` (no `template` subcommand) |
| `sbx shell NAME` | `sbx exec -it NAME bash` |
| Per-sandbox network policy | Policies are global; scope by hostname/port |
| Custom `Dockerfile` templates | Not supported — see Gotchas |

## Gotchas

Drawn from `.learnings/`:

- **Custom Dockerfile templates are not supported.** Do not expect `sbx create -t ./Dockerfile`. Start from a base agent (`claude`, `shell`, ...), configure the running sandbox, then `sbx save NAME my-template:v1` to produce a reusable image. Pass that image on the next create with `-t my-template:v1`.
- **Claude Code in sbx must run `/login` for Max-subscription auth.** Without it, the session falls through to per-token API billing against whatever key sbx proxies. Run `/login` once per new sandbox that uses the `claude` agent.
- **Workspace mount scope can surprise you.** The `claude` agent may mount a parent directory as `/home/agent/workspace` rather than the exact subdirectory you passed. Verify with `sbx exec NAME pwd && sbx exec NAME ls /home/agent/workspace` before assuming paths.
- **Host `node_modules` are unusable inside the sandbox** (darwin-arm64 vs linux-arm64). Always run `npm install` inside the sandbox after create.
- **`host.docker.internal` resolves to IPv6 `fe80::1`** inside sandboxes, and all traffic is routed through `gateway.docker.internal:3128`. Bind host listeners to `0.0.0.0` (or both stacks) if a sandbox needs to reach them.

## Recipes

### Fresh sandbox for a new issue

Matches the dogfooding flow in the project `CLAUDE.md`:

```bash
sbx create --name ap-<slug> --branch <type>/<issue>-<desc> shell .
sbx exec ap-<slug> bash -c 'cd /workspace && npm install'
```

Edit files on the host (the worktree is bind-mounted). Run tests, builds, and typechecks inside:

```bash
sbx exec ap-<slug> bash -c 'cd /workspace && npm test'
sbx exec ap-<slug> bash -c 'cd /workspace && npm run build'
sbx exec ap-<slug> bash -c 'cd /workspace && npm run typecheck'
```

### Exec into a sandbox interactively

```bash
sbx exec -it ap-<slug> bash
```

### Inject env vars for a single command

```bash
sbx exec -e MCP_PROXY_URL=http://host.docker.internal:18923 ap-<slug> env | grep MCP_PROXY
```

### Let the sandbox reach the host MCP proxy

The MCP proxy listens on the host (default port `18923`). The sandbox reaches it outbound via `host.docker.internal`, gated by the network policy:

```bash
sbx policy allow network "host.docker.internal:18923,localhost:18923"
# capture the returned UUIDs for cleanup
```

Remove later with `sbx policy rm network --id <uuid>`. See `scripts/sandbox-run.sh` for the full pattern, including policy-ID capture and teardown.

### Publish a port from sandbox to host

Only needed when the host calls into a service running inside the sandbox (rare for this project):

```bash
sbx ports ap-<slug> --publish 9090
sbx ls   # shows the host-side ephemeral port
```

### Snapshot a sandbox as a reusable image

Configure a running sandbox (install tooling, drop config files, run `/login`, etc.), then:

```bash
sbx save ap-<slug> agentic-press-dev:v1
sbx create --name ap-next -t agentic-press-dev:v1 --branch feat/<n>-<desc> shell .
```

This replaces the "custom Dockerfile template" pattern that sbx does not support.

### Cleanup after a merged PR

```bash
sbx rm ap-<slug>
git worktree list
git worktree remove <path>   # if sbx left one behind
git branch -D pr-NN          # if gh pr checkout left a stub
sbx policy ls                # prune any lingering per-sandbox policies
```

## Where this shows up in the repo

- `scripts/sandbox-run.sh` — end-to-end example: create sandbox, set policy, exec curl calls through the MCP proxy, remove policy and sandbox on exit.
- `CLAUDE.md` (Development Workflow) — canonical workflow that these commands support.

## When the version drifts

If `sbx version` on your host reports anything other than `v0.23.0`, treat this doc as advisory and re-verify the command surface table before relying on it. Flag changes in a PR that updates both this file and `.learnings/`.
