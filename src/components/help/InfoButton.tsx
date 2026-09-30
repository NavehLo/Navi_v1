import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";
import { HELP_UI_ATTR } from "./Coachmark";

// A small ⓘ beside something that does not explain itself. Tapped, it opens a
// short explanation; a tap anywhere else closes it.
//
// Tapped, not hovered: on a phone there is no hover, which is also why the
// title="" on the buttons never reaches anybody there.
//
// The explanation is drawn on top of everything (a portal to <body>, fixed to
// the screen) because the panels it sits in scroll and would clip it.

const EDGE = 16;

export default function InfoButton({
  label, children, className = "",
}: {
  // What it explains, for the screen reader: "הסבר על …".
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // Placed once it has been drawn (hidden until then), so its real height
  // decides whether it goes below the ⓘ or above it.
  useEffect(() => {
    if (!open) return;
    const place = () => {
      if (!buttonRef.current) return;
      const b = buttonRef.current.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const width = Math.min(300, vw - EDGE * 2);
      const h = popRef.current?.offsetHeight ?? 120;
      const left = Math.min(Math.max(EDGE, b.left + b.width / 2 - width / 2), vw - EDGE - width);
      const below = b.bottom + 8;
      const top = below + h <= vh - EDGE ? below : Math.max(EDGE, b.top - 8 - h);
      setPos({ top, left, width });
    };
    const id = requestAnimationFrame(place);
    return () => cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || buttonRef.current?.contains(t)) return;
      setOpen(false);
    };
    // Scrolling the panel underneath would leave it pointing at nothing.
    const onScroll = (e: Event) => {
      if (!popRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener("pointerdown", close, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); if (open) setPos(null); }}
        aria-label={`הסבר על ${label}`}
        aria-expanded={open}
        className={`inline-flex items-center justify-center w-6 h-6 -my-1 rounded-full text-sky-300 hover:bg-white/10 active:bg-white/20 shrink-0 ${className}`}
      >
        <Info className="w-4 h-4" />
      </button>
      {open && createPortal(
        <div
          ref={popRef}
          {...{ [HELP_UI_ATTR]: "" }}
          role="tooltip"
          dir="rtl"
          onClick={(e) => e.stopPropagation()}
          className="fixed z-[90] bg-zinc-900 text-white text-sm leading-relaxed rounded-xl border border-sky-400/50 shadow-2xl px-3.5 py-3 normal-case tracking-normal font-normal text-right"
          style={pos ? { top: pos.top, left: pos.left, width: pos.width } : { visibility: "hidden", top: 0, left: 0, width: 300 }}
        >
          {children}
        </div>,
        document.body
      )}
    </>
  );
}
