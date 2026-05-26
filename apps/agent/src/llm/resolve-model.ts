import { createGcloudTokenProvider } from '../auth/gcloud.js';
import { readModelConfig } from '../config/env.js';
import { OpenAiCompatibleLlm } from './openai-compatible-llm.js';

/**
 * Builds the LLM connector for a given agent from environment config.
 * Each agent can point at a different local or cloud OpenAI-compatible model.
 *
 * @param agentKey upper-snake-case agent name, e.g. `ROOT`, `WEB_SEARCH`.
 */
export function resolveModel(agentKey: string): OpenAiCompatibleLlm {
  const cfg = readModelConfig(agentKey);
  return new OpenAiCompatibleLlm({
    model: cfg.model,
    baseURL: cfg.baseURL,
    apiKey: cfg.apiKey,
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    // Vertex AI via the gcloud CLI: mint a fresh bearer token per request.
    getAuthToken: cfg.auth === 'gcloud' ? createGcloudTokenProvider(cfg.gcloudAccount) : undefined,
  });
}
