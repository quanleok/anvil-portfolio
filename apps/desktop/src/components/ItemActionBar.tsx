import type { ReactNode } from "react";
import type { FocusScope, FormatKind, SectionId } from "../types";
import type { PrimarySectionId, SectionEntry } from "../lib/sections";
import { getAgentActions, type AgentActionItem } from "../lib/agent-actions";
import { evaluateLockVisual, shortLockLabel } from "../lib/focus-lock";
import { usePopover } from "../hooks/usePopover";
import { InlineLockIcon } from "./icons";
import { handleMenuNavigation } from "./menu-navigation";

export interface ItemActionBarProps {
  activeSection: SectionId;
  activePrimary: PrimarySectionId;
  selectedItem: SectionEntry | null;
  projectContextSelected: boolean;
  sectionFormatSelected: FormatKind | null;
  selectedMagicDoc?: boolean;
  pinboardSelected?: boolean;
  focusScope: FocusScope;
  sending: boolean;
  onSend: (message: string, label?: string) => void;
  // Right-aligned slot — used for the format-rules gear so it lives on
  // the same row as the primary action pills instead of floating over
  // the editor head.
  trailing?: ReactNode;
}

// Shows up to 3 action pills inline; anything beyond collapses into a "⋯"
// overflow dropdown.
const INLINE_LIMIT = 3;

export function ItemActionBar({
  activeSection,
  activePrimary,
  selectedItem,
  projectContextSelected,
  sectionFormatSelected,
  selectedMagicDoc = false,
  pinboardSelected = false,
  focusScope,
  sending,
  onSend,
  trailing,
}: ItemActionBarProps) {
  const {
    open: overflowOpen,
    toggle: toggleOverflow,
    close: closeOverflow,
    ref: wrapRef,
  } = usePopover<HTMLDivElement>();

  const actions = getAgentActions({
    activeSection,
    activePrimary,
    selectedItem,
    projectContextSelected,
    sectionFormatSelected,
    selectedMagicDoc,
    pinboardSelected,
  });

  if (actions.length === 0 && !trailing) return null;

  const inline = actions.slice(0, INLINE_LIMIT);
  const overflow = actions.slice(INLINE_LIMIT);

  const fire = (action: AgentActionItem) => {
    if (sending) return;
    onSend(action.message, action.label);
    closeOverflow();
  };

  const lockLabel = shortLockLabel(focusScope);
  const lockVisual = evaluateLockVisual(focusScope, selectedItem?.path);

  return (
    <div className="item-action-bar" ref={wrapRef}>
      {lockLabel ? (
        <span
          className={`item-action-lock lock-${lockVisual}`}
          title="Focus lock active"
        >
          <span className="item-action-lock-icon"><InlineLockIcon /></span>
          <span>{lockLabel}</span>
        </span>
      ) : null}
      {inline.map((action) => (
        <button
          key={action.label}
          className="item-action-pill item-action-primary icon-hover-tooltip tooltip-bottom"
          onClick={() => fire(action)}
          disabled={sending}
          data-tooltip={action.hint}
          type="button"
          data-action-label={action.label}
        >
          <span className="item-action-icon" aria-hidden="true">{action.icon}</span>
          <span className="item-action-label">{action.label}</span>
        </button>
      ))}
      {overflow.length > 0 ? (
        <div className="item-action-overflow">
          <button
            className="item-action-pill item-action-more icon-hover-tooltip tooltip-bottom"
            onClick={toggleOverflow}
            disabled={sending}
            data-tooltip={`${overflow.length} more action${overflow.length === 1 ? "" : "s"}`}
            aria-label="More actions"
            aria-expanded={overflowOpen}
            type="button"
          >
            ⋯
          </button>
          {overflowOpen ? (
            <div className="item-action-overflow-menu" role="menu" aria-label="More actions" onKeyDown={handleMenuNavigation}>
              {overflow.map((action) => (
                <button
                  key={action.label}
                  className="item-action-overflow-item"
                  onClick={() => fire(action)}
                  disabled={sending}
                  role="menuitem"
                  type="button"
                >
                  <span className="item-action-icon" aria-hidden="true">{action.icon}</span>
                  <span className="item-action-overflow-text">
                    <span className="item-action-overflow-label">{action.label}</span>
                    <span className="item-action-overflow-hint">{action.hint}</span>
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {trailing ? <div className="item-action-bar-trailing">{trailing}</div> : null}
    </div>
  );
}
