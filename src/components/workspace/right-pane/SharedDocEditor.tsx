"use client";

import { useEffect } from "react";

import { useEditorDraft } from "../WorkspaceProvider";
import { MarkdownEditor } from "./editor/MarkdownEditor";

// Shared markdown doc surface for ContextWorkspace and ScriptWorkspace.
// The browser app keeps persistence quiet: no Save button, no dirty
// badge, no revision drawer in the main flow.

export function SharedDocEditor() {
  const {
    selectedFile,
    selectedPath,
    dirty,
    conflictFile,
    setDraft,
    setDirty,
    saveFile,
    draft,
  } = useEditorDraft();

  useEffect(() => {
    if (!dirty || !selectedPath) return;
    const timer = window.setTimeout(() => {
      void saveFile({ force: Boolean(conflictFile) });
    }, 700);
    return () => window.clearTimeout(timer);
  }, [conflictFile, dirty, draft, saveFile, selectedPath]);

  return (
    <>
      <header className="anvil-workspace-doc-header">
        <div>
          <h2>{selectedFile?.title || selectedPath.split("/").pop() || "New doc"}</h2>
          <p>{selectedPath}</p>
        </div>
      </header>
      <MarkdownEditor
        draft={draft}
        onDraftChange={setDraft}
        onDraftDirty={() => setDirty(true)}
        onDraftCommit={() => {
          if (dirty) void saveFile({ force: Boolean(conflictFile) });
        }}
      />
    </>
  );
}
