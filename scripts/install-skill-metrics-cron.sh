#!/usr/bin/env bash
# Install the launchd job for the weekly skill-usage metrics sweep
# (issue #55). Run this once after merging the trial PR.
#
# Idempotent: re-running unloads the existing job first, then reloads.
#
# Trial sunset: 2026-05-30. Uninstall with:
#   launchctl unload ~/Library/LaunchAgents/com.zickgraf.agentic-press.skill-metrics.plist
#   rm ~/Library/LaunchAgents/com.zickgraf.agentic-press.skill-metrics.plist

set -euo pipefail

LABEL="com.zickgraf.agentic-press.skill-metrics"
SOURCE_PLIST="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/${LABEL}.plist"
DEST_PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"

if [[ ! -f "$SOURCE_PLIST" ]]; then
  echo "error: source plist not found at $SOURCE_PLIST" >&2
  exit 1
fi

mkdir -p "${HOME}/Library/LaunchAgents"

# Unload any prior version (ignore errors — first run won't have one).
launchctl unload "$DEST_PLIST" 2>/dev/null || true

cp "$SOURCE_PLIST" "$DEST_PLIST"
launchctl load "$DEST_PLIST"

echo "✓ Loaded ${LABEL}"
echo
echo "Schedule: Mondays at 09:00 local time"
echo "Working directory: /Users/jeffzickgraf/Code/agentic-press"
echo "Logs: /tmp/agentic-press-skill-metrics.log"
echo
echo "Test immediately with:"
echo "  launchctl start ${LABEL}"
echo "  tail /tmp/agentic-press-skill-metrics.log"
echo
echo "Trial sunset 2026-05-30. Uninstall with:"
echo "  launchctl unload ${DEST_PLIST}"
echo "  rm ${DEST_PLIST}"
