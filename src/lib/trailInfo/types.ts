// Shared between the /api/trail-info route and the panel that shows its
// answer, so nothing here may touch the server environment.

// Which trail to describe. World trails are OSM relations (Waymarked Trails);
// the Israeli trails are GPX files taken from Nakeb, whose file names end in
// the trail's Nakeb id ("…_7.gpx" is nakeb.co.il/hike/7).
export type TrailInfoRequest =
  | { kind: 'wmt'; id: number; name?: string }
  | { kind: 'nakeb'; id: number; name: string; lat?: number; lon?: number };

// How much a source is trusted, best first. When two sources disagree the
// higher tier wins, and the panel labels every source with its tier so the
// reader can judge the same way.
export type SourceTier = 'official' | 'nakeb' | 'wikipedia' | 'wikivoyage' | 'osm' | 'web';

export const TIER_LABEL: Record<SourceTier, string> = {
  official: 'אתר רשמי',
  nakeb: 'נאקב',
  wikipedia: 'ויקיפדיה',
  wikivoyage: 'ויקימסע',
  osm: 'נתוני מפה',
  web: 'חיפוש ברשת',
};

export interface TrailInfoSource {
  id: number;
  tier: SourceTier;
  title: string;
  url?: string;
}

export type SectionKey = 'where' | 'access' | 'stages' | 'lodging' | 'water' | 'season' | 'safety' | 'nature' | 'history' | 'tips';

export interface TrailInfoSection {
  key: SectionKey;
  title: string;
  body: string;
  // Ids into `sources`: where the section's facts were taken from.
  sources: number[];
}

export interface TrailInfoFact {
  label: string;
  value: string;
}

export interface TrailInfo {
  name: string;
  summary: string;
  facts: TrailInfoFact[];
  sections: TrailInfoSection[];
  sources: TrailInfoSource[];
  generatedAt: string;
}

export type TrailInfoStatus = 'ok' | 'no-sources' | 'unavailable' | 'rate-limited';

export function trailInfoKey(req: TrailInfoRequest): string {
  return `${req.kind}:${req.id}`;
}

// "/trails/circular/נחל סער_7.gpx" (possibly percent-encoded) → 7.
export function nakebIdFromUrl(url: string | null | undefined): number | null {
  if (!url) return null;
  let path = url;
  try { path = decodeURIComponent(url); } catch { /* keep as is */ }
  const m = /\/trails\/[^?#]*_(\d+)\.gpx(?:[?#]|$)/i.exec(path);
  return m ? Number(m[1]) : null;
}
