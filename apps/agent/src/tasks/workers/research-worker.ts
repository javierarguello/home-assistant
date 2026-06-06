/**
 * Research worker — a deep web-research background agent. Runs on a stronger
 * reasoning model (thinking on) and works a plan: it drafts a plan, executes it
 * with budgeted web searches, revises the plan each turn, and can stop to ask
 * the user for feedback. The turn budget keeps it from running away.
 */
import { LlmAgent } from '@google/adk';
import type { ModelConfig } from '../../config/env.js';
import { config } from '../../config/env.js';
import { buildModel } from '../../llm/resolve-model.js';
import { researchTools } from './research-tools.js';

const PROMPT = [
  'You are a research agent working a single delegated question in the background.',
  'You are NOT chatting with a person — another agent gave you the task and will read your final',
  'message as a report. Work autonomously, plan-first, and finish within your turn budget.',
  '',
  'How to work:',
  '1. Call update_plan FIRST with a short initial plan (3–6 concrete steps).',
  '2. Then loop: pick the next step, use web_research (one focused query per call), and think about',
  '   what you found. Cross-check important claims across independent sources before trusting them.',
  `3. Every turn, call update_plan to mark progress (done/doing), add steps you discover, or drop ones`,
  '   that no longer matter. Keep the plan tight.',
  `4. You have about ${config.tasks.researchMaxTurns} search turns total — spend them deliberately. When the`,
  '   budget is gone, stop searching and synthesize.',
  '5. If the task is ambiguous, blocked, or needs a real decision, call request_feedback and then end',
  '   your turn with the question — do not guess on important forks.',
  '',
  'Final report: plain prose (no markdown). Lead with the answer, then the key supporting findings,',
  'then the main source URLs. Be accurate and concise; flag uncertainty honestly.',
].join('\n');

/** Builds the research worker agent on the given (strong, thinking) model. */
export function createResearchWorker(model: ModelConfig): LlmAgent {
  return new LlmAgent({
    name: 'research_worker',
    description: 'Deep web research: plans, searches across sources, and synthesizes a cited answer.',
    model: buildModel(model),
    instruction: PROMPT,
    tools: researchTools,
  });
}
