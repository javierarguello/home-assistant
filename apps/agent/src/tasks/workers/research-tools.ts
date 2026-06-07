/**
 * Tools for the research worker: a living plan, a budgeted web-search, and a way
 * to stop and ask the user for feedback. State is module-level — fine because
 * each task runs in its own dedicated worker process.
 */
import { FunctionTool } from '@google/adk';
import { z } from 'zod/v4';
import { config } from '../../config/env.js';
import { searchWeb } from '../../tools/web-search.js';

type StepStatus = 'pending' | 'doing' | 'done' | 'dropped';
interface PlanStep {
  task: string;
  status: StepStatus;
}

const MAX_TURNS = config.tasks.researchMaxTurns;
const state = { turns: 0, plan: [] as PlanStep[] };

const renderPlan = () =>
  state.plan.length
    ? state.plan.map((s, i) => `${i + 1}. [${s.status}] ${s.task}`).join('\n')
    : '(empty)';

const updatePlanTool = new FunctionTool({
  name: 'update_plan',
  description:
    'Create or revise your research plan. Call this FIRST with an initial plan, then again every turn ' +
    'to mark steps done/doing, add new steps you discover, or drop ones that became irrelevant. Pass ' +
    'the FULL updated list each time (it replaces the plan). Keeps you focused and bounded.',
  parameters: z.object({
    steps: z
      .array(
        z.object({
          task: z.string().describe('A concise research step.'),
          status: z.enum(['pending', 'doing', 'done', 'dropped']).describe('Step state.'),
        }),
      )
      .describe('The full, updated plan (replaces the previous one).'),
  }),
  execute: async ({ steps }) => {
    state.plan = steps;
    return { plan: renderPlan(), turnsUsed: state.turns, turnsLeft: Math.max(0, MAX_TURNS - state.turns) };
  },
});

const webResearchTool = new FunctionTool({
  name: 'web_research',
  description:
    'Search the web for one focused query and get results (title, snippet, url). Each call uses one ' +
    'research turn; you have a limited budget, so search deliberately. When the budget runs out you ' +
    'must stop searching and write your final report from what you have.',
  parameters: z.object({
    query: z.string().describe('A single focused search query.'),
  }),
  execute: async ({ query }) => {
    if (state.turns >= MAX_TURNS) {
      return {
        stop: true,
        message: `Turn budget reached (${MAX_TURNS}). Stop searching and write your final report now from what you have.`,
        turnsLeft: 0,
      };
    }
    state.turns += 1;
    try {
      const results = await searchWeb(query);
      return { query, results, turnsUsed: state.turns, turnsLeft: MAX_TURNS - state.turns };
    } catch (error) {
      return { query, error: (error as Error).message, results: [], turnsLeft: MAX_TURNS - state.turns };
    }
  },
});

// To stop and ask the user, the worker uses the shared `ask_user` tool
// (see ./interactive-tools.ts), which pauses the task until the user answers.
export const researchTools = [updatePlanTool, webResearchTool];
