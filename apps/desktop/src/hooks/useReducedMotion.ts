import { useEffect, useState } from "react";

// Track the OS-level "reduce motion" preference. CSS already throttles
// global animations via the @media query in styles.css, but APNG pixel
// animation can't be paused with CSS — components that render APNG variants
// (the AnvilMark idle/hammer states, etc.) need to branch on this hook to
// swap to a static image source.
//
// The MediaQueryList listener stays attached so the swap reacts live when
// the user toggles the preference in System Preferences without a reload.
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return reduced;
}
