/**
 * Thin wrapper around ADK's runner that keeps a single conversation session
 * and turns the event stream into simple {@link AskUpdate}s.
 */
import { InMemoryRunner, StreamingMode, isFinalResponse } from '@google/adk';
import type { Event } from '@google/adk';
import { rootAgent } from './agents/root-agent.js';
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
  private sessionId?: string;

  /** Creates (or reuses) the conversation session. */
  async init(): Promise<void> {
    if (this.sessionId) return;
    const session = await this.runner.sessionService.createSession({
      appName: APP_NAME,
      userId: this.userId,
    });
    this.sessionId = session.id;
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
  }
}

function textOf(event: Event): string {
  return (event.content?.parts ?? [])
    .map((p) => p.text)
    .filter((t): t is string => !!t)
    .join('');
}
