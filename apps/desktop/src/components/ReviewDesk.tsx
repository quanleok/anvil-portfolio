import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  ReviewFileContent,
  ReviewFileEntry,
  ReviewFileList,
  ReviewFileTarget,
} from "../types";

interface ReviewDeskProps {
  projectDir: string;
  onClose: () => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}

function targetKey(target: ReviewFileTarget | null) {
  return target ? `${target.scope}:${target.path}` : "";
}

function fileSizeLabel(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 1) return "0 KB";
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 1024 * 100 ? 1 : 0)} KB`;
}

function modifiedLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function firstFile(list: ReviewFileList | null) {
  return list?.groups.find((group) => group.files.length > 0)?.files[0] || null;
}

export function ReviewDesk({ projectDir, onClose, onError, onNotice }: ReviewDeskProps) {
  const [fileList, setFileList] = useState<ReviewFileList | null>(null);
  const [selected, setSelected] = useState<ReviewFileTarget | null>(null);
  const [loaded, setLoaded] = useState<ReviewFileContent | null>(null);
  const [text, setText] = useState("");
  const [savedText, setSavedText] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [filter, setFilter] = useState("");
  const dirty = text !== savedText;
  const selectedKey = targetKey(selected);

  const loadList = useCallback(async () => {
    try {
      const next = await window.forgeDesktop.listReviewFiles(projectDir);
      setFileList(next);
      setSelected((current) => current || firstFile(next));
    } catch (error) {
      onError(error instanceof Error ? error.message : "Review Desk failed to list files.");
    }
  }, [onError, projectDir]);

  const loadSelected = useCallback(async (target: ReviewFileTarget) => {
    setLoading(true);
    try {
      const next = await window.forgeDesktop.readReviewFile(projectDir, target);
      setLoaded(next);
      setText(next.content);
      setSavedText(next.content);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Review Desk failed to read file.");
    } finally {
      setLoading(false);
    }
  }, [onError, projectDir]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (!selected) return;
    void loadSelected(selected);
  }, [loadSelected, selected, selectedKey]);

  useEffect(() => {
    if (!selected || dirty) return;
    const timer = window.setInterval(async () => {
      try {
        const next = await window.forgeDesktop.readReviewFile(projectDir, selected);
        setLoaded(next);
        setText(next.content);
        setSavedText(next.content);
      } catch {
        // Ignore transient reload failures; explicit reload/save reports errors.
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [dirty, projectDir, selected, selectedKey]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (selected) void saveFile();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const filteredGroups = useMemo(() => {
    if (!fileList) return [];
    const needle = filter.trim().toLowerCase();
    return fileList.groups
      .map((group) => ({
        ...group,
        files: needle
          ? group.files.filter((file) =>
              `${file.path} ${file.label} ${file.scope}`.toLowerCase().includes(needle),
            )
          : group.files,
      }))
      .filter((group) => group.files.length > 0);
  }, [fileList, filter]);

  async function saveFile() {
    if (!selected || saving) return;
    setSaving(true);
    try {
      const result = await window.forgeDesktop.writeReviewFile(projectDir, selected, text);
      setLoaded((current) => current
        ? { ...current, modifiedAt: result.modifiedAt, sizeBytes: result.sizeBytes, content: text }
        : current);
      setSavedText(text);
      onNotice(`Saved ${selected.path}.`);
      void loadList();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Review Desk failed to save file.");
    } finally {
      setSaving(false);
    }
  }

  async function appendNote() {
    const note = noteDraft.trim();
    if (!note) return;
    try {
      await window.forgeDesktop.appendReviewNote(projectDir, note);
      setNoteDraft("");
      onNotice("Review note added.");
      void loadList();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Review Desk failed to add note.");
    }
  }

  function selectFile(file: ReviewFileEntry) {
    if (dirty && !window.confirm("Discard unsaved Review Desk edits?")) return;
    setSelected({ scope: file.scope, path: file.path });
  }

  return (
    <div className="review-desk-backdrop" role="dialog" aria-modal="true" aria-label="Review Desk">
      <section className="review-desk-shell">
        <header className="review-desk-header">
          <div>
            <h2>Review Desk</h2>
            <p>Live text review for product docs, desktop internals, and this project.</p>
          </div>
          <div className="review-desk-header-actions">
            <span className={dirty ? "review-desk-state dirty" : "review-desk-state"}>
              {dirty ? "Unsaved" : "Clean"}
            </span>
            <button type="button" className="review-desk-icon-btn" onClick={onClose} aria-label="Close Review Desk">
              x
            </button>
          </div>
        </header>

        <div className="review-desk-grid">
          <aside className="review-desk-sidebar">
            <input
              className="review-desk-filter"
              value={filter}
              onChange={(event) => setFilter(event.currentTarget.value)}
              placeholder="Filter files"
              aria-label="Filter Review Desk files"
            />
            <div className="review-desk-file-groups">
              {filteredGroups.length === 0 ? (
                <p className="review-desk-empty">No text files found.</p>
              ) : filteredGroups.map((group) => (
                <section key={group.id} className="review-desk-file-group">
                  <h3>{group.label}</h3>
                  {group.files.map((file) => (
                    <button
                      key={`${file.scope}:${file.path}`}
                      type="button"
                      className={[
                        "review-desk-file",
                        selectedKey === `${file.scope}:${file.path}` ? "active" : "",
                      ].filter(Boolean).join(" ")}
                      onClick={() => selectFile(file)}
                      title={file.path}
                    >
                      <span>{file.label}</span>
                      <small>{file.scope} - {fileSizeLabel(file.sizeBytes)}</small>
                    </button>
                  ))}
                </section>
              ))}
            </div>
          </aside>

          <main className="review-desk-editor-pane">
            <div className="review-desk-toolbar">
              <div className="review-desk-path">
                <span>{selected?.scope || "repo"}</span>
                <strong>{selected?.path || "No file selected"}</strong>
                {loaded ? <small>{fileSizeLabel(loaded.sizeBytes)} - {modifiedLabel(loaded.modifiedAt)}</small> : null}
              </div>
              <div className="review-desk-toolbar-actions">
                <button
                  type="button"
                  onClick={() => selected && loadSelected(selected)}
                  disabled={!selected || loading}
                >
                  Reload
                </button>
                <button
                  type="button"
                  className="review-desk-save"
                  onClick={() => void saveFile()}
                  disabled={!selected || !dirty || saving}
                >
                  {saving ? "Saving" : "Save"}
                </button>
              </div>
            </div>
            <textarea
              className="review-desk-editor"
              value={text}
              onChange={(event) => setText(event.currentTarget.value)}
              spellCheck={false}
              disabled={!selected || loading}
              placeholder={loading ? "Loading..." : "Select a file to review."}
            />
          </main>

          <aside className="review-desk-notes">
            <h3>Notes</h3>
            <p>Append decisions here while we sort files together.</p>
            <textarea
              value={noteDraft}
              onChange={(event) => setNoteDraft(event.currentTarget.value)}
              placeholder="Example: keep continuity.md, merge shot grammar into prompt protocol."
            />
            <button type="button" onClick={() => void appendNote()} disabled={!noteDraft.trim()}>
              Add note
            </button>
          </aside>
        </div>
      </section>
    </div>
  );
}
