import { useEffect, useState } from 'react';
import type { WmtStage } from '../lib/waymarked';
import type { WmtParent } from './useTrailData';

// A world trail's place among long trails: its own stages, if it is a long
// trail made of them, and the long trail it is a stage of, if it is one.
//
// Asked of the server in its short form (/api/world-trails?id=…&stages=1):
// an open trail has only its points left, and a stage's card needs its long
// trail's list for "המקטע הקודם / הבא". A card that already holds a trail's
// details hands its list in here (seedWmtStages), so the stage opened from it
// finds its neighbours without asking.

export interface WmtStructure {
  stages: WmtStage[];
  parents: WmtParent[];
  // Whether the stages carry climb and descent. A list without them is enough
  // to step from one stage to the next, not to show on the trail's own card.
  climb: boolean;
}

// For the session: a trail's stages do not change while the app is open, and
// stepping along a long trail asks for the same few trails again and again.
const known = new Map<number, WmtStructure>();
const listeners = new Set<() => void>();

export function seedWmtStages(id: number, value: WmtStructure) {
  const had = known.get(id);
  if (had?.climb && !value.climb) return;
  known.set(id, value);
  listeners.forEach((l) => l());
}

function usable(value: WmtStructure | undefined, climb: boolean): WmtStructure | null {
  return value && (value.climb || !climb) ? value : null;
}

// `climb: false` when only the order of the stages is wanted: the server then
// skips the long trail's elevation, which for a GR crossing three countries is
// megabytes.
export function useWmtStages(id: number | null, { climb = true }: { climb?: boolean } = {}): WmtStructure | null {
  const [, setRev] = useState(0);

  useEffect(() => {
    const l = () => setRev((r) => r + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);

  useEffect(() => {
    if (id == null || usable(known.get(id), climb)) return;
    let live = true;
    (async () => {
      try {
        const res = await fetch(`/api/world-trails?id=${id}&stages=1${climb ? '' : '&climb=0'}`);
        const body = await res.json();
        if (body.status !== 'ok' || !live) return; // offline or rate-limited: no list, no harm
        seedWmtStages(id, { stages: body.stages ?? [], parents: body.parents ?? [], climb: !!body.climb });
      } catch {
        // The card is whole without it.
      }
    })();
    return () => { live = false; };
  }, [id, climb]);

  return id == null ? null : usable(known.get(id), climb);
}
