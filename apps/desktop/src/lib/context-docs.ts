import type { StoryContextGroup, StoryContextGroupBuiltIn, StoryEntry } from "../types";

export type ContextDocTone = "world" | "custom";
export type ContextDocGroup = StoryContextGroup;

const BUILT_IN_GROUPS: ReadonlySet<StoryContextGroupBuiltIn> = new Set([
  "project",
  "canon",
  "asset",
]);

export function isBuiltInContextGroup(value: ContextDocGroup): value is StoryContextGroupBuiltIn {
  return BUILT_IN_GROUPS.has(value as StoryContextGroupBuiltIn);
}

export function slugifyContextGroup(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function contextGroupDisplayLabel(group: ContextDocGroup) {
  if (group === "project") return "Project context";
  if (group === "canon") return "Canon context";
  if (group === "asset") return "Asset context";
  const cleaned = String(group || "").replace(/[-_]+/g, " ").trim();
  if (!cleaned) return "Context";
  return cleaned
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export interface ContextDocDescriptor {
  accent: ContextDocTone;
  avoid: string;
  builtIn: boolean;
  group: ContextDocGroup;
  key: string;
  path: string | null;
  purpose: string;
  title: string;
  usedFor: string[];
}

const BASE_USED_FOR = ["Master Script", "Prompts", "Assets", "Workshop"];

export const BUILTIN_CONTEXT_DOCS: ContextDocDescriptor[] = [
  {
    key: "project-scope",
    path: "story/intake.md",
    title: "Project Scope",
    purpose: "Optional project notes, goals, and references supplied by the user.",
    usedFor: BASE_USED_FOR,
    avoid: "Do not use this for hidden agent protocol, directory rules, or internal SOP; those belong in ANVIL.md.",
    accent: "custom",
    builtIn: true,
    group: "project",
  },
  {
    key: "world-bible",
    path: "story/world-bible.md",
    title: "World Bible",
    purpose: "One compact source for durable story truth, taste, visual identity, and continuity rules.",
    usedFor: BASE_USED_FOR,
    avoid: "Do not use this for full scene prose, prompt files, generated takes, or one-off workshop decisions.",
    accent: "world",
    builtIn: true,
    group: "canon",
  },
];

function descriptorForBuiltIn(path: string, title: string) {
  const normalizedPath = String(path || "").trim().toLowerCase();
  const normalizedTitle = String(title || "").trim().toLowerCase();
  if (normalizedPath) {
    const byPath = BUILTIN_CONTEXT_DOCS.find((doc) => doc.path?.toLowerCase() === normalizedPath);
    if (byPath) return byPath;
  }
  if (!normalizedPath && normalizedTitle) {
    return BUILTIN_CONTEXT_DOCS.find((doc) => doc.title.toLowerCase() === normalizedTitle);
  }
  return undefined;
}

export function normalizeContextDocGroup(value: unknown): ContextDocGroup {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "project" || raw === "asset" || raw === "canon") return raw;
  const slug = slugifyContextGroup(raw);
  return slug || "canon";
}

export function contextDocGroup(entry: Pick<StoryEntry, "contextGroup" | "path" | "title">): ContextDocGroup {
  const builtIn = descriptorForBuiltIn(entry.path || "", entry.title || "");
  if (builtIn) return builtIn.group;
  return normalizeContextDocGroup(entry.contextGroup);
}

export function describeContextDoc(entry: Pick<StoryEntry, "contextGroup" | "path" | "title">): ContextDocDescriptor {
  const builtIn = descriptorForBuiltIn(entry.path || "", entry.title || "");
  if (builtIn) return builtIn;
  const group = contextDocGroup(entry);
  let purpose: string;
  let avoid: string;
  if (group === "project") {
    purpose = "Visible project context for scope, constraints, creative brief, and user-facing operating notes that should guide the film.";
    avoid = "Do not put hidden agent protocol, private method rules, or generation prompt bodies here; use ANVIL.md for protocol and Prompts for render text.";
  } else if (group === "asset") {
    purpose = "Manual asset/reference context for visual rules, library notes, and reusable source material.";
    avoid = "Do not use this as a dumping ground for unrelated story beats; keep it tied to references and asset decisions.";
  } else if (group === "canon") {
    purpose = "Supplementary canon context for story facts, structure, tone, or decisions that need their own page.";
    avoid = "Do not duplicate large chunks of the World Bible or Master Script unless this doc truly owns something different.";
  } else {
    const sectionLabel = contextGroupDisplayLabel(group);
    purpose = `Custom ${sectionLabel.toLowerCase()} doc — user-defined section for context that does not fit Project / Canon / Asset.`;
    avoid = "Keep the section's purpose tight; if it grows broad, split it or move docs into the built-in groups.";
  }
  return {
    key: "custom-context-doc",
    path: entry.path || null,
    title: entry.title || "Context Doc",
    purpose,
    usedFor: BASE_USED_FOR,
    avoid,
    accent: "custom",
    builtIn: false,
    group,
  };
}
