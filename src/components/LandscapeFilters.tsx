import { Mountain, Trees, Waves } from 'lucide-react';
import Collapsible from './Collapsible';
import {
  FOREST_CHOICES, FOREST_EXPLAINED, FOREST_LABELS, NO_LANDSCAPE_FILTER, landscapeFilterCount,
  forestShort, reliefShort, waterShort,
  type LandscapeFilter, type LandscapeSummary, type ReliefChoice, type WaterChoice,
} from '../lib/landscape';

// "הרים, יער ונהרות" in the world lists: the filter, and the one line that
// says what a country or an area looks like. What the words mean is decided
// in lib/landscape.ts. Read outdoors on a phone — white text, nothing under
// text-xs (CLAUDE.md).

const chip = (on: boolean) =>
  `px-2.5 py-1 rounded-full text-xs font-bold border transition-colors ${on ? 'bg-emerald-600 text-white border-emerald-400' : 'bg-transparent text-white border-white/20 hover:bg-white/5'}`;

const RELIEF_CHOICES: Array<[ReliefChoice, string]> = [
  ['any', 'הכל'],
  ['mountains', 'הררי'],
  ['dramatic', 'דרמטי'],
  ['veryDramatic', 'דרמטי מאוד'],
];

const WATER_CHOICES: Array<[WaterChoice, string]> = [
  ['any', 'הכל'],
  ['perennial', 'זורמים כל השנה'],
  ['seasonal', 'גם עונתיים'],
];

export function LandscapeFilterPanel({ filter, onChange, what }: {
  filter: LandscapeFilter;
  onChange: (f: LandscapeFilter) => void;
  // "מדינות" or "אזורים": what the filter keeps.
  what: string;
}) {
  const set = (patch: Partial<LandscapeFilter>) => onChange({ ...filter, ...patch });
  const active = landscapeFilterCount(filter);
  return (
    <Collapsible
      className="shrink-0"
      icon={<Mountain className="w-4 h-4 text-emerald-300" />}
      title="סינון לפי נוף"
      summary={active ? <span className="text-emerald-300">{active === 1 ? 'מסנן אחד פעיל' : `${active} מסננים פעילים`}</span> : 'הכל'}
    >
      <div className="flex flex-col gap-3 text-sm text-white">
        <span className="text-xs">נשארים {what} שלפחות עשירית מהשטח שלהם כזה (ביער: רבע).</span>
        <div className="flex flex-col gap-1.5">
          <span className="font-bold flex items-center gap-1.5"><Mountain className="w-4 h-4 text-amber-300" /> הרים</span>
          <span className="text-xs">לפי כמה הקרקע יורדת סביבך, לא לפי הגובה: רמה גבוהה ושטוחה איננה דרמטית.</span>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="הרים">
            {RELIEF_CHOICES.map(([v, label]) => (
              <button key={v} role="radio" aria-checked={filter.relief === v} onClick={() => set({ relief: v })} className={chip(filter.relief === v)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="font-bold flex items-center gap-1.5"><Trees className="w-4 h-4 text-emerald-300" /> יער</span>
          <div className="flex flex-wrap gap-1.5">
            <button aria-pressed={filter.forested} onClick={() => set({ forested: !filter.forested })} className={chip(filter.forested)}>
              מיוער
            </button>
          </div>
          <span className="text-xs">סוג היער (אפשר לבחור כמה):</span>
          <div className="flex flex-wrap gap-1.5">
            {FOREST_CHOICES.map((t) => {
              const on = filter.types.includes(t);
              return (
                <button
                  key={t}
                  aria-pressed={on}
                  title={FOREST_EXPLAINED[t]}
                  onClick={() => set({ types: on ? filter.types.filter((x) => x !== t) : [...filter.types, t] })}
                  className={chip(on)}
                >
                  {FOREST_LABELS[t]}
                </button>
              );
            })}
          </div>
          <ul className="text-xs flex flex-col gap-0.5">
            {FOREST_CHOICES.map((t) => <li key={t}><b>{FOREST_LABELS[t]}:</b> {FOREST_EXPLAINED[t]}</li>)}
          </ul>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="font-bold flex items-center gap-1.5"><Waves className="w-4 h-4 text-sky-300" /> נהרות ונחלים</span>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="נהרות ונחלים">
            {WATER_CHOICES.map(([v, label]) => (
              <button key={v} role="radio" aria-checked={filter.water === v} onClick={() => set({ water: v })} className={chip(filter.water === v)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {active > 0 && (
          <button onClick={() => onChange(NO_LANDSCAPE_FILTER)} className="self-start text-xs font-bold text-emerald-300 underline">
            ניקוי הסינון
          </button>
        )}
      </div>
    </Collapsible>
  );
}

// "הרים דרמטיים · יער 45% מחטני · נחלים זורמים" — one line, three icons.
export function LandscapeLine({ s, bins }: { s: LandscapeSummary; bins: number[] }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs font-semibold text-white">
      <span className="flex items-center gap-1"><Mountain className="w-3.5 h-3.5 shrink-0 text-amber-300" />{reliefShort(s, bins)}</span>
      <span className="flex items-center gap-1"><Trees className="w-3.5 h-3.5 shrink-0 text-emerald-300" />{forestShort(s)}</span>
      <span className="flex items-center gap-1"><Waves className="w-3.5 h-3.5 shrink-0 text-sky-300" />{waterShort(s)}</span>
    </span>
  );
}
