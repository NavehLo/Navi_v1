import { useRef, useState, useSyncExternalStore } from 'react';
import { History, Globe2, MapPin } from 'lucide-react';
import { useOutsideTap } from '../hooks/useOutsideTap';
import {
  agoText, listRecentTrails, recentTrailsOnServer, subscribeRecentTrails, type RecentTrail,
} from '../lib/recentTrails';

// The history button at the end of the place search on the home screen: the
// last trails looked at, one tap to see each again. Its list drops down under
// the search box (both are placed inside the box's relative wrapper).
export default function RecentTrailsButton({ onPick }: {
  onPick: (item: RecentTrail) => void;
}) {
  const items = useSyncExternalStore(subscribeRecentTrails, listRecentTrails, recentTrailsOnServer);
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useOutsideTap([btnRef, listRef], open, () => setOpen(false));
  if (items.length === 0) return null;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        data-tour="recent"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="מסלולים אחרונים"
        title="מסלולים שצפית בהם לאחרונה"
        className={`absolute left-1.5 top-1/2 -translate-y-1/2 p-1.5 rounded-xl transition-colors ${open ? 'bg-orange-500 text-white' : 'text-white hover:bg-white/10'}`}
      >
        <History size={18} />
      </button>
      {open && (
        <div
          ref={listRef}
          className="absolute top-full mt-1 right-0 left-0 bg-zinc-900/95 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl overflow-hidden"
        >
          <div className="px-3 pt-2 pb-1 text-xs font-bold text-orange-300">צפית לאחרונה</div>
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => { setOpen(false); onPick(item); }}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 text-right border-t border-white/10 hover:bg-white/10 transition-colors"
            >
              {item.type === 'world'
                ? <Globe2 className="w-4 h-4 shrink-0 text-sky-300" />
                : <MapPin className="w-4 h-4 shrink-0 text-orange-400" />}
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-bold text-white truncate"><bdi>{item.name}</bdi></span>
                <span className="block text-xs text-white/85">{agoText(item.at)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
