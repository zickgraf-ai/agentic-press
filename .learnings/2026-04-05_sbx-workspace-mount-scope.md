---
date: 2026-04-05
category: architecture
source: session-retro
confidence: high
---

## What happened

When running `sbx run claude` from a subdirectory (e.g., `/Users/jeff/code/claude-throttle`), the sandbox mounted the parent directory `/Users/jeff/code` as the workspace rather than the current directory. This means the agent has access to all sibling projects, not just the target project. The `shell` agent, by contrast, mounted the specified directory correctly.

## Root cause

sbx's `claude` agent template determines the workspace mount point, which may differ from what the shell agent does. The claude agent appears to walk up to find a git root or broader workspace context. This is by design for Claude Code's multi-project awareness, but has security implications for our sandbox isolation model.

## Rule

Be aware that `sbx claude` may mount a broader workspace than the directory you specify. Always verify the workspace path shown at sandbox startup ("Workspace: /path/to/dir") and consider the scoping implications for file access. For tighter isolation, use `sbx shell` with explicit workspace paths, or verify the mount with `sbx exec NAME bash -c 'echo $WORKSPACE_DIR'`.

## Evidence

- sbx verification session (Issue #1)
- `sbx ls` output showing workspace paths
- Environment variable `WORKSPACE_DIR` inside sandbox
