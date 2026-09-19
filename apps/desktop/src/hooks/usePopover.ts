import { useEffect, useRef, useState, type RefObject } from "react";

// Shared open/close + outside-click + escape-key logic for dropdown
// popovers. Replaces three copies of the same useEffect across
// FormatMenu, MediaUploadButton, and linked asset pickers.
//
//   const { open, setOpen, ref } = usePopover<HTMLDivElement>();
//   <div ref={ref}>...</div>
//
// The ref must be attached to the popover's outermost wrapper — clicks
// outside that wrapper close the popover; Escape closes it regardless.
export function usePopover<T extends HTMLElement = HTMLDivElement>(): {
  open: boolean;
  setOpen: (next: boolean | ((prev: boolean) => boolean)) => void;
  ref: RefObject<T | null>;
  toggle: () => void;
  close: () => void;
} {
  const [open, setOpen] = useState(false);
  const ref = useRef<T | null>(null);

  useEffect(() => {
    if (!open) return;
    const handleDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  return {
    open,
    setOpen,
    ref,
    toggle: () => setOpen((c) => !c),
    close: () => setOpen(false),
  };
}
