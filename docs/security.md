# Security

agentic-press sits between an untrusted, sandboxed agent and trusted MCP servers running on the host. Its security posture is built on four enforcement points: the MCP proxy allowlist, the response sanitizer, the path guard, and structured audit logging. This document describes the threat model, the defenses, and — explicitly — what is not defended.

Audience: security reviewers and any contributor touching `src/security/` or `src/mcp-proxy/sanitizer.ts`.

See also: [architecture](./architecture.md), [observability](./observability.md), [development workflow](./development.md).

## Threat Model

The agent is treated as untrusted. So is every byte returned by an MCP server — a compromised or malicious server can reach the agent only through the proxy, and the proxy is the chokepoint where every mitigation runs.

| Threat | Mitigation | Code location |
|---|---|---|
| Prompt injection in MCP tool responses | Response sanitizer runs injection-pattern detection, returns `flag` / `strip` / `block` result | `src/mcp-proxy/sanitizer.ts`, `src/security/injection-patterns.ts` |
| Path traversal in tool arguments (`../`, encoded variants) | Path guard normalizes, rejects encoded traversal, confines to workspace root | `src/security/path-guard.ts` |
| Unauthorized tool call from agent | Allowlist check before forward; exact or suffix-wildcard match, fail-closed on malformed config | `src/mcp-proxy/allowlist.ts` |
| Command/markup injection via crafted MCP responses | Sanitizer categories `markup_injection`, `system_override`, `encoded_payload` | `src/mcp-proxy/sanitizer.ts`, `src/security/injection-patterns.ts` |
| Symlink escape from workspace | Path guard resolves with `realpathSync` and re-checks containment after resolution | `src/security/path-guard.ts` |
| Tool-result turn boundary forgery (fake `<|system|>`, `</tool_result>`) | `system_override` category in injection patterns | `src/security/injection-patterns.ts` |
| Zero-width unicode smuggling of hidden instructions | `unicode_smuggling` category; stripped globally in `strip` mode | `src/security/injection-patterns.ts`, `src/mcp-proxy/sanitizer.ts` |
| Base64-encoded payloads carrying injection strings | `encoded_payload` category — decode, round-trip verify, match against dangerous content | `src/security/injection-patterns.ts` |

## Enforcement Points

### Allowlist

The proxy rejects every tool call whose name does not match a configured pattern. Supported match forms:

- Exact match (e.g. `echo__read_file`)
- Suffix wildcard with non-empty prefix (e.g. `filesystem.*`, `echo__*`)
- Bare `*` catch-all

Malformed config (`null` / `undefined` / missing `patterns`) and empty tool names block unconditionally. Bare `**` does not match — only bare `*` is the catch-all, so an accidental `**` cannot silently bypass the allowlist. Matching is case-sensitive.

### Sanitizer Pipeline

The sanitizer is called on every MCP response body before it reaches the agent. It runs each pattern in `src/security/injection-patterns.ts` against the content, then applies one of three modes:

- `flag` (default): return content unchanged with a structured list of flags (pattern name, matched substring, position).
- `strip`: remove every matched substring; zero-width characters are stripped globally regardless of which pattern matched them.
- `block`: replace the entire body with a fixed blocked-content marker.

Each `InjectionPattern` owns both its `test()` and `find()` methods so there is exactly one regex per concept — the sanitizer never duplicates pattern logic.

### Injection Pattern Categories

Patterns are organized into five categories. Specific regexes are intentionally not reproduced in this document; refer to the source.

- `prompt_injection` — instruction-override phrases ("ignore/disregard/forget previous instructions") and role-assumption phrases ("you are now...", DAN-style jailbreaks).
- `system_override` — forged turn boundaries (`<|system|>`, `[SYSTEM]`, `<<SYS>>`), `system:` line prefixes, injected `{"tools": [...]}` / `{"function_call": {...}}` blocks, and `</tool_result>` escape attempts.
- `unicode_smuggling` — zero-width and invisible characters (ZWSP, ZWNJ, ZWJ, BOM, word joiner).
- `encoded_payload` — base64 strings that round-trip-verify and decode to known-dangerous content (override phrases, `eval(`, `exec(`, `rm -rf`, `process.exit/env/kill`).
- `markup_injection` — `<script>`, event handlers, `<iframe>`, `<style url(...)>`, `javascript:` URLs, and markdown images pointing to external hosts (data exfil channel).

### Path Guard

`checkPath(path, { workspaceRoot })` returns either `{ allowed: true, resolvedPath }` or `{ allowed: false, reason }`. It rejects in this order: empty path, invalid workspace root, null byte, backslash, drive letter, encoded-traversal sequence. It then resolves the path (absolute paths are normalized; relative paths resolve against the workspace root), checks logical containment, resolves symlinks with `realpathSync`, and re-checks containment. Both logical and real-path checks must pass.

Encoded-traversal detection targets actual traversal sequences — single-encoded, double-encoded (`%25xx`), overlong UTF-8 (`%c0%ae`), and fullwidth slash (`%ef%bc%8f`) — not individual percent-encoded characters, to avoid false positives on legitimate encoded filenames.

## Clean-Room Sourcing

Every pattern, threat, and mitigation in this codebase is sourced from public material only:

- OWASP Top 10 for LLM Applications (2025)
- MCP specification security considerations
- `invariantlabs.ai` published MCP attack-vector research
- Public CVE advisories

No code or pattern is ported from Ren or Wake. This is a non-negotiable project rule — see `CLAUDE.md`. Contributors modifying `src/security/` or `src/mcp-proxy/sanitizer.ts` must cite a public source in the file header comment and run the security test suite before opening a PR.

## CVE References

| CVE | Description | Our mitigation |
|---|---|---|
| CVE-2025-6514 (CVSS 9.6) | `mcp-remote` arbitrary OS command execution via crafted `authorization_endpoint` URLs | Allowlist blocks unknown tools; sanitizer `system_override` category flags injected tool/function-call blocks in responses |
| CVE-2025-53110 | Filesystem MCP Server directory-containment bypass | Path guard enforces workspace-root containment on both logical and symlink-resolved paths |
| CVE-2025-53109 | Filesystem MCP Server symlink-traversal bypass | Path guard calls `realpathSync` and re-runs the containment check after symlink resolution |

## Audit Logging

Every MCP request and response passes through `src/mcp-proxy/logger.ts` and is emitted as a structured JSON log line (pino). Every sanitizer flag and every allowlist rejection is logged with enough context — tool name, pattern name, match position, sanitize mode, decision — to reconstruct what the proxy saw and what it did. Logs are the authoritative audit record; see [observability](./observability.md) for sinks, retention, and Langfuse tracing.

## What Is Not Defended

The following risks are out of scope for this codebase. Deployers must address them separately.

- **Supply-chain compromise of MCP servers themselves.** The proxy inspects traffic but does not verify the integrity of the MCP server binaries or their dependencies. A malicious server that produces responses within our allowed patterns will be forwarded.
- **Authentication on the proxy itself.** agentic-press is single-user by design. There is no user authentication, no API keys, and no multi-tenancy on the proxy listener. Network exposure of the proxy port is the deployer's responsibility.
- **Resource exhaustion / DoS.** There are no rate limits, request-size limits, or concurrency caps in the proxy. A misbehaving agent or server can exhaust host resources.
- **Sandbox escape.** Container isolation is owned by sbx; we do not harden the container runtime. See [architecture](./architecture.md) for the boundary.
- **Secret exfiltration via allowed tools.** If `filesystem.readFile` is allowed and the agent reads a credential file inside the workspace, the allowlist will not stop it. Deployers must keep secrets out of the sandbox workspace.
- **Novel injection vectors.** Pattern-based detection is a known-bad filter. Any technique not in the public sources listed above will pass through `flag` mode silently. Use `block` mode for high-assurance deployments.
- **Semantic prompt-injection defense.** We detect syntactic markers, not semantic intent. A polite, well-formed instruction override using no flagged tokens will not be caught.

## Verifying Defenses

The test suite is organized to let a reviewer verify each mitigation in isolation:

- `tests/injection-patterns.test.ts` — per-category detection, per-pattern-name detection, metadata completeness, false-positive checks on clean content.
- `tests/sanitizer.test.ts` — `flag` / `strip` / `block` modes, multi-injection handling, repeated-payload stripping.
- `tests/path-guard.test.ts` — valid paths, traversal, encoded separators, null bytes, symlink escape, Windows-style rejection, edge cases.
- `tests/allowlist.test.ts` — exact match, wildcard semantics, case sensitivity, malformed-config fail-closed behavior, `**` bypass guard.

Run `npm test` inside the sbx sandbox (see [development](./development.md)) after any change under `src/security/` or `src/mcp-proxy/sanitizer.ts`.
