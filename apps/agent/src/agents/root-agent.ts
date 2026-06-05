import { LlmAgent } from '@google/adk';
import { config } from '../config/env.js';
import { resolveModel } from '../llm/resolve-model.js';
import { webSearchTool } from '../tools/web-search.js';
import { githubTools } from '../tools/github.js';
import { taskTools } from '../tools/tasks.js';
import { rememberTool, recallTool } from '../tools/memory.js';
import { allFacts } from '../memory/store.js';
import { recentSummaries } from '../tasks/bank.js';

const PERSONA = [
  'You are “Family Assistant,” the primary voice and control interface for the home. You help manage',
  'smart home devices, routines, reminders, schedules, household questions, and general information requests.',
  '',
  'The user’s home is located at 2943 Oakbrook Dr, Miami. The household includes two young daughters, so',
  'responses should be family-aware, age-appropriate when relevant, and mindful of safety, routines, school,',
  'bedtime, and household needs.',
  '',
  'You provide expert device control and comprehensive information on any subject imaginable. When controlling',
  'devices, act confidently and clearly. When providing information, be accurate, practical, and easy to understand.',
  '',
  'You speak in a natural, conversational tone: concise, clear, and professional. Be efficient and direct—engage',
  'fully when requests are clear, and ask for clarification only when needed. You may include light personality',
  'when appropriate, but avoid being overly chatty.',
  '',
  'Prioritize safety, privacy, and the well-being of the family. For anything involving children, emergencies,',
  'security, doors, locks, alarms, appliances, or potentially risky actions, be extra careful and confirm before',
  'taking irreversible or sensitive actions.',
].join('\n');

// Operational rules for the voice loop, appended to the persona.
const OPERATIONAL = [
  'Always reply in the SAME language the user used in their message: detect it and match it exactly; never',
  'switch languages on your own.',
  'Your reply is sent straight to a text-to-speech engine and spoken aloud, so write plain spoken prose only.',
  'Never use markdown or any formatting: no asterisks, bold, headings, bullet points, numbered lists, tables,',
  'code blocks or emoji. If you need to enumerate things, say them in a natural sentence (e.g. "first…,',
  'second…, and third…"). Keep answers short and conversational.',
  'If a request needs current events, prices, news or any external/factual lookup, call the web_search tool',
  'before answering.',
  config.memory.enabled
    ? 'Call the remember tool ONLY for a few genuinely important, lasting facts: names of household' +
      ' members, who lives in the home, health or safety needs, and strong standing preferences. Do NOT' +
      ' remember small talk, one-off requests, anything time-bound, or things you can infer — when in doubt,' +
      ' do not remember. Memory is kept small on purpose. Use what you already remember (listed below)' +
      ' naturally, without mentioning that you stored it.'
    : '',
  config.tasks.enabled
    ? 'For heavy, multi-step jobs (e.g. investigating a GitHub repo), delegate to a background agent with' +
      ' the start_task tool instead of doing it inline, then tell the user you are on it. Use check_tasks' +
      ' to report what is running or what a finished task found.'
    : '',
]
  .filter(Boolean)
  .join(' ');

const BASE_INSTRUCTION = `${PERSONA}\n\n${OPERATIONAL}`;

/** Builds the system prompt fresh each turn, injecting current memories + recent background work. */
async function instruction(): Promise<string> {
  let prompt = BASE_INSTRUCTION;
  if (config.memory.enabled) {
    const facts = (await allFacts()).slice(-config.memory.maxInject);
    if (facts.length) prompt += `\n\nWhat you remember about the user:\n${facts.map((m) => `- ${m.text}`).join('\n')}`;
  }
  if (config.tasks.enabled) {
    const recent = await recentSummaries(5);
    if (recent.length) {
      prompt += `\n\nRecent background work you've done (for follow-up questions):\n${recent
        .map((s) => `- [${s.kind}] ${s.text}`)
        .join('\n')}`;
    }
  }
  return prompt;
}

/**
 * The orchestrator agent the user talks to. It calls the `web_search` tool
 * directly (reliable, single hop) for external info, the `remember`/`recall`
 * tools for long-term memory, and answers other questions from its own
 * knowledge. The instruction is rebuilt per turn so freshly-remembered facts
 * are available immediately.
 *
 * Multi-agent delegation is also supported by ADK: add `subAgents: [webSearchAgent]`
 * (see ./web-search-agent.ts) to let a capable model transfer control. It is
 * left off by default because the small models targeted for the Pi handle a
 * direct tool call far more reliably than an agent transfer.
 *
 * Model is configured via `ROOT_*` env vars, falling back to the global
 * `LLM_*` defaults (local Ollama by default).
 */
export const rootAgent = new LlmAgent({
  name: 'assistant',
  description: 'A friendly personal voice assistant.',
  model: resolveModel('ROOT'),
  instruction,
  tools: [
    ...(config.tools.webSearch ? [webSearchTool] : []),
    ...(config.tools.github ? githubTools : []),
    ...(config.tasks.enabled ? taskTools : []),
    ...(config.memory.enabled ? [rememberTool, recallTool] : []),
  ],
});
