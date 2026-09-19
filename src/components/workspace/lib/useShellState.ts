"use client";

import { useEffect, useRef, useState } from "react";

// Three-column shell chrome state. Widths + collapsed flags persist
// to localStorage. Keyboard shortcuts and the auto-expand-right
// behavior on agent file-write also live here so the monolith can
// stay under spec's 200-LOC ceiling.
//
// Takes touchedPaths + switchSection from useWorkspaceData so the
// shell can react to agent writes (auto-expand right pane) and
// keyboard section switches (Cmd+1..4).

const RAIL_DEFAULT_WIDTH = 220;
const RIGHT_DEFAULT_WIDTH = 300;
const RAIL_STORAGE = "anvil-workspace-rail-width";
const RIGHT_STORAGE = "anvil-workspace-right-width";
const RAIL_COLLAPSED_STORAGE = "anvil-workspace-rail-collapsed";
const RIGHT_COLLAPSED_STORAGE = "anvil-workspace-right-collapsed";

function readStoredNumber(key: string, fallback: number, min: number, max: number) {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, value));
  } catch {
    return fallback;
  }
}

function readStoredFlag(key: string) {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export type ShellState = {
  railWidth: number;
  rightWidth: number;
  railCollapsed: boolean;
  rightCollapsed: boolean;
  setRailWidth: React.Dispatch<React.SetStateAction<number>>;
  setRightWidth: React.Dispatch<React.SetStateAction<number>>;
  setRailCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  setRightCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
};

export function useShellState(
  touchedPaths: ReadonlySet<string>,
  switchSection: (section: string) => void,
): ShellState {
  const [railWidth, setRailWidth] = useState(RAIL_DEFAULT_WIDTH);
  const [rightWidth, setRightWidth] = useState(RIGHT_DEFAULT_WIDTH);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const rightCollapsedRef = useRef(rightCollapsed);

  useEffect(() => {
    rightCollapsedRef.current = rightCollapsed;
  }, [rightCollapsed]);

  // Hydrate from localStorage on mount + listen for <1024px auto-collapse.
  useEffect(() => {
    const hydrationFrame = window.requestAnimationFrame(() => {
      setRailWidth(readStoredNumber(RAIL_STORAGE, RAIL_DEFAULT_WIDTH, 120, 360));
      setRightWidth(readStoredNumber(RIGHT_STORAGE, RIGHT_DEFAULT_WIDTH, 220, 640));
      setRailCollapsed(readStoredFlag(RAIL_COLLAPSED_STORAGE));
      setRightCollapsed(readStoredFlag(RIGHT_COLLAPSED_STORAGE));
    });
    const handleResize = () => {
      if (window.innerWidth < 1024) setRightCollapsed(true);
    };
    window.addEventListener("resize", handleResize);
    handleResize();
    return () => {
      window.cancelAnimationFrame(hydrationFrame);
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(RAIL_STORAGE, String(railWidth));
    } catch {
      // not load-bearing
    }
  }, [railWidth]);

  useEffect(() => {
    try {
      window.localStorage.setItem(RIGHT_STORAGE, String(rightWidth));
    } catch {
      // not load-bearing
    }
  }, [rightWidth]);

  useEffect(() => {
    try {
      window.localStorage.setItem(RAIL_COLLAPSED_STORAGE, railCollapsed ? "1" : "0");
    } catch {
      // not load-bearing
    }
  }, [railCollapsed]);

  useEffect(() => {
    try {
      window.localStorage.setItem(RIGHT_COLLAPSED_STORAGE, rightCollapsed ? "1" : "0");
    } catch {
      // not load-bearing
    }
  }, [rightCollapsed]);

  // Auto-expand right pane when the agent writes a file (spec §6).
  useEffect(() => {
    if (touchedPaths.size > 0 && rightCollapsedRef.current) {
      const frame = window.requestAnimationFrame(() => setRightCollapsed(false));
      return () => window.cancelAnimationFrame(frame);
    }
    // touchedPaths is the trigger; rightCollapsed is read through a ref
    // so collapsing later does not re-fire this effect.
  }, [touchedPaths]);

  // Keyboard shortcuts (spec §5 commit 5). switchSection captured in
  // a ref so the document keydown listener doesn't need to re-bind
  // on every render.
  const switchSectionRef = useRef(switchSection);
  useEffect(() => {
    switchSectionRef.current = switchSection;
  }, [switchSection]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      if (event.key >= "1" && event.key <= "4") {
        const index = Number(event.key) - 1;
        const target = ["story", "script", "assets", "workshop"][index];
        if (target) {
          event.preventDefault();
          switchSectionRef.current(target);
        }
        return;
      }
      if (event.key === "\\") {
        event.preventDefault();
        if (event.shiftKey) setRightCollapsed((c) => !c);
        else setRailCollapsed((c) => !c);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  return {
    railWidth,
    rightWidth,
    railCollapsed,
    rightCollapsed,
    setRailWidth,
    setRightWidth,
    setRailCollapsed,
    setRightCollapsed,
  };
}
