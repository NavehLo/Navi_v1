import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { rateLimit, clientIp } from '../../../lib/rateLimit';
import { pickTextProvider, generateText } from '../../../lib/narration';
import type { AdviceInput } from '../../../lib/tripAdvice';

// A few sentences on what the trip day will be like, from the conclusions the
// app already reached (lib/hikeAdvice.ts). The model gets those conclusions,
// not the forecast, and is told not to touch a number — the litres and the
// warnings on the panel are decided by rules and must read the same here.
//
// Same provider choice as the tour guide: the user's pick in settings, then
// AI_PROVIDER, then whichever key is configured.

type Status = 'ok' | 'unavailable' | 'rate-limited';

const SYSTEM_PROMPT = [
  'אתה מדריך טיולים ישראלי מנוסה. קיבלת תחזית ומסקנות שכבר חושבו עבור מסלול מסוים ביום מסוים.',
  'כתוב למטיילים הסבר קצר: איך ירגיש היום בשטח, מה ללבוש וכמה מים לקחת.',
  'כללים:',
  '1. 4 עד 6 משפטים בעברית פשוטה וטבעית, בגוף שני רבים ("קחו", "צאו").',
  '2. אם יש אזהרות שמתחילות ב"סכנה" — פתח בהן, בבירור ובלי לרכך.',
  '3. אל תשנה אף מספר — טמפרטורות, ליטרים, שעות, אחוזים — ואל תמציא נתון שלא קיבלת. אל תוסיף פריטי ציוד או אזהרות שאינם ברשימות.',
  '4. תאר את מהלך היום: איך יהיה ביציאה ואיך לקראת הסיום, שמש או עננים, רוח, וההבדל בנקודה הגבוהה אם יש.',
  '5. כמות המים ורשימת הביגוד — במשפט או שניים, בדיוק כפי שקיבלת.',
  '6. אם זו נסיעה ולא הליכה — דבר על מזג האוויר בדרך ובעצירות, בלי מים ובלי ביגוד להליכה.',
  '7. אם היום רחוק יותר מ־4 ימים, הזכר בחצי משפט שהתחזית עוד יכולה להשתנות.',
  '8. בלי כותרות, בלי רשימות, בלי כוכביות ובלי אימוג׳י.',
].join('\n');

function userPrompt(a: AdviceInput): string {
  const lines = [
    `מסלול: ${a.trailName} (${a.kind === 'drive' ? 'נסיעה' : 'הליכה'}), ${a.km} ק״מ, משך משוער ${a.hours}${a.effort ? `, רמת מאמץ ${a.effort}` : ''}.`,
    `יום: ${a.day} (בעוד ${a.daysAhead} ימים). יציאה ${a.start}, סיום משוער ${a.end}, שקיעה ${a.sunset}.`,
    `שמיים: ${a.sky}. טמפרטורה בשעות ${a.kind === 'drive' ? 'הנסיעה' : 'ההליכה'}: ${a.temp}, מרגיש כמו ${a.feels}. ${a.heat}.`,
    `גשם: סיכוי עד ${a.rainChance}%, ${a.rainMm} מ״מ. משבי רוח עד ${a.gusts} קמ״ש. קרינת UV עד ${a.uv}.`,
  ];
  if (a.high) lines.push(a.high + '.');
  if (a.betterStart) lines.push(`שעת יציאה מומלצת כדי לחסוך חום: ${a.betterStart}.`);
  if (a.water) lines.push(`מים: ${a.water}.`);
  if (a.clothing.length) lines.push(`ביגוד וציוד: ${a.clothing.join(', ')}.`);
  lines.push(a.warnings.length ? `אזהרות:\n${a.warnings.join('\n')}` : 'אזהרות: אין.');
  return lines.join('\n');
}

const cache = new Map<string, string>();
const MAX_BODY = 6000;

export async function POST(request: Request) {
  try {
    if (!(await rateLimit(`trip-advice:${clientIp(request)}`, 10, 60_000))) {
      return NextResponse.json({ status: 'rate-limited' satisfies Status }, { status: 429 });
    }

    const raw = await request.text();
    if (raw.length > MAX_BODY) return NextResponse.json({ error: 'too large' }, { status: 413 });
    const { input, provider: requested } = JSON.parse(raw) as { input: AdviceInput; provider?: string };
    if (!input?.trailName || !input?.day) return NextResponse.json({ error: 'input required' }, { status: 400 });

    const provider = pickTextProvider(requested);
    if (!provider) return NextResponse.json({ status: 'unavailable' satisfies Status });

    const prompt = userPrompt(input);
    const key = crypto.createHash('sha1').update(provider + prompt).digest('hex');
    const hit = cache.get(key);
    if (hit) return NextResponse.json({ status: 'ok' satisfies Status, text: hit });

    const text = (await generateText(provider, SYSTEM_PROMPT, prompt)).trim();
    if (!text) return NextResponse.json({ status: 'unavailable' satisfies Status });

    if (cache.size > 300) cache.delete(cache.keys().next().value!);
    cache.set(key, text);
    return NextResponse.json({ status: 'ok' satisfies Status, text });
  } catch (error) {
    console.error('Trip advice error:', error);
    return NextResponse.json({ status: 'unavailable' satisfies Status });
  }
}
