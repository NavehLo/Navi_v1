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
  niqqud?: boolean | null;
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
  // Which rung of the ladder below actually worked, so the app can say when a
  // setting had to be dropped instead of pretending it was honoured.
  variant: RequestVariant;
}

export interface SpeechFailure {
  status: number | null;
  // What ElevenLabs itself said. Passed through rather than replaced with a
  // guess: the guess is what made the previous failure impossible to diagnose.
  detail: string;
  variantsTried: RequestVariant[];
}

export type SpeechOutcome =
  | { ok: true; result: SpeechResult }
  | { ok: false; error: SpeechFailure };

// The API rejects a request outright when a field it does not accept is
// present, and which fields those are depends on the model — v3 in particular
// is stricter than the older ones. Rather than encode a guess about the
// current contract, the request is tried at three levels of ambition and the
// first that is accepted wins.
export type RequestVariant = 'full' | 'basic' | 'bare';

// v3 documents stability as three named settings rather than a continuum.
// Snapping to the nearest is what the 'basic' rung does, so a slider position
// in between still produces a request the model will accept.
function snapStability(value: number): number {
  const stops = [0, 0.5, 1];
  return stops.reduce((best, stop) =>
    Math.abs(stop - value) < Math.abs(best - value) ? stop : best
  );
}

function bodyFor(variant: RequestVariant, text: string, voice: VoiceSignature): Record<string, unknown> {
  const base = { text, model_id: voice.model };
  if (variant === 'bare') return base;
  if (variant === 'basic') {
    return {
      ...base,
      voice_settings: {
        stability: snapStability(voice.settings.stability),
        similarity_boost: voice.settings.similarityBoost,
      },
    };
  }
  return {
    ...base,
    language_code: 'he',
    voice_settings: {
      stability: voice.settings.stability,
      similarity_boost: voice.settings.similarityBoost,
      style: voice.settings.style,
      speed: voice.settings.speed,
    },
  };
}

// Keep the passed-through detail short and free of anything request-shaped.
function trimDetail(body: string): string {
  return body.replace(/\s+/g, ' ').trim().slice(0, 400);
}

const LADDER: RequestVariant[] = ['full', 'basic', 'bare'];

// Never throws. On failure the caller gets what ElevenLabs actually said, so a
// bad voice id, an unsupported setting, an expired key and an empty balance
// stop looking identical from the outside.
export async function synthesizeElevenLabs(
  text: string,
  override?: VoiceOverride | null
): Promise<SpeechOutcome> {
  if (!isElevenLabsConfigured(override)) {
    return {
      ok: false,
      error: {
        status: null,
        detail: 'ElevenLabs is not configured (missing ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID).',
        variantsTried: [],
      },
    };
  }

  const voice = elevenLabsVoiceSignature(override);
  const url = `${API_BASE}/${encodeURIComponent(voice.voice)}?output_format=${encodeURIComponent(voice.format)}`;
  const tried: RequestVariant[] = [];
  let lastStatus: number | null = null;
  let lastDetail = 'unknown error';

  for (const variant of LADDER) {
    tried.push(variant);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'xi-api-key': process.env.ELEVENLABS_API_KEY as string,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(bodyFor(variant, text, voice)),
        signal: AbortSignal.timeout(60_000),
      });

      if (res.ok) {
        return {
          ok: true,
          result: {
            buffer: Buffer.from(await res.arrayBuffer()),
            format: containerFor(voice.format),
            voice,
            variant,
          },
        };
      }

      lastStatus = res.status;
      lastDetail = trimDetail(await res.text());
      console.error('ElevenLabs TTS error:', variant, res.status, lastDetail);

      // Only a rejected *request* is worth simplifying and retrying. A bad key,
      // an exhausted balance or an outage will answer the same way every time,
      // so stop and report rather than burn two more round trips.
      if (res.status !== 400 && res.status !== 422) break;
    } catch (e) {
      lastStatus = null;
      lastDetail = e instanceof Error ? e.message : String(e);
      console.error('ElevenLabs TTS failed:', variant, e);
      break;
    }
  }

  return { ok: false, error: { status: lastStatus, detail: lastDetail, variantsTried: tried } };
}
