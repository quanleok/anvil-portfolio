import type { AssetCategory, ScriptChild } from "./types";

// Constants lifted out of BrowserProjectWorkspace.tsx in commit 3.
// Path values + group ids stay aligned with desktop's lib/sections.ts
// + lib/context-docs.ts so the two runtimes converge.

// Section ids mirror desktop's PRIMARY_SECTIONS:
// story · script · assets · workshop. Labels stay desktop-canonical
// ("Context" for story, "Workshop" for workshop — distinct from the
// "Video" asset category to avoid the duplicate-label confusion).
export const NAV = [
  { id: "story", label: "Context", icon: "/anvil-ui/context-compass.webp" },
  { id: "script", label: "Script", icon: "/anvil-ui/script-grimoire-open.webp" },
  { id: "assets", label: "Assets", icon: "/anvil-ui/assets-armory.webp" },
  { id: "workshop", label: "Workshop", icon: "/anvil-ui/hammer-toolbar.webp" },
] as const;

export const SCRIPT_CHILDREN: ReadonlyArray<{ id: ScriptChild; label: string }> = [
  { id: "master", label: "Master" },
  { id: "dialogue", label: "Dialogue" },
  { id: "prompts", label: "Prompts" },
];

export const DIALOGUE_DOC_PATH = "dialogue/dialogue.md";
export const MASTER_SCRIPT_PATH = "script/master-script.md";

export const ASSET_CATEGORIES: AssetCategory[] = [
  { id: "all", label: "All", icon: "/anvil-ui/media-archive.webp", accept: "image/*,video/*,audio/*" },
  { id: "character", label: "Character", icon: "/anvil-ui/characters-anatomy.webp", accept: "image/*", kinds: ["image"] },
  { id: "location", label: "Location", icon: "/anvil-ui/locations-map.webp", accept: "image/*,video/*", kinds: ["image", "video"] },
  { id: "prop", label: "Prop", icon: "/anvil-ui/props-relic.webp", accept: "image/*", kinds: ["image"] },
  { id: "keyframe", label: "Keyframe", icon: "/anvil-ui/keyframes-frame.webp", accept: "image/*,video/*", kinds: ["image", "video"] },
  { id: "audio", label: "Audio", icon: "/anvil-ui/audio-bell.webp", accept: "audio/*", kinds: ["audio"] },
  { id: "video", label: "Video", icon: "/anvil-ui/assets-armory.webp", accept: "video/*", kinds: ["video"] },
];

export const ROOT_LABELS: Record<string, string> = {
  story: "Context",
  script: "Script",
  scenes: "Scenes",
  shots: "Shots",
  prompts: "Prompts",
  assets: "Assets",
  custom: "Custom",
};

// Phase C: built-in context-doc paths → canonical group. Mirrors
// desktop's BUILTIN_CONTEXT_DOCS.
export const BUILTIN_CONTEXT_GROUP: Record<string, "project" | "canon" | "asset"> = {
  "story/project-scope.md": "project",
  "story/world-bible.md": "canon",
  "story/asset-context.md": "asset",
};

export const CONTEXT_GROUP_LABELS: Record<string, string> = {
  project: "Project Context",
  canon: "Canon Context",
  asset: "Asset Context",
};

export const CONTEXT_GROUP_ORDER = ["project", "canon", "asset"];

export const PATH_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function createLabelForScriptChild(child: ScriptChild) {
  if (child === "prompts") return "New Prompt";
  if (child === "dialogue") return "Open Dialogue";
  return "New Scene";
}

export function readScriptChildFromUrl(): ScriptChild {
  if (typeof window === "undefined") return "master";
  const param = new URLSearchParams(window.location.search).get("script");
  return param === "dialogue" || param === "prompts" ? param : "master";
}

export function contextGroupLabel(group: string) {
  if (CONTEXT_GROUP_LABELS[group]) return CONTEXT_GROUP_LABELS[group];
  const cleaned = group.replace(/[-_]+/g, " ").trim();
  if (!cleaned) return "Context";
  return cleaned
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function fileUrl(projectId: string, filePath: string) {
  return `/api/projects/${encodeURIComponent(projectId)}/files/${filePath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}
