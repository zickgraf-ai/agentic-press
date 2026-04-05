# agent-sandbox

A thin orchestration layer on top of [Docker Sandbox (sbx)](https://docs.docker.com/sandbox/) that adds mediated MCP access with injection prevention for secure AI coding agent execution.

## What This Does

- **MCP Proxy**: HTTP server that mediates MCP tool access between sandboxed agents and host MCP servers
- **Injection Prevention**: Clean-room detection patterns for prompt injection, path traversal, and other MCP attack vectors
- **Tool Allowlisting**: Configurable per-sandbox allowlist of permitted MCP tools
- **Audit Logging**: Every MCP tool call logged with timestamp, tool, args, and status
- **Observability** (opt-in): Langfuse traces for agent sessions, Prometheus metrics for proxy operations
- **Dashboard** (opt-in): Mission Control integration for visual agent orchestration

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) with Sandbox support
- Node.js >= 22
- `sbx` CLI (included with Docker Desktop)

## Quick Start

```bash
npm install
cp .env.example .env
# Edit .env with your configuration
npm run dev
```

## Development

```bash
npm test           # Run tests
npm run test:watch # Watch mode
npm run build      # Compile TypeScript
npm run typecheck  # Type check without emitting
npm run lint       # Lint
```

## Architecture

```
Host Machine                          Docker Sandbox (sbx)
┌─────────────────────┐              ┌──────────────────────┐
│  MCP Servers (stdio) │◄────────────│  AI Agent            │
│  - filesystem        │  MCP Proxy  │  (Claude Code, etc.) │
│  - git               │  (HTTP)     │                      │
│  - github            │             │  Connects to proxy   │
│  - custom            │  Filters:   │  via host.docker.    │
│                      │  - Allowlist│  internal:18923      │
│  MCP Proxy Server ◄──┤  - Sanitize │                      │
│  :18923              │  - PathGuard│                      │
│                      │  - AuditLog │                      │
└─────────────────────┘              └──────────────────────┘
```

## License

MIT
