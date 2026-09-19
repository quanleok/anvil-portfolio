"use client";

import { useWorkspace } from "../../WorkspaceProvider";
import { EmptySectionState } from "../EmptySectionState";
import { MediaPreview } from "../MediaPreview";

// Workshop (Video) section right pane — preview-only. Video / audio
// list lives in the docs rail; this pane plays back the selection.
//
// Empty-state CTA when the project has no video/audio media yet
// (improvement-plan §4.4).

export function WorkshopWorkspace() {
  const { mediaAssets, project } = useWorkspace();
  const hasMedia = mediaAssets.some((asset) => asset.kind === "video" || asset.kind === "audio");
  const isEmpty = project !== null && !hasMedia;
  return (
    <section className="anvil-workspace-section anvil-workspace-section--workshop">
      {isEmpty ? <EmptySectionState section="workshop" /> : <MediaPreview />}
    </section>
  );
}
