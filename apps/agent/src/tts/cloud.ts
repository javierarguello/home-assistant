/**
 * Cloud TTS via any OpenAI-compatible `/audio/speech` endpoint.
 * Configure with `TTS_BASE_URL`, `TTS_API_KEY`, `TTS_MODEL`, `TTS_VOICE`.
 */
import { writeFile } from 'node:fs/promises';
import { config } from '../config/env.js';

export async function synthesizeCloud(text: string, outPath: string): Promise<string> {
  const res = await fetch(`${config.tts.baseURL}/audio/speech`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.tts.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.tts.model,
      voice: config.tts.voice,
      input: text,
      response_format: 'wav',
    }),
  });
  if (!res.ok) throw new Error(`Cloud TTS error ${res.status}: ${await res.text()}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  await writeFile(outPath, buffer);
  return outPath;
}
