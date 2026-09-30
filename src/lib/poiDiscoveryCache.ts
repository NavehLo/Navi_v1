import { serviceClient } from './supabaseService';

// Durable cache of a trail's discovered points.
//
// Discovery goes out to Overpass, a free public service that answers in one
// second or fails with a gateway error eight seconds later, more or less at
// random. Retrying helps; not asking at all helps more. The first successful
// discovery of a trail is written here, and every later visitor to that trail —
// on any device — gets the answer from this table without Overpass being
// involved. A flaky dependency becomes a one-time cost.
//
// The rows are global rather than per-user: the points along a trail are the
// same points whoever is walking it. Writes need the service-role key; without
// it everything here is a no-op and the app simply asks Overpass every time.

// Bumping this retires every cached list, the way PROMPT_VERSION retires
// narrations. Raise it whenever a change to the discovery filter should show
// up on trails that have already been discovered — otherwise the old list,
// selected under the old rules, keeps being served.
export const DISCOVERY_VERSION = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

// A list this old is discovered again: OSM gains new points, and a Wikipedia
// article can be written for a place that had none.
const MAX_AGE_MS = 90 * DAY_MS;

// An empty list expires far sooner. It is the answer that would be most costly
// to get wrong — a trail told, for three months, that it has nothing worth
// hearing — and it is the answer a misconfigured or regional Overpass mirror
// produces. Re-asking a genuinely empty trail every week is cheap; being
// confidently wrong about Yehiam fortress for a season is not.
const MAX_AGE_EMPTY_MS = 7 * DAY_MS;

export interface CachedDiscovery<T> {
  pois: T[];
  stale: boolean;
}

// Set once the table turns out not to exist, so deploying this code before
// running the migration costs one failed query rather than two on every
// discovery, for ever, with the log to match. The app works either way — it
// just asks Overpass every time until the table is created.
let tableMissing = false;

function noteError(where: string, e: unknown): void {
  const code = (e as { code?: string })?.code;
  const message = String((e as { message?: string })?.message ?? e);
  if (code === '42P01' || /does not exist|schema cache/i.test(message)) {
    if (!tableMissing) {
      console.error(
        `POI discovery cache disabled: table public.trail_pois is missing. ` +
          `Run the trail_pois section of supabase/schema.sql to enable it. (${message})`
      );
    }
    tableMissing = true;
    return;
  }
  console.error(`POI discovery cache ${where} failed:`, e);
}

export function isDiscoveryCacheConfigured(): boolean {
  return serviceClient() !== null && !tableMissing;
}

export async function readDiscovery<T>(trailKey: string): Promise<CachedDiscovery<T> | null> {
  const client = serviceClient();
  if (!client || tableMissing) return null;
  try {
    const { data, error } = await client
      .from('trail_pois')
      .select('pois, discovered_at')
      .eq('trail_key', trailKey)
      .eq('discovery_version', DISCOVERY_VERSION)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const pois = (data.pois ?? []) as T[];
    const age = Date.now() - new Date(data.discovered_at).getTime();
    return { pois, stale: age > (pois.length === 0 ? MAX_AGE_EMPTY_MS : MAX_AGE_MS) };
  } catch (e) {
    noteError('read', e);
    return null;
  }
}

// Only a successful discovery is written — including one that genuinely found
// nothing, which is a real answer about the trail and worth not asking twice.
// A failure is never written: caching an outage would make it permanent.
export async function writeDiscovery<T>(trailKey: string, pois: T[]): Promise<void> {
  const client = serviceClient();
  if (!client || tableMissing) return;
  try {
    const { error } = await client.from('trail_pois').upsert({
      trail_key: trailKey,
      discovery_version: DISCOVERY_VERSION,
      pois,
      discovered_at: new Date().toISOString(),
    });
    if (error) throw error;
  } catch (e) {
    // A cache that can't be written costs another Overpass call, never a
    // user-facing failure.
    noteError('write', e);
  }
}
