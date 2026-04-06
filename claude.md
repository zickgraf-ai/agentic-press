# agentic-press

Thin orchestration layer on top of Docker Sandbox (sbx). Adds MCP proxy with security filtering, audit logging, and tool allowlisting. Wraps sbx — never reimplements it.

## Commands

```bash
npm run build        # Compile TypeScript
npm test             # Run all tests (Vitest)
npm run typecheck    # Type check without emitting
npm run dev          # Start MCP proxy (tsx)
./scripts/sandbox-run.sh  # Full integration test (proxy + sbx sandbox)
```

## Code Style

- TypeScript, functions and composition over classes
- Tests in `tests/` directory (Vitest, `*.test.ts`)
- Conventional commits: `feat:`, `fix:`, `chore:`, `refactor:`, `docs:`, `test:`
- Config via environment variables (`.env.example`)
- Error handling: fail loudly, structured error messages

## Security Requirements (NON-NEGOTIABLE)

- All injection patterns are **clean-room** from public sources: OWASP Top 10 for LLM Apps, MCP spec, published CVEs
- **DO NOT** port code from Ren or Wake — clean-room only
- MCP proxy MUST validate all tool calls against allowlist before forwarding
- Reference CVEs: CVE-2025-6514 (mcp-remote, CVSS 9.6), CVE-2025-53110 (directory containment bypass), CVE-2025-53109 (symlink traversal bypass)
- Run security tests after ANY change to `src/security/` or `src/mcp-proxy/sanitizer.ts`
- All MCP proxy requests/responses logged for audit
- No host filesystem access from sandbox except sbx-managed workspace mount

## Architecture Rules

- sbx handles sandbox lifecycle — we never reimplement sandbox management, container runtime, or network policies
- MCP servers run on HOST, proxy mediates all access from sandboxed agents
- Observability (Langfuse, Grafana) and dashboard (Mission Control) are opt-in via env vars — no hard dependencies
- See `docs/ARCHITECTURE.md` for detailed architecture and phase planning

## What NOT to Build

- Custom sandbox manager or container runtime (sbx does this)
- Custom web dashboard (adopt Mission Control)
- Auth or multi-tenancy (single-user only)
- OMC integration, AWS headless, or multi-agent (Phase 2)
- Any code ported from Ren or Wake

## Development Workflow

- **TDD required**: write failing tests first → implement → refactor
- **GitHub issues first**: create issue before starting work
- **Worktree isolation**: use `git worktree` for feature branches
- **Branch naming**: `<type>/<issue-number>-<description>` (e.g., `feat/7-mcp-proxy-server`)
- **Code review before merge**: every PR reviewed via pr-review-toolkit, address findings, merge after approval
- **Security changes**: enter Plan Mode first for any changes to `src/security/` or `src/mcp-proxy/`
- **Workflow**: issue → branch → tests → implement → PR → review → fix → merge

## Key Paths

- `src/mcp-proxy/` — proxy server, allowlist, sanitizer, logger, stdio bridge
- `src/security/` — injection patterns, path guard
- `src/observability/` — Langfuse, Prometheus metrics
- `src/dashboard/` — Mission Control adapter
- `tests/` — all test files
- `scripts/` — sbx integration scripts
- `sbx/` — Dockerfile (Phase 2 AWS only; local uses sbx save for templates)
