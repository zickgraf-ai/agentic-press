#!/usr/bin/env bash
set -euo pipefail

# Build and register custom sbx template
# Usage: ./scripts/setup-sbx-template.sh

echo "Building agent-sandbox template..."
docker build -t agent-sandbox:latest sbx/
echo "Template built: agent-sandbox:latest"
echo "Use with: sbx create -t agent-sandbox:latest claude ."
