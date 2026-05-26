/**
 * Diagnostics logger. Writes timestamped, leveled lines to `<LOG_DIR>/agent.log`
 * (everything at or above LOG_LEVEL) and mirrors warnings/errors to the console.
 * Routine info/debug stay out of the console so the chat REPL stays readable;
 * the full trace is always in the file for later diagnosis.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config/env.js';

type Level = 'debug' | 'info' | 'warn' | 'error';
const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const threshold = RANK[config.logLevel] ?? RANK.info;
export const logFilePath = join(config.logDir, 'agent.log');

// Synchronous appends: simple, ordered, and crash-safe (the last lines before a
// crash/exit are already on disk). Log volume is low (a few lines per turn).
try {
  mkdirSync(config.logDir, { recursive: true });
} catch {
  /* best effort */
}

function stringify(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return ` ${value}`;
  if (value instanceof Error) return ` ${value.stack ?? value.message}`;
  try {
    return ` ${JSON.stringify(value)}`;
  } catch {
    return ` ${String(value)}`;
  }
}

function write(level: Level, scope: string, message: string, extra?: unknown): void {
  if (RANK[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${stringify(extra)}`;
  // Console: errors/warnings always; everything else only in live mode.
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else if (config.logConsole) console.log(line);
  try {
    appendFileSync(logFilePath, `${line}\n`);
  } catch {
    /* never let logging break the app */
  }
}

export interface Logger {
  debug(message: string, extra?: unknown): void;
  info(message: string, extra?: unknown): void;
  warn(message: string, extra?: unknown): void;
  error(message: string, extra?: unknown): void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, e) => write('debug', scope, m, e),
    info: (m, e) => write('info', scope, m, e),
    warn: (m, e) => write('warn', scope, m, e),
    error: (m, e) => write('error', scope, m, e),
  };
}
