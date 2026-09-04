import crypto from 'crypto';
import {
  type VoiceOverride,
  type VoiceSettings,
  isElevenLabsConfigured,
  elevenLabsVoiceSignature,
  containerFor,
  synthesizeElevenLabs,
} from './elevenlabs';

export type { VoiceOverride } from './elevenlabs';
import {
  type NiqqudOutcome,
  type NiqqudProvider,
  NIQQUD_VERSION,
  resolveNiqqudProvider,
  vocalize,
} from './niqqud';

export type { NiqqudProvider, NiqqudOutcome } from './niqqud';

// Text-to-speech, one voice chosen per request.
//
// Order: ElevenLabs first — it is the only provider here whose Hebrew is good
// enough for narration — then the caller's picked provider if it has TTS, then
// the other one. Null means no server-side voice is available and the client
// falls back to the browser's own speechSynthesis. Claude has no TTS at all.

export type TextProvider = 'openai' | 'gemini' | 'claude';
export type TtsProvider = 'elevenlabs' | 'openai' | 'gemini';

export interface TtsVoice {
  provider: TtsProvider;
  model: string;
  voice: string;
  format: string; // container: mp3 | wav
  settings?: VoiceSettings; // ElevenLabs only
  // Vowel points added before synthesis. Off is a distinct rendering from on,
  // and Nakdan is a distinct rendering from the lexicon, so both belong to the
  // voice's identity.
  niqqud?: boolean;
  niqqudProvider?: NiqqudProvider;
}

export interface SynthesizedSpeech {
  buffer: Buffer;
  format: string;
  voice: TtsVoice;
  // What was actually sent to the voice, and by which diacritizer. The stored
  // narration is plain Hebrew, so without this there is no way to see what the
  // model was asked to read.
  spokenText?: string;
  niqqud?: NiqqudOutcome | null;
  // Set when ElevenLabs would not accept the full request and a simplified one
  // was used instead — the app says so rather than implying the settings took.
  degraded?: 'basic' | 'bare';
}

// Synthesis either produced audio or has a reason it did not. The reason is the
// provider's own words: replacing it with a guess is what made the last failure
// impossible to diagnose from the app.
export interface SynthesisOutcome {
  speech: SynthesizedSpeech | null;
  error: string | null;
}

const TTS_INSTRUCTIONS =
  'דבר בעברית טבעית ורהוטה, בטון חם ומזמין של מדריך טיולים ישראלי מנוסה.';

export const AUDIO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
};

function geminiVoice(): TtsVoice {
  return {
    provider: 'gemini',
    model: process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts',
    voice: process.env.GEMINI_TTS_VOICE || 'Kore',
    format: 'wav',
  };
}

// Which voice a synthesis request will actually use. Deterministic from env
// plus the caller's preference, so a cache can be keyed on it *before* the
// call. (The old key mixed every configured provider's signature together, so
// a Gemini-voiced clip could be served to a caller who asked for OpenAI.)
export function resolveTtsVoice(preferred: TextProvider, override?: VoiceOverride | null): TtsVoice | null {
  if (isElevenLabsConfigured(override)) {
    const v = elevenLabsVoiceSignature(override);
    return {
      provider: 'elevenlabs',
      model: v.model,
      voice: v.voice,
      format: containerFor(v.format),
      settings: v.settings,
      niqqud: override?.niqqud !== false,
      niqqudProvider: resolveNiqqudProvider(),
    };
  }
  if (preferred === 'gemini' && process.env.GEMINI_API_KEY) return geminiVoice();
  if (process.env.OPENAI_API_KEY) {
    return {
      provider: 'openai',
      model: process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
      voice: process.env.OPENAI_TTS_VOICE || 'nova',
      format: 'mp3',
    };
  }
  if (process.env.GEMINI_API_KEY) return geminiVoice();
  return null;
}

export function voiceSignature(voice: TtsVoice): string {
  const s = voice.settings;
  // The settings are part of the identity: the same voice at stability 0.3 is
  // a different rendering from the same voice at 0.7, and must not be served
  // from the other's cache entry. Same for the niqqud pass — and its version,
  // so improving the lexicon re-renders instead of serving the old reading.
  const tuning = s ? `:${s.stability}:${s.similarityBoost}:${s.style}:${s.speed}` : '';
  const nq = voice.niqqud ? `:nq${NIQQUD_VERSION}:${voice.niqqudProvider ?? 'lexicon'}` : '';
  return `${voice.provider}:${voice.model}:${voice.voice}:${voice.format}${tuning}${nq}`;
}

// Identifies a specific rendering of a specific narration. Used as the primary
// key of the durable audio cache, so re-rendering the same text with the same
// voice is always free.
export function audioKey(text: string, voice: TtsVoice): string {
  return crypto.createHash('sha1').update(voiceSignature(voice) + '::' + text).digest('hex');
}

// What the app is allowed to say about a clip: which voice produced it, in
// terms a person can check against the settings panel. Public identifiers
// only — a voice id is a Voice Library identifier, not a secret.
export interface VoiceStamp {
  provider: TtsProvider;
  model: string;
  voiceId: string;
  signature: string;
  niqqud: boolean;
  niqqudProvider: NiqqudProvider | null;
}

export function voiceStamp(voice: TtsVoice | null): VoiceStamp | null {
  if (!voice) return null;
  return {
    provider: voice.provider,
    model: voice.model,
    voiceId: voice.voice,
    signature: voiceSignature(voice),
    niqqud: !!voice.niqqud,
    niqqudProvider: voice.niqqud ? (voice.niqqudProvider ?? 'lexicon') : null,
  };
}

// Raw synthesis — no caching. Returns null on any failure; the narration text
// alone is still a valid response.
export async function synthesize(
  text: string,
  voice: TtsVoice,
  override?: VoiceOverride | null
): Promise<SynthesisOutcome> {
  if (voice.provider === 'elevenlabs') {
    // Only ElevenLabs gets the vowel points: the OpenAI and Gemini voices are
    // fallbacks whose Hebrew is the problem this project moved away from, and
    // feeding them niqqud has not been shown to help.
    const niqqud = voice.niqqud ? await vocalize(text, voice.niqqudProvider ?? 'lexicon') : null;
    const spoken = niqqud?.text ?? text;
    const outcome = await synthesizeElevenLabs(spoken, override);
    if (!outcome.ok) {
      const { status, detail } = outcome.error;
      return { speech: null, error: status ? `ElevenLabs ${status}: ${detail}` : detail };
    }
    return {
      speech: {
        buffer: outcome.result.buffer,
        format: outcome.result.format,
        voice,
        spokenText: spoken,
        niqqud,
        degraded: outcome.result.variant === 'full' ? undefined : outcome.result.variant,
      },
      error: null,
    };
  }
  const r = voice.provider === 'gemini'
    ? await synthesizeGemini(text, voice)
    : await synthesizeOpenAI(text, voice);
  return r
    ? { speech: { ...r, voice, spokenText: text, niqqud: null }, error: null }
    : { speech: null, error: `${voice.provider} TTS failed — see server logs.` };
}

async function synthesizeOpenAI(text: string, voice: TtsVoice): Promise<{ buffer: Buffer; format: string } | null> {
  try {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: voice.model,
        voice: voice.voice,
        input: text,
        response_format: 'mp3',
        instructions: TTS_INSTRUCTIONS,
      }),
    });
    if (!res.ok) {
      console.error('OpenAI TTS error:', res.status, await res.text());
      return null;
    }
    return { buffer: Buffer.from(await res.arrayBuffer()), format: 'mp3' };
  } catch (e) {
    console.error('OpenAI TTS failed:', e);
    return null;
  }
}

async function synthesizeGemini(text: string, voice: TtsVoice): Promise<{ buffer: Buffer; format: string } | null> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${voice.model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice.voice } } },
          },
        }),
      }
    );
    if (!res.ok) {
      console.error('Gemini TTS error:', res.status, await res.text());
      return null;
    }
    const data = await res.json();
    const part = data.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
    if (!part) return null;
    // Gemini returns raw PCM (e.g. audio/L16;rate=24000) — wrap in a WAV header
    const rate = parseInt(/rate=(\d+)/.exec(part.inlineData.mimeType || '')?.[1] || '24000', 10);
    return { buffer: pcmToWav(Buffer.from(part.inlineData.data, 'base64'), rate), format: 'wav' };
  } catch (e) {
    console.error('Gemini TTS failed:', e);
    return null;
  }
}

// Wrap 16-bit mono PCM in a minimal WAV header so browsers can play it.
function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const channels = 1, bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
