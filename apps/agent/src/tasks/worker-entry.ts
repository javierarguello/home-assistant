/**
 * Child-process entry for a background worker. Stands up a single worker agent
 * as an A2A service on an ephemeral localhost port and prints its agent-card URL
 * on stdout so the parent (TaskManager) can drive it.
 *
 * Launched as:  node --import tsx worker-entry.ts --kind=github
 * Env in:       WORKER_NEEDS_ANALYSIS=true|false  (picks cheap vs Pro model)
 * Stdout (one line, JSON):  {"ready":true,"agentCard":"http://127.0.0.1:<port>/.well-known/agent-card.json","port":<n>,"pid":<n>}
 */
import { createServer } from 'node:net';
import { toA2a } from '@google/adk';
import { config, readWorkerModel } from '../config/env.js';
import { createLogger } from '../logger.js';
import { WORKERS, isWorkerKind } from './workers/index.js';

const log = createLogger('worker');

/** `--kind=github` or `--kind github`. */
function arg(name: string): string | undefined {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Reserve an ephemeral port (small TOCTOU race, fine on localhost). */
function freePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, host, () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function main(): Promise<void> {
  const kind = arg('kind');
  if (!kind || !isWorkerKind(kind)) {
    log.error('unknown worker kind', { kind });
    process.exit(2);
  }
  const needsAnalysis = process.env.WORKER_NEEDS_ANALYSIS === 'true';
  const model = readWorkerModel(needsAnalysis);
  const agent = WORKERS[kind].build(model);

  const host = config.tasks.host;
  const port = await freePort(host);
  // basePath defaults to "" -> card lives at /.well-known/agent-card.json
  const app = await toA2a(agent, { host, port, protocol: 'http' });
  const server = app.listen(port, host, () => {
    const agentCard = `http://${host}:${port}/.well-known/agent-card.json`;
    log.info('worker ready', { kind, model: model.model, port });
    process.stdout.write(JSON.stringify({ ready: true, agentCard, port, pid: process.pid }) + '\n');
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  log.error('worker entry failed', e);
  process.exit(1);
});
