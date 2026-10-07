import { useCallback, useEffect, useRef } from "react";

// On a phone, the round "שאלו את Navi" button (components/HelpChat) stands
// beside the folded panel at the bottom of the home screen — the trail list,
// the drive planner — rather than under it in the corner. The panel is
// narrowed to leave room for it (right-[72px]), and tells the button where to
// stand: level with its middle, through --help-chat-bottom on <html>.
//
// Only while the panel is folded and drawn; opened, hidden or gone, the
// button goes back to its corner (the variable is removed, and HelpChat falls
// back to 12px).
const VAR = "--help-chat-bottom";
const BUTTON = 48;

export function useHelpChatBeside(folded: boolean) {
  const el = useRef<HTMLElement | null>(null);
  const observer = useRef<ResizeObserver | null>(null);

  const publish = useCallback(() => {
    const root = document.documentElement;
    const node = el.current;
    const phone = window.matchMedia("(max-width: 767px)").matches;
    const r = node?.getBoundingClientRect();
    if (!folded || !phone || !r || r.height === 0) {
      root.style.removeProperty(VAR);
      return;
    }
    const bottom = window.innerHeight - r.bottom + (r.height - BUTTON) / 2;
    root.style.setProperty(VAR, `${Math.round(bottom)}px`);
  }, [folded]);

  useEffect(() => {
    publish();
    window.addEventListener("resize", publish);
    return () => {
      window.removeEventListener("resize", publish);
      document.documentElement.style.removeProperty(VAR);
    };
  }, [publish]);

  // A ref callback, so it can sit beside the panel's own ref.
  return useCallback((node: HTMLElement | null) => {
    observer.current?.disconnect();
    el.current = node;
    if (node) {
      observer.current = new ResizeObserver(publish);
      observer.current.observe(node);
    }
    publish();
  }, [publish]);
}
