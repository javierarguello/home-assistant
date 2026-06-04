import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentState,
  ClientEvent,
  ServerEvent,
  TranscriptEntry,
} from '@home-assistant/shared';

const WS_URL = import.meta.env.VITE_WS_URL ?? `ws://${location.hostname}:8787`;

/** Live wake-word telemetry for the kiosk meter. */
export interface WakeMeter {
  score: number;
  threshold: number;
  rms: number;
}

/** Per-stage latency (ms) of the most recent turn, for the debug overlay. */
export interface Metrics {
  stt?: number;
  llm?: number;
  tts?: number;
}

const WAKE_IDLE: WakeMeter = { score: 0, threshold: 0, rms: 0 };

export function useAgentSocket() {
  const [state, setState] = useState<AgentState>('idle');
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [wake, setWake] = useState<WakeMeter>(WAKE_IDLE);
  const [metrics, setMetrics] = useState<Metrics>({});
  const wsRef = useRef<WebSocket | null>(null);
  const wakeDecay = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;

    const connect = () => {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 1500);
      };
      ws.onmessage = (event) => {
        const ev = JSON.parse(event.data) as ServerEvent;
        if (ev.type === 'state') setState(ev.state);
        else if (ev.type === 'wake') {
          // Refresh the meter and decay it to zero if frames stop arriving
          // (e.g. while thinking/speaking the side-car pauses scoring).
          setWake({ score: ev.score, threshold: ev.threshold, rms: ev.rms });
          clearTimeout(wakeDecay.current);
          wakeDecay.current = setTimeout(() => setWake(WAKE_IDLE), 600);
        } else if (ev.type === 'timing') {
          // STT is the first stage of a turn — reset so stale llm/tts clear.
          setMetrics((m) => (ev.stage === 'stt' ? { stt: ev.ms } : { ...m, [ev.stage]: ev.ms }));
        } else if (ev.type === 'hello') {
          setState(ev.state);
          setTranscript(ev.transcript);
        } else if (ev.type === 'transcript') {
          setTranscript((t) => {
            // Update in place if the entry id already exists (streaming), else append.
            const idx = t.findIndex((e) => e.id === ev.entry.id);
            if (idx >= 0) {
              const copy = t.slice();
              copy[idx] = ev.entry;
              return copy;
            }
            return [...t, ev.entry].slice(-50);
          });
        } else if (ev.type === 'error') {
          setTranscript((t) =>
            [
              ...t,
              {
                id: crypto.randomUUID(),
                speaker: 'assistant' as const,
                text: `⚠️ ${ev.message}`,
                ts: Date.now(),
              },
            ].slice(-50),
          );
        }
      };
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      clearTimeout(wakeDecay.current);
      wsRef.current?.close();
    };
  }, []);

  const send = useCallback((text: string) => {
    const ev: ClientEvent = { type: 'text', text };
    wsRef.current?.send(JSON.stringify(ev));
  }, []);

  return { state, transcript, connected, wake, metrics, send };
}
