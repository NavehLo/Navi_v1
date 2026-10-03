import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

// The areas inside a country — provinces, cantons, states, or for countries
// with very many of them the regions they belong to — built by
// scripts/buildRegions.mjs from Natural Earth. Server only. The world-trail
// lists use them as the step between a country and its trails: hundreds of
// trail names mean little until one knows which part of the country they are
// in.

const FILE = join(process.cwd(), 'src/data/regions.json.gz');

export interface RegionInfo {
  id: string;
  name: string;           // Hebrew where Natural Earth has it
  latin: string | null;   // the name as written there, when it differs
  dir: string;            // צפון, דרום-מערב, מרכז… ('' for a territory overseas)
}

interface Unit extends RegionInfo {
  c: [number, number];
  bbox: [number, number, number, number];
  polys: number[][];      // flat [lon, lat, lon, lat, …] rings
}

let data: Record<string, { grouped: boolean; units: Unit[] }> | null = null;
let failed = false;

function load() {
  if (data || failed) return data;
  try {
    data = JSON.parse(gunzipSync(readFileSync(FILE)).toString('utf8')).countries;
  } catch (e) {
    failed = true;
    console.error('Regions could not be loaded:', e);
  }
  return data;
}

// Even–odd over all of a unit's rings, so holes come out right.
function inside(u: Unit, lon: number, lat: number): boolean {
  const [w, s, e, n] = u.bbox;
  if (lon < w || lon > e || lat < s || lat > n) return false;
  let hit = false;
  for (const r of u.polys) {
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit;
    }
  }
  return hit;
}

// The areas a trail passes through, from points on it ([lon, lat]) that lie
// in this country. A point the simplified outlines miss (on a coast, at a
// border) goes to the nearest area's centre. A long trail can be in several.
export function regionsAlong(country: string, points: Array<[number, number]>): string[] {
  const units = load()?.[country]?.units;
  if (!units?.length) return [];
  const found = new Set<string>();
  for (const [lon, lat] of points) {
    let unit = units.find((u) => inside(u, lon, lat));
    if (!unit) {
      let best = Infinity;
      for (const u of units) {
        const d = (u.c[0] - lon) ** 2 * Math.cos((lat * Math.PI) / 180) ** 2 + (u.c[1] - lat) ** 2;
        if (d < best) { best = d; unit = u; }
      }
    }
    if (unit) found.add(unit.id);
  }
  return [...found];
}

export function regionInfo(country: string, ids: Iterable<string>): RegionInfo[] {
  const units = load()?.[country]?.units ?? [];
  const want = new Set(ids);
  return units.filter((u) => want.has(u.id)).map(({ id, name, latin, dir }) => ({ id, name, latin, dir }));
}
