/**
 * Interactive tools shared by EVERY worker, so any sub-agent supports the same
 * "stop and ask the user" interface. `ask_user` is a LongRunningFunctionTool:
 * when the worker calls it, ADK's A2A layer puts the task in `input-required`
 * (carrying the question + options), the TaskManager surfaces it to the user
 * (voice + on-screen options), and the user's answer resumes the worker.
 */
import { LongRunningFunctionTool } from '@google/adk';
import { z } from 'zod/v4';

/** The worker pauses and asks the user a question. */
export const askUserTool = new LongRunningFunctionTool({
  name: 'ask_user',
  description:
    'Pause and ask the USER a question, then wait for their answer before continuing. Use it when the ' +
    'task is ambiguous, blocked, or needs a decision only the user can make. Provide clear options when ' +
    'the answer is a choice. After calling this, STOP — your turn ends until the user answers; their ' +
    'answer arrives as a normal message and you continue from there.',
  parameters: z.object({
    question: z.string().describe('The question for the user, in their language. Be specific and concise.'),
    options: z
      .array(z.string())
      .optional()
      .describe('Optional answer choices (e.g. ["Sí", "No"]). Omit for a free-form answer.'),
  }),
  // The return is provisional — the task pauses (input-required) regardless; the
  // real answer comes back from the user and resumes the run.
  execute: async ({ question }) => ({ status: 'waiting_for_user', asked: question }),
});

export const interactiveTools = [askUserTool];
