import { useEffect, useState } from 'react';
import { Mountain, Trees, Waves } from 'lucide-react';
import Collapsible from './Collapsible';
import {
  FOREST_EXPLAINED, mainForestTypes, forestLine, forestShort, rangeName, reliefLine, reliefShort, waterShort,
  type LandscapeData, type LandscapeSummary,
} from '../lib/landscape';

// "נוף ושטח" on a world trail's card: how dramatic the mountains around it
// are, the forest along it and its type, and the rivers it passes — from the
// same summaries as the world lists (scripts/collectLandscape.mjs). Shown only
// for trails whose country was collected.

type Found = LandscapeData & { country: string; trail: LandscapeSummary };
const memo = new Map<number, Found | null>();

export default function TrailLandscapeSection({ id }: { id: number }) {
  const [data, setData] = useState<{ id: number; d: Found | null } | null>(null);

  useEffect(() => {
    if (memo.has(id)) return;
    let live = true;
    fetch(`/api/landscape?trail=${id}`)
      .then((r) => r.json())
      .then((j) => {
        const d = j.status === 'ok' ? (j as Found) : null;
        if (j.status === 'ok' || j.status === 'none') memo.set(id, d);
        if (live) setData({ id, d });
      })
      .catch(() => { if (live) setData({ id, d: null }); });
    return () => { live = false; };
  }, [id]);

  const d = memo.has(id) ? memo.get(id)! : data?.id === id ? data.d : null;
  if (!d) return null;
  const s = d.trail;
  const bins = d.reliefBins;
  const ranges = s.ranges.map((r) => rangeName(d, r)).filter(Boolean);
  const type = mainForestTypes(s)[0];
  const nearAllYear = Math.round(s.perennial / 10);
  const nearSeasonal = Math.round(s.seasonal / 10);

  return (
    <Collapsible
      variant="section"
      icon={<Mountain className="w-4 h-4 text-amber-300" />}
      title="נוף ושטח"
      summary={`${reliefShort(s, bins)} · ${forestShort(s)} · ${waterShort(s, 'trail')}`}
    >
      <div className="flex flex-col gap-2.5 text-sm text-white">
        <div>
          <div className="flex items-center gap-1.5 font-bold text-amber-200">
            <Mountain className="w-4 h-4" /> {reliefLine(s, bins, 'trail')}
          </div>
          <div className="text-xs mt-0.5">
            לפי כמה ההרים סביב הדרך מתנשאים מעל העמקים שלידם.
            {ranges.length > 0 && <> ברכס: <bdi>{ranges.join(', ')}</bdi>.</>}
          </div>
        </div>
        <div>
          <div className="flex items-center gap-1.5 font-bold text-emerald-200">
            <Trees className="w-4 h-4" /> {forestLine(s, 'trail')}
          </div>
          {type && type !== 'unknown' && <div className="text-xs mt-0.5">{FOREST_EXPLAINED[type]}</div>}
        </div>
        <div>
          <div className="flex items-center gap-1.5 font-bold text-sky-200">
            <Waves className="w-4 h-4" /> {waterShort(s, 'trail')}
          </div>
          <div className="text-xs mt-0.5">
            {nearAllYear || nearSeasonal
              ? `${nearAllYear ? `ב־${nearAllYear}% מהדרך עובר נחל שזורם כל השנה בטווח של כקילומטר` : ''}${nearAllYear && nearSeasonal ? ', וב־' : nearSeasonal ? 'ב־' : ''}${nearSeasonal ? `${nearSeasonal}% נחל עונתי` : ''}.`
              : 'אין נהר או נחל בטווח של כקילומטר מהדרך (נחלים קטנים מאוד לא נספרים).'}
          </div>
        </div>
        <div className="text-xs">לפי מפות עולמיות ברזולוציה של כקילומטר — מתאר את הסביבה של הדרך, לא כל צעד בה.</div>
      </div>
    </Collapsible>
  );
}
