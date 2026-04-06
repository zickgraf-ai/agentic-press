---
date: 2026-04-05
category: tooling
source: user-correction
confidence: high
---

## What happened

When `sbx run claude` was first launched, the status showed "API Usage Billing" instead of Max subscription. Without `/login`, every agent session would consume pay-per-token API billing instead of the Max subscription's included usage.

## Root cause

sbx doesn't inherit host-level Claude authentication. The sandbox runs its own Claude Code instance with `apiKeyHelper: "echo proxy-managed"` — the sbx proxy manages API keys, but OAuth authentication for Max subscription must be performed inside the sandbox via the `/login` command. The proxy handles the OAuth flow so credentials aren't stored in the sandbox.

## Rule

After creating a new `sbx claude` sandbox, always run `/login` before doing any work. Verify auth status shows Max subscription, not API Usage Billing. This is a one-time setup per sandbox — the auth persists across sandbox stop/start cycles.

## Evidence

- Docker Sandbox documentation on credentials
- sbx verification session (Issue #1)
