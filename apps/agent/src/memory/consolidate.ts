/**
 * Background memory consolidation. Every few hours, IF enough new facts have
 * piled up since the last pass, an LLM rewrites the whole memory bank: it merges
 * duplicates, drops outdated/contradicted facts, and keeps concise standalone
 * facts. Keeps the injected-into-prompt memory small and coherent over time.
 */
import { config, readModelConfig } from '../config/env.js';
import { createLogger } from '../logger.js';
import { allFacts, replaceFacts, unsummarizedCount } from './store.js';

const log = createLogger('memory');

const SYSTEM_PROMPT = [
  "You consolidate a personal voice assistant's long-term memory about its user.",
  'Given a list of remembered facts, return a cleaned-up list that:',
  '- merges duplicates and near-duplicates into a single fact;',
  '- drops outdated facts when a newer one contradicts them (keep the newer);',
  '- removes trivial or time-bound noise;',
  '- keeps each fact as one concise, standalone sentence in its original language.',
  'Do not invent facts. Return ONLY a JSON array of strings, nothing else.',
].join(' ');

/** Strips ```json fences and parses the array. */
function parseFacts(content: string): string[] | null {
  const body = content.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    const arr = JSON.parse(body) as unknown;
    if (Array.isArray(arr) && arr.every((x) => typeof x === 'string')) return arr;
  } catch {
    /* fall through */
  }
  return null;
}

async function summarizeFacts(texts: string[]): Promise<string[] | null> {
  const cfg = readModelConfig('MEMORY'); // falls back to LLM_*
  if (!cfg.apiKey || cfg.auth === 'gcloud') {
    log.warn('consolidation skipped: needs a static API key (apiKey auth)');
    return null;
  }
  const res = await fetch(`${cfg.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(texts) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`consolidation LLM error ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return parseFacts(data.choices?.[0]?.message?.content ?? '');
}

/** Runs one consolidation pass. Returns {before, after} or null if nothing to do. */
export async function consolidateMemory(): Promise<{ before: number; after: number } | null> {
  const facts = await allFacts();
  if (facts.length < 2) return null;
  const merged = await summarizeFacts(facts.map((f) => f.text));
  if (!merged) return null;
  await replaceFacts(merged);
  log.info('memory consolidated', { before: facts.length, after: merged.length });
  return { before: facts.length, after: merged.length };
}

/** Starts the periodic check. Consolidates only when enough facts are unsummarized. */
export function startConsolidationSchedule(): void {
  if (!config.memory.enabled) return;
  const everyMs = config.memory.consolidateHours * 3600_000;
  const tick = async () => {
    try {
      const pending = await unsummarizedCount();
      if (pending > config.memory.consolidateThreshold) {
        log.info('memory consolidation triggered', { unsummarized: pending });
        await consolidateMemory();
      }
    } catch (e) {
      log.error('memory consolidation failed', e);
    }
  };
  const timer = setInterval(tick, everyMs);
  timer.unref?.(); // don't keep the process alive just for this
  log.info('memory consolidation scheduled', {
    everyHours: config.memory.consolidateHours,
    threshold: config.memory.consolidateThreshold,
  });
}
