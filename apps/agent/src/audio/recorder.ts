/**
 * Microphone capture via Picovoice PvRecorder (pairs with Porcupine).
 *
 * Fase 1: npm i @picovoice/pvrecorder-node
 */

export interface Microphone {
  readonly frameLength: number;
  readonly sampleRate: number;
  start(): void;
  stop(): void;
  release(): void;
  /** Reads one frame of `frameLength` 16-bit samples. */
  read(): Promise<Int16Array>;
}

export async function createMicrophone(frameLength: number): Promise<Microphone> {
  // Indirect specifier so the optional native dep isn't a hard compile-time
  // requirement (it's installed in Fase 1).
  const pkg = '@picovoice/pvrecorder-node';
  let mod: unknown;
  try {
    mod = await import(pkg);
  } catch {
    throw new Error('Microphone dependency missing. Run: npm i @picovoice/pvrecorder-node');
  }

  const { PvRecorder } = mod as {
    PvRecorder: new (
      frameLength: number,
      deviceIndex?: number,
    ) => {
      sampleRate: number;
      start(): void;
      stop(): void;
      release(): void;
      read(): Promise<Int16Array> | Int16Array;
    };
  };

  const recorder = new PvRecorder(frameLength, -1);

  return {
    frameLength,
    sampleRate: recorder.sampleRate ?? 16000,
    start: () => recorder.start(),
    stop: () => recorder.stop(),
    release: () => recorder.release(),
    read: async () => Int16Array.from(await recorder.read()),
  };
}
