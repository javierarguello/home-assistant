/**
 * Entry point. Starts the kiosk WebSocket server and runs either:
 *   --mode=chat   headless text REPL (default; no audio hardware needed)
 *   --mode=voice  wake-word voice pipeline (requires Fase 1 audio deps)
 */
import { parseArgs } from 'node:util';
import { config, readModelConfig, type RunMode } from './config/env.js';
import { Conversation } from './conversation.js';
import { createLogger, logFilePath } from './logger.js';
import { startWsServer } from './server/ws.js';
import { startConsolidationSchedule } from './memory/consolidate.js';
import { setDetailSink } from './tools/detail.js';
import { taskManager } from './tasks/instance.js';

const log = createLogger('main');

const { values } = parseArgs({
  options: { mode: { type: 'string' } },
  strict: false,
  allowPositionals: true,
});

const requested = values.mode;
const mode: RunMode = requested === 'voice' || requested === 'chat' ? requested : config.mode;

const rootModel = readModelConfig('ROOT');
log.info('starting', {
  mode,
  llm: { model: rootModel.model, baseURL: rootModel.baseURL, auth: rootModel.auth ?? 'apiKey' },
  stt: config.stt.provider,
  tts: config.tts.provider,
  ws: config.wsEnabled ? config.wsPort : 'disabled',
});
console.log(`[home-assistant] mode=${mode} · logs → ${logFilePath}`);

const convo = new Conversation();
await convo.init();

const ws = config.wsEnabled
  ? startWsServer(config.wsPort, {
      onText: (text) => void convo.handle(text),
      // A kiosk answered a worker's question (or asked what it's doing).
      onTaskAnswer: (taskId, answer) => {
        if (!config.tasks.enabled) return;
        try {
          taskManager().answer(taskId, answer);
        } catch (e) {
          log.error('task answer failed', e);
        }
      },
      onTaskStatus: (taskId) => {
        if (!config.tasks.enabled) return;
        try {
          ws?.broadcast({ type: 'task', task: taskManager().liveStatus(taskId) });
        } catch (e) {
          log.error('task status failed', e);
        }
      },
    })
  : undefined;
convo.emit = ws?.broadcast;
// Tools can push rich HTML "details" straight to the kiosk sidebar.
setDetailSink(ws ? (detail) => ws.broadcast({ type: 'detail', detail }) : undefined);

// Periodically consolidate long-term memory in the background (no-op in the
// short-lived chat REPL: the interval is unref'd).
startConsolidationSchedule();

// Background task agents: emit progress to the kiosk and speak a notice when one
// finishes. init() recovers any workers still alive from a previous run.
const tasks = config.tasks.enabled ? taskManager() : undefined;
if (tasks) {
  tasks.configure({
    onUpdate: (task) => ws?.broadcast({ type: 'task', task }),
    announce: (text) => void convo.announce(text),
  });
  await tasks.init();
}

if (mode === 'voice') {
  const { Orchestrator } = await import('./pipeline/orchestrator.js');
  const orchestrator = new Orchestrator(convo);
  // Reap the wake-word side-car (and close the WS) on shutdown.
  const shutdown = () => {
    log.info('shutting down');
    orchestrator.stop();
    void tasks?.stop();
    ws?.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await orchestrator.start();
} else if (process.stdin.isTTY) {
  // Interactive terminal: run the text REPL.
  const { runChat } = await import('./cli/chat.js');
  await runChat(convo);
  await tasks?.stop();
  ws?.close();
  process.exit(0);
} else {
  // Headless (no terminal, e.g. background/service): just serve the kiosk over
  // WebSocket. The WS server keeps the process alive.
  log.info('headless chat server — kiosk can connect over WebSocket');
}
