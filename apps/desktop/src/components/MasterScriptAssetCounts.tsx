import type { ForgeProjectData } from "../types";
import type { SectionId } from "../types";

type CountKey = "characters" | "locations" | "props" | "keyframes" | "audio";

const ENTRIES: Array<[CountKey, string]> = [
  ["characters", "Characters"],
  ["locations", "Locations"],
  ["props", "Props"],
  ["keyframes", "Keyframes"],
  ["audio", "Audio"],
];

// Replaces the LinkedAssetRail on the Master Script row with a compact
// counts-only strip — at that zoom level thumbnails are noise; the
// writer just wants to know "how many characters/locations/props do I
// have" and jump to the panel.
export function MasterScriptAssetCounts({
  project,
  onOpen,
}: {
  project: ForgeProjectData | null;
  onOpen: (section: SectionId) => void;
}) {
  const counts: Record<CountKey, number> = {
    characters: project?.characters?.length || 0,
    locations: project?.locations?.length || 0,
    props: project?.props?.length || 0,
    keyframes: project?.keyframes?.length || 0,
    audio: project?.audio?.length || 0,
  };

  return (
    <div className="master-script-asset-counts">
      {ENTRIES.map(([key, label]) => (
        <button
          key={key}
          type="button"
          className="master-script-asset-count"
          onClick={() => onOpen(key)}
          title={`Open ${label}`}
        >
          <span className="master-script-asset-count-label">{label}</span>
          <span className="master-script-asset-count-value">{counts[key]}</span>
        </button>
      ))}
    </div>
  );
}
