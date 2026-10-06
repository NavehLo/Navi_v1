// "אזורי טיול": a country's main hiking regions, each with its best-known
// trails, written once per country by a strong model that searched the web,
// and stored as a static file (public/country-guides/<CC>.json). The admin
// writes them from this Mac (scripts/writeCountryGuide.mjs); visitors only
// read.

import type { WmtRouteSummary } from '../waymarked';

// Bump when what is stored changes shape; the reader ignores other versions.
export const GUIDE_VERSION = 1;

export interface GuideSource {
  id: number;
  url: string;
  title: string;
}

export interface GuideTrail {
  name: string;          // as an Israeli reader knows it, often Latin
  nameLatin: string;
  body: string;
  sources: number[];
  // Where it starts (a village, a lake), placed on the map when found.
  start?: [number, number] | null;
  // Its other Latin names, for finding it among the marked routes again.
  aliases?: string[];
  // The marked route it is (link.ts), which the app can open, and its line,
  // simplified, as [lon, lat] runs. Absent when none was found.
  wmt?: WmtRouteSummary | null;
  line?: number[][][] | null;
}

// How the region is drawn on the map. 'units': the outlines of whole provinces
// (an island, Valle d'Aosta); 'hull': a soft outline around the places that
// define it (the Dolomites, Cinque Terre), which are no province of their own.
export interface GuideShape {
  kind: 'units' | 'hull';
  // GeoJSON MultiPolygon coordinates, [lon, lat], rounded.
  polygons: number[][][][];
  bbox: [number, number, number, number];
}

export interface GuidePlace {
  name: string;
  lon: number;
  lat: number;
}

export interface GuideRegion {
  name: string;
  nameLatin: string;
  // A short line under the name: the provinces or the part of the country.
  where: string;
  body: string;
  sources: number[];
  trails: GuideTrail[];
  shape: GuideShape | null;
  places: GuidePlace[];
}

export interface CountryGuide {
  version: number;
  country: string;
  intro: string;
  introSources: number[];
  regions: GuideRegion[];
  closing: string;
  closingSources: number[];
  sources: GuideSource[];
  model: string;
  generatedAt: string;
}

export interface GuideIndex {
  version: number;
  countries: string[];
}
