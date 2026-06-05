/**
 * Short audio cues played through the assistant's speaker at pipeline
 * transitions, for hands-free feedback:
 *   - `wake`     rising two-tone when the wake word fires (your turn to speak)
 *   - `thinking` soft tone when it starts processing the command
 *   - `done`     falling two-tone when the spoken answer finishes
 *
 * Tones are synthesized once into temp WAVs (no asset files, no deps) and played
 * through the same player as TTS. Disable with `AUDIO_CUES=false`.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config/env.js';
import { createLogger } from '../logger.js';
import { playWav } from './player.js';
import { writePcm16Wav } from './wav.js';

const log = createLogger('cues');
const RATE = 16000;

export type Cue = 'wake' | 'thinking' | 'done';

interface Segment {
  freq: number;
  ms: number;
}

const CUES: Record<Cue, Segment[]> = {
  wake: [{ freq: 660, ms: 90 }, { freq: 990, ms: 120 }], // rising — "listening"
  thinking: [{ freq: 520, ms: 130 }], // soft single — "got it"
  done: [{ freq: 780, ms: 90 }, { freq: 520, ms: 140 }], // falling — "finished"
};

/** Renders a sequence of tones to 16-bit PCM, with short fades to avoid clicks. */
function renderTone(segments: Segment[]): Int16Array {
  const counts = segments.map((s) => Math.round((s.ms / 1000) * RATE));
  const out = new Int16Array(counts.reduce((a, b) => a + b, 0));
  let i = 0;
  segments.forEach((s, idx) => {
    const n = counts[idx]!;
    const fade = Math.min(Math.floor(n / 4), Math.round(0.005 * RATE)); // 5 ms
    for (let k = 0; k < n; k++) {
      let amp = 0.28;
      if (k < fade) amp *= k / fade;
      else if (k > n - fade) amp *= (n - k) / fade;
      out[i++] = Math.round(Math.sin((2 * Math.PI * s.freq * k) / RATE) * amp * 32767);
    }
  });
  return out;
}

const paths: Partial<Record<Cue, string>> = {};
let ready: Promise<void> | undefined;

function ensure(): Promise<void> {
  ready ??= (async () => {
    for (const cue of Object.keys(CUES) as Cue[]) {
      const p = join(tmpdir(), `home-assistant-cue-${cue}.wav`);
      await writePcm16Wav(p, renderTone(CUES[cue]), RATE);
      paths[cue] = p;
    }
  })();
  return ready;
}

/** Plays a cue (best-effort; never throws, never blocks the pipeline on error). */
export async function playCue(cue: Cue): Promise<void> {
  if (!config.audio.cues) return;
  try {
    await ensure();
    const p = paths[cue];
    if (p) await playWav(p);
  } catch (e) {
    log.debug('cue failed', { cue, error: (e as Error).message });
  }
}
