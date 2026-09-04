import { NextResponse } from 'next/server';
import { rateLimit, clientIp } from '../../../lib/rateLimit';
import { bearerToken, checkAndIncrementGuideQuota } from '../../../lib/supabaseServer';
import {
  type TextProvider,
  type SynthesizedSpeech,
  resolveTtsVoice,
  audioKey,
  synthesize,
} from '../../../lib/tts';

// Per signed-in user (real quota, tied to identity via Supabase).
const DAILY_LIMIT_PER_USER = parseInt(process.env.GUIDE_DAILY_LIMIT_PER_USER || '30', 10);
// Per IP, only for anonymous (not signed in) callers.
const DAILY_LIMIT_ANON = parseInt(process.env.GUIDE_DAILY_LIMIT_ANON || '8', 10);

// ── POI type → Hebrew description (unknown types pass through for future use) ──
const POI_TYPE_HE: Record<string, string> = {
  start: "נקודת הפתיחה של המסלול",
  midway: "אמצע המסלול",
  end: "נקודת הסיום של המסלול",
};

const SYSTEM_PROMPT =
  "אתה מדריך טיולים ישראלי מנוסה בארץ ישראל. השתמש בוויב חם ומזמין, תהיה קצר וקולע (מקסימום 2-3 משפטים). התייחס לעונת השנה, לפריחה אפשרית, משקעים או היסטוריה הקשורה לקואורדינטות המדויקות המסופקות. התאם את הטון לסוג הנקודה: בנקודת פתיחה — ברכת פתיחה נלהבת; באמצע המסלול — עידוד והפניית תשומת לב לסביבה; בנקודת סיום — סיכום חם ופרידה. הטקסט יוקרא בקול, אז כתוב אותו כדיבור טבעי בלי כותרות או סימנים מיוחדים.";

type Provider = TextProvider;

function availableProviders(): Record<Provider, boolean> {
  return {
    openai: !!process.env.OPENAI_API_KEY,
    gemini: !!process.env.GEMINI_API_KEY,
    claude: !!process.env.ANTHROPIC_API_KEY,
  };
}

// Priority: user's in-app choice → AI_PROVIDER env → first available key.
function pickTextProvider(requested?: string): Provider | null {
  const has = availableProviders();
  const req = requested?.toLowerCase() as Provider | undefined;
  if (req && has[req]) return req;
  const explicit = process.env.AI_PROVIDER?.toLowerCase() as Provider | undefined;
  if (explicit && has[explicit]) return explicit;
  if (has.openai) return 'openai';
  if (has.gemini) return 'gemini';
  if (has.claude) return 'claude';
  return null;
}

// Lets the settings UI show only providers that actually have a key configured.
// Booleans only — no secrets leave the server.
export async function GET() {
  return NextResponse.json({ providers: availableProviders() });
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

async function generateText(provider: Provider, system: string, user: string): Promise<string> {
  if (provider === 'gemini') return generateTextGemini(system, user);
  if (provider === 'claude') return generateTextClaude(system, user);
  return generateTextOpenAI(system, user);
}

// Process-memory audio cache. It only survives as long as a serverless
// instance does; the durable cache lives in lib/narrationCache.
const audioCache = new Map<string, SynthesizedSpeech>();

async function generateSpeech(text: string, preferred: Provider): Promise<SynthesizedSpeech | null> {
  const voice = resolveTtsVoice(preferred);
  if (!voice) return null;

  const key = audioKey(text, voice);
  const cached = audioCache.get(key);
  if (cached) return cached;

  const result = await synthesize(text, voice);
  if (result) {
    if (audioCache.size > 200) audioCache.delete(audioCache.keys().next().value!);
    audioCache.set(key, result);
  }
  return result;
}

export async function POST(request: Request) {
  try {
    // Burst protection for everyone: 20 requests/min per IP, regardless of login
    if (!(await rateLimit(`guide:${clientIp(request)}`, 20, 60_000))) {
      return NextResponse.json({ error: 'יותר מדי בקשות. נסה שוב בעוד רגע.' }, { status: 429 });
    }

    // Real per-user daily quota (ties cost to an actual account, not just an IP)
    const token = bearerToken(request);
    let quotaEnforced = false;
    if (token) {
      const quota = await checkAndIncrementGuideQuota(token, DAILY_LIMIT_PER_USER);
      if (quota.configured && !quota.allowed) {
        return NextResponse.json(
          { error: `הגעת למכסה היומית (${DAILY_LIMIT_PER_USER} קריינויות ליום). נסה שוב מחר.` },
          { status: 429 }
        );
      }
      quotaEnforced = quota.configured;
    }

    // No per-account quota was applied — either the caller isn't signed in, or
    // Supabase is unreachable (e.g. a paused free-tier project). Either way the
    // per-IP daily cap has to hold the line, otherwise an outage on their side
    // turns into unmetered TTS spend on ours.
    if (!quotaEnforced) {
      const allowed = await rateLimit(`guide:daily:${clientIp(request)}`, DAILY_LIMIT_ANON, 24 * 60 * 60 * 1000);
      if (!allowed) {
        return NextResponse.json(
          {
            error: token
              ? 'שירות המכסה אינו זמין כרגע, ולכן חלה מכסה יומית מצומצמת. נסה שוב מאוחר יותר.'
              : 'הגעת למכסה היומית להתנסות ללא התחברות. התחבר עם Google לקבלת מכסה גדולה יותר.',
          },
          { status: 429 }
        );
      }
    }

    const { lat, lon, month, type, name, provider: requestedProvider } = await request.json();
    const typeDesc = POI_TYPE_HE[type] ?? type ?? 'נקודת עניין';
    const place = name ? `${typeDesc} "${name}"` : typeDesc;
    const provider = pickTextProvider(requestedProvider);

    // No provider key configured → mocked text, no audio (dev/demo mode)
    if (!provider) {
      console.warn('No AI provider key found. Returning mocked response.');
      return NextResponse.json({
        text: `ברוכים הבאים ל${place} בנ"צ ${lat.toFixed(3)}, ${lon.toFixed(3)}. בחודש ${month} הפריחה כאן בשיאה, אפשר לראות כאן כלניות ונוריות. תהנו מהסיור!`,
        audio: null,
        audioFormat: 'mp3',
      });
    }

    const userPrompt = `המטייל נמצא עכשיו ב${place}, בנ.צ: קו רוחב ${lat}, קו אורך ${lon}. חודש נוכחי: ${month}. הקרא מדריך קצר לנקודה זו — אם יש שם למקום, התייחס אליו ולמה שמייחד אותו.`;
    const text = await generateText(provider, SYSTEM_PROMPT, userPrompt);

    // Chain to TTS; audio stays null on failure — text alone is a valid response
    const speech = await generateSpeech(text, provider);

    return NextResponse.json({
      text,
      audio: speech ? speech.buffer.toString('base64') : null,
      audioFormat: speech?.format ?? 'mp3',
    });
  } catch (error: any) {
    console.error('AI Guide Error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
