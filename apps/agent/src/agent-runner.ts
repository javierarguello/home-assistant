/**
 * Thin wrapper around ADK's runner that keeps a single conversation session
 * and turns the event stream into simple {@link AskUpdate}s.
 */
import { InMemoryRunner, StreamingMode, isFinalResponse } from '@google/adk';
import type { Event } from '@google/adk';
import { rootAgent } from './agents/root-agent.js';
import { config } from './config/env.js';
import { createLogger } from './logger.js';

const log = createLogger('agent');

const APP_NAME = 'home-assistant';

export type AskUpdate =
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string }
  | { type: 'tool'; tool: string };

export class AgentRunner {
  private readonly runner = new InMemoryRunner({ agent: rootAgent, appName: APP_NAME });
  private readonly userId = 'local-user';
  private readonly idleMs = config.session.idleResetMs;
  private sessionId?: string;
  private lastActivityAt = 0;
  private sweeper?: ReturnType<typeof setInterval>;

  /**
   * Ensures a live conversation session. If the previous one has been idle past
   * the configured window, it's dropped first so we start fresh — this is what
   * keeps the per-turn token cost from carrying stale context across a long gap.
   */
  async init(): Promise<void> {
    if (this.sessionId && Date.now() - this.lastActivityAt > this.idleMs) {
      await this.reset('idle');
    }
    if (!this.sessionId) {
      const session = await this.runner.sessionService.createSession({
        appName: APP_NAME,
        userId: this.userId,
      });
      this.sessionId = session.id;
      this.startSweeper();
    }
    this.markActivity();
  }

  /**
   * Records activity so the idle timer doesn't expire mid-work. Called on every
   * user turn; background tasks that should keep the conversation alive can call
   * it too.
   */
  markActivity(): void {
    this.lastActivityAt = Date.now();
  }

  /** Drops the in-memory conversation, freeing its accumulated context (tokens). */
  async reset(reason = 'manual'): Promise<void> {
    const id = this.sessionId;
    this.sessionId = undefined;
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = undefined;
    }
    if (!id) return;
    try {
      await this.runner.sessionService.deleteSession({
        appName: APP_NAME,
        userId: this.userId,
        sessionId: id,
      });
    } catch {
      /* best-effort; the service is RAM-only anyway */
    }
    log.info('conversation session dropped', { reason });
  }

  /** Background check that proactively drops the session once it goes idle. */
  private startSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      if (this.sessionId && Date.now() - this.lastActivityAt > this.idleMs) {
        void this.reset('idle');
      }
    }, Math.min(this.idleMs, 60_000));
    this.sweeper.unref?.(); // never keep the process alive just for this
  }

  /** Sends a user message and streams back updates from the agent graph. */
  async *ask(text: string): AsyncGenerator<AskUpdate, void> {
    await this.init();
    for await (const event of this.runner.runAsync({
      userId: this.userId,
      sessionId: this.sessionId!,
      newMessage: { role: 'user', parts: [{ text }] },
      runConfig: { streamingMode: StreamingMode.SSE },
    })) {
      // ADK reports model/transport failures as error events rather than throws.
      if (event.errorCode || event.errorMessage) {
        throw new Error(event.errorMessage ?? `Model error: ${event.errorCode}`);
      }
      for (const part of event.content?.parts ?? []) {
        if (part.functionCall?.name) yield { type: 'tool', tool: part.functionCall.name };
      }
      const text = textOf(event);
      if (!text) continue;
      if (isFinalResponse(event)) {
        log.debug('final', { len: text.length, head: text.slice(0, 50) });
        yield { type: 'final', text };
      } else if (event.partial) {
        log.debug('partial', { len: text.length, text: text.slice(0, 50) });
        yield { type: 'partial', text };
      }
    }
    this.markActivity(); // count the idle window from the end of the turn
  }
}

function textOf(event: Event): string {
  return (event.content?.parts ?? [])
    .map((p) => p.text)
    .filter((t): t is string => !!t)
    .join('');
}
