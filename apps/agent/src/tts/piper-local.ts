/**
 * Local TTS via Piper. Fast neural speech, fully offline on the Pi 5.
 * Requires the `piper` binary and a voice `.onnx` (see docs/raspberry-pi-setup.md).
 */
import { spawn } from 'node:child_process';
import { config } from '../config/env.js';

export async function synthesizePiper(text: string, outPath: string): Promise<string> {
  const args = ['--model', config.tts.piperVoice, '--output_file', outPath];

  return new Promise<string>((resolve, reject) => {
    const child = spawn(config.tts.piperBinary, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) =>
      reject(new Error(`Piper failed to start (${config.tts.piperBinary}): ${e.message}`)),
    );
    child.on('exit', (code) => {
      if (code === 0) resolve(outPath);
      else reject(new Error(`Piper exited with code ${code}: ${err.trim()}`));
    });
    child.stdin.write(text);
    child.stdin.end();
  });
}
