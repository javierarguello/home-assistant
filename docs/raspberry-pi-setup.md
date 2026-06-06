# Raspberry Pi 5 setup

Target: Raspberry Pi OS (64-bit), Pi 5 with 8 GB recommended, a USB mic/speaker
(or HAT), and the official touchscreen.

## Quick setup (scripted)

One idempotent script installs everything (system packages, Node 24, whisper.cpp +
model, Piper + voice, npm deps, wake-word deps) and writes the paths into `.env`.
Re-run it anytime to add what's missing.

```bash
git clone https://github.com/javierarguello/home-assistant.git
cd home-assistant
npm run setup                 # = bash scripts/setup-pi.sh
# then set your LLM in .env (local Ollama is default) and PICOVOICE_ACCESS_KEY
npm run chat                  # smoke-test the brain (text only)
bash scripts/install-service.sh   # optional: run on boot (systemd)
```

The sections below explain each piece (and how to do it manually).

## 1. Node 24

ADK needs Node 24+. With nvm:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 24 && nvm use 24
```

## 2. Clone + install

```bash
git clone https://github.com/javierarguello/home-assistant.git
cd home-assistant
npm install
cp .env.example .env
```

## 3. LLM (local with Ollama)

Ollama already exposes an OpenAI-compatible API, so the defaults in `.env` work:

```bash
ollama pull llama3.2:3b          # or qwen2.5:3b — efficient on the Pi 5
# .env: LLM_BASE_URL=http://localhost:11434/v1  LLM_API_KEY=ollama  LLM_MODEL=llama3.2:3b
```

Prefer snappier responses? Point any agent at a cloud model in `.env` (Gemini
Flash-Lite is cheap) — see Profile B in `.env.example`. You can keep the root
agent local and only the `web_search` agent in the cloud.

Smoke-test the brain (no audio needed):

```bash
npm run chat
```

## 4. Speech (voice mode)

### Wake word — openWakeWord (local, no key)

`npm run setup` installs it (a Python venv at `vendor/wakeword-venv` + base
models). It runs as a side-car that owns the mic — fully offline, no API key.

```bash
# Manual:
sudo apt install -y libportaudio2 portaudio19-dev   # mic capture (Linux)
python3 -m venv vendor/wakeword-venv
vendor/wakeword-venv/bin/pip install openwakeword sounddevice numpy
vendor/wakeword-venv/bin/python -c "import openwakeword.utils as u; u.download_models()"
# .env: WAKE_WORD_ENGINE=openwakeword   WAKE_WORD=hey_jarvis
#       (models: hey_jarvis, alexa, hey_mycroft, hey_rhasspy… or a custom .onnx)
```

Point `WAKE_WORD` at a built-in name (`hey_jarvis`, `alexa`, `hey_mycroft`,
`hey_rhasspy`) or an absolute path to a custom `.onnx`. To switch wake words or
train your own (incl. Spanish), see **[wake-word.md](wake-word.md)**.

> Porcupine is still available as an alternative (`WAKE_WORD_ENGINE=porcupine`,
> needs `PICOVOICE_ACCESS_KEY` + periodic internet). openWakeWord is the default
> because it's 100% local with no key.

### STT — whisper.cpp (local, offline)

Runs as a subprocess: the pipeline records your phrase to a 16 kHz mono WAV and
calls `whisper-cli -m <model> -f <wav> -l es -t 4`.

```bash
sudo apt install -y build-essential cmake
git clone https://github.com/ggml-org/whisper.cpp && cd whisper.cpp
cmake -B build && cmake --build build -j --config Release
# Multilingual model (NOT *.en) since the assistant speaks Spanish:
bash ./models/download-ggml-model.sh base       # or tiny (faster) / small (more accurate)
# .env: STT_PROVIDER=whisper-local
#       WHISPER_BINARY=/home/pi/whisper.cpp/build/bin/whisper-cli
#       WHISPER_MODEL=/home/pi/whisper.cpp/models/ggml-base.bin
#       WHISPER_THREADS=4
```

Performance on the Pi 5 (8 GB), short phrases (~3–6 s):

| Model | Size | Speed | Notes |
|-------|------|-------|-------|
| `tiny` | ~75 MB | fastest, ~real-time or better | snappy; lower accuracy |
| `base` | ~142 MB | ≈ real-time | **recommended balance** |
| `small` | ~466 MB | ~2–3× slower | best accuracy, more latency |

Test it without a microphone (transcribe any 16 kHz mono WAV):

```bash
npm run stt --workspace apps/agent -- /path/to/phrase.wav
```

### TTS — Piper (local)

`npm run setup` installs Piper in a venv and downloads a voice. Manually:

```bash
python3 -m venv vendor/piper-venv
vendor/piper-venv/bin/pip install piper-tts
# Download a Spanish voice via curl (piper.download_voices trips on macOS SSL):
V=es_MX-ald-medium
B=https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_MX/ald/medium
curl -fsSL -o voices/$V.onnx      "$B/$V.onnx"
curl -fsSL -o voices/$V.onnx.json "$B/$V.onnx.json"
# .env: TTS_PROVIDER=piper  PIPER_BINARY=vendor/piper-venv/bin/piper  PIPER_VOICE=voices/es_MX-ald-medium.onnx
```

Test STT and TTS in isolation (no mic/wake word needed):

```bash
npm run stt --workspace apps/agent -- audio.wav      # WAV -> text
npm run tts --workspace apps/agent -- "Hola, ¿qué tal?"  # text -> speech (plays audio)
```

### Audio devices

```bash
arecord -l   # find your mic; set the default in ~/.asoundrc if needed
aplay  -l    # find your speaker
# .env: AUDIO_PLAYER=aplay
```

Run the full voice loop:

```bash
npm run dev:agent -- --mode=voice
```

## 5. Kiosk on the touchscreen

```bash
npm run build --workspace apps/kiosk
npm run preview --workspace apps/kiosk    # serves on http://localhost:5173
```

Launch Chromium fullscreen pointing at it (the `--autoplay-policy` flag lets the
kiosk play its listening chimes without a tap):

```bash
chromium-browser --kiosk --noerrdialogs --disable-infobars \
  --autoplay-policy=no-user-gesture-required http://localhost:5173
```

Run the kiosk browser from the desktop autostart (`~/.config/autostart/`) or a
second service that waits for the graphical session.

## 6. Run on boot (systemd services)

`scripts/install-service.sh` installs two **user** services — `home-assistant-whisper`
(STT server, model kept warm) and `home-assistant-agent` (voice loop) — enables
them, and turns on lingering so they start at boot without a login:

```bash
bash scripts/install-service.sh
```

The agent service reads `.env`, restarts on failure, and runs `scripts/run-agent.sh`
(which loads Node 24 via nvm). It's generated from the paths in your `.env`, so
re-run the installer after changing those.

## 7. Operations (deploy / live / stop / logs)

```bash
# Update + keep running as a service (git pull → setup → install services → restart)
npm run deploy

# Run LIVE in the foreground to diagnose (stops the service, streams all logs)
npm run live            # voice mode
npm run live -- chat    # text mode

# Stop everything (services + stray agent/whisper/kiosk processes)
npm run stop
```

**Logs** (always written, even under systemd):

```bash
tail -f logs/agent.log                            # app diagnostics (state, STT, tools, errors)
tail -f logs/whisper-server.log                   # whisper.cpp server output
journalctl --user -u home-assistant-agent -f      # service stdout/stderr
```

Tune verbosity with `LOG_LEVEL=debug` and mirror everything to the console with
`LOG_CONSOLE=true` (what `npm run live` sets).

## 8. This Pi (deployment specifics)

The live device:

- **Host:** `raspberry.local` (ARM64 / Raspberry Pi). SSH as the `claude` user
  (`ssh claude@raspberry.local`), which has a key configured.
- **Repo:** checked out at **`/srv/home-assistant`** (a shared location, writable
  by all users — not under a single home dir).
- **LLM:** Google Gemini via its OpenAI-compatible endpoint —
  `LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/`,
  `LLM_MODEL=gemini-2.5-flash-lite`, with `LLM_API_KEY` set (static key).
- **Services:** user systemd units (`home-assistant-agent`, `home-assistant-whisper`);
  manage with `systemctl --user …`.

### Deploying an update

Run on the Pi (or over SSH). Full path (rebuilds deps/whisper, idempotent):

```bash
ssh claude@raspberry.local 'cd /srv/home-assistant && npm run deploy'
```

**Light deploy** when only app code changed (no new npm deps, no native rebuild):
the agent runs via `tsx` and consumes `@home-assistant/shared` as source, so no
build step is needed — just pull and restart:

```bash
ssh claude@raspberry.local '
  cd /srv/home-assistant && git pull --ff-only &&
  systemctl --user restart home-assistant-agent.service'
```

> `.env` is gitignored, so a pull never changes it. After enabling a feature in
> code, add its env vars to the Pi's `.env` by hand (see below) before restarting.

### Env vars to enable background tasks here

`WORKER_*` fall back to `LLM_*`, so the cheap default is already Gemini Flash-Lite.
Set a stronger model for the analysis/research escalations and turn tasks on:

```bash
TASKS_ENABLED=true
WORKER_ANALYSIS_MODEL=<a stronger Gemini, e.g. gemini-2.5-pro>
WORKER_RESEARCH_MODEL=<a stronger Gemini, e.g. gemini-2.5-pro>
# GitHub worker (optional): needs its own token
# ENABLE_GITHUB=true
# GITHUB_TOKEN=ghp_...
```

Research's web search reuses the existing `TAVILY_API_KEY`. See
[background-tasks.md](background-tasks.md) for the full feature + config.
