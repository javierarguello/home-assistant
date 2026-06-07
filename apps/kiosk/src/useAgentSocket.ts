import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentState,
  ClientEvent,
  Detail,
  ServerEvent,
  TaskInfo,
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
  const [activity, setActivity] = useState('');
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [details, setDetails] = useState<Detail[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const wakeDecay = useRef<ReturnType<typeof setTimeout>>(undefined);
  const taskTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

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
        if (ev.type === 'state') {
          setState(ev.state);
          // Activity describes "thinking" work; clear it once we speak or go idle.
          if (ev.state === 'speaking' || ev.state === 'idle') setActivity('');
        } else if (ev.type === 'activity') setActivity(ev.label);
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
          setTasks(ev.tasks ?? []);
          setDetails(ev.details ?? []);
        } else if (ev.type === 'detail') {
          setDetails((d) => [...d, ev.detail].slice(-10));
        } else if (ev.type === 'task') {
          const task = ev.task;
          setTasks((ts) => {
            const idx = ts.findIndex((t) => t.id === task.id);
            if (idx >= 0) {
              const copy = ts.slice();
              copy[idx] = task;
              return copy;
            }
            return [...ts, task];
          });
          // Keep a finished task on screen briefly (✓), then drop it.
          if (task.status === 'completed' || task.status === 'failed' || task.status === 'canceled') {
            clearTimeout(taskTimers.current.get(task.id));
            taskTimers.current.set(
              task.id,
              setTimeout(() => setTasks((ts) => ts.filter((t) => t.id !== task.id)), 8000),
            );
          }
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
    const timers = taskTimers.current;
    return () => {
      closed = true;
      clearTimeout(retry);
      clearTimeout(wakeDecay.current);
      for (const t of timers.values()) clearTimeout(t);
      wsRef.current?.close();
    };
  }, []);

  const send = useCallback((text: string) => {
    const ev: ClientEvent = { type: 'text', text };
    wsRef.current?.send(JSON.stringify(ev));
  }, []);

  const sendTaskAnswer = useCallback((taskId: string, answer: string) => {
    const ev: ClientEvent = { type: 'task-answer', taskId, answer };
    wsRef.current?.send(JSON.stringify(ev));
  }, []);

  return { state, transcript, connected, wake, metrics, activity, tasks, details, send, sendTaskAnswer };
}
