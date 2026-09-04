// ElevenLabs text-to-speech.
//
// Hebrew is only supported by Eleven v3 (`eleven_v3`, 70+ languages). The
// cheaper models — Multilingual v2 (29 languages) and Flash v2.5 (32) — do not
// cover Hebrew, so there is no cheaper tier to fall back to here.
//
// `mp3_44100_192` requires a Creator plan; for spoken narration
// `mp3_44100_64` is enough and produces smaller files to store and to sync
// offline, which is what the narration cache wants anyway.

const API_BASE = 'https://api.elevenlabs.io/v1/text-to-speech';

export const ELEVENLABS_DEFAULT_MODEL = 'eleven_v3';
export const ELEVENLABS_DEFAULT_FORMAT = 'mp3_44100_64';

// The dials the Voice Library preview exposes. Its own preview plays each voice
// with that voice's saved settings, which is why a voice can sound different in
// the app than it did on the site — these are what close the gap.
export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  stability: 0.5,
  similarityBoost: 0.75,
  style: 0,
  speed: 1.0,
};

export interface VoiceSettings {
  stability: number;
  similarityBoost: number;
  style: number;
  speed: number;
}

// Anything a caller may override per request. The api key is never part of
// this — it stays server-side.
export interface VoiceOverride {
  id?: string | null;
  stability?: number | null;
  similarityBoost?: number | null;
  style?: number | null;
  speed?: number | null;
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function resolveVoiceSettings(override?: VoiceOverride | null): VoiceSettings {
  const base: VoiceSettings = {
    stability: clamp(process.env.ELEVENLABS_STABILITY, 0, 1, DEFAULT_VOICE_SETTINGS.stability),
    similarityBoost: clamp(process.env.ELEVENLABS_SIMILARITY, 0, 1, DEFAULT_VOICE_SETTINGS.similarityBoost),
    style: clamp(process.env.ELEVENLABS_STYLE, 0, 1, DEFAULT_VOICE_SETTINGS.style),
    speed: clamp(process.env.ELEVENLABS_SPEED, 0.7, 1.2, DEFAULT_VOICE_SETTINGS.speed),
  };
  if (!override) return base;
  return {
    stability: override.stability == null ? base.stability : clamp(override.stability, 0, 1, base.stability),
    similarityBoost: override.similarityBoost == null ? base.similarityBoost : clamp(override.similarityBoost, 0, 1, base.similarityBoost),
    style: override.style == null ? base.style : clamp(override.style, 0, 1, base.style),
    speed: override.speed == null ? base.speed : clamp(override.speed, 0.7, 1.2, base.speed),
  };
}

// A voice id is a public identifier from the Voice Library, not a secret, so a
// caller may name one. Restricted to the characters ElevenLabs actually uses,
// so nothing else can be smuggled into the request path.
const VOICE_ID_RE = /^[A-Za-z0-9]{16,40}$/;

export function resolveVoiceId(override?: VoiceOverride | null): string {
  const requested = override?.id?.trim();
  if (requested && VOICE_ID_RE.test(requested)) return requested;
  return process.env.ELEVENLABS_VOICE_ID || '';
}

export function isElevenLabsConfigured(override?: VoiceOverride | null): boolean {
  return !!(process.env.ELEVENLABS_API_KEY && resolveVoiceId(override));
}

export interface VoiceSignature {
  provider: string;
  model: string;
  voice: string;
  format: string;
  settings: VoiceSettings;
}

// Identifies the exact voice that produced a piece of audio. Part of the audio
// cache key, so changing the voice, the model *or any of its settings*
// produces a new file instead of silently serving the old one — and switching
// back to a voice you already used costs nothing.
export function elevenLabsVoiceSignature(override?: VoiceOverride | null): VoiceSignature {
  return {
    provider: 'elevenlabs',
    model: process.env.ELEVENLABS_MODEL_ID || ELEVENLABS_DEFAULT_MODEL,
    voice: resolveVoiceId(override),
    format: process.env.ELEVENLABS_OUTPUT_FORMAT || ELEVENLABS_DEFAULT_FORMAT,
    settings: resolveVoiceSettings(override),
  };
}

// The API's output_format values encode the container in their prefix
// (mp3_44100_64, pcm_16000, ulaw_8000...). We only need the container name for
// the MIME type and the stored file extension.
export function containerFor(outputFormat: string): string {
  const container = outputFormat.split('_')[0];
  return container === 'mp3' ? 'mp3' : container === 'pcm' ? 'pcm' : container;
}

export interface SpeechResult {
  buffer: Buffer;
  format: string; // 'mp3'
  voice: VoiceSignature;
}

// Returns null (never throws) so the caller can fall through to OpenAI/Gemini
// and ultimately to the browser's speechSynthesis — narration is best-effort.
export async function synthesizeElevenLabs(
  text: string,
  override?: VoiceOverride | null
): Promise<SpeechResult | null> {
  if (!isElevenLabsConfigured(override)) return null;

  const voice = elevenLabsVoiceSignature(override);
  try {
    const res = await fetch(
      `${API_BASE}/${encodeURIComponent(voice.voice)}?output_format=${encodeURIComponent(voice.format)}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': process.env.ELEVENLABS_API_KEY as string,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          model_id: voice.model,
          language_code: 'he',
          voice_settings: {
            stability: voice.settings.stability,
            similarity_boost: voice.settings.similarityBoost,
            style: voice.settings.style,
            speed: voice.settings.speed,
          },
        }),
        signal: AbortSignal.timeout(60_000),
      }
    );

    if (!res.ok) {
      console.error('ElevenLabs TTS error:', res.status, await res.text());
      return null;
    }

    return {
      buffer: Buffer.from(await res.arrayBuffer()),
      format: containerFor(voice.format),
      voice,
    };
  } catch (e) {
    console.error('ElevenLabs TTS failed:', e);
    return null;
  }
}
