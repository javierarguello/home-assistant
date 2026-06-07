/**
 * Task memory bank: a small ring buffer (≤ config.tasks.bankMax) of brief
 * summaries of past background tasks, so the assistant can answer follow-ups
 * about work it did earlier ("¿qué encontraste en el repo?"). Mirrors the
 * long-term memory store (../memory/store.ts) but is a separate, capped file.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config, readModelConfig } from '../config/env.js';
import { createLogger } from '../logger.js';

const log = createLogger('tasks');

export interface TaskSummary {
  id: string;
  kind: string;
  title: string;
  text: string;
  /** Epoch millis when the task finished/was summarized. */
  ts: number;
}

interface Bank {
  summaries: TaskSummary[];
}

let cache: Bank | undefined;

async function load(): Promise<Bank> {
  if (cache) return cache;
  try {
    const raw = JSON.parse(await readFile(config.tasks.bankFile, 'utf8')) as unknown;
    cache = Array.isArray(raw) ? { summaries: raw as TaskSummary[] } : (raw as Bank);
  } catch {
    cache = { summaries: [] };
  }
  return cache;
}

async function persist(): Promise<void> {
  if (!cache) return;
  await mkdir(dirname(config.tasks.bankFile), { recursive: true });
  await writeFile(config.tasks.bankFile, JSON.stringify(cache, null, 2));
}

/** Records a finished task, trimming the bank to the newest `bankMax`. */
export async function addSummary(kind: string, title: string, text: string): Promise<TaskSummary> {
  const bank = await load();
  const entry: TaskSummary = { id: randomUUID().slice(0, 8), kind, title, text: text.trim(), ts: Date.now() };
  bank.summaries.push(entry);
  if (bank.summaries.length > config.tasks.bankMax) {
    bank.summaries = bank.summaries.slice(-config.tasks.bankMax);
  }
  await persist();
  log.info('task summary banked', { id: entry.id, kind, title: title.slice(0, 60) });
  return entry;
}

export async function recentSummaries(limit = 5): Promise<TaskSummary[]> {
  return (await load()).summaries.slice(-limit);
}

/** Keyword search over past task summaries (same scoring shape as recallFacts). */
export async function searchSummaries(query: string, limit = 5): Promise<TaskSummary[]> {
  const { summaries } = await load();
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  if (!terms.length) return summaries.slice(-limit);
  const hay = (s: TaskSummary) => `${s.title} ${s.text}`.toLowerCase();
  return summaries
    .map((s) => ({ s, score: terms.filter((t) => hay(s).includes(t)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.s);
}

const SUMMARY_PROMPT = [
  'You write a short recap of a background task the assistant just finished, for its memory so it can',
  'tell the user about it later. In 2–4 sentences capture the request and the key findings/result —',
  'be specific (numbers, names, repo/branch, the actual answer). Plain prose, no markdown. Return ONLY',
  'the recap, nothing else.',
].join(' ');

/**
 * Produces a brief recap of a task's work via the cheap worker model. Returns
 * null if no static API key is available (same limitation as memory
 * consolidation — agent-initiated calls can't use gcloud bearer tokens here).
 */
export async function summarizeTask(request: string, result: string): Promise<string | null> {
  const cfg = readModelConfig('WORKER'); // cheap model; falls back to LLM_*
  if (!cfg.apiKey || cfg.auth === 'gcloud') {
    log.warn('task summary skipped: needs a static API key (apiKey auth)');
    return null;
  }
  try {
    const res = await fetch(`${cfg.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.3,
        messages: [
          { role: 'system', content: SUMMARY_PROMPT },
          { role: 'user', content: `Request:\n${request}\n\nResult:\n${result}` },
        ],
      }),
    });
    if (!res.ok) throw new Error(`summary LLM error ${res.status}`);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content?.trim();
    return text || null;
  } catch (e) {
    log.error('task summary failed', e);
    return null;
  }
}
