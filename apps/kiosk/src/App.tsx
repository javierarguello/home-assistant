import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import type { AgentState, TaskInfo } from '@home-assistant/shared';
import { chime, enableChimeOnInteraction } from './chime.js';
import { Starfield } from './Starfield.js';
import {
  useAgentSocket,
  type Metrics,
  type WakeMeter as WakeData,
} from './useAgentSocket.js';

/** Debug overlay (per-stage timings) is on when the URL has `?debug`. */
const DEBUG = new URLSearchParams(location.search).has('debug');

const STATUS: Record<AgentState, string> = {
  idle: 'EN ESPERA',
  listening: 'ESCUCHANDO',
  thinking: 'PROCESANDO',
  speaking: 'TRANSMITIENDO',
  error: 'FALLO DE SISTEMA',
};

/**
 * Live wake-word feedback: a MIC level bar (does it hear audio?) and a WAKE
 * score bar with a threshold marker (does it reach the trigger?). Turns green
 * the instant the score crosses the threshold.
 */
function WakeMeter({ wake }: { wake: WakeData }) {
  const level = Math.min(1, wake.rms / 4000); // raw int16 RMS → 0..1
  const score = Math.min(1, wake.score);
  const thr = Math.min(1, wake.threshold);
  const hot = wake.threshold > 0 && wake.score >= wake.threshold;

  const row: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 10,
    letterSpacing: 1,
    margin: '5px 0',
  };
  const track: CSSProperties = {
    position: 'relative',
    flex: 1,
    height: 8,
    background: 'rgba(0,255,255,0.07)',
    border: '1px solid rgba(0,255,255,0.25)',
    borderRadius: 2,
    overflow: 'hidden',
  };
  const tag: CSSProperties = { width: 40, opacity: 0.7 };
  const fill = (w: number, bg: string, glow = false): CSSProperties => ({
    height: '100%',
    width: `${w * 100}%`,
    background: bg,
    boxShadow: glow ? '0 0 8px currentColor' : 'none',
    transition: 'width .08s linear',
  });

  return (
    <div style={{ padding: '6px 0' }}>
      <div style={row}>
        <span style={tag}>MIC</span>
        <div style={track}>
          <div style={fill(level, 'linear-gradient(90deg,#0ff,#06a)')} />
        </div>
      </div>
      <div style={row}>
        <span style={tag}>WAKE</span>
        <div style={track}>
          <div style={{ ...fill(score, hot ? '#3f6' : '#08f', hot), color: '#3f6' }} />
          {thr > 0 && (
            <span
              style={{
                position: 'absolute',
                top: -2,
                bottom: -2,
                left: `${thr * 100}%`,
                width: 2,
                background: '#ff5',
                boxShadow: '0 0 4px #ff5',
              }}
            />
          )}
        </div>
        <span style={{ width: 34, textAlign: 'right', color: hot ? '#3f6' : '#0cf' }}>
          {wake.score.toFixed(2)}
        </span>
      </div>
    </div>
  );
}

const fmtMs = (ms?: number) =>
  ms == null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;

/** Debug overlay: per-stage latency of the last turn (STT / LLM / TTS). */
function DebugMetrics({ metrics }: { metrics: Metrics }) {
  const ready = (metrics.stt ?? 0) + (metrics.llm ?? 0); // time until the answer is ready
  const rows: Array<[string, number | undefined]> = [
    ['STT', metrics.stt],
    ['LLM', metrics.llm],
    ['TTS', metrics.tts],
    ['→ LISTO', metrics.stt != null && metrics.llm != null ? ready : undefined],
  ];
  return (
    <div
      style={{
        position: 'fixed',
        right: 14,
        bottom: 70,
        zIndex: 20,
        minWidth: 150,
        padding: '8px 12px',
        fontSize: 11,
        letterSpacing: 1,
        fontFamily: 'monospace',
        color: '#0cf',
        background: 'rgba(0,10,16,0.82)',
        border: '1px solid rgba(0,255,255,0.3)',
        borderRadius: 4,
        boxShadow: '0 0 12px rgba(0,255,255,0.15)',
      }}
    >
      <div style={{ opacity: 0.6, marginBottom: 4 }}>DEBUG · TIEMPOS</div>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
          <span style={{ opacity: 0.75 }}>{k}</span>
          <span style={{ color: k === '→ LISTO' ? '#3f6' : '#0cf' }}>{fmtMs(v)}</span>
        </div>
      ))}
    </div>
  );
}

const TASK_ICON: Record<TaskInfo['status'], string> = {
  starting: '◌',
  running: '▸',
  completed: '✓',
  failed: '✕',
};
const TASK_COLOR: Record<TaskInfo['status'], string> = {
  starting: '#0cf',
  running: '#0cf',
  completed: '#3f6',
  failed: '#f55',
};

/** Live panel of background task agents (running + just-finished). */
function TasksPanel({ tasks }: { tasks: TaskInfo[] }) {
  if (!tasks.length) return null;
  return (
    <div
      style={{
        position: 'fixed',
        left: 18,
        bottom: 84,
        zIndex: 30,
        maxWidth: 340,
        fontFamily: 'monospace',
        fontSize: 12,
        letterSpacing: 0.5,
        color: '#0cf',
        background: 'rgba(0,10,16,0.72)',
        border: '1px solid rgba(0,255,255,0.25)',
        borderRadius: 4,
        padding: '8px 10px',
        boxShadow: '0 0 12px rgba(0,255,255,0.15)',
      }}
    >
      <div style={{ opacity: 0.6, marginBottom: 6 }}>▸ AGENTES</div>
      {tasks.map((t) => (
        <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '3px 0' }}>
          <span style={{ color: TASK_COLOR[t.status], width: 12 }}>{TASK_ICON[t.status]}</span>
          {t.analysis && <span title="análisis de código (modelo Pro)">🧠</span>}
          <span style={{ opacity: 0.6, textTransform: 'uppercase' }}>{t.kind}</span>
          <span
            style={{
              flex: 1,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              opacity: t.status === 'completed' || t.status === 'failed' ? 0.7 : 1,
            }}
          >
            {t.step || t.title}
          </span>
        </div>
      ))}
    </div>
  );
}

export function App() {
  const { state, transcript, connected, wake, metrics, activity, tasks, send } = useAgentSocket();
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const prevState = useRef<AgentState>('idle');
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Chime on entering/leaving "listening" (hands-free audio feedback).
  useEffect(() => enableChimeOnInteraction(), []);
  useEffect(() => {
    const prev = prevState.current;
    if (state !== prev) {
      if (state === 'listening') chime.listening();
      else if (prev === 'listening') chime.done();
      prevState.current = state;
    }
  }, [state]);

  const reversed = [...transcript].reverse();
  const lastUser = reversed.find((e) => e.speaker === 'user');
  const lastAssistant = reversed.find((e) => e.speaker === 'assistant');

  const isSpeaking = state === 'speaking';
  const answer = lastAssistant?.text ?? '';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    send(text);
    setDraft('');
  };

  const clock = `${now.toISOString().slice(0, 19).replace('T', ' ')} UTC`;

  return (
    <div className={`hal state-${state}`}>
      <Starfield />
      {DEBUG && <DebugMetrics metrics={metrics} />}
      <TasksPanel tasks={tasks} />
      <div className="grid-floor" aria-hidden />
      <div className="scanlines" aria-hidden />

      <header className="topbar">
        <span className="brand">
          <i className={`led ${connected ? 'on' : 'off'}`} /> HAL · 9000 · HOME ASSISTANT INTERFACE
        </span>
        <span className="sys">
          MIC · {state === 'listening' ? 'LIVE' : 'IDLE'} · SYS · {connected ? 'ONLINE' : 'OFFLINE'} · {clock}
        </span>
      </header>

      <main className="stage">
        <section className="panel left">
          <div className="panel-head">
            ▸ ENTRADA · AUDIO <span className="dash">—</span>
          </div>
          <div className="panel-body" key={lastUser?.id}>
            {lastUser?.text ?? ''}
          </div>
          <WakeMeter wake={wake} />
          <div className="wave" />
        </section>

        <div className="center">
          <div className={`eye-wrap ${isSpeaking ? 'shrunk' : ''}`}>
            <div className="eye" aria-hidden>
              <div className="reticle" />
              <div className="ring r1" />
              <div className="ring r2" />
              <div className="iris">
                <div className="pupil" />
              </div>
            </div>
            <div className="status">
              {state === 'idle' && <span className="status-dot" />} {STATUS[state]}
            </div>
            {activity && (
              <div
                style={{
                  marginTop: 6,
                  fontSize: 13,
                  letterSpacing: 1,
                  color: '#0cf',
                  opacity: 0.85,
                  textShadow: '0 0 8px rgba(0,255,255,0.4)',
                }}
              >
                ▸ {activity}
              </div>
            )}
          </div>

          <div className={`central-out ${isSpeaking ? 'open' : ''}`}>
            <div className="central-head">
              ▸ HAL · TRANSMITIENDO <span className="live" />
            </div>
            <div className="central-text">
              {answer}
              <span className="caret" />
            </div>
          </div>

          <button type="button" className="talk" onClick={() => inputRef.current?.focus()}>
            ● HABLAR A HAL
          </button>
        </div>

        <section className="panel right">
          <div className="panel-head">
            ▸ SALIDA · HAL-9000 <span className="dash">—</span>
          </div>
          <div className="panel-body out" key={lastAssistant?.id}>
            {answer}
          </div>
          <div className="panel-foot">FREQ · 432HZ · CANAL · 09 · {transcript.length} VOCES</div>
        </section>
      </main>

      <form className="composer" onSubmit={submit}>
        <span className="prompt">HAL ▸</span>
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Escribe un mensaje para que HAL lo lea en voz alta…"
          autoComplete="off"
        />
        <button type="submit">TRANSMITIR</button>
      </form>
    </div>
  );
}
