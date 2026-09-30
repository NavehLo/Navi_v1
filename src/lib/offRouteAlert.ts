// The off-route alarm: how far is too far, and the sound that says so.
//
// The distance is a device setting, like the rail labels — it belongs to the
// phone in the hiker's pocket, not to an account, and it has to work signed
// out and with no reception.

export type OffRouteThreshold = 0 | 50 | 100 | 200; // metres; 0 = off
export const OFF_ROUTE_OPTIONS: OffRouteThreshold[] = [50, 100, 200, 0];
const DEFAULT_THRESHOLD: OffRouteThreshold = 100;
const KEY = 'navi:offRouteM';
const listeners = new Set<() => void>();

export function readOffRouteThreshold(): OffRouteThreshold {
  try {
    const n = Number(localStorage.getItem(KEY));
    return (OFF_ROUTE_OPTIONS as number[]).includes(n) && localStorage.getItem(KEY) !== null
      ? (n as OffRouteThreshold)
      : DEFAULT_THRESHOLD;
  } catch {
    return DEFAULT_THRESHOLD;
  }
}

export function writeOffRouteThreshold(m: OffRouteThreshold) {
  try { localStorage.setItem(KEY, String(m)); } catch {}
  listeners.forEach((l) => l());
}

export function subscribeOffRouteThreshold(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export const serverOffRouteThreshold = () => DEFAULT_THRESHOLD;

// ── The sound ────────────────────────────────────────────────────────────────
// Synthesised rather than a file, so it needs no download and works offline.
// A square wave at full volume, alternating two pitches like a siren — it has
// to be heard from a pocket over wind. The phone also vibrates, for when the
// sound is not heard.
//
// It repeats until it is silenced (the banner's "השתק" button), the walker is
// back on the route, or ALARM_MAX_MS has passed — a single burst is easy to
// miss, and one that never stops is its own emergency.
//
// Browsers only let a page make sound after a tap, so the context is created
// (or resumed) from one: switching on the live location calls primeAlarm().

const BURST_MS = 2400;
const GAP_MS = 1600;
const ALARM_MAX_MS = 30_000;

let ctx: AudioContext | null = null;
let repeatTimer: ReturnType<typeof setInterval> | null = null;
let stopTimer: ReturnType<typeof setTimeout> | null = null;
let current: { osc: OscillatorNode; gain: GainNode } | null = null;

export function primeAlarm() {
  try {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    // No Web Audio — the vibration and the banner still work.
  }
}

function burst() {
  try { navigator.vibrate?.([400, 150, 400, 150, 800]); } catch {}
  if (!ctx) primeAlarm();
  if (!ctx) return;
  if (ctx.state === 'suspended') void ctx.resume();
  const t0 = ctx.currentTime + 0.05;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  gain.connect(ctx.destination);
  const osc = ctx.createOscillator();
  osc.type = 'square';
  osc.connect(gain);
  // Six two-tone beats, 2.4 seconds.
  for (let i = 0; i < 6; i++) {
    const t = t0 + i * 0.4;
    osc.frequency.setValueAtTime(i % 2 ? 1320 : 880, t);
    gain.gain.setValueAtTime(1, t);
    gain.gain.setValueAtTime(0, t + 0.32);
  }
  osc.start(t0);
  osc.stop(t0 + BURST_MS / 1000);
  current = { osc, gain };
}

// Starts the alarm; repeats until stopAlarm(). `once` plays a single burst
// (the "play a sample" button in the settings).
export function soundAlarm({ once = false }: { once?: boolean } = {}) {
  stopAlarm();
  burst();
  if (once) return;
  repeatTimer = setInterval(burst, BURST_MS + GAP_MS);
  stopTimer = setTimeout(stopAlarm, ALARM_MAX_MS);
}

export function stopAlarm() {
  if (repeatTimer) { clearInterval(repeatTimer); repeatTimer = null; }
  if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
  if (current) {
    try { current.gain.gain.cancelScheduledValues(0); current.gain.gain.value = 0; current.osc.stop(); } catch {}
    current = null;
  }
  try { navigator.vibrate?.(0); } catch {}
}

export function isAlarmSounding() {
  return repeatTimer !== null;
}
