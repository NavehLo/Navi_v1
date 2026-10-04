import { useEffect, useState } from 'react';
import { ExternalLink, Footprints, Star } from 'lucide-react';
import Collapsible from './Collapsible';
import { countryName } from '../lib/worldTrailSearch';
import { NO_CROWD_INFO, TRAFFIC_LABELS, type CrowdSource, type CrowdSummary } from '../lib/trailCrowd/score';

// "מה אומרים מטיילים" on a world trail's card: how busy it is compared with
// its country's other trails, its rating, and where the numbers come from —
// the Komoot route that runs along it, with a link to Komoot's page. Shown
// only for trails whose country the admin has collected (api/admin/trail-crowd).

interface CrowdDetails extends CrowdSummary {
  country: string;
  pageviews: number;
  sources: CrowdSource[];
  fetchedAt: string;
}

const memo = new Map<number, CrowdDetails | null>();

export default function TrailCrowdSection({ id }: { id: number }) {
  const [data, setData] = useState<{ id: number; d: CrowdDetails | null } | null>(null);

  useEffect(() => {
    if (memo.has(id)) return;
    let live = true;
    fetch(`/api/world-trails/crowd?id=${id}`)
      .then((r) => r.json())
      .then((j) => {
        const d = j.status === 'ok' ? (j as CrowdDetails) : null;
        if (j.status === 'ok' || j.status === 'none') memo.set(id, d);
        if (live) setData({ id, d });
      })
      .catch(() => { if (live) setData({ id, d: null }); });
    return () => { live = false; };
  }, [id]);

  const d = memo.has(id) ? memo.get(id)! : data?.id === id ? data.d : null;
  if (!d) return null;

  const traffic = d.traffic !== 'unknown' ? TRAFFIC_LABELS[d.traffic] : null;
  const summary = [
    traffic,
    d.rating != null ? `★ ${d.rating.toFixed(1)}` : null,
  ].filter(Boolean).join(' · ') || NO_CROWD_INFO;
  const when = new Date(d.fetchedAt).toLocaleDateString('he-IL', { month: 'long', year: 'numeric' });

  return (
    <Collapsible
      variant="section"
      icon={<Footprints className="w-4 h-4 text-sky-300" />}
      title="מה אומרים מטיילים"
      summary={summary}
    >
      <div className="flex flex-col gap-2.5 text-sm text-white">
        <div>
          <div className="flex items-center gap-1.5 font-bold text-sky-200">
            <Footprints className="w-4 h-4" /> {traffic ?? `כמות מטיילים: ${NO_CROWD_INFO}`}
          </div>
          <div className="text-xs mt-0.5">
            {traffic
              ? `בהשוואה לשאר המסלולים ב${countryName(d.country)} שיש עליהם מידע — לפי מספר המטיילים ב-Komoot וכמה קוראים עליו בוויקיפדיה.`
              : `המסלול לא מופיע בין המסלולים המובילים של האזור ב-Komoot ואין עליו ערך בוויקיפדיה — אין מספיק מידע כדי להשוות.`}
          </div>
        </div>

        <div>
          <div className="flex items-center gap-1.5 font-bold text-yellow-300">
            <Star className="w-4 h-4 fill-yellow-300" />
            {d.rating != null ? `${d.rating.toFixed(1)} מתוך 5` : `ציון: ${NO_CROWD_INFO}`}
            {d.ratingCount > 0 && <span className="font-semibold text-white">({d.ratingCount.toLocaleString('he-IL')} דירוגים)</span>}
          </div>
          {d.rating == null && d.ratingCount > 0 && (
            <div className="text-xs mt-0.5">פחות מ-5 דירוגים — מעט מדי לממוצע.</div>
          )}
        </div>

        {d.sources.length > 0 && (
          <div className="flex flex-col gap-1">
            {d.sources.map((s) => (
              <a
                key={s.site}
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex flex-col gap-1 text-xs bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg px-2.5 py-1.5"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="font-bold" dir="ltr">{s.site}</span>
                  <span className="flex items-center gap-1.5">
                    {s.hikers ? <span>{s.hikers.toLocaleString('he-IL')} מטיילים</span> : null}
                    {s.rating != null && <span className="text-yellow-300 font-bold">★ {s.rating.toFixed(1)}</span>}
                    <span>({s.count.toLocaleString('he-IL')} דירוגים)</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </span>
                </span>
                {s.route && <span dir="ltr" className="text-right truncate">{s.route}</span>}
              </a>
            ))}
          </div>
        )}

        <div className="text-xs">
          נאסף ב{when}
          {d.pageviews > 0 && ` · ${d.pageviews.toLocaleString('he-IL')} קריאות בוויקיפדיה בשנתיים האחרונות`}
        </div>
      </div>
    </Collapsible>
  );
}
