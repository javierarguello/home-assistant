/**
 * Current date/time tool. The model has no live clock, so it must call this for
 * anything time-relative (what time/day is it, "today", "this month", scheduling…).
 */
import { FunctionTool } from '@google/adk';
import { z } from 'zod/v4';
import { config } from '../config/env.js';

export const datetimeTool = new FunctionTool({
  name: 'current_datetime',
  description:
    'Get the CURRENT date and time right now (day of week, day, month, year, hour, minute). ' +
    'You do not otherwise know the current time, so call this whenever the answer depends on it ' +
    '(e.g. "what time is it", "what day is today", "what is the date", or any "now/today/this week" reasoning).',
  parameters: z.object({
    timezone: z
      .string()
      .optional()
      .describe('Optional IANA timezone, e.g. "America/New_York". Omit to use the home default.'),
  }),
  execute: async ({ timezone }) => {
    const tz = timezone || config.assistant.timezone;
    const now = new Date();
    try {
      const part = (opts: Intl.DateTimeFormatOptions) =>
        new Intl.DateTimeFormat('es-ES', { timeZone: tz, ...opts }).format(now);
      return {
        readable: new Intl.DateTimeFormat('es-ES', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' }).format(now),
        timezone: tz,
        iso: now.toISOString(),
        dayOfWeek: part({ weekday: 'long' }),
        day: Number(part({ day: 'numeric' })),
        month: part({ month: 'long' }),
        monthNumber: Number(part({ month: 'numeric' })),
        year: Number(part({ year: 'numeric' })),
        time24: part({ hour: '2-digit', minute: '2-digit', hour12: false }),
      };
    } catch (error) {
      // Bad timezone → fall back to plain ISO so the model still gets something.
      return { error: (error as Error).message, iso: now.toISOString() };
    }
  },
});
