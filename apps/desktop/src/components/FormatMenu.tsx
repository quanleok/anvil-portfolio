import type { FormatKind } from "../types";
import { SECTION_FORMAT_LABELS } from "../lib/section-format";
import { usePopover } from "../hooks/usePopover";
import { handleMenuNavigation } from "./menu-navigation";

// Compact trigger that sits on the ItemActionBar row, right-aligned next
// to the primary actions. Opens a popover listing the active agent
// writing-rules docs (Master Script + Prompt format). Owns its own open-state
// + outside-click dismissal so App.tsx doesn't carry the responsibility
// anymore.

type Props = {
  onSelect: (kind: FormatKind) => void;
};

export function FormatMenu({ onSelect }: Props) {
  const { open, toggle, close, ref } = usePopover<HTMLDivElement>();

  return (
    <div className="format-menu-wrapper" ref={ref}>
      <button
        className="format-menu-trigger"
        onClick={toggle}
        title="Format rules"
        aria-label="Format rules"
        aria-expanded={open}
        aria-haspopup="menu"
        type="button"
      >
        Format Rules
      </button>
      {open ? (
        <div className="format-menu-popover" role="menu" aria-label="Writing rules" onKeyDown={handleMenuNavigation}>
          <div className="format-menu-head">Writing rules</div>
          {(["script", "prompts"] as FormatKind[]).map((kind) => (
            <button
              key={kind}
              className="format-menu-item"
              role="menuitem"
              type="button"
              onClick={() => {
                onSelect(kind);
                close();
              }}
              title={SECTION_FORMAT_LABELS[kind].pathHint}
            >
              {SECTION_FORMAT_LABELS[kind].label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
