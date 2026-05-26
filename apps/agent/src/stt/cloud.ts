/**
 * Cloud STT via any OpenAI-compatible `/audio/transcriptions` endpoint
 * (OpenAI, Groq, etc.). Configure with `STT_BASE_URL`, `STT_API_KEY`, `STT_MODEL`.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { config } from '../config/env.js';

export async function transcribeCloud(wavPath: string): Promise<string> {
  const bytes = await readFile(wavPath);
  const form = new FormData();
  form.append('model', config.stt.model);
  // Omit language for 'auto' so the cloud STT detects it.
  if (config.stt.language !== 'auto') form.append('language', config.stt.language);
  form.append('file', new Blob([bytes], { type: 'audio/wav' }), basename(wavPath));

  const res = await fetch(`${config.stt.baseURL}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.stt.apiKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Cloud STT error ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { text?: string };
  return (data.text ?? '').trim();
}
