---
name: dashboard-integration
description: Mission Control integration patterns and time-box rules
---

## Implementation Status
- **Not yet implemented**: All dashboard modules are stubs (`src/dashboard/adapter.ts`, `event-bridge.ts`, `config.ts` all throw "Not implemented")
- **Next**: Issue #11 — Mission Control integration (time-boxed to 2-3 hours)

## Mission Control (builderz-labs/mission-control)

**WARNING: Alpha software** — APIs, database schemas, and config formats may change between releases. Pin to a specific release tag. Keep the adapter thin so breaking changes upstream don't cascade.

### What It Provides
- Kanban board (inbox → assigned → in progress → review → done) with drag-and-drop
- Real-time session tracking for Claude Code (auto-discovers from ~/.claude/projects/)
- Token usage dashboard with per-model breakdowns, trend charts, cost analysis
- Memory browser with filesystem-backed memory tree
- Skill management with built-in security scanner
- SQLite-based, zero external dependencies, single `pnpm start`

### Integration Surface
- **Adapter layer** for multi-agent frameworks (OpenClaw, CrewAI, LangGraph, AutoGen, Claude SDK, generic fallback)
- **Direct CLI mode** — no gateway required for existing CLI agent workflows
- **Task Bridge** — read-only scanner surfacing tasks from `~/.claude/tasks/`
- **Webhooks** with HMAC-SHA256 signatures
- **Comms API** for agent inter-agent messaging

### Our Integration Approach
1. Register as generic fallback adapter or use Direct CLI path
2. **Session registration**: When agent-sandbox starts a sandbox, register with Mission Control API
3. **Task tracking**: Feed agent task into Kanban (inbox → assigned → in progress → review)
4. **Event streaming**: Forward MCP proxy events (tool calls, injection flags) via webhook/comms API
5. **Cost data**: Bridge Langfuse token usage to Mission Control cost tracking

### Time-Box Rule
Spend no more than **2-3 hours** on Mission Control integration. If the API surface doesn't match expectations, switch to agents-observe without guilt.

### Adapter Module Structure
- `src/dashboard/adapter.ts` — Mission Control API client (session CRUD, task updates)
- `src/dashboard/event-bridge.ts` — Transforms MCP proxy events into Mission Control format
- `src/dashboard/config.ts` — URL, API key, enable/disable flag. Opt-in: no-op when not configured.

## Fallback: agents-observe (simple10/agents-observe)

- Real-time tool call visualization, subagent relationship trees
- Uses Claude Code hooks for event capture (hook script → API server → React dashboard)
- Docker-based, lighter weight than Mission Control
- Better for "watch the agent work" visualization, weaker on task management
- Dashboard at `http://localhost:4981`
