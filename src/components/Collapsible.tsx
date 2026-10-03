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
  const outer = variant === "card"
    ? "rounded-xl bg-white/5 border border-white/10"
    : "mt-3 border-t border-white/10 pt-3";
  const header = variant === "card" ? "p-3 hover:bg-white/5 rounded-xl" : "py-1";

  return (
    <div className={`${outer} ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`w-full flex items-center justify-between gap-2 text-right transition-colors ${header}`}
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
      {open && <div className={variant === "card" ? "px-3 pb-3" : "mt-2"}>{children}</div>}
    </div>
  );
}
