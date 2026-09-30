import { useSyncExternalStore } from 'react';
import { BellRing } from 'lucide-react';
import {
  OFF_ROUTE_OPTIONS, readOffRouteThreshold, writeOffRouteThreshold, subscribeOffRouteThreshold,
  serverOffRouteThreshold, primeAlarm, soundAlarm,
} from '../lib/offRouteAlert';

// The off-route alarm distance. Shown both in the settings and in the personal
// area; it is one device setting either way.
export default function OffRouteSetting() {
  const value = useSyncExternalStore(subscribeOffRouteThreshold, readOffRouteThreshold, serverOffRouteThreshold);
  return (
    <div className="bg-white/5 border border-white/10 rounded-2xl p-3" dir="rtl">
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="text-sm font-bold text-white flex items-center gap-2">
          <BellRing size={15} className="text-red-400" /> התראה על סטייה מהמסלול
        </div>
        <button
          onClick={() => { primeAlarm(); soundAlarm({ once: true }); }}
          className="text-xs text-white hover:text-orange-300 underline underline-offset-2"
        >
          השמע דוגמה
        </button>
      </div>
      <p className="text-xs text-white leading-relaxed mb-2">
        צליל חזק ורטט כשמתרחקים מהמסלול, עד שלוחצים ״השתק״. פעם אחת בלבד — ושוב רק אחרי שחוזרים לתוואי. פועל כשהמיקום החי דולק.
      </p>
      <div className="grid grid-cols-4 gap-1.5">
        {OFF_ROUTE_OPTIONS.map((m) => (
          <button
            key={m}
            onClick={() => writeOffRouteThreshold(m)}
            aria-pressed={value === m}
            className={`text-xs font-bold py-2 rounded-xl transition-colors ${
              value === m ? (m ? 'bg-red-500 text-white' : 'bg-zinc-600 text-white') : 'bg-white/5 text-zinc-300 hover:bg-white/10'
            }`}
          >
            {m ? `${m} מ׳` : 'כבוי'}
          </button>
        ))}
      </div>
    </div>
  );
}
