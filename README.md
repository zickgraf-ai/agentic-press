# agentic-press

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
- Node.js >= 20 (sbx sandboxes ship Node 20.x)
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

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — MCP proxy architecture, request pipeline, security boundaries
- [`docs/setup.md`](docs/setup.md) — install, environment variables, first run
- [`docs/sbx-reference.md`](docs/sbx-reference.md) — sbx commands this project relies on
- [`docs/security.md`](docs/security.md) — threat model, injection patterns, CVE references
- [`docs/observability.md`](docs/observability.md) — Langfuse tracing, structured logging, planned metrics
- [`docs/development.md`](docs/development.md) — TDD loop, fresh-sandbox-per-issue dogfooding, PR workflow

## License

MIT
