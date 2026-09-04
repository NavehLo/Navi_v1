import crypto from 'crypto';
import {
  isElevenLabsConfigured,
  elevenLabsVoiceSignature,
  containerFor,
  synthesizeElevenLabs,
} from './elevenlabs';

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
}

export interface SynthesizedSpeech {
  buffer: Buffer;
  format: string;
  voice: TtsVoice;
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
export function resolveTtsVoice(preferred: TextProvider): TtsVoice | null {
  if (isElevenLabsConfigured()) {
    const v = elevenLabsVoiceSignature();
    return { provider: 'elevenlabs', model: v.model, voice: v.voice, format: containerFor(v.format) };
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
  return `${voice.provider}:${voice.model}:${voice.voice}:${voice.format}`;
}

// Identifies a specific rendering of a specific narration. Used as the primary
// key of the durable audio cache, so re-rendering the same text with the same
// voice is always free.
export function audioKey(text: string, voice: TtsVoice): string {
  return crypto.createHash('sha1').update(voiceSignature(voice) + '::' + text).digest('hex');
}

// Raw synthesis — no caching. Returns null on any failure; the narration text
// alone is still a valid response.
export async function synthesize(text: string, voice: TtsVoice): Promise<SynthesizedSpeech | null> {
  if (voice.provider === 'elevenlabs') {
    const r = await synthesizeElevenLabs(text);
    return r ? { buffer: r.buffer, format: r.format, voice } : null;
  }
  const r = voice.provider === 'gemini'
    ? await synthesizeGemini(text, voice)
    : await synthesizeOpenAI(text, voice);
  return r ? { ...r, voice } : null;
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
