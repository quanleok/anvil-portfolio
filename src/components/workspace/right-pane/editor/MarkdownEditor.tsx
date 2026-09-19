"use client";

// Markdown textarea for browser project docs. Persistence is quiet
// autosave from SharedDocEditor; this component only renders the edit
// surface.

export type MarkdownEditorProps = {
  draft: string;
  onDraftChange: (next: string) => void;
  onDraftDirty: () => void;
  onDraftCommit: () => void;
};

export function MarkdownEditor({
  draft,
  onDraftChange,
  onDraftDirty,
  onDraftCommit,
}: MarkdownEditorProps) {
  return (
    <div className="anvil-workspace-editor-body">
      <textarea
        value={draft}
        onChange={(event) => {
          onDraftChange(event.target.value);
          onDraftDirty();
        }}
        onBlur={onDraftCommit}
        placeholder="Write markdown..."
        spellCheck={false}
      />
    </div>
  );
}
