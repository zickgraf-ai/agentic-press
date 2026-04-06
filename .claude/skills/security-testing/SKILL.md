---
name: security-testing
description: Injection prevention patterns, CVE references, and test-first security workflow
---

## Implementation Status
- **Implemented**: Injection patterns (17 patterns, 5 categories), sanitizer (flag/strip/block modes), allowlist (exact/wildcard/catch-all), path guard (traversal, symlinks, encoded)
- **Tests**: 178 passing — injection-patterns, sanitizer, allowlist, path-guard

## Injection Pattern Categories

We test for these attack vectors in MCP tool responses and requests:

1. **Prompt injection via tool responses** — "ignore previous instructions", "you are now", "disregard", "forget" + role override phrases
2. **Zero-width unicode smuggling** — U+200B (ZWSP), U+200C (ZWNJ), U+200D (ZWJ), U+FEFF (BOM), U+2060 (Word Joiner) hiding instructions between visible characters
3. **Base64-encoded payloads** — Base64 strings that decode to known injection phrases (only flags dangerous decoded content, not all base64)
4. **Path traversal** — `../`, encoded variants (`%2f`, `%5c`, double-encoded, overlong UTF-8, fullwidth), null bytes, symlink following
5. **Markdown/HTML injection** — `<script>`, event handlers, `<iframe>`, `javascript:` protocol, markdown image exfiltration, CSS url() exfiltration
6. **System prompt override** — Fake turn boundaries (`<|system|>`, `<|assistant|>`, `[SYSTEM]`), tool definition injection, function_call injection, tool_result XML escape

## Reference CVEs

- **CVE-2025-6514** (mcp-remote, CVSS 9.6) — Arbitrary OS command execution via crafted `authorization_endpoint` URLs. Discovered by JFrog Security Research. Demonstrates that injected tool/function definitions in MCP responses can trigger code execution.
- **CVE-2025-53110** (Filesystem MCP Server) — Directory containment bypass. Attacker can escape the allowed directory boundary through crafted path arguments.
- **CVE-2025-53109** (Filesystem MCP Server) — Symlink traversal bypass. Attacker creates symlinks inside allowed directory pointing outside, then accesses files through the symlink.

## Source Material

- OWASP Top 10 for LLM Applications (2025)
- MCP specification security considerations section
- invariantlabs.ai published MCP attack vector research
- Published blog posts on MCP injection techniques

## Test-First Workflow

1. **Red**: Write failing tests in `tests/injection-patterns.test.ts`, `tests/sanitizer.test.ts`, `tests/path-guard.test.ts` that define expected detection behavior
2. **Green**: Implement patterns in `src/security/injection-patterns.ts` and sanitizer in `src/mcp-proxy/sanitizer.ts` to make tests pass
3. **Verify**: Run `npx vitest run` — all tests must pass. Include false-positive tests with clean content.

## Clean-Room Requirement

All patterns MUST be sourced from public research (OWASP, MCP spec, published CVEs, public blog posts). NEVER port patterns from any employer's codebase (Ren, Wake, or any other). This is a legal and IP separation requirement.
