/**
 * Wake-word source abstraction. A source listens for the wake word and yields a
 * recorded utterance (16 kHz mono WAV) per detection.
 *
 *  - openWakeWord (default): a Python side-car that owns the mic — fully local,
 *    no API key, no phone-home.
 *  - Porcupine (optional): Node-native, but needs a Picovoice access key and
 *    periodic internet for license validation.
 */
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { config } from '../config/env.js';
import { createLogger } from '../logger.js';
import { createMicrophone, type Microphone } from './recorder.js';
import { createWakeWord } from './wakeword.js';
import { writePcm16Wav } from './wav.js';

const log = createLogger('wake');

export type UtteranceHandler = (wavPath: string) => Promise<void> | void;

export interface WakeSource {
  /** Runs until stopped; calls onUtterance with a WAV path per detected phrase. */
  start(onUtterance: UtteranceHandler, onWake?: () => void): Promise<void>;
  stop(): void;
}

export function createWakeSource(): WakeSource {
  return config.wakeWord.engine === 'porcupine'
    ? createPorcupineSource()
    : createOpenWakeWordSource();
}

// --- openWakeWord (Python side-car; fully local, no key) -------------------

function createOpenWakeWordSource(): WakeSource {
  let proc: ChildProcess | undefined;
  let stopped = false;

  return {
    async start(onUtterance, onWake) {
      proc = spawn(config.wakeWord.python, [config.wakeWord.script], {
        env: {
          ...process.env,
          WAKEWORD_MODEL: config.wakeWord.word,
          WAKEWORD_THRESHOLD: String(config.wakeWord.threshold),
          ...(config.wakeWord.inputDevice
            ? { WAKEWORD_INPUT_DEVICE: config.wakeWord.inputDevice }
            : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      proc.on('error', (e) =>
        log.error('failed to start wake-word side-car (is the venv installed?)', e),
      );
      proc.stderr?.on('data', (d) => log.debug('oww', String(d).trim()));
      proc.on('exit', (code) => {
        if (!stopped) log.warn('wake-word side-car exited', { code });
      });

      const rl = createInterface({ input: proc.stdout! });
      for await (const line of rl) {
        let evt: { event?: string; model?: string; score?: number; wav?: string; message?: string };
        try {
          evt = JSON.parse(line);
        } catch {
          continue;
        }
        switch (evt.event) {
          case 'ready':
            log.info('wake-word ready (openWakeWord)', { model: evt.model });
            break;
          case 'score':
            log.debug('score', { score: evt.score });
            break;
          case 'wake':
            log.info('wake word detected', { score: evt.score });
            onWake?.();
            break;
          case 'utterance':
            if (evt.wav) await onUtterance(evt.wav);
            break;
          case 'error':
            log.error('wake-word side-car error', evt.message);
            break;
        }
      }
    },
    stop() {
      stopped = true;
      proc?.kill();
    },
  };
}

// --- Porcupine (Node-native; needs an access key) --------------------------

function createPorcupineSource(): WakeSource {
  let running = false;
  let mic: Microphone | undefined;

  return {
    async start(onUtterance, onWake) {
      const wake = await createWakeWord();
      mic = await createMicrophone(wake.frameLength);
      running = true;
      mic.start();
      log.info('wake-word ready (Porcupine)', { word: config.wakeWord.word });
      try {
        while (running) {
          const frame = await mic.read();
          if (!wake.process(frame)) continue;
          log.info('wake word detected');
          onWake?.();
          const pcm = await recordUtterance(mic, wake.sampleRate);
          const wavPath = join(tmpdir(), `oww-utt-${randomUUID()}.wav`);
          await writePcm16Wav(wavPath, pcm, wake.sampleRate);
          await onUtterance(wavPath);
        }
      } finally {
        mic.stop();
        mic.release();
        wake.release();
      }
    },
    stop() {
      running = false;
    },
  };
}

const MAX_UTTERANCE_SECONDS = 8;
const SILENCE_HANG_SECONDS = 1.0;
const SILENCE_RMS_THRESHOLD = 500;

/** Captures audio until ~1s of trailing silence (used by the Porcupine source). */
async function recordUtterance(mic: Microphone, sampleRate: number): Promise<Int16Array> {
  const maxFrames = Math.ceil((sampleRate * MAX_UTTERANCE_SECONDS) / mic.frameLength);
  const silenceHangFrames = Math.ceil((sampleRate * SILENCE_HANG_SECONDS) / mic.frameLength);
  const frames: Int16Array[] = [];
  let started = false;
  let silentRun = 0;

  for (let i = 0; i < maxFrames; i++) {
    const frame = await mic.read();
    frames.push(frame);
    if (rms(frame) > SILENCE_RMS_THRESHOLD) {
      started = true;
      silentRun = 0;
    } else if (started && ++silentRun >= silenceHangFrames) {
      break;
    }
  }

  const length = frames.reduce((n, f) => n + f.length, 0);
  const out = new Int16Array(length);
  let offset = 0;
  for (const frame of frames) {
    out.set(frame, offset);
    offset += frame.length;
  }
  return out;
}

function rms(frame: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i]!;
    sum += v * v;
  }
  return Math.sqrt(sum / frame.length);
}
