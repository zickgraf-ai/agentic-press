---
date: 2026-04-05
category: architecture
source: session-retro
confidence: high
---

## What happened

We designed a `sbx/Dockerfile` and `scripts/setup-sbx-template.sh` assuming sbx consumed custom Dockerfiles via a `docker build` → `sbx template register` workflow. When we actually ran sbx v0.23.0, it only supports predefined agent types (claude, codex, copilot, docker-agent, gemini, kiro, opencode, shell). There is no `sbx template` subcommand. Custom templates are created by snapshotting a running sandbox with `sbx save`, not by building Dockerfiles.

## Root cause

We designed the architecture from prompt assumptions before verifying the actual CLI surface. The prompt specified `sbx create --template claude-code-docker` which doesn't exist. Step 1 (verify sbx works) caught this, but the Dockerfile and setup script had already been designed around the wrong model.

## Rule

Always verify sbx's actual behavior by running it before designing integration code. sbx is agent-specific, not a generic container runtime. Custom templates use `sbx save SANDBOX TAG` to snapshot, not `docker build`. The Dockerfile in `sbx/` is only for Phase 2 AWS headless mode where sbx isn't available.

## Evidence

- GitHub issue #1 (verify sbx CLI)
- sbx verification report in Obsidian
- PR #13 updated Dockerfile comments and setup script
