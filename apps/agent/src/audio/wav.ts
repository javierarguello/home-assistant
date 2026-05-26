/** Minimal 16-bit PCM mono WAV encoder (no dependencies). */
import { writeFile } from 'node:fs/promises';

export async function writePcm16Wav(
  path: string,
  pcm: Int16Array,
  sampleRate = 16000,
): Promise<void> {
  await writeFile(path, encodeWav(pcm, sampleRate));
}

function encodeWav(pcm: Int16Array, sampleRate: number): Buffer {
  const numChannels = 1;
  const bytesPerSample = 2;
  const dataSize = pcm.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // PCM fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * numChannels * bytesPerSample, 28);
  buffer.writeUInt16LE(numChannels * bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < pcm.length; i++) buffer.writeInt16LE(pcm[i]!, 44 + i * 2);
  return buffer;
}
