/**
 * Short Web Audio chimes for hands-free feedback (no audio files).
 *
 * Browsers gate audio until a user gesture, so we resume the AudioContext on the
 * first interaction. For a fully hands-free kiosk, launch Chromium with
 * `--autoplay-policy=no-user-gesture-required`.
 */
let ctx: AudioContext | null = null;

function context(): AudioContext {
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!ctx) ctx = new Ctor();
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

function tones(freqs: number[], step = 0.11, gain = 0.05): void {
  const c = context();
  let t = c.currentTime;
  for (const f of freqs) {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + step);
    osc.connect(g).connect(c.destination);
    osc.start(t);
    osc.stop(t + step);
    t += step;
  }
}

export const chime = {
  /** Ascending — "I'm listening". */
  listening: () => tones([660, 880]),
  /** Descending — "stopped listening". */
  done: () => tones([700, 520]),
};

/** Prime the AudioContext on the first user interaction (autoplay policy). */
export function enableChimeOnInteraction(): void {
  const resume = () => {
    context();
    window.removeEventListener('pointerdown', resume);
    window.removeEventListener('keydown', resume);
  };
  window.addEventListener('pointerdown', resume);
  window.addEventListener('keydown', resume);
}
