"use client";

import { memo, useRef, useState, type DragEvent } from "react";

import { ChatComposer } from "./ChatComposer";
import { ChatThread } from "./ChatThread";
import { useWorkspace } from "../WorkspaceProvider";

// Center-column chat panel. ChatGPT-style — no top header chrome,
// thread fills the column and scrolls, composer pinned to the
// bottom. The Anvil-Agent / Hosted-workflow header is gone now
// that the project name + section state live in the left rail.
//
// Drop-target generosity (improvement-plan 4.7): the entire agent
// column accepts a file drag, not just the composer textarea. When
// files are dragged anywhere over this <aside>, we mount a violet-
// outlined overlay with a centered "Drop to attach…" hint. Anywhere
// inside the column is a valid drop area; the composer no longer
// owns its own drop handlers (kept its dragOver placeholder for the
// textarea-only typing affordance but the actual file pickup is at
// the column level).

function dragHasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

export const AgentChat = memo(function AgentChat() {
  const { messages, agentBusy, uploadMedia, selectFile } = useWorkspace();
  const [dragOver, setDragOver] = useState(false);
  // Drag enter/leave counter — drag events fire on every child
  // crossing, so a naive boolean toggles repeatedly. Counter keeps
  // the overlay open until the actual leave at depth 0.
  const dragDepthRef = useRef(0);

  function handleDragEnter(event: DragEvent<HTMLElement>) {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragOver(true);
  }
  function handleDragOver(event: DragEvent<HTMLElement>) {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  }
  function handleDragLeave(event: DragEvent<HTMLElement>) {
    if (!dragHasFiles(event)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragOver(false);
  }
  function handleDrop(event: DragEvent<HTMLElement>) {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragOver(false);
    const files = event.dataTransfer?.files;
    if (files && files.length) {
      void attachFiles(files);
    }
  }

  async function attachFiles(files: File[] | FileList) {
    for (const file of Array.from(files)) {
      await uploadMedia(file);
    }
  }

  const className = [
    "anvil-workspace-agent",
    agentBusy ? "is-working" : "",
    dragOver ? "is-drag-over" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <aside
      className={className}
      aria-busy={agentBusy ? true : undefined}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <ChatThread messages={messages} agentBusy={agentBusy} onOpenPath={selectFile} />
      <ChatComposer />
      {dragOver ? (
        <div className="anvil-workspace-agent-drop-overlay" aria-hidden="true">
          <span>Drop to attach…</span>
        </div>
      ) : null}
    </aside>
  );
});
