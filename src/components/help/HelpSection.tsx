import { useState } from "react";
import { HelpCircle, PlayCircle, RotateCcw, Check, ChevronDown } from "lucide-react";
import Collapsible from "../Collapsible";
import { FEATURES } from "./features";

// "מדריכים ומידע נוסף", at the top of the settings: the one place where everything
// the app can do is explained, and nothing jumps out at anybody by itself.
// Also the way back to the tour, and to the one-off tips once they were seen.
// The explanations themselves are in features.ts, shared with the help chat.

export default function HelpSection({
  onReplay, onReset,
}: {
  // Absent when the screen has no tour to replay (an open drive).
  onReplay?: () => void;
  onReset: () => void;
}) {
  const [resetDone, setResetDone] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const row = "flex items-center gap-2.5 text-sm font-bold p-3 rounded-xl transition-colors";
  // Inside the folded section the buttons sit one shade lighter than it.

  return (
    // One line until tapped: the explanations are there for whoever looks
    // for them, not a list everybody has to scroll past to reach the rest.
    <Collapsible
      className="mb-3"
      icon={<HelpCircle size={16} className="text-sky-300 shrink-0" />}
      title="מדריכים ומידע נוסף"
    >
      <div className="flex flex-col gap-2">
        {onReplay && (
          <button onClick={onReplay} className={`${row} bg-white/10 text-white hover:bg-white/15`}>
            <PlayCircle size={16} className="text-sky-300" /> הצג שוב את ההדרכה של המסך הזה
          </button>
        )}
        <button
          onClick={() => { onReset(); setResetDone(true); }}
          disabled={resetDone}
          className={`${row} bg-white/10 text-white hover:bg-white/15 disabled:hover:bg-white/10`}
        >
          {resetDone
            ? <><Check size={16} className="text-emerald-300" /> הטיפים יופיעו שוב כשתגיעו אליהם</>
            : <><RotateCcw size={16} className="text-sky-300" /> הצג שוב את כל הטיפים</>}
        </button>

        <div className="rounded-xl bg-white/10 divide-y divide-white/10">
          {FEATURES.map((f, i) => (
            <div key={f.title}>
              <button
                onClick={() => setOpen(open === i ? null : i)}
                aria-expanded={open === i}
                className="w-full flex items-center justify-between gap-2 text-right text-sm text-white font-bold px-3 py-2.5"
              >
                {f.title}
                <ChevronDown size={16} className={`shrink-0 transition-transform ${open === i ? "rotate-180" : ""}`} />
              </button>
              {open === i && <p className="text-white text-sm leading-relaxed px-3 pb-3">{f.body}</p>}
            </div>
          ))}
        </div>
      </div>
    </Collapsible>
  );
}
