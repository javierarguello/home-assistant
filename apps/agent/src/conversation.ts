/**
 * One conversation turn, shared by every entry point (chat REPL, kiosk
 * WebSocket, and the voice pipeline). It drives the {@link AgentState}
 * lifecycle and broadcasts transcript/state events to the kiosk.
 */
import { randomUUID } from 'node:crypto';
import type { AgentState, ServerEvent, Speaker, TranscriptEntry } from '@home-assistant/shared';
import { AgentRunner } from './agent-runner.js';
import { createLogger } from './logger.js';

export type Emit = (event: ServerEvent) => void;

const log = createLogger('conversation');

export class Conversation {
  /** Broadcasts events to the kiosk. Set after the WS server starts. */
  emit?: Emit;
  /** Speaks the final answer (voice mode only). */
  speak?: (text: string) => Promise<void>;
  /** Receives partial/final text, e.g. for console rendering. */
  onText?: (update: { text: string; final: boolean }) => void;
  /** Receives the name of each tool the agent calls. */
  onTool?: (tool: string) => void;

  private readonly runner = new AgentRunner();

  constructor(init: Partial<Pick<Conversation, 'emit' | 'speak' | 'onText'>> = {}) {
    Object.assign(this, init);
  }

  async init(): Promise<void> {
    await this.runner.init();
  }

  setState(state: AgentState): void {
    this.emit?.({ type: 'state', state });
  }

  /** Runs a full turn: think -> (speak) -> idle. Returns the final answer. */
  async handle(text: string): Promise<string> {
    log.info('turn', { user: text });
    this.emitTranscript('user', text);
    this.setState('thinking');

    const startedAt = Date.now();
    let final = '';
    try {
      for await (const update of this.runner.ask(text)) {
        if (update.type === 'final') {
          final = update.text;
          this.onText?.({ text: update.text, final: true });
        } else if (update.type === 'partial') {
          this.onText?.({ text: update.text, final: false });
        } else if (update.type === 'tool') {
          log.info('tool call', { tool: update.tool });
          this.onTool?.(update.tool);
        }
      }
    } catch (error) {
      log.error('turn failed', error);
      this.emit?.({ type: 'error', message: (error as Error).message });
      this.setState('idle');
      throw error;
    }

    log.info('answer', { ms: Date.now() - startedAt, text: final.slice(0, 200) });
    if (final) this.emitTranscript('assistant', final);

    if (final && this.speak) {
      this.setState('speaking');
      try {
        await this.speak(final);
      } catch (error) {
        this.emit?.({ type: 'error', message: (error as Error).message });
      }
    }

    this.setState('idle');
    return final;
  }

  private emitTranscript(speaker: Speaker, text: string): void {
    const entry: TranscriptEntry = { id: randomUUID(), speaker, text, ts: Date.now() };
    this.emit?.({ type: 'transcript', entry });
  }
}
