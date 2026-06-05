import { createGcloudTokenProvider } from '../auth/gcloud.js';
import { readModelConfig, type ModelConfig } from '../config/env.js';
import { OpenAiCompatibleLlm } from './openai-compatible-llm.js';

/** Builds an LLM connector from an already-resolved {@link ModelConfig}. */
export function buildModel(cfg: ModelConfig): OpenAiCompatibleLlm {
  return new OpenAiCompatibleLlm({
    model: cfg.model,
    baseURL: cfg.baseURL,
    apiKey: cfg.apiKey,
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    think: cfg.think,
    // Vertex AI via the gcloud CLI: mint a fresh bearer token per request.
    getAuthToken: cfg.auth === 'gcloud' ? createGcloudTokenProvider(cfg.gcloudAccount) : undefined,
  });
}

/**
 * Builds the LLM connector for a given agent from environment config.
 * Each agent can point at a different local or cloud OpenAI-compatible model.
 *
 * @param agentKey upper-snake-case agent name, e.g. `ROOT`, `WEB_SEARCH`.
 */
export function resolveModel(agentKey: string): OpenAiCompatibleLlm {
  return buildModel(readModelConfig(agentKey));
}
