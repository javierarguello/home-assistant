/**
 * Local TTS via Piper. Fast neural speech, fully offline on the Pi 5.
 * Requires the `piper` binary and a voice `.onnx` (see docs/raspberry-pi-setup.md).
 */
import { spawn } from 'node:child_process';
import { franc } from 'franc-min';
import { config } from '../config/env.js';

/**
 * Picks the voice by detected language: English -> voiceEn, else the default.
 * Restricting franc to es/en makes it reliable even on short text (unrestricted
 * franc mis-detects short English as obscure languages).
 */
function voiceForText(text: string): string {
  if (config.tts.voiceEn && franc(text, { only: ['eng', 'spa'], minLength: 1 }) === 'eng') {
    return config.tts.voiceEn;
  }
  return config.tts.piperVoice;
}

export async function synthesizePiper(text: string, outPath: string): Promise<string> {
  const args = ['--model', voiceForText(text), '--output_file', outPath];

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
