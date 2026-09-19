import { type ReactNode, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

interface ModalProps {
  cancelLabel?: string;
  children: ReactNode;
  className?: string;
  description?: string;
  onCancel: () => void;
  onSubmit?: () => void;
  submitLabel?: string;
  title: string;
  submitDisabled?: boolean;
  submitDisabledReason?: string;
}

export function Modal({
  cancelLabel = "Cancel",
  children,
  className = "",
  description,
  onCancel,
  onSubmit,
  submitLabel,
  title,
  submitDisabled = false,
  submitDisabledReason,
}: ModalProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const descriptionId = useId();
  const titleId = useId();

  // Focus the first focusable element on mount; restore focus to the
  // previously-focused element on unmount (matches native <dialog> semantics).
  useEffect(() => {
    const prevFocus = document.activeElement as HTMLElement | null;
    const focusable = cardRef.current?.querySelector<HTMLElement>(
      'input, textarea, select, button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus();
    return () => {
      if (prevFocus && typeof prevFocus.focus === "function" && document.contains(prevFocus)) {
        prevFocus.focus();
      }
    };
  }, []);

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && onSubmit && !submitDisabled) {
        event.preventDefault();
        onSubmit();
        return;
      }
      // Focus trap: cycle Tab focus inside the modal card.
      if (event.key === "Tab" && cardRef.current) {
        const nodes = cardRef.current.querySelectorAll<HTMLElement>(
          'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (!nodes.length) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (event.shiftKey && active === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel, onSubmit, submitDisabled]);

  const modal = (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        ref={cardRef}
        className={["modal-card", className].filter(Boolean).join(" ")}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <div className="modal-head">
          <h3 id={titleId}>{title}</h3>
          {description ? <p id={descriptionId}>{description}</p> : null}
        </div>
        <div className="modal-body">{children}</div>
        <div className="modal-actions">
          <button className="ghost-btn" onClick={onCancel} type="button">
            {cancelLabel}
          </button>
          {onSubmit && submitLabel ? (
            <button
              className="primary-btn"
              onClick={onSubmit}
              disabled={submitDisabled}
              type="button"
              title={submitDisabled && submitDisabledReason ? submitDisabledReason : undefined}
            >
              {submitLabel}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
