import { GUIDE_VERSION, type CountryGuide, type GuideIndex, type GuideRegion } from './types';

// The browser's side of "אזורי טיול": which countries have a guide, and one
// country's guide. Both are static files (public/country-guides), the same
// for everybody; fetched once a session.

let index: Promise<Set<string>> | null = null;
const guides = new Map<string, Promise<CountryGuide | null>>();

export function guideCountries(): Promise<Set<string>> {
  index ??= fetch(`/country-guides/index.json?v=${GUIDE_VERSION}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((d: GuideIndex | null) => new Set(d?.version === GUIDE_VERSION ? d.countries : []))
    .catch(() => {
      index = null; // offline now is not offline forever
      return new Set<string>();
    });
  return index;
}

export function loadGuide(country: string): Promise<CountryGuide | null> {
  let p = guides.get(country);
  if (!p) {
    p = fetch(`/country-guides/${country}.json?v=${GUIDE_VERSION}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((g: CountryGuide | null) => (g?.version === GUIDE_VERSION ? g : null))
      .catch(() => {
        guides.delete(country);
        return null;
      });
    guides.set(country, p);
  }
  return p;
}

// Where a region is: its outline, or failing that the places in it.
export function regionBounds(r: GuideRegion): [number, number, number, number] | null {
  if (r.shape) return r.shape.bbox;
  const pts = [...r.places.map((p) => [p.lon, p.lat]), ...r.trails.flatMap((t) => (t.start ? [t.start] : []))];
  if (!pts.length) return null;
  const lons = pts.map((p) => p[0]);
  const lats = pts.map((p) => p[1]);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}

export function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}
