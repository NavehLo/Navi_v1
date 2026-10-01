// Server-side access to the Waymarked Trails API, shared by the routes under
// /api/world-trails: a User-Agent that says who is asking, and a small cache —
// the details of a national trail are several megabytes, and the same few
// searches are typed one letter at a time.

const BASE = 'https://hiking.waymarkedtrails.org/api/v1';
const USER_AGENT = 'Navi-Trail-App/1.0 (naveh@hamarag.com)';

type Cache = Map<string, { at: number; body: unknown }>;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
// Route details run to megabytes and are kept few; lists are a few hundred
// bytes, and searching would otherwise push every opened trail out.
const details: Cache = new Map();
const lists: Cache = new Map();
const DETAILS_MAX = 40;
const LISTS_MAX = 300;

export async function fetchWmt(path: string, timeoutMs = 20000): Promise<unknown | null> {
  const isDetails = path.startsWith('/details');
  const cache = isDetails ? details : lists;
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.body;
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      console.error('Waymarked Trails error:', path, res.status);
      return null;
    }
    const body = await res.json();
    if (cache.size >= (isDetails ? DETAILS_MAX : LISTS_MAX)) cache.delete(cache.keys().next().value!);
    cache.set(path, { at: Date.now(), body });
    return body;
  } catch (e) {
    console.error('Waymarked Trails request failed:', path, e);
    return null;
  }
}
