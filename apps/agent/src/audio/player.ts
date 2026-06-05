/**
 * Plays a WAV file via the configured system player (`aplay`/`afplay`).
 *
 * All playback is serialized through a single queue: the HDMI ALSA device is
 * opened exclusively, so two overlapping `aplay`s (e.g. an audio cue and a TTS
 * chunk, or two back-to-back chunks) would fail with "device busy". A small gap
 * after each clip lets the device fully release before the next opens it.
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { config } from '../config/env.js';

const RELEASE_MS = 60;

let queue: Promise<void> = Promise.resolve();

export function playWav(path: string): Promise<void> {
  const next = queue.then(async () => {
    await playOnce(path);
    await delay(RELEASE_MS);
  });
  // Keep the chain alive even if one clip fails, so later clips still play.
  queue = next.catch(() => {});
  return next;
}

function playOnce(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const [cmd, ...preset] = config.audio.playerCommand.split(' ');
    const child = spawn(cmd!, [...preset, path], { stdio: 'ignore' });
    child.on('error', (e) =>
      reject(new Error(`Audio player failed (${config.audio.playerCommand}): ${e.message}`)),
    );
    child.on('exit', () => resolve());
  });
}
