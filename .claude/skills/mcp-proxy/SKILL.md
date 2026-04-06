---
name: mcp-proxy
description: MCP proxy architecture, JSON-RPC bridging, and allowlist design
---

## Proxy Role

HTTP server running on the HOST machine, accepting JSON-RPC 2.0 MCP protocol requests from sandboxed agents over HTTP. Sandboxed agents connect via `host.docker.internal:18923` (configurable via `MCP_PROXY_PORT` env var).

## Request Pipeline

For each incoming MCP request:
1. **Allowlist check** — reject if tool name not in configured allowlist (return structured JSON-RPC error, not silence)
2. **Path guard** — reject if any file path arguments escape workspace root (traversal, encoded, symlinks)
3. **Forward** — send to appropriate local MCP server via stdio subprocess
4. **Sanitize response** — run response content through injection pattern detection, flag/strip/block
5. **Audit log** — log full call (timestamp, tool name, sanitized args, result status, any flags)
6. **Return** — send filtered response to caller

## Stdio Bridge

The proxy spawns local MCP servers as stdio subprocesses and bridges them to HTTP. Architecture decision: use `@modelcontextprotocol/sdk` (official TypeScript SDK) with Express.

- `supergateway` and `mcp-proxy` (Python) are CLI-only transport adapters with zero filtering capability — rejected
- The official SDK provides `McpServer` + `NodeStreamableHTTPServerTransport` + Express middleware
- Full programmatic control over request/response pipeline for injection filtering

## Allowlist Design

- Configurable per-sandbox via `ALLOWED_TOOLS` env var (comma-separated)
- Supports exact match (`Read`), wildcard prefix (`filesystem.*`), and catch-all (`*`)
- Case-sensitive matching
- Empty allowlist blocks everything (deny-by-default)
- Non-allowlisted tools return a structured JSON-RPC error with reason
- Malformed/null config blocks everything defensively

## Connection Architecture

```
Docker Sandbox (sbx)                    Host Machine
┌──────────────────┐   JSON-RPC/HTTP   ┌──────────────────────┐
│ AI Agent         ├──────────────────►│ MCP Proxy :18923     │
│ (Claude Code)    │                   │  ├─ allowlist         │
│                  │◄──────────────────┤  ├─ path guard        │
│ host.docker.     │   filtered resp   │  ├─ sanitizer         │
│ internal:18923   │                   │  └─ audit log         │
└──────────────────┘                   │         │ stdio       │
                                       │  ┌──────▼─────────┐  │
                                       │  │ MCP Servers     │  │
                                       │  │ filesystem, git │  │
                                       │  └────────────────┘  │
                                       └──────────────────────┘
```
