import {
  type TextProvider,
  type TtsVoice,
  type VoiceOverride,
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
import {
  type Grounding,
  gatherGrounding,
  groundingPromptBlock,
  sourcesForStorage,
} from './grounding';

// One narration for one point of interest, produced in two halves so the
// caller can put a quota check between them: `lookupNarration` is free and
// `generateNarration` is what costs money.

// ── POI type → Hebrew description (unknown types pass through as-is) ──────────
const POI_TYPE_HE: Record<string, string> = {
  start: 'נקודת הפתיחה של המסלול',
  midway: 'אמצע המסלול',
  end: 'נקודת הסיום של המסלול',
};

// Written against the failure mode of the old prompt, which had nothing but a
// coordinate to work with and so produced "the view here is breathtaking" for
// every point on every trail. The rules below are all one rule: say something
// only if a source says it.
//
// Bump PROMPT_VERSION in narrationCache.ts whenever this changes — it is what
// retires narrations written under the old wording.
const SYSTEM_PROMPT = [
  'אתה מדריך טיולים ישראלי מנוסה. אתה כותב קטע קריינות קצר שיוקרא בקול למטייל שעומד עכשיו בנקודה מסוימת במסלול.',
  '',
  'כללים מחייבים:',
  '1. כתוב אך ורק על סמך המקורות שיסופקו לך. אל תמציא שום עובדה, שם, תאריך או מספר שאינם מופיעים בהם.',
  '2. אם סופקו מקורות — הבא לפחות עובדה קונקרטית אחת מתוכם: שם, תאריך, אדם, אירוע, מספר או תקופה.',
  '3. אם לא סופקו מקורות — תאר עובדתית את סוג הנקודה ואת מה שידוע עליה מהנתונים שקיבלת בלבד, ואל תמלא את החסר בניחושים.',
  '4. אסור להשתמש בקלישאות נוף: "הנוף עוצר נשימה", "יפה במיוחד", "קסום", "מרהיב". אסור לספקולציה על מזג אוויר, פריחה או עונה — הקטע נשמר לתמיד ויושמע בכל חודש בשנה.',
  '5. אל תחזור על נושאים שכבר סופרו במסלול הזה, אם צוינו כאלה. כל נקודה מוסיפה משהו חדש.',
  '6. אורך: 4 עד 6 משפטים, בערך 600 תווים.',
  '7. הטקסט יוקרא בקול: כתוב דיבור טבעי ורציף, בלי כותרות, בלי רשימות, בלי סוגריים, בלי סימנים מיוחדים ובלי ציון מקורות.',
  '8. התאם את הפתיחה לסוג הנקודה: בנקודת הפתיחה — ברכה קצרה; בנקודת הסיום — סיום קצר. בשאר הנקודות גש ישר לעניין.',
].join('\n');

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

// Low, not zero: the narration should read as speech rather than as a
// database row, but it is retelling sourced facts, not inventing them.
const TEXT_TEMPERATURE = 0.3;

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
      temperature: TEXT_TEMPERATURE,
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
  const model = process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash';
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { temperature: TEXT_TEMPERATURE },
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
      model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
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
  tags?: Record<string, string> | null;
  // Points already narrated on this trail, so the guide doesn't tell the same
  // story twice. Not part of the cache key: a narration has to stand on its own
  // whichever order the walker meets the points in.
  covered?: string[] | null;
  // Lets the app try a different ElevenLabs voice, or different settings for
  // the same one, without a redeploy. Part of the audio cache key, never of the
  // narration key: the words don't change when the voice does.
  voice?: VoiceOverride | null;
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
  const voice = resolveTtsVoice(provider, input.voice);

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

function buildUserPrompt(input: NarrationInput, grounding: Grounding): string {
  const typeDesc = POI_TYPE_HE[input.type] ?? input.type ?? 'נקודת עניין';
  const place = input.name ? `${typeDesc} "${input.name}"` : typeDesc;

  const parts = [
    `המטייל נמצא עכשיו ב${place}, בנ.צ: קו רוחב ${input.lat}, קו אורך ${input.lon}.`,
  ];

  const sources = groundingPromptBlock(grounding);
  parts.push(sources ?? 'לא נמצאו מקורות על הנקודה הזו. אל תמציא עובדות — הסתמך רק על סוג הנקודה ועל שמה, אם יש לה שם.');

  const covered = (input.covered ?? []).filter(Boolean);
  if (covered.length > 0) {
    parts.push(`נושאים שכבר סופרו במסלול הזה, אל תחזור עליהם: ${covered.join('; ')}.`);
  }

  parts.push('כתוב עכשיו את קטע הקריינות.');
  return parts.join('\n\n');
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
    const grounding = await gatherGrounding({ lat: input.lat, lon: input.lon, tags: input.tags });
    text = (await generateText(provider, SYSTEM_PROMPT, buildUserPrompt(input, grounding))).trim();
    rememberInMemory(memNarration, poiKey, text);
    // The sources are stored with the text so it stays possible to check, after
    // the fact, what the guide was actually working from.
    await writeNarration(poiKey, text, sourcesForStorage(grounding));
  }

  if (!voice) {
    // No server-side voice at all — the client reads the text with the
    // browser's own speechSynthesis.
    return { poiKey, text, audioUrl: null, audio: null, audioFormat: 'mp3', cached: false, charsSynthesized: 0 };
  }

  const key = audioKey(text, voice);
  const { speech } = await synthesize(text, voice, input.voice);
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
