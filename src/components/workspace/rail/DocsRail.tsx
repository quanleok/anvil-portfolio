"use client";

import { memo } from "react";

import { PlusIcon } from "../lib/icons";
import { useWorkspace } from "../WorkspaceProvider";
import { cardSectionForCategory, RailFileTree } from "./RailFileTree";

// Secondary panel next to the IconRail — section title + subtitle,
// +New button on the right, and the file/media tree below. Mirrors
// the desktop app's docs-panel layout (apps/desktop/src/App.tsx
// "Context · Project · script · assets · agent" header).
//
// Hidden <input type="file"> is anchored here (rather than in the
// section workspaces, which are preview-only now) so the +New
// button can trigger a media upload for Assets/Workshop sections
// without re-mounting on section switches.

function sectionTitle(section: string) {
  if (section === "story") return "Context";
  if (section === "script") return "Script";
  if (section === "assets") return "Assets";
  if (section === "workshop") return "Workshop";
  return "Workspace";
}

function sectionSubtitle(section: string) {
  if (section === "story") return "Project · Canon · Asset";
  if (section === "script") return "Master · Scenes · Prompts";
  if (section === "assets") return "Characters · Locations · Props · Keyframes · Audio · Video";
  if (section === "workshop") return "Bin · Timeline";
  return "";
}

function cardSectionLabel(section: string) {
  if (section === "characters") return "character";
  if (section === "locations") return "location";
  if (section === "props") return "prop";
  if (section === "keyframes") return "keyframe";
  if (section === "audio") return "audio";
  if (section === "videos") return "video";
  return "asset";
}

export const DocsRail = memo(function DocsRail() {
  const {
    activeSection,
    activeScriptChild,
    activeCategory,
    activeAssetCategory,
    createFile,
    fileInputRef,
    uploadMedia,
    createProjectAsset,
    mediaBusy,
    mediaStatus,
    mediaProgress,
    user,
  } = useWorkspace();

  // On Assets section, the rail-head "+" is context-aware:
  //   typed category (Character / Location / Prop / Keyframe / Audio)
  //     → create a new card of that section
  //   "all" → open the file picker so the user can upload
  // Workshop stays upload-only. Script + Context unchanged.
  const cardSection = cardSectionForCategory(activeAssetCategory);
  const newButtonLabel = (() => {
    if (activeSection === "script") {
      return activeScriptChild === "prompts" ? "New prompt" : "New scene";
    }
    if (activeSection === "story") return "New context doc";
    if (activeSection === "workshop") return "Upload media";
    if (activeSection === "assets") {
      if (cardSection) return `Add ${cardSectionLabel(cardSection)} card`;
      return "Upload media";
    }
    return "New";
  })();

  const handleNew = () => {
    if (activeSection === "script") {
      void createFile(activeScriptChild === "prompts" ? "prompts" : "scenes");
      return;
    }
    if (activeSection === "story") {
      void createFile("custom");
      return;
    }
    if (activeSection === "workshop") {
      fileInputRef.current?.click();
      return;
    }
    if (activeSection === "assets") {
      if (cardSection) {
        void createProjectAsset(cardSection);
        return;
      }
      fileInputRef.current?.click();
      return;
    }
    void createFile("custom");
  };

  const acceptForSection =
    activeSection === "workshop"
      ? "video/*,audio/*"
      : activeSection === "assets"
        ? activeCategory.accept
        : null;

  // Surface upload status in the head — without this the +New button
  // on Workshop/Assets felt like it "didn't work" because every
  // visible cue (file picker, upload, rail refresh) happened off-
  // screen or silently. Any non-empty status that's not the default
  // "No media yet." takes over the subtitle so server errors,
  // upload-progress, and "Uploaded." all surface uniformly — earlier
  // the allowlist missed custom server error strings like
  // "Storage limit exceeded" or "Authentication failed".
  const showMediaStatus =
    (activeSection === "workshop" || activeSection === "assets") &&
    (mediaBusy ||
      (mediaStatus !== "" &&
        mediaStatus !== "No media yet." &&
        !/^\d+ media files?$/.test(mediaStatus)));
  // While the PUT is in flight, swap the static "Uploading..." string
  // for a live percentage so the user has feedback during long
  // uploads (50GB video). Improvement-plan 4.6.
  const liveMediaStatus =
    mediaBusy && mediaProgress !== null && mediaStatus.startsWith("Uploading")
      ? `Uploading… ${Math.round(mediaProgress * 100)}%`
      : mediaStatus;
  const headSubtitle = showMediaStatus ? liveMediaStatus : sectionSubtitle(activeSection);

  return (
    <aside className="anvil-workspace-docsrail" aria-label={sectionTitle(activeSection)}>
      <header className="anvil-workspace-docsrail-head">
        <div>
          <h2>{sectionTitle(activeSection)}</h2>
          <p
            className={mediaBusy ? "is-busy" : showMediaStatus ? "is-status" : undefined}
            aria-live={showMediaStatus ? "polite" : undefined}
          >
            {headSubtitle}
          </p>
        </div>
        <button
          type="button"
          onClick={handleNew}
          disabled={mediaBusy}
          title={newButtonLabel}
          aria-label={newButtonLabel}
          aria-busy={mediaBusy || undefined}
        >
          <PlusIcon size={14} />
        </button>
      </header>
      <div className="anvil-workspace-docsrail-body">
        {user.id === "dev-user" ? (
          <div className="anvil-workspace-session-warning" role="status">
            Local preview. Sign in to keep work.
          </div>
        ) : null}
        <RailFileTree />
      </div>
      {acceptForSection ? (
        <input
          ref={fileInputRef}
          type="file"
          hidden
          accept={acceptForSection}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.currentTarget.value = "";
            if (file) void uploadMedia(file);
          }}
        />
      ) : null}
    </aside>
  );
});
