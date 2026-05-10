#!/usr/bin/env bash
# Install the launchd job for the weekly skill-usage metrics sweep.
# Reads the plist template, substitutes the host's actual paths
# (primary git worktree, npm binary, log directory), writes the result
# to ~/Library/LaunchAgents/, and loads it.
#
# Run this once after merging the trial PR.
#
# Idempotent: re-running unloads the existing job first, then reloads.
#
# Decision date documented in src/improvements/skill-usage-report.ts:TRIAL_END_DATE.
# Uninstall with:
#   launchctl unload ~/Library/LaunchAgents/com.zickgraf.agentic-press.skill-metrics.plist
#   rm ~/Library/LaunchAgents/com.zickgraf.agentic-press.skill-metrics.plist

set -euo pipefail

LABEL="com.zickgraf.agentic-press.skill-metrics"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="${SCRIPT_DIR}/${LABEL}.plist.template"
DEST_PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG_PATH="${HOME}/Library/Logs/agentic-press-skill-metrics.log"

if [[ ! -f "$TEMPLATE" ]]; then
  echo "error: template not found at $TEMPLATE" >&2
  exit 1
fi

# Find the primary git worktree, not the worktree the installer was run from.
# After merging the trial PR you'll typically run this from the main checkout,
# but `git worktree list` makes the choice explicit either way.
if ! command -v git >/dev/null 2>&1; then
  echo "error: git not found in PATH" >&2
  exit 1
fi
PRIMARY_WORKTREE="$(git worktree list | head -1 | awk '{print $1}')"
if [[ -z "$PRIMARY_WORKTREE" || ! -d "$PRIMARY_WORKTREE" ]]; then
  echo "error: could not determine primary git worktree from `git worktree list`" >&2
  exit 1
fi

NPM_PATH="$(command -v npm || true)"
if [[ -z "$NPM_PATH" ]]; then
  echo "error: npm not found in PATH" >&2
  exit 1
fi

# launchd doesn't inherit the user shell PATH; pass it explicitly.
LAUNCHD_PATH="$(dirname "$NPM_PATH"):/usr/local/bin:/usr/bin:/bin"

mkdir -p "${HOME}/Library/LaunchAgents" "${HOME}/Library/Logs"

# Substitute placeholders. The template uses {{NAME}} markers so the source
# file is plist-valid on its own (won't be mistakenly loaded by launchd).
sed \
  -e "s|{{WORKING_DIR}}|${PRIMARY_WORKTREE}|g" \
  -e "s|{{NPM_PATH}}|${NPM_PATH}|g" \
  -e "s|{{PATH}}|${LAUNCHD_PATH}|g" \
  -e "s|{{LOG_PATH}}|${LOG_PATH}|g" \
  "$TEMPLATE" > "$DEST_PLIST"

# Validate the rendered plist before loading.
if ! plutil -lint "$DEST_PLIST" >/dev/null; then
  echo "error: rendered plist failed plutil -lint" >&2
  echo "        rendered file: $DEST_PLIST" >&2
  exit 1
fi

# Unload any prior version (ignore errors — first run won't have one).
launchctl unload "$DEST_PLIST" 2>/dev/null || true
launchctl load "$DEST_PLIST"

cat <<EOF
✓ Loaded ${LABEL}

  Working directory: ${PRIMARY_WORKTREE}
  npm path:          ${NPM_PATH}
  Schedule:          Mondays at 09:00 local time
  Logs:              ${LOG_PATH}

Test immediately with:
  launchctl start ${LABEL}
  tail ${LOG_PATH}

Uninstall with:
  launchctl unload ${DEST_PLIST}
  rm ${DEST_PLIST}

Decision date documented in src/improvements/skill-usage-report.ts:TRIAL_END_DATE.
EOF
