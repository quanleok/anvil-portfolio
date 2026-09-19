import type {
  AssetEntry,
  DialogueEntry,
  PromptEntry,
  ScriptEntry,
  SectionId,
  StoryEntry,
  VideoEntry,
} from "../types";

// Primary top-level tabs. Video Bin lives under Assets because takes are
// project media; Timeline/Workshop remain edit/output surfaces. Canonical
// section ids stay stable for data + agent tools.
export type PrimarySectionId = "story" | "script" | "assets" | "workshop" | "agent";
export type StoryChildId = "world-bible";
export type AssetSectionId = "media" | "characters" | "locations" | "props" | "keyframes" | "audio";
export type WorkshopSectionId = "workshop" | "videos" | "timeline";
export type SectionEntry = StoryEntry | ScriptEntry | DialogueEntry | PromptEntry | AssetEntry | VideoEntry;
export type AssetMediaEntry = AssetEntry["media"][number];

// Workshop is the lightweight edit/output surface for rough sequencing
// before finishing in a dedicated editor.
export const SHOW_WORKSHOP_SURFACE = true;
export const SHOW_AGENT_SURFACE = false;
export const SHOW_PROJECT_TERMINAL_SURFACE = true;

// Order matters. Hidden primaries remain typed/canonical for archived builds.
export const PRIMARY_SECTIONS: PrimarySectionId[] = [
  "story",
  "script",
  "assets",
  ...(SHOW_WORKSHOP_SURFACE ? (["workshop"] as const) : []),
  ...(SHOW_AGENT_SURFACE ? (["agent"] as const) : []),
];
export const STORY_CHILD_SECTIONS: StoryChildId[] = ["world-bible"];
export const SCRIPT_CHILD_SECTIONS: Array<"dialogue" | "prompts"> = ["dialogue", "prompts"];
export const ASSET_SECTIONS: AssetSectionId[] = ["media", "characters", "locations", "props", "keyframes", "audio"];
// Workshop is a leaf primary — no sub-rail entries. Click → NLE.
export const WORKSHOP_SECTIONS: WorkshopSectionId[] = [];

export const CHAT_COLLAPSE_CHAR_LIMIT = 420;
export const CHAT_COLLAPSE_LINE_LIMIT = 8;

export const PRIMARY_LABELS: Record<PrimarySectionId, string> = {
  story: "Context",
  // User-facing label stays focused on the current MVP: writing and
  // organizing scripts. Canon remains an internal/source-of-truth concept.
  script: "Script",
  assets: "Assets",
  workshop: "Video",
  agent: "Agent",
};

export const ASSET_SECTION_DETAILS: Record<AssetSectionId, { label: string }> = {
  media: { label: "Media" },
  characters: { label: "Characters" },
  locations: { label: "Locations" },
  props: { label: "Props" },
  keyframes: { label: "Keyframes" },
  audio: { label: "Audio" },
};

export const SECTION_LABELS: Record<SectionId, string> = {
  story: "Story",
  script: "Script",
  dialogue: "Dialogue",
  beats: "Beats",
  shots: "Shots",
  prompts: "Prompts",
  media: "Media",
  characters: "Characters",
  locations: "Locations",
  props: "Props",
  keyframes: "Keyframes",
  audio: "Audio",
  videos: "Video Bin",
  timeline: "Timeline",
  workshop: "Video",
};

export function isAssetSection(section: SectionId): section is AssetSectionId {
  return ASSET_SECTIONS.includes(section as AssetSectionId);
}

export function primaryForSection(section: SectionId): PrimarySectionId {
  if (section === "story") return "story";
  if (section === "script" || section === "dialogue" || section === "prompts") return "script";
  if (section === "videos") return "assets";
  if (section === "timeline" || section === "workshop") return "workshop";
  return "assets";
}

export function singularAssetLabel(section: AssetSectionId) {
  switch (section) {
    case "media":
      return "Media";
    case "characters":
      return "Character";
    case "locations":
      return "Location";
    case "props":
      return "Prop";
    case "keyframes":
      return "Keyframe";
    case "audio":
      return "Audio";
  }
}

export function createLabelForSection(section: SectionId) {
  switch (section) {
    case "story":
      return "New Context Doc";
    case "script":
      return "New Scene";
    case "dialogue":
      return "Open Dialogue";
    case "prompts":
      return "New Prompt";
    case "media":
      return "New Media Item";
    case "characters":
      return "New Character";
    case "locations":
      return "New Location";
    case "props":
      return "New Prop";
    case "keyframes":
      return "New Keyframe";
    case "audio":
      return "New Audio";
    case "videos":
      // No manual-create affordance for videos — they come from generation
      // (agent tool) or drop-on-prompt upload. Returning a generic label
      // keeps the nav label function total; the UI hides the +New button
      // for this section.
      return "New Video";
    case "timeline":
    case "workshop":
      return "New Prompt";
    case "beats":
    case "shots":
      // Retired tiers (cut #1). Label kept for legacy SectionId values
      // that may still flow through old project.json files.
      return "New Prompt";
  }
}

export function uploadLabelForSection(section: AssetSectionId, mediaCount = 0) {
  if (section === "media") {
    return "Add Media";
  }
  if (section === "audio") {
    return mediaCount > 0 ? "Add audio variants" : "Upload MP3";
  }
  return mediaCount > 0 ? "Add variants" : `Upload ${singularAssetLabel(section)} Image`;
}

export function contextSubtitle(primary: PrimarySectionId, activeSection: SectionId) {
  if (primary === "story") {
    return "Project · script · assets · agent";
  }
  if (primary === "script") {
    return "Master Script + prompts";
  }
  if (primary === "assets") {
    if (activeSection === "media") return "All media";
    return SECTION_LABELS[activeSection];
  }
  if (primary === "workshop") {
    if (activeSection === "timeline") return "Assembly + exports";
    if (activeSection === "workshop") return "Edit · assemble · export";
    return "Rendered takes";
  }
  if (primary === "agent") {
    return "Local agent";
  }
  return SECTION_LABELS[activeSection];
}

/** Map UI section id to the ForgeProjectData property key. Returns
 *  null for sections with no backing array (e.g. Timeline is derived
 *  from script + videos at render time, not persisted as a flat list). */
function dataKey(
  section: SectionId,
): keyof import("../types").ForgeProjectData | null {
  if (section === "media") return "library";
  if (section === "videos") return "videos";
  if (section === "timeline" || section === "workshop") return null;
  return section as keyof import("../types").ForgeProjectData;
}

export function getSectionItems(project: import("../types").ForgeProjectData, section: SectionId): SectionEntry[] {
  // "media" is an AGGREGATED read-only view across all asset sub-sections.
  // characters / locations / props / keyframes / audio are the children;
  // Assets → media shows copies of everything together. project.library[]
  // still exists for back-compat — if any entries live there they merge
  // in too. Editing / deleting an aggregated row routes to the original
  // section via App.resolveAssetTarget().
  if (section === "media") {
    return [
      ...((project.library || []) as SectionEntry[]),
      ...((project.characters || []) as SectionEntry[]),
      ...((project.locations || []) as SectionEntry[]),
      ...((project.props || []) as SectionEntry[]),
      ...((project.keyframes || []) as SectionEntry[]),
      ...((project.audio || []) as SectionEntry[]),
    ];
  }
  const key = dataKey(section);
  if (!key) return [];
  return (project[key] || []) as SectionEntry[];
}

export function getEntryLabel(
  section: SectionId,
  entry: { title?: string | null; name?: string | null; takeIndex?: number; note?: string },
) {
  if (section === "videos") {
    // VideoEntry has no title/name — derive a stable label from takeIndex +
    // optional note. Numeric padding keeps sort order visually consistent.
    const take = typeof entry.takeIndex === "number"
      ? `Take ${String(entry.takeIndex).padStart(2, "0")}`
      : "Take";
    return entry.note ? `${take} · ${entry.note}` : take;
  }
  if (isAssetSection(section)) {
    return String(entry.name || entry.title || "Untitled");
  }
  return String(entry.title || "Untitled");
}

export function createEntry(
  section: SectionId,
  count: number,
  options: {
    defaultSceneId?: string;
    defaultScenePath?: string | null;
  } = {},
) {
  const label =
    section === "story"
      ? "Context Doc"
      : section === "script"
        ? "Scene"
        : section === "dialogue"
          ? "Dialogue"
          : section === "prompts"
            ? "Prompt"
            : section === "media"
              ? "Media Item"
              : isAssetSection(section)
                ? singularAssetLabel(section)
                : SECTION_LABELS[section].slice(0, -1);
  const base = {
    id: crypto.randomUUID(),
    path: "",
    title: `${label} ${count + 1}`,
    content: "",
  };

  if (section === "script") {
    return { ...base, kind: "scene" as const, durationSec: null };
  }

  if (section === "dialogue") {
    return {
      ...base,
      sceneId: options.defaultSceneId || null,
      scenePath: options.defaultScenePath || null,
      shotId: null,
      shotPath: null,
    };
  }

  if (section === "prompts") {
    return {
      ...base,
      durationSec: 15,
      sceneId: options.defaultSceneId || null,
      scenePath: options.defaultScenePath || null,
      segmentCount: null,
      segmentEndSec: null,
      segmentIndex: null,
      segmentStartSec: null,
      shotId: null,
      shotPath: null,
    };
  }

  if (isAssetSection(section)) {
    const name = `${label} ${count + 1}`;
    return {
      ...base,
      title: name,
      name,
      path: "",
      folder: null,
      media: [],
    };
  }

  return { ...base, kind: "story" as const };
}
