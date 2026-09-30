import { useEffect, useState } from 'react';
import type mapboxgl from 'mapbox-gl';

// A scale bar in Hebrew — metres up close, kilometres further out — that
// follows every zoom and pan. Mapbox has one built in, but it labels in
// English and sits in a corner this app already uses.
//
// Measured the way Mapbox measures its own: the ground distance across the
// middle row of the screen, so in 3D it is right for the centre of the view
// (the near edge is bigger, the horizon smaller — no single bar can be right
// for all of a tilted map).

const MAX_WIDTH_PX = 90;

function niceDistance(m: number): number {
  const pow = 10 ** Math.floor(Math.log10(m));
  const d = m / pow;
  const nice = d >= 5 ? 5 : d >= 3 ? 3 : d >= 2 ? 2 : 1;
  return nice * pow;
}

function formatDistance(m: number): string {
  return m >= 1000 ? `${m / 1000} ק״מ` : `${m} מ׳`;
}

export default function ScaleBar({ map }: { map: mapboxgl.Map }) {
  const [scale, setScale] = useState<{ widthPx: number; label: string } | null>(null);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const y = map.getContainer().clientHeight / 2;
      const metres = map.unproject([0, y]).distanceTo(map.unproject([MAX_WIDTH_PX, y]));
      if (!Number.isFinite(metres) || metres <= 0) return;
      const nice = niceDistance(metres);
      setScale({ widthPx: Math.round(MAX_WIDTH_PX * (nice / metres)), label: formatDistance(nice) });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    map.on('move', schedule);
    map.on('resize', schedule);
    return () => {
      map.off('move', schedule);
      map.off('resize', schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [map]);

  if (!scale) return null;
  return (
    <div
      className="pointer-events-none flex flex-col items-start gap-0.5 bg-zinc-900/70 rounded-lg px-1.5 py-1 backdrop-blur-sm"
      aria-label={`קנה מידה: ${scale.label}`}
    >
      <span className="text-[10px] font-bold text-white leading-none">{scale.label}</span>
      <div
        className="h-1.5 border-x-2 border-b-2 border-white rounded-b-sm transition-[width] duration-150"
        style={{ width: scale.widthPx }}
      />
    </div>
  );
}
