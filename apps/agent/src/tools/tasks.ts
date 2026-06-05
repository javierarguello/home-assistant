/**
 * Tools for delegating heavy work to background agents and checking on them.
 *
 * `start_task` kicks off a worker and returns immediately (the assistant should
 * tell the user it's on it). `check_tasks` reports what's running / recently
 * finished so the assistant can answer "¿qué están haciendo?" or "¿ya terminó?".
 */
import { FunctionTool } from '@google/adk';
import { z } from 'zod/v4';
import { taskManager } from '../tasks/instance.js';
import { WORKERS } from '../tasks/workers/index.js';
import { recentSummaries } from '../tasks/bank.js';

const KINDS = Object.keys(WORKERS) as [string, ...string[]];

export const startTaskTool = new FunctionTool({
  name: 'start_task',
  description:
    'Delegate a heavy, multi-step job to a background agent (e.g. investigating a GitHub repo: ' +
    'commits, diffs between branches/tags, PRs, deployments). Returns immediately with a task id; ' +
    'the work continues in the background and you will be told when it finishes. After calling this, ' +
    "tell the user you're on it. Use it instead of doing such work inline.",
  parameters: z.object({
    kind: z.enum(KINDS).describe('Which kind of background worker to use.'),
    request: z
      .string()
      .describe('The full task for the worker, in natural language, including any repo as "owner/repo".'),
    needsCodeAnalysis: z
      .boolean()
      .optional()
      .describe(
        'Set true ONLY when the task requires analyzing or reasoning about code (e.g. review a diff, ' +
          'assess risk of changes). This escalates to a stronger, costlier model. Leave false/omitted ' +
          'for lookups like listing commits, PRs, or deployments.',
      ),
  }),
  execute: async ({ kind, request, needsCodeAnalysis }) => {
    try {
      const info = await taskManager().start({ kind, request, needsCodeAnalysis });
      return { taskId: info.id, kind: info.kind, status: 'started' };
    } catch (error) {
      return { error: (error as Error).message };
    }
  },
});

export const checkTasksTool = new FunctionTool({
  name: 'check_tasks',
  description:
    'List the background tasks that are running or recently finished, plus a few summaries of older ' +
    'completed work. Use it to answer what the agents are doing, whether something finished, or to ' +
    'recall what a past task found.',
  parameters: z.object({}),
  execute: async () => {
    const active = taskManager().list();
    const past = await recentSummaries(5);
    return {
      active: active.map((t) => ({
        id: t.id,
        kind: t.kind,
        title: t.title,
        status: t.status,
        step: t.step,
        analysis: t.analysis,
      })),
      recent: past.map((s) => ({ kind: s.kind, title: s.title, summary: s.text })),
    };
  },
});

export const taskTools = [startTaskTool, checkTasksTool];
