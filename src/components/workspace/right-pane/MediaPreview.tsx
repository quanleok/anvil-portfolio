"use client";

import { useState } from "react";
import { useWorkspace } from "../WorkspaceProvider";

// Right-pane preview for the selected media row. Shared between
// Assets and Workshop sections. Renders the same shape as the
// doc-editor right pane (header strip + body) so the four sections
// look consistent.

function formatBytes(size: number) {
  if (!size) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function MediaPreview({ allowAudio = true }: { allowAudio?: boolean }) {
  const { selectedMedia, mediaReady, mediaPreviewUrl, mediaBusy } = useWorkspace();
  const [brokenMedia, setBrokenMedia] = useState<{ id: string; url: string } | null>(null);

  if (!selectedMedia) {
    return (
      <>
        <header>
          <div>
            <h2>No selection</h2>
            <p>Pick a media file from the rail, or drop one in.</p>
          </div>
          <div>
            <span>{mediaBusy ? "Uploading…" : "Ready"}</span>
          </div>
        </header>
        <div className="anvil-workspace-preview-body">
          <div className="anvil-workspace-preview-empty">
            <strong>No media selected</strong>
            <p>Pick a file from the rail, or upload one.</p>
          </div>
        </div>
      </>
    );
  }

  const metaParts = [
    selectedMedia.kind,
    formatBytes(selectedMedia.byteSize),
  ].filter(Boolean);
  const mediaUnavailable = brokenMedia?.id === selectedMedia.id && brokenMedia.url === mediaPreviewUrl;
  const mediaRenderable = mediaReady && !mediaUnavailable && Boolean(mediaPreviewUrl);
  const handleMediaError = () => setBrokenMedia({ id: selectedMedia.id, url: mediaPreviewUrl });

  return (
    <>
      <header>
        <div>
          <h2>{selectedMedia.fileName}</h2>
          <p>{metaParts.join(" · ")}</p>
        </div>
        <div>
          <span>{selectedMedia.status}</span>
        </div>
      </header>
      <div className="anvil-workspace-preview-body">
        {mediaRenderable && selectedMedia.kind === "image" ? (
          <div className="anvil-workspace-preview-stage">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={mediaPreviewUrl} alt={selectedMedia.fileName} onError={handleMediaError} />
          </div>
        ) : null}
        {mediaRenderable && selectedMedia.kind === "video" ? (
          <div className="anvil-workspace-preview-stage">
            <video src={mediaPreviewUrl} controls playsInline onError={handleMediaError} />
          </div>
        ) : null}
        {mediaRenderable && allowAudio && selectedMedia.kind === "audio" ? (
          <div className="anvil-workspace-preview-stage anvil-workspace-preview-stage--audio">
            <audio src={mediaPreviewUrl} controls onError={handleMediaError} />
          </div>
        ) : null}
        {!mediaRenderable || (selectedMedia.kind === "other") || (!allowAudio && selectedMedia.kind === "audio") ? (
          <div className="anvil-workspace-preview-empty">
            <strong>{selectedMedia.fileName}</strong>
            <p>Status: {mediaUnavailable ? "media unavailable" : selectedMedia.status}</p>
          </div>
        ) : null}
      </div>
    </>
  );
}
