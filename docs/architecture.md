# Architecture

## Components

- **`apps/agent`** — the brain. A Node process that:
  - hosts the ADK agent graph (root agent + `web_search` sub-agent + tools),
  - runs the voice pipeline (wake word → STT → agent → TTS) in `--mode=voice`,
  - serves a WebSocket the kiosk subscribes to.
- **`apps/kiosk`** — a React/Vite single-page app for the touchscreen. Connects to
  the WebSocket, renders the current `AgentState` (an animated orb) and the
  conversation, and can send typed messages.
- **`packages/shared`** — the contract between them: `AgentState`, `ServerEvent`,
  `ClientEvent`, `TranscriptEntry`.

## The LLM layer (local or cloud, per agent)

Google's TypeScript ADK only ships native connectors for **Gemini** and
**Apigee**; there is no built-in OpenAI/LiteLLM connector (the Python ADK has
`LiteLlm`). ADK doesn't speak raw OpenAI HTTP either — internally it passes
`@google/genai` types (`Content`, `Part`, `FunctionDeclaration`) through its
`BaseLlm` abstraction.

So `apps/agent/src/llm/openai-compatible-llm.ts` implements **one** `BaseLlm`
subclass, `OpenAiCompatibleLlm`, that:

1. converts an ADK `LlmRequest` (contents, system instruction, tool declarations)
   into OpenAI `chat/completions` messages + `tools`;
2. calls any OpenAI-compatible endpoint via the `openai` SDK (`baseURL` + `apiKey`);
3. converts the response (text + `tool_calls`) back into an ADK `LlmResponse`
   (`Content` with `text` / `functionCall` parts).

Because Ollama, OpenAI, Groq, OpenRouter — **and Gemini's OpenAI-compatible
endpoint** — all speak this protocol, one adapter covers local and cloud.

`resolveModel('ROOT')` / `resolveModel('WEB_SEARCH')` read per-agent env
(`<AGENT>_MODEL`, `<AGENT>_BASE_URL`, `<AGENT>_API_KEY`, falling back to `LLM_*`)
and hand the resulting `OpenAiCompatibleLlm` instance to each `LlmAgent`. That is
how one agent can run locally while another runs in the cloud.

> Note: ADK's built-in `GOOGLE_SEARCH` tool only works with Gemini grounding, so
> this repo uses a provider-agnostic `web_search` `FunctionTool` instead.

## Conversation lifecycle

`Conversation.handle(text)` drives the shared state machine and is called by every
entry point (chat REPL, kiosk WebSocket, voice pipeline):

```
idle ──(wake word / typed text)──▶ listening ──(record)──▶ thinking ──(agent)──▶ speaking ──▶ idle
                                                                          └─(no voice)─────────▶ idle
```

Each transition is broadcast as a `{type:'state'}` event; user and assistant turns
are broadcast as `{type:'transcript'}`. New kiosks receive a `hello` snapshot.

## Voice pipeline (`--mode=voice`, Fase 1)

`pipeline/orchestrator.ts` drives a `WakeSource` (`audio/wake-source.ts`):

1. **Wake word + capture** — `WakeSource` yields a recorded utterance WAV per
   detection. Default `openwakeword`: a Python side-car (`apps/agent/python/wakeword_runner.py`)
   that owns the mic, detects the wake word, records the phrase (RMS silence
   detection, max 8 s), and emits the WAV path as JSON on stdout. Alternative
   `porcupine`: Node-native (`audio/wakeword.ts` + `audio/recorder.ts`).
2. `stt/*` transcribes it (whisper.cpp server locally, or a cloud `/audio/transcriptions`).
3. `Conversation.handle(transcript)` runs the agent graph.
4. `tts/*` synthesizes the answer (Piper locally, or cloud `/audio/speech`) and
   `audio/player.ts` plays it (`aplay`/`afplay`).

All speech providers are swappable via `.env` with zero code changes.

## Why these choices for the Pi 5

| Concern | Choice | Notes |
|---------|--------|-------|
| Wake word | openWakeWord | 100% local, no API key, no phone-home (Python side-car) |
| STT | whisper.cpp | tiny/base ≈ real time on Pi 5; cloud optional |
| TTS | Piper | fast neural TTS designed for the Pi |
| LLM (local) | Ollama | ~5 tok/s on 3B models; OpenAI-compatible API |
| LLM (cloud) | any OpenAI-compatible | Gemini Flash-Lite is the cheapest to test |
