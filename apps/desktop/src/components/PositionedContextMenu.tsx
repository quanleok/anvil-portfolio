import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { focusFirstMenuItem, handleMenuNavigation } from "./menu-navigation";

interface PositionedContextMenuProps {
  ariaLabel: string;
  children: ReactNode;
  onClose: () => void;
  title?: ReactNode;
  x: number;
  y: number;
}

export function PositionedContextMenu({
  ariaLabel,
  children,
  onClose,
  title,
  x,
  y,
}: PositionedContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ top: y, left: x });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useLayoutEffect(() => {
    const node = menuRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const margin = 8;
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
    setPos({
      left: Math.max(margin, Math.min(x, maxLeft)),
      top: Math.max(margin, Math.min(y, maxTop)),
    });
  }, [x, y]);

  useEffect(() => {
    focusFirstMenuItem(menuRef.current);
  }, []);

  const menu = (
    <div
      className="shot-context-menu-backdrop"
      onClick={onClose}
      onContextMenu={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div
        ref={menuRef}
        aria-label={ariaLabel}
        className="shot-context-menu"
        role="menu"
        style={{ top: pos.top, left: pos.left }}
        onClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.stopPropagation()}
        onKeyDown={handleMenuNavigation}
      >
        {title ? <div className="shot-context-menu-title">{title}</div> : null}
        {children}
      </div>
    </div>
  );

  return createPortal(menu, document.body);
}
