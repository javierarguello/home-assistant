/**
 * Worker registry: maps a task `kind` to the agent factory that builds it.
 * Add a new background worker type by registering its factory here.
 */
import type { LlmAgent } from '@google/adk';
import type { ModelConfig } from '../../config/env.js';
import { createGithubWorker } from './github-worker.js';

export type WorkerKind = 'github';

export interface WorkerSpec {
  /** Human label for the kiosk / logs. */
  label: string;
  /** Builds the worker agent on a resolved model. */
  build: (model: ModelConfig) => LlmAgent;
}

export const WORKERS: Record<WorkerKind, WorkerSpec> = {
  github: { label: 'GitHub', build: createGithubWorker },
};

export function isWorkerKind(kind: string): kind is WorkerKind {
  return kind in WORKERS;
}
