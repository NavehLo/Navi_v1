// The voice the app asks for, stored on the device.
//
// The point of this is that trying a voice should not need a deploy. The voice
// id is a public identifier from the ElevenLabs Voice Library — not a secret —
// so the browser may name one and the server will use it; the API key never
// leaves the server, and the daily quota applies exactly as before.
//
// The settings matter as much as the id: the Voice Library preview plays each
// voice with its own saved settings, so a voice can sound noticeably different
// in the app than it did on the site until these match.

export const VOICE_PREFS_STORAGE_KEY = 'elevenlabs_voice';

// Fired on the window whenever the preferences change, so anything showing
// which voice is active re-checks with the server instead of going stale until
// the next reload. `storage` would not do: it only fires in *other* tabs.
export const VOICE_PREFS_EVENT = 'navi:voice-prefs';

// The account's voice list is only loaded by the settings panel, but the id is
// what every other screen has to work with. Remembering the names it saw lets
// the guide say "Jessica" instead of a 20-character identifier — and, more to
// the point, lets someone recognise at a glance that it is *not* the voice they
// picked. Public names for public ids; nothing here is a secret.
const VOICE_NAMES_STORAGE_KEY = 'elevenlabs_voice_names';

export function rememberVoiceNames(voices: Array<{ id: string; name: string }>): void {
  if (typeof window === 'undefined' || voices.length === 0) return;
  try {
    const map: Record<string, string> = {};
    for (const v of voices) if (v.id && v.name) map[v.id] = v.name;
    localStorage.setItem(VOICE_NAMES_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Storage blocked — the id alone is still shown.
  }
}

export function voiceNameFor(id: string | null | undefined): string | null {
  if (typeof window === 'undefined' || !id) return null;
  try {
    const raw = localStorage.getItem(VOICE_NAMES_STORAGE_KEY);
    if (!raw) return null;
    return (JSON.parse(raw) as Record<string, string>)[id] ?? null;
  } catch {
    return null;
  }
}

export interface VoicePrefs {
  id?: string;
  stability?: number;
  similarityBoost?: number;
  style?: number;
  speed?: number;
  // Vowel points on the geographic vocabulary before synthesis. On unless
  // explicitly turned off, so the A/B is one toggle away.
  niqqud?: boolean;
}

// Sent as the request's `voice` field. Undefined means "whatever the server is
// configured with", which is the normal case.
export function readVoicePrefs(): VoicePrefs | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const raw = localStorage.getItem(VOICE_PREFS_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as VoicePrefs;
    return parsed && Object.keys(parsed).length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function writeVoicePrefs(prefs: VoicePrefs | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (!prefs || Object.keys(prefs).length === 0) {
      localStorage.removeItem(VOICE_PREFS_STORAGE_KEY);
    } else {
      localStorage.setItem(VOICE_PREFS_STORAGE_KEY, JSON.stringify(prefs));
    }
  } catch {
    // A browser with storage blocked simply uses the server's configured voice.
  }
  window.dispatchEvent(new Event(VOICE_PREFS_EVENT));
}
