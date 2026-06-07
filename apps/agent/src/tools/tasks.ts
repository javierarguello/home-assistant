/**
 * Tools for delegating heavy work to background agents and checking on them.
 *
 * `start_task` kicks off a worker and returns immediately (the assistant should
 * tell the user it's on it). `check_tasks` reports what's running / recently
 * finished so the assistant can answer "¿qué están haciendo?" or "¿ya terminó?".
 */
import { FunctionTool } from '@google/adk';
import { z } from 'zod/v4';
import { config } from '../config/env.js';
import { taskManager } from '../tasks/instance.js';
import { WORKERS } from '../tasks/workers/index.js';
import { recentSummaries } from '../tasks/bank.js';

// Only offer the github worker when GitHub is enabled (research is always on).
const KINDS = (Object.keys(WORKERS) as string[]).filter(
  (k) => k !== 'github' || config.tools.github,
) as [string, ...string[]];

export const startTaskTool = new FunctionTool({
  name: 'start_task',
  description:
    'Delegate a heavy, multi-step job to a background agent. Kinds: "github" (investigate a repo — ' +
    'commits, diffs between branches/tags, PRs, deployments) and "research" (deep web research across ' +
    'many sources). Returns immediately with a task id; the work continues in the background and you ' +
    "will be told when it finishes. After calling this, tell the user you're on it. Use it instead of " +
    'doing such heavy work inline.',
  parameters: z.object({
    kind: z.enum(KINDS).describe('Which kind of background worker to use.'),
    request: z
      .string()
      .describe('The full task for the worker, in natural language, including any repo as "owner/repo".'),
    needsCodeAnalysis: z
      .boolean()
      .optional()
      .describe(
        'github only: set true ONLY when the task requires analyzing or reasoning about code (e.g. ' +
          'review a diff, assess risk of changes). Escalates to a stronger, costlier model. Leave ' +
          'false for lookups like listing commits, PRs, or deployments.',
      ),
    deep: z
      .boolean()
      .optional()
      .describe(
        'research only: set true when the user asks for a DEEP/thorough/exhaustive investigation ' +
          '("deep", "profundo", "a fondo", "exhaustivo"). Escalates to a stronger, slower model. ' +
          'Leave false for a quick/normal research.',
      ),
  }),
  execute: async ({ kind, request, needsCodeAnalysis, deep }) => {
    try {
      const info = await taskManager().start({ kind, request, needsCodeAnalysis, deep });
      return { taskId: info.id, kind: info.kind, status: 'started' };
    } catch (error) {
      return { error: (error as Error).message };
    }
  },
});

export const controlTaskTool = new FunctionTool({
  name: 'control_task',
  description:
    'Pause, resume, or cancel a background task the user asked to stop or hold. "cancel" kills it for ' +
    'good; "pause"/"resume" freeze and continue it. If the user does not say which task and only one is ' +
    'active, omit taskId. Use check_tasks first if you need the id.',
  parameters: z.object({
    action: z.enum(['cancel', 'pause', 'resume']).describe('What to do with the task.'),
    taskId: z.string().optional().describe('Which task; omit to target the single active one.'),
  }),
  execute: async ({ action, taskId }) => {
    try {
      const mgr = taskManager();
      const info = action === 'cancel' ? mgr.cancel(taskId) : action === 'pause' ? mgr.pause(taskId) : mgr.resume(taskId);
      return { ok: true, taskId: info.id, status: info.status };
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

export const taskTools = [startTaskTool, checkTasksTool, controlTaskTool];
