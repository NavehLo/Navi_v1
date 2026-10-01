import type { WmtRouteSummary } from './waymarked';

// The browser's side of searching world trails by name and of their English
// names. Both go through /api/world-trails (see the routes there).

export interface WorldTrailHit extends WmtRouteSummary {
  name_en: string | null;
  // The name is in a non-Latin script and has no English name yet; worth
  // asking translateWorldTrails for one.
  needs_en: boolean;
}

export async function searchWorldTrails(query: string, signal?: AbortSignal): Promise<WorldTrailHit[]> {
  try {
    const res = await fetch(`/api/world-trails?q=${encodeURIComponent(query)}`, { signal });
    const body = await res.json();
    const hits: WorldTrailHit[] = body.status === 'ok' ? (body.results ?? []) : [];
    for (const h of hits) if (h.name_en) known.set(h.id, h.name_en);
    return hits;
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') throw e;
    // Half of the search box's answer; the places half still stands.
    return [];
  }
}

// Remembered for the session, answers and misses alike: the same trail turns
// up in one search after another as a name is typed out, and a name the model
// could not translate will not translate on the next keystroke either.
const known = new Map<number, string | null>();
const pending = new Map<number, Promise<void>>();

export function knownEnglish(id: number): string | null | undefined {
  return known.get(id);
}

export async function translateWorldTrails(ids: number[]): Promise<Map<number, string>> {
  const ask = [...new Set(ids)].filter((id) => !known.has(id) && !pending.has(id)).slice(0, 10);
  if (ask.length) {
    const request = (async () => {
      try {
        const res = await fetch('/api/world-trails/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: ask }),
        });
        const body = await res.json();
        if (body.status !== 'ok') return; // rate limited: leave them unasked
        for (const id of ask) known.set(id, body.names?.[id] ?? null);
      } catch {
        // Offline or the server had a bad moment — try again next time.
      } finally {
        for (const id of ask) pending.delete(id);
      }
    })();
    for (const id of ask) pending.set(id, request);
  }
  await Promise.all(ids.map((id) => pending.get(id)).filter(Boolean));
  const out = new Map<number, string>();
  for (const id of ids) {
    const en = known.get(id);
    if (en) out.set(id, en);
  }
  return out;
}
