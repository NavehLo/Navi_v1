import { generateTextWithFallback, textProviderChain } from './narration';
import { lookupEnglish, saveEnglish } from './trailNameCache';
import { needsEnglish, parseTranslations } from './trailNames';
import { fetchWmt } from './wmtServer';
import type { WmtRouteSummary } from './waymarked';

// English names for world trails that OSM gives only in their own script.
// Server only: it spends a model call, and it writes the shared table.

const SYSTEM_PROMPT = [
  'You translate the names of hiking trails into English for a map app.',
  'If the trail is well known under an established English name (e.g. "Israel National Trail", "Kumano Kodo"), use that name.',
  'Translate generic words (trail, path, route, loop, gorge, monastery, lake, peak, village, chapel, ridge…) into English.',
  'Transliterate proper names of places and people with the standard romanization of their language (e.g. Greek ELOT, Hepburn for Japanese, BGN for Russian) — do not translate their meaning.',
  'Keep route numbers, refs and punctuation such as "2A - " or "–" as they are.',
  'Answer with a single JSON object mapping each id to its English name, and nothing else.',
].join('\n');

export const MAX_TRANSLATE = 10;

async function translate(items: Array<{ id: number; name: string }>): Promise<Record<number, string>> {
  if (items.length === 0) return {};
  const user = JSON.stringify(Object.fromEntries(items.map((i) => [i.id, i.name])));
  const { text } = await generateTextWithFallback(textProviderChain(), SYSTEM_PROMPT, user);
  return parseTranslations(text, items.map((i) => i.id));
}

// The names come from Waymarked Trails, never from the browser that asked:
// the table is shared, and a request must not be able to file any name it
// likes under a real trail's id.
export async function englishNamesFor(ids: number[]): Promise<Record<number, string>> {
  const wanted = [...new Set(ids)].filter((id) => Number.isInteger(id) && id > 0).slice(0, MAX_TRANSLATE);
  if (wanted.length === 0) return {};

  const list = (await fetchWmt(`/list/by_ids?relations=${wanted.join(',')}`, 8000)) as
    | { results?: WmtRouteSummary[] }
    | null;
  const routes = (list?.results ?? []).filter((r) => needsEnglish(r.name));
  if (routes.length === 0) return {};

  const known = await lookupEnglish(routes.map((r) => r.id));
  const out: Record<number, string> = {};
  for (const [id, en] of known) out[id] = en;

  const missing = routes.filter((r) => !known.has(r.id)).map((r) => ({ id: r.id, name: r.name! }));
  if (missing.length === 0) return out;

  try {
    const translated = await translate(missing);
    Object.assign(out, translated);
    await saveEnglish(
      missing
        .filter((m) => translated[m.id])
        .map((m) => ({ relation_id: m.id, name: m.name, name_en: translated[m.id], source: 'ai' as const }))
    );
  } catch (e) {
    // No English name is a smaller loss than no trail card.
    console.error('Trail name translation failed:', e);
  }
  return out;
}
