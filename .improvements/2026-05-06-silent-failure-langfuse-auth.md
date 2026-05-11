---
id: 2026-05-06-silent-failure-langfuse-auth
category: silent-failure
confidence: high
status: addressed
created: 2026-05-06T18:40:00.000Z
addressed: 2026-05-11T17:55:00.000Z
addressed_via: "issue #73"
source: manual-entry
---

# Surface Langfuse credential / region mismatch at startup

The Langfuse SDK silently swallows authentication failures. If `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` belong to one region but `LANGFUSE_HOST` points to another (or to no host, defaulting to EU when keys are US-region), the SDK accepts the configuration, logs `Langfuse tracing enabled` at startup, and uploads happen to fail with **zero operator-visible signal**. Traces never appear in the UI, and the only way to discover the misconfiguration is to notice empty trace lists.

This bit us during the 2026-05-06 telemetry validation session — wasted ~30 minutes debugging why no traces were landing before realizing the keys belonged to a different project (and incidentally a different region). PR #48 documented the regional pitfall but did not add a runtime check.

## Proposal

Add a startup probe in `createTracer` (`src/observability/langfuse.ts`) that confirms credentials authenticate against the configured host before declaring `Langfuse tracing enabled`. Implementation sketch:

1. Inside the enabled branch of `createTracer`, after constructing the `LangfuseClient` but before returning the tracer, fire a one-shot `fetch(\`${config.host}/api/public/projects\`, { headers: { Authorization: 'Basic ' + base64(\`${publicKey}:${secretKey}\`) } })`.
2. If the response is `401`: log a loud warning naming the most likely cause (region mismatch), and continue with the tracer (do **not** fall back to no-op — the operator may want traces to start working as soon as they fix the env without restarting). The wrapper preserves the "observability never breaks startup" invariant.
3. If the response is `200`: optionally log `verified credentials, project: <project-id>` at info level so operators get an explicit confirmation.
4. If the request errors (network, timeout): log at warn but continue — could be transient.

The probe must have a tight timeout (~3s) and never block startup beyond that.

## Why this is worth doing

- **High user-frustration cost when it bites.** The failure mode is invisible until someone goes looking for traces. By that time the operator has built up a debugging workflow that doesn't match the actual problem.
- **Cheap to implement.** ~30 lines plus tests. Single HTTP call, well-defined response codes.
- **Self-documenting.** A clear startup log message ("Langfuse credentials authenticate against `<host>` — project `<id>`") doubles as runtime confirmation for operators verifying their config.
- **Defends the "observability never breaks the request path" invariant in both directions.** Today we defend against tracer exceptions breaking requests. This adds the symmetric defense against silent observability blackouts.

## Evidence

```yaml
incident_date: "2026-05-06"
session_log: "~/Obsidian/claude-workspace/Journal/2026-05-06-langfuse-v5-telemetry.md"
debug_time_lost: "~30 minutes"
related_pr_docs_only: 48
related_pr_sdk_upgrade: 49
file_to_modify: "src/observability/langfuse.ts"
recommended_endpoint: "/api/public/projects"
recommended_timeout_ms: 3000
fail_loud_response_code: 401
```

## How this was generated

Manually filed — this is **not** an output of `scripts/sweep-improvements.mjs`. The pattern was observed firsthand during the SDK upgrade session and the agent (operator) chose to surface it here for human triage rather than implement it inline. The category `silent-failure` does not exist in the current detector enum; if a future sweep is taught to detect this class of failure, it would need a new category in `src/improvements/types.ts`.

## Triage

- **To dismiss**: change `status: open` to `status: dismissed` in the frontmatter, or delete this file.
- **To address**: run `npm run address-improvement -- 2026-05-06-silent-failure-langfuse-auth` (or click "Address" in Mission Control's Memory Browser). This creates a feature branch and a draft PR seeded with this suggestion as the description.
