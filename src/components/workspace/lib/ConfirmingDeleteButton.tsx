"use client";

import { useEffect, useRef, useState } from "react";

// Two-step delete button shared by surfaces that need a single
// arm/confirm gesture (not coordinating across a list — RailFileTree
// keeps its own ID-keyed multi-row state so only one row can be armed
// at a time, which a self-contained component can't express).
//
// Click once → arms (button shows armedLabel, class `is-armed`).
// Click again within `timeoutMs` → invokes onConfirm and resets.
// Otherwise auto-disarms after `timeoutMs` ms.
//
// Component owns its own state and timer; resets cleanly on unmount.
// Improvement-plan §3.4.

export type ConfirmingDeleteButtonProps = {
  onConfirm: () => void | Promise<void>;
  label?: string;
  armedLabel?: string;
  hint?: string;
  armedHint?: string;
  className?: string;
  disabled?: boolean;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 2500;

export function ConfirmingDeleteButton({
  onConfirm,
  label = "Delete",
  armedLabel = "Confirm?",
  hint = "Delete",
  armedHint = "Click again to delete",
  className,
  disabled,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: ConfirmingDeleteButtonProps) {
  const [armed, setArmed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  function disarm() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setArmed(false);
  }

  function handleClick() {
    if (!armed) {
      setArmed(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setArmed(false);
      }, timeoutMs);
      return;
    }
    disarm();
    void onConfirm();
  }

  const composedClass = armed
    ? `${className || ""} is-armed`.trim()
    : className;

  return (
    <button
      type="button"
      className={composedClass || undefined}
      onClick={handleClick}
      disabled={disabled}
      title={armed ? armedHint : hint}
      aria-pressed={armed ? true : undefined}
    >
      {armed ? armedLabel : label}
    </button>
  );
}
