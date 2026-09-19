"use client";

import { useWorkspace } from "../../WorkspaceProvider";
import { EmptySectionState } from "../EmptySectionState";
import { MediaPreview } from "../MediaPreview";
import { AssetCardPreview } from "./AssetCardPreview";

// Assets section right pane. Renders either:
//   - The selected asset card's detail when selectedAssetId points
//     at a known card.
//   - The empty-state CTA when there are no cards AND no media in
//     the project (first-time experience).
//   - The flat media preview otherwise.
//
// The docs rail handles uploads + card selection; this pane is
// preview/edit-only.

export function AssetsWorkspace() {
  const { projectAssets, mediaAssets, selectedAssetId, project } = useWorkspace();
  const selectedCard = selectedAssetId
    ? projectAssets.find((card) => card.assetId === selectedAssetId) || null
    : null;
  // Empty only after the project has loaded — avoid flashing the
  // empty state during the initial fetch.
  const isEmpty =
    project !== null && projectAssets.length === 0 && mediaAssets.length === 0;

  return (
    <section className="anvil-workspace-section anvil-workspace-section--assets">
      {selectedCard ? (
        <AssetCardPreview card={selectedCard} />
      ) : isEmpty ? (
        <EmptySectionState section="assets" />
      ) : (
        <MediaPreview />
      )}
    </section>
  );
}
