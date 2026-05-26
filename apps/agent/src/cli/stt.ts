/**
 * STT smoke test, decoupled from the mic/wake word: transcribe a WAV file with
 * the configured engine (whisper-local by default).
 *
 *   npm run stt --workspace apps/agent -- path/to/audio.wav
 *
 * The WAV should be 16 kHz mono (what the voice pipeline records).
 */
import { config } from '../config/env.js';
import { createStt } from '../stt/index.js';

const file = process.argv[2];
if (!file || !file.endsWith('.wav')) {
  console.error('usage: npm run stt --workspace apps/agent -- <file.wav>');
  process.exit(1);
}

console.log(`STT provider: ${config.stt.provider}`);
if (config.stt.provider === 'whisper-local') {
  console.log(`  binary: ${config.stt.whisperBinary}`);
  console.log(`  model:  ${config.stt.whisperModel} (threads: ${config.stt.whisperThreads})`);
}

const started = Date.now();
const text = await createStt().transcribe(file);
console.log(`\n--- transcript (${((Date.now() - started) / 1000).toFixed(1)}s) ---`);
console.log(text || '(empty)');
