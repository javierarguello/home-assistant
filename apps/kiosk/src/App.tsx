import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AgentState } from '@home-assistant/shared';
import { useAgentSocket } from './useAgentSocket.js';

const STATE_LABEL: Record<AgentState, string> = {
  idle: 'Listo',
  listening: 'Escuchando…',
  thinking: 'Pensando…',
  speaking: 'Hablando…',
  error: 'Algo salió mal',
};

export function App() {
  const { state, transcript, connected, send } = useAgentSocket();
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcript]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    send(text);
    setDraft('');
  };

  return (
    <div className={`app state-${state}`}>
      <header className="status">
        <div className={`orb orb-${state}`} aria-hidden />
        <div className="status-text">{STATE_LABEL[state]}</div>
        <span className={`conn ${connected ? 'on' : 'off'}`}>
          {connected ? 'conectado' : 'sin conexión'}
        </span>
      </header>

      <main className="transcript">
        {transcript.length === 0 && (
          <p className="hint">Di la palabra de activación o escribe abajo.</p>
        )}
        {transcript.map((entry) => (
          <div key={entry.id} className={`msg ${entry.speaker}`}>
            {entry.text}
          </div>
        ))}
        <div ref={endRef} />
      </main>

      <form className="composer" onSubmit={submit}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Escribe un mensaje…"
          autoComplete="off"
        />
        <button type="submit">Enviar</button>
      </form>
    </div>
  );
}
