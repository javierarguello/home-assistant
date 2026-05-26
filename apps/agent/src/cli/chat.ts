/**
 * Headless text REPL — exercise the agent graph (models, tools, sub-agents)
 * with no microphone or speakers. Great for developing on a laptop and for a
 * first smoke test against local Ollama on the Pi.
 */
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { config } from '../config/env.js';
import type { Conversation } from '../conversation.js';

export async function runChat(convo: Conversation): Promise<void> {
  const rl = readline.createInterface({ input, output });
  console.log(`\n${config.assistant.name} — modo chat. Escribe un mensaje (Ctrl+C o /exit para salir).\n`);
  convo.onTool = (tool) => console.log(`  · usando herramienta: ${tool}`);
  convo.setState('idle');
  rl.setPrompt('› ');
  rl.prompt();

  // Async-iterator form handles piped stdin / EOF gracefully.
  for await (const raw of rl) {
    const line = raw.trim();
    if (line === '/exit' || line === '/quit') break;
    if (line) {
      try {
        const answer = await convo.handle(line);
        console.log(`\n${answer || '(sin respuesta)'}\n`);
      } catch (error) {
        console.error(`\n[error] ${(error as Error).message}\n`);
      }
    }
    rl.prompt();
  }
  rl.close();
}
