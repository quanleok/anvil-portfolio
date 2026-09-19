"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";

import { ASSET_CATEGORIES } from "../constants";
import { buildScriptTree } from "../lib/buildScriptTree";
import { PlusIcon } from "../lib/icons";
import { type AssetCard, type AssetCardSection, type MediaAsset } from "../types";
import { useWorkspace } from "../WorkspaceProvider";

// Map between the rail's activeAssetCategory (singular: "character",
// "location"…) and the server's AssetCardSection (plural). "all"
// stays an aggregate view; typed lanes are card-capable.
export function cardSectionForCategory(category: string): AssetCardSection | null {
  if (category === "character") return "characters";
  if (category === "location") return "locations";
  if (category === "prop") return "props";
  if (category === "keyframe") return "keyframes";
  if (category === "audio") return "audio";
  if (category === "video") return "videos";
  return null;
}

function categoryForCardSection(section: AssetCardSection) {
  if (section === "characters") return "character";
  if (section === "locations") return "location";
  if (section === "props") return "prop";
  if (section === "keyframes") return "keyframe";
  if (section === "audio") return "audio";
  return "video";
}

function cardSectionNoun(section: AssetCardSection) {
  if (section === "characters") return "character";
  if (section === "locations") return "location";
  if (section === "props") return "prop";
  if (section === "keyframes") return "keyframe";
  if (section === "audio") return "audio";
  return "video";
}

function categoryIcon(categoryId: string) {
  return ASSET_CATEGORIES.find((category) => category.id === categoryId)?.icon || "/anvil-ui/media-archive.webp";
}

function mediaPreviewUrl(mediaId: string | null | undefined) {
  return mediaId ? `/api/media/${encodeURIComponent(mediaId)}/download` : "";
}

function newestLinkedMedia(card: AssetCard, mediaAssets: MediaAsset[]) {
  const linked = mediaAssets
    .filter((media) => media.assetId === card.assetId)
    .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
  return linked[0] || null;
}

function cardBoundMedia(card: AssetCard, mediaAssets: MediaAsset[]) {
  const linked = newestLinkedMedia(card, mediaAssets);
  const metadata = card.metadata || {};
  const metadataKind = metadata.mediaKind;
  const kind =
    linked?.kind === "image" || linked?.kind === "video" || linked?.kind === "audio"
      ? linked.kind
      : metadataKind === "image" || metadataKind === "video" || metadataKind === "audio"
        ? metadataKind
        : null;
  const id = linked?.id || (typeof metadata.mediaAssetId === "string" ? metadata.mediaAssetId : "");
  return { id, kind };
}

// Docs picker in the left rail. The user picks the file here; the
// right pane shows the preview/editor. Renders one of three modes
// based on activeSection:
//   - story    → grouped context-docs tree (Project / Canon / Asset)
//   - script   → master → scenes → prompts hierarchy
//   - assets   → card list plus flat media variants
//   - workshop → flat video/audio list

// Display labels: strip the leading NN-prefix and `.md` extension so
// the user sees "Scene" / "Prompt" / "Foundry" rather than
// "01 Scene" / "01-prompt.md". Sort order still uses the prefix —
// only the visible string changes. Improvement-plan §3.7.
const NN_PREFIX = /^(\d{1,4})[\s\-_]+/;
const MD_SUFFIX = /\.md$/i;
function displayLabel(raw: string | undefined | null, fallback: string): string {
  const source = (raw && raw.trim()) || fallback;
  const cleaned = source.replace(MD_SUFFIX, "").replace(NN_PREFIX, "").trim();
  return cleaned || source;
}

export const RailFileTree = memo(function RailFileTree() {
  const {
    activeSection,
    fileTreeGroups,
    selectedPath,
    selectFile,
    files,
    activeScriptChild,
    activeAssetCategory,
    setActiveAssetCategory,
    filteredMediaAssets,
    selectedMedia,
    setSelectedMediaId,
    mediaAssets,
    createPromptForScene,
    createFile,
    touchedPaths,
    agentBusy,
    projectId,
    projectAssets,
    createProjectAsset,
    deleteProjectAsset,
    loadProjectAssets,
    selectedAssetId,
    setSelectedAssetId,
  } = useWorkspace();

  const scriptTree = useMemo(() => buildScriptTree(files), [files]);

  // Inline-confirm pattern for the × buttons on card rows. First click
  // arms the button (red, glyph flips to "?"); second click within
  // 2.5s actually deletes. Replaces the jarring window.confirm() that
  // froze the page on every delete.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    };
  }, []);
  const requestDelete = (assetId: string) => {
    if (confirmDeleteId === assetId) {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
      setConfirmDeleteId(null);
      void deleteProjectAsset(assetId);
      return;
    }
    setConfirmDeleteId(assetId);
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    confirmTimerRef.current = setTimeout(() => setConfirmDeleteId(null), 2500);
  };

  // Inline rename for asset card rows. Pattern: click a row that's
  // already selected (or double-click any row) to swap the title
  // into an editable input. Enter / blur commits via PATCH to the
  // card route; Esc cancels. Mirrors Finder / VS Code rename UX so
  // the user doesn't have to drift to the right-pane card preview
  // to retitle a card.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  // Debounces commitRename — blur + Enter can fire back-to-back
  // and we don't want two PATCHes in flight or a retry-after-success
  // loop while we're still resolving the first call.
  const renameInFlightRef = useRef(false);
  useEffect(() => {
    if (!renamingId) return;
    const el = renameInputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [renamingId]);

  const beginRename = (assetId: string, currentName: string) => {
    setRenamingId(assetId);
    setRenameDraft(currentName);
    setRenameError(null);
  };
  const cancelRename = () => {
    setRenamingId(null);
    setRenameDraft("");
    setRenameError(null);
  };
  const commitRename = async (assetId: string, originalName: string) => {
    if (renameInFlightRef.current) return;
    const trimmed = renameDraft.trim();
    // No-op exits clear state immediately — nothing to persist.
    if (!trimmed || trimmed === originalName) {
      setRenamingId(null);
      setRenameDraft("");
      setRenameError(null);
      return;
    }
    renameInFlightRef.current = true;
    setRenameError(null);
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: trimmed }),
        },
      );
      if (response.ok) {
        setRenamingId(null);
        setRenameDraft("");
        setRenameError(null);
        await loadProjectAssets();
        return;
      }
      // Server said no. Keep rename mode open so the user sees their
      // typed value + a red outline + tooltip; they can Esc to cancel
      // or retry. Previous behavior swallowed the error silently and
      // reverted the rail to the server name with zero feedback.
      const data = await response.json().catch(() => ({} as Record<string, unknown>));
      const message = typeof data?.message === "string" ? data.message : `Rename failed (${response.status})`;
      console.warn("[rename] PATCH not ok", { status: response.status, body: data, assetId });
      setRenameError(message);
    } catch (err) {
      console.warn("[rename] PATCH threw", err);
      setRenameError("Rename failed (network)");
    } finally {
      renameInFlightRef.current = false;
    }
  };

  // Click handler for card rows: first click selects; a second click
  // on the same already-selected row enters rename mode (Finder-style).
  const handleCardClick = (assetId: string, currentName: string) => {
    if (assetId === selectedAssetId) {
      beginRename(assetId, currentName);
      return;
    }
    setSelectedAssetId(assetId);
  };

  const renderCardThumbnail = (card: AssetCard, showSection = false) => {
    const categoryId = categoryForCardSection(card.section);
    const media = cardBoundMedia(card, mediaAssets);
    const previewUrl = mediaPreviewUrl(media.id);
    const selected = card.assetId === selectedAssetId;
    const label = card.name || "Untitled";
    return (
      <div key={card.assetId} className="anvil-workspace-asset-thumb-wrap">
        <button
          type="button"
          className={`anvil-workspace-asset-thumb${selected ? " is-selected" : ""}`}
          onClick={() => handleCardClick(card.assetId, card.name)}
          onDoubleClick={() => beginRename(card.assetId, card.name)}
          title={selected ? `Click to rename · ${label}` : label}
        >
          <span className="anvil-workspace-asset-thumb-preview" aria-hidden>
            {previewUrl && media.kind === "image" ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={previewUrl} alt="" />
            ) : previewUrl && media.kind === "video" ? (
              <video src={previewUrl} muted playsInline preload="metadata" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="is-icon" src={categoryIcon(categoryId)} alt="" />
            )}
          </span>
          <span className="anvil-workspace-asset-thumb-title">{label}</span>
          {showSection ? <span className="anvil-workspace-asset-thumb-meta">{categoryId}</span> : null}
        </button>
        {renamingId === card.assetId ? (
          <input
            ref={renameInputRef}
            type="text"
            className={`anvil-workspace-asset-thumb-rename${renameError ? " has-error" : ""}`}
            value={renameDraft}
            onChange={(e) => {
              setRenameDraft(e.target.value);
              if (renameError) setRenameError(null);
            }}
            onBlur={() => void commitRename(card.assetId, card.name)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commitRename(card.assetId, card.name);
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelRename();
              }
            }}
            spellCheck={false}
            aria-label={`Rename ${label}`}
            aria-invalid={renameError ? true : undefined}
            title={renameError || `Rename ${label}`}
          />
        ) : null}
        <button
          type="button"
          className={`anvil-workspace-asset-thumb-delete${confirmDeleteId === card.assetId ? " is-armed" : ""}`}
          onClick={() => requestDelete(card.assetId)}
          title={confirmDeleteId === card.assetId ? `Tap again to delete ${label}` : `Delete ${label}`}
          aria-label={confirmDeleteId === card.assetId ? `Confirm delete ${label}` : `Delete ${label}`}
        >
          {confirmDeleteId === card.assetId ? "?" : "×"}
        </button>
      </div>
    );
  };

  const renderMediaThumbnail = (asset: MediaAsset) => {
    const selected = asset.id === selectedMedia?.id;
    const category = typeof asset.metadata?.category === "string" ? asset.metadata.category : asset.kind;
    const ready = asset.status === "uploaded" || asset.status === "ready";
    const previewUrl = ready ? mediaPreviewUrl(asset.id) : "";
    return (
      <button
        key={asset.id}
        type="button"
        className={`anvil-workspace-media-thumb${selected ? " is-selected" : ""}`}
        onClick={() => {
          setSelectedAssetId(null);
          setSelectedMediaId(asset.id);
        }}
        title={asset.fileName}
      >
        <span className="anvil-workspace-media-thumb-preview" aria-hidden>
          {previewUrl && asset.kind === "image" ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={previewUrl} alt="" />
          ) : previewUrl && asset.kind === "video" ? (
            <video src={previewUrl} muted playsInline preload="metadata" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="is-icon" src={categoryIcon(category)} alt="" />
          )}
        </span>
        <span className="anvil-workspace-media-thumb-title">{asset.fileName}</span>
      </button>
    );
  };

  // Helper for the touched-path pulse + the in-flight working state.
  // - is-touched: 1.5s flash that fires when the agent finishes a turn
  //   that wrote to this row's path (touchedPaths set).
  // - is-working: outline pulse on the currently-selected row while
  //   agentBusy is true, so the user sees which file is in scope as
  //   the agent runs.
  const rowClass = (path: string, base: string, isSelected: boolean) => {
    const tokens = [base];
    if (isSelected) tokens.push("is-selected");
    if (touchedPaths.has(path)) tokens.push("is-touched");
    if (isSelected && agentBusy) tokens.push("is-working");
    return tokens.join(" ");
  };

  if (activeSection === "assets") {
    const cardSection = cardSectionForCategory(activeAssetCategory);
    const visibleCards = cardSection
      ? projectAssets.filter((card) => card.section === cardSection)
      : activeAssetCategory === "all"
        ? projectAssets
        : [];
    const boundMediaIds = new Set<string>();
    const boundCardIds = new Set<string>();
    for (const card of visibleCards) {
      boundCardIds.add(card.assetId);
      const media = cardBoundMedia(card, mediaAssets);
      if (media.id) boundMediaIds.add(media.id);
    }
    const unassignedMediaAssets = filteredMediaAssets.filter((asset) => {
      if (asset.assetId && boundCardIds.has(asset.assetId)) return false;
      if (boundMediaIds.has(asset.id)) return false;
      return true;
    });
    const cardNoun = cardSection ? cardSectionNoun(cardSection) : "asset";
    return (
      <div className="anvil-workspace-rail-tree" role="tree" aria-label="Assets">
        <nav className="anvil-workspace-rail-category-strip" aria-label="Asset categories">
          {ASSET_CATEGORIES.map((category) => (
            <button
              key={category.id}
              type="button"
              className={category.id === activeAssetCategory ? "is-active" : ""}
              onClick={() => setActiveAssetCategory(category.id)}
              title={category.label}
              aria-label={category.label}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={category.icon} alt="" />
              <span>{category.label}</span>
            </button>
          ))}
        </nav>
        <div className="anvil-workspace-rail-tree-list anvil-workspace-rail-tree-list--assets">
          {cardSection ? (
            <>
              {visibleCards.length ? (
                <section className="anvil-workspace-rail-thumb-section">
                  <div className="anvil-workspace-asset-thumb-grid">
                    {visibleCards.map((card) => renderCardThumbnail(card))}
                  </div>
                </section>
              ) : null}
              {!visibleCards.length ? (
                <button
                  type="button"
                  className="anvil-workspace-rail-row anvil-workspace-rail-row--placeholder"
                  onClick={() => void createProjectAsset(cardSection)}
                  title={`Add ${cardNoun} card`}
                >
                  <PlusIcon size={11} />
                  <strong>Add {cardNoun}</strong>
                </button>
              ) : null}
            </>
          ) : visibleCards.length ? (
            <section className="anvil-workspace-rail-thumb-section">
              <h4>Cards</h4>
              <div className="anvil-workspace-asset-thumb-grid">
                {visibleCards.map((card) => renderCardThumbnail(card, true))}
              </div>
            </section>
          ) : null}
          {unassignedMediaAssets.length ? (
            <section className="anvil-workspace-rail-thumb-section">
              <h4>Unassigned</h4>
              <div className="anvil-workspace-media-thumb-grid">
                {unassignedMediaAssets.map((asset) => renderMediaThumbnail(asset))}
              </div>
            </section>
          ) : null}
          {!visibleCards.length && !unassignedMediaAssets.length && !cardSection ? (
            <p className="anvil-workspace-rail-tree-empty">No assets in this lane.</p>
          ) : null}
        </div>
      </div>
    );
  }

  if (activeSection === "workshop") {
    return (
      <div className="anvil-workspace-rail-tree" role="tree" aria-label="Video bin">
        <div className="anvil-workspace-rail-tree-list">
          {filteredMediaAssets.length ? (
            filteredMediaAssets.map((asset) => (
              <button
                key={asset.id}
                type="button"
                className={`anvil-workspace-rail-row ${asset.id === selectedMedia?.id ? "is-selected" : ""}`}
                onClick={() => setSelectedMediaId(asset.id)}
                title={asset.fileName}
              >
                <strong>{asset.fileName}</strong>
              </button>
            ))
          ) : (
            <p className="anvil-workspace-rail-tree-empty">No video or audio yet.</p>
          )}
        </div>
      </div>
    );
  }

  if (activeSection === "script") {
    return (
      <div className="anvil-workspace-rail-tree" role="tree" aria-label="Script">
        <div className="anvil-workspace-rail-tree-list">
          {scriptTree.master ? (
            <div className="anvil-workspace-rail-scene-head">
              <button
                type="button"
                className={rowClass(scriptTree.master.path, "anvil-workspace-rail-row", scriptTree.master.path === selectedPath)}
                onClick={() => selectFile(scriptTree.master!.path)}
                title={scriptTree.master.path}
              >
                <strong>{displayLabel(scriptTree.master.title, "Master script")}</strong>
              </button>
              <button
                type="button"
                className="anvil-workspace-rail-scene-add"
                onClick={() => void createFile("scenes")}
                title="Add a new scene"
                aria-label="Add a new scene"
              >
                <PlusIcon size={11} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="anvil-workspace-rail-row anvil-workspace-rail-row--placeholder"
              onClick={() => void createFile("master-script")}
              title="Create script/master-script.md"
            >
              <PlusIcon size={11} />
              <strong>Master script</strong>
            </button>
          )}
          {scriptTree.scenes.map((scene) => (
            <div key={scene.sceneFile.path} className="anvil-workspace-rail-scene">
              <div className="anvil-workspace-rail-scene-head">
                <button
                  type="button"
                  className={rowClass(scene.sceneFile.path, "anvil-workspace-rail-row anvil-workspace-rail-row--scene", scene.sceneFile.path === selectedPath)}
                  onClick={() => selectFile(scene.sceneFile.path)}
                  title={scene.sceneFile.path}
                >
                  <strong>{displayLabel(scene.sceneFile.title, scene.stem)}</strong>
                  {scene.durationSec ? (
                    <span>{Math.round(scene.durationSec)}s</span>
                  ) : null}
                  {scene.collidingPaths && scene.collidingPaths.length ? (
                    <span
                      className="anvil-workspace-rail-row-warn"
                      role="img"
                      aria-label={`Name collides with ${scene.collidingPaths.join(", ")} — rename to differentiate`}
                      title={`Name collides (case-insensitive) with: ${scene.collidingPaths.join(", ")}\nRename one to differentiate — prompts will route to whichever scene was added last.`}
                    >
                      ⚠
                    </span>
                  ) : null}
                </button>
                <button
                  type="button"
                  className="anvil-workspace-rail-scene-add"
                  onClick={() => void createPromptForScene(scene.stem)}
                  title={`Add prompt under ${scene.stem}`}
                  aria-label={`Add prompt under ${scene.stem}`}
                >
                  <PlusIcon size={11} />
                </button>
              </div>
              {scene.prompts.map((prompt) => (
                <button
                  key={prompt.promptFile.path}
                  type="button"
                  className={rowClass(prompt.promptFile.path, "anvil-workspace-rail-row anvil-workspace-rail-row--prompt", prompt.promptFile.path === selectedPath)}
                  onClick={() => selectFile(prompt.promptFile.path)}
                  title={prompt.promptFile.path}
                >
                  <span className="anvil-workspace-rail-row-dot" aria-hidden />
                  <strong>{displayLabel(prompt.promptFile.title, prompt.promptFile.path.split("/").pop() || "Prompt")}</strong>
                  {prompt.durationSec ? <span>{Math.round(prompt.durationSec)}s</span> : null}
                </button>
              ))}
            </div>
          ))}
          {scriptTree.orphanPrompts.length ? (
            <section className="anvil-workspace-rail-orphans">
              <h4>Unlinked</h4>
              {scriptTree.orphanPrompts.map((prompt) => (
                <button
                  key={prompt.path}
                  type="button"
                  className={rowClass(prompt.path, "anvil-workspace-rail-row anvil-workspace-rail-row--prompt", prompt.path === selectedPath)}
                  onClick={() => selectFile(prompt.path)}
                  title={prompt.path}
                >
                  <strong>{displayLabel(prompt.title, prompt.path.split("/").pop() || "Prompt")}</strong>
                </button>
              ))}
            </section>
          ) : null}
          {!scriptTree.master && !scriptTree.scenes.length && !scriptTree.orphanPrompts.length && (activeScriptChild !== undefined) ? (
            <p className="anvil-workspace-rail-tree-empty">
              No script yet. Ask Anvil to draft scenes, or use + to add one.
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  // Story (context) — grouped by contextGroup. DocsRail provides the
  // section header + New button; this branch just renders the tree.
  // Missing canonical docs render as dashed-border placeholders so
  // the user can scaffold them in one click (mirrors the Script
  // section's "+ Master script" placeholder pattern).
  const existingPaths = new Set(files.map((file) => file.path));
  const canonicalContextDocs: Array<{ root: string; title: string; path: string }> = [
    { root: "project-scope", title: "Project Scope", path: "story/project-scope.md" },
    { root: "world-bible", title: "World Bible", path: "story/world-bible.md" },
    { root: "asset-context", title: "Asset Context", path: "story/asset-context.md" },
  ];
  const missingCanonical = canonicalContextDocs.filter((doc) => !existingPaths.has(doc.path));

  return (
    <div className="anvil-workspace-rail-tree" role="tree" aria-label="Context docs">
      <div className="anvil-workspace-rail-tree-list">
        {fileTreeGroups.length ? (
          fileTreeGroups.map((group) => (
            <section key={group.id} className="anvil-workspace-rail-group">
              <h4>{group.label}</h4>
              {group.files.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  className={rowClass(file.path, "anvil-workspace-rail-row", file.path === selectedPath)}
                  onClick={() => selectFile(file.path)}
                  title={file.path}
                >
                  <strong>{file.title}</strong>
                </button>
              ))}
            </section>
          ))
        ) : null}
        {missingCanonical.length ? (
          <section className="anvil-workspace-rail-group">
            {fileTreeGroups.length ? <h4>Add canonical</h4> : null}
            {missingCanonical.map((doc) => (
              <button
                key={doc.path}
                type="button"
                className="anvil-workspace-rail-row anvil-workspace-rail-row--placeholder"
                onClick={() => void createFile(doc.root)}
                title={`Create ${doc.path}`}
              >
                <PlusIcon size={11} />
                <strong>{doc.title}</strong>
              </button>
            ))}
          </section>
        ) : null}
        {!fileTreeGroups.length && !missingCanonical.length ? (
          <p className="anvil-workspace-rail-tree-empty">
            No docs yet. Ask Anvil to draft a scope, or use + to add one.
          </p>
        ) : null}
      </div>
    </div>
  );
});
