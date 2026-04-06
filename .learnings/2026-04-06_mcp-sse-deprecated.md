---
date: 2026-04-06
category: architecture
source: session-retro
confidence: high
---

## What happened

While designing the MCP proxy transport layer, we initially referenced SSE (Server-Sent Events) as an HTTP transport option for remote MCP servers. SSE was deprecated in MCP spec version 2025-03-26 and replaced by Streamable HTTP.

## Root cause

Training data and early MCP documentation referenced SSE as a transport option. The deprecation happened in March 2025 and the ecosystem is still migrating (deadlines through mid-2026).

## Rule

Never implement or reference MCP SSE transport. The only two active MCP transports are stdio (local subprocesses) and Streamable HTTP (remote servers). The `@modelcontextprotocol/sdk` supports Streamable HTTP via `StreamableHTTPClientTransport` since v1.10.0.

## Evidence

- MCP spec 2025-03-26 deprecation
- https://blog.fka.dev/blog/2025-06-06-why-mcp-deprecated-sse-and-go-with-streamable-http/
- GitHub issue #26
