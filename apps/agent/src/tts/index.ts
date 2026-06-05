/**
 * Text-to-speech provider abstraction. Choose local (Piper) or cloud (any
 * OpenAI-compatible `/audio/speech`) via `TTS_PROVIDER`. Each `synthesize`
 * returns the path to a WAV file to play, or `null` if nothing to play.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config/env.js';
import { synthesizePiper } from './piper-local.js';
import { synthesizeCloud } from './cloud.js';
import { synthesizeGemini } from './gemini.js';

export interface TtsEngine {
  synthesize(text: string): Promise<string | null>;
}

export function tmpWavPath(): string {
  return join(tmpdir(), `home-assistant-tts-${randomUUID()}.wav`);
}

export function createTts(): TtsEngine {
  switch (config.tts.provider) {
    case 'piper':
      return { synthesize: (text) => synthesizePiper(text, tmpWavPath()) };
    case 'openai':
      return { synthesize: (text) => synthesizeCloud(text, tmpWavPath()) };
    case 'gemini':
      return { synthesize: (text) => synthesizeGemini(text, tmpWavPath()) };
    case 'mock':
      return {
        synthesize: async (text) => {
          console.log(`[tts:mock] would speak: ${text}`);
          return null;
        },
      };
    default:
      throw new Error(`Unknown TTS_PROVIDER: ${config.tts.provider}`);
  }
}
