"use client";

import { memo, useEffect, useRef, useState } from "react";

import { ConfirmingDeleteButton } from "../../lib/ConfirmingDeleteButton";
import { useWorkspace } from "../../WorkspaceProvider";
import type { AssetCard, MediaAsset } from "../../types";

// Card-detail surface for the Assets right pane. Per quan: image
// preview only — no notes textarea, no timestamps. Just the card
// name (inline-editable), section label, an image placeholder for
// future media binding, and Delete. Name persists on blur via
// PATCH /api/projects/[id]/assets/[id].

export type AssetCardPreviewProps = {
  card: AssetCard;
};

function sectionLabel(section: string) {
  if (section === "characters") return "Character";
  if (section === "locations") return "Location";
  if (section === "props") return "Prop";
  if (section === "keyframes") return "Keyframe";
  if (section === "audio") return "Audio";
  if (section === "videos") return "Video";
  return section;
}

// Pulls the bound-media id off the card's metadata, if any. The
// metadata bag is unknown-shaped, so a defensive read.
function boundMediaIdFor(card: AssetCard): string | null {
  const id = (card.metadata as Record<string, unknown> | undefined)?.mediaAssetId;
  return typeof id === "string" && id ? id : null;
}

function boundMediaKindFor(card: AssetCard): "image" | "audio" | "video" | null {
  const kind = (card.metadata as Record<string, unknown> | undefined)?.mediaKind;
  if (kind === "image" || kind === "audio" || kind === "video") return kind;
  return null;
}

function newestLinkedMedia(card: AssetCard, mediaAssets: MediaAsset[]) {
  const linked = mediaAssets
    .filter((media) => media.assetId === card.assetId)
    .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
  return linked[0] || null;
}

// Default accept string for the upload button — narrow per section
// so the file picker filters correctly. Audio cards accept audio
// only; everything else (character / location / prop / keyframe)
// is image-first, but allow video too for keyframe/location since
// those can be reference clips.
function acceptForSection(section: string): string {
  if (section === "audio") return "audio/*";
  if (section === "videos") return "video/*";
  if (section === "keyframes" || section === "locations") return "image/*,video/*";
  return "image/*";
}

export const AssetCardPreview = memo(function AssetCardPreview({ card }: AssetCardPreviewProps) {
  const {
    projectId,
    deleteProjectAsset,
    loadProjectAssets,
    mediaAssets,
    setSelectedAssetId,
    uploadMediaForCard,
    mediaBusy,
    mediaProgress,
  } = useWorkspace();
  const [name, setName] = useState(card.name);
  const [busy, setBusy] = useState(false);
  const [brokenBoundMediaId, setBrokenBoundMediaId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Reset local state when the selected card changes. The Delete
  // button manages its own armed-state + timer via ConfirmingDeleteButton.
  useEffect(() => {
    setName(card.name);
    setBrokenBoundMediaId(null);
  }, [card.assetId, card.name]);

  async function persist(patch: { name?: string }) {
    setBusy(true);
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(card.assetId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        },
      );
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        console.warn("[AssetCardPreview] card update failed", data?.message || response.status);
        return;
      }
      await loadProjectAssets();
    } catch {
      console.warn("[AssetCardPreview] card update failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleNameBlur() {
    const trimmed = name.trim();
    if (!trimmed) {
      setName(card.name);
      return;
    }
    if (trimmed === card.name) return;
    await persist({ name: trimmed });
  }

  async function handleConfirmedDelete() {
    await deleteProjectAsset(card.assetId);
    setSelectedAssetId(null);
  }

  const label = sectionLabel(card.section);
  const linkedMedia = newestLinkedMedia(card, mediaAssets);
  const boundMediaId = linkedMedia?.id || boundMediaIdFor(card);
  const boundMediaKind =
    linkedMedia?.kind === "image" || linkedMedia?.kind === "audio" || linkedMedia?.kind === "video"
      ? linkedMedia.kind
      : boundMediaKindFor(card) || (card.section === "audio" ? "audio" : card.section === "videos" ? "video" : "image");
  const boundMediaUrl =
    boundMediaId && brokenBoundMediaId !== boundMediaId
      ? `/api/media/${encodeURIComponent(boundMediaId)}/download`
      : null;
  const mediaUnavailable = Boolean(boundMediaId && brokenBoundMediaId === boundMediaId);
  const accept = acceptForSection(card.section);
  const handleBoundMediaError = () => {
    if (boundMediaId) setBrokenBoundMediaId(boundMediaId);
  };

  useEffect(() => {
    setBrokenBoundMediaId(null);
  }, [boundMediaId]);

  function handleUploadClick() {
    fileInputRef.current?.click();
  }
  async function handleFilePicked(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (event.target) event.target.value = "";
    if (!file) return;
    await uploadMediaForCard(file, card.assetId);
  }

  // Per-section preview shape:
  //   bound media exists → render the actual <img>/<audio>/<video>
  //                        from /api/media/<id>/download
  //   no bound media     → dashed placeholder with an inline
  //                        "Upload" button (no more chat-composer
  //                        detour for binding media to a card)
  let mediaPlaceholder;
  if (boundMediaUrl && boundMediaKind === "image") {
    mediaPlaceholder = (
      <div className="anvil-workspace-asset-card-preview anvil-workspace-asset-card-preview--bound" aria-label={`${label} image`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={boundMediaUrl} alt={name || label} onError={handleBoundMediaError} />
      </div>
    );
  } else if (boundMediaUrl && boundMediaKind === "audio") {
    mediaPlaceholder = (
      <div className="anvil-workspace-asset-card-preview anvil-workspace-asset-card-preview--audio anvil-workspace-asset-card-preview--bound" aria-label={`${label} audio`}>
        <audio src={boundMediaUrl} controls aria-label={`${name || "audio"} player`} onError={handleBoundMediaError} />
      </div>
    );
  } else if (boundMediaUrl && boundMediaKind === "video") {
    mediaPlaceholder = (
      <div className="anvil-workspace-asset-card-preview anvil-workspace-asset-card-preview--video anvil-workspace-asset-card-preview--bound" aria-label={`${label} video`}>
        <video src={boundMediaUrl} controls playsInline aria-label={`${name || "video"} player`} onError={handleBoundMediaError} />
      </div>
    );
  } else if (card.section === "audio") {
    mediaPlaceholder = (
      <div className="anvil-workspace-asset-card-preview anvil-workspace-asset-card-preview--audio" aria-label="Audio placeholder">
        <span>{mediaUnavailable ? "Audio unavailable" : "No audio attached yet"}</span>
        <small>Click Upload to attach an audio file, or drop one in the chat composer.</small>
      </div>
    );
  } else if (card.section === "videos") {
    mediaPlaceholder = (
      <div className="anvil-workspace-asset-card-preview anvil-workspace-asset-card-preview--video" aria-label="Video placeholder">
        <span>{mediaUnavailable ? "Video unavailable" : "No video attached yet"}</span>
        <small>Click Upload to attach a video file, or drop one in the chat composer.</small>
      </div>
    );
  } else {
    mediaPlaceholder = (
      <div className="anvil-workspace-asset-card-preview" aria-label={`${label} placeholder`}>
        <span>{mediaUnavailable ? "Media unavailable" : "No media attached yet"}</span>
        <small>Click Upload to attach a file, or drop one in the chat composer.</small>
      </div>
    );
  }

  return (
    <>
      <header>
        <div>
          <input
            type="text"
            className="anvil-workspace-asset-card-title"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={handleNameBlur}
            spellCheck={false}
            placeholder="Card name"
          />
          <p>
            {label}
            {card.folder ? <> · {card.folder}</> : null}
          </p>
        </div>
        <div>
          {mediaBusy ? (
            <span
              className="anvil-workspace-asset-card-progress"
              role="status"
              aria-live="polite"
              title={mediaProgress !== null ? `${Math.round(mediaProgress * 100)}% uploaded` : "Uploading…"}
            >
              {mediaProgress !== null ? `${Math.round(mediaProgress * 100)}%` : "Uploading…"}
            </span>
          ) : null}
          <button
            type="button"
            onClick={handleUploadClick}
            disabled={busy || mediaBusy}
            title={boundMediaId ? "Replace media" : "Upload media"}
          >
            {boundMediaId ? "Replace" : "Upload"}
          </button>
          <ConfirmingDeleteButton
            onConfirm={handleConfirmedDelete}
            label="Delete"
            armedLabel="Confirm?"
            hint="Delete card"
            armedHint="Click again to delete"
            disabled={busy || mediaBusy}
          />
        </div>
      </header>
      <input
        ref={fileInputRef}
        type="file"
        accept={accept}
        onChange={(event) => void handleFilePicked(event)}
        style={{ display: "none" }}
        tabIndex={-1}
      />
      <div className="anvil-workspace-preview-body">{mediaPlaceholder}</div>
    </>
  );
});
