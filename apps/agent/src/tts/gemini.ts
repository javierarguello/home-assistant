/**
 * Cloud TTS via Gemini native audio output. High quality and multilingual, but
 * non-streaming: the whole clip arrives in one response (network + synth), so
 * first-audio latency is higher than Piper's per-sentence streaming. Enable with
 * `TTS_PROVIDER=gemini`; uses `TTS_GEMINI_*` (the API key falls back to
 * `LLM_API_KEY`).
 */
import { config } from '../config/env.js';
import { writePcm16Wav } from '../audio/wav.js';

interface GenerateContentResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> };
  }>;
}

export async function synthesizeGemini(text: string, outPath: string): Promise<string | null> {
  if (!text.trim()) return null;

  const url =
    `${config.tts.geminiBaseUrl}/models/${config.tts.geminiModel}:generateContent` +
    `?key=${config.tts.geminiApiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: config.tts.geminiVoice } },
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`Gemini TTS error ${res.status}: ${await res.text()}`);

  const data = (await res.json()) as GenerateContentResponse;
  const inline = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
  if (!inline?.data) return null;

  // Gemini returns raw little-endian 16-bit PCM mono; rate is in the mime type
  // (e.g. "audio/L16;codec=pcm;rate=24000").
  const pcm = Buffer.from(inline.data, 'base64');
  const rate = Number(/rate=(\d+)/.exec(inline.mimeType ?? '')?.[1]) || 24000;
  const samples = new Int16Array(pcm.length >> 1);
  for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2);
  await writePcm16Wav(outPath, samples, rate);
  return outPath;
}
