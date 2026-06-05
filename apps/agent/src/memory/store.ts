/**
 * Long-term memory store: a small JSON file of durable facts about the user,
 * their home and preferences. Written by the `remember` tool, read by `recall`
 * and injected into the agent's prompt. A background job periodically
 * consolidates it (see ./consolidate.ts).
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config/env.js';
import { createLogger } from '../logger.js';

const log = createLogger('memory');

export interface Memory {
  id: string;
  text: string;
  category?: string;
  /** Epoch millis when stored. */
  ts: number;
}

interface Store {
  memories: Memory[];
  /** Epoch millis of the last consolidation; facts newer than this are "unsummarized". */
  lastConsolidatedAt: number;
}

let cache: Store | undefined;

async function load(): Promise<Store> {
  if (cache) return cache;
  try {
    const raw = JSON.parse(await readFile(config.memory.file, 'utf8')) as unknown;
    cache = Array.isArray(raw)
      ? { memories: raw as Memory[], lastConsolidatedAt: 0 } // tolerate a bare-array file
      : (raw as Store);
  } catch {
    cache = { memories: [], lastConsolidatedAt: 0 };
  }
  return cache;
}

async function persist(): Promise<void> {
  if (!cache) return;
  await mkdir(dirname(config.memory.file), { recursive: true });
  await writeFile(config.memory.file, JSON.stringify(cache, null, 2));
}

/** Stores a fact (idempotent on identical text). */
export async function rememberFact(text: string, category?: string): Promise<Memory> {
  const store = await load();
  const clean = text.trim();
  const existing = store.memories.find((m) => m.text.toLowerCase() === clean.toLowerCase());
  if (existing) return existing;
  const mem: Memory = { id: randomUUID().slice(0, 8), text: clean, category, ts: Date.now() };
  store.memories.push(mem);
  await persist();
  log.info('remembered', { id: mem.id, text: clean.slice(0, 60) });
  return mem;
}

/** Keyword search over stored facts, best matches first. */
export async function recallFacts(query: string, limit = 6): Promise<Memory[]> {
  const { memories } = await load();
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);
  if (!terms.length) return memories.slice(-limit);
  return memories
    .map((m) => ({ m, score: terms.filter((t) => m.text.toLowerCase().includes(t)).length }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.m);
}

export async function allFacts(): Promise<Memory[]> {
  return [...(await load()).memories];
}

/** Count of facts added since the last consolidation. */
export async function unsummarizedCount(): Promise<number> {
  const store = await load();
  return store.memories.filter((m) => m.ts > store.lastConsolidatedAt).length;
}

/** Replaces the whole store with a consolidated set and marks it summarized now. */
export async function replaceFacts(texts: string[]): Promise<void> {
  const store = await load();
  const now = Date.now();
  store.memories = texts
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => ({ id: randomUUID().slice(0, 8), text: t, ts: now }));
  store.lastConsolidatedAt = now;
  await persist();
}
