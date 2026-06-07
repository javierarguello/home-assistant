/**
 * WebSocket bridge to the kiosk. Broadcasts {@link ServerEvent}s (state +
 * transcript) and accepts {@link ClientEvent}s (typed text / interrupt).
 * Keeps a short history so a freshly-opened kiosk can catch up via `hello`.
 */
import { WebSocketServer, WebSocket } from 'ws';
import type {
  AgentState,
  ClientEvent,
  Detail,
  ServerEvent,
  TaskInfo,
  TranscriptEntry,
} from '@home-assistant/shared';
import { createLogger } from '../logger.js';

const log = createLogger('ws');

export interface WsHandlers {
  onText?: (text: string) => void;
  onInterrupt?: () => void;
  /** User answered (or gave more context to) a background task. */
  onTaskAnswer?: (taskId: string, answer: string) => void;
  /** User asked what a background task is doing. */
  onTaskStatus?: (taskId: string) => void;
  /** Push-to-talk: a base64 audio clip to transcribe + run as a turn. */
  onPushAudio?: (audio: string, mime: string) => void;
}

export interface WsServer {
  broadcast: Emit;
  close: () => void;
}

type Emit = (event: ServerEvent) => void;

export function startWsServer(port: number, handlers: WsHandlers = {}): WsServer {
  const wss = new WebSocketServer({ port });

  let state: AgentState = 'idle';
  const transcript: TranscriptEntry[] = [];
  // Latest snapshot per task, so a freshly-connected kiosk catches up via `hello`.
  const tasks = new Map<string, TaskInfo>();
  // Recent tool details (rolling), so a freshly-connected kiosk can show them.
  const details: Detail[] = [];

  const broadcast: Emit = (event) => {
    if (event.type === 'state') state = event.state;
    if (event.type === 'transcript') {
      transcript.push(event.entry);
      if (transcript.length > 100) transcript.shift();
    }
    if (event.type === 'task') {
      // Drop finished tasks from the catch-up snapshot after a grace window;
      // keep running/paused ones. (Live clients still get every event.)
      const terminal = ['completed', 'failed', 'canceled'].includes(event.task.status);
      tasks.set(event.task.id, event.task);
      if (terminal) setTimeout(() => tasks.delete(event.task.id), 60_000).unref?.();
    }
    if (event.type === 'detail') {
      details.push(event.detail);
      if (details.length > 10) details.shift();
    }
    const data = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  };

  wss.on('connection', (ws) => {
    log.info('kiosk connected', { clients: wss.clients.size });
    const hello: ServerEvent = {
      type: 'hello',
      state,
      transcript: [...transcript],
      tasks: [...tasks.values()],
      details: [...details],
    };
    ws.send(JSON.stringify(hello));
    ws.on('close', () => log.info('kiosk disconnected', { clients: wss.clients.size }));
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as ClientEvent;
        if (msg.type === 'text' && msg.text.trim()) handlers.onText?.(msg.text.trim());
        else if (msg.type === 'interrupt') handlers.onInterrupt?.();
        else if (msg.type === 'task-answer' && msg.taskId && msg.answer.trim())
          handlers.onTaskAnswer?.(msg.taskId, msg.answer.trim());
        else if (msg.type === 'task-status' && msg.taskId) handlers.onTaskStatus?.(msg.taskId);
        else if (msg.type === 'push-audio' && msg.audio) handlers.onPushAudio?.(msg.audio, msg.mime);
      } catch {
        /* ignore malformed messages */
      }
    });
  });

  log.info('kiosk WebSocket listening', { url: `ws://localhost:${port}` });
  return { broadcast, close: () => wss.close() };
}
