# Agent Sandbox Platform — CLAUDE.md

## Project Identity
- **Name**: agentic-press (working name)
- **Owner**: JZ (personal project, pre-employment IP — all commits must predate any employment agreement)
- **License**: MIT
- **Repo**: GitHub under JZ's personal account
- **Goal**: An open-source orchestration layer that adds mediated MCP access and injection prevention to Docker Sandbox (sbx) for secure multi-agent AI coding workflows.

## What This Project IS and IS NOT
- **IS**: A thin layer on top of Docker Sandbox (sbx) that adds MCP proxy with security filtering, audit logging, and orchestration glue for OMC
- **IS NOT**: A replacement for sbx, a custom container runtime, a reimplementation of sandbox lifecycle management, or a web UI

## Architecture Summary

### Platform Strategy
- **macOS (Apple Silicon) + Windows 11 — Local Dev Mode**:
  - Docker Sandbox (`sbx`) provides microVM isolation per agent worker
  - `sbx` has its own template system for environment definitions (NOT devcontainer.json)
  - Each sandbox gets its own Docker daemon, filesystem, and network
  - sbx natively supports Claude Code, Codex, Gemini CLI, Copilot CLI, Kiro, OpenCode
  - Our layer adds: MCP proxy with injection filtering, audit logging, OMC integration

- **AWS Linux — Headless Mode (Phase 2)**:
  - ECS Fargate provides task-level isolation (Fargate runs on Firecracker internally — AWS manages this, we don't nest our own Firecracker)
  - Plain Docker containers with Anthropic's reference devcontainer firewall (iptables default-deny)
  - Isolation is namespace-level, NOT microVM — this is a known gap vs local dev mode
  - If stronger isolation is needed later: EC2 .metal instances with self-managed Firecracker
  - Queue-driven: SQS → Lambda dispatcher → ephemeral Fargate task → PR → destroy
  - NOTE: sbx does NOT support Linux today. AWS mode uses different container approach.

### Shared Base Image
- Same Dockerfile base layer across local and AWS (Ubuntu 24.04, Node.js 22, Python 3.12, Claude Code)
- Local dev: Dockerfile registered as an sbx template via `sbx template`
- AWS headless: Same Dockerfile used directly with Docker/Fargate
- NOT a universal config spec — platform-specific wrappers around a shared image

### MCP Proxy Architecture (This is our primary value-add)
- MCP servers run on the HOST (filesystem, git, github, custom servers)
- MCP proxy server runs on the HOST, exposes selected MCP tools over HTTP
- Sandboxed agents connect to MCP proxy via host networking (host.docker.internal or Docker network)
- Proxy layer implements:
  - Tool allowlisting (configurable per-sandbox — only expose specific MCP tools)
  - Request/response sanitization with injection prevention patterns
  - Workspace path restriction (prevent path traversal outside mounted workspace)
  - Full audit logging (timestamp, tool name, sanitized arguments, result status)
- Agents CANNOT access MCP servers directly — all access is mediated through the proxy

### Observability (Phase 1.5 — after integration test passes)
- **LLM/Agent Observability — Langfuse Cloud (Free Hobby Tier)**:
  - 50,000 units/month, 2 users, 30-day retention — sufficient for personal project
  - Instrument MCP proxy to emit Langfuse traces per agent session
  - Each MCP tool call becomes a span: tool name, latency, sanitized args, result status
  - Tracks: token usage per session, MCP tool call patterns, task completion rates, cost per task
  - Uses Langfuse TypeScript SDK (@langfuse/langfuse) — lightweight integration
  - Upgrade path: Core tier at $29/month if usage exceeds 50K units

- **Infrastructure/Container Observability — Grafana Cloud (Free Tier)**:
  - 3 users, 10K metrics, 50GB logs, 50GB traces — sufficient for personal project
  - Uses open standards: Prometheus metrics, OpenTelemetry, Loki for logs
  - Grafana Alloy (OTel collector) on host collects Docker container metrics automatically
  - Prebuilt Docker integration dashboards for container metrics and logs out of the box
  - Tracks: sandbox startup time, container CPU/memory, MCP proxy request rate/latency, error rates, network policy violations
  - Zero vendor lock-in — same Prometheus/OTel instrumentation works with any future platform

- **Why NOT Datadog**: Free tier limited to 5 hosts with 1-day retention. Pricing model designed to ratchet up costs with host-based billing, custom metric charges, and high-watermark billing. Wrong economic model for a personal project with no revenue. JZ already has Datadog experience from Ren for resume purposes.

### Dashboard / Control Plane (Phase 1.75 — adopt, don't build)
- **Mission Control** (builderz-labs/mission-control): open-source, self-hosted agent orchestration dashboard
- **WARNING: Alpha software** — APIs, schemas, and config formats may change between releases. Pin to a release tag.
- Provides: Kanban task board, real-time session tracking, token/cost dashboards, memory browser, skill management
- Integration surface: adapter layer for agent frameworks, Direct CLI mode, Task Bridge scanning ~/.claude/tasks/, webhooks with HMAC-SHA256, comms API
- SQLite-based, zero external dependencies, single process
- We integrate via its adapter layer or Direct CLI path — we do NOT fork or modify it
- Fallback: agents-observe (simple10/agents-observe) if Mission Control integration exceeds 2-3 hours
- Integration is opt-in — agent-sandbox works without a dashboard running

### OMC Integration (Phase 2 — requires research)
- OMC (oh-my-claudecode) runs on the HOST, not inside sandboxes
- OMC uses tmux-based worker spawning — workers are tmux panes running CLI agents
- Integration approach TBD: likely a wrapper script that OMC calls, which invokes `sbx run` under the hood
- OMC does NOT have a documented plugin API for sandbox delegation — this needs investigation
- Phase 1 works without OMC — single agent in single sandbox

## Tech Stack
- **Language**: TypeScript (MCP proxy, glue scripts)
- **Sandbox Runtime**: Docker Sandbox (sbx) — we wrap it, not reimplement it
- **MCP Bridging**: supergateway (TypeScript) or mcp-proxy (Python) — evaluate both as starting points
- **LLM Observability**: Langfuse Cloud (Hobby free tier) — agent tracing, token tracking, tool call spans
- **Infra Observability**: Grafana Cloud (free tier) — container metrics, proxy logs, dashboards via Alloy + Loki
- **Dashboard**: Mission Control (builderz-labs/mission-control) — self-hosted, open-source agent orchestration UI
- **Testing**: Vitest for TypeScript
- **AWS (Phase 2)**: CDK (TypeScript), Lambda, Fargate, SQS

## Security Requirements (Non-Negotiable)
- Agents NEVER have unrestricted network access inside the sandbox
- sbx network policies enforced (Locked Down mode as default)
- MCP proxy MUST validate all tool calls against an allowlist before forwarding
- Injection prevention patterns written from scratch based on public MCP security research:
  - OWASP AI agent security guidelines
  - MCP specification security considerations
  - Published MCP-related CVEs:
    - CVE-2025-6514 (mcp-remote, CVSS 9.6 — arbitrary OS command execution via crafted authorization_endpoint URLs)
    - CVE-2025-53110 (Filesystem MCP Server — directory containment bypass)
    - CVE-2025-53109 (Filesystem MCP Server — symlink traversal bypass)
  - Publicly documented injection vectors: prompt injection via tool responses, role override phrases, zero-width unicode characters, base64-encoded instructions, path traversal in filesystem tool calls
  - DO NOT port patterns from Ren/Wake to Code — write clean-room implementations after employment attorney review
- All MCP proxy requests and responses logged for audit
- No host filesystem access from sandbox except sbx-managed workspace mount

## Development Workflow (Mandatory)
- **TDD is required** — always write failing tests first (Red), implement minimally (Green), then refactor. Claude should proactively create test frameworks and helpers to reduce developer burden.
- **GitHub issues first** — create a GitHub issue ticket before starting any new work.
- **Worktree isolation** — always use `git worktree` when working on feature/fix branches.
- **Branch naming** — `<type>/<issue-number>-<2-3-word-description>` where type is: `feat`, `fix`, `chore`, `refactor`, `docs`, `test`.
  - Examples: `feat/27-implement-hooks`, `chore/68-update-docs`, `fix/45-fix-network-issue`
- **Code review before merge** — every PR must be reviewed before merging. Never merge without review. Use the pr-review-toolkit agents to run a review, then address findings before requesting merge.
- **Workflow sequence**: (1) create GitHub issue → (2) create worktree branch with correct naming → (3) write failing tests → (4) implement → (5) refactor → (6) PR back to main → (7) review → (8) address findings → (9) merge after approval.

## Code Conventions
- All source in `src/` with clear module boundaries
- Tests alongside source files (`*.test.ts`)
- Prefer functions and composition over classes
- Error handling: fail loudly, structured error messages
- Config via environment variables with `.env.example`
- Conventional commits (feat:, fix:, docs:)
- Tag milestones: v0.1.0 (sbx + proxy works), v0.2.0 (injection filtering), v0.3.0 (audit logging), v0.4.0 (Langfuse + Grafana observability), v0.5.0 (Mission Control dashboard integrated)

## What NOT to Build
- Do NOT build sandbox lifecycle management — sbx does this
- Do NOT build a custom container runtime — sbx does this
- Do NOT build a custom web dashboard — adopt Mission Control instead
- Do NOT implement auth or multi-tenancy — single-user only
- Do NOT build OMC integration in Phase 1 — single agent first
- Do NOT build the AWS headless mode in Phase 1 — local only
- Do NOT port any code from Ren or Wake to Code — clean-room only