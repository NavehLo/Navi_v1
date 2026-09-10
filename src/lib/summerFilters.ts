// "Show me a shaded trail" and "show me one with water", as filters.
//
// The figures behind these are estimates from maps, not measurements, so the
// filters are deliberately coarse: two steps each, no slider, no exact number
// in the UI. Offering a 37% threshold would imply a precision the data does not
// have. Two steps is also what makes the answer useful — one on/off switch
// cannot tell "there is a spring somewhere on this walk" apart from "you are
// beside water most of the day", and those are different trips.
//
// The thresholds live here rather than in the component so there is one place
// to change them, and so the build script and the UI can never disagree about
// what counts as shaded.

export interface TrailSummer {
  shadePct: number | null;
  bands?: { sun: number; partial: number; shade: number } | null;
  longestDryKm?: number;
  nearWaterPct?: number;
  waterBar?: string;
  waterPoints?: Array<{
    lat: number; lon: number; km: number; offTrailM: number;
    category: string; label: string; confident: boolean; counted: boolean; name: string | null;
  }>;
}

// Measured over the 83 bundled trails, shade is close to bimodal: desert routes
// sit at or near zero and wooded ones cluster well above a third, with little
// in between. 25% is inside that empty middle — high enough that a trail which
// qualifies really does have tree cover for a meaningful part of the walk, low
// enough to admit the partly-wooded ones people actually pick in August.
export const SHADE_SOME = 25;
export const SHADE_LOTS = 50;

// Water is far rarer than shade: most trails in the country have none in reach
// at all. So the first step is not a percentage but "is there anything here we
// can stand behind" — one confirmed pool or perennial stream. Asking for 25%
// as the entry level would leave almost nothing on the list, which is a filter
// that answers a question nobody asked.
export const WATER_LOTS_PCT = 25;

export type ShadeFilter = 'some' | 'lots';
export type WaterFilter = 'any' | 'lots';

export const SHADE_FILTER_LABELS: Record<ShadeFilter, string> = {
  some: 'קצת צל',
  lots: 'מסלול מוצל',
};

export const WATER_FILTER_LABELS: Record<WaterFilter, string> = {
  any: 'יש מים בדרך',
  lots: 'מסלול מים',
};

export function matchesShade(summer: TrailSummer | undefined, filter: ShadeFilter): boolean {
  const pct = summer?.shadePct;
  // A trail with no figure is left out rather than let through. "We do not
  // know" is not "yes", and a filter that quietly includes unknowns stops
  // meaning anything.
  if (pct == null) return false;
  return pct >= (filter === 'lots' ? SHADE_LOTS : SHADE_SOME);
}

export function matchesWater(summer: TrailSummer | undefined, filter: WaterFilter): boolean {
  if (!summer || summer.nearWaterPct == null) return false;
  if (filter === 'lots') return summer.nearWaterPct >= WATER_LOTS_PCT;
  // Springs and unverified pools do not count towards `nearWaterPct`, so any
  // reading above zero already means at least one source worth relying on.
  return summer.nearWaterPct > 0;
}
