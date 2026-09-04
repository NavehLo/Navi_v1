import {
  type TextProvider,
  type TtsVoice,
  resolveTtsVoice,
  audioKey,
  synthesize,
} from './tts';
import {
  type CachedAudio,
  poiKeyFor,
  readNarration,
  writeNarration,
  readAudio,
  writeAudio,
  isNarrationCacheConfigured,
} from './narrationCache';

// One narration for one point of interest, produced in two halves so the
// caller can put a quota check between them: `lookupNarration` is free and
// `generateNarration` is what costs money.

// ── POI type → Hebrew description (unknown types pass through as-is) ──────────
const POI_TYPE_HE: Record<string, string> = {
  start: 'נקודת הפתיחה של המסלול',
  midway: 'אמצע המסלול',
  end: 'נקודת הסיום של המסלול',
};

// Seasonal framing is deliberately gone: a narration is cached forever, so
// anything tied to the month it was written in would be wrong most of the year.
const SYSTEM_PROMPT =
  'אתה מדריך טיולים ישראלי מנוסה בארץ ישראל. השתמש בוויב חם ומזמין, תהיה קצר וקולע (מקסימום 2-3 משפטים). התייחס להיסטוריה ולסביבה הקשורות לקואורדינטות המדויקות המסופקות. התאם את הטון לסוג הנקודה: בנקודת פתיחה — ברכת פתיחה נלהבת; באמצע המסלול — עידוד והפניית תשומת לב לסביבה; בנקודת סיום — סיכום חם ופרידה. הטקסט יוקרא בקול, אז כתוב אותו כדיבור טבעי בלי כותרות או סימנים מיוחדים.';

export function availableProviders(): Record<TextProvider, boolean> {
  return {
    openai: !!process.env.OPENAI_API_KEY,
    gemini: !!process.env.GEMINI_API_KEY,
    claude: !!process.env.ANTHROPIC_API_KEY,
  };
}

// Priority: user's in-app choice → AI_PROVIDER env → first available key.
export function pickTextProvider(requested?: string): TextProvider | null {
  const has = availableProviders();
  const req = requested?.toLowerCase() as TextProvider | undefined;
  if (req && has[req]) return req;
  const explicit = process.env.AI_PROVIDER?.toLowerCase() as TextProvider | undefined;
  if (explicit && has[explicit]) return explicit;
  if (has.openai) return 'openai';
  if (has.gemini) return 'gemini';
  if (has.claude) return 'claude';
  return null;
}

// ── Text generation, one function per provider ────────────────────────────────
async function generateTextOpenAI(system: string, user: string): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
      temperature: 0.7,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'OpenAI text error');
  return data.choices[0].message.content;
}

async function generateTextGemini(system: string, user: string): Promise<string> {
  const model = process.env.GEMINI_TEXT_MODEL || 'gemini-2.0-flash';
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { temperature: 0.7 },
      }),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Gemini text error');
  return data.candidates[0].content.parts.map((p: any) => p.text).join('');
}

async function generateTextClaude(system: string, user: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY as string,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8',
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Claude text error');
  return data.content.map((b: any) => (b.type === 'text' ? b.text : '')).join('');
}

function generateText(provider: TextProvider, system: string, user: string): Promise<string> {
  if (provider === 'gemini') return generateTextGemini(system, user);
  if (provider === 'claude') return generateTextClaude(system, user);
  return generateTextOpenAI(system, user);
}

// ── The narration pipeline ────────────────────────────────────────────────────
export interface NarrationInput {
  lat: number;
  lon: number;
  type: string;
  name?: string | null;
  osmType?: string | null;
  osmId?: number | string | null;
  trailSlug?: string | null;
}

// In-memory fallbacks, used only when the durable cache isn't configured.
// They live as long as the serverless instance does. Caching the *text* is what
// makes the audio cache useful at all: the audio key is derived from the text,
// so regenerating the text on every request meant the audio key never repeated.
const memNarration = new Map<string, string>();
const memAudio = new Map<string, { buffer: Buffer; format: string }>();

function rememberInMemory<T>(map: Map<string, T>, key: string, value: T) {
  if (map.size > 200) map.delete(map.keys().next().value!);
  map.set(key, value);
}

export interface NarrationLookup {
  poiKey: string;
  voice: TtsVoice | null;
  text: string | null;
  audio: CachedAudio | null; // durable, served by URL
  inlineAudio: { buffer: Buffer; format: string } | null; // in-memory fallback
}

// Everything that can be answered without spending anything.
export async function lookupNarration(input: NarrationInput): Promise<NarrationLookup> {
  const poiKey = poiKeyFor(input);
  const provider = pickTextProvider() ?? 'openai';
  const voice = resolveTtsVoice(provider);

  const durable = isNarrationCacheConfigured();
  const cached = durable ? await readNarration(poiKey) : null;
  const text = cached?.text ?? memNarration.get(poiKey) ?? null;

  let audio: CachedAudio | null = null;
  let inlineAudio: { buffer: Buffer; format: string } | null = null;
  if (text && voice) {
    const key = audioKey(text, voice);
    if (durable) audio = await readAudio(key);
    if (!audio) inlineAudio = memAudio.get(key) ?? null;
  }

  return { poiKey, voice, text, audio, inlineAudio };
}

export interface NarrationResult {
  poiKey: string;
  text: string;
  audioUrl: string | null;
  audio: string | null; // base64, only when no durable URL is available
  audioFormat: string;
  cached: boolean; // true when nothing was paid for
  charsSynthesized: number;
}

export function resultFromLookup(lookup: NarrationLookup): NarrationResult | null {
  if (!lookup.text) return null;
  if (lookup.audio) {
    return {
      poiKey: lookup.poiKey,
      text: lookup.text,
      audioUrl: lookup.audio.url,
      audio: null,
      audioFormat: lookup.audio.format,
      cached: true,
      charsSynthesized: 0,
    };
  }
  if (lookup.inlineAudio) {
    return {
      poiKey: lookup.poiKey,
      text: lookup.text,
      audioUrl: null,
      audio: lookup.inlineAudio.buffer.toString('base64'),
      audioFormat: lookup.inlineAudio.format,
      cached: true,
      charsSynthesized: 0,
    };
  }
  return null;
}

function buildUserPrompt(input: NarrationInput): string {
  const typeDesc = POI_TYPE_HE[input.type] ?? input.type ?? 'נקודת עניין';
  const place = input.name ? `${typeDesc} "${input.name}"` : typeDesc;
  return `המטייל נמצא עכשיו ב${place}, בנ.צ: קו רוחב ${input.lat}, קו אורך ${input.lon}. הקרא מדריך קצר לנקודה זו — אם יש שם למקום, התייחס אליו ולמה שמייחד אותו.`;
}

// The paid half: fills in whatever the lookup didn't have, then writes both
// halves back to the cache so nobody pays for this point again.
export async function generateNarration(
  input: NarrationInput,
  lookup: NarrationLookup,
  provider: TextProvider
): Promise<NarrationResult> {
  const { poiKey, voice } = lookup;

  let text = lookup.text;
  if (!text) {
    text = (await generateText(provider, SYSTEM_PROMPT, buildUserPrompt(input))).trim();
    rememberInMemory(memNarration, poiKey, text);
    await writeNarration(poiKey, text, null);
  }

  if (!voice) {
    // No server-side voice at all — the client reads the text with the
    // browser's own speechSynthesis.
    return { poiKey, text, audioUrl: null, audio: null, audioFormat: 'mp3', cached: false, charsSynthesized: 0 };
  }

  const key = audioKey(text, voice);
  const speech = await synthesize(text, voice);
  if (!speech) {
    return { poiKey, text, audioUrl: null, audio: null, audioFormat: voice.format, cached: false, charsSynthesized: 0 };
  }

  rememberInMemory(memAudio, key, { buffer: speech.buffer, format: speech.format });
  const stored = await writeAudio({
    audioKey: key,
    poiKey,
    buffer: speech.buffer,
    format: speech.format,
    chars: text.length,
  });

  return {
    poiKey,
    text,
    audioUrl: stored?.url ?? null,
    audio: stored ? null : speech.buffer.toString('base64'),
    audioFormat: speech.format,
    cached: false,
    charsSynthesized: text.length,
  };
}
