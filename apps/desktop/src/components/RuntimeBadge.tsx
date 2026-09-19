import { useState } from "react";
import { formatDurationLabel } from "../lib/duration";

// Inline runtime control rendered at every level of the
// script tree (master / scene / shot / prompt segment). Three visual
// states selected by the `editing` prop + the presence/absence of
// `value`:
//   - editing   → numeric <input> with Enter/Esc commit
//   - empty     → dashed "＋ runtime" affordance
//   - set       → formatted duration, optional delta chip for sync
//
// Draft state is LOCAL to the input subcomponent. Parent owns only which
// row is editing (editingDurationKey) so concurrent edits across multiple
// rows stay mutually exclusive. Previously the draft lived in App.tsx
// state and every keystroke re-rendered all ~1500 badges on a big project;
// now it's one mount/unmount per edit session.

type Props = {
  editing: boolean;
  initialDraft: string;
  onEditCommit: (draft: string) => void;
  onEditCancel: () => void;
  onEditStart: () => void;

  // View-state inputs
  value: number | null; // duration in seconds, null/0 renders empty
  text?: string;        // overrides formatted duration (e.g. "0-15s" for segments)
  prefix?: string;      // e.g. "~" for derived shot durations
  emptyLabel?: string;  // text shown when value is falsy — default "＋ runtime"
  hideWhenEmpty?: boolean; // if true and value+text are empty, render nothing
  tooltip: string;

  // Optional delta chip (sync action)
  delta?: number;
  deltaTooltip?: string;
  onSyncClick?: () => void;

  // Styling flags
  isTotal?: boolean;    // item-row-badge-total (master)
  isDerived?: boolean;  // font-italic + muted (derived from children)
};

function RuntimeBadgeInput({
  initialDraft,
  onCommit,
  onCancel,
}: {
  initialDraft: string;
  onCommit: (draft: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initialDraft);
  return (
    <input
      className="item-row-badge item-row-badge-edit runtime-badge-edit"
      type="text"
      name="runtime-seconds"
      autoComplete="off"
      aria-label="Runtime in seconds"
      inputMode="numeric"
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => onCommit(draft)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit(draft);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
    />
  );
}

export function RuntimeBadge({
  editing,
  initialDraft,
  onEditCommit,
  onEditCancel,
  onEditStart,
  value,
  text,
  prefix,
  emptyLabel = "＋ runtime",
  hideWhenEmpty = false,
  tooltip,
  delta = 0,
  deltaTooltip,
  onSyncClick,
  isTotal = false,
  isDerived = false,
}: Props) {
  if (editing) {
    return (
      <RuntimeBadgeInput
        initialDraft={initialDraft}
        onCommit={onEditCommit}
        onCancel={onEditCancel}
      />
    );
  }

  const hasValue = Number.isFinite(Number(value)) && Number(value) > 0;
  const bodyText = hasValue
    ? text ?? `${prefix || ""}${formatDurationLabel(value)}`
    : text || "";
  const isEmpty = !bodyText;

  if (isEmpty && hideWhenEmpty) return null;

  const className = [
    "item-row-badge",
    "runtime-badge",
    "item-row-badge-editable",
    isTotal ? "item-row-badge-total" : "",
    isDerived && hasValue ? "item-row-badge-derived" : "",
    isEmpty ? "badge-empty" : "",
    delta > 0 ? "badge-over" : delta < 0 ? "badge-under" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span className={className}>
      <button
        type="button"
        className="item-row-badge-trigger"
        title={tooltip}
        aria-label={tooltip}
        onClick={(event) => {
          event.stopPropagation();
          onEditStart();
        }}
      >
        {isEmpty ? emptyLabel : bodyText}
      </button>
      {delta !== 0 && onSyncClick ? (
        <button
          type="button"
          className="badge-delta badge-delta-click"
          title={deltaTooltip || ""}
          aria-label={deltaTooltip || ""}
          onClick={(event) => {
            event.stopPropagation();
            onSyncClick();
          }}
        >
          {delta > 0 ? "↑" : "↓"}
          {Math.abs(delta)}s
        </button>
      ) : delta !== 0 ? (
        <span
          className="badge-delta"
          title={deltaTooltip || ""}
          aria-label={deltaTooltip || ""}
        >
          {delta > 0 ? "↑" : "↓"}
          {Math.abs(delta)}s
        </span>
      ) : null}
    </span>
  );
}
