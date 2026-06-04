import { LlmAgent } from '@google/adk';
import { config } from '../config/env.js';
import { resolveModel } from '../llm/resolve-model.js';
import { webSearchTool } from '../tools/web-search.js';

/**
 * The orchestrator agent the user talks to. It calls the `web_search` tool
 * directly (reliable, single hop) for external info, and answers other
 * questions from its own knowledge.
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
  instruction: [
    `You are ${config.assistant.name}, a friendly, concise personal voice assistant.`,
    'Your answers are read aloud by a text-to-speech engine, so keep them short,',
    'natural and free of markdown, lists or emoji unless asked.',
    'Always reply in the SAME language the user used in their message: detect it',
    'and match it exactly; never switch languages on your own.',
    'If a question needs current events, prices, news or any external/factual',
    'lookup, call the web_search tool before answering. For everything else,',
    'answer directly from your own knowledge.',
  ].join(' '),
  tools: config.tools.webSearch ? [webSearchTool] : [],
});
