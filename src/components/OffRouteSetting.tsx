import { useEffect, useState, useSyncExternalStore } from 'react';
import { BellRing, Play, Square, Volume1, Volume2 } from 'lucide-react';
import {
  OFF_ROUTE_OPTIONS, ALARM_SOUNDS, type AlarmSoundId,
  readOffRouteThreshold, writeOffRouteThreshold, subscribeOffRouteThreshold, serverOffRouteThreshold,
  readAlarmSound, writeAlarmSound, serverAlarmSound,
  readAlarmVolume, writeAlarmVolume, serverAlarmVolume,
  primeAlarm, soundAlarm, stopAlarm,
} from '../lib/offRouteAlert';
import { isNativeApp } from '../lib/native';
import Collapsible from './Collapsible';

// The off-route alarm: how far, which sound, how loud. Shown both in the
// settings and in the personal area; they are one set of device settings.
// Open from the start where it is the only thing on the screen (the personal
// area's settings tab); folded in the settings window.
export default function OffRouteSetting({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const value = useSyncExternalStore(subscribeOffRouteThreshold, readOffRouteThreshold, serverOffRouteThreshold);
  const sound = useSyncExternalStore(subscribeOffRouteThreshold, readAlarmSound, serverAlarmSound);
  const volume = useSyncExternalStore(subscribeOffRouteThreshold, readAlarmVolume, serverAlarmVolume);
  // Which sample is playing, so its button can stop it again.
  const [previewing, setPreviewing] = useState<AlarmSoundId | null>(null);

  useEffect(() => {
    if (!previewing) return;
    const t = setTimeout(() => setPreviewing(null), 3500);
    return () => clearTimeout(t);
  }, [previewing]);
  // Leaving the settings stops a sample that is still playing.
  useEffect(() => () => stopAlarm(), []);

  const play = (id: AlarmSoundId, v = volume) => {
    primeAlarm();
    soundAlarm({ once: true, sound: id, volume: v });
    setPreviewing(id);
  };
  const preview = (id: AlarmSoundId) => {
    if (previewing === id) { stopAlarm(); setPreviewing(null); return; }
    play(id);
  };

  return (
    // Folded to one line, with the distance it is set to beside the title —
    // the only part most people ever need to see.
    <Collapsible
      defaultOpen={defaultOpen}
      icon={<BellRing size={15} className="text-red-400 shrink-0" />}
      title="התראה על סטייה מהמסלול"
      summary={value ? `${value} מ׳` : 'כבויה'}
    >
    <div className="text-white flex flex-col gap-3" dir="rtl">
      <div>
        <p className="text-xs leading-relaxed">
          צליל ורטט כשמתרחקים מהמסלול, עד שלוחצים ״השתק״. פעם אחת בלבד — ושוב רק אחרי שחוזרים לתוואי. פועל כשהמיקום החי דולק.
        </p>
      </div>

      <div>
        <div className="text-xs font-bold mb-1.5">מרחק</div>
        <div className="grid grid-cols-4 gap-1.5">
          {OFF_ROUTE_OPTIONS.map((m) => (
            <button
              key={m}
              onClick={() => writeOffRouteThreshold(m)}
              aria-pressed={value === m}
              className={`text-sm font-bold py-2 rounded-xl transition-colors ${
                value === m ? (m ? 'bg-red-500 text-white' : 'bg-zinc-600 text-white') : 'bg-white/5 text-white hover:bg-white/10'
              }`}
            >
              {m ? `${m} מ׳` : 'כבוי'}
            </button>
          ))}
        </div>
      </div>

      {value !== 0 && (
        <>
          <div>
            <div className="text-xs font-bold mb-1.5">צליל <span className="font-normal">— מהרגוע לחזק</span></div>
            <div className="flex flex-col gap-1">
              {ALARM_SOUNDS.map((s, i) => (
                <div
                  key={s.id}
                  className={`flex items-center gap-2 rounded-xl border px-2 py-1 transition-colors ${
                    sound === s.id ? 'bg-red-500/20 border-red-400' : 'bg-white/5 border-transparent'
                  }`}
                >
                  <button
                    onClick={() => { writeAlarmSound(s.id); play(s.id); }}
                    aria-pressed={sound === s.id}
                    className="flex-1 flex items-center gap-2 text-right text-sm py-1"
                  >
                    <span className={`w-4 h-4 rounded-full border-2 shrink-0 ${sound === s.id ? 'border-red-400 bg-red-400' : 'border-white/60'}`} />
                    <span className="font-bold">{s.name}</span>
                    {/* How insistent it is, at a glance */}
                    <span className="mr-auto flex gap-0.5" aria-hidden>
                      {Array.from({ length: ALARM_SOUNDS.length }, (_, k) => (
                        <span key={k} className={`w-1 rounded-full ${k <= i ? 'bg-white' : 'bg-white/20'}`} style={{ height: 4 + k * 1.5 }} />
                      ))}
                    </span>
                  </button>
                  <button
                    onClick={() => preview(s.id)}
                    className="p-1.5 rounded-lg hover:bg-white/15"
                    aria-label={previewing === s.id ? `עצור את ${s.name}` : `השמע ${s.name}`}
                  >
                    {previewing === s.id ? <Square className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="text-xs font-bold mb-1.5 flex justify-between">
              <span>עוצמה</span>
              <span>{Math.round(volume * 100)}%</span>
            </div>
            <div className="flex items-center gap-2" dir="ltr">
              <Volume1 className="w-4 h-4 shrink-0" />
              <input
                type="range"
                min={10}
                max={100}
                step={10}
                value={Math.round(volume * 100)}
                onChange={(e) => writeAlarmVolume(Number(e.target.value) / 100)}
                // Heard once the finger lifts, at the new level.
                onPointerUp={(e) => play(sound, Number((e.target as HTMLInputElement).value) / 100)}
                className="flex-1 accent-red-500"
                aria-label="עוצמת ההתראה"
              />
              <Volume2 className="w-4 h-4 shrink-0" />
            </div>
            <p className="text-xs leading-relaxed mt-1.5">
              {isNativeApp()
                ? 'באפליקציה הצליל מושמע כהתראת שעון מעורר: הוא נשמע גם במצב שקט, והעוצמה המלאה היא עוצמת השעון המעורר של הטלפון.'
                : 'העוצמה המלאה היא עוצמת המדיה של הטלפון. בדפדפן ההתראה נשמעת רק כשהמסך דלוק — באפליקציה לאנדרואיד גם כשהוא כבוי.'}
            </p>
          </div>
        </>
      )}
    </div>
    </Collapsible>
  );
}
