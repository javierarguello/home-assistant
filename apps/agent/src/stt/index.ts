/**
 * Speech-to-text provider abstraction. Choose local (whisper.cpp) or cloud
 * (any OpenAI-compatible `/audio/transcriptions`) via `STT_PROVIDER`.
 */
import { config } from '../config/env.js';
import { transcribeWhisperLocal } from './whisper-local.js';
import { transcribeWhisperServer } from './whisper-server.js';
import { transcribeCloud } from './cloud.js';

export interface SttEngine {
  /** Transcribes a 16 kHz mono WAV file to text. */
  transcribe(wavPath: string): Promise<string>;
}

export function createStt(): SttEngine {
  switch (config.stt.provider) {
    case 'whisper-local':
      return { transcribe: transcribeWhisperLocal };
    case 'whisper-server':
      return { transcribe: transcribeWhisperServer };
    case 'openai':
      return { transcribe: transcribeCloud };
    case 'mock':
      return { transcribe: async () => '(mock transcript)' };
    default:
      throw new Error(`Unknown STT_PROVIDER: ${config.stt.provider}`);
  }
}
