import { authHeaders } from './authHeaders';
import type { AppEvent } from './appEvents';

// Counts an action for the admin's users report (lib/appEvents). Queued and
// sent in small batches — every few seconds, and when the page is hidden — so
// it never holds anything up. Without reception the events are dropped: the
// report counts use, it is not a record anyone relies on.

type Props = Record<string, string | number | boolean | null | undefined>;
interface Queued { event: AppEvent; at: number; props?: Props }

const FLUSH_MS = 8000;
const MAX_QUEUE = 50;
let queue: Queued[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let listening = false;

async function flush() {
  timer = null;
  if (queue.length === 0) return;
  const events = queue;
  queue = [];
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  try {
    await fetch('/api/events', {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ events }),
    });
  } catch {}
}

export function track(event: AppEvent, props?: Props) {
  if (typeof window === 'undefined') return;
  if (queue.length >= MAX_QUEUE) return;
  queue.push({ event, at: Date.now(), ...(props ? { props } : {}) });
  if (!listening) {
    listening = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void flush();
    });
  }
  timer ??= setTimeout(() => void flush(), FLUSH_MS);
}
