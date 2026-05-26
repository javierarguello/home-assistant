/**
 * TTS smoke test: synthesize text with the configured engine (Piper by default)
 * and play it through the configured audio player.
 *
 *   npm run tts --workspace apps/agent -- "Hola, ¿cómo estás?"
 */
import { unlink } from 'node:fs/promises';
import { playWav } from '../audio/player.js';
import { config } from '../config/env.js';
import { createTts } from '../tts/index.js';

const text = process.argv.slice(2).join(' ').trim();
if (!text) {
  console.error('usage: npm run tts --workspace apps/agent -- "text to speak"');
  process.exit(1);
}

console.log(`TTS provider: ${config.tts.provider}`);
if (config.tts.provider === 'piper') {
  console.log(`  binary: ${config.tts.piperBinary}`);
  console.log(`  voice:  ${config.tts.piperVoice}`);
}

const started = Date.now();
const wav = await createTts().synthesize(text);
console.log(`synthesized in ${((Date.now() - started) / 1000).toFixed(1)}s${wav ? '' : ' (nothing to play)'}`);

if (wav) {
  console.log(`playing (${config.audio.playerCommand})…`);
  await playWav(wav);
  await unlink(wav).catch(() => {});
}
