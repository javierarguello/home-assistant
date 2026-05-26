/**
 * Offline wake-word detection via Picovoice Porcupine.
 *
 * Fase 1: install the native deps and set a key:
 *   npm i @picovoice/porcupine-node @picovoice/pvrecorder-node
 *   PICOVOICE_ACCESS_KEY=...  (free at https://console.picovoice.ai)
 */
import { config } from '../config/env.js';

export interface WakeWordDetector {
  readonly frameLength: number;
  readonly sampleRate: number;
  /** Returns true when the wake word is detected in this audio frame. */
  process(frame: Int16Array): boolean;
  release(): void;
}

export async function createWakeWord(): Promise<WakeWordDetector> {
  if (!config.wakeWord.accessKey) {
    throw new Error(
      'PICOVOICE_ACCESS_KEY is required for wake-word detection (free at console.picovoice.ai).',
    );
  }

  // Indirect specifier so the optional native dep isn't a hard compile-time
  // requirement (it's installed in Fase 1).
  const pkg = '@picovoice/porcupine-node';
  let mod: unknown;
  try {
    mod = await import(pkg);
  } catch {
    throw new Error(
      'Wake-word dependency missing. Run: npm i @picovoice/porcupine-node @picovoice/pvrecorder-node',
    );
  }

  const { Porcupine, BuiltinKeyword } = mod as {
    Porcupine: new (
      key: string,
      keywords: unknown[],
      sensitivities: number[],
    ) => {
      frameLength: number;
      sampleRate: number;
      process(frame: Int16Array): number;
      release(): void;
    };
    BuiltinKeyword: Record<string, unknown>;
  };

  const keyword = config.wakeWord.word;
  const keywordArg = keyword.endsWith('.ppn')
    ? keyword
    : (BuiltinKeyword[keyword.toUpperCase()] ?? keyword);

  const porcupine = new Porcupine(
    config.wakeWord.accessKey,
    [keywordArg],
    [config.wakeWord.sensitivity],
  );

  return {
    frameLength: porcupine.frameLength,
    sampleRate: porcupine.sampleRate,
    process: (frame) => porcupine.process(frame) >= 0,
    release: () => porcupine.release(),
  };
}
