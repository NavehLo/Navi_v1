import {
  type TextProvider,
  type TtsVoice,
  type VoiceOverride,
  type VoiceStamp,
  resolveTtsVoice,
  audioKey,
  synthesize,
  voiceStamp,
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
  isWorthNarrating,
  sourcesForStorage,
} from './grounding';
import { geminiTokens, recordAiUsage } from './aiUsage';
import { ensureAllowed, isAiLimitError } from './aiLimits';

// One narration for one point of interest, produced in two halves so the
// caller can put a quota check between them: `lookupNarration` is free and
// `generateNarration` is what costs money.

// Written against the failure mode of the old prompt, which had nothing but a
// coordinate to work with and so produced "the view here is breathtaking" for
// every point on every trail. The rules below are all one rule: say something
// only if a source says it — and a point without a source is never sent here
// at all (see `generateNarration`), so the prompt no longer needs a rule for
// what to do with nothing.
//
// Bump PROMPT_VERSION in poiKey.ts whenever this changes in a way that should
// retire narrations written under the old wording.
const SYSTEM_PROMPT = [
  'אתה מדריך טיולים ישראלי מנוסה. אתה כותב קטע קריינות קצר שיוקרא בקול למטייל שעומד עכשיו בנקודה מסוימת במסלול.',
  '',
  'כללים מחייבים:',
  '1. כתוב אך ורק על סמך המקורות שיסופקו לך. אל תמציא שום עובדה, שם, תאריך או מספר שאינם מופיעים בהם.',
  '2. הקטע חייב להיות על הנקודה הזו עצמה, ומורכב אך ורק מהעובדות שבמקורות: שם, תאריך, אדם, אירוע, מספר, תקופה או מה נמצא שם בפועל.',
  '3. אל תכתוב משפטים שנכונים לכל מקום מהסוג הזה. "מקום שמזמין להרגיש את כוח הטבע", "אתר מרתק", "הנוף עוצר נשימה" — אסורים. אם משפט יכול להופיע בקריינות של מערה אחרת, מעיין אחר או חורבה אחרת, מחק אותו.',
  '4. אסור לספקולציה על מזג אוויר, פריחה או עונה — הקטע נשמר לתמיד ויושמע בכל חודש בשנה. אסור לתאר מה המטייל רואה או מרגיש.',
  '5. אל תחזור על נושאים שכבר סופרו במסלול הזה, אם צוינו כאלה. כל נקודה מוסיפה משהו חדש.',
  '6. האורך נקבע לפי כמות המידע ולא להפך: עד 6 משפטים כשיש הרבה במקורות, ומשפט או שניים בלבד כשיש מעט. עדיף קטע קצר ומדויק על פני קטע מלא ריפוד. אל תוסיף משפט סיכום, מסקנה או הזמנה להתרשם.',
  '7. הטקסט יוקרא בקול: כתוב דיבור טבעי ורציף, בלי כותרות, בלי רשימות, בלי סוגריים, בלי סימנים מיוחדים ובלי ציון מקורות.',
  '8. פתח ישר בעובדה הראשונה. אל תפתח בפנייה למטייל ואל תספר לו היכן הוא נמצא — הוא יודע. אסור לפתוח ב"אתם נמצאים", "לפניכם", "ברוכים הבאים" או כל נוסח דומה.',
].join('\n');

export function availableProviders(): Record<TextProvider, boolean> {
  return {
    openai: !!process.env.OPENAI_API_KEY,
    gemini: !!process.env.GEMINI_API_KEY,
    claude: !!process.env.ANTHROPIC_API_KEY,
  };
}

// The paid providers plus Google's free tier, which is a different key against
// a different model and so has to be named separately.
//
// The free tier goes first, at the owner's explicit choice: its rate limits
// and Google's right to train on the prompts were both weighed and accepted,
// and narration is written from public Wikipedia text about public places.
// When it is rate limited the chain simply moves on to a paid key, so the
// effect of it being first is that the free quota is spent before money is.
export type TextEngine = TextProvider | 'gemini-free';

const GEMINI_FREE_MODEL = process.env.GEMINI_FREE_TEXT_MODEL || 'gemini-3.5-flash-lite';

function engineAvailable(engine: TextEngine): boolean {
  if (engine === 'gemini-free') return !!process.env.GEMINI_FREE_API_KEY;
  return availableProviders()[engine];
}

// An engine that has just refused is stood down for a few minutes rather than
// asked again on the very next point. A depleted prepaid balance or an
// exhausted free quota does not recover within a tour, and trying it first
// every time adds a failed round trip to every narration — which is what
// AI_PROVIDER pointing at a dead key would otherwise cost.
const PAUSE_MS = 10 * 60_000;
const pausedUntil = new Map<TextEngine, number>();

function pauseEngine(engine: TextEngine): void {
  pausedUntil.set(engine, Date.now() + PAUSE_MS);
}

function isPaused(engine: TextEngine): boolean {
  const until = pausedUntil.get(engine);
  return until !== undefined && until > Date.now();
}

// Every engine that could write this narration, best first.
//
// A single provider was a single point of failure: when the Gemini key ran out
// of prepaid credit the whole request answered 500 with Google's billing page
// in the message, although an OpenAI key sat right there in the environment.
// Falling through costs nothing when the first engine works.
export function textProviderChain(requested?: string): TextEngine[] {
  const order: TextEngine[] = [];
  const add = (engine?: TextEngine | null) => {
    if (engine && engineAvailable(engine) && !order.includes(engine)) order.push(engine);
  };
  add(requested?.toLowerCase() as TextEngine | undefined);
  add(process.env.AI_PROVIDER?.toLowerCase() as TextEngine | undefined);
  // Free quota before paid keys; OpenAI ahead of the paid Gemini key, which is
  // the one that ran out of prepaid credit.
  for (const engine of ['gemini-free', 'openai', 'gemini', 'claude'] as TextEngine[]) add(engine);

  // Engines that failed recently go to the back rather than being dropped:
  // the judgement that one is dead was made from a single response, and being
  // wrong about it must not leave the guide with nothing to try.
  const ready = order.filter((e) => !isPaused(e));
  return ready.length > 0 ? [...ready, ...order.filter(isPaused)] : order;
}

// Priority: user's in-app choice → AI_PROVIDER env → first available key.
export function pickTextProvider(requested?: string): TextEngine | null {
  return textProviderChain(requested)[0] ?? null;
}

// Which voice family to prefer, for an engine that may not be one of the
// three the TTS side knows about.
export function ttsPreferenceFor(engine: TextEngine | null): TextProvider {
  return engine === 'gemini-free' ? 'gemini' : (engine ?? 'openai');
}

// Low, not zero: the narration should read as speech rather than as a
// database row, but it is retelling sourced facts, not inventing them.
const TEXT_TEMPERATURE = 0.3;

// ── Text generation, one function per provider ────────────────────────────────
// Options for callers other than the narration: the trail description asks
// for a JSON answer and a longer one, and must not hang on a slow provider.
export interface TextOptions {
  json?: boolean;
  maxTokens?: number;
  timeoutMs?: number;
  // Overrides OPENAI_TEXT_MODEL for this call only.
  openaiModel?: string;
}

async function generateTextOpenAI(system: string, user: string, opts: TextOptions = {}): Promise<string> {
  const model = opts.openaiModel || process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini';
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      temperature: TEXT_TEMPERATURE,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'OpenAI text error');
  await recordAiUsage({
    kind: 'text', provider: 'openai', model: data.model || model,
    inputTokens: data.usage?.prompt_tokens, outputTokens: data.usage?.completion_tokens,
  });
  return data.choices[0].message.content;
}

// Shared by both Gemini keys: the paid project key and the free-tier one,
// which differ only in the key and the model they are allowed to drive.
async function generateTextGemini(system: string, user: string, free = false, opts: TextOptions = {}): Promise<string> {
  // gemini-2.5-flash was retired for new users in September 2026 (the API
  // answers "no longer available"); 3.6 is what Google points to instead.
  const model = free ? GEMINI_FREE_MODEL : (process.env.GEMINI_TEXT_MODEL || 'gemini-3.6-flash');
  const key = free ? process.env.GEMINI_FREE_API_KEY : process.env.GEMINI_API_KEY;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: {
          temperature: TEXT_TEMPERATURE,
          ...(opts.maxTokens ? { maxOutputTokens: opts.maxTokens } : {}),
          ...(opts.json ? { responseMimeType: 'application/json' } : {}),
        },
      }),
      ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Gemini text error');
  await recordAiUsage({ kind: 'text', provider: free ? 'gemini-free' : 'gemini', model, ...geminiTokens(data) });
  if (!data.candidates?.[0]?.content?.parts) throw new Error('Gemini returned no text');
  return data.candidates[0].content.parts.map((p: any) => p.text).join('');
}

async function generateTextClaude(system: string, user: string, opts: TextOptions = {}): Promise<string> {
  const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY as string,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens ?? 1024,
      system,
      messages: [{ role: 'user', content: user }],
    }),
    ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Claude text error');
  await recordAiUsage({
    kind: 'text', provider: 'claude', model: data.model || model,
    inputTokens: data.usage?.input_tokens, outputTokens: data.usage?.output_tokens,
  });
  return data.content.map((b: any) => (b.type === 'text' ? b.text : '')).join('');
}

async function generateText(engine: TextEngine, system: string, user: string, opts?: TextOptions): Promise<string> {
  // Over a limit (lib/aiLimits): this engine is skipped, the chain goes on.
  await ensureAllowed(engine);
  if (engine === 'gemini') return generateTextGemini(system, user, false, opts);
  if (engine === 'gemini-free') return generateTextGemini(system, user, true, opts);
  if (engine === 'claude') return generateTextClaude(system, user, opts);
  return generateTextOpenAI(system, user, opts);
}

// Walks the chain until one engine answers. A provider that is out of credit,
// rate limited or having an outage costs one failed call and the next one is
// tried; only when every engine has refused does the caller see an error, and
// then it is the last real reason rather than the first.
export async function generateTextWithFallback(
  chain: TextEngine[],
  system: string,
  user: string,
  opts?: TextOptions
): Promise<{ text: string; engine: TextEngine }> {
  let lastError: unknown = new Error('no text provider configured');
  for (const engine of chain) {
    try {
      const text = (await generateText(engine, system, user, opts)).trim();
      if (text) return { text, engine };
      lastError = new Error(`${engine} returned empty text`);
    } catch (e) {
      lastError = e;
      // A limit is about this person or today, not about the engine: it stays
      // in the chain for everyone else.
      if (isAiLimitError(e)) continue;
      pauseEngine(engine);
      console.error(`Narration text via ${engine} failed, trying the next provider:`, e);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
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
  const voice = resolveTtsVoice(ttsPreferenceFor(pickTextProvider()), input.voice);

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
  // Which voice this clip was rendered with. Travels with every response, hit
  // or miss, so the app can say what is speaking instead of reporting the
  // server's default and hoping it is the same one. Null when there is no
  // server-side voice and the browser reads the text itself.
  voice: VoiceStamp | null;
  // Why there is no server voice, or why it is not the one that was asked
  // for — in the provider's own words where there are any. Null when nothing
  // went wrong.
  voiceError?: string | null;
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
      voice: voiceStamp(lookup.voice),
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
      voice: voiceStamp(lookup.voice),
    };
  }
  return null;
}

function buildUserPrompt(input: NarrationInput, grounding: Grounding): string {
  const typeDesc = input.type || 'נקודת עניין';
  const place = input.name ? `${typeDesc} "${input.name}"` : typeDesc;

  const parts = [
    `המטייל נמצא עכשיו ב${place}, בנ.צ: קו רוחב ${input.lat}, קו אורך ${input.lon}.`,
  ];

  // Never null here: a point with nothing to say is turned away before the
  // prompt is built.
  const sources = groundingPromptBlock(grounding);
  if (sources) parts.push(sources);

  const covered = (input.covered ?? []).filter(Boolean);
  if (covered.length > 0) {
    parts.push(`נושאים שכבר סופרו במסלול הזה, אל תחזור עליהם: ${covered.join('; ')}.`);
  }

  parts.push('כתוב עכשיו את קטע הקריינות.');
  return parts.join('\n\n');
}

// The sources a new narration would be written from, or null when there are
// none worth writing from — no article about the point, no description on it.
// Free (Wikipedia only), so the routes call it before their quota checks: a
// point with nothing to say must not use up a daily slot. Returns an empty
// grounding when the text is already cached, since nothing will be written.
export async function groundingFor(input: NarrationInput, lookup: NarrationLookup): Promise<Grounding | null> {
  if (lookup.text) return { sources: [], osmFacts: [] };
  const grounding = await gatherGrounding({ lat: input.lat, lon: input.lon, name: input.name, tags: input.tags });
  return isWorthNarrating(grounding, input.tags) ? grounding : null;
}

// The paid half: fills in whatever the lookup didn't have, then writes both
// halves back to the cache so nobody pays for this point again.
//
// `grounding` is what `groundingFor` returned. Without it the sources are
// gathered here, and null comes back when there is nothing specific to say —
// a narration that could be about any cave is worth less than silence, and it
// would have cost the same as a real one.
export async function generateNarration(
  input: NarrationInput,
  lookup: NarrationLookup,
  provider: TextEngine,
  grounding?: Grounding
): Promise<NarrationResult | null> {
  const { poiKey, voice } = lookup;

  let text = lookup.text;
  if (!text) {
    grounding ??= (await groundingFor(input, lookup)) ?? undefined;
    if (!grounding) return null;
    // Starting from the engine the caller picked, then whatever else is
    // configured — one provider being out of credit must not silence the
    // guide when another key is sitting right there.
    const written = await generateTextWithFallback(
      textProviderChain(provider),
      SYSTEM_PROMPT,
      buildUserPrompt(input, grounding)
    );
    text = written.text;
    rememberInMemory(memNarration, poiKey, text);
    // The sources are stored with the text so it stays possible to check, after
    // the fact, what the guide was actually working from.
    await writeNarration(poiKey, text, sourcesForStorage(grounding));
  }

  if (!voice) {
    // No server-side voice at all — the client reads the text with the
    // browser's own speechSynthesis.
    return { poiKey, text, audioUrl: null, audio: null, audioFormat: 'mp3', cached: false, charsSynthesized: 0, voice: null };
  }

  const { speech, error } = await synthesize(text, voice, input.voice);
  if (!speech) {
    // Synthesis failed: the text is still worth returning, but nothing spoke
    // it, so no voice is claimed — and the provider's own words travel with
    // the response. Dropping them here is what made every failure look like
    // "no voice is configured on the server", whatever had actually gone
    // wrong, so a refused voice was indistinguishable from a missing key.
    return {
      poiKey, text, audioUrl: null, audio: null, audioFormat: voice.format,
      cached: false, charsSynthesized: 0, voice: null, voiceError: error,
    };
  }

  // Keyed on the voice that spoke. When a refused voice was replaced by the
  // fallback, keying on the requested one would file the fallback's audio
  // under the premium voice's name — and hand it back unchanged after an
  // upgrade.
  const key = audioKey(text, speech.voice);

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
    voice: voiceStamp(speech.voice),
    // Set when the voice that spoke is not the voice that was asked for, so
    // the app can say so instead of quietly sounding different.
    voiceError: speech.voice.voice === voice.voice
      ? null
      : `הקול שנבחר אינו זמין בחשבון ElevenLabs הזה, והקריינות הוקראה בקול חלופי.`,
  };
}
