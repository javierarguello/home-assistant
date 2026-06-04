/**
 * One conversation turn, shared by every entry point (chat REPL, kiosk
 * WebSocket, and the voice pipeline). It streams the model's tokens and starts
 * speaking each sentence as soon as it's ready (lower perceived latency), while
 * broadcasting the growing transcript + state to the kiosk.
 */
import { randomUUID } from 'node:crypto';
import type { AgentState, ServerEvent, Speaker, TranscriptEntry } from '@home-assistant/shared';
import { AgentRunner } from './agent-runner.js';
import { createLogger } from './logger.js';

export type Emit = (event: ServerEvent) => void;

const log = createLogger('conversation');

/**
 * Longest speakable prefix of `pending`: up to the last sentence terminator, or
 * (if it's getting long with none) a clause break; the whole thing when `final`.
 */
function speakableChunk(pending: string, final: boolean): string {
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
  if (pending.length > 140) {
    const sp = pending.lastIndexOf(' ', 140);
    if (sp > 40) return pending.slice(0, sp + 1);
  }
  return '';
}

export class Conversation {
  /** Broadcasts events to the kiosk. Set after the WS server starts. */
  emit?: Emit;
  /** Speaks one chunk of the answer (voice mode only). */
  speak?: (text: string) => Promise<void>;
  /** Receives the growing answer text, e.g. for console rendering. */
  onText?: (update: { text: string; final: boolean }) => void;
  /** Receives the name of each tool the agent calls. */
  onTool?: (tool: string) => void;

  private readonly runner = new AgentRunner();

  constructor(init: Partial<Pick<Conversation, 'emit' | 'speak' | 'onText' | 'onTool'>> = {}) {
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

    // Ordered TTS queue: speak each sentence as soon as it's ready, in order.
    let speakChain: Promise<void> = Promise.resolve();
    const enqueueSpeech = (chunk: string) => {
      const speak = this.speak;
      if (!speak || !chunk.trim()) return;
      if (!speaking) {
        speaking = true;
        this.setState('speaking');
      }
      log.debug('speak chunk', { head: chunk.trim().slice(0, 50) });
      speakChain = speakChain.then(() => speak(chunk)).catch((e) => log.error('tts chunk failed', e));
    };
    const flush = (final: boolean) => {
      const chunk = speakableChunk(full.slice(flushed), final);
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
    await speakChain; // wait for all queued speech to finish playing
    this.setState('idle');
    return full;
  }

  /** Emits a transcript entry. Reuse `id` to update an entry in place (streaming). */
  private emitTranscript(speaker: Speaker, text: string, id = randomUUID()): void {
    const entry: TranscriptEntry = { id, speaker, text, ts: Date.now() };
    this.emit?.({ type: 'transcript', entry });
  }
}
