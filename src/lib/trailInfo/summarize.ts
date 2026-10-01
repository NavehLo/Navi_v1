// Turning the collected sources into the Hebrew description.
//
// The free Gemini tier first, OpenAI's small model if it fails — nothing
// pricier: a trail description is written once and served from the cache to
// everyone after, so even the fallback costs about half a cent a trail.

import { generateTextWithFallback, textProviderChain, type TextEngine } from '../narration';
import type { CollectedTrail } from './sources';
import type { SectionKey, TrailInfo, TrailInfoFact, TrailInfoSection } from './types';

const SECTION_TITLES: Record<SectionKey, string> = {
  where: 'איפה ומה',
  access: 'איך מגיעים',
  stages: 'קטעים ושלבים',
  lodging: 'לינה, אוכל ואספקה',
  water: 'מים בדרך',
  season: 'עונה ומזג אוויר',
  safety: 'קושי ובטיחות',
  nature: 'נוף וטבע',
  history: 'היסטוריה ותרבות',
  tips: 'טיפים מעשיים',
};

const FACT_LABELS: Record<string, string> = {
  length: 'אורך',
  duration: 'משך',
  difficulty: 'קושי',
  type: 'סוג',
  season: 'עונה מומלצת',
  marking: 'סימון',
  start: 'התחלה',
  end: 'סיום',
};

const SYSTEM_PROMPT = [
  'אתה עורך מדריכי טיולים בעברית. קיבלת מקורות על מסלול הליכה אחד, כל אחד עם מספר ודרגת אמינות. כתוב עליו מדריך תמציתי ושימושי למטייל ישראלי.',
  '',
  'כללים מחייבים:',
  '1. רק עובדות שמופיעות במקורות. אל תמציא שום שם, מספר, מרחק, מחיר, טלפון או תאריך. מספרים — בדיוק כפי שהם במקור. אסור להוסיף ידע כללי משלך, גם לא דברים שנשמעים סבירים: עונה מומלצת, רמת קושי, התאמה לילדים, אפליקציות או ציוד — רק אם נכתבו במקורות.',
  '1א. מדריך מלא ולא תקציר: העבר למטייל כל פרט מעשי ומעניין שבמקורות — שמות כפרים, מעיינות ומזרקות, גשרים, מנזרים, תצפיות, מרחקים, זמני הליכה, גבהים, אפשרויות לינה והסעה. אל תחליף פרטים במשפט כללי כמו "המסלול עובר בכפרים ונופים".',
  '2. כשמקורות סותרים זה את זה, סדר האמינות הוא: official (אתר רשמי) > nakeb > wikipedia > wikivoyage > osm > web. כתוב לפי המקור האמין יותר, ואם הסתירה חשובה (אורך, סכנה, סגירה) — ציין אותה בקצרה.',
  '3. בלי שיווק ובלי מליצות: "חוויה בלתי נשכחת", "נוף עוצר נשימה", "אחד היפים באירופה" — אסורים. רק מידע.',
  '4. עברית בלבד, בלי ניקוד. שמות מקום בחו"ל: בתעתיק עברי, ובפעם הראשונה גם המקור באותיות לטיניות בסוגריים, למשל: סטמניצה (Stemnitsa).',
  '5. כל חלק מקבל רשימת מספרי המקורות שמהם לקחת את המידע שבו.',
  '6. חלק שאין עליו מידע במקורות — אל תכלול אותו בכלל. אסור לכתוב חלק שאומר "אין מידע" או "כדאי לבדוק", ואסור להשלים פער בהנחה ("אפשר להגיע ברכב או בתחבורה ציבורית"). עדיף מדריך קצר ומדויק.',
  '6א. "מעגלי" רק כשהמקורות אומרים זאת או כשנקודת ההתחלה והסיום זהות. מסלול שמתחיל בכפר אחד ומסתיים באחר הוא קווי.',
  '7. בגוף החלקים: פסקאות קצרות; לרשימות (קטעים, אפשרויות הגעה) — שורה לכל פריט שמתחילה ב-"• ". בלי markdown אחר, בלי כותרות ובלי כוכביות.',
  '8. לקטעים ושלבים: שורה לכל קטע, למשל: "• קטע 1: סטמניצה (Stemnitsa) – דימיצנה (Dimitsana), 10.5 ק\"מ, 4 שעות. עולים בשביל הפרדות למנזר פרודרומוס…" — עם כל מה שידוע על הקטע ממקורותיו.',
  '',
  'מפתחות החלקים ותוכנם:',
  'where — איפה המסלול, באיזה אזור, ומה אופיו הכללי.',
  'access — איך מגיעים להתחלה ומהסיום: תחבורה ציבורית, מוניות, חניה, שדות תעופה.',
  'stages — חלוקה לקטעים או לימים.',
  'lodging — לינה, קמפינג, מסעדות, אספקה בכפרים.',
  'water — מקורות מים לאורך הדרך.',
  'season — מתי מומלץ ללכת ומזג האוויר.',
  'safety — רמת קושי, סכנות, היתרים, סימון השביל, גבולות, סגירות.',
  'nature — נוף, צמחייה ובעלי חיים.',
  'history — היסטוריה, ארכיאולוגיה, כפרים ותרבות.',
  'tips — טיפים מעשיים: ציוד, מפות, אפליקציות, אנשי קשר.',
  '',
  'החזר JSON בלבד, במבנה הזה:',
  '{"summary": "3–5 משפטים: מה המסלול, איפה, כמה ארוך וכמה זמן, מה מיוחד בו ולמי הוא מתאים — רק ממה שבמקורות",',
  ' "facts": {"length": "...", "duration": "...", "difficulty": "...", "type": "מעגלי / קווי / רב-יומי", "season": "...", "marking": "...", "start": "...", "end": "..."},',
  ' "sections": [{"key": "where", "body": "...", "sources": [1, 3]}]}',
  'ב-facts: ערך קצר (עד 6 מילים) או null כשאינו ידוע.',
].join('\n');

const TIER_ORDER = ['official', 'nakeb', 'wikipedia', 'wikivoyage', 'osm', 'web'];

function userPrompt(t: CollectedTrail): string {
  const head = [
    `שם המסלול: ${t.name}${t.nameEn && t.nameEn !== t.name ? ` (${t.nameEn})` : ''}`,
    ...t.facts,
  ];
  const sources = [...t.sources]
    .sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || a.id - b.id)
    .map((s) => `=== מקור ${s.id} | ${s.tier} | ${s.title}${s.url ? ` | ${s.url}` : ''} ===\n${s.text}`);
  return [...head, '', 'המקורות:', '', ...sources, '', 'כתוב עכשיו את המדריך, כ-JSON.'].join('\n');
}

const NIQQUD = /[֑-ׇֽֿׁׂׅׄ]/g;

function clean(text: unknown): string {
  return typeof text === 'string'
    ? text.replace(NIQQUD, '').replace(/\*\*/g, '').replace(/^#+\s*/gm, '').replace(/\n{3,}/g, '\n\n').trim()
    : '';
}

// Small models write "there is no information about X" despite being told
// not to. Such sentences are removed; a section left with nothing is dropped.
const NO_INFO = /אין (מידע|פרטים|נתונים)|לא (צוין|צוינו|מצוין|ידוע)|המקורות אינם|במקורות אין/;

function withoutNoInfo(body: string): string {
  return body
    .split('\n')
    .map((line) => line.split(/(?<=[.!?])\s+/).filter((sentence) => !NO_INFO.test(sentence)).join(' '))
    .filter((line) => line.replace(/^•\s*/, '').trim())
    .join('\n')
    .trim();
}

function factValue(v: unknown): string {
  const t = clean(v);
  // Nakeb lists seasons as "חורף|קיץ|סתיו|אביב".
  const parts = t.split('|').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 4 && ['חורף', 'קיץ', 'סתיו', 'אביב'].every((x) => parts.includes(x))) return 'כל השנה';
  return parts.join(', ');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- model output, validated field by field below
function parseJson(text: string): any | null {
  const body = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(body);
  } catch {
    const first = body.indexOf('{');
    const last = body.lastIndexOf('}');
    if (first < 0 || last <= first) return null;
    try { return JSON.parse(body.slice(first, last + 1)); } catch { return null; }
  }
}

function engines(): TextEngine[] {
  // Free tier, then the cheap paid model. Only if neither key exists does any
  // other configured provider get a turn.
  const cheap = textProviderChain('gemini-free').filter((e) => e === 'gemini-free' || e === 'openai');
  return cheap.length ? cheap : textProviderChain();
}

export async function summarizeTrail(t: CollectedTrail): Promise<TrailInfo | null> {
  const prompt = userPrompt(t);
  const ids = new Set(t.sources.map((s) => s.id));

  for (let attempt = 0; attempt < 2; attempt++) {
    const { text } = await generateTextWithFallback(engines(), SYSTEM_PROMPT, prompt, {
      json: true,
      maxTokens: 6000,
      timeoutMs: 35_000,
      // gpt-4o-mini, the narration's model, filled gaps with plausible
      // inventions ("reachable by car or public transport"); 4.1-mini keeps to
      // the sources at well under a cent a trail.
      openaiModel: process.env.TRAIL_INFO_OPENAI_MODEL || 'gpt-4.1-mini',
    });
    const data = parseJson(text);
    const summary = clean(data?.summary);
    if (!summary) continue;

    const facts: TrailInfoFact[] = Object.entries(FACT_LABELS).flatMap(([key, label]) => {
      const v = factValue(data?.facts?.[key]);
      return v && !/^(null|-)$/i.test(v) && !NO_INFO.test(v) ? [{ label, value: v }] : [];
    });

    const seenKeys = new Set<string>();
    const sections: TrailInfoSection[] = (Array.isArray(data?.sections) ? data.sections : []).flatMap(
      (s: { key?: string; body?: unknown; sources?: unknown }) => {
        const key = s?.key as SectionKey;
        const body = withoutNoInfo(clean(s?.body));
        if (!key || !(key in SECTION_TITLES) || body.length < 20 || seenKeys.has(key)) return [];
        seenKeys.add(key);
        const sources = Array.isArray(s.sources) ? [...new Set(s.sources.map(Number).filter((n) => ids.has(n)))] : [];
        return [{ key, title: SECTION_TITLES[key], body, sources }];
      }
    );
    // Keep the reading order fixed, whatever order the model wrote them in.
    const order = Object.keys(SECTION_TITLES);
    sections.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));

    return {
      name: t.name,
      summary,
      facts,
      sections,
      sources: t.sources.map(({ id, tier, title, url }) => ({ id, tier, title, url })),
      generatedAt: new Date().toISOString(),
    };
  }
  return null;
}
