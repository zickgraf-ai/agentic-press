# Architecture — agentic-press

Detailed architecture, platform strategy, and phase planning for the agent-sandbox platform.

## Platform Strategy

### macOS (Apple Silicon) + Windows 11 — Local Dev Mode
- Docker Sandbox (`sbx`) provides microVM isolation per agent worker
- `sbx` has its own template system for environment definitions (NOT devcontainer.json)
- Each sandbox gets its own Docker daemon, filesystem, and network
- sbx natively supports Claude Code, Codex, Gemini CLI, Copilot CLI, Kiro, OpenCode
- Our layer adds: MCP proxy with injection filtering, audit logging, orchestration glue

### AWS Linux — Headless Mode (Phase 2)
- ECS Fargate provides task-level isolation
- Fargate runs on Firecracker internally — AWS manages this, we don't nest our own Firecracker
- Plain Docker containers with Anthropic's reference devcontainer firewall (iptables default-deny)
- Isolation is namespace-level, NOT microVM — this is a known gap vs local dev mode
- If stronger isolation needed: EC2 .metal instances with self-managed Firecracker
- Queue-driven: SQS → Lambda dispatcher → ephemeral Fargate task → PR → destroy
- **sbx does NOT support Linux** — AWS mode uses a different container approach entirely

### Shared Base Image
- Same Dockerfile base layer across local and AWS (Ubuntu 24.04, Node.js, Python, Claude Code)
- Local dev: Dockerfile registered as an sbx template via `sbx save`
- AWS headless: Same Dockerfile used directly with Docker/Fargate
- NOT a universal config spec — platform-specific wrappers around a shared image

## MCP Proxy Architecture (Primary Value-Add)

```
Docker Sandbox (sbx)                 Host Machine
┌──────────────────────┐            ┌─────────────────────────────────────┐
│ AI Agent             │  JSON-RPC  │  MCP Proxy Server (:18923)          │
│ (Claude Code, etc.)  ├───────────►│  ┌─────────────────────────────┐   │
│                      │  over HTTP │  │ 1. Allowlist check           │   │
│ Connects via         │            │  │ 2. Path guard                │   │
│ host.docker.         │            │  │ 3. Forward to MCP server     │   │
│ internal:18923       │            │  │ 4. Sanitize response         │   │
│                      │◄───────────┤  │ 5. Audit log                 │   │
│                      │  filtered  │  └──────────────┬──────────────┘   │
└──────────────────────┘  response  │                 │ stdio            │
                                    │  ┌──────────────▼──────────────┐   │
                                    │  │ MCP Servers                  │   │
                                    │  │ - filesystem, git, github    │   │
                                    │  └─────────────────────────────┘   │
                                    └─────────────────────────────────────┘
```

- MCP servers run on the HOST (filesystem, git, github, custom servers)
- MCP proxy server runs on the HOST, exposes selected MCP tools over HTTP
- Sandboxed agents connect via `host.docker.internal` through sbx's gateway proxy
- Proxy layer: tool allowlisting → request/response sanitization → workspace path restriction → audit logging
- Agents CANNOT access MCP servers directly — all access is mediated

## Observability Architecture (Phase 1.5)

### Langfuse Cloud — LLM/Agent Tracing
- Hobby free tier: 50K units/month, 2 users, 30-day retention
- Trace per agent session, span per MCP tool call
- Tracks: token usage, tool call patterns, task completion rates, cost per task
- SDK: `@langfuse/langfuse` TypeScript

### Grafana Cloud — Infrastructure Monitoring
- Free tier: 3 users, 10K metrics, 50GB logs, 50GB traces
- Grafana Alloy (OTel collector) on host for Docker container metrics
- Prometheus metrics from proxy: request count, latency, injection flags, blocked requests
- Zero vendor lock-in — standard Prometheus/OTel

### Why Not Datadog
Free tier: 5 hosts, 1-day retention. Host-based pricing, custom metric charges, high-watermark billing. Wrong economic model for a personal project with no revenue.

## Dashboard Architecture (Phase 1.75)

### Mission Control (builderz-labs/mission-control)
- Open-source, self-hosted agent orchestration dashboard
- **Alpha software** — pin to release tag, keep adapter thin
- Kanban board, session tracking, token/cost dashboards, memory browser
- Integration: adapter layer, Direct CLI mode, Task Bridge, webhooks (HMAC-SHA256), comms API
- SQLite-based, zero external dependencies

### Fallback: agents-observe (simple10/agents-observe)
- Claude Code hooks → Docker container → React dashboard
- Real-time tool call visualization, subagent relationship trees
- Simpler but Docker-dependent

## OMC Integration (Phase 2)

- OMC (oh-my-claudecode) runs on the HOST, not inside sandboxes
- Uses tmux-based worker spawning — workers are tmux panes running CLI agents
- Integration approach TBD: likely a wrapper script that OMC calls, which invokes `sbx run`
- OMC does NOT have a documented plugin API for sandbox delegation — needs investigation
- Phase 1 works without OMC — single agent in single sandbox

## Phase Roadmap

| Phase | Goal | Tag |
|-------|------|-----|
| 1 | Minimal viable sandbox: single Claude Code agent + MCP proxy | v0.1.0 |
| 1.5 | Observability: Langfuse traces + Grafana metrics | v0.4.0 |
| 1.75 | Dashboard: Mission Control integration | v0.5.0 |
| 2 | OMC integration, AWS headless mode, multi-agent | TBD |

## Tech Stack

- **Language**: TypeScript (MCP proxy, glue scripts)
- **Sandbox Runtime**: Docker Sandbox (sbx)
- **MCP SDK**: `@modelcontextprotocol/sdk` + Express
- **LLM Observability**: Langfuse Cloud
- **Infra Observability**: Grafana Cloud (Alloy + Loki + Prometheus)
- **Dashboard**: Mission Control
- **Testing**: Vitest
- **AWS (Phase 2)**: CDK, Lambda, Fargate, SQS
