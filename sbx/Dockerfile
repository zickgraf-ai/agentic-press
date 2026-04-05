# NOTE: This Dockerfile is NOT used directly. sbx sandboxes use an internal
# base image (Ubuntu 25.10, Node 20, Python 3.13, Claude Code 2.1) that is
# not published to Docker Hub.
#
# To create a custom template for agent-sandbox:
#   1. sbx create --name base claude .
#   2. sbx exec base bash -c "claude mcp add --transport http --scope local agent-sandbox-proxy http://host.docker.internal:18923/mcp"
#   3. sbx save base agent-sandbox:v1
#   4. sbx stop base && sbx rm base
#   5. sbx create -t agent-sandbox:v1 claude .
#
# See scripts/setup-sbx-template.sh for the automated version.
#
# This Dockerfile exists only for the AWS headless mode (Phase 2), where
# sbx is not available and we run plain Docker containers on Fargate.

FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates git && \
    rm -rf /var/lib/apt/lists/*

# Phase 2: Add Node.js, Python, Claude Code installation here
