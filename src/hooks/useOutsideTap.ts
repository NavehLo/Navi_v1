import { useEffect, useRef, type RefObject } from "react";
import { HELP_UI_ATTR } from "../components/help/Coachmark";

// A tap anywhere outside an open panel puts it away (collapses or closes it),
// whatever the panel is. Every open card on the map works this way, so the
// way out of any of them is the same: tap the map.
//
// Listening on pointerdown rather than click means the panel is gone before
// the map starts handling the gesture — a drag of the map that starts outside
// the panel folds it and pans in one movement.
//
// A tap on an explanation opened from inside the panel (an ⓘ, a tour step)
// is still a tap on the panel, even though it is drawn outside it. So is a tap
// on the button that opens it (pass both refs), which toggles it on its own.
export function useOutsideTap(
  ref: RefObject<HTMLElement | null> | RefObject<HTMLElement | null>[],
  active: boolean,
  onOutside: () => void,
) {
  // Kept in refs so a new callback or a fresh array of refs on each render
  // does not re-attach the listener.
  const onOutsideRef = useRef(onOutside);
  const refsRef = useRef(ref);
  useEffect(() => { onOutsideRef.current = onOutside; refsRef.current = ref; });

  useEffect(() => {
    if (!active) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (target?.closest?.(`[${HELP_UI_ATTR}]`)) return;
      const refs = Array.isArray(refsRef.current) ? refsRef.current : [refsRef.current];
      if (refs.some((r) => r.current?.contains(target as Node))) return;
      onOutsideRef.current();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [active]);
}
