---
name: sandbox-operations
description: Docker Sandbox sbx commands, agent types, and network policies
---

## sbx Basics

sbx (Docker Sandbox) provides microVM-isolated sandbox environments for AI agents. Each sandbox gets its own Docker daemon, filesystem, and network.

### Available Agents
`claude`, `codex`, `copilot`, `docker-agent`, `gemini`, `kiro`, `opencode`, `shell`

### Key Commands
```bash
sbx run claude .                    # Create + start Claude Code sandbox in current dir
sbx run shell .                     # Plain shell sandbox
sbx create --name NAME claude .     # Create without starting
sbx exec -it NAME bash              # Shell into running sandbox
sbx exec -w /path NAME cmd          # Run command with explicit workdir
sbx exec -e KEY=VAL NAME cmd        # Inject env vars
sbx stop NAME && sbx rm NAME        # Clean up
sbx ls                              # List all sandboxes
sbx save NAME tag:version           # Snapshot as reusable template
sbx create -t tag:version claude .  # Use custom template
```

### Workspace Mounting
- Workspace mounts automatically from the path given to `sbx create/run`
- Inside sandbox: workspace at `/home/agent/workspace` (claude agent) or full host path via `-w`
- Direct mount — file changes are immediately visible both directions

### Network Policies
```bash
sbx policy set-default balanced     # Options: allow-all, balanced, deny-all
sbx policy allow network "host.docker.internal:18923"  # Allow specific host:port
sbx policy deny network "evil.com:443"                 # Block specific host
sbx policy ls                       # List all policies
sbx policy rm network --resource "host.docker.internal:18923"  # Remove policy
```
Default `balanced` allows AI services, package managers, code repos, cloud infra.

### Secrets
```bash
sbx secret set -g github            # Store GitHub token globally
sbx secret set -g anthropic         # Store Anthropic key globally
sbx secret ls                       # List stored secrets
```
Secrets are proxied — never exposed directly to the agent inside the sandbox.

### Template System
sbx does NOT consume devcontainer.json. It has its own internal base images (Ubuntu 25.10, Node 20, Python 3.13, Claude Code 2.1 as of v0.23.0). Custom templates are created by snapshotting a configured sandbox with `sbx save`.

### Platform Support
- macOS Apple Silicon: supported
- Windows 11: supported
- Linux: **NOT supported** (AWS mode uses plain Docker + iptables instead)

### Important Notes
- Sandboxes persist after agent exits — always `sbx stop` + `sbx rm` to clean up
- Claude Code runs in `bypassPermissions` mode inside sandboxes by default
- All traffic proxied through `gateway.docker.internal:3128` for policy enforcement
- `host.docker.internal` resolves to host — used for MCP proxy connectivity
- Git credentials need `sbx secret set -g github` for push from inside sandbox
