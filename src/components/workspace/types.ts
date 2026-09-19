// Shared workspace types. Lifted out of BrowserProjectWorkspace.tsx in
// commit 3 of the three-column layout pivot so the rail / right-pane
// children can import without bouncing through the monolith.

export type CloudFile = {
  path: string;
  title: string;
  kind: string;
  content: string;
  /** Optional grouping for context docs. Mirrors desktop's
   *  StoryEntry.contextGroup ("project" | "canon" | "asset" | <slug>).
   *  Absent or null = not a context doc. */
  contextGroup?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CloudProject = {
  id: string;
  name: string;
  icon: string;
  fileCount: number;
  updatedAt: string;
  project: {
    files: Record<string, CloudFile>;
  };
};

export type MediaAsset = {
  id: string;
  /** Nullable server-side relation to an asset card. Present on
   *  rows returned by the media APIs once a media item is attached
   *  through /projects/[id]/assets/[assetId]/media. */
  assetId?: string | null;
  kind: "image" | "video" | "audio" | "other";
  status: string;
  fileName: string;
  contentType: string;
  byteSize: number;
  metadata?: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
};

export type AssetCategory = {
  id: string;
  label: string;
  icon: string;
  accept: string;
  kinds?: MediaAsset["kind"][];
};

export type FileTreeGroup = {
  id: string;
  label: string;
  files: CloudFile[];
};

/** Phase B: Script sub-rail child id. Mirrors desktop's
 *  SCRIPT_CHILD_SECTIONS plus the implicit "master" landing view. */
export type ScriptChild = "master" | "dialogue" | "prompts";

export function isScriptChild(value: unknown): value is ScriptChild {
  return value === "master" || value === "dialogue" || value === "prompts";
}

/** Phase D, slice D4: asset card on the browser side. Mirrors the
 *  server-side BrowserProjectAsset shape returned by
 *  /api/projects/[id]/assets. Each card is an entity in one of the
 *  typed asset sections (characters/locations/props/keyframes/audio
 *  /videos); media variants attach to it via /assets/[id]/media. */
export type AssetCardSection = "characters" | "locations" | "props" | "keyframes" | "audio" | "videos";

export type AssetCard = {
  assetId: string;
  section: AssetCardSection;
  name: string;
  folder: string | null;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export function isAssetCardSection(value: unknown): value is AssetCardSection {
  return (
    value === "characters" ||
    value === "locations" ||
    value === "props" ||
    value === "keyframes" ||
    value === "audio" ||
    value === "videos"
  );
}
