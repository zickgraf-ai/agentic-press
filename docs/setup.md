# Setup

Get from a fresh clone to a running MCP proxy with a Claude Code session inside an sbx sandbox in under 15 minutes.

For what gets built and why, see [./architecture.md](./architecture.md). For day-to-day workflow (TDD, worktrees, sandbox-per-issue), see [./development.md](./development.md).

## 1. Prerequisites

- **Docker Desktop** with Sandbox support enabled. Verify: `docker --version` and `sbx version` both return without error. (Note: it's `sbx version`, not `sbx --version` — see [./sbx-reference.md](./sbx-reference.md).)
- **Node.js >= 20.** Verify: `node --version`.
- **Git** and **curl** on the host.

The `sbx` CLI ships with Docker Desktop. If `sbx` is missing, update Docker Desktop and enable the Sandbox feature in Settings.

## 2. Clone and install

```bash
git clone https://github.com/<org>/agentic-press.git
cd agentic-press
npm install
cp .env.example .env
```

`npm install` runs on the host for editor/typecheck support only. Execution (`npm test`, `npm run build`, `npm run dev`, `./scripts/sandbox-run.sh`) happens inside an sbx sandbox — see [./development.md](./development.md) for the dogfooding workflow.

## 3. Configure environment

Every variable from `.env.example`:

```dotenv
MCP_PROXY_PORT=18923
ALLOWED_TOOLS=filesystem.*,Read,Write,Grep,Glob
LOG_LEVEL=info
METRICS_PORT=9090
```

| Variable | Purpose | Default | When to change |
|---|---|---|---|
| `MCP_PROXY_PORT` | TCP port the proxy HTTP server listens on. Sandboxed agents reach it via `http://host.docker.internal:<port>/mcp`. | `18923` | Change only on port conflict. `scripts/sandbox-run.sh` honors it. |
| `ALLOWED_TOOLS` | Comma-separated allowlist. Supports glob suffixes (`filesystem.*`) and exact names (`Read`). Any tool not matched is rejected with an allowlist error. | `filesystem.*,Read,Write,Grep,Glob` | Extend per project. See [./security.md](./security.md). |
| `LOG_LEVEL` | Pino log verbosity: `debug` \| `info` \| `warn` \| `error`. Unknown values fall back to `info`. At `debug`, every non-JSON line emitted by child MCP servers is logged; at `info`+ the proxy emits a one-shot warning per misbehaving server. | `info` | Set to `debug` when diagnosing a stdio bridge issue. |
| `METRICS_PORT` | Prometheus scrape port (opt-in metrics). | `9090` | Change on port conflict. See [./observability.md](./observability.md). |

Commented-out variables in `.env.example`:

| Variable | Purpose |
|---|---|
| `MCP_SERVERS` | JSON array of backing MCP servers, e.g. `[{"name":"filesystem","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/workspace"]}]`. Required for real use; the integration script sets its own inline. |
| `SERVER_ROUTES` | **Required alongside `MCP_SERVERS`.** JSON object mapping tool-name globs to server names, e.g. `{"filesystem.*":"filesystem"}`. Without it the proxy boots but cannot route any tool call. Not yet present in `.env.example` — tracked in [#33](https://github.com/zickgraf-ai/agentic-press/issues/33). `scripts/sandbox-run.sh` sets it inline. |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_HOST` | Langfuse tracing. Proxy runs fine without them. See [./observability.md](./observability.md). |
| `MISSION_CONTROL_URL` / `MISSION_CONTROL_API_KEY` | Mission Control dashboard integration. See [./development.md](./development.md). |

Logs are structured JSON. Pipe through `pino-pretty` locally:

```bash
npm run dev | npx pino-pretty
```

## 4. Smoke-test the proxy (host-only)

Before touching sandboxes, confirm the proxy boots:

```bash
npm run build
npm test
```

`npm test` runs the full Vitest suite including allowlist, sanitizer, and stdio bridge tests. All green is required before proceeding.

## 5. First full run: proxy + sandbox + tool calls

The canonical end-to-end test is `scripts/sandbox-run.sh`. It is the fastest path to a verified working system.

```bash
./scripts/sandbox-run.sh
```

What it does, step by step:

1. **Pre-flight** — fails if `MCP_PROXY_PORT` (default `18923`) is already bound.
2. **Build** — compiles TypeScript to `dist/`.
3. **Start proxy** — launches `node dist/index.js` with an echo MCP server (`scripts/echo-mcp-server.js`) as the backend. Sets `ALLOWED_TOOLS=echo__*`, `MCP_SERVERS=[{...echo...}]`, `SERVER_ROUTES={"echo__*":"echo"}`, and redirects proxy output to a temp audit log. Waits up to 10 s for `GET /health` to return `"ok"`.
4. **Create sandbox** — `sbx create --name integration-test-<pid> shell <project-dir>`. Then opens a network policy with `sbx policy allow network "host.docker.internal:<port>,localhost:<port>"` so the sandbox can reach the proxy on the host.
5. **Exercise the stdio bridge** from inside the sandbox via `sbx exec ... curl -X POST http://host.docker.internal:<port>/mcp`:
   - Health check
   - Allowed tool call → echo server round-trip
   - Blocked tool (not in allowlist) → rejection
   - Prompt-injection string → rejection
   - Path-traversal (`../../etc/passwd`) → rejection
6. **Audit verification** — greps the proxy log for `"status":"allowed"`, `"blocked"`, and `"flagged"` entries.
7. **Cleanup** (trap on exit) — kills the proxy, runs `sbx stop` + `sbx rm`, removes the per-run network policies, deletes the audit log.

Expected output ends with `INTEGRATION TEST PASSED`. If it fails, the trap still cleans up; rerun with `LOG_LEVEL=debug ./scripts/sandbox-run.sh` for verbose stdio bridge diagnostics.

## 6. Running a Claude Code session inside a sandbox

Once the integration test passes, create a persistent sandbox for real work:

```bash
sbx create --name ap-dev --branch feat/<issue>-<desc> shell .
sbx exec ap-dev bash -c 'cd /workspace && npm install'
sbx policy allow network "host.docker.internal:18923,localhost:18923"
```

On the host, start the proxy with your real `MCP_SERVERS` config:

```bash
npm run dev
```

Inside the sandbox, point Claude Code (or any MCP client) at `http://host.docker.internal:18923/mcp`. The proxy enforces `ALLOWED_TOOLS` on every call. Note: Claude Code in sbx requires `/login` for Max-subscription auth; otherwise it bills per-token.

Tear down when done:

```bash
sbx rm ap-dev
```

## 7. Dispatching an agent with per-session allowlist (Tier 1.4)

When you want an agent to run against a **narrower** allowlist than the global `ALLOWED_TOOLS`, use the dispatch CLI. It mints a session ID, registers a per-session allowlist with the control plane, writes a workspace-local `.mcp.json` so the agent sends the right identity headers, runs the agent inside a fresh sandbox, and deregisters on exit.

Prerequisites:
- `MCP_CONTROL_TOKEN` set in `.envrc` (`openssl rand -hex 32`). The dispatch CLI reads it from its own host env — it is **never** written to the workspace or passed into the sandbox.
- Proxy running on the host (`npm run dev`).
- A workspace directory (typically a git worktree) that exists, is absolute, and that you're happy to be bind-mounted into the sandbox.

Write a manifest (`reviewer.json`):

```json
{
  "agents": [
    {
      "agentType": "reviewer",
      "allowedTools": ["echo__read_file", "echo__list_files"],
      "agentCommand": ["claude"],
      "workspace": "/Users/you/code/agentic-press-worktrees/feat-99-something",
      "sandboxName": "ap-reviewer-99"
    }
  ]
}
```

Run it:

```bash
npm run dispatch -- reviewer.json
# or, once installed via npm link / npm install -g:
apd reviewer.json
```

Available flags:

- `--workspace <abs-dir>` — override `agents[0].workspace` (must be absolute and exist)
- `--proxy-port <port>` — override the URL written into `.mcp.json` (defaults to `MCP_PROXY_PORT` or 18923)
- `--force` — overwrite an existing non-conforming `.mcp.json` in the workspace

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Agent exited 0, cleanup clean |
| (agent's) | Agent non-zero, cleanup clean |
| 64 | Manifest invalid (parse, schema, single-agent guardrail, or bad CLI flag) |
| 65 | `MCP_CONTROL_TOKEN` missing on host |
| 66 | Control-plane registration failed (401 / 400 / 5xx / network / timeout) |
| 67 | sbx command failed (create / exec / policy) |
| 68 | Workspace path invalid (`--workspace`, manifest `workspace`, or broken symlink / permission error during canonicalization) |
| 69 | Conflicting pre-existing `.mcp.json` without `--force` |
| 70 | Cleanup leak — registry DELETE OR sbx tearDown (stop / rm / policy rm) failed. Recover with `curl -X DELETE -H "Authorization: Bearer …" http://127.0.0.1:18924/sessions/<id>`, `sbx rm <name>`, and `sbx policy rm network --id <id>`. The registry is in-memory; restarting the proxy also clears any leaked session. |
| 71 | Internal error — dispatch CLI itself crashed (e.g. unhandled rejection). Distinguishable from "agent exited 1". |
| 130 | Cleanup ran after SIGINT / SIGTERM. (Second signal or 5s timeout forces this exit even if cleanup is still draining.) |

What gets written into the workspace: a single `.mcp.json` at the workspace root pointing the agent at `http://host.docker.internal:18923/mcp` with `X-Agent-Session-Id` and `X-Agent-Type` headers wired in. Mode 0644 (owner-readable/writable, group/other read-only); idempotent if re-run with the same identity.

The dispatch CLI accepts exactly one agent per manifest. Multi-agent dispatch is a planned extension.

## Network policy reference

sbx sandboxes deny all egress by default. The proxy is reachable only after:

```bash
sbx policy allow network "host.docker.internal:<MCP_PROXY_PORT>,localhost:<MCP_PROXY_PORT>"
```

Both hostnames are required: `host.docker.internal` resolves to the host from inside Docker, but some clients rewrite it to `localhost`. Use `sbx policy ls` to inspect active rules and `sbx policy rm network --id <id>` to revoke. Full policy catalog: [./sbx-reference.md](./sbx-reference.md).

## Troubleshooting

- **`Port 18923 is already in use`** — another proxy instance is running. `lsof -i :18923` then kill the PID, or set `MCP_PROXY_PORT` to a free port in `.env`.
- **Sandbox cannot reach proxy** — confirm the network policy with `sbx policy ls`. The proxy must be started on the host *before* the sandbox attempts its first call.
- **`darwin-arm64` native module errors inside sandbox** — you ran `npm install` on the host and the sandbox is reusing those `node_modules`. Always run `npm install` inside the sandbox (`sbx exec <name> bash -c 'cd /workspace && npm install'`).
- **Tool call rejected with "not in allowlist"** — expected behavior. Add the tool (or a matching glob) to `ALLOWED_TOOLS` and restart the proxy. See [./security.md](./security.md).

## Next steps

- [./architecture.md](./architecture.md) — proxy request pipeline, stdio bridge, allowlist
- [./security.md](./security.md) — injection patterns, path guard, CVE references
- [./observability.md](./observability.md) — Langfuse traces, Prometheus metrics
- [./development.md](./development.md) — TDD workflow, fresh-sandbox-per-issue dogfooding
- [./sbx-reference.md](./sbx-reference.md) — sbx commands used by this project
