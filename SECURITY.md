# Security Policy

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Report suspected vulnerabilities through GitHub Security Advisories:

> https://github.com/zickgraf-ai/agentic-press/security/advisories/new

Advisories are private until published. The maintainer will acknowledge receipt within 5 business days and coordinate disclosure timing with the reporter.

For non-vulnerability security concerns (defensive hardening suggestions, observed gaps in documentation, questions about the threat model), public issues are fine — see [`docs/security.md`](docs/security.md) for what is in and out of scope.

## Scope

In scope:

- The MCP proxy (`src/mcp-proxy/`)
- The injection patterns and path guard (`src/security/`)
- The stdio bridge (`src/mcp-proxy/stdio-bridge.ts`)
- The audit logging path
- Any sample script under `scripts/`

Out of scope (report upstream):

- Vulnerabilities in `sbx`, Docker, or any upstream MCP server implementation
- Vulnerabilities in third-party dependencies (use `npm audit` and report to the package maintainer)

## Supported Versions

Pre-1.0. Only the `main` branch is supported. Backports to tagged releases are evaluated case-by-case after a vulnerability is confirmed.

## Defense Boundary

agentic-press is one layer in a defense-in-depth strategy. The threat model, mitigations, and operator responsibilities are documented in [`docs/security.md`](docs/security.md). Read that document before reporting — issues already documented as out-of-scope operator responsibilities will be closed with a pointer back to the doc.
