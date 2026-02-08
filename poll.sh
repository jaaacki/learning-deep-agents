#!/usr/bin/env bash
# poll.sh -- Cron-friendly wrapper for the Deep Agents poller
# Usage: */15 * * * * /path/to/deepagents/poll.sh

set -euo pipefail

# Change to project directory (where config.json and node_modules live)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Ensure node/pnpm are on PATH when running under cron
# Uncomment the appropriate line for your setup:
# export PATH="/usr/local/bin:$PATH"                       # Homebrew (Intel Mac)
# export PATH="/opt/homebrew/bin:$PATH"                    # Homebrew (Apple Silicon)
# export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"  # nvm

# Log file for debugging cron issues
LOG_FILE="./poll.log"

# Lock file to prevent overlapping cron runs.
# Uses mkdir (atomic on all filesystems) instead of a PID file.
LOCK_DIR="./poll.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "=== Poll SKIPPED at $(date -u +"%Y-%m-%dT%H:%M:%SZ") -- previous run still active ===" >> "$LOG_FILE"
  exit 0
fi
trap 'rmdir "$LOCK_DIR"' EXIT

echo "=== Poll started at $(date -u +"%Y-%m-%dT%H:%M:%SZ") ===" >> "$LOG_FILE"

# Run the agent
pnpm start >> "$LOG_FILE" 2>&1
EXIT_CODE=$?

echo "=== Poll finished at $(date -u +"%Y-%m-%dT%H:%M:%SZ") (exit: $EXIT_CODE) ===" >> "$LOG_FILE"
echo "" >> "$LOG_FILE"

exit $EXIT_CODE
