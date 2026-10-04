import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { LandscapeData, LandscapeSummary, RangeName } from './landscape';

// The landscape summaries built by scripts/buildLandscape.mjs: every country
// and every area of src/data/regions.json.gz. Server only — read once per
// instance and kept. What the numbers mean is decided in landscape.ts.

const FILE = join(process.cwd(), 'src/data/landscape.json.gz');

interface LandscapeFile {
  version: number;
  builtAt: string;
  sources: string;
  reliefBins: number[];
  ranges: Record<string, RangeName>;
  countries: Record<string, LandscapeSummary>;
  regions: Record<string, Record<string, LandscapeSummary>>;
}

let file: LandscapeFile | null = null;
let failed = false;

function load(): LandscapeFile | null {
  if (file || failed) return file;
  try {
    file = JSON.parse(gunzipSync(readFileSync(FILE)).toString('utf8')) as LandscapeFile;
  } catch (e) {
    failed = true;
    console.error('Landscape could not be loaded:', e);
  }
  return file;
}

// The names of the ranges these summaries mention, and nothing else.
function dataFor(f: LandscapeFile, summaries: LandscapeSummary[]): LandscapeData {
  const ranges: Record<string, RangeName> = {};
  for (const s of summaries) for (const id of s.ranges) if (f.ranges[id]) ranges[id] = f.ranges[id];
  return { version: f.version, reliefBins: f.reliefBins, ranges };
}

export function landscapeOfCountries(): (LandscapeData & { countries: Record<string, LandscapeSummary> }) | null {
  const f = load();
  if (!f) return null;
  return { ...dataFor(f, Object.values(f.countries)), countries: f.countries };
}

export function landscapeOfCountry(country: string):
  (LandscapeData & { country: LandscapeSummary; regions: Record<string, LandscapeSummary> }) | null {
  const f = load();
  const c = f?.countries[country];
  if (!f || !c) return null;
  const regions = f.regions[country] ?? {};
  return { ...dataFor(f, [c, ...Object.values(regions)]), country: c, regions };
}

// ── Trails ───────────────────────────────────────────────────────────────────
// The same summaries for the trails of the world lists, by country, from
// src/data/trail-landscape.json.gz (written by scripts/collectLandscape.mjs,
// shares of each trail's length). A country not collected has none.

const TRAIL_FILE = join(process.cwd(), 'src/data/trail-landscape.json.gz');

interface TrailLandscapeFile {
  version: number;
  reliefBins: number[];
  ranges: Record<string, RangeName>;
  countries: Record<string, { builtAt: string; trails: Record<string, LandscapeSummary> }>;
}

let trailFile: TrailLandscapeFile | null = null;
let trailFailed = false;
let trailIndex: Map<number, string> | null = null; // trail id → country

function loadTrails(): TrailLandscapeFile | null {
  if (trailFile || trailFailed) return trailFile;
  try {
    trailFile = JSON.parse(gunzipSync(readFileSync(TRAIL_FILE)).toString('utf8')) as TrailLandscapeFile;
    trailIndex = new Map();
    for (const [country, c] of Object.entries(trailFile.countries)) {
      for (const id of Object.keys(c.trails)) trailIndex.set(Number(id), country);
    }
  } catch (e) {
    trailFailed = true;
    console.error('Trail landscape could not be loaded:', e);
  }
  return trailFile;
}

function trailData(f: TrailLandscapeFile, summaries: LandscapeSummary[]): LandscapeData {
  const ranges: Record<string, RangeName> = {};
  for (const s of summaries) for (const id of s.ranges) if (f.ranges[id]) ranges[id] = f.ranges[id];
  return { version: f.version, reliefBins: f.reliefBins, ranges };
}

// A country's trails, for its list — null when it was never collected.
export function trailLandscapeOfCountry(country: string):
  (LandscapeData & { trails: Record<string, LandscapeSummary> }) | null {
  const f = loadTrails();
  const c = f?.countries[country];
  if (!f || !c) return null;
  return { ...trailData(f, Object.values(c.trails)), trails: c.trails };
}

// One trail, for its card.
export function trailLandscape(id: number): (LandscapeData & { country: string; trail: LandscapeSummary }) | null {
  const f = loadTrails();
  const country = trailIndex?.get(id);
  const trail = country ? f?.countries[country]?.trails[id] : undefined;
  if (!f || !country || !trail) return null;
  return { ...trailData(f, [trail]), country, trail };
}
