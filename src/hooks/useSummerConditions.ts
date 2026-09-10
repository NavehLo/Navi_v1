import { useEffect, useState } from 'react';
import type { TrailData } from './useTrailData';
import { loadCanopyGrid } from '../lib/canopy';
import { computeShade, type ShadeResult } from '../lib/summerConditions';

export interface SummerConditions {
  shade: ShadeResult | null;
  // Distinguishes "still working it out" from "we have no answer for this
  // trail". Both render as no number, but only one of them is worth waiting on.
  shadeLoading: boolean;
  attribution: string | null;
}

// Summer conditions for the open trail. Shade needs no network once the canopy
// grid is in the browser cache, so this stays quiet and works offline.
export function useSummerConditions(trail: TrailData | null): SummerConditions {
  const [shade, setShade] = useState<ShadeResult | null>(null);
  const [shadeLoading, setShadeLoading] = useState(false);
  const [attribution, setAttribution] = useState<string | null>(null);

  useEffect(() => {
    if (!trail) {
      setShade(null);
      setShadeLoading(false);
      return;
    }

    let cancelled = false;
    setShade(null);
    setShadeLoading(true);

    loadCanopyGrid().then((grid) => {
      if (cancelled) return;
      setShadeLoading(false);
      if (!grid) return;
      setAttribution(grid.attribution);
      setShade(computeShade(trail.coords, trail.accumulatedDistances, grid));
    });

    return () => { cancelled = true; };
  }, [trail]);

  return { shade, shadeLoading, attribution };
}
