/**
 * Local STT via whisper.cpp. Runs fully offline on the Raspberry Pi 5.
 * Requires the `whisper-cli` binary and a GGML model (see docs/raspberry-pi-setup.md).
 */
import { spawn } from 'node:child_process';
import { config } from '../config/env.js';

export async function transcribeWhisperLocal(wavPath: string): Promise<string> {
  const args = [
    '-m', config.stt.whisperModel,
    '-f', wavPath,
    '-l', config.stt.language,
    '-t', String(config.stt.whisperThreads),
    '-nt', // no timestamps: print plain text
  ];

  return new Promise<string>((resolve, reject) => {
    const child = spawn(config.stt.whisperBinary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) =>
      reject(new Error(`whisper.cpp failed to start (${config.stt.whisperBinary}): ${e.message}`)),
    );
    child.on('exit', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`whisper.cpp exited with code ${code}: ${err.trim()}`));
    });
  });
}
