import { useCallback, useEffect, useState } from "react";
import { VOICE_PREFS_EVENT, readVoicePrefs } from "../lib/voicePrefs";

// Which voice the server would use for *this* device's preferences.
//
// The app could not answer that before: the settings panel reported the
// server's default, which is a different question the moment a voice is picked
// in the browser, and nothing anywhere reported the rendering signature. Two
// things need it — the guide, to say what is speaking, and the offline store,
// to refuse a clip saved under a voice that is no longer configured.

export interface VoiceStatus {
  provider: "elevenlabs" | "openai" | "gemini";
  model: string;
  voiceId: string | null;
  tunable: boolean;
  signature: string;
  niqqud: boolean;
  niqqudProvider: "lexicon" | "dicta" | null;
}

// undefined: not known yet (still loading, or the request failed — offline, for
// instance). null: the server has no voice at all and the browser reads the
// text itself. Callers must tell those two apart: "unknown" may not be treated
// as "no voice".
export type VoiceStatusState = VoiceStatus | null | undefined;

export function useVoiceStatus(): { status: VoiceStatusState; providers: Record<string, boolean> | null; refresh: () => void } {
  const [status, setStatus] = useState<VoiceStatusState>(undefined);
  const [providers, setProviders] = useState<Record<string, boolean> | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    const prefs = readVoicePrefs();
    const query = prefs ? `?voice=${encodeURIComponent(JSON.stringify(prefs))}` : "";
    fetch(`/api/tour-guide${query}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setProviders(d.providers ?? null);
        setStatus(d.tts ?? null);
      })
      .catch(() => {
        // Offline, most likely. Leaving this undefined rather than null is what
        // lets a downloaded trail still play: "unknown voice" falls back to
        // whatever copy the device holds.
        if (!cancelled) setStatus(undefined);
      });
    return () => { cancelled = true; };
  }, [nonce]);

  useEffect(() => {
    const onChange = () => refresh();
    window.addEventListener(VOICE_PREFS_EVENT, onChange);
    return () => window.removeEventListener(VOICE_PREFS_EVENT, onChange);
  }, [refresh]);

  return { status, providers, refresh };
}
