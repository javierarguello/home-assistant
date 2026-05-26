import { LlmAgent } from '@google/adk';
import { resolveModel } from '../llm/resolve-model.js';
import { webSearchTool } from '../tools/web-search.js';

/**
 * A specialized sub-agent that answers questions needing current/external
 * information using the {@link webSearchTool}. The root agent can transfer
 * control to it. Configure its model independently via `WEB_SEARCH_*` env vars
 * (e.g. point it at a stronger cloud model while the root runs locally).
 */
export const webSearchAgent = new LlmAgent({
  name: 'web_search_agent',
  description: 'Answers questions that require searching the web for current or factual information.',
  model: resolveModel('WEB_SEARCH'),
  instruction:
    'You are a research assistant. Use the web_search tool to find current, ' +
    'factual information, then answer concisely citing the source domain. ' +
    'Reply in the same language the user used.',
  tools: [webSearchTool],
});
