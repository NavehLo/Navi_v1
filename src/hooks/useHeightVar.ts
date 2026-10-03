import { useCallback, useRef } from "react";

// Publishes an element's height as a CSS variable on <html>, kept current as
// it grows and shrinks, and 0px once it is gone. The panels that stack above
// it position themselves with calc(var(--name) + …), so the bottom of a phone
// screen is laid out by what is actually there rather than by guessed offsets
// that stop being true the moment one of them changes size.
export function useHeightVar(name: string) {
  const observer = useRef<ResizeObserver | null>(null);
  return useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    const root = document.documentElement;
    if (!el) {
      root.style.setProperty(name, "0px");
      return;
    }
    const publish = () => root.style.setProperty(name, `${el.offsetHeight}px`);
    publish();
    observer.current = new ResizeObserver(publish);
    observer.current.observe(el);
  }, [name]);
}
