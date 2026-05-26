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
  ? startWsServer(config.wsPort, { onText: (text) => void convo.handle(text) })
  : undefined;
convo.emit = ws?.broadcast;

if (mode === 'voice') {
  const { Orchestrator } = await import('./pipeline/orchestrator.js');
  const orchestrator = new Orchestrator(convo);
  // Reap the wake-word side-car (and close the WS) on shutdown.
  const shutdown = () => {
    log.info('shutting down');
    orchestrator.stop();
    ws?.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await orchestrator.start();
} else {
  const { runChat } = await import('./cli/chat.js');
  await runChat(convo);
  ws?.close();
  process.exit(0);
}
