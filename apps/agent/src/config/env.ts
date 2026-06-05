/**
 * Central configuration, read from environment variables (see `.env.example`).
 *
 * Everything that differs between "all-local on the Raspberry Pi" and "cloud"
 * lives here, so moving between machines is just editing `.env` — no code
 * changes. Per-agent LLM overrides let each agent run on a different
 * local/cloud model.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WS_DEFAULT_PORT } from '@home-assistant/shared';

// apps/agent/src/config/env.ts -> repo root
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

export interface ModelConfig {
  /** Model id sent to the backend, e.g. `llama3.2:3b`, `gpt-4o-mini`. */
  model: string;
  /** OpenAI-compatible base URL. */
  baseURL: string;
  apiKey: string;
  temperature?: number;
  maxTokens?: number;
  /** When 'gcloud', the bearer token comes from the gcloud CLI (Vertex AI). */
  auth?: 'gcloud';
  /** gcloud account to mint the token from (when auth='gcloud'). */
  gcloudAccount?: string;
  /** Ollama: disable model thinking/reasoning output (cleaner, faster). */
  think?: boolean;
}

function num(value: string | undefined): number | undefined {
  if (value == null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Resolves the LLM config for an agent. Looks for `<AGENT>_MODEL`,
 * `<AGENT>_BASE_URL`, etc., falling back to the global `LLM_*` defaults.
 *
 * @param agentKey upper-snake-case agent name, e.g. `ROOT`, `WEB_SEARCH`.
 */
export function readModelConfig(agentKey: string): ModelConfig {
  const get = (suffix: string) => process.env[`${agentKey}_${suffix}`];
  const auth = get('AUTH') ?? process.env.LLM_AUTH;
  const think = get('THINK') ?? process.env.LLM_THINK;
  return {
    model: get('MODEL') ?? process.env.LLM_MODEL ?? 'llama3.2:3b',
    baseURL: get('BASE_URL') ?? process.env.LLM_BASE_URL ?? 'http://localhost:11434/v1',
    apiKey: get('API_KEY') ?? process.env.LLM_API_KEY ?? 'ollama',
    temperature: num(get('TEMPERATURE') ?? process.env.LLM_TEMPERATURE),
    maxTokens: num(get('MAX_TOKENS') ?? process.env.LLM_MAX_TOKENS),
    auth: auth === 'gcloud' ? 'gcloud' : undefined,
    gcloudAccount: get('GCLOUD_ACCOUNT') ?? process.env.LLM_GCLOUD_ACCOUNT,
    think: think === 'true' ? true : think === 'false' ? false : undefined,
  };
}

export type SttProvider = 'whisper-local' | 'whisper-server' | 'openai' | 'gemini' | 'mock';
export type TtsProvider = 'piper' | 'openai' | 'gemini' | 'mock';
export type RunMode = 'chat' | 'voice';

export const config = {
  /** Default run mode if `--mode` is not passed. */
  mode: (process.env.MODE as RunMode) ?? 'chat',

  /** Diagnostics log: written to <repo>/logs by default (override with LOG_DIR). */
  logDir: process.env.LOG_DIR ?? join(repoRoot, 'logs'),
  logLevel: (process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error') ?? 'info',
  /** Mirror ALL log lines to the console (live diagnosis). Default: warn/error only. */
  logConsole: process.env.LOG_CONSOLE === 'true',

  /** WebSocket server the kiosk connects to. */
  wsPort: num(process.env.WS_PORT) ?? WS_DEFAULT_PORT,
  /** Set to '0'/'false' to disable the kiosk WebSocket server. */
  wsEnabled: process.env.WS_ENABLED !== 'false' && process.env.WS_ENABLED !== '0',

  assistant: {
    name: process.env.ASSISTANT_NAME ?? 'Asistente',
    /** Language hint passed to the model and STT. */
    language: process.env.ASSISTANT_LANGUAGE ?? 'es',
  },

  wakeWord: {
    /** 'openwakeword' (fully local, no key) or 'porcupine' (needs an access key). */
    engine: (process.env.WAKE_WORD_ENGINE as 'openwakeword' | 'porcupine') ?? 'openwakeword',
    /** openWakeWord model name (e.g. hey_jarvis) / .onnx path, or a Porcupine keyword/.ppn. */
    word: process.env.WAKE_WORD ?? 'hey_jarvis',
    threshold: num(process.env.WAKE_WORD_THRESHOLD) ?? 0.5,
    // openWakeWord side-car:
    python: process.env.WAKEWORD_PYTHON ?? join(repoRoot, 'vendor/wakeword-venv/bin/python'),
    script: process.env.WAKEWORD_SCRIPT ?? join(repoRoot, 'apps/agent/python/wakeword_runner.py'),
    inputDevice: process.env.WAKEWORD_INPUT_DEVICE ?? '',
    // Porcupine (optional, legacy):
    accessKey: process.env.PICOVOICE_ACCESS_KEY ?? '',
    sensitivity: num(process.env.WAKE_WORD_SENSITIVITY) ?? 0.5,
  },

  stt: {
    provider: (process.env.STT_PROVIDER as SttProvider) ?? 'whisper-local',
    /** Language for transcription. 'auto' lets whisper detect (multilingual). */
    language: process.env.STT_LANGUAGE ?? 'auto',
    /** Path to the whisper.cpp `whisper-cli` binary (local). */
    whisperBinary: process.env.WHISPER_BINARY ?? 'whisper-cli',
    /** Path to the GGML model, e.g. models/ggml-base.bin (local). */
    whisperModel: process.env.WHISPER_MODEL ?? 'models/ggml-base.bin',
    /** CPU threads for whisper.cpp (Pi 5 has 4 cores). */
    whisperThreads: num(process.env.WHISPER_THREADS) ?? 4,
    /** whisper.cpp HTTP server (keeps the model in memory; much faster). */
    whisperServerUrl: process.env.WHISPER_SERVER_URL ?? 'http://127.0.0.1:8088',
    whisperServerBinary: process.env.WHISPER_SERVER_BINARY ?? 'whisper-server',
    /** Auto-start the server if it isn't already running. */
    whisperServerAutostart: process.env.WHISPER_SERVER_AUTOSTART !== 'false',
    /** Cloud STT (OpenAI-compatible /audio/transcriptions). */
    baseURL: process.env.STT_BASE_URL ?? 'https://api.openai.com/v1',
    apiKey: process.env.STT_API_KEY ?? '',
    model: process.env.STT_MODEL ?? 'whisper-1',
    /** Gemini STT (audio input). Key falls back to the LLM key. */
    geminiBaseUrl:
      process.env.STT_GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta',
    geminiApiKey: process.env.STT_GEMINI_API_KEY ?? process.env.LLM_API_KEY ?? '',
    geminiModel: process.env.STT_GEMINI_MODEL ?? 'gemini-2.5-flash-lite',
  },

  tts: {
    provider: (process.env.TTS_PROVIDER as TtsProvider) ?? 'piper',
    /** Path to the Piper binary (local). */
    piperBinary: process.env.PIPER_BINARY ?? 'piper',
    /** Default Piper voice `.onnx` (used for Spanish / when language unknown). */
    piperVoice: process.env.PIPER_VOICE ?? 'voices/es_AR-daniela-high.onnx',
    /** English Piper voice; used when the response text is detected as English. */
    voiceEn: process.env.TTS_VOICE_EN ?? '',
    /** Cloud TTS (OpenAI-compatible /audio/speech). */
    baseURL: process.env.TTS_BASE_URL ?? 'https://api.openai.com/v1',
    apiKey: process.env.TTS_API_KEY ?? '',
    model: process.env.TTS_MODEL ?? 'tts-1',
    voice: process.env.TTS_VOICE ?? 'alloy',
    /** Gemini TTS (native audio out). Key falls back to the LLM key. */
    geminiBaseUrl:
      process.env.TTS_GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta',
    geminiApiKey: process.env.TTS_GEMINI_API_KEY ?? process.env.LLM_API_KEY ?? '',
    // NB: the cheaper gemini-2.5-flash-lite-preview-tts is not on the AI Studio
    // (generativelanguage) API yet — only flash/pro TTS are. flash is cheapest here.
    geminiModel: process.env.TTS_GEMINI_MODEL ?? 'gemini-2.5-flash-preview-tts',
    geminiVoice: process.env.TTS_GEMINI_VOICE ?? 'Kore',
  },

  audio: {
    /** Command used to play a WAV file. `aplay` on Pi/Linux, `afplay` on mac. */
    playerCommand: process.env.AUDIO_PLAYER ?? (process.platform === 'darwin' ? 'afplay' : 'aplay'),
    /** Play short audio cues at wake / processing / done. Disable with AUDIO_CUES=false. */
    cues: process.env.AUDIO_CUES !== 'false',
  },

  tools: {
    /**
     * Expose the web_search tool to the agent. Disable for small local models
     * (e.g. llama3.2:1b) that over-call tools or emit malformed arguments.
     */
    webSearch: process.env.ENABLE_WEB_SEARCH !== 'false',
    /** Web-search backend, in order of preference: Brave > Tavily > DuckDuckGo (keyless). */
    braveApiKey: process.env.BRAVE_API_KEY ?? '',
    tavilyApiKey: process.env.TAVILY_API_KEY ?? '',
    /**
     * GitHub tools (commits, compare refs, PRs, deployments). Off by default —
     * enable with ENABLE_GITHUB=true once a token is set. Needs a Personal
     * Access Token with `repo` scope for private repos.
     */
    github: process.env.ENABLE_GITHUB === 'true',
    githubToken: process.env.GITHUB_TOKEN ?? '',
    /** Fallback "owner/repo" so you don't have to name the repo every time. */
    githubDefaultRepo: process.env.GITHUB_DEFAULT_REPO ?? '',
  },

  memory: {
    /** Long-term memory: `remember`/`recall` tools + facts injected into the prompt. */
    enabled: process.env.MEMORY_ENABLED !== 'false',
    /** JSON store (gitignored, survives `git pull`; outside the repo via MEMORY_FILE). */
    file: process.env.MEMORY_FILE ?? join(repoRoot, 'data', 'memory.json'),
    /** Max facts injected into the system prompt each turn. */
    maxInject: num(process.env.MEMORY_MAX_INJECT) ?? 30,
    /** Background consolidation: how often to check (hours). */
    consolidateHours: num(process.env.MEMORY_CONSOLIDATE_HOURS) ?? 6,
    /** Only consolidate when this many facts have piled up unsummarized. */
    consolidateThreshold: num(process.env.MEMORY_CONSOLIDATE_THRESHOLD) ?? 50,
  },
} as const;
