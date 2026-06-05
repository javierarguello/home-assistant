/**
 * Cloud STT via Gemini audio input (multimodal `generateContent`). More accurate
 * and multilingual than the local whisper.cpp base model, and it doesn't
 * hallucinate "[Música]" on silence. Enable with `STT_PROVIDER=gemini`; uses
 * `STT_GEMINI_*` (the API key falls back to `LLM_API_KEY`).
 */
import { readFile } from 'node:fs/promises';
import { config } from '../config/env.js';

interface GenerateContentResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}

export async function transcribeGemini(wavPath: string): Promise<string> {
  const audio = (await readFile(wavPath)).toString('base64');
  const lang = config.stt.language;
  const hint = lang && lang !== 'auto' ? ` The spoken language is "${lang}".` : '';
  const prompt =
    'Transcribe the speech in this audio verbatim. Output ONLY the transcription — ' +
    'no quotes, labels or commentary. If there is no intelligible speech, output nothing.' +
    hint;

  const url =
    `${config.stt.geminiBaseUrl}/models/${config.stt.geminiModel}:generateContent` +
    `?key=${config.stt.geminiApiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        { parts: [{ text: prompt }, { inline_data: { mime_type: 'audio/wav', data: audio } }] },
      ],
      generationConfig: { temperature: 0 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini STT error ${res.status}: ${await res.text()}`);

  const data = (await res.json()) as GenerateContentResponse;
  const text =
    data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  return text.trim();
}
