/**
 * Push-to-talk button: hold to record (WhatsApp-style), release to send the
 * audio clip to the agent as a command — no wake word. Uses MediaRecorder.
 *
 * Note: getUserMedia needs a secure context. On the Pi kiosk open the app at
 * http://localhost:5173 (localhost is treated as secure); plain-http access from
 * another device on the LAN will be blocked by the browser.
 */
import { useRef, useState } from 'react';

function pickMime(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  const MR = typeof MediaRecorder !== 'undefined' ? MediaRecorder : undefined;
  return candidates.find((m) => MR?.isTypeSupported?.(m)) ?? 'audio/webm';
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function PushToTalk({ onAudio }: { onAudio: (base64: string, mime: string) => void }) {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState('');
  const streamRef = useRef<MediaStream | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const start = async () => {
    setError('');
    try {
      if (!streamRef.current) {
        streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      const mime = pickMime();
      const rec = new MediaRecorder(streamRef.current, { mimeType: mime });
      chunksRef.current = [];
      rec.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
      rec.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: mime });
        if (blob.size > 0) onAudio(await blobToBase64(blob), mime);
      };
      recRef.current = rec;
      rec.start();
      setRecording(true);
    } catch (e) {
      setError((e as Error).message || 'mic no disponible');
      setRecording(false);
    }
  };

  const stop = () => {
    if (recRef.current && recRef.current.state !== 'inactive') recRef.current.stop();
    setRecording(false);
  };

  return (
    <button
      type="button"
      title="Mantén presionado para hablar"
      onPointerDown={(e) => {
        e.preventDefault();
        void start();
      }}
      onPointerUp={stop}
      onPointerLeave={() => recording && stop()}
      onPointerCancel={stop}
      style={{
        userSelect: 'none',
        touchAction: 'none',
        background: recording ? 'rgba(255,80,80,0.25)' : 'rgba(0,255,255,0.12)',
        border: `1px solid ${recording ? '#f55' : 'rgba(0,255,255,0.5)'}`,
        color: recording ? '#f88' : '#0cf',
        borderRadius: 999,
        padding: '10px 16px',
        fontFamily: 'monospace',
        fontSize: 13,
        letterSpacing: 1,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {error ? `⚠ ${error.slice(0, 24)}` : recording ? '● GRABANDO… (suelta)' : '🎙 MANTÉN PARA HABLAR'}
    </button>
  );
}
