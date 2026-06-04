import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import type { AgentState } from '@home-assistant/shared';
import { chime, enableChimeOnInteraction } from './chime.js';
import { Starfield } from './Starfield.js';
import { useAgentSocket, type WakeMeter as WakeData } from './useAgentSocket.js';

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

export function App() {
  const { state, transcript, connected, wake, send } = useAgentSocket();
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
