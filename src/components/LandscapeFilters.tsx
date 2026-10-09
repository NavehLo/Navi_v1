import { useState, type ReactNode } from 'react';
import { ArrowDownWideNarrow, ChevronDown, Mountain, Trees, Waves } from 'lucide-react';
import Collapsible from './Collapsible';
import {
  LANDSCAPE_SORTS, NO_LANDSCAPE_FILTER, SORT_LABELS, landscapeFilterCount,
  forestShort, reliefShort, waterShort,
  type ForestChoice, type Kind, type LandscapeFilter, type LandscapeSort, type LandscapeSummary,
  type ReliefChoice, type WaterChoice,
} from '../lib/landscape';

// "הרים, יער ונהרות" in the world lists: the filter and the order, and the
// one line that says what a country, an area or a trail looks like. What the
// words mean is decided in lib/landscape.ts. Read outdoors on a phone — white
// text, nothing under text-xs (CLAUDE.md).
//
// The panel opens as four headings — הרים, יער, נהרות ונחלים, סדר הרשימה —
// each with what is chosen beside it; a tap opens one, with a short
// explanation and its choices.

const chip = (on: boolean) =>
  `px-2.5 py-1 rounded-full text-xs font-bold border transition-colors ${on ? 'bg-emerald-600 text-white border-emerald-400' : 'bg-transparent text-white border-white/20 hover:bg-white/5'}`;

const RELIEF_CHOICES: Array<[ReliefChoice, string]> = [
  ['any', 'הכל'], ['mountains', 'הררי'], ['dramatic', 'דרמטי'], ['veryDramatic', 'דרמטי מאוד'],
];
const FOREST_CHOICES: Array<[ForestChoice, string]> = [
  ['any', 'הכל'], ['forested', 'מיוער'], ['veryForested', 'מיוער מאוד'],
];
const WATER_CHOICES: Array<[WaterChoice, string]> = [
  ['any', 'הכל'], ['perennial', 'זורמים כל השנה'], ['seasonal', 'גם עונתיים'],
];

const label = <T,>(choices: Array<[T, string]>, v: T) => choices.find(([c]) => c === v)?.[1] ?? '';

type Part = 'relief' | 'forest' | 'water' | 'sort';

function Part({ icon, title, value, on, open, onToggle, children }: {
  icon: ReactNode; title: string; value: string; on: boolean; open: boolean; onToggle: () => void; children: ReactNode;
}) {
  return (
    <div className="border-t border-white/10 first:border-t-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-2 py-2.5 text-right"
      >
        <span className="flex items-center gap-2 text-sm font-bold text-white">{icon}{title}</span>
        <span className="flex items-center gap-1.5 shrink-0">
          <span className={`text-xs font-bold ${on ? 'text-emerald-300' : 'text-white'}`}>{value}</span>
          <ChevronDown size={16} className={`text-white transition-transform ${open ? 'rotate-180' : ''}`} />
        </span>
      </button>
      {open && <div className="flex flex-col gap-2 pb-3 text-sm text-white">{children}</div>}
    </div>
  );
}

// The three filters alone, without the order, for a drop-down that has its
// own frame (the world lists, where the order is a drop-down of its own).
export function LandscapeFilterParts({ filter, onChange, kind = 'area', what }: {
  filter: LandscapeFilter;
  onChange: (f: LandscapeFilter) => void;
  kind?: Kind;
  what: string;
}) {
  return <LandscapeFilterPanel filter={filter} onChange={onChange} sort="default" onSort={() => {}} kind={kind} what={what} bare />;
}

export function LandscapeFilterPanel({ filter, onChange, sort, onSort, kind = 'area', what, bare = false }: {
  filter: LandscapeFilter;
  onChange: (f: LandscapeFilter) => void;
  sort: LandscapeSort;
  onSort: (s: LandscapeSort) => void;
  kind?: Kind;
  // "מדינות", "אזורים" or "מסלולים": what the filter keeps.
  what: string;
  bare?: boolean;
}) {
  const [open, setOpen] = useState<Part | null>(null);
  const toggle = (p: Part) => setOpen((o) => (o === p ? null : p));
  const set = (patch: Partial<LandscapeFilter>) => onChange({ ...filter, ...patch });
  const active = landscapeFilterCount(filter);
  const sorted = sort !== 'default';
  const around = kind === 'trail' ? 'מהשטח סביב הדרך' : 'מהשטח';

  const gist = [
    active ? (active === 1 ? 'מסנן אחד' : `${active} מסננים`) : null,
    sorted ? `לפי ${SORT_LABELS[sort].replace(/^הכי /, '')}` : null,
  ].filter(Boolean).join(' · ');

  const parts = (
      <div className="flex flex-col">
        <Part
          icon={<Mountain className="w-4 h-4 text-amber-300" />}
          title="הרים"
          value={label(RELIEF_CHOICES, filter.relief)}
          on={filter.relief !== 'any'}
          open={open === 'relief'}
          onToggle={() => toggle('relief')}
        >
          <p className="text-xs leading-relaxed">
            כמה גבוה ההר מעל העמק שלידו — לא כמה גבוה המקום מעל הים. רמה גבוהה ושטוחה נחשבת שטוחה.
          </p>
          <ul className="text-xs leading-relaxed flex flex-col gap-0.5">
            <li><b>הררי</b> — הרים של 700 מ׳ ויותר מעל העמק (היער השחור, הווז׳)</li>
            <li><b>דרמטי</b> — 1,000 מ׳ ויותר (הטטרה, יוסמיטי, סקוטלנד)</li>
            <li><b>דרמטי מאוד</b> — 1,500 מ׳ ויותר (צרמט, הדולומיטים)</li>
          </ul>
          <span className="text-xs">נשארים ברשימה: {what} עם לפחות עשירית {kind === 'trail' ? 'מהדרך כזו' : 'מהשטח כזה'}.</span>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="הרים">
            {RELIEF_CHOICES.map(([v, l]) => (
              <button key={v} role="radio" aria-checked={filter.relief === v} onClick={() => set({ relief: v })} className={chip(filter.relief === v)}>{l}</button>
            ))}
          </div>
        </Part>

        <Part
          icon={<Trees className="w-4 h-4 text-emerald-300" />}
          title="יער"
          value={label(FOREST_CHOICES, filter.forest)}
          on={filter.forest !== 'any'}
          open={open === 'forest'}
          onToggle={() => toggle('forest')}
        >
          <p className="text-xs leading-relaxed">
            כמה {around} מכוסה עצים, לפי מפת לוויין. <b>מיוער</b> — רבע ויותר, <b>מיוער מאוד</b> — חצי ויותר.
            סוג היער (מחטני, נשיר, מעורב) כתוב ליד כל אחד ברשימה.
          </p>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="יער">
            {FOREST_CHOICES.map(([v, l]) => (
              <button key={v} role="radio" aria-checked={filter.forest === v} onClick={() => set({ forest: v })} className={chip(filter.forest === v)}>{l}</button>
            ))}
          </div>
        </Part>

        <Part
          icon={<Waves className="w-4 h-4 text-sky-300" />}
          title="נהרות ונחלים"
          value={label(WATER_CHOICES, filter.water)}
          on={filter.water !== 'any'}
          open={open === 'water'}
          onToggle={() => toggle('water')}
        >
          <p className="text-xs leading-relaxed">
            <b>זורמים כל השנה</b> — לא מתייבשים גם בקיץ. <b>עונתיים</b> — זורמים רק בחלק מהשנה, בדרך כלל בחורף ובאביב.
            {kind === 'trail' ? ' נספר נחל שעובר בקילומטר הקרוב לדרך.' : ''} נחלים קטנים מאוד לא נספרים.
          </p>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="נהרות ונחלים">
            {WATER_CHOICES.map(([v, l]) => (
              <button key={v} role="radio" aria-checked={filter.water === v} onClick={() => set({ water: v })} className={chip(filter.water === v)}>{l}</button>
            ))}
          </div>
        </Part>

        {!bare && <Part
          icon={<ArrowDownWideNarrow className="w-4 h-4 text-sky-300" />}
          title="סדר הרשימה"
          value={SORT_LABELS[sort]}
          on={sorted}
          open={open === 'sort'}
          onToggle={() => toggle('sort')}
        >
          <p className="text-xs leading-relaxed">
            מהגבוה לנמוך, לפי כמה אחוזים {kind === 'trail' ? 'מהדרך' : 'מהשטח'} הם כאלה. <b>כל הנופים יחד</b> — ציון שבו ההרים שווים חצי, היער 30% והנחלים 20%.
          </p>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="סדר הרשימה">
            {LANDSCAPE_SORTS.map((v) => (
              <button key={v} role="radio" aria-checked={sort === v} onClick={() => onSort(v)} className={chip(sort === v)}>{SORT_LABELS[v]}</button>
            ))}
          </div>
        </Part>}

        {(active > 0 || sorted) && (
          <button
            onClick={() => { onChange(NO_LANDSCAPE_FILTER); onSort('default'); }}
            className="self-start text-xs font-bold text-emerald-300 underline mt-1"
          >
            ניקוי
          </button>
        )}
      </div>
  );
  if (bare) return parts;
  return (
    <Collapsible
      className="shrink-0"
      icon={<Mountain className="w-4 h-4 text-emerald-300" />}
      title="נוף: סינון וסדר"
      summary={gist ? <span className="text-emerald-300">{gist}</span> : 'הכל'}
    >
      {parts}
    </Collapsible>
  );
}

// "הרים דרמטיים · יער 45% מחטני · נחלים זורמים" — one line, three icons.
// A country or an area leaves the rivers out: nearly every one has flowing
// streams somewhere, so the words said nothing and cost a line on a phone.
// A trail keeps them — there they tell one walk from another.
export function LandscapeLine({ s, bins, kind = 'area' }: { s: LandscapeSummary; bins: number[]; kind?: Kind }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs font-semibold text-white">
      <span className="flex items-center gap-1"><Mountain className="w-3.5 h-3.5 shrink-0 text-amber-300" />{reliefShort(s, bins)}</span>
      <span className="flex items-center gap-1"><Trees className="w-3.5 h-3.5 shrink-0 text-emerald-300" />{forestShort(s)}</span>
      {kind === 'trail' && <span className="flex items-center gap-1"><Waves className="w-3.5 h-3.5 shrink-0 text-sky-300" />{waterShort(s, kind)}</span>}
    </span>
  );
}
