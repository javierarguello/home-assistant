#!/usr/bin/env bash
#
# One-command deploy/update for the Raspberry Pi:
#   1. git pull            (latest code)
#   2. scripts/setup-pi.sh (install/update deps, whisper, piper, models — idempotent)
#   3. install + (re)start the systemd services so it always runs on boot
#
# First time or every update, just run:   npm run deploy
#
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> 1/3  git pull"
git pull --ff-only || echo "    warn: git pull failed; continuing with current checkout"

echo "==> 2/3  setup (idempotent install/update)"
bash scripts/setup-pi.sh

if [ "$(uname)" = "Linux" ] && command -v systemctl >/dev/null 2>&1; then
  echo "==> 3/3  systemd services"
  bash scripts/install-service.sh
  # enable --now won't restart already-running units, so restart to pick up new code.
  systemctl --user restart home-assistant-whisper.service 2>/dev/null || true
  systemctl --user restart home-assistant-agent.service 2>/dev/null || true
  cat <<EOF

Deployed and running as a service.
  systemctl --user status home-assistant-agent
  tail -f $REPO_ROOT/logs/agent.log
  npm run stop        # stop everything
EOF
else
  cat <<EOF

==> 3/3  services skipped (no systemd — this is a macOS/dev box)
Updated. There are no background services here; run it in the foreground:
  npm run live           # voice (live logs)
  npm run live -- chat   # text
  npm run stop           # kill any stray agent/whisper/kiosk processes
EOF
fi
