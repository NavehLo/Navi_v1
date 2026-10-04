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
