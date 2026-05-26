#!/usr/bin/env bash
#
# Stop everything: systemd services (if installed) and any stray processes
# (agent, whisper-server, kiosk browser, vite). Safe to run anytime.
#
#   bash scripts/stop.sh      (or:  npm run stop)
#
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "Stopping home-assistant…"

# 1. systemd user services first, so Restart= doesn't respawn them.
if command -v systemctl >/dev/null 2>&1; then
  for unit in home-assistant-agent home-assistant-whisper; do
    if systemctl --user cat "$unit.service" >/dev/null 2>&1; then
      systemctl --user stop "$unit.service" 2>/dev/null && echo "  stopped service: $unit"
    fi
  done
fi

# 2. Stray processes (dev runs, autostarted whisper-server, kiosk).
stop_pat() {
  local label="$1" pat="$2"
  local pids
  pids="$(pgrep -f "$pat" 2>/dev/null | grep -vw "$$" | tr '\n' ' ')"
  if [ -n "${pids// /}" ]; then
    echo "  killing $label ($pids)"
    pkill -TERM -f "$pat" 2>/dev/null || true
    pkill -KILL -f "$pat" 2>/dev/null || true
  fi
}

# Match the agent by its tsx entrypoint (cmdline is `… tsx src/index.ts`, run
# with cwd=apps/agent, so the path is relative). Match the kiosk by the repo's
# vite binary path. Patterns must match the actual argv, not the working dir.
stop_pat "agent"          "tsx src/index.ts"
stop_pat "agent launcher" "scripts/run-agent.sh"
stop_pat "wakeword side-car" "wakeword_runner.py"
stop_pat "whisper-server" "whisper-server"
stop_pat "kiosk (vite)"   "$REPO_ROOT/node_modules/.bin/vite"
stop_pat "kiosk (browser)" "chromium.*--kiosk"

echo "Done."
