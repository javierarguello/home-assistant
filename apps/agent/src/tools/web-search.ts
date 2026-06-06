/**
 * A provider-agnostic web-search tool.
 *
 * Note: ADK ships a built-in `GOOGLE_SEARCH` tool, but it only works with
 * Gemini grounding — not with OpenAI-compatible/local models. This custom
 * `FunctionTool` works with any model.
 *
 * Uses Tavily when `TAVILY_API_KEY` is set (better results), otherwise falls
 * back to the keyless DuckDuckGo Instant Answer API.
 */
import { FunctionTool } from '@google/adk';
// Import from the same zod build ADK uses for tool schemas (`zod/v4`).
import { z } from 'zod/v4';
import { config } from '../config/env.js';
import { emitDetail, escapeHtml } from './detail.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Runs a web search via the configured backend (Brave > Tavily > DuckDuckGo). */
export async function searchWeb(query: string): Promise<SearchResult[]> {
  return config.tools.braveApiKey
    ? searchBrave(query)
    : config.tools.tavilyApiKey
      ? searchTavily(query)
      : searchDuckDuckGo(query);
}

export const webSearchTool = new FunctionTool({
  name: 'web_search',
  description:
    'Search the web for current or factual information. Returns a short list ' +
    'of results (title, snippet, url). Use it whenever the answer may depend ' +
    'on recent or external information.',
  parameters: z.object({
    query: z.string().describe('The search query, in natural language.'),
  }),
  execute: async ({ query }) => {
    try {
      const results = await searchWeb(query);
      // Push a rich, clickable list to the kiosk sidebar (not spoken).
      if (results.length) {
        const items = results
          .map(
            (r) =>
              `<li><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.title)}</a>` +
              `<div class="snip">${escapeHtml(r.snippet)}</div></li>`,
          )
          .join('');
        emitDetail(`Búsqueda: ${query}`, `<ul class="results">${items}</ul>`);
      }
      return { query, results };
    } catch (error) {
      return { query, error: (error as Error).message, results: [] as SearchResult[] };
    }
  },
});

async function searchBrave(query: string): Promise<SearchResult[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', '5');
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': config.tools.braveApiKey,
    },
  });
  if (!res.ok) throw new Error(`Brave error ${res.status}`);
  const data = (await res.json()) as {
    web?: { results?: Array<{ title: string; url: string; description: string }> };
  };
  return (data.web?.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.description,
  }));
}

async function searchTavily(query: string): Promise<SearchResult[]> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: config.tools.tavilyApiKey,
      query,
      search_depth: 'basic',
      max_results: 5,
      include_answer: false,
    }),
  });
  if (!res.ok) throw new Error(`Tavily error ${res.status}`);
  const data = (await res.json()) as { results?: Array<{ title: string; url: string; content: string }> };
  return (data.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content }));
}

async function searchDuckDuckGo(query: string): Promise<SearchResult[]> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`DuckDuckGo error ${res.status}`);
  const data = (await res.json()) as {
    Heading?: string;
    AbstractText?: string;
    AbstractURL?: string;
    RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
  };

  const results: SearchResult[] = [];
  if (data.AbstractText) {
    results.push({
      title: data.Heading ?? query,
      url: data.AbstractURL ?? '',
      snippet: data.AbstractText,
    });
  }
  for (const topic of data.RelatedTopics ?? []) {
    if (topic.Text && topic.FirstURL) {
      results.push({ title: topic.Text.slice(0, 80), url: topic.FirstURL, snippet: topic.Text });
    }
    if (results.length >= 5) break;
  }
  return results;
}
