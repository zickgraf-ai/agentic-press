---
date: 2026-05-11
source: dogfood-session
status: agent-suggested
---

# apd operator-UX gaps surfaced during Tier 1.4 dogfood

Agent-generated from session 2026-05-11. Not auto-loaded into context. Triage manually.

## 1. Silent success path

On the happy path, `apd` prints nothing to stdout/stderr until the agent itself starts producing output. The operator has no visibility into:

- "session minted: ..."
- "control-plane register OK"
- ".mcp.json written at <path>"
- "sandbox <name> created"
- "policy IDs allocated: ..."
- "exec starting"
- "exec finished, cleaning up"

This is fine for CI but rough for interactive use, especially when a step takes 10–30s (sbx create is slow on macOS because Docker Desktop has to start). Adding pino `info` lines at each transition would be cheap and high-value.

## 2. `.mcp.json` rewrite requires `--force` on every rerun

Because every run mints a new sessionId, the existing `.mcp.json` content always differs from the new desired content → conflict → exit 69 → operator passes `--force`. The conflict-detection logic is correct, but rerunning the same manifest twice in a row needs `--force` always. Two possible improvements:

- Auto-overwrite when the existing `.mcp.json` was *written by apd itself* (detect by structure shape — has the agentic-press mcpServer block with `host.docker.internal:<port>/mcp`).
- Print a friendlier hint ("Existing .mcp.json was likely apd-generated for a previous session — pass --force to mint a new one") rather than just the bare conflict message.

## 3. Mission Control dashboard during dispatch — visibility unclear

`npm run dev` enabled Mission Control at `http://localhost:3000`. I didn't open the browser this session, so I don't know what (if anything) it shows for an `apd`-driven session in real time. Worth a follow-up to verify:

- Does the session appear in MC during the brief window it's registered?
- Does the per-session allowlist show up?
- Does the deny event (Stage B-lite Test B) appear as a visible audit entry?

If not, this is a Tier 1.5 dashboard-integration gap rather than an `apd` issue, but it's the kind of thing an operator running `apd` would expect to "just work."

## 4. No way to dispatch into an existing sandbox

`apd` always creates a fresh sandbox. For Claude Code workflows (per issue #76) where `/login` has to happen ahead of dispatch, there's no way to say "dispatch into sandbox 'foo' that I already prepped." Probably worth a `--use-existing-sandbox <name>` flag eventually, but only after the claude-bootstrap story is decided.

## 5. agentCommand contract: cwd expectation

(Already filed as #75.) Adding a `cwd: string` field to the manifest entry, validated against the workspace, would be the cleanest fix and would also serve as documentation. Mentioning here to ensure the improvement isn't dropped if #75's implementation goes another way.
