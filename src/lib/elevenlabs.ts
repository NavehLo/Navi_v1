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

export function isElevenLabsConfigured(): boolean {
  return !!(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID);
}

export interface VoiceSignature {
  provider: string;
  model: string;
  voice: string;
  format: string;
}

// Identifies the exact voice that produced a piece of audio. Part of the audio
// cache key, so switching voice or model produces a new file instead of
// silently serving the old one.
export function elevenLabsVoiceSignature(): VoiceSignature {
  return {
    provider: 'elevenlabs',
    model: process.env.ELEVENLABS_MODEL_ID || ELEVENLABS_DEFAULT_MODEL,
    voice: process.env.ELEVENLABS_VOICE_ID || '',
    format: process.env.ELEVENLABS_OUTPUT_FORMAT || ELEVENLABS_DEFAULT_FORMAT,
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
export async function synthesizeElevenLabs(text: string): Promise<SpeechResult | null> {
  if (!isElevenLabsConfigured()) return null;

  const voice = elevenLabsVoiceSignature();
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
          voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.0 },
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
