import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { rateLimit, clientIp } from '../../../lib/rateLimit';
import type { AdviceInput } from '../../../lib/tripAdvice';

// A few sentences on what the trip day will be like, from the conclusions the
// app already reached (lib/hikeAdvice.ts). Off by default in the panel — the
// plain sentences from lib/tripAdvice.ts are the default — and only asked for
// when somebody switches it on.
//
// Deliberately a free model on a free key, and nothing else: this is a nicety,
// not worth paying for. GEMINI_FREE_API_KEY must come from a Google AI Studio
// project with NO billing attached — a key from a project with billing (like
// the one the tour guide uses) is charged, whatever the model. With no free
// key configured the route answers 'not-configured' and the panel stays on the
// plain sentences; it never falls back to a paid key.
//
// The model gets the conclusions, not the forecast, and is told not to touch a
// number — the litres and the warnings are decided by rules.

type Status = 'ok' | 'unavailable' | 'rate-limited' | 'not-configured';

const KEY = process.env.GEMINI_FREE_API_KEY;
// Flash-Lite: the smallest model on Google's free tier, and plenty for
// rephrasing a paragraph of facts.
const MODEL = process.env.GEMINI_ADVICE_MODEL || 'gemini-3.5-flash-lite';

const SYSTEM_PROMPT = [
  'אתה מדריך טיולים ישראלי מנוסה וזהיר. קיבלת תחזית ומסקנות שכבר חושבו עבור מסלול מסוים ביום מסוים.',
  'כתוב למטיילים הסבר קצר: איך צפוי להרגיש היום בשטח, מה כדאי ללבוש וכמה מים מומלץ לקחת.',
  'כללים:',
  '1. 4 עד 6 משפטים בעברית פשוטה וטבעית.',
  '2. ניסוח ממליץ וזהיר, לא ציווי: "ההמלצה היא לקחת לפחות…", "כדאי…", "מומלץ…". לא "קחו", "צאו", "לבשו".',
  '3. כמות המים היא טווח (למשל "3–4 ליטר") — ציין אותו בדיוק כך, בלי "לפחות".',
  '4. אם יש אזהרות שמתחילות ב"סכנה" — פתח בהן, בבירור ובלי לרכך.',
  '5. אל תשנה אף מספר — טמפרטורות, ליטרים, שעות, אחוזים — ואל תמציא נתון שלא קיבלת. אל תוסיף פריטי ציוד או אזהרות שאינם ברשימות.',
  '6. תאר את מהלך היום: איך יהיה ביציאה ואיך לקראת הסיום, שמש או עננים, רוח, וההבדל בנקודה הגבוהה אם יש.',
  '7. אם זו נסיעה ולא הליכה — דבר על מזג האוויר בדרך ובעצירות, בלי מים ובלי ביגוד להליכה.',
  '8. אם היום רחוק יותר מ־4 ימים, הזכר בחצי משפט שהתחזית עוד יכולה להשתנות.',
  '9. כשמזכירים רוח או קרינת UV — במילים פשוטות, לפי ההסבר שקיבלת, לא רק מספר.',
  '10. עברית בלבד: בלי ניקוד ובלי מילים בשפות אחרות. בלי כותרות, בלי רשימות, בלי כוכביות ובלי אימוג׳י.',
].join('\n');

function userPrompt(a: AdviceInput): string {
  const lines = [
    `מסלול: ${a.trailName} (${a.kind === 'drive' ? 'נסיעה' : 'הליכה'}), ${a.km} ק״מ, משך משוער ${a.hours}${a.effort ? `, רמת מאמץ ${a.effort}` : ''}.`,
    `יום: ${a.day} (בעוד ${a.daysAhead} ימים). יציאה ${a.start}, סיום משוער ${a.end}, שקיעה ${a.sunset}.`,
    `שמיים: ${a.sky}. טמפרטורה בשעות ${a.kind === 'drive' ? 'הנסיעה' : 'ההליכה'}: ${a.temp}, מרגיש כמו ${a.feels}. ${a.heat}.`,
    `גשם: סיכוי עד ${a.rainChance}%, ${a.rainMm} מ״מ.`,
    `רוח: משבים עד ${a.gusts} קמ״ש — ${a.windNote}`,
    `קרינת UV עד ${a.uv} — ${a.uvNote}`,
  ];
  if (a.high) lines.push(a.high + '.');
  if (a.betterStart) lines.push(`שעת יציאה מוקדמת יותר שחוסכת חום: ${a.betterStart}.`);
  if (a.water) lines.push(`מים: ${a.water}.`);
  if (a.clothing.length) lines.push(`ביגוד וציוד: ${a.clothing.join(', ')}.`);
  lines.push(a.warnings.length ? `אזהרות:\n${a.warnings.join('\n')}` : 'אזהרות: אין.');
  return lines.join('\n');
}

// The small model now and then slips a vowel mark or a word of Arabic into
// the Hebrew ("המסלוּל", "على" in the first live test). Vowel marks are simply
// removed; text with another script in it is asked for once more, and if it
// comes back the same way the panel keeps the plain sentences.
const NIQQUD = /[\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7]/g;
const FOREIGN_SCRIPT = /[\u0600-\u06FF\u0400-\u04FF]/;

function clean(text: string): string | null {
  const t = text.replace(NIQQUD, '').trim();
  return t && !FOREIGN_SCRIPT.test(t) ? t : null;
}

async function generate(user: string): Promise<string> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 600 },
      }),
      signal: AbortSignal.timeout(20000),
    },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Gemini ${res.status}`);
  const parts: Array<{ text?: string }> = data.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p.text ?? '').join('').trim();
}

const cache = new Map<string, string>();
const MAX_BODY = 6000;

export async function POST(request: Request) {
  try {
    if (!KEY) return NextResponse.json({ status: 'not-configured' satisfies Status });

    // Personal use: a handful a minute is already generous, and it keeps a
    // stuck client from eating the free tier's daily allowance.
    if (!(await rateLimit(`trip-advice:${clientIp(request)}`, 6, 60_000))) {
      return NextResponse.json({ status: 'rate-limited' satisfies Status }, { status: 429 });
    }

    const raw = await request.text();
    if (raw.length > MAX_BODY) return NextResponse.json({ error: 'too large' }, { status: 413 });
    const { input } = JSON.parse(raw) as { input: AdviceInput };
    if (!input?.trailName || !input?.day) return NextResponse.json({ error: 'input required' }, { status: 400 });

    const prompt = userPrompt(input);
    const key = crypto.createHash('sha1').update(MODEL + prompt).digest('hex');
    const hit = cache.get(key);
    if (hit) return NextResponse.json({ status: 'ok' satisfies Status, text: hit });

    const text = clean(await generate(prompt)) ?? clean(await generate(prompt));
    if (!text) return NextResponse.json({ status: 'unavailable' satisfies Status });

    if (cache.size > 300) cache.delete(cache.keys().next().value!);
    cache.set(key, text);
    return NextResponse.json({ status: 'ok' satisfies Status, text });
  } catch (error) {
    console.error('Trip advice error:', error);
    return NextResponse.json({ status: 'unavailable' satisfies Status });
  }
}
