import { useEffect, useState } from 'react';
import type { WmtStage } from '../lib/waymarked';
import type { WmtParent } from './useTrailData';

// The open world trail's place among long trails: its own stages, if it is a
// long trail made of them, and the long trail it is a stage of, if it is one.
// The world trail card works these out from the details it already holds; an
// open trail has only its points left, so this asks the server for the short
// version (/api/world-trails?id=…&stages=1).

export interface WmtStructure {
  stages: WmtStage[];
  parents: WmtParent[];
}

// For the session: a trail's stages do not change while the app is open, and
// going from a stage back to its long trail and on to the next stage asks for
// the same few trails again and again.
const known = new Map<number, WmtStructure>();

export function useWmtStages(id: number | null): WmtStructure | null {
  const [fetched, setFetched] = useState<{ id: number; value: WmtStructure } | null>(null);

  useEffect(() => {
    if (id == null || known.has(id)) return;
    let live = true;
    (async () => {
      try {
        const res = await fetch(`/api/world-trails?id=${id}&stages=1`);
        const body = await res.json();
        if (body.status !== 'ok') return; // offline or rate-limited: no list, no harm
        const value: WmtStructure = { stages: body.stages ?? [], parents: body.parents ?? [] };
        known.set(id, value);
        if (live) setFetched({ id, value });
      } catch {
        // The card is whole without it.
      }
    })();
    return () => { live = false; };
  }, [id]);

  if (id == null) return null;
  return known.get(id) ?? (fetched?.id === id ? fetched.value : null);
}
