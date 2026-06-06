/**
 * Worker registry: maps a task `kind` to its model policy and agent factory.
 * Add a new background worker type by registering its factory here.
 */
import type { LlmAgent } from '@google/adk';
import { type ModelConfig, readWorkerModel, readResearchModel } from '../../config/env.js';
import { createGithubWorker } from './github-worker.js';
import { createResearchWorker } from './research-worker.js';

export type WorkerKind = 'github' | 'research';

export interface WorkerSpec {
  /** Human label for the kiosk / logs. */
  label: string;
  /** Picks the model for a run (cheapest by default; may escalate). */
  resolveModel: (needsCodeAnalysis: boolean) => ModelConfig;
  /** Builds the worker agent on a resolved model. */
  build: (model: ModelConfig) => LlmAgent;
}

export const WORKERS: Record<WorkerKind, WorkerSpec> = {
  github: {
    label: 'GitHub',
    resolveModel: (needsCodeAnalysis) => readWorkerModel(needsCodeAnalysis),
    build: createGithubWorker,
  },
  research: {
    // Research always uses a stronger reasoning model with thinking on.
    label: 'Research',
    resolveModel: () => readResearchModel(),
    build: createResearchWorker,
  },
};

export function isWorkerKind(kind: string): kind is WorkerKind {
  return kind in WORKERS;
}
