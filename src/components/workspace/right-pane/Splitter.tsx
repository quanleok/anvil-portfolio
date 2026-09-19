"use client";

import { useState } from "react";

// Thin vertical splitter for resizing rail / right pane widths.
// Window-level pointermove avoids losing the drag when the cursor
// passes over child iframes / scroll containers.
//
// Visible 1px seam line, generous 10px hover hit area centered on
// the seam so users can grab it without pixel-hunting (improvement
// plan §4.3). The line goes violet on hover/active.

export type SplitterProps = {
  ariaLabel: string;
  onDrag: (deltaX: number) => void;
};

export function Splitter({ ariaLabel, onDrag }: SplitterProps) {
  const [hover, setHover] = useState(false);
  const [active, setActive] = useState(false);
  const lit = hover || active;
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      style={{
        position: "relative",
        width: 10,
        marginInline: -3,
        cursor: "col-resize",
        flexShrink: 0,
        background: "transparent",
        zIndex: 2,
      }}
      onPointerDown={(event) => {
        event.preventDefault();
        setActive(true);
        let lastX = event.clientX;
        const onMove = (move: PointerEvent) => {
          const dx = move.clientX - lastX;
          lastX = move.clientX;
          onDrag(dx);
        };
        const onUp = () => {
          setActive(false);
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      }}
    >
      {/* Visible 1px line, centered inside the 10px hit area. Picks
          up the violet accent on hover so users can see it's grabbable. */}
      <span
        aria-hidden
        style={{
          position: "absolute",
          inset: "0 auto 0 50%",
          transform: "translateX(-0.5px)",
          width: 1,
          background: lit ? "rgba(167, 139, 250, 0.65)" : "rgba(148, 163, 184, 0.18)",
          transition: "background 120ms ease",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}
