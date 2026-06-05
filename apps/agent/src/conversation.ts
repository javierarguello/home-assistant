/**
 * One conversation turn, shared by every entry point (chat REPL, kiosk
 * WebSocket, and the voice pipeline). It streams the model's tokens and starts
 * speaking each sentence as soon as it's ready (lower perceived latency), while
 * broadcasting the growing transcript + state to the kiosk.
 */
import { randomUUID } from 'node:crypto';
import type { AgentState, ServerEvent, Speaker, TranscriptEntry } from '@home-assistant/shared';
import { AgentRunner } from './agent-runner.js';
import { cleanForSpeech } from './tts/clean-text.js';
import { createLogger } from './logger.js';

export type Emit = (event: ServerEvent) => void;

const log = createLogger('conversation');

/** Maps a tool name to a friendly, non-technical activity label for the kiosk. */
function activityLabel(tool: string): string {
  switch (tool) {
    case 'web_search':
      return 'Buscando en la web…';
    case 'remember':
      return 'Guardando en memoria…';
    case 'recall':
      return 'Consultando lo que recuerdo…';
    default:
      return 'Trabajando…';
  }
}

/**
 * Longest speakable prefix of `pending`: up to the last sentence terminator, or
 * (if it's getting long with none) a clause break; the whole thing when `final`.
 *
 * In `early` mode (the very first chunk of an answer) it also breaks at a clause
 * separator and on a much shorter length, so speech — and its synthesis — starts
 * as soon as possible; later chunks break on full sentences for natural prosody.
 */
function speakableChunk(pending: string, final: boolean, early = false): string {
  if (final) return pending;
  let lastEnd = -1;
  for (let i = 0; i < pending.length; i++) {
    const c = pending[i]!;
    if ((c === '.' || c === '!' || c === '?' || c === '…' || c === '\n')) {
      const next = pending[i + 1];
      if (next === undefined || /\s/.test(next)) lastEnd = i + 1;
    }
  }
  if (lastEnd > 0) return pending.slice(0, lastEnd);
  // First chunk: get something speakable out fast — break at the first clause
  // separator (",", ";", ":") past ~20 chars.
  if (early) {
    for (let i = 20; i < pending.length; i++) {
      const c = pending[i]!;
      if ((c === ',' || c === ';' || c === ':') && /\s/.test(pending[i + 1] ?? ' ')) {
        return pending.slice(0, i + 1);
      }
    }
  }
  const limit = early ? 60 : 140;
  if (pending.length > limit) {
    const sp = pending.lastIndexOf(' ', limit);
    if (sp > (early ? 20 : 40)) return pending.slice(0, sp + 1);
  }
  return '';
}

export class Conversation {
  /** Broadcasts events to the kiosk. Set after the WS server starts. */
  emit?: Emit;
  /**
   * Synthesizes one chunk of the answer to a WAV path (voice mode only). Kept
   * separate from {@link play} so chunks can be synthesized in parallel — the
   * next sentence renders while the current one is still playing.
   */
  synth?: (text: string) => Promise<string | null>;
  /** Plays a synthesized WAV to completion (voice mode only). */
  play?: (wavPath: string) => Promise<void>;
  /** Called once the spoken answer has finished playing (voice mode only). */
  onSpeechEnd?: () => Promise<void> | void;
  /** Receives the growing answer text, e.g. for console rendering. */
  onText?: (update: { text: string; final: boolean }) => void;
  /** Receives the name of each tool the agent calls. */
  onTool?: (tool: string) => void;

  private readonly runner = new AgentRunner();

  constructor(
    init: Partial<
      Pick<Conversation, 'emit' | 'synth' | 'play' | 'onSpeechEnd' | 'onText' | 'onTool'>
    > = {},
  ) {
    Object.assign(this, init);
  }

  async init(): Promise<void> {
    await this.runner.init();
  }

  setState(state: AgentState): void {
    this.emit?.({ type: 'state', state });
  }

  /** Runs a turn: stream tokens -> speak sentence-by-sentence -> idle. */
  async handle(text: string): Promise<string> {
    log.info('turn', { user: text });
    this.emitTranscript('user', text);
    this.setState('thinking');

    const answerId = randomUUID();
    const startedAt = Date.now();
    let full = '';
    let flushed = 0; // chars of `full` already queued for speech
    let speaking = false;
    let speakStartedAt = 0; // when the first chunk started being spoken

    // TTS pipeline: start synthesizing each sentence the moment its text is
    // ready (so renders run in parallel — important for slow cloud TTS), but
    // play them strictly in order. `speakChain` only gates *playback*.
    let speakChain: Promise<void> = Promise.resolve();
    const enqueueSpeech = (chunk: string) => {
      const synth = this.synth;
      const play = this.play;
      if (!synth || !play) return;
      // Strip markdown so it isn't read aloud literally; skip if nothing remains
      // (e.g. a bare list marker).
      const spoken = cleanForSpeech(chunk);
      if (!spoken) return;
      if (!speaking) {
        speaking = true;
        speakStartedAt = Date.now();
        this.setState('speaking');
      }
      log.debug('speak chunk', { head: spoken.slice(0, 50) });
      // Fire synthesis NOW (don't await playback of earlier chunks).
      const wav = Promise.resolve(synth(spoken)).catch((e) => {
        log.error('tts synth failed', e);
        return null;
      });
      speakChain = speakChain
        .then(async () => {
          const path = await wav; // usually already resolved by the time we get here
          if (path) await play(path);
        })
        .catch((e) => log.error('tts play failed', e));
    };
    const flush = (final: boolean) => {
      // `!speaking` is true only until the first chunk is queued -> early mode.
      const chunk = speakableChunk(full.slice(flushed), final, !speaking);
      if (chunk) {
        enqueueSpeech(chunk);
        flushed += chunk.length;
      }
    };

    try {
      for await (const update of this.runner.ask(text)) {
        if (update.type === 'tool') {
          log.info('tool call', { tool: update.tool });
          this.onTool?.(update.tool);
          this.emit?.({ type: 'activity', label: activityLabel(update.tool) });
          continue;
        }
        if (update.type === 'partial') full += update.text;
        else if (update.type === 'final' && update.text.length >= full.length) full = update.text;

        this.onText?.({ text: full, final: update.type === 'final' });
        flush(update.type === 'final');
        this.emitTranscript('assistant', full, answerId);
      }
    } catch (error) {
      log.error('turn failed', error);
      this.emit?.({ type: 'error', message: (error as Error).message });
      await speakChain.catch(() => {});
      this.setState('idle');
      throw error;
    }

    log.info('answer', { ms: Date.now() - startedAt, text: full.slice(0, 200) });
    this.emit?.({ type: 'timing', stage: 'llm', ms: Date.now() - startedAt });
    await speakChain; // wait for all queued speech to finish playing
    if (speakStartedAt) {
      this.emit?.({ type: 'timing', stage: 'tts', ms: Date.now() - speakStartedAt });
      await this.onSpeechEnd?.();
    }
    this.setState('idle');
    return full;
  }

  /** Emits a transcript entry. Reuse `id` to update an entry in place (streaming). */
  private emitTranscript(speaker: Speaker, text: string, id = randomUUID()): void {
    const entry: TranscriptEntry = { id, speaker, text, ts: Date.now() };
    this.emit?.({ type: 'transcript', entry });
  }
}
