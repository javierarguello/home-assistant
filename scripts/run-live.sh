#!/usr/bin/env bash
#
# Run the agent LIVE in the foreground for diagnosis (not as a service).
# Streams all logs to the console (LOG_CONSOLE=true, debug level) and still
# writes them to logs/agent.log. Stops the background agent service first so it
# doesn't fight over the microphone.
#
#   npm run live            # voice mode (mic + wake word)
#   npm run live -- chat    # text REPL
#
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Live mode runs its OWN whisper-server (not the systemd service), so it behaves
# identically on a Mac dev box and on the Pi. Stop both background services.
if command -v systemctl >/dev/null 2>&1; then
  systemctl --user stop home-assistant-agent.service 2>/dev/null && echo "(stopped agent service)"
  systemctl --user stop home-assistant-whisper.service 2>/dev/null && echo "(stopped whisper service)"
fi

export LOG_CONSOLE=true
export LOG_LEVEL="${LOG_LEVEL:-debug}"
export WHISPER_SERVER_AUTOSTART=true   # the agent starts/owns whisper-server itself

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"; nvm use 24 >/dev/null 2>&1 || true
fi

MODE="${1:-voice}"
echo "Running LIVE (mode=$MODE) — Ctrl+C to stop. Logs also in logs/agent.log"
exec npm run start --workspace apps/agent -- --mode="$MODE"
