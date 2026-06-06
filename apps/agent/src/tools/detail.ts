/**
 * Side channel for rich tool output. A tool can push an HTML "detail" that goes
 * straight to the kiosk's expandable sidebar — separate from the concise data it
 * returns to the model (which is what gets spoken). The sink is wired by
 * index.ts to the WebSocket broadcast.
 */
import { randomUUID } from 'node:crypto';
import type { Detail } from '@home-assistant/shared';

type Sink = (detail: Detail) => void;
let sink: Sink | undefined;

export function setDetailSink(fn?: Sink): void {
  sink = fn;
}

/** Pushes an HTML detail to the kiosk (no-op if no sink is wired, e.g. in a worker). */
export function emitDetail(title: string, html: string): void {
  sink?.({ id: randomUUID().slice(0, 8), title, html, ts: Date.now() });
}

/** Escapes text for safe interpolation into detail HTML. */
export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}
