import {
  isNativeApp, prepareNativeAlarm, showNativeAlarm, clearNativeAlarm,
  nativeAlarmSoundAvailable, playNativeAlarmSound, stopNativeAlarmSound,
} from './native';

// The off-route alarm: how far is too far, and the sound that says so.
//
// All three choices (distance, sound, volume) are device settings, like the
// rail labels — they belong to the phone in the hiker's pocket, not to an
// account, and they have to work signed out and with no reception.

const listeners = new Set<() => void>();
function notify() { listeners.forEach((l) => l()); }
export function subscribeOffRouteThreshold(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
// The same store carries the sound and the volume.
export const subscribeAlarmPrefs = subscribeOffRouteThreshold;

function readKey(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeKey(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch {}
  notify();
}

// ── Distance ─────────────────────────────────────────────────────────────────
export type OffRouteThreshold = 0 | 50 | 100 | 200; // metres; 0 = off
export const OFF_ROUTE_OPTIONS: OffRouteThreshold[] = [50, 100, 200, 0];
const DEFAULT_THRESHOLD: OffRouteThreshold = 100;
const KEY = 'navi:offRouteM';

export function readOffRouteThreshold(): OffRouteThreshold {
  const raw = readKey(KEY);
  const n = Number(raw);
  return raw !== null && (OFF_ROUTE_OPTIONS as number[]).includes(n) ? (n as OffRouteThreshold) : DEFAULT_THRESHOLD;
}
export function writeOffRouteThreshold(m: OffRouteThreshold) { writeKey(KEY, String(m)); }
export const serverOffRouteThreshold = () => DEFAULT_THRESHOLD;

// ── Which sound ──────────────────────────────────────────────────────────────
// From the calmest to the harshest. The files are made by
// scripts/generateAlarmSounds.py, once for the site (public/sounds) and once
// for the Android app (res/raw) — keep the ids in step with it.
export const ALARM_SOUNDS = [
  { id: 'soft-bell', name: 'פעמון רך' },
  { id: 'chime', name: 'צלצול עולה' },
  { id: 'marimba', name: 'מרימבה' },
  { id: 'bird', name: 'ציוץ' },
  { id: 'beep', name: 'צפצוף' },
  { id: 'clock', name: 'שעון מעורר' },
  { id: 'horn', name: 'צופר' },
  { id: 'siren', name: 'סירנה' },
] as const;
export type AlarmSoundId = typeof ALARM_SOUNDS[number]['id'];
const DEFAULT_SOUND: AlarmSoundId = 'beep';
const SOUND_KEY = 'navi:alarmSound';

export function readAlarmSound(): AlarmSoundId {
  const raw = readKey(SOUND_KEY);
  return ALARM_SOUNDS.some((s) => s.id === raw) ? (raw as AlarmSoundId) : DEFAULT_SOUND;
}
export function writeAlarmSound(id: AlarmSoundId) { writeKey(SOUND_KEY, id); }
export const serverAlarmSound = () => DEFAULT_SOUND;

// ── How loud ─────────────────────────────────────────────────────────────────
// A share of the full volume, 0.1–1. In the Android app the full volume is
// the phone's alarm volume; in a browser, the media volume.
const DEFAULT_VOLUME = 0.8;
const VOLUME_KEY = 'navi:alarmVolume';

export function readAlarmVolume(): number {
  const n = Number(readKey(VOLUME_KEY));
  return Number.isFinite(n) && n >= 0.1 && n <= 1 ? n : DEFAULT_VOLUME;
}
export function writeAlarmVolume(v: number) { writeKey(VOLUME_KEY, String(Math.round(v * 100) / 100)); }
export const serverAlarmVolume = () => DEFAULT_VOLUME;

// ── Playing it ───────────────────────────────────────────────────────────────
// It repeats until it is silenced (the banner's "השתק", or tapping the
// notification in the app), the walker is back on the route, or
// ALARM_MAX_MS has passed — one round is easy to miss, and one that never
// stops is its own emergency.
//
// In the Android app the sound is played natively on the phone's alarm
// channel (AlarmSoundPlugin): it sounds with the screen off and through
// silent mode. In a browser it is Web Audio, which a page may only start after
// a tap — so primeAlarm() is called from one (switching on the live location).

const ALARM_MAX_MS = 30_000;

let ctx: AudioContext | null = null;
const buffers = new Map<string, Promise<AudioBuffer | null>>();
let source: AudioBufferSourceNode | null = null;
let stopTimer: ReturnType<typeof setTimeout> | null = null;
let repeatTimer: ReturnType<typeof setInterval> | null = null;
let sounding = false;

function loadBuffer(id: AlarmSoundId): Promise<AudioBuffer | null> {
  if (!ctx) return Promise.resolve(null);
  let p = buffers.get(id);
  if (!p) {
    const c = ctx;
    // Fetched once: the service worker keeps a copy, so it plays offline too.
    p = fetch(`/sounds/alarm-${id}.wav`)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((b) => c.decodeAudioData(b))
      .catch(() => { buffers.delete(id); return null; });
    buffers.set(id, p);
  }
  return p;
}

export function primeAlarm() {
  prepareNativeAlarm();
  if (isNativeApp() && nativeAlarmSoundAvailable()) return;
  try {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    void loadBuffer(readAlarmSound());
  } catch {
    // No Web Audio — the vibration and the banner still work.
  }
}

// The last resort, if the sound file cannot be had: a synthesised two-tone beat.
function synthBurst(c: AudioContext, volume: number) {
  const t0 = c.currentTime + 0.05;
  const gain = c.createGain();
  gain.gain.value = 0;
  gain.connect(c.destination);
  const osc = c.createOscillator();
  osc.type = 'square';
  osc.connect(gain);
  for (let i = 0; i < 6; i++) {
    const t = t0 + i * 0.4;
    osc.frequency.setValueAtTime(i % 2 ? 1320 : 880, t);
    gain.gain.setValueAtTime(volume, t);
    gain.gain.setValueAtTime(0, t + 0.32);
  }
  osc.start(t0);
  osc.stop(t0 + 2.4);
}

async function playWeb(sound: AlarmSoundId, volume: number, loop: boolean) {
  primeAlarm();
  const c = ctx;
  if (!c) return;
  if (c.state === 'suspended') await c.resume().catch(() => {});
  const buf = await loadBuffer(sound);
  if (!sounding) return; // silenced while the file was loading
  const gain = c.createGain();
  gain.gain.value = volume;
  gain.connect(c.destination);
  if (!buf) {
    synthBurst(c, volume);
    if (loop) repeatTimer = setInterval(() => synthBurst(c, volume), 4000);
    return;
  }
  const src = c.createBufferSource();
  src.buffer = buf;
  src.loop = loop;
  src.connect(gain);
  src.start();
  src.onended = () => { if (source === src) { source = null; if (!loop) sounding = false; } };
  source = src;
}

// Starts the alarm. `once` plays a single round (the samples in the
// settings); `sound` and `volume` override the saved choices for a preview.
export function soundAlarm({ once = false, message, sound, volume }: {
  once?: boolean; message?: string; sound?: AlarmSoundId; volume?: number;
} = {}) {
  stopAlarm();
  sounding = true;
  const s = sound ?? readAlarmSound();
  const v = volume ?? readAlarmVolume();
  if (!once) stopTimer = setTimeout(stopAlarm, ALARM_MAX_MS);

  if (isNativeApp() && nativeAlarmSoundAvailable()) {
    void playNativeAlarmSound({
      sound: s, volume: v, loop: !once, maxMs: ALARM_MAX_MS,
      ...(once ? {} : { title: 'סטית מהמסלול', body: message ?? 'חזרו לתוואי המסלול' }),
    });
    return;
  }
  if (isNativeApp()) {
    // An app installed before the sound choice existed: its notification
    // channel has the siren built in, and no volume of its own.
    void showNativeAlarm(message ?? 'חזרו לתוואי המסלול');
    if (!once) repeatTimer = setInterval(() => void showNativeAlarm(message ?? 'חזרו לתוואי המסלול'), 7000);
    return;
  }
  try { navigator.vibrate?.([400, 150, 400, 150, 800]); } catch {}
  void playWeb(s, v, !once);
}

export function stopAlarm() {
  sounding = false;
  if (repeatTimer) { clearInterval(repeatTimer); repeatTimer = null; }
  if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
  if (source) {
    try { source.stop(); } catch {}
    source = null;
  }
  try { navigator.vibrate?.(0); } catch {}
  if (isNativeApp()) {
    stopNativeAlarmSound();
    clearNativeAlarm();
  }
}

export function isAlarmSounding() {
  return sounding;
}
