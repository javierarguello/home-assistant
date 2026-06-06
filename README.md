# home-assistant

A personal **voice assistant** built to run on a **Raspberry Pi 5**, with models
that can be **local or cloud, configurable per agent via `.env`**. Node + TypeScript +
[Google ADK](https://google.github.io/adk-docs/).

Voice loop: **wake word → speech-to-text → agent (tools + sub-agents) → text-to-speech**,
with a **kiosk web UI** for a touchscreen that shows whether the assistant is
listening, thinking, or speaking.

```
                ┌──────────────────────── apps/agent (Node + ADK) ─────────────────────────┐
 mic ──▶ wake word + record ──────────────▶ STT ──▶  root agent ──▶ web_search tool
 (openWakeWord side-car, local)            (whisper   │ (ADK)
                                            / cloud)   │
 speaker ◀── player ◀── TTS ◀───────────────────┘            every LLM call goes through
            (aplay)    (Piper / cloud)                       OpenAiCompatibleLlm → any
                                  │                          OpenAI-compatible endpoint
                                  ▼                          (Ollama / Gemini / Vertex / OpenAI…)
                          WebSocket (state + transcript)
                                  │
                                  ▼
                       apps/kiosk (React, fullscreen) ── touchscreen
```

## Why a custom LLM connector?

The official `@google/adk` for TypeScript only ships **Gemini** and **Apigee**
model connectors — it has **no OpenAI/LiteLLM connector** (unlike the Python ADK).
So to talk to **Ollama** (local) or any **OpenAI-compatible** cloud, this repo adds
one small adapter, [`OpenAiCompatibleLlm`](apps/agent/src/llm/openai-compatible-llm.ts),
that translates ADK's `@google/genai` request/response types to/from the OpenAI
wire format. Every agent picks its model (local or cloud) independently via env.

## Quick start

> Requires **Node 24+** (recommended by ADK). Use `nvm use` (see `.nvmrc`).

```bash
npm install
cp .env.example .env        # then edit .env

# Fastest way to test end-to-end (no GPU, no local model): use a cheap cloud
# Gemini model. Two options in .env.example:
#   Profile B — Gemini via an AI Studio API key
#   Profile D — Vertex AI via your gcloud login (no static key; LLM_AUTH=gcloud)

npm run chat                # headless text REPL — exercises agents + tools
npm run dev:kiosk           # the touchscreen UI at http://localhost:5173
```

`npm run chat` and the kiosk both talk to the same agent over a WebSocket, so you
can develop the whole brain **without any microphone or speakers**.

When you're on the Pi with audio hardware configured (Fase 1), run the full voice
loop with `npm run dev:agent -- --mode=voice`.

## Configuration model

Everything that differs between machines lives in `.env` (see `.env.example`):

| What | Env | Local default | Cloud option |
|------|-----|---------------|--------------|
| LLM (per agent) | `LLM_*`, `ROOT_*`, `WEB_SEARCH_*` | Ollama `http://localhost:11434/v1` | Gemini / Vertex (gcloud) / OpenAI / any OpenAI-compatible |
| Speech-to-text | `STT_PROVIDER` | `whisper-local` (whisper.cpp) | `openai` |
| Text-to-speech | `TTS_PROVIDER` | `piper` | `openai` |
| Wake word | `WAKE_WORD`, `WAKE_WORD_THRESHOLD` | openWakeWord (local, no key) — see [docs/wake-word.md](docs/wake-word.md) | Porcupine |

Moving to the Pi = clone, `npm install`, edit URLs/keys in `.env`. No code changes.

## Repo layout

```
apps/agent     Node backend: ADK agents, the OpenAI-compatible LLM connector,
               the voice pipeline (wake/STT/TTS), and the kiosk WebSocket.
apps/kiosk     React (Vite) fullscreen kiosk UI for the touchscreen.
packages/shared Types shared by agent + kiosk (AgentState, WebSocket events).
docs/          architecture.md and raspberry-pi-setup.md.
```

## Running on the Pi (scripts)

```bash
npm run deploy   # git pull → install/update everything → run as a systemd service (on boot)
npm run live     # run in the foreground to diagnose (streams all logs); `-- chat` for text
npm run stop     # stop everything (services + stray agent/whisper/kiosk processes)
npm run setup    # idempotent install only (deps, whisper.cpp + model, Piper, etc.)
```

Test the speech components in isolation (no mic/wake word needed):

```bash
npm run stt --workspace apps/agent -- audio.wav          # WAV -> text (whisper.cpp)
npm run tts --workspace apps/agent -- "Hola, ¿qué tal?"  # text -> speech (Piper, plays audio)
```

Logs are always written to `logs/agent.log` (and `logs/whisper-server.log`); under
systemd, also `journalctl --user -u home-assistant-agent -f`.

## Status / roadmap

- **Fase 0 (done):** monorepo, ADK agents + tools, OpenAI-compatible connector
  (local/cloud per agent, incl. Vertex via gcloud), chat REPL, kiosk UI + WebSocket,
  diagnostics logging, systemd services + deploy/live/stop scripts.
- **Fase 1 (in progress):** real audio, all local. **STT (whisper.cpp server) and
  TTS (Piper) validated** (`npm run stt` / `npm run tts`); **wake word = openWakeWord**
  side-car (no key, installed + model load validated). Remaining: live mic test of the
  full loop on Pi hardware.
- **Fase 2:** kiosk autostart (`chromium --kiosk`), polish, packaging.

See [docs/architecture.md](docs/architecture.md),
[docs/raspberry-pi-setup.md](docs/raspberry-pi-setup.md) (incl. deploying to the
live Pi), [docs/background-tasks.md](docs/background-tasks.md), and
[docs/wake-word.md](docs/wake-word.md).
