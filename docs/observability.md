# Observability

This document covers logging, tracing, and metrics for the MCP proxy. All three
surfaces are opt-in via environment variables. The proxy and stdio bridge run
without any of them configured.

See also: [`./architecture.md`](./architecture.md), [`./security.md`](./security.md),
[`./setup.md`](./setup.md).

## Surfaces at a glance

| Surface  | Transport             | Status                 | Enabled by                                      |
|----------|-----------------------|------------------------|-------------------------------------------------|
| Logging  | pino JSON on stdout   | Implemented            | Always on; level via `LOG_LEVEL`                |
| Audit    | NDJSON on stdout      | Implemented            | Always on (one line per tool call)              |
| Tracing  | Langfuse SDK (HTTPS)  | Implemented            | `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY`   |
| Metrics  | Prometheus `/metrics` | Planned (#10)          | `METRICS_PORT` (handler stubs throw today)      |
| Dashboards | Grafana / Loki      | Planned (#10)          | No Alloy config shipped yet                     |

## Logging

The proxy uses pino for structured JSON logging. The module singleton is
created in `src/logger.ts` from `process.env.LOG_LEVEL` at import time. Every
source module calls `childLogger("<module>")` so log records carry a stable
`module` field.

### Levels

`LOG_LEVEL` accepts pino's standard ladder: `trace`, `debug`, `info`, `warn`,
`error`, `fatal`. Unknown values fall back to `info` with a one-line warning
emitted through `console.warn` from `parseLogLevel` in `src/types.ts`. The
stdio bridge references `LOG_LEVEL=debug` in its own diagnostics — at `debug`
the bridge prints every non-JSON stdout line from a backend MCP server instead
of summarizing.

### Fields

A typical proxy log line looks like:

```json
{"level":30,"time":1712999999999,"pid":1,"module":"mcp-proxy","correlationId":"3f2a1c8e9b4d5a6f","msg":"Bridge call failed","server":"filesystem","error":"connection refused"}
```

Standard fields:

- `level` — pino numeric level (30 = info, 40 = warn, 50 = error)
- `time` — ms since epoch
- `module` — attached by `childLogger` at the call site
- `correlationId` — 16-hex random id attached per `/mcp` request via
  `reqLog = log.child({ correlationId })`. Also returned to clients inside
  generic internal-error messages so operators can grep.

### Audit log

`src/mcp-proxy/logger.ts` writes audit entries directly to `process.stdout`
(one JSON object per line, not pino-formatted). Every request emits exactly
one entry with `timestamp`, `tool`, `args`, `status` (`allowed`, `blocked`,
`flagged`, `error`), `flags`, `durationMs`, and optional `errorMessage`. The
audit stream is the source of truth for who-called-what; the pino log is
operator-facing diagnostics.

## Tracing (Langfuse)

Implemented in `src/observability/langfuse.ts` and `config.ts` (PR [#30](https://github.com/zickgraf-ai/agentic-press/pull/30)).

### Enabling

```dotenv
LANGFUSE_PUBLIC_KEY=pk-...
LANGFUSE_SECRET_KEY=sk-...
LANGFUSE_HOST=https://cloud.langfuse.com
```

`LANGFUSE_HOST` is optional and defaults to Langfuse Cloud. Both keys must be
present; setting only one is treated as a misconfiguration and logs a warning
via the `langfuse` child logger, then falls back to the no-op tracer.

### Shape

- **One trace per `/mcp` request.** Named `mcp.request:<toolName>`. Started
  in the server handler as soon as the tool name is known.
- **One span per pipeline decision.** Named `mcp.tool_call`, emitted on the
  terminal decision for the request.
- **Trace metadata**: `method`, `requestId` (JSON-RPC id), `correlationId`.
- **Span metadata**: `tool`, `status`, `durationMs`, `flags` (sanitizer
  pattern names when status is `flagged`).
- **`sessionId`** is reserved in the API but not yet wired — see the comment
  in `server.ts` and the `StartTraceParams` docstring.

| Stage outcome           | Span status | Trace end outcome |
|-------------------------|-------------|-------------------|
| Allowlist rejection     | `blocked`   | `blocked`         |
| Sanitizer flag          | `flagged`   | `flagged`         |
| Path guard rejection    | `blocked`   | `blocked`         |
| No backend configured   | `allowed`   | `allowed`         |
| Route resolution miss   | `blocked`   | `blocked`         |
| Bridge call success     | `allowed`   | `allowed`         |
| Bridge call failure     | `error`     | `error`           |

### Failure modes

Observability must never break the request path. Three layers enforce that:

1. `createNoopTracer()` is used whenever config is disabled. It never imports
   the `langfuse` module, so Langfuse is a genuine optional dependency.
2. The real tracer wraps every SDK call (`trace`, `span`, `update`,
   `flushAsync`, `shutdownAsync`) in try/catch and logs at `warn`.
3. The server additionally wraps every `span`/`end` call in `safeSpan` /
   `safeEnd` to defend against custom `Tracer` implementations.

If Langfuse is unreachable mid-request, the SDK queues events in memory and
retries on its own schedule. Individual failed calls log `span failed` /
`end failed` / `startTrace failed` and are dropped silently from the
operator's perspective. `end()` is idempotent at the `ActiveTrace` layer, so
both the success and the defensive outer-catch paths can call it without
risk of double-close. Trace flushing happens on shutdown via
`tracer.shutdown()`.

### Adding a traced operation

1. Accept an `ActiveTrace` from the caller or start one via
   `tracer.startTrace({ name, metadata })`.
2. Call `activeTrace.span({ tool, status, durationMs, flags })` on the
   terminal outcome of each stage.
3. Call `activeTrace.end({ outcome, metadata? })` exactly once per trace.
   Double-calls are safe but wasteful.
4. Never let a tracer exception escape. Use `safeSpan` / `safeEnd` patterns
   from `server.ts` when integrating new call sites.

Tests under `tests/observability/` cover the config loader, the no-op
isolation guarantee (langfuse module is never imported when disabled), and
the tracer's error-isolation behaviour. `tests/server-langfuse.test.ts`
covers the server-side integration — every terminal branch emits exactly
one trace with the expected outcome.

## Metrics (Prometheus)

`src/observability/metrics.ts` exposes a `MetricsRecorder` interface plus a
`createMetricsServer` helper. Like Langfuse, metrics are strictly opt-in:
when `METRICS_PORT` is unset the proxy returns a frozen no-op recorder and
never imports `prom-client`. When set, a separate Express server on the
given port serves `GET /metrics` in Prometheus exposition format. The MCP
proxy's `audit()` function calls `safeRecord(entry)` at every terminal
pipeline outcome (allowed, blocked, flagged, error).

### Metric shape

| Metric                                  | Type      | Labels                 | Source call            |
|-----------------------------------------|-----------|------------------------|------------------------|
| `mcp_proxy_requests_total`              | counter   | `tool`, `status`       | `recordRequest`        |
| `mcp_proxy_request_duration_seconds`    | histogram | `tool`, `status`       | `recordRequest`        |
| `mcp_proxy_injection_flags_total`       | counter   | `pattern`              | `recordInjectionFlag`  |
| `mcp_proxy_blocked_total`               | counter   | `reason`               | `recordBlockedRequest` |

Block reasons are one of `allowlist`, `path_guard`, `no_route`, `unknown`.
Default Node.js process metrics (cpu, event loop lag, gc, heap) are also
emitted via `prom-client`'s `collectDefaultMetrics`.

### Vendor portability

Prometheus exposition is the de facto standard wire format for metrics.
Datadog (Datadog Agent's [OpenMetrics check](https://docs.datadoghq.com/integrations/openmetrics/)),
Azure Monitor (Managed Service for Prometheus), New Relic, Honeycomb, and
Splunk all scrape Prometheus endpoints natively. Pointing them at
`http://<proxy>:9090/metrics` is a config change in the scrape agent, not
in agentic-press code. Push-based emission (StatsD, Datadog API, AppInsights
TrackMetric) would require a separate exporter — file an issue if needed.

## Grafana / Loki (Planned, #10)

No Alloy or scrape config is checked in today. When added, it should live
under `observability/` at the repo root (or a similarly-scoped top-level
directory — not inside `src/`). The target topology:

- pino JSON stdout to Loki via Alloy's `loki.source.file` or the container
  stdout driver
- `/metrics` endpoint scraped by Alloy's `prometheus.scrape`
- Langfuse traces flow direct from the proxy to Langfuse Cloud; Grafana
  Tempo is not planned

Until then, operators can tail stdout (`docker logs`, `sbx exec ... | jq`)
and rely on Langfuse for trace search.
