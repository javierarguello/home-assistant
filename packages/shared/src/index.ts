/**
 * Types shared between the agent backend and the kiosk frontend.
 *
 * The backend broadcasts {@link ServerEvent}s over a WebSocket; the kiosk
 * renders the current {@link AgentState} and the running conversation.
 */

/** High-level lifecycle of the assistant, used to drive the kiosk UI. */
export type AgentState =
  | 'idle' // waiting for the wake word
  | 'listening' // wake word fired, capturing speech
  | 'thinking' // running STT + the agent graph
  | 'speaking' // playing back the TTS response
  | 'error';

export type Speaker = 'user' | 'assistant';

/** A single turn in the conversation transcript. */
export interface TranscriptEntry {
  id: string;
  speaker: Speaker;
  text: string;
  /** True while the text is still streaming in (partial result). */
  partial?: boolean;
  /** Epoch millis when the entry was created. */
  ts: number;
}

/** Events the backend pushes to the kiosk. */
export type ServerEvent =
  | { type: 'state'; state: AgentState }
  | { type: 'transcript'; entry: TranscriptEntry }
  | { type: 'error'; message: string }
  | { type: 'hello'; state: AgentState; transcript: TranscriptEntry[] }
  /**
   * Live wake-word telemetry, emitted per audio frame while listening for the
   * wake word so the kiosk can show whether the mic hears audio (`rms`, raw
   * int16 RMS) and how close it is to firing (`score` vs `threshold`).
   */
  | { type: 'wake'; score: number; threshold: number; rms: number };

/** Events the kiosk (or a dev tool) can send to the backend. */
export type ClientEvent =
  | { type: 'text'; text: string } // type a message instead of speaking
  | { type: 'interrupt' }; // stop current speech / cancel turn

export const WS_DEFAULT_PORT = 8787;
