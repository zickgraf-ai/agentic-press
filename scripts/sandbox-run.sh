#!/usr/bin/env bash
set -euo pipefail

# Integration test: full sandbox + MCP proxy loop
# Usage: ./scripts/sandbox-run.sh [task description]

TASK="${1:-list the files in the workspace and describe the project structure}"
SANDBOX_NAME="integration-test-$$"
PROXY_PORT="${MCP_PROXY_PORT:-18923}"

echo "=== agent-sandbox integration test ==="
echo "Task: $TASK"
echo "Sandbox: $SANDBOX_NAME"
echo "Proxy port: $PROXY_PORT"
echo ""

# TODO: Implement in Issue #8
echo "ERROR: Not yet implemented. See Issue #8."
exit 1
