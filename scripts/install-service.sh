#!/usr/bin/env bash
#
# Install home-assistant as systemd *user* services so it starts on boot and
# restarts on failure. Idempotent: re-run to update the units.
#
#   bash scripts/install-service.sh
#
# Installs two services:
#   home-assistant-whisper   the whisper.cpp STT server (keeps the model warm)
#   home-assistant-agent     the voice agent (depends on whisper)
#
set -euo pipefail

if [ "$(uname)" != "Linux" ] || ! command -v systemctl >/dev/null 2>&1; then
  echo "This installer targets Linux with systemd (the Raspberry Pi)." >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"

get_env() { grep -E "^$1=" "$REPO_ROOT/.env" 2>/dev/null | tail -1 | cut -d= -f2-; }

WHISPER_SERVER_BINARY="$(get_env WHISPER_SERVER_BINARY)"
WHISPER_MODEL="$(get_env WHISPER_MODEL)"
WHISPER_THREADS="$(get_env WHISPER_THREADS)"; WHISPER_THREADS="${WHISPER_THREADS:-4}"
LANG_CODE="$(get_env ASSISTANT_LANGUAGE)"; LANG_CODE="${LANG_CODE:-es}"
PORT="$(get_env WHISPER_SERVER_URL | sed -E 's|.*:([0-9]+).*|\1|')"; PORT="${PORT:-8088}"

WANTS_WHISPER=""
if [ -n "$WHISPER_SERVER_BINARY" ] && [ -x "$WHISPER_SERVER_BINARY" ]; then
  WANTS_WHISPER="home-assistant-whisper.service"
  cat > "$UNIT_DIR/home-assistant-whisper.service" <<EOF
[Unit]
Description=home-assistant whisper.cpp STT server
After=network.target

[Service]
ExecStart=$WHISPER_SERVER_BINARY -m $WHISPER_MODEL --host 127.0.0.1 --port $PORT -l $LANG_CODE -t $WHISPER_THREADS -nt
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
  echo "wrote home-assistant-whisper.service"
else
  echo "note: WHISPER_SERVER_BINARY not set/executable in .env — skipping whisper service"
  echo "      (the agent will still auto-start whisper-server itself)"
fi

cat > "$UNIT_DIR/home-assistant-agent.service" <<EOF
[Unit]
Description=home-assistant voice agent
After=network-online.target $WANTS_WHISPER
Wants=network-online.target $WANTS_WHISPER

[Service]
WorkingDirectory=$REPO_ROOT
EnvironmentFile=$REPO_ROOT/.env
ExecStart=$REPO_ROOT/scripts/run-agent.sh
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
echo "wrote home-assistant-agent.service"

systemctl --user daemon-reload
[ -n "$WANTS_WHISPER" ] && systemctl --user enable --now home-assistant-whisper.service
systemctl --user enable --now home-assistant-agent.service

# Start user services at boot without an interactive login.
loginctl enable-linger "$USER" 2>/dev/null || sudo loginctl enable-linger "$USER" || \
  echo "warn: could not enable linger; services may only start after login"

cat <<EOF

Installed. Useful commands:
  systemctl --user status home-assistant-agent
  systemctl --user restart home-assistant-agent
  journalctl --user -u home-assistant-agent -f      # service stdout/stderr
  tail -f $REPO_ROOT/logs/agent.log                 # app diagnostics log
EOF
