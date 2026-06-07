/**
 * Push-to-talk: turn a base64 audio clip recorded in the kiosk browser into a
 * 16 kHz mono WAV (via ffmpeg) for the STT engine. Lets the user hold a button
 * and speak a command without the wake word.
 */
import { spawn } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../logger.js';

const log = createLogger('ptt');

const EXT: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
};

/** Decodes the clip, transcodes to 16 kHz mono WAV, returns the WAV path. */
export async function pushAudioToWav(base64: string, mime: string): Promise<string> {
  const ext = EXT[mime.split(';')[0]!.trim()] ?? 'webm';
  const inPath = join(tmpdir(), `ptt-${randomUUID()}.${ext}`);
  const wavPath = join(tmpdir(), `ptt-${randomUUID()}.wav`);
  await writeFile(inPath, Buffer.from(base64, 'base64'));
  try {
    await new Promise<void>((resolve, reject) => {
      const ff = spawn(
        'ffmpeg',
        ['-y', '-i', inPath, '-ar', '16000', '-ac', '1', '-sample_fmt', 's16', wavPath],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let err = '';
      ff.stderr.on('data', (d) => (err += d.toString()));
      ff.on('error', reject);
      ff.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${err.slice(-200)}`))));
    });
    return wavPath;
  } finally {
    void unlink(inPath).catch(() => {});
  }
}

export { log as pttLog };
