import { useEffect, useState } from 'react';
import { Footprints, Sparkles, Star } from 'lucide-react';
import Collapsible from './Collapsible';

// "הקטעים הפופולריים בשביל" on a long trail's card: the parts of it that famous
// day walks are (lib/trailCrowd/sections.ts), the most walked first — open
// from the start, since for a day out they matter more than the whole trail.
// A tap opens the part's own card.

export interface SectionItem {
  id: number;
  name: string;
  km: number;
  hikers: number;
  rating: number | null;
  count: number;
}

const memo = new Map<number, SectionItem[]>();

export default function TrailSectionsList({ parent, parentName, onPick }: {
  parent: number;
  parentName: string | null;
  onPick: (s: SectionItem) => void;
}) {
  const [items, setItems] = useState<{ parent: number; list: SectionItem[] } | null>(null);
  useEffect(() => {
    if (memo.has(parent)) return;
    let live = true;
    fetch(`/api/world-trails/sections?parent=${parent}`)
      .then((r) => r.json())
      .then((j) => {
        const list: SectionItem[] = j.status === 'ok' ? j.sections : [];
        if (j.status === 'ok') memo.set(parent, list);
        if (live) setItems({ parent, list });
      })
      .catch(() => {});
    return () => { live = false; };
  }, [parent]);

  const list = memo.get(parent) ?? (items?.parent === parent ? items.list : []);
  if (!list.length) return null;
  // "Peaks of the Balkans: Theth – Valbonë" → "Theth – Valbonë" under its trail.
  const short = (name: string) => (parentName && name.startsWith(`${parentName}: `) ? name.slice(parentName.length + 2) : name);

  return (
    <Collapsible
      variant="section"
      defaultOpen
      icon={<Sparkles className="w-4 h-4 text-amber-300" />}
      title="הקטעים הפופולריים בשביל"
      summary={`${list.length} קטעים`}
    >
      <div className="flex flex-col gap-1">
        <span className="text-xs text-white">החלקים של השביל שבהם הולכים הכי הרבה מטיילים, כטיול של יום.</span>
        {list.map((s) => (
          <button
            key={s.id}
            onClick={() => onPick(s)}
            className="text-right flex flex-col gap-0.5 rounded-xl px-2 py-2 bg-amber-300/10 hover:bg-amber-300/20 border border-amber-300/30 transition-colors"
          >
            <span className="text-sm font-bold text-white"><bdi>{short(s.name)}</bdi></span>
            <span className="flex flex-wrap items-center gap-x-3 text-xs font-bold">
              <span className="text-white">{s.km >= 10 ? Math.round(s.km) : s.km} ק״מ</span>
              <span className="flex items-center gap-1 text-sky-200">
                <Footprints className="w-3.5 h-3.5 shrink-0" />
                {s.hikers.toLocaleString('he-IL')} מטיילים
              </span>
              {s.rating != null && (
                <span className="flex items-center gap-1 text-yellow-300">
                  <Star className="w-3.5 h-3.5 shrink-0 fill-yellow-300" />
                  {s.rating.toFixed(1)}
                </span>
              )}
            </span>
          </button>
        ))}
      </div>
    </Collapsible>
  );
}
