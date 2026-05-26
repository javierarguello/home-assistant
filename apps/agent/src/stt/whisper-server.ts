/**
 * Local STT via the whisper.cpp HTTP server (`whisper-server`).
 *
 * Unlike the per-utterance `whisper-cli` (which reloads the ~150 MB model every
 * time), the server keeps the model in memory, so transcription is fast on
 * every turn. If the server isn't running and autostart is enabled, it is
 * spawned (detached) on first use and left running so repeated runs reuse it.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { config } from '../config/env.js';
import { createLogger } from '../logger.js';

const log = createLogger('stt');

let ensurePromise: Promise<void> | undefined;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Any HTTP reply means the server is listening; a connection error means down. */
async function serverIsUp(): Promise<boolean> {
  try {
    await fetch(config.stt.whisperServerUrl, { method: 'GET' });
    return true;
  } catch {
    return false;
  }
}

async function startServer(): Promise<void> {
  const url = new URL(config.stt.whisperServerUrl);
  const logPath = join(config.logDir, 'whisper-server.log');
  mkdirSync(config.logDir, { recursive: true });
  const fd = openSync(logPath, 'a');

  const child = spawn(
    config.stt.whisperServerBinary,
    [
      '-m', config.stt.whisperModel,
      '--host', url.hostname,
      '--port', url.port || '8088',
      '-l', config.stt.language,
      '-t', String(config.stt.whisperThreads),
      '-nt',
    ],
    { detached: true, stdio: ['ignore', fd, fd] },
  );
  child.on('error', (e) => {
    throw new Error(
      `Failed to start whisper-server (${config.stt.whisperServerBinary}): ${e.message}`,
    );
  });
  child.unref(); // survive this process, so repeated runs reuse the warm server

  log.info('starting whisper-server (loading model)', { logPath, model: config.stt.whisperModel });
  const deadline = Date.now() + 90_000; // model load can take a while on the Pi
  while (Date.now() < deadline) {
    if (await serverIsUp()) {
      log.info('whisper-server ready');
      return;
    }
    await delay(500);
  }
  throw new Error(`whisper-server did not become ready in time. See ${logPath}`);
}

async function ensureServer(): Promise<void> {
  if (await serverIsUp()) return;
  if (!config.stt.whisperServerAutostart) {
    throw new Error(
      `whisper-server is not running at ${config.stt.whisperServerUrl} and ` +
        `WHISPER_SERVER_AUTOSTART=false.`,
    );
  }
  if (!ensurePromise) {
    ensurePromise = startServer().finally(() => {
      ensurePromise = undefined;
    });
  }
  await ensurePromise;
}

export async function transcribeWhisperServer(wavPath: string): Promise<string> {
  await ensureServer();
  const bytes = await readFile(wavPath);
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'audio/wav' }), basename(wavPath));
  form.append('response_format', 'json');

  const res = await fetch(new URL('/inference', config.stt.whisperServerUrl), {
    method: 'POST',
    body: form,
  });
  if (!res.ok) throw new Error(`whisper-server error ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { text?: string };
  return (data.text ?? '').trim();
}
