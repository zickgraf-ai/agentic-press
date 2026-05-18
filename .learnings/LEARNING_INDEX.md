# Learning Index

Lessons learned from previous sessions. Each entry links to a detailed learning file.

| Date | Category | Learning | File |
|------|----------|---------|------|
| 2026-04-05 | architecture | sbx does not support custom Dockerfile templates — use `sbx save` to snapshot, not `docker build` | [link](2026-04-05_sbx-no-custom-dockerfile-templates.md) |
| 2026-04-05 | tooling | Claude Code in sbx requires `/login` for Max subscription auth — otherwise bills per-token | [link](2026-04-05_sbx-login-for-max-auth.md) |
| 2026-04-05 | architecture | sbx claude agent may mount parent directory as workspace, not the specified subdirectory | [link](2026-04-05_sbx-workspace-mount-scope.md) |
| 2026-04-06 | architecture | MCP SSE transport is deprecated — use Streamable HTTP only, never implement SSE | [link](2026-04-06_mcp-sse-deprecated.md) |
| 2026-05-09 | process | Vendored-skill trials need pre-defined success criteria + instrumentation, not calendar prompts (Superpowers cherry-pick #55) | [link](2026-05-09_superpowers-cherrypick-criteria.md) |
| 2026-05-11 | architecture | `sbx exec` cwd defaults to `/home/agent/workspace`, not the workspace bind-mount — apd agents must `cd` first or they won't find `.mcp.json` | [link](2026-05-11_apd-cwd-vs-workspace-mount.md) |
| 2026-05-11 | tooling | `apd` doesn't bootstrap `claude` or auth in fresh `sbx shell` sandboxes; Stage B "dispatch Claude Code" needs follow-up work before it's realistic | [link](2026-05-11_apd-no-claude-bootstrap.md) |
