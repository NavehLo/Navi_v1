import { useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { useOutsideTap } from '../hooks/useOutsideTap';

// The filter row above a list: each filter is one button the size of a
// drop-down, and its choices open in a box over the list. On a phone the
// filters used to stand above the list as rows of chips (or scroll away with
// it) and left the list little room; now they take one fixed row.
//
// The box is placed against the nearest positioned ancestor — give the row
// `relative`, and every filter in it opens across the row's full width.
// A tap outside closes it (useOutsideTap), as with every panel on the map.

const SELECT_BASE = 'w-full min-w-0 bg-zinc-900 text-sm font-bold border rounded-lg px-2 py-1.5 focus:outline-none focus:border-orange-500/60';
export const SELECT_CLASS = `${SELECT_BASE} text-white border-white/20`;
// A filter that narrows the list stands out from one left at "all".
export const SELECT_ACTIVE_CLASS = `${SELECT_BASE} text-sky-200 border-sky-400`;

export default function FilterDropdown({ label, short, value, active, children }: {
  // The box's heading, and the button's when nothing is chosen.
  label: string;
  // The button's instead, where the full name does not fit a third of a phone.
  short?: string;
  // What is chosen, in a few words; null when nothing is.
  value?: string | null;
  active: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useOutsideTap([button, box], open, () => setOpen(false));

  return (
    <>
      <button
        ref={button}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={`${active ? SELECT_ACTIVE_CLASS : SELECT_CLASS} flex items-center justify-between gap-1 text-right`}
      >
        <span className="truncate min-w-0">{active && value ? value : short ?? label}</span>
        <ChevronDown size={16} className={`shrink-0 text-white transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div
          ref={box}
          className="absolute top-full mt-1 inset-x-0 z-30 max-h-[50dvh] overflow-y-auto custom-scrollbar rounded-xl bg-zinc-900 border border-white/20 shadow-2xl p-3 flex flex-col gap-2 text-sm text-white"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-extrabold">{label}</span>
            <button type="button" onClick={() => setOpen(false)} className="text-xs font-bold text-white bg-white/10 hover:bg-white/20 rounded-full px-3 py-1">
              סגור
            </button>
          </div>
          {children}
        </div>
      )}
    </>
  );
}

// A row of choices that can each be turned on and off, drawn as checkboxes.
export function CheckRow({ on, onToggle, children }: { on: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <label className="flex items-center gap-2.5 py-1 text-sm font-bold text-white cursor-pointer">
      <input type="checkbox" checked={on} onChange={onToggle} className="w-4 h-4 accent-sky-500 shrink-0" />
      {children}
    </label>
  );
}
