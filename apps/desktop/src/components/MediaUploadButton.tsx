import { useState, type DragEvent } from "react";
import { OpenLibraryIcon, UploadArrowIcon, UploadFilesIcon, UploadFolderIcon } from "./icons";
import { usePopover } from "../hooks/usePopover";
import { handleMenuNavigation } from "./menu-navigation";

export interface MediaUploadButtonProps {
  projectDir: string;
  onNotice: (msg: string) => void;
  onError: (msg: string) => void;
  onProjectReload: () => void;
  // Optional. Header renders this; the in-panel usage omits it so the
  // self-referential "Open Media library" menu item doesn't appear when
  // the user is already on the Media panel.
  onGoToMedia?: () => void;
}

// Header-level shortcut for importing files into the unified media
// library. The label intentionally says "Import media" because the
// primary action is ingestion; the menu still includes a navigation
// shortcut to the library.
export function MediaUploadButton({
  projectDir,
  onNotice,
  onError,
  onProjectReload,
  onGoToMedia,
}: MediaUploadButtonProps) {
  const { open, toggle, close, ref: wrapRef } = usePopover<HTMLDivElement>();
  const [busy, setBusy] = useState<null | "files" | "folder" | "drop">(null);
  const [dragOver, setDragOver] = useState(false);

  async function uploadFiles() {
    if (!projectDir || busy) return;
    setBusy("files");
    try {
      const result = await window.forgeDesktop.uploadLibraryAssets(projectDir);
      if (result.length) {
        onNotice(`${result.length} file${result.length === 1 ? "" : "s"} added to media library.`);
        onProjectReload();
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setBusy(null);
      close();
    }
  }

  async function uploadFolder() {
    if (!projectDir || busy) return;
    setBusy("folder");
    try {
      const result = await window.forgeDesktop.uploadLibraryFolder(projectDir);
      if (result.length) {
        onNotice(`${result.length} file${result.length === 1 ? "" : "s"} imported from folder.`);
        onProjectReload();
      } else {
        onNotice("No supported media found in that folder.");
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : "Folder import failed.");
    } finally {
      setBusy(null);
      close();
    }
  }

  function handleDragOver(event: DragEvent) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragOver(true);
  }

  function handleDragLeave() {
    setDragOver(false);
  }

  async function handleDrop(event: DragEvent) {
    event.preventDefault();
    setDragOver(false);
    if (!projectDir || busy) return;
    const files = event.dataTransfer.files;
    if (!files.length) return;
    const paths: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const p = (f as unknown as { path?: string }).path;
      if (p) paths.push(p);
    }
    if (!paths.length) {
      onError("Could not read dropped file paths.");
      return;
    }
    setBusy("drop");
    try {
      const result = await window.forgeDesktop.dropLibraryFiles(projectDir, paths);
      if (result.length) {
        onNotice(`${result.length} file${result.length === 1 ? "" : "s"} added to media library.`);
        onProjectReload();
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : "Drop failed.");
    } finally {
      setBusy(null);
    }
  }

  const busyLabel =
    busy === "files" ? "Uploading…"
      : busy === "folder" ? "Importing folder…"
      : busy === "drop" ? "Adding…"
      : null;

  return (
    <div className="media-upload-wrap" ref={wrapRef}>
      <button
        className={[
          "ghost-btn",
          "compact",
          "media-upload-btn",
          dragOver ? "drag-over" : "",
          open ? "open" : "",
        ].filter(Boolean).join(" ")}
        onClick={toggle}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={(e) => void handleDrop(e)}
        disabled={Boolean(busy)}
        title={busyLabel || "Import media or open the media library"}
        aria-label="Import media"
        aria-haspopup="menu"
        aria-expanded={open}
        type="button"
      >
        <span className="media-upload-glyph" aria-hidden="true">
          <UploadArrowIcon />
        </span>
        <span className="media-upload-label">{busyLabel || "Import media"}</span>
      </button>
      {open && !busy ? (
        <div className="media-upload-menu" role="menu" aria-label="Import media options" onKeyDown={handleMenuNavigation}>
          <button
            className="media-upload-menu-item"
            onClick={() => void uploadFiles()}
            type="button"
            role="menuitem"
          >
            <span className="media-upload-menu-icon" aria-hidden="true"><UploadFilesIcon /></span>
            <span className="media-upload-menu-text">
              <span className="media-upload-menu-label">Upload files…</span>
              <span className="media-upload-menu-hint">Pick files.</span>
            </span>
          </button>
          <button
            className="media-upload-menu-item"
            onClick={() => void uploadFolder()}
            type="button"
            role="menuitem"
          >
            <span className="media-upload-menu-icon" aria-hidden="true"><UploadFolderIcon /></span>
            <span className="media-upload-menu-text">
              <span className="media-upload-menu-label">Upload folder…</span>
              <span className="media-upload-menu-hint">Import supported media.</span>
            </span>
          </button>
          {onGoToMedia ? (
            <>
              <div className="media-upload-menu-divider" />
              <button
                className="media-upload-menu-item"
                onClick={() => {
                  close();
                  onGoToMedia();
                }}
                type="button"
                role="menuitem"
              >
                <span className="media-upload-menu-icon" aria-hidden="true"><OpenLibraryIcon /></span>
                <span className="media-upload-menu-text">
                  <span className="media-upload-menu-label">Open media library</span>
                  <span className="media-upload-menu-hint">Browse imported files.</span>
                </span>
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
