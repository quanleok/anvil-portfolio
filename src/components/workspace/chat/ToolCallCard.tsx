"use client";

import { memo } from "react";

import { ChevronRightIcon, FilePlusIcon, PencilIcon } from "../lib/icons";
import type { ChatToolCall } from "./types";

// Inline card per visual spec §4 — three variants:
//   create   · file-plus icon (success color) + "wrote X" + stats
//   edit     · pencil icon (info color) + "edited X" + diff stats
//   running  · spinner + "creating ..." + "N of M" progress
// Card is the click target; surfaces the file in the right pane.

export type ToolCallCardProps = {
  toolCall: ChatToolCall;
  onOpenPath: (path: string) => void;
};

function defaultMeta(kind: ChatToolCall["kind"], count: number) {
  if (kind === "running") return undefined;
  return `${count} file${count === 1 ? "" : "s"} · just now`;
}

export const ToolCallCard = memo(function ToolCallCard({ toolCall, onOpenPath }: ToolCallCardProps) {
  const kind = toolCall.kind || "create";
  const primaryPath = toolCall.paths[0] || "";
  const title =
    kind === "running"
      ? toolCall.progress
        ? `${toolCall.appliedCount > 0 ? "Editing" : "Writing"}…`
        : "Working…"
      : kind === "edit"
        ? `edited ${primaryPath || `${toolCall.appliedCount} file${toolCall.appliedCount === 1 ? "" : "s"}`}`
        : `wrote ${primaryPath || `${toolCall.appliedCount} file${toolCall.appliedCount === 1 ? "" : "s"}`}`;
  const meta = toolCall.stats || toolCall.progress || defaultMeta(kind, toolCall.appliedCount);

  return (
    <button
      type="button"
      className="anvil-workspace-tool-call"
      onClick={() => primaryPath && onOpenPath(primaryPath)}
      disabled={!primaryPath}
      aria-label={title}
    >
      {kind === "running" ? (
        <span className="anvil-workspace-tool-call-spinner" aria-hidden />
      ) : kind === "edit" ? (
        <PencilIcon size={13} className="anvil-workspace-tool-call-icon--edit" />
      ) : (
        <FilePlusIcon size={13} className="anvil-workspace-tool-call-icon--create" />
      )}
      <span className="anvil-workspace-tool-call-body">
        <span className="anvil-workspace-tool-call-title">{title}</span>
        {meta ? <span className="anvil-workspace-tool-call-meta">{meta}</span> : null}
      </span>
      {kind !== "running" ? (
        <ChevronRightIcon size={11} className="anvil-workspace-tool-call-trailing" />
      ) : null}
    </button>
  );
});
