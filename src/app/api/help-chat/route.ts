import { NextResponse, after } from 'next/server';
import { rateLimit, clientIp } from '../../../lib/rateLimit';
import { geminiTokens, recordAiUsage, withAiUsage } from '../../../lib/aiUsage';
import { ensureAllowed, isAiLimitError } from '../../../lib/aiLimits';
import { serviceClient } from '../../../lib/supabaseService';
import { availableActions, type HelpActionId, type HelpScreen } from '../../../lib/helpChat/actions';
import { placesOnScreen, systemPrompt } from '../../../lib/helpChat/knowledge';
import type { HelpPlaceId } from '../../../lib/helpChat/places';

// "שאלו את Navi": short answers to questions about using the app, from the
// help text only (lib/helpChat/knowledge.ts), with up to two buttons that
// open the place the answer talks about.
//
// Free model on the free key, and nothing else — the same rule as the trip
// advice (see trip-advice/route.ts): with no GEMINI_FREE_API_KEY the chat says
// it is unavailable; it never falls back to a paid key. The free tier has a
// daily allowance for the whole key, so each device gets a share of it.
//
// Every question is kept, without who asked, for the admin's list of what
// users do not find (help_chat_log, settings → מתקדם).

type Status = 'ok' | 'unavailable' | 'rate-limited' | 'busy' | 'not-configured';

const KEY = process.env.GEMINI_FREE_API_KEY;
const MODEL = process.env.GEMINI_HELP_MODEL || 'gemini-3.5-flash-lite';

const PER_MINUTE = 6;
const PER_DEVICE_DAY = 30;
// Looser than a device, so a family on one network is not stopped, but a
// cleared browser storage does not buy a fresh day.
const PER_IP_DAY = 80;
const DAY = 24 * 60 * 60 * 1000;

const MAX_BODY = 8000;
const MAX_TURNS = 6;
const MAX_CHARS = 500;

interface Turn { role: 'user' | 'model'; text: string }

// Same slips as in the trip advice: a stray vowel mark is dropped, another
// script means the answer is not used.
const NIQQUD = /[֑-ׇֽֿׁׂׅׄ]/g;
const FOREIGN_SCRIPT = /[؀-ۿЀ-ӿ]/;

class QuotaError extends Error {}

async function generate(system: string, turns: Turn[], actions: HelpActionId[], places: HelpPlaceId[]) {
  await ensureAllowed('gemini-free');
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
        generationConfig: {
          temperature: 0.2,
          // Room for the model's own thinking too: a cut-off answer is not JSON.
          maxOutputTokens: 1000,
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: {
              answer: { type: 'STRING' },
              // An empty enum is not allowed; with no button to offer, none is asked for.
              ...(actions.length ? { actions: { type: 'ARRAY', items: { type: 'STRING', enum: actions } } } : {}),
              // Optional, and no '' in the list: Gemini answers 400 to an empty
              // enum value ("enum[0]: cannot be empty"), which failed every question.
              ...(places.length ? { pointTo: { type: 'STRING', enum: places } } : {}),
            },
            required: ['answer'],
          },
        },
      }),
      signal: AbortSignal.timeout(20000),
    },
  );
  const data = await res.json().catch(() => ({}));
  if (res.status === 429) throw new QuotaError(data.error?.message || 'quota');
  if (!res.ok) throw new Error(data.error?.message || `Gemini ${res.status}`);
  await recordAiUsage({ kind: 'text', provider: 'gemini-free', model: MODEL, ...geminiTokens(data) });
  const parts: Array<{ text?: string }> = data.candidates?.[0]?.content?.parts ?? [];
  let parsed: { answer?: string; actions?: string[]; pointTo?: string };
  // Not JSON (cut off, or prose): asked once more by the caller.
  try { parsed = JSON.parse(parts.map((p) => p.text ?? '').join('')); } catch { return null; }
  const answer = (parsed.answer ?? '').replace(NIQQUD, '').trim();
  if (!answer || FOREIGN_SCRIPT.test(answer)) return null;
  const picked = (parsed.actions ?? []).filter((a): a is HelpActionId => (actions as string[]).includes(a));
  const pointTo = (places as string[]).includes(parsed.pointTo ?? '') ? (parsed.pointTo as HelpPlaceId) : null;
  return { answer, actions: [...new Set(picked)].slice(0, 2), pointTo };
}

function readScreen(s: Partial<HelpScreen> | undefined): HelpScreen {
  return {
    hasTrail: !!s?.hasTrail,
    driveTrail: !!s?.driveTrail,
    mode: s?.mode === 'drive' ? 'drive' : 'trails',
    recording: !!s?.recording,
    nativeApp: !!s?.nativeApp,
    inIsrael: !!s?.inIsrael,
    labelsOn: s?.labelsOn !== false,
  };
}

function readTurns(raw: unknown): Turn[] | null {
  if (!Array.isArray(raw)) return null;
  const turns = raw.slice(-MAX_TURNS).flatMap((t): Turn[] => {
    const text = typeof t?.text === 'string' ? t.text.trim().slice(0, MAX_CHARS) : '';
    const role = t?.role === 'model' ? 'model' : t?.role === 'user' ? 'user' : null;
    return text && role ? [{ role, text }] : [];
  });
  // The conversation the model sees starts and ends with the user.
  while (turns.length && turns[0].role !== 'user') turns.shift();
  return turns.length && turns[turns.length - 1].role === 'user' ? turns : null;
}

function log(row: { question: string; answer: string | null; actions: string[]; screen: HelpScreen; status: Status }) {
  after(async () => {
    const db = serviceClient();
    if (!db) return;
    const { error } = await db.from('help_chat_log').insert(row);
    if (error) console.warn('help_chat_log insert failed:', error.message);
  });
}

async function handlePost(request: Request) {
  if (!KEY) return NextResponse.json({ status: 'not-configured' satisfies Status });

  const raw = await request.text();
  if (raw.length > MAX_BODY) return NextResponse.json({ error: 'too large' }, { status: 413 });
  let body: { messages?: unknown; screen?: Partial<HelpScreen>; deviceId?: unknown };
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: 'bad json' }, { status: 400 }); }
  const turns = readTurns(body.messages);
  if (!turns) return NextResponse.json({ error: 'question required' }, { status: 400 });
  const screen = readScreen(body.screen);
  const deviceId = typeof body.deviceId === 'string' && /^[a-z0-9-]{8,64}$/i.test(body.deviceId) ? body.deviceId : null;
  const question = turns[turns.length - 1].text;

  const ip = clientIp(request);
  const allowed = (await rateLimit(`help-chat:${ip}`, PER_MINUTE, 60_000))
    && (await rateLimit(`help-chat:day:ip:${ip}`, PER_IP_DAY, DAY))
    && (!deviceId || (await rateLimit(`help-chat:day:dev:${deviceId}`, PER_DEVICE_DAY, DAY)));
  if (!allowed) return NextResponse.json({ status: 'rate-limited' satisfies Status }, { status: 429 });

  const actions = availableActions(screen);
  const places = placesOnScreen(screen);
  const system = systemPrompt(screen, actions);
  try {
    const reply = (await generate(system, turns, actions, places)) ?? (await generate(system, turns, actions, places));
    if (!reply) {
      log({ question, answer: null, actions: [], screen, status: 'unavailable' });
      return NextResponse.json({ status: 'unavailable' satisfies Status });
    }
    log({ question, answer: reply.answer, actions: reply.actions, screen, status: 'ok' });
    return NextResponse.json({ status: 'ok' satisfies Status, ...reply });
  } catch (error) {
    const status: Status = error instanceof QuotaError || isAiLimitError(error) ? 'busy' : 'unavailable';
    console.error('Help chat error:', error);
    // The reason goes into the admin's list: the server logs are not always at hand.
    const reason = error instanceof Error ? error.message.trim().slice(0, 300) : String(error);
    log({ question, answer: `[שגיאה] ${reason}`, actions: [], screen, status });
    return NextResponse.json({ status });
  }
}

// Every AI call made while answering is logged under this area and the caller
// (see lib/aiUsage).
export function POST(request: Request) {
  return withAiUsage(request, 'help_chat', () => handlePost(request));
}
