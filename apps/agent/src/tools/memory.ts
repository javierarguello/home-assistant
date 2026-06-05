/**
 * Long-term memory tools. `remember` persists a durable fact; `recall` searches
 * stored facts. Facts are also injected into the agent's prompt each turn (see
 * agents/root-agent.ts), so `recall` is mainly for details beyond that window.
 */
import { FunctionTool } from '@google/adk';
import { z } from 'zod/v4';
import { rememberFact, recallFacts } from '../memory/store.js';

export const rememberTool = new FunctionTool({
  name: 'remember',
  description:
    'Save a durable fact about the user, their home, family, routines or ' +
    'preferences so you can use it in future conversations. Call this whenever ' +
    'the user shares something worth remembering long-term (e.g. their name, ' +
    'where they work, who lives with them, likes/dislikes). Do NOT save ' +
    'one-off, trivial or time-bound details.',
  parameters: z.object({
    fact: z
      .string()
      .describe('The fact to remember, as a short standalone sentence in the user\'s language.'),
    category: z
      .string()
      .optional()
      .describe('Optional grouping, e.g. "personal", "home", "preferences".'),
  }),
  execute: async ({ fact, category }) => {
    const mem = await rememberFact(fact, category);
    return { ok: true, id: mem.id };
  },
});

export const recallTool = new FunctionTool({
  name: 'recall',
  description:
    'Search your long-term memory for facts about the user relevant to a query. ' +
    'Use it when answering needs details the user may have told you before.',
  parameters: z.object({
    query: z.string().describe('What to look up, in natural language.'),
  }),
  execute: async ({ query }) => {
    const memories = await recallFacts(query);
    return { memories: memories.map((m) => m.text) };
  },
});
