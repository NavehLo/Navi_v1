import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

// A section that shows only its title until tapped. Panels with a lot in
// them (the settings, the trail's figures) open as a short list of titles,
// each with the one thing worth knowing beside it, rather than as a wall of
// text and numbers.
//
// "card" is a box of its own (the settings window); "section" is a part of a
// longer card, divided from the part above by a line (the trail card).
export default function Collapsible({
  title, icon, summary, children, defaultOpen = false, variant = "card", className = "",
}: {
  title: ReactNode;
  icon?: ReactNode;
  // Shown beside the title while closed: the gist, so opening is optional.
  summary?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  variant?: "card" | "section";
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);

  // Inside a longer card a bare title with a small arrow did not read as
  // something to tap. There the row is drawn as a button: a box of its own,
  // the gist under the title, and a "פרטים" pill that says what a tap does.
  if (variant === "section") {
    return (
      <div className={`mt-3 border-t border-white/10 pt-3 ${className}`}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="w-full flex items-center justify-between gap-3 text-right rounded-xl bg-white/10 hover:bg-white/15 active:bg-white/20 border border-white/15 px-3 py-2.5 transition-colors"
        >
          <span className="min-w-0 flex flex-col gap-1">
            <span className="flex items-center gap-2 text-white font-bold text-sm leading-tight">{icon}{title}</span>
            {summary != null && !open && (
              <span className="text-xs text-white font-bold flex items-center gap-1 flex-wrap">{summary}</span>
            )}
          </span>
          <span className="shrink-0 flex items-center gap-1 rounded-full bg-sky-600 text-white text-xs font-bold px-2.5 py-1">
            {open ? "סגור" : "פרטים"}
            <ChevronDown size={14} className={`transition-transform ${open ? "rotate-180" : ""}`} />
          </span>
        </button>
        {open && <div className="mt-3">{children}</div>}
      </div>
    );
  }

  return (
    <div className={`rounded-xl bg-white/5 border border-white/10 ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-2 text-right transition-colors p-3 hover:bg-white/5 rounded-xl"
      >
        <span className="flex items-center gap-2 min-w-0 text-white font-bold text-sm">
          {icon}
          <span className="leading-tight">{title}</span>
        </span>
        <span className="flex items-center gap-2 shrink-0">
          {summary != null && !open && <span className="text-xs text-white font-bold flex items-center gap-1">{summary}</span>}
          <ChevronDown size={16} className={`text-white shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
        </span>
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}
