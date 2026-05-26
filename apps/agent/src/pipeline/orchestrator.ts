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

    if (text.trim()) await this.convo.handle(text.trim());
    else this.convo.setState('idle');
  }
}
