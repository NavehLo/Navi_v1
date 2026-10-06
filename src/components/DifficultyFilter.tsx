import type { ReactNode } from 'react';
import { Gauge } from 'lucide-react';
import Collapsible from './Collapsible';
import {
  DIFFICULTY_LABELS, DIFFICULTY_ORDER, DIFFICULTY_SOURCE_LABELS, DIFFICULTY_TEXT, NO_DIFFICULTY_FILTER,
  type Difficulty, type DifficultyFilter, type DifficultySource,
} from '../lib/difficulty';

// "רמת קושי" in the trail lists: the filter, and the badge on each row. What
// a level means is decided in lib/difficulty.ts. Read outdoors on a phone —
// white text, nothing under text-xs (CLAUDE.md).

export function DifficultyBadge({ d }: { d: Difficulty | null | undefined }) {
  if (!d) return null;
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-bold ${DIFFICULTY_TEXT[d]}`}>
      <Gauge className="w-3.5 h-3.5 shrink-0" />
      {DIFFICULTY_LABELS[d]}
    </span>
  );
}

const chip = (on: boolean) =>
  `px-2.5 py-1 rounded-full text-xs font-bold border transition-colors ${on ? 'bg-sky-600 text-white border-sky-400' : 'bg-transparent text-white border-white/20 hover:bg-white/5'}`;

// The chips alone, for a panel that has its own frame (the Israeli list).
export function DifficultyChips({ filter, onChange }: {
  filter: DifficultyFilter;
  onChange: (f: DifficultyFilter) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="רמת קושי">
      {DIFFICULTY_ORDER.map((d) => {
        const on = filter.levels.includes(d);
        return (
          <button
            key={d}
            aria-pressed={on}
            onClick={() => onChange({ ...filter, levels: on ? filter.levels.filter((x) => x !== d) : [...filter.levels, d] })}
            className={chip(on)}
          >
            {DIFFICULTY_LABELS[d]}
          </button>
        );
      })}
    </div>
  );
}

// What is chosen, in a few words: "קל · בינוני", or "הכל".
export function difficultyGist(f: DifficultyFilter): string {
  return f.levels.length ? DIFFICULTY_ORDER.filter((d) => f.levels.includes(d)).map((d) => DIFFICULTY_LABELS[d]).join(' · ') : 'הכל';
}

// The whole filter as a section of its own, for the world lists, where many
// trails have no level and the reader decides whether to keep them.
export function DifficultyFilterPanel({ filter, onChange, explanation, unknown }: {
  filter: DifficultyFilter;
  onChange: (f: DifficultyFilter) => void;
  explanation: ReactNode;
  // How many of the trails in view have no level; the checkbox shows only
  // when some do.
  unknown: number;
}) {
  const active = filter.levels.length > 0;
  return (
    <Collapsible
      className="shrink-0"
      icon={<Gauge className="w-4 h-4 text-yellow-300" />}
      title="רמת קושי"
      summary={<span className={active ? 'text-sky-300' : undefined}>{difficultyGist(filter)}</span>}
    >
      <div className="flex flex-col gap-2 text-sm text-white">
        <span className="text-xs">{explanation} אפשר לבחור כמה.</span>
        <DifficultyChips filter={filter} onChange={onChange} />
        {unknown > 0 && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={filter.keepUnknown}
              onChange={(e) => onChange({ ...filter, keepUnknown: e.target.checked })}
              className="w-4 h-4 accent-sky-500"
            />
            להשאיר מסלולים בלי רמת קושי ({unknown.toLocaleString('he-IL')})
          </label>
        )}
        {active && (
          <button onClick={() => onChange(NO_DIFFICULTY_FILTER)} className="self-start text-xs font-bold text-sky-300 underline">
            ניקוי הסינון
          </button>
        )}
      </div>
    </Collapsible>
  );
}

// The card's line: "רמת קושי בינוני", and where it comes from when asked.
export function DifficultyLine({ d, withSource = false }: {
  d: { level: Difficulty; source: DifficultySource } | null;
  withSource?: boolean;
}) {
  if (!d) return null;
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      <Gauge className="w-4 h-4 text-yellow-300 shrink-0" />
      רמת קושי <b className={DIFFICULTY_TEXT[d.level]}>{DIFFICULTY_LABELS[d.level]}</b>
      {withSource && <span className="text-xs text-white">({DIFFICULTY_SOURCE_LABELS[d.source]})</span>}
    </span>
  );
}
