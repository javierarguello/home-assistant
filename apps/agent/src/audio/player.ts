/** Plays a WAV file via the configured system player (`aplay`/`afplay`). */
import { spawn } from 'node:child_process';
import { config } from '../config/env.js';

export function playWav(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const [cmd, ...preset] = config.audio.playerCommand.split(' ');
    const child = spawn(cmd!, [...preset, path], { stdio: 'ignore' });
    child.on('error', (e) =>
      reject(new Error(`Audio player failed (${config.audio.playerCommand}): ${e.message}`)),
    );
    child.on('exit', () => resolve());
  });
}
