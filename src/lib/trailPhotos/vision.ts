import { geminiTokens, recordAiUsage } from '../aiUsage';
import { ensureAllowed, isAiLimitError } from '../aiLimits';
import type { Candidate, Placed, Verdict } from './select';

// The free model looks at the shortlisted pictures (select.ts → shortlist):
// is each one a view of the trail's country, how good a picture is it, and
// does it show the same view as one before it. One request per trail, then
// stored with the trail's photos.
//
// Free key only, like the weather explanation and the help chat: with no
// GEMINI_FREE_API_KEY, or its daily allowance used up, the photos are chosen
// from where and when they were taken alone (and kept for a week, to be
// looked at again).

const KEY = process.env.GEMINI_FREE_API_KEY;
const MODEL = process.env.GEMINI_PHOTOS_MODEL || 'gemini-3.5-flash-lite';

const SCENES = ['landscape', 'trail', 'viewpoint', 'water', 'ruins', 'village', 'building', 'indoors', 'people', 'document', 'vehicle', 'closeup', 'other'] as const;
// What a hiker would see along the way. A village street counts: many trails
// in Europe walk through one.
const KEEP = new Set<string>(['landscape', 'trail', 'viewpoint', 'water', 'ruins', 'village']);

const PROMPT = `You are choosing photos for a hiking trail's gallery. Each photo below is numbered.
For every photo answer:
- scene: what the photo mainly shows. "landscape" (scenery, hills, desert, forest, fields), "trail" (the path itself), "viewpoint" (a wide view from a high point), "water" (stream, spring, pool, waterfall, lake, sea), "ruins" (an archaeological site or old ruin outdoors), "village" (an outdoor street or houses of a village), "building" (mainly one modern building from outside), "indoors", "people" (mainly a person or a group, a portrait or a selfie), "document" (a map, a sign's text, a page, a screenshot), "vehicle" (mainly a car, bus or bike), "closeup" (a single plant, animal, rock or object filling the frame), "other".
- quality: 1 to 5, how good and clear a picture of the place it is (5 = sharp, well lit, a view worth showing; 1 = blurry, dark, tilted or mostly sky or ground).
- sameAs: the number of an EARLIER photo that shows the same view from about the same spot, or -1 if none.
Answer for every photo, in order.`;

class QuotaError extends Error {}

async function asInline(url: string): Promise<{ mime_type: string; data: string } | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Navi-Trail-App/1.0 (naveh@hamarag.com)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? 'image/jpeg';
    if (!type.startsWith('image/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 1_500_000) return null;
    return { mime_type: type.split(';')[0], data: buf.toString('base64') };
  } catch {
    return null;
  }
}

// The verdict for each picture the model could see, by candidate id — or null
// when the model was not asked (no key, no allowance, an error). A picture
// that could not be fetched gets no verdict, and so is not shown.
export async function lookAtPhotos(list: Placed<Candidate>[]): Promise<Map<string, Verdict> | null> {
  if (!KEY || list.length === 0) return null;
  const images = await Promise.all(list.map((p) => asInline(p.c.thumb)));
  const shown = list.map((p, i) => ({ p, img: images[i] })).filter((x) => x.img);
  if (shown.length === 0) return null;

  const parts: Array<Record<string, unknown>> = [{ text: PROMPT }];
  shown.forEach((x, i) => {
    parts.push({ text: `Photo ${i}:` });
    parts.push({ inline_data: x.img });
  });

  try {
    await ensureAllowed('gemini-free');
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 4000,
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  photo: { type: 'INTEGER' },
                  scene: { type: 'STRING', enum: [...SCENES] },
                  quality: { type: 'INTEGER' },
                  sameAs: { type: 'INTEGER' },
                },
                required: ['photo', 'scene', 'quality', 'sameAs'],
              },
            },
          },
        }),
        signal: AbortSignal.timeout(30000),
      },
    );
    const data = await res.json().catch(() => ({}));
    if (res.status === 429) throw new QuotaError(data.error?.message || 'quota');
    if (!res.ok) throw new Error(data.error?.message || `Gemini ${res.status}`);
    await recordAiUsage({ kind: 'text', provider: 'gemini-free', model: MODEL, ...geminiTokens(data) });

    const text = (data.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? '').join('');
    const answers = JSON.parse(text) as Array<{ photo: number; scene: string; quality: number; sameAs: number }>;
    const out = new Map<string, Verdict>();
    for (const a of answers) {
      const x = shown[a.photo];
      if (!x) continue;
      const earlier = a.sameAs >= 0 && a.sameAs < a.photo ? shown[a.sameAs]?.p.c.id : undefined;
      out.set(x.p.c.id, {
        keep: KEEP.has(a.scene),
        quality: Math.max(1, Math.min(5, Math.round(a.quality) || 3)),
        ...(earlier ? { sameAs: earlier } : {}),
      });
    }
    return out.size ? out : null;
  } catch (e) {
    if (!(e instanceof QuotaError) && !isAiLimitError(e)) console.error('Trail photos: the model could not look at the photos:', e);
    return null;
  }
}
