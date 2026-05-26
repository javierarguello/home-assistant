#!/usr/bin/env bash
#
# Launcher used by the systemd service. Ensures Node 24 (via nvm if present) is
# on PATH, then starts the agent. Mode defaults to voice; override with HA_MODE.
#
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm use 24 >/dev/null 2>&1 || true
fi

cd "$REPO_ROOT"
exec npm run start --workspace apps/agent -- --mode="${HA_MODE:-voice}"
