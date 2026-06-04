/**
 * Voice pipeline: wake word -> recorded utterance -> STT -> agent -> TTS.
 * The wake word + mic capture live behind a {@link WakeSource} (openWakeWord by
 * default). This orchestrator turns each utterance WAV into a spoken answer and
 * drives the {@link AgentState} the kiosk shows.
 */
import { unlink } from 'node:fs/promises';
import { playWav } from '../audio/player.js';
import { createWakeSource, type WakeSource } from '../audio/wake-source.js';
import { config } from '../config/env.js';
import type { Conversation } from '../conversation.js';
import { createLogger } from '../logger.js';
import { createStt } from '../stt/index.js';
import { createTts } from '../tts/index.js';

const log = createLogger('voice');

export class Orchestrator {
  private readonly stt = createStt();
  private readonly tts = createTts();
  private source?: WakeSource;

  constructor(private readonly convo: Conversation) {
    // In voice mode, the final answer is spoken aloud.
    this.convo.speak = async (text) => {
      const wav = await this.tts.synthesize(text);
      if (!wav) return;
      try {
        await playWav(wav);
      } finally {
        void unlink(wav).catch(() => {});
      }
    };
  }

  /** Inject a text turn (e.g. from the kiosk) without using the microphone. */
  async injectText(text: string): Promise<void> {
    await this.convo.handle(text);
  }

  stop(): void {
    this.source?.stop();
  }

  async start(): Promise<void> {
    this.source = createWakeSource();
    this.convo.setState('idle');
    log.info('voice pipeline starting', {
      engine: config.wakeWord.engine,
      word: config.wakeWord.word,
    });
    await this.source.start(
      (wavPath) => this.handleUtterance(wavPath),
      () => this.convo.setState('listening'),
      (score, rms) =>
        this.convo.emit?.({
          type: 'wake',
          score,
          rms,
          threshold: config.wakeWord.threshold,
        }),
    );
  }

  private async handleUtterance(wavPath: string): Promise<void> {
    this.convo.setState('thinking');
    let text = '';
    const startedAt = Date.now();
    try {
      text = await this.stt.transcribe(wavPath);
    } catch (error) {
      log.error('STT failed', error);
      this.convo.setState('idle');
      return;
    } finally {
      void unlink(wavPath).catch(() => {});
    }
    log.info('stt', { ms: Date.now() - startedAt, text });
    this.convo.emit?.({ type: 'timing', stage: 'stt', ms: Date.now() - startedAt });

    // Whisper hallucinates non-speech markers on silence/noise ("[Música]",
    // "(sonido de música)", "[BLANK_AUDIO]"…). Drop those so a false wake or a
    // silent capture doesn't trigger a bogus answer.
    if (!text.trim() || isNoiseTranscript(text)) {
      if (text.trim()) log.info('ignoring non-speech transcript', { text });
      this.convo.setState('idle');
      return;
    }
    // A failed turn (e.g. an LLM 403/network error) must not kill the voice
    // loop. Conversation.handle already emits the error and resets to idle
    // before re-throwing; swallow it here so we keep listening for the next
    // wake word.
    try {
      await this.convo.handle(text.trim());
    } catch (error) {
      log.error('turn failed; staying live', error);
      this.convo.setState('idle');
    }
  }
}

/** Whisper's non-speech hallucinations (silence/noise) that we must not answer. */
const NOISE_MARKERS = new Set([
  'musica',
  'music',
  'blankaudio',
  'silencio',
  'silence',
  'sonidodemusica',
  'aplausos',
  'applause',
  'risas',
  'laughter',
  'subtitulos',
  'graciasporver',
]);

/**
 * True when a transcript is almost certainly a whisper hallucination on
 * silence/noise rather than real speech: a fully bracketed/parenthesised tag
 * (`[Música]`, `(música)`, `♪…♪`) or a bare non-speech marker.
 */
export function isNoiseTranscript(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  // Whisper wraps non-speech in brackets/parens or music notes.
  if (/^[[({♪*].*[\])}♪*]$/.test(trimmed)) return true;
  const stripped = trimmed
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // drop accents (música -> musica)
    .replace(/[^a-z]/g, ''); // keep letters only
  return NOISE_MARKERS.has(stripped);
}
