/**
 * GitHub investigator worker — a focused background agent with its own prompt
 * and the github_* tools. Spawned as an A2A service (see ../worker-entry.ts) and
 * driven by the TaskManager; it never talks to the user directly, so its output
 * is a self-contained findings report.
 */
import { LlmAgent } from '@google/adk';
import type { ModelConfig } from '../../config/env.js';
import { buildModel } from '../../llm/resolve-model.js';
import { githubTools } from '../../tools/github.js';

const PROMPT = [
  'You are a GitHub investigator agent working a single delegated task in the background.',
  'You are NOT chatting with a person — another agent gave you a task and will read your',
  'final message as a report. Work autonomously to completion.',
  '',
  'Use the github_* tools (commits, compare refs, pull requests, deployments) to gather the',
  'facts you need. The user names repositories as "owner/repo"; pass that through. Make as',
  'many tool calls as needed, but do not loop pointlessly.',
  '',
  'When done, reply with a single concise findings report in plain prose (no markdown):',
  'lead with the answer, then the few supporting specifics (commit/PR numbers, counts, refs).',
  'If you could not complete the task, say what blocked you. Keep it tight — it may be read aloud.',
].join('\n');

/** Builds the GitHub worker agent on the given model. */
export function createGithubWorker(model: ModelConfig): LlmAgent {
  return new LlmAgent({
    name: 'github_worker',
    description: 'Investigates GitHub repositories: commits, diffs between refs, PRs, deployments.',
    model: buildModel(model),
    instruction: PROMPT,
    tools: githubTools,
  });
}
