import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentState,
  ClientEvent,
  ServerEvent,
  TranscriptEntry,
} from '@home-assistant/shared';

const WS_URL = import.meta.env.VITE_WS_URL ?? `ws://${location.hostname}:8787`;

export function useAgentSocket() {
  const [state, setState] = useState<AgentState>('idle');
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

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
        else if (ev.type === 'hello') {
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
      wsRef.current?.close();
    };
  }, []);

  const send = useCallback((text: string) => {
    const ev: ClientEvent = { type: 'text', text };
    wsRef.current?.send(JSON.stringify(ev));
  }, []);

  return { state, transcript, connected, send };
}
