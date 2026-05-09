# Security

agentic-press sits between an untrusted, sandboxed agent and host-resident MCP servers. Its security posture is built on five enforcement points: the MCP proxy allowlist, the request-argument sanitizer, the path guard, the **response sanitizer**, and structured audit logging. This document describes the threat model, the defenses, and — explicitly — what is not defended.

Audience: security reviewers and any contributor touching `src/security/` or `src/mcp-proxy/sanitizer.ts`.

See also: [architecture](./architecture.md), [observability](./observability.md), [development workflow](./development.md).

> **Scope note.** The sanitizer runs on **both directions**: on tool-call request arguments sent by the agent, and on upstream MCP server responses before they reach the agent. A flag in either direction rejects the call with a generic JSON-RPC error; raw matched content is never echoed back. Image and audio content blocks skip only their binary fields (`data`, `blob`) during response walking — sibling text is still inspected because the block `type` is attacker-controlled. See [#35](https://github.com/zickgraf-ai/agentic-press/issues/35) for the decision record.

## Threat Model

Both the agent and upstream MCP servers are treated as untrusted input sources. Agent-originated traffic may be relaying attacker-controlled content it read from the filesystem; upstream responses may come from a compromised or malicious MCP server (CVE-2025-6514).

| Threat | Mitigation | Code location |
|---|---|---|
| Prompt injection in agent tool-call arguments | Request-arg sanitizer runs injection-pattern detection, returns `flag` / `strip` / `block` result on the offending arg value | `src/mcp-proxy/sanitizer.ts`, `src/security/injection-patterns.ts` |
| Prompt injection in MCP tool responses | Response sanitizer walks every string-valued field in the upstream result; any flag rejects the response with JSON-RPC `-32001` and a generic ref-only message. Walker is cycle-safe (WeakSet), depth-capped (64), and fails closed on exception. | `src/mcp-proxy/response-sanitizer.ts`, `src/mcp-proxy/server.ts` |
| Path traversal in tool arguments (`../`, encoded variants) | Path guard normalizes, rejects encoded traversal, confines to workspace root | `src/security/path-guard.ts` |
| Unauthorized tool call from agent | Allowlist check before forward; exact or suffix-wildcard match, fail-closed on malformed config | `src/mcp-proxy/allowlist.ts` |
| Command/markup injection in tool-call arguments | Sanitizer categories `markup_injection`, `system_override`, `encoded_payload` applied to arg values | `src/mcp-proxy/sanitizer.ts`, `src/security/injection-patterns.ts` |
| Symlink escape from workspace | Path guard resolves with `realpathSync` and re-checks containment after resolution | `src/security/path-guard.ts` |
| Tool-result turn boundary forgery (fake `<|system|>`, `</tool_result>`) | `system_override` category in injection patterns | `src/security/injection-patterns.ts` |
| Zero-width unicode smuggling of hidden instructions | `unicode_smuggling` category; stripped globally in `strip` mode | `src/security/injection-patterns.ts`, `src/mcp-proxy/sanitizer.ts` |
| Base64-encoded payloads carrying injection strings | `encoded_payload` category — decode, round-trip verify, match against dangerous content | `src/security/injection-patterns.ts` |
| Denial-of-service via unbounded upstream response (memory exhaustion) | Stdio bridge rejects any single response line that exceeds `MAX_RESPONSE_BYTES` (default 10 MiB) at the read layer, before JSON parsing. HTTP bridge enforces the same cap on the received body before `JSON.parse` (the OOM defence is weaker — `fetch` fully buffers the body before measurement — but still bounds memory). The in-flight call is rejected with the response sanitizer's generic JSON-RPC `-32001` reply on both transports. Envelope is byte-identical between size-cap and content-sanitizer rejections, but **wall-clock latency may differ and is not constant-time** — size-cap fires mid-stream (stdio) or post-fetch (http) while the content sanitizer fires after a full parse, so a careful attacker can still distinguish the two via timing. Treat as defense-in-depth, not size-probe-proof. Audit entry carries `direction=response, status=blocked, errorMessage="response size cap exceeded"`. Set `MAX_RESPONSE_BYTES=0` to disable. | `src/mcp-proxy/stdio-bridge.ts`, `src/mcp-proxy/http-bridge.ts`, `src/mcp-proxy/server.ts` |
| Plain HTTP credential / payload exposure to remote MCP servers | `parseServerDefs` rejects HTTP server definitions where `url` uses `http://` and the host is not localhost (`localhost`, `127.0.0.1`, `::1`). Bearer tokens and request/response bodies cannot be sent in cleartext to a remote MCP server — `https://` is required. Local development against `http://localhost` is permitted. | `src/server-config.ts` |

## Enforcement Points

### Allowlist

The proxy rejects every tool call whose name does not match a configured pattern. Supported match forms:

- Exact match (e.g. `echo__read_file`)
- Suffix wildcard with non-empty prefix (e.g. `filesystem.*`, `echo__*`)
- Bare `*` catch-all

Malformed config (`null` / `undefined` / missing `patterns`) and empty tool names block unconditionally. Bare `**` does not match — only bare `*` is the catch-all, so an accidental `**` cannot silently bypass the allowlist. Matching is case-sensitive.

### Sanitizer Pipeline

The sanitizer is called on every string-valued tool-call argument before the call is forwarded to the upstream MCP server, and on every string-valued field in the upstream response before it reaches the agent. The response-side walker (`src/mcp-proxy/response-sanitizer.ts`) is cycle-safe via `WeakSet`, depth-capped at 64, treats `Date`/`Buffer`/typed-arrays as opaque scalars, and fails closed if it throws. Image and audio content blocks skip only their `data` and `blob` fields — sibling text is still walked because the block `type` is attacker-controlled and could be used to smuggle prompt content past a whole-block skip. Duplicate flags are deduped and capped to bound audit-entry size. It runs each pattern in `src/security/injection-patterns.ts` against the content, then applies one of three modes:

- `flag` (default): return content unchanged with a structured list of flags (pattern name, matched substring, position).
- `strip`: remove every matched substring; zero-width characters are stripped globally regardless of which pattern matched them.
- `block`: replace the entire body with a fixed blocked-content marker.

These modes describe the **sanitizer library's** behaviour. The **proxy server** layered on top rejects the tool call whenever the sanitizer returns any flag, regardless of which mode the library used. So `flag` mode is not "permissive" at the proxy boundary — it just means the sanitizer reports findings instead of mutating the input before the server applies its reject-on-any-flag policy.

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
- Public CVE advisories

No code or pattern is ported from any proprietary or non-public source. This is a non-negotiable project rule. Contributors modifying `src/security/` or `src/mcp-proxy/sanitizer.ts` must cite a public source in the file header comment and run the security test suite before opening a PR.

## CVE References

| CVE | Description | Our mitigation |
|---|---|---|
| CVE-2025-6514 (CVSS 9.6) | `mcp-remote` arbitrary OS command execution via crafted `authorization_endpoint` URLs | Allowlist blocks unknown tools. Sanitizer `system_override` and `markup_injection` categories run on **both** request arguments and upstream responses — injected tool/function-call blocks, `javascript:` URIs, and `</tool_result>` escapes are rejected in either direction. The proxy never dynamically executes any field from a response; it only forwards filtered JSON to the agent. |
| CVE-2025-53110 | Filesystem MCP Server directory-containment bypass | Path guard enforces workspace-root containment on both logical and symlink-resolved paths |
| CVE-2025-53109 | Filesystem MCP Server symlink-traversal bypass | Path guard calls `realpathSync` and re-runs the containment check after symlink resolution |

## Audit Logging

Every MCP request and every upstream response passes through `src/mcp-proxy/logger.ts` and is emitted as a structured JSON log line (pino). Every sanitizer flag and every allowlist rejection is logged with enough context — tool name, pattern name, match position, sanitize mode, decision — to reconstruct what the proxy saw and what it did. Entries carry a `direction` field (`request` or `response`) so request-side and response-side decisions are distinguishable in post-hoc analysis. Response-side flagged entries also include an operator-searchable `errorMessage` summarizing which pattern names matched; pattern names are never returned to the agent. Logs are the authoritative audit record; see [observability](./observability.md) for sinks, retention, and Langfuse tracing. Test-coverage gaps for the audit-logging path are tracked in [#34](https://github.com/zickgraf-ai/agentic-press/issues/34).

## What Is NOT Defended Against

- **Semantic prompt injection in clean English.** Pattern matching is a coarse first layer; the agent's own instruction-following discipline is the second. High-assurance deployments should pair `block` mode with output validation and human-in-the-loop confirmation.
- **Covert data in image/audio binary fields.** Response sanitization skips `data` and `blob` inside image/audio blocks because they are opaque payloads. If the agent decodes and renders them, that is a separate trust boundary from this proxy.
- **Compromise of the proxy process itself.** The proxy is trusted code; there is no in-process sandboxing of its own logic.

## Operator Responsibilities

The proxy is one layer in a defense-in-depth strategy. The following concerns are out of scope for this codebase and must be handled by the deployer:

- **MCP-server supply chain.** Vet and pin the MCP server implementations and their dependencies before deployment. The proxy inspects traffic but cannot attest to upstream binary integrity.
- **Network access control.** Bind the proxy listener only to interfaces reachable by trusted sandboxes. Use a host firewall, reverse proxy, or VPN to restrict exposure. agentic-press is single-user by design — add authentication at the network or reverse-proxy layer if multi-tenancy is required.
- **Rate limiting and resource caps.** Apply request-size, rate, and concurrency limits at the network or reverse-proxy layer. Set host-level cgroup or ulimit constraints on the proxy process and on sbx sandboxes.
- **Container isolation.** Container hardening is owned by sbx. Keep sbx and Docker up to date and audit `sbx policy` rules. See [architecture](./architecture.md) for the trust boundary.
- **Workspace secret hygiene.** The allowlist does not distinguish credential files from any other file. Keep secrets out of the sandbox workspace; mount them only through sbx's secret-management surface.
- **Defense-in-depth for prompt injection.** Pattern-based detection is one layer; combine it with output validation, content provenance checks, and human-in-the-loop confirmation for high-stakes tool calls. Use `block` mode for high-assurance deployments.

## Control-plane trust boundary

Tier 1.3 (#56) introduces a **second HTTP listener** alongside the proxy: the control-plane server. The proxy serves untrusted sandbox traffic on `0.0.0.0:18923`; the control plane handles privileged session-registry mutations on `127.0.0.1:18924`. A sandbox-side process registering a permissive allowlist for itself would defeat the entire per-session policy, so the control plane's trust boundary is non-negotiable.

**Two layers, belt-and-braces:**

1. **Loopback bind** on `127.0.0.1:18924`. Sandboxes can reach `host.docker.internal` (the host's Docker bridge IP) but **not** the host's loopback interface — connections to `127.0.0.1:18924` from inside a sandbox are RST'd at the kernel. The bind is a hard-coded literal in `src/index.ts`; there is intentionally no env knob to widen it. Changing it requires a code change and security review.
2. **Bearer-token gate** via the `MCP_CONTROL_TOKEN` env var on every endpoint except `GET /health`. Comparison uses `crypto.timingSafeEqual` with an explicit length check first (a wrong-length token returns 401, not 400 — preventing a length-probe distinguisher). When the token is unset at startup the control plane **does not start** and the proxy continues with the global allowlist as in Phase 1.

**Threat decomposition.** "Sandbox escape" is six different concerns; each has a different defence:

| # | Threat | Primary defence | Backstop | Out-of-scope / caveats |
|---|---|---|---|---|
| 1 | **Container escape (kernel-level)** — agent gets shell on host kernel via Docker / container exploit | sbx + Docker isolation, kernel patching | None at our layer | Operator responsibility; tracked under [Operator Responsibilities](#operator-responsibilities) |
| 2 | **Network escape** — sandbox tries `curl http://host.docker.internal:18924/sessions` | Loopback bind on `127.0.0.1:18924`. `host.docker.internal` resolves to the Docker bridge IP, **not** `127.0.0.1`; connection refused | Bearer token | **Depends on sbx not running sandboxes with `--network host`.** Documented dependency on the sbx side. |
| 3 | **Token theft** — agent obtains the bearer token | (a) Token never enters sandbox — host-side env only, never passed via `sbx exec --env`. (b) Token never logs (audit, trace, Prometheus, MC adapter, stdout). (c) 256-bit unguessable. (d) `crypto.timingSafeEqual` with explicit length check | Loopback bind: stolen token alone won't reach the port from outside the host | Operator footgun: pasting the token into a terminal whose stdout ends up in a sandbox-readable location leaks it. Documented but not enforced. |
| 4 | **Identity spoofing** — agent A sets `X-Agent-Session-Id` to agent B's id to inherit B's allowlist | Dispatch CLI (Tier 1.4) mints session IDs as 16-byte random hex — unguessable. Per-sandbox workspace mounts (sbx default) prevent A from reading a file B wrote | Lookup precedence: a forged session id that doesn't exist in the registry falls through to the global allowlist (the most-restrictive baseline) | If operator deliberately gives two agents a shared workspace mount, one can leak its session id to the other. Documented sharp edge. |
| 5 | **Confused deputy via dispatch CLI** — agent influences the dispatch CLI (which holds the token) into registering a permissive session for it | Tier 1.4 contract: dispatch CLI constructs the registration payload from operator-provided manifest only — never from sandbox stdout, never from sandbox-writable files | None at the control-plane layer (this lives one layer up) | Tier 1.3 must not preclude this contract. Future MC connectors must inherit it. |
| 6 | **Self-elevation via /mcp** — agent calls a /mcp method that mutates the registry | Not a vector by construction: `/mcp` doesn't speak the control-plane protocol; the proxy reads but never writes the registry. Type-level guard: `ProxyServerConfig.registry` is `Pick<SessionRegistry, "lookup">`, so a TypeScript-level mistake won't compile | Code review for any new `/mcp` admin method | A future PR adding `/mcp/admin` would need explicit Plan-Mode approval. |

**Defences explicitly NOT added:**

| Not added | Reason |
|---|---|
| mTLS on control plane | Heavy. Single-user system. Loopback + token suffices. |
| Per-token rate limiting | Loopback bind already restricts attack surface to host-only. Add later if it becomes a real signal. |
| Token rotation without restart | Env-based config, restart-to-rotate. Acceptable single-user trade-off. |
| Configurable bind via env var | Operator footgun that could silently void the primary defence. Hard-coded literal in source. |
| Auto-generation of bearer token with stdout print | "Secret printed to logs" is a bad pattern even when intentional, and fragile if operator doesn't capture stdout. Explicit-only. |

**Audit invariants for the control plane:**

- Successful `POST /sessions` and `DELETE /sessions/:id` write a single `direction: "control-plane"` audit entry per call. Structured fields capture `action` (`register`/`deregister`), `sessionId`, `agentType`, `remoteAddress`, `remotePort`, and (for register only) `allowedToolsCount`.
- The allowlist contents are **never** recorded — only the count of allowed tools — so an audit-log reader cannot derive an operator-private allowlist by scraping NDJSON.
- 401 / 400 rejections write a warn-log only, **not** an audit entry. This prevents a probe burst from flooding the NDJSON file.
- The token value never appears in any log line, audit entry, trace metadata, Prometheus output, or MC payload. Tested in `tests/orchestrator/control-plane.test.ts`.

## Verifying Defenses

The test suite is organized to let a reviewer verify each mitigation in isolation:

- `tests/injection-patterns.test.ts` — per-category detection, per-pattern-name detection, metadata completeness, false-positive checks on clean content.
- `tests/sanitizer.test.ts` — `flag` / `strip` / `block` modes, multi-injection handling, repeated-payload stripping.
- `tests/path-guard.test.ts` — valid paths, traversal, encoded separators, null bytes, symlink escape, Windows-style rejection, edge cases.
- `tests/allowlist.test.ts` — exact match, wildcard semantics, case sensitivity, malformed-config fail-closed behavior, `**` bypass guard.
- `tests/orchestrator/session-registry.test.ts`, `tests/orchestrator/control-plane.test.ts`, `tests/server-per-session-allowlist.test.ts` — per-session allowlist + control-plane HTTP gate (Tier 1.3 / #56).

Run `npm test` inside the sbx sandbox (see [development](./development.md)) after any change under `src/security/` or `src/mcp-proxy/sanitizer.ts`.
