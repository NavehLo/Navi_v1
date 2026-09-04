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
}
