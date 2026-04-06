---
name: observability
description: Langfuse and Grafana Cloud integration patterns
---

## Implementation Status
- **Not yet implemented**: All observability modules are stubs (`src/observability/langfuse.ts`, `metrics.ts`, `config.ts` all throw "Not implemented")
- **No SDK dependencies yet**: @langfuse/langfuse and prom-client are not in package.json
- **Next**: Issue #9 (Langfuse), Issue #10 (Prometheus metrics)

## Langfuse Cloud — LLM/Agent Observability

- **Tier**: Hobby (free) — 50,000 units/month, 2 users, 30-day retention
- **SDK**: `@langfuse/langfuse` TypeScript SDK
- **Integration pattern**:
  - Start a Langfuse **trace** when a sandbox agent session begins (trace = one agent task)
  - Create a **span** for each MCP tool call flowing through the proxy
  - Span fields: tool name, latency ms, sanitized arguments, result status, injection flags raised
  - End trace when sandbox session completes
  - Flush on process shutdown
- **Opt-in**: Requires `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` env vars. Proxy works without them (no hard dependency).
- **Module**: `src/observability/langfuse.ts` — startTrace, spanToolCall, endTrace helpers
- **Upgrade path**: Core tier at $29/month if usage exceeds 50K units

## Grafana Cloud — Infrastructure Observability

- **Tier**: Free — 3 users, 10K metrics, 50GB logs, 50GB traces
- **Collector**: Grafana Alloy (OTel collector) on host machine
  - Docker integration for automatic container metrics (CPU, memory, network, disk per sandbox)
  - Log collection from MCP proxy stdout/stderr to Grafana Loki
- **Prometheus metrics** exposed from MCP proxy (`src/observability/metrics.ts`):
  - `mcp_proxy_requests_total` (counter, labels: tool_name, status)
  - `mcp_proxy_request_duration_seconds` (histogram, labels: tool_name)
  - `mcp_proxy_injection_flags_total` (counter, labels: pattern_name)
  - `mcp_proxy_blocked_requests_total` (counter, labels: reason — allowlist, path_traversal, injection)
- **Endpoint**: GET `/metrics` on port 9090 (configurable via `METRICS_PORT`)
- **Dashboards**: Import prebuilt Docker dashboard, create custom MCP proxy dashboard

## Why NOT Datadog

Free tier limited to 5 hosts with 1-day retention. Pricing model designed to ratchet up costs with host-based billing, custom metric charges, and high-watermark billing. Wrong economic model for a personal project with no revenue.
