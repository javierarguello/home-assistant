/**
 * Worker registry: maps a task `kind` to its model policy and agent factory.
 * Add a new background worker type by registering its factory here.
 */
import type { LlmAgent } from '@google/adk';
import { type ModelConfig, readWorkerModel, readResearchModel } from '../../config/env.js';
import { createGithubWorker } from './github-worker.js';
import { createResearchWorker } from './research-worker.js';

export type WorkerKind = 'github' | 'research';

/** Per-run intent flags that drive model escalation. */
export interface RunOptions {
  /** github: the task needs to analyze/reason over code → stronger model. */
  needsCodeAnalysis: boolean;
  /** research: the user asked for a deep/thorough investigation → stronger model. */
  deep: boolean;
}

export interface WorkerSpec {
  /** Human label for the kiosk / logs. */
  label: string;
  /** Picks the model for a run (cheapest by default; may escalate per intent). */
  resolveModel: (opts: RunOptions) => ModelConfig;
  /** Builds the worker agent on a resolved model. */
  build: (model: ModelConfig) => LlmAgent;
}

export const WORKERS: Record<WorkerKind, WorkerSpec> = {
  github: {
    label: 'GitHub',
    resolveModel: (o) => readWorkerModel(o.needsCodeAnalysis),
    build: createGithubWorker,
  },
  research: {
    // Fast model by default; the stronger one only for deep investigations.
    label: 'Research',
    resolveModel: (o) => readResearchModel(o.deep),
    build: createResearchWorker,
  },
};

export function isWorkerKind(kind: string): kind is WorkerKind {
  return kind in WORKERS;
}
