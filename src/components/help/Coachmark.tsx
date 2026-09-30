import { useEffect, useRef, useState, type ReactNode } from "react";

// A short walk through the real buttons on the screen: each step lights up one
// of them (found by its data-tour attribute) and says what it is for, beside it.
//
// Two ways of showing it:
//  - a tour (dim): the rest of the screen is darkened and cannot be tapped
//    until the tour is finished or skipped. Used for the first visit.
//  - a tip (not dim): a bubble with a ring round the button, nothing blocked.
//    Any tap anywhere puts it away — using the thing it points at included.
//
// Everything that is read here is white and at least text-sm (see CLAUDE.md):
// this is the part of the app a newcomer reads first, often in sunlight.

export interface CoachStep {
  // data-tour value of the element to point at; none puts the bubble in the
  // middle of the screen.
  target?: string;
  title?: string;
  body: ReactNode;
}

interface Rect { top: number; left: number; width: number; height: number }

const GAP = 12;
const EDGE = 16;
const PAD = 6;

// Taps on these belong to the help itself. StatsPanel checks for it so that
// tapping "הבא" does not count as a tap outside the card and fold it away.
export const HELP_UI_ATTR = "data-help-ui";

function findTarget(name?: string): HTMLElement | null {
  if (!name) return null;
  // The same name can be on a hidden copy (e.g. a panel that renders a
  // different layout per screen size); take the one that is actually drawn.
  const all = document.querySelectorAll<HTMLElement>(`[data-tour="${name}"]`);
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return el;
  }
  return null;
}

function measure(el: HTMLElement | null): Rect | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

// Below the target if it fits, then above, then beside it, and inside it as a
// last resort (a panel that fills most of the screen).
function placeBubble(target: Rect | null, bw: number, bh: number, vw: number, vh: number) {
  const clampX = (x: number) => Math.min(Math.max(EDGE, x), vw - EDGE - bw);
  const clampY = (y: number) => Math.min(Math.max(EDGE, y), vh - EDGE - bh);
  if (!target) return { top: clampY((vh - bh) / 2), left: clampX((vw - bw) / 2) };

  const cx = target.left + target.width / 2 - bw / 2;
  const below = target.top + target.height + PAD + GAP;
  if (below + bh <= vh - EDGE) return { top: below, left: clampX(cx) };
  const above = target.top - PAD - GAP - bh;
  if (above >= EDGE) return { top: above, left: clampX(cx) };
  const leftOf = target.left - PAD - GAP - bw;
  if (leftOf >= EDGE) return { top: clampY(target.top), left: leftOf };
  const rightOf = target.left + target.width + PAD + GAP;
  if (rightOf + bw <= vw - EDGE) return { top: clampY(target.top), left: rightOf };
  return { top: clampY(target.top + EDGE), left: clampX(cx) };
}

export default function Coachmark({
  steps, onDone, dim = true,
}: {
  steps: CoachStep[];
  // Called once, whether the steps were finished or skipped.
  onDone: () => void;
  dim?: boolean;
}) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const [bubbleSize, setBubbleSize] = useState({ w: 0, h: 0 });
  const bubbleRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef(false);

  const finish = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone();
  };

  const step = steps[index];

  // The buttons move — a panel opens, the map settles, the phone turns — so the
  // light follows them for as long as the step is up. Four times a second is
  // plenty and costs nothing. A step whose button is not on the screen right
  // now is skipped rather than shown pointing at nothing.
  useEffect(() => {
    const update = () => {
      const el = findTarget(step?.target);
      if (step?.target && !el) {
        if (index < steps.length - 1) setIndex(index + 1);
        else finish();
        return;
      }
      setViewport({ w: window.innerWidth, h: window.innerHeight });
      setRect(measure(el));
      const b = bubbleRef.current;
      if (b) setBubbleSize((prev) => (prev.w === b.offsetWidth && prev.h === b.offsetHeight ? prev : { w: b.offsetWidth, h: b.offsetHeight }));
    };
    // Once now, once more when the bubble has been drawn and can be measured,
    // then on a steady beat.
    const first = requestAnimationFrame(update);
    const second = setTimeout(update, 60);
    const id = setInterval(update, 250);
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(first);
      clearTimeout(second);
      clearInterval(id);
      window.removeEventListener("resize", update);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, step]);

  // A tip goes away at the first tap anywhere else.
  useEffect(() => {
    if (dim) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!bubbleRef.current?.contains(e.target as Node)) finish();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dim]);

  if (!step || (step.target && !rect) || viewport.w === 0) return null;

  const bw = Math.min(320, viewport.w - EDGE * 2);
  const pos = placeBubble(rect, bw, bubbleSize.h || 160, viewport.w, viewport.h);
  const last = index === steps.length - 1;
  const hole = rect && {
    top: rect.top - PAD, left: rect.left - PAD,
    width: rect.width + PAD * 2, height: rect.height + PAD * 2,
  };

  return (
    <div {...{ [HELP_UI_ATTR]: "" }}>
      {dim && (
        // Catches every tap, so the tour is the only thing that can be pressed.
        <div className={`fixed inset-0 z-[80] ${hole ? "" : "bg-black/65"}`} />
      )}
      {hole && (
        <div
          className={`fixed z-[80] rounded-2xl pointer-events-none transition-all duration-200 ${dim ? "" : "ring-2 ring-orange-400"}`}
          style={{
            ...hole,
            boxShadow: dim ? "0 0 0 9999px rgba(0,0,0,0.65), 0 0 0 2px #fb923c" : undefined,
          }}
        />
      )}
      <div
        ref={bubbleRef}
        role="dialog"
        aria-live="polite"
        dir="rtl"
        className="fixed z-[81] bg-zinc-900 border border-orange-400/60 rounded-2xl shadow-2xl p-4 flex flex-col gap-2"
        // Hidden for the moment before it has been measured, so it does not
        // jump into place.
        style={{ top: pos.top, left: pos.left, width: bw, visibility: bubbleSize.h ? "visible" : "hidden" }}
      >
        {step.title && <div className="text-white font-bold text-base">{step.title}</div>}
        <div className="text-white text-sm leading-relaxed">{step.body}</div>
        <div className="flex items-center gap-2 mt-1">
          {steps.length > 1 && (
            <span className="text-white/80 text-xs tabular-nums">{index + 1} / {steps.length}</span>
          )}
          <div className="flex-1" />
          {steps.length > 1 && !last && (
            <button
              onClick={finish}
              className="text-white text-sm font-bold px-3 py-2 rounded-xl bg-white/10 hover:bg-white/20"
            >
              דלג
            </button>
          )}
          <button
            onClick={() => (last ? finish() : setIndex(index + 1))}
            className="text-white text-sm font-bold px-4 py-2 rounded-xl bg-orange-500 hover:bg-orange-400"
          >
            {steps.length === 1 ? "הבנתי" : last ? "סיום" : "הבא"}
          </button>
        </div>
      </div>
    </div>
  );
}
