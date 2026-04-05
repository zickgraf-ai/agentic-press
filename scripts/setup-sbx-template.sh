#!/usr/bin/env bash
set -euo pipefail

# Create a custom sbx template with MCP proxy pre-configured.
# sbx uses internal base images — we can't docker build from them.
# Instead: create a sandbox, configure it, snapshot it.
#
# Usage: ./scripts/setup-sbx-template.sh [proxy-url]

PROXY_URL="${1:-http://host.docker.internal:18923/mcp}"
TEMPLATE_NAME="agent-sandbox:v1"
SANDBOX_NAME="template-builder-$$"

echo "=== Creating sbx template: ${TEMPLATE_NAME} ==="
echo "Proxy URL: ${PROXY_URL}"

# 1. Create a fresh claude sandbox
sbx create --name "${SANDBOX_NAME}" claude .

# 2. Configure MCP proxy connection inside the sandbox
sbx exec "${SANDBOX_NAME}" bash -c \
  "claude mcp add --transport http --scope local agent-sandbox-proxy ${PROXY_URL}"

# 3. Snapshot as a reusable template
echo "Saving snapshot as ${TEMPLATE_NAME}..."
sbx save "${SANDBOX_NAME}" "${TEMPLATE_NAME}"

# 4. Clean up the builder sandbox
sbx stop "${SANDBOX_NAME}"
sbx rm "${SANDBOX_NAME}"

echo ""
echo "Template created: ${TEMPLATE_NAME}"
echo "Use with: sbx create -t ${TEMPLATE_NAME} claude ."
