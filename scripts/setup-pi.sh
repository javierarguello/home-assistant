#!/usr/bin/env bash
#
# Idempotent setup for running home-assistant on a Raspberry Pi 5 (or a Linux/
# macOS dev box). Safe to run repeatedly: every step checks what already exists
# and only installs what's missing.
#
#   bash scripts/setup-pi.sh
#
# Override defaults with env vars, e.g.:
#   WHISPER_MODEL_NAME=small PIPER_VOICE_NAME=es_ES-davefx-medium bash scripts/setup-pi.sh
#
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

WHISPER_DIR="$REPO_ROOT/vendor/whisper.cpp"
WHISPER_MODEL_NAME="${WHISPER_MODEL_NAME:-base}"          # tiny | base | small
WHISPER_MODEL="$REPO_ROOT/models/ggml-${WHISPER_MODEL_NAME}.bin"
PIPER_VENV="$REPO_ROOT/vendor/piper-venv"
PIPER_BIN="$PIPER_VENV/bin/piper"
PIPER_VOICE_NAME="${PIPER_VOICE_NAME:-es_MX-ald-medium}"
PIPER_VOICE="$REPO_ROOT/voices/${PIPER_VOICE_NAME}.onnx"
WW_VENV="$REPO_ROOT/vendor/wakeword-venv"
WAKE_WORD_MODEL="${WAKE_WORD_MODEL:-hey_jarvis}"
OLLAMA_MODEL="${OLLAMA_MODEL:-llama3.2:3b}"

log()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '    \033[0;32m✓\033[0m %s\n' "$*"; }
warn() { printf '    \033[0;33m!\033[0m %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# Download a Piper voice (<name>.onnx + .json) via curl — robust on Mac & Pi,
# unlike piper.download_voices (which trips on macOS Python SSL certs).
# name like es_MX-ald-medium -> es/es_MX/ald/medium/es_MX-ald-medium.onnx
download_piper_voice() {
  local name="$1" dir="$2"
  local region="${name%%-*}"      # es_MX
  local rest="${name#*-}"         # ald-medium
  local voice="${rest%%-*}"       # ald
  local quality="${rest#*-}"      # medium
  local lang="${region%%_*}"      # es
  local base="https://huggingface.co/rhasspy/piper-voices/resolve/main/${lang}/${region}/${voice}/${quality}"
  curl -fsSL -o "$dir/${name}.onnx" "$base/${name}.onnx" &&
    curl -fsSL -o "$dir/${name}.onnx.json" "$base/${name}.onnx.json"
}

# Idempotently set KEY=VALUE in .env (replace existing or append).
set_env() {
  local key="$1" val="$2" file="$REPO_ROOT/.env"
  touch "$file"
  if grep -qE "^${key}=" "$file"; then
    sed -i.bak "s|^${key}=.*|${key}=${val}|" "$file" && rm -f "$file.bak"
  else
    echo "${key}=${val}" >> "$file"
  fi
}

# ---------------------------------------------------------------------------
log "1/8  System packages"
if [ "$(uname)" = "Linux" ] && have apt-get; then
  sudo apt-get update -y
  sudo apt-get install -y build-essential cmake git curl ffmpeg sox alsa-utils \
    python3 python3-venv python3-pip libportaudio2 portaudio19-dev
  ok "apt packages installed"
elif [ "$(uname)" = "Darwin" ]; then
  have cmake || { have brew && brew install cmake; }
  have brew && brew list portaudio >/dev/null 2>&1 || { have brew && brew install portaudio; }
  ok "macOS build tools ready"
else
  warn "Unknown platform — install build-essential, cmake, portaudio, alsa-utils manually"
fi

# ---------------------------------------------------------------------------
log "2/8  Node.js 24+"
node_major() { node -v 2>/dev/null | sed 's/v\([0-9]*\).*/\1/'; }
if ! have node || [ "$(node_major)" -lt 24 ]; then
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] || curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm install 24 && nvm use 24
fi
ok "node $(node -v)"

# ---------------------------------------------------------------------------
log "3/8  npm dependencies"
npm install
ok "workspaces installed"

# ---------------------------------------------------------------------------
log "4/8  Wake word (openWakeWord — local, no API key)"
if [ ! -x "$WW_VENV/bin/python" ]; then
  python3 -m venv "$WW_VENV"
  "$WW_VENV/bin/pip" install --quiet --upgrade pip certifi openwakeword sounddevice numpy \
    || warn "openWakeWord pip install failed"
fi
if [ -x "$WW_VENV/bin/python" ]; then
  # Pre-download the base models once (certifi fixes macOS Python SSL).
  SSL_CERT_FILE="$("$WW_VENV/bin/python" -m certifi 2>/dev/null)" \
    "$WW_VENV/bin/python" -c "import openwakeword.utils as u; u.download_models()" >/dev/null 2>&1 \
    && ok "openWakeWord installed + models ready" \
    || warn "openWakeWord models not pre-downloaded (will fetch at first run)"
fi

# ---------------------------------------------------------------------------
log "5/8  whisper.cpp (local STT)"
if [ ! -d "$WHISPER_DIR/.git" ]; then
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp "$WHISPER_DIR"
else
  git -C "$WHISPER_DIR" pull --ff-only || warn "could not update whisper.cpp"
fi
if [ ! -x "$WHISPER_DIR/build/bin/whisper-server" ]; then
  cmake -S "$WHISPER_DIR" -B "$WHISPER_DIR/build" -DCMAKE_BUILD_TYPE=Release
  cmake --build "$WHISPER_DIR/build" -j --config Release
fi
ok "whisper-server built"
mkdir -p "$REPO_ROOT/models"
if [ ! -f "$WHISPER_MODEL" ]; then
  bash "$WHISPER_DIR/models/download-ggml-model.sh" "$WHISPER_MODEL_NAME" "$REPO_ROOT/models" \
    || bash "$WHISPER_DIR/models/download-ggml-model.sh" "$WHISPER_MODEL_NAME"
  # If it landed in the whisper.cpp models dir, move it next to ours.
  [ -f "$WHISPER_MODEL" ] || mv "$WHISPER_DIR/models/ggml-${WHISPER_MODEL_NAME}.bin" "$WHISPER_MODEL" 2>/dev/null || true
fi
[ -f "$WHISPER_MODEL" ] && ok "model: ggml-${WHISPER_MODEL_NAME}.bin" || warn "model download failed"

# ---------------------------------------------------------------------------
log "6/8  Piper (local TTS)"
if [ ! -x "$PIPER_BIN" ]; then
  python3 -m venv "$PIPER_VENV"
  "$PIPER_VENV/bin/pip" install --quiet --upgrade pip piper-tts || warn "piper-tts pip install failed"
fi
mkdir -p "$REPO_ROOT/voices"
if [ ! -f "$PIPER_VOICE" ]; then
  download_piper_voice "$PIPER_VOICE_NAME" "$REPO_ROOT/voices" \
    || warn "Piper voice download failed (check PIPER_VOICE_NAME / network)"
fi
[ -f "$PIPER_VOICE" ] && ok "voice: ${PIPER_VOICE_NAME}.onnx" || warn "no Piper voice yet"

# ---------------------------------------------------------------------------
log "7/8  Ollama (local LLM, optional)"
if have ollama; then
  if ollama list 2>/dev/null | tail -n +2 | grep -q .; then
    ok "ollama present with models"
  else
    ollama pull "$OLLAMA_MODEL" && ok "pulled $OLLAMA_MODEL" || warn "could not pull $OLLAMA_MODEL"
  fi
else
  warn "ollama not found — install from https://ollama.com for a fully-local LLM"
fi

# ---------------------------------------------------------------------------
log "8/8  .env"
[ -f .env ] || { cp .env.example .env && ok "created .env from .env.example"; }
set_env STT_PROVIDER whisper-server
set_env WHISPER_SERVER_BINARY "$WHISPER_DIR/build/bin/whisper-server"
set_env WHISPER_BINARY "$WHISPER_DIR/build/bin/whisper-cli"
set_env WHISPER_MODEL "$WHISPER_MODEL"
set_env WHISPER_THREADS 4
set_env TTS_PROVIDER piper
set_env PIPER_BINARY "$PIPER_BIN"
set_env PIPER_VOICE "$PIPER_VOICE"
set_env WAKE_WORD_ENGINE openwakeword
set_env WAKE_WORD "$WAKE_WORD_MODEL"
set_env WAKEWORD_PYTHON "$WW_VENV/bin/python"
set_env WAKEWORD_SCRIPT "$REPO_ROOT/apps/agent/python/wakeword_runner.py"
ok "STT/TTS/wake-word paths written to .env"

cat <<EOF

$(printf '\033[1;32mSetup complete.\033[0m')

Next:
  • Set your LLM in .env (local Ollama is the default; Gemini/Vertex profiles are
    documented in .env.example).
  • Wake word is openWakeWord (local, no key). Default '$WAKE_WORD_MODEL';
    change WAKE_WORD in .env (e.g. alexa, hey_mycroft) or point it at a custom model.

Test:
  npm run chat                                  # text only
  npm run stt --workspace apps/agent -- file.wav  # STT (auto-starts whisper-server)
  npm run dev:agent -- --mode=voice             # full voice loop

Run on boot (systemd):
  bash scripts/install-service.sh               # starts agent + whisper at boot
EOF
