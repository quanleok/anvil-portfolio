import { Component, lazy, Suspense, startTransition, type DragEvent as ReactDragEvent, type ErrorInfo, type KeyboardEvent, type ReactNode, type UIEvent, useCallback, useDeferredValue, useEffect, useEffectEvent, useId, useMemo, useRef, useState } from "react";
import { ActivityFeed } from "./components/ActivityFeed";
import { ItemActionBar } from "./components/ItemActionBar";
import { MediaUploadButton } from "./components/MediaUploadButton";
import { AGENT_AVATAR_OPTIONS, AnvilMark, type AgentAvatarId } from "./components/AnvilMark";
import { ProjectHeaderMenu } from "./components/ProjectHeaderMenu";
import { LinkedAssetRail } from "./components/LinkedAssetRail";
import { MasterScriptAssetCounts } from "./components/MasterScriptAssetCounts";
import { AttachmentChip } from "./components/AttachmentChip";
import { Field } from "./components/Field";
import type { MarkdownEditorProps } from "./components/MarkdownEditor";
import { RuntimeBadge } from "./components/RuntimeBadge";
import { FormatMenu } from "./components/FormatMenu";
import { PositionedContextMenu } from "./components/PositionedContextMenu";
import { handleMenuNavigation } from "./components/menu-navigation";
import { SECTION_FORMAT_LABELS } from "./lib/section-format";
import {
  AudioWaveIcon,
  HideChatIcon,
  LockClosedIcon,
  LockOpenIcon,
  MediaFileIcon,
  NoticeBellIcon,
  PlusIcon,
  RedoIcon,
  SettingsIcon,
  TemporaryTrashIcon,
  TrashIcon,
  VideoCameraIcon,
  VideoMirrorIcon,
  ShowChatIcon,
  SyncIcon,
  UndoIcon,
  assetIconForSection,
  primaryIconForSection,
} from "./components/icons";
import { Modal } from "./components/Modal";
import { DesktopLoginGate } from "./components/DesktopLoginGate";
import { LaunchScreen } from "./components/LaunchScreen";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { WorkshopNLE } from "./components/WorkshopNLE";
import {
  buildPendingAssistantMessage,
  buildQueuedAssistantMessage,
  buildCommandMessageText,
  buildUserMessage,
  APP_EXTRACTION_REFUSAL,
  compactMessagePreview,
  detectAppExtractionRequest,
  messageNeedsCollapse,
  sanitizeVisibleAgentText,
} from "./lib/chat";
import {
  buildPromptSegments,
  distributeEvenly,
  formatDurationLabel,
  moveItem,
  parseDurationInput,
  scaleProportionally,
  sceneIdentifierLabel,
} from "./lib/duration";
import { promptContinuityPrevId } from "./lib/continuity";
import { evaluateLockVisual, fullLockLabel, isPathInScope, shortLockLabel } from "./lib/focus-lock";
import { usePopover } from "./hooks/usePopover";
import { useReducedMotion } from "./hooks/useReducedMotion";
import { cascadeMasterToScenes } from "./lib/runtime-cascade";
import { classifyIntent, type ClassifierInput } from "./lib/intent-classifier";
import {
  contextDocGroup,
  contextGroupDisplayLabel,
  describeContextDoc,
  isBuiltInContextGroup,
  slugifyContextGroup,
  type ContextDocGroup,
} from "./lib/context-docs";
import {
  buildDialogueScaffold,
  DIALOGUE_DOC_PATH,
  DIALOGUE_DOC_TITLE,
  syncEmptyDialogueScaffold,
} from "./lib/dialogue";
import { firstRenderableAssetMedia, indexMediaSrc, mediaSrc, writeClipboardText } from "./lib/media";
import {
  ASSET_SECTIONS,
  ASSET_SECTION_DETAILS,
  PRIMARY_LABELS,
  PRIMARY_SECTIONS,
  SECTION_LABELS,
  SHOW_AGENT_SURFACE,
  SHOW_PROJECT_TERMINAL_SURFACE,
  SHOW_WORKSHOP_SURFACE,
  contextSubtitle,
  createEntry,
  createLabelForSection,
  getEntryLabel,
  getSectionItems,
  isAssetSection,
  primaryForSection,
  uploadLabelForSection,
  type AssetSectionId,
  type PrimarySectionId,
  type SectionEntry,
} from "./lib/sections";

import type {
  AnvilMethodId,
  AssetEntry,
  AssetEntryKind,
  AgentPhase,
  ChatAttachment,
  ChatMessage,
  ChatTarget,
  CustomSubsection,
  CustomSubsectionId,
  CustomSubsectionKind,
  AccountEntitlement,
  AudioKind,
  DialogueEntry,
  EntityRef,
  EntityRefRole,
  FocusScope,
  FormatKind,
  ForgeProjectData,
  ForgeProjectHandle,
  MagicDocEntry,
  AssetContextGuideEntry,
  MediaRecord,
  OpenClawMeta,
  PinboardEntry,
  PromptEntry,
  RecentProjectEntry,
  SectionId,
  ScriptEntry,
  SkillAddonGroupId,
  StoryEntry,
  SuppressedRef,
  TimelineClip as PersistedTimelineClip,
  ToolCall,
  VideoEntry,
} from "./types";

const SEEDANCE_CLIP_MIN_SEC = 5;
const SEEDANCE_CLIP_MAX_SEC = 15;
const DEFAULT_CLIP_DURATION_SEC = 15;
const ASSET_LIBRARY_SECTIONS = [
  "characters",
  "locations",
  "props",
  "keyframes",
  "audio",
] as const;
const ASSET_NAV_SECTIONS = [...ASSET_SECTIONS, "videos"] as const;
type AllMediaCategoryId = "unassigned" | "assigned" | "generated";
const ALL_MEDIA_CATEGORY_FILTERS: Array<{
  id: AllMediaCategoryId;
  label: string;
}> = [
  { id: "unassigned", label: "Unassigned" },
  { id: "assigned", label: "Assigned" },
  { id: "generated", label: "Generated" },
];
const ALL_MEDIA_CATEGORY_RANK: Record<AssetSectionId, number> = {
  characters: 0,
  locations: 1,
  props: 2,
  keyframes: 3,
  audio: 4,
  media: 5,
};
const LOCAL_UI_LIMITS = {
  customSubsectionsPerPrimary: 8,
  customSubsectionDocs: 50,
  assetItemsPerSection: 500,
  assetVariantsPerAsset: 80,
  assetGridInitialItems: 180,
  assetGridPageSize: 120,
  compactSubrailAt: 8,
  compactDocListAt: 16,
} as const;

function readDeveloperFlag(key: string) {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

// Internal support docs stay on disk for the local agent and future server
// methods, but the production Context pane should remain plain markdown docs.
const SHOW_MAGIC_DOC_SURFACE = readDeveloperFlag("anvil:dev:magic-docs");
const SHOW_INTERNAL_CONTEXT_SURFACES = readDeveloperFlag("anvil:dev:context-surfaces");
const SHOW_DESKTOP_ACCOUNT_GATE = readDeveloperFlag("anvil:dev:account-gate");

function formatUiLimit(value: number) {
  return value.toLocaleString("en-US");
}

// Normalize a stored prompt durationSec to a Seedance-legal integer
// in seconds. Edge cases:
//   - null / undefined / NaN / negative / 0 → DEFAULT_CLIP_DURATION_SEC
//     (so empty draft prompts still count as the planning default in
//     scene totals — match the agent's create_prompt default).
//   - Below SEEDANCE_CLIP_MIN_SEC (5) → silently clamped UP to 5.
//   - Above SEEDANCE_CLIP_MAX_SEC (15) → silently clamped DOWN to 15.
//     Legacy / imported prompts longer than 15s SHOULD have been
//     split into sub-prompts; the clamp here protects the totals
//     from showing impossible Seedance generations. The underlying
//     stored value is untouched — only the contribution to runtime
//     totals is clamped.
//   - Fractional seconds → rounded.
function clipDurationSeconds(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CLIP_DURATION_SEC;
  return Math.min(SEEDANCE_CLIP_MAX_SEC, Math.max(SEEDANCE_CLIP_MIN_SEC, Math.round(parsed)));
}

function numericOrderFromClientPath(value: unknown, prefix: "scene" | "prompt") {
  const basename = normalizeClientRelativePath(value).split("/").pop()?.replace(/\.[^.]+$/, "") || "";
  const match = basename.match(new RegExp(`^(?:${prefix}[-_])?(\\d{1,4})(?:[-_\\s]|$)`, "i"));
  const parsed = Number(match?.[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function sceneTitleFromClientPath(value: unknown) {
  const basename = normalizeClientRelativePath(value).split("/").pop()?.replace(/\.[^.]+$/, "") || "";
  return basename.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()).trim();
}

function stemFromClientPath(value: unknown) {
  return normalizeClientRelativePath(value).split("/").pop()?.replace(/\.[^.]+$/, "") || "";
}

function normalizeSceneTitleForOrder(value: unknown) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/^\s*(?:scene|sequence|chapter|prompt|clip)\s*\d+(?:\.\d+)*\s*[—\-:.)·]?\s*/i, "")
    .replace(/^\s*\d+(?:\.\d+)*\s*[—\-:.)·]\s*/u, "")
    .replace(/\.(md|markdown)$/i, "")
    .replace(/[`*_#[\](){}"']/g, " ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function cleanSceneTitleForOrder(value: unknown) {
  let text = String(value || "").trim();
  if (!text) return "";
  text = text
    .replace(/\[[^\]]+\]\([^)]+\)/g, (match) => {
      const inner = match.match(/^\[([^\]]+)\]/);
      return inner?.[1] || match;
    })
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^\s*(scene\s*)?\d+(?:\.\d+)*\s*[.)—\-:·]?\s*/i, "")
    .replace(/\s+\([^)]*\d+\s*(?:s|sec|second|min|m)\b[^)]*\)\s*$/i, "")
    .replace(/\s+[—-]\s+\d+(?::\d+)?\s*(?:s|sec|second|min|m)?\s*$/i, "")
    .replace(/\s+[—-]\s+\d+\s*prompts?\s*$/i, "")
    .replace(/\s+[—-]\s+\d+\s*beats?\s*$/i, "")
    .replace(/\s*[:：]\s*$/, "")
    .replace(/[.,;]+$/g, "")
    .trim();
  if (!text || text.includes("scenes/") || text.length > 100) return "";
  return text;
}

function cleanSluglineTitleForOrder(value: unknown) {
  const line = String(value || "").trim();
  const match = line.match(/^(?:[-*]\s*)?(?:INT|EXT|INT\/EXT|I\/E)\.?\s+(.+)$/i);
  if (!match?.[1]) return "";
  return cleanSceneTitleForOrder(
    match[1]
      .replace(/\s+(?:[—-]|–)\s*(?:DAY|NIGHT|DAWN|DUSK|MORNING|AFTERNOON|EVENING|SUNRISE|SUNSET|CONTINUOUS|LATER|MOMENTS LATER|SAME TIME|FLASHBACK|PRESENT).*$/i, "")
      .replace(/\s+\((?:DAY|NIGHT|DAWN|DUSK|MORNING|AFTERNOON|EVENING|CONTINUOUS|LATER)[^)]*\)\s*$/i, "")
      .trim(),
  );
}

function isUsefulSceneTitleForOrder(key: string) {
  if (!key) return false;
  return !new Set([
    "master script",
    "scene file order",
    "runtime allocation",
    "prompt plan",
    "shot plan",
    "story function",
    "runtime estimate",
    "continuity notes",
    "linked assets",
    "characters",
    "locations",
    "props",
    "audio",
    "project context",
    "canon context",
    "asset context",
    "agent context",
  ]).has(key);
}

function sceneOrderHintsFromScriptContent(content: unknown) {
  const pathOrder = new Map<string, number>();
  const titleOrder = new Map<string, number>();
  const pushPath = (value: unknown) => {
    const normalized = normalizeClientRelativePath(value);
    if (normalized && !pathOrder.has(normalized)) pathOrder.set(normalized, pathOrder.size + 1);
  };
  const pushTitle = (value: unknown) => {
    const normalized = normalizeSceneTitleForOrder(cleanSceneTitleForOrder(value));
    if (isUsefulSceneTitleForOrder(normalized) && !titleOrder.has(normalized)) {
      titleOrder.set(normalized, titleOrder.size + 1);
    }
  };
  const lines = String(content || "").replace(/\r\n/g, "\n").split("\n");
  const allText = lines.join("\n");
  const pathRe = /(?:^|[\s("'`])((?:\.\/)?scenes\/[^\s"'`)]+?\.md)\b/gi;
  for (const match of allText.matchAll(pathRe)) pushPath(match[1]);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const explicitPath = line.match(/(?:^|[\s("'`])((?:\.\/)?scenes\/[^\s"'`)]+?\.md)\b/i);
    if (explicitPath?.[1]) pushPath(explicitPath[1]);

    const markdownHeading = line.match(/^\s*#{1,6}\s+(.+)$/);
    if (markdownHeading?.[1]) pushTitle(markdownHeading[1]);

    const sceneHeading =
      line.match(/^\s*(?:[-*]\s*)?(?:scene|sequence|chapter)\s*\d+(?:\.\d+)*\s*[.)—\-:·]?\s+(.+)$/i) ||
      line.match(/^\s*(?:[-*]\s*)?(?:scene|sequence|chapter)\s*[—\-:·]\s+(.+)$/i);
    if (sceneHeading?.[1]) pushTitle(sceneHeading[1]);

    const numbered =
      line.match(/^\s*(?:[-*]\s*)?\d+(?:\.\d+)*\s*[.)]\s+(.+)$/) ||
      line.match(/^\s*(?:[-*]\s*)?\d+(?:\.\d+)*\s+[—-]\s+(.+)$/) ||
      line.match(/^\s*#{2,4}\s+(?:scene\s*)?\d+(?:\.\d+)*\s*[—\-:.)·]\s*(.+)$/i);
    if (numbered?.[1]) pushTitle(numbered[1]);

    const slugline = cleanSluglineTitleForOrder(line);
    if (slugline) pushTitle(slugline);
  }

  return { pathOrder, titleOrder, normalizedContent: normalizeSceneTitleForOrder(allText) };
}

function sortScenesForDisplay(scenes: ScriptEntry[], scriptContent: unknown) {
  const hints = sceneOrderHintsFromScriptContent(scriptContent);
  return [...scenes]
    .map((scene, index) => {
      const explicit = Number(scene.sceneOrder);
      if (Number.isFinite(explicit) && explicit > 0) {
        return { scene, index, bucket: 0, value: explicit };
      }
      const normalizedPath = normalizeClientRelativePath(scene.path);
      const pathRank = hints.pathOrder.get(normalizedPath);
      if (Number.isFinite(pathRank)) {
        return { scene, index, bucket: 1, value: pathRank || 0 };
      }
      const titleKeys = [
        normalizeSceneTitleForOrder(scene.title),
        normalizeSceneTitleForOrder(sceneTitleFromClientPath(normalizedPath)),
      ].filter(Boolean);
      for (const titleKey of titleKeys) {
        const titleRank = hints.titleOrder.get(titleKey);
        if (Number.isFinite(titleRank)) return { scene, index, bucket: 1, value: titleRank || 0 };
      }
      for (const titleKey of titleKeys) {
        const tokenCount = titleKey.split(/\s+/).filter(Boolean).length;
        if (titleKey.length < 8 && tokenCount < 2) continue;
        const occurrence = hints.normalizedContent.indexOf(titleKey);
        if (occurrence >= 0) return { scene, index, bucket: 2, value: occurrence };
      }
      const pathNumeric = numericOrderFromClientPath(scene.path, "scene");
      if (Number.isFinite(pathNumeric)) {
        return { scene, index, bucket: 3, value: pathNumeric || 0 };
      }
      return { scene, index, bucket: 4, value: index };
    })
    .sort((a, b) => a.bucket - b.bucket || a.value - b.value || a.index - b.index)
    .map((item) => item.scene);
}

function promptFolderSlugForOrder(prompt: PromptEntry) {
  const parts = normalizeClientRelativePath(prompt.path).split("/");
  return parts[0] === "prompts" && parts.length > 2 ? parts[1] || "" : "";
}

function sceneSlugForPromptMatch(scene: ScriptEntry) {
  return stemFromClientPath(scene.path);
}

function promptBelongsToSceneForDisplay(prompt: PromptEntry, scene: ScriptEntry) {
  if (prompt.sceneId) return prompt.sceneId === scene.id;
  const promptScenePath = normalizeClientRelativePath(prompt.scenePath);
  const scenePath = normalizeClientRelativePath(scene.path);
  if (promptScenePath && scenePath && promptScenePath === scenePath) return true;
  const promptFolder = promptFolderSlugForOrder(prompt);
  return Boolean(promptFolder && sceneSlugForPromptMatch(scene) && promptFolder === sceneSlugForPromptMatch(scene));
}

function promptTitleKeysForOrder(prompt: PromptEntry) {
  return Array.from(new Set([
    normalizeSceneTitleForOrder(prompt.title),
    normalizeSceneTitleForOrder(sceneTitleFromClientPath(prompt.path)),
  ].filter(Boolean)));
}

function buildPromptContentRankForOrder(prompts: PromptEntry[], scene?: ScriptEntry | null) {
  const sceneContent = normalizeSceneTitleForOrder(scene?.content || "");
  const ranks = new Map<string, number>();
  if (!sceneContent) return ranks;
  for (const prompt of prompts) {
    if (!prompt.id) continue;
    let best = Number.POSITIVE_INFINITY;
    for (const titleKey of promptTitleKeysForOrder(prompt)) {
      const tokenCount = titleKey.split(/\s+/).filter(Boolean).length;
      if (titleKey.length < 8 && tokenCount < 2) continue;
      const index = sceneContent.indexOf(titleKey);
      if (index >= 0 && index < best) best = index;
    }
    if (Number.isFinite(best)) ranks.set(prompt.id, best);
  }
  return ranks;
}

function promptBaseRank(
  prompt: PromptEntry,
  originalIndexById: Map<string, number>,
  contentRankById: Map<string, number>,
) {
  const segmentIndex = Number(prompt.segmentIndex);
  if (Number.isFinite(segmentIndex) && segmentIndex > 0) {
    return { bucket: 0, value: segmentIndex };
  }
  const explicit = Number((prompt as PromptEntry & Record<string, unknown>).promptOrder);
  if (Number.isFinite(explicit) && explicit > 0) {
    return { bucket: 1, value: explicit };
  }
  const contentRank = prompt.id ? contentRankById.get(prompt.id) : null;
  if (Number.isFinite(contentRank)) {
    return { bucket: 2, value: contentRank || 0 };
  }
  const pathOrder = numericOrderFromClientPath(prompt.path, "prompt");
  if (Number.isFinite(pathOrder)) {
    return { bucket: 3, value: pathOrder || 0 };
  }
  return { bucket: 4, value: originalIndexById.get(prompt.id) ?? 0 };
}

function sortPromptChain(
  prompts: PromptEntry[],
  originalIndexById: Map<string, number>,
  contentRankById: Map<string, number>,
) {
  const ids = new Set(prompts.map((prompt) => prompt.id).filter(Boolean));
  const starts: PromptEntry[] = [];
  const nextByPrev = new Map<string, PromptEntry[]>();
  for (const prompt of prompts) {
    const prevId = String(prompt.prevPromptId || "").trim();
    if (prevId && ids.has(prevId) && prevId !== prompt.id) {
      const list = nextByPrev.get(prevId) || [];
      list.push(prompt);
      nextByPrev.set(prevId, list);
    } else {
      starts.push(prompt);
    }
  }
  const compare = (a: PromptEntry, b: PromptEntry) => {
    const rankA = promptBaseRank(a, originalIndexById, contentRankById);
    const rankB = promptBaseRank(b, originalIndexById, contentRankById);
    return (
      rankA.bucket - rankB.bucket ||
      rankA.value - rankB.value ||
      (originalIndexById.get(a.id) ?? 0) - (originalIndexById.get(b.id) ?? 0)
    );
  };
  starts.sort(compare);
  for (const list of nextByPrev.values()) list.sort(compare);

  const ordered: PromptEntry[] = [];
  const seen = new Set<string>();
  const visit = (prompt: PromptEntry) => {
    if (!prompt.id || seen.has(prompt.id)) return;
    seen.add(prompt.id);
    ordered.push(prompt);
    for (const next of nextByPrev.get(prompt.id) || []) visit(next);
  };
  for (const prompt of starts) visit(prompt);
  for (const prompt of [...prompts].sort(compare)) visit(prompt);
  return ordered;
}

function sortPromptsForDisplay(prompts: PromptEntry[], scene?: ScriptEntry | null) {
  const originalIndexById = new Map<string, number>();
  prompts.forEach((prompt, index) => {
    if (prompt.id && !originalIndexById.has(prompt.id)) originalIndexById.set(prompt.id, index);
  });
  const contentRankById = buildPromptContentRankForOrder(prompts, scene);
  const ids = new Set(prompts.map((prompt) => prompt.id).filter(Boolean));
  const topLevel: PromptEntry[] = [];
  const orphanedChildren: PromptEntry[] = [];
  const childrenByParent = new Map<string, PromptEntry[]>();
  for (const prompt of prompts) {
    const parentId = String(prompt.parentPromptId || "").trim();
    if (parentId && ids.has(parentId) && parentId !== prompt.id) {
      const children = childrenByParent.get(parentId) || [];
      children.push(prompt);
      childrenByParent.set(parentId, children);
    } else if (parentId) {
      orphanedChildren.push(prompt);
    } else {
      topLevel.push(prompt);
    }
  }
  const ordered: PromptEntry[] = [];
  for (const prompt of sortPromptChain(topLevel, originalIndexById, contentRankById)) {
    ordered.push(prompt);
    ordered.push(...sortPromptChain(childrenByParent.get(prompt.id) || [], originalIndexById, contentRankById));
  }
  ordered.push(...sortPromptChain(orphanedChildren, originalIndexById, contentRankById));
  return ordered;
}

// Status → next-action CTA hint. null if status doesn't call for action.
function magicDocNextAction(status: MagicDocEntry["status"]): { label: string; hint: string } | null {
  switch (status) {
    case "stale":
      return { label: "Update", hint: "Rebuild summary" };
    case "never-synced":
      return { label: "Generate", hint: "Build summary" };
    case "hand-edited":
      return null; // Regenerate button already handles this with confirm
    case "broken":
      return { label: "Fix sources", hint: "Missing source files" };
    case "fresh":
    default:
      return null;
  }
}

function slugifyContextDocTitle(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "context-doc";
}

function contextDocPathForGroup(group: ContextDocGroup, title: string) {
  const slug = slugifyContextDocTitle(title);
  const prefix = isBuiltInContextGroup(group)
    ? group
    : slugifyContextGroup(group) || "canon";
  return `story/${prefix}-${slug}.md`;
}

function slugifyContentPathPart(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72) || "scene";
}

function normalizeClientRelativePath(value: unknown) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");
}

const MASTER_SCRIPT_PATH = "script/master-script.md";

function markdownDocTitleFromPath(value: unknown) {
  const basename = normalizeClientRelativePath(value).split("/").pop() || "";
  return basename.replace(/\.md$/i, "") || "Untitled";
}

function nextSceneOrdinal(project: ForgeProjectData) {
  const scenes = Array.isArray(project.script)
    ? project.script.filter((entry): entry is ScriptEntry => entry.kind === "scene")
    : [];
  const ordinals = scenes.map((entry, index) => {
    const pathMatch = normalizeClientRelativePath(entry.path).match(/(?:^|\/)scene-(\d{1,4})(?:[-./]|$)/i);
    const titleMatch = String(entry.title || "").match(/^\s*(?:scene\s*)?(\d{1,4})(?:\D|$)/i);
    return Math.max(
      index + 1,
      Number(pathMatch?.[1]) || 0,
      Number(titleMatch?.[1]) || 0,
    );
  });
  return Math.max(0, ...ordinals) + 1;
}

function uniqueClientRelativePath(project: ForgeProjectData, candidate: string) {
  const usedPaths = new Set<string>();
  const collections = [
    project.story,
    project.script,
    project.prompts,
    project.dialogue,
  ];
  for (const collection of collections) {
    if (!Array.isArray(collection)) continue;
    for (const entry of collection) {
      const path = normalizeClientRelativePath(entry?.path);
      if (path) usedPaths.add(path);
    }
  }

  const normalized = normalizeClientRelativePath(candidate);
  if (!usedPaths.has(normalized)) return normalized;

  const extensionMatch = normalized.match(/(\.[^/.]+)$/);
  const extension = extensionMatch?.[1] || ".md";
  const stem = normalized.slice(0, normalized.length - extension.length);
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const next = `${stem}-${suffix}${extension}`;
    if (!usedPaths.has(next)) return next;
  }
  const fallbackSuffix = (globalThis.crypto?.randomUUID?.() || String(Date.now())).slice(0, 8);
  return `${stem}-${fallbackSuffix}${extension}`;
}

function createScriptSceneEntry(project: ForgeProjectData, parentScriptPath?: string) {
  const ordinal = nextSceneOrdinal(project);
  const title = `Scene ${ordinal}`;
  const path = uniqueClientRelativePath(
    project,
    `scenes/scene-${String(ordinal).padStart(2, "0")}-${slugifyContentPathPart(title)}.md`,
  );
  return {
    ...(createEntry("script", ordinal - 1, {}) as ScriptEntry),
    path,
    title,
    ...(parentScriptPath ? { parentScriptPath } : {}),
  };
}

function sceneParentScriptPath(entry: ScriptEntry) {
  const parent = normalizeClientRelativePath(entry.parentScriptPath);
  return parent || MASTER_SCRIPT_PATH;
}

function sceneFileOrderBlock(orderedScenes: ScriptEntry[]) {
  return [
    "Scene file order:",
    "",
    ...orderedScenes.map((scene, index) => `${index + 1}. \`${normalizeClientRelativePath(scene.path)}\``),
  ].join("\n");
}

function replaceSceneFileOrderBlock(content: string, orderedScenes: ScriptEntry[]) {
  const block = sceneFileOrderBlock(orderedScenes);
  const normalizedContent = String(content || "").replace(/\r\n/g, "\n");
  const lines = normalizedContent.split("\n");
  const start = lines.findIndex((line) => /^Scene file order:\s*$/i.test(line.trim()));
  if (start < 0) {
    return `${normalizedContent.trimEnd()}\n\n${block}\n`;
  }

  let end = start + 1;
  while (end < lines.length && lines[end].trim() === "") end += 1;
  while (
    end < lines.length &&
    /^\s*\d+\.\s+`?(?:\.\/)?scenes\/[^\s`]+\.md`?\s*$/i.test(lines[end].trim())
  ) {
    end += 1;
  }
  while (end < lines.length && lines[end].trim() === "") end += 1;

  return [
    ...lines.slice(0, start),
    ...block.split("\n"),
    "",
    ...lines.slice(end),
  ].join("\n").replace(/\n+$/g, "\n");
}

function persistSceneOrderForScript(scriptEntries: ScriptEntry[], scriptPath: string) {
  const normalizedScriptPath = normalizeClientRelativePath(scriptPath) || MASTER_SCRIPT_PATH;
  const orderedScenes = scriptEntries.filter(
    (entry) => entry.kind === "scene" && sceneParentScriptPath(entry) === normalizedScriptPath,
  );
  const orderById = new Map(orderedScenes.map((scene, index) => [scene.id, index + 1]));

  return scriptEntries.map((entry) => {
    if (entry.kind === "scene" && orderById.has(entry.id)) {
      return { ...entry, sceneOrder: orderById.get(entry.id) || null };
    }
    if (entry.kind === "master" && normalizeClientRelativePath(entry.path) === normalizedScriptPath) {
      return {
        ...entry,
        content: replaceSceneFileOrderBlock(String(entry.content || ""), orderedScenes),
      };
    }
    return entry;
  });
}

function contextDocGroupLabel(group: ContextDocGroup) {
  return contextGroupDisplayLabel(group);
}

const HIDDEN_LEGACY_CONTEXT_DOCS = new Set(["story/project-brief.md"]);
const RESERVED_CONTEXT_SECTION_SLUGS = new Set(["project", "canon", "asset"]);

function normalizeReadOnlyPath(value: string) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim();
}

// Remove a single legacy assetRefs entry from one section bucket.
// Restored as a local helper to unblock TypeScript after the lib/asset-sync
// extraction was rolled back; the LinkedAssetRail callsite still expects
// it. Pure function — does not touch entityRefs.
function removeLegacyAssetRef(
  assetRefs:
    | { characters?: string[]; locations?: string[]; props?: string[]; keyframes?: string[]; audio?: string[] }
    | undefined,
  section: "characters" | "locations" | "props" | "keyframes" | "audio",
  assetId: string,
):
  | { characters?: string[]; locations?: string[]; props?: string[]; keyframes?: string[]; audio?: string[] }
  | undefined {
  if (!assetRefs) return assetRefs;
  const bucket = assetRefs[section];
  if (!Array.isArray(bucket) || bucket.length === 0) return assetRefs;
  const next = bucket.filter((id) => id !== assetId);
  if (next.length === bucket.length) return assetRefs;
  const out = { ...assetRefs, [section]: next };
  if (next.length === 0) delete out[section];
  return out;
}

function isPathReadOnly(project: ForgeProjectData | null | undefined, relativePath: string) {
  const target = normalizeReadOnlyPath(relativePath);
  if (!target || !project) return false;
  // No defaults — paths are editable unless explicitly listed as locked.
  const list = project.readOnlyPaths;
  if (!Array.isArray(list)) return false;
  return list.some((entry) => normalizeReadOnlyPath(entry) === target);
}

function withTogglePathReadOnly(
  project: ForgeProjectData,
  relativePath: string,
  next: boolean,
): ForgeProjectData {
  const target = normalizeReadOnlyPath(relativePath);
  if (!target) return project;
  const current = Array.isArray(project.readOnlyPaths) ? project.readOnlyPaths : [];
  const filtered = current.filter((entry) => normalizeReadOnlyPath(entry) !== target);
  const nextPaths = next ? [...filtered, target] : filtered;
  return { ...project, readOnlyPaths: nextPaths };
}

function ReadOnlyToggle({
  project,
  relativePath,
  onToggle,
}: {
  project: ForgeProjectData | null | undefined;
  relativePath: string;
  onToggle: (next: boolean) => void;
}) {
  const locked = isPathReadOnly(project, relativePath);
  return (
    <button
      type="button"
      className={`read-only-toggle${locked ? " locked" : ""}`}
      onClick={() => onToggle(!locked)}
      title={
        locked
          ? "Locked — agents and tools cannot edit. Click to allow editing."
          : "Editable — click to lock so agents cannot modify this file."
      }
      aria-pressed={locked}
    >
      {locked ? <LockClosedIcon /> : <LockOpenIcon />}
      <span>{locked ? "Read-only" : "Editable"}</span>
    </button>
  );
}


const AGENT_NOTE_PATH = ".forge/agent-note.md";
const AGENT_NOTE_LABEL = "Agent Note";
const AGENT_NOTE_PURPOSE =
  "User-facing handoff notes for the local agent: taste calls, blockers, next steps, and direct instructions.";

// Project-relative path matcher. Picks up strings like
//   scenes/scene-03-crow.md
//   shots/scene-01-intro/shot-02-door.md
//   prompts/scene-03-crow/prompt-05.md
//   assets/characters/kai.md
//   story/world-bible.md
//   .forge/memory/MEMORY.md
// plus bare top-level docs like ANVIL.md. Purely best-effort — if the path
// doesn't resolve in the project we just render it as plain text.
const PROJECT_PATH_PATTERN =
  /(?:\.forge\/|dialogue\/|scenes\/|beats\/|shots\/|prompts\/|assets\/|story\/|script\/)(?:[\w.\-/]+?)\.md\b|\b(?:ANVIL|AGENT|CLAUDE)\.md\b/g;

type InboxFile = {
  name: string;
  relPath: string;
  kind: "image" | "video" | "audio" | "document" | "other";
  size: number;
  mtime: number;
  fileUrl: string;
};

type InboxPendingJob = {
  id: string;
  capability: "image" | "video" | "music" | "audio" | "asset";
  prompt: string;
  model?: string;
  section?: string;
  startedAt: number;
};

type NoticeType = "success" | "error" | "info";
type NoticeCategory =
  | "project"
  | "script"
  | "story"
  | "dialogue"
  | "assets"
  | "videos"
  | "timeline"
  | "repair"
  | "lock"
  | "agent"
  | "settings";
type NoticeImportance = "low" | "normal" | "attention";
type NoticeVisibility = "toast" | "log";
type NoticeActionTarget =
  | { kind: "magicDoc"; id: string }
  | { kind: "video"; id: string }
  | { kind: "section"; section: SectionId; itemId?: string }
  | { kind: "revealPath"; relativePath?: string }
  | { kind: "release-lock" }
  | { kind: "settings" };
type NoticeAction = { label: string; target: NoticeActionTarget };
type Notice = {
  id: string;
  text: string;
  type: NoticeType;
  timestamp: number;
  category: NoticeCategory;
  importance: NoticeImportance;
  visibility: NoticeVisibility;
  dedupeKey: string;
  count: number;
  action?: NoticeAction;
};
type NoticeOptions = Partial<Pick<Notice, "category" | "importance" | "visibility" | "dedupeKey" | "action">>;
type SessionNoticeCard = {
  key: string;
  tone: "attention" | "working" | "info";
  title: string;
  detail: string;
  action?: NoticeAction;
};

function formatTrimPointInput(value?: number | null) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return "";
  const rounded = Math.round(numeric * 10) / 10;
  return String(rounded).replace(/\.0$/, "");
}

const NOTICE_DEDUPE_WINDOW_MS = 12_000;

function noticeCategoryLabel(category: NoticeCategory) {
  switch (category) {
    case "story":
      return "Story";
    case "dialogue":
      return "Dialogue";
    case "assets":
      return "Assets";
    case "videos":
      return "Videos";
    case "timeline":
      return "Timeline";
    case "repair":
      return "Repair";
    case "lock":
      return "Lock";
    case "agent":
      return "Agent";
    case "settings":
      return "Settings";
    case "script":
      return "Script";
    case "project":
    default:
      return "Project";
  }
}

function inferNoticeDefaults(
  text: string,
  type: NoticeType,
): Pick<Notice, "category" | "importance" | "visibility" | "dedupeKey"> {
  const lower = text.trim().toLowerCase();
  let category: NoticeCategory = "project";
  if (
    lower.includes("repair") ||
    lower.includes("broken") ||
    lower.includes("stale context")
  ) {
    category = "repair";
  } else if (lower.includes("lock") || lower.includes("read-only")) {
    category = "lock";
  } else if (lower.includes("dialogue")) {
    category = "dialogue";
  } else if (lower.includes("timeline") || lower.includes("clip")) {
    category = "timeline";
  } else if (lower.includes("video") || lower.includes("take")) {
    category = "videos";
  } else if (
    lower.includes("media") ||
    lower.includes("asset") ||
    lower.includes("variant") ||
    lower.includes("library")
  ) {
    category = "assets";
  } else if (
    lower.includes("sync") ||
    lower.includes("context doc") ||
    lower.includes("film bible") ||
    lower.includes("world bible") ||
    lower.includes("story")
  ) {
    category = "story";
  } else if (
    lower.includes("prompt") ||
    lower.includes("scene") ||
    lower.includes("shot") ||
    lower.includes("segment")
  ) {
    category = "script";
  } else if (lower.includes("agent") || lower.includes("queue")) {
    category = "agent";
  } else if (lower.includes("settings")) {
    category = "settings";
  }

  let importance: NoticeImportance = "normal";
  if (
    type === "error" ||
    /outside lock scope|timed out|failed|can't|cannot|couldn't|missing|broken|error|read-only/.test(lower)
  ) {
    importance = "attention";
  } else if (
    /^opened\b/.test(lower) ||
    /^copied\b/.test(lower) ||
    /^undo$/.test(lower) ||
    /^redo$/.test(lower) ||
    /^locked to\b/.test(lower) ||
    /^focus lock released\b/.test(lower) ||
    /^read-only mode on\b/.test(lower) ||
    /^ignored this health warning\b/.test(lower) ||
    /^restored this health warning\b/.test(lower) ||
    /is up to date|already in sync|no changes applied|attached to chat/.test(lower)
  ) {
    importance = "low";
  }

  return {
    category,
    importance,
    visibility: importance === "low" ? "log" : "toast",
    dedupeKey: `${category}:${type}:${lower}`,
  };
}

// Convert chat text into an array of React nodes, replacing matched paths
// with clickable chips. Text inside fenced code blocks (```...```) and
// inline code (`...`) is passed through unchanged — chipping paths inside
// a code example would corrupt what the agent was literally showing.
function renderChatTextWithPaths(
  text: string,
  onPathClick: (path: string) => void,
): ReactNode[] {
  if (!text) return [text];
  // Split text into alternating "text" / "code" segments so the chip regex
  // only runs on the "text" portion. Code delimiters: triple-backtick
  // fences (``` ... ```) or single-backtick inline (`...`). Fences are
  // checked first because they may contain bare backticks.
  type Segment = { kind: "text" | "code"; value: string };
  const segments: Segment[] = [];
  let remaining = text;
  const fenceRe = /```[\s\S]*?```/;
  const inlineRe = /`[^`\n]+`/;
  while (remaining.length > 0) {
    const fence = fenceRe.exec(remaining);
    const inline = inlineRe.exec(remaining);
    // Pick whichever match comes first.
    let picked: { match: RegExpExecArray; kind: "code" } | null = null;
    if (fence && (!inline || fence.index <= inline.index)) {
      picked = { match: fence, kind: "code" };
    } else if (inline) {
      picked = { match: inline, kind: "code" };
    }
    if (!picked) {
      segments.push({ kind: "text", value: remaining });
      break;
    }
    if (picked.match.index > 0) {
      segments.push({ kind: "text", value: remaining.slice(0, picked.match.index) });
    }
    segments.push({ kind: "code", value: picked.match[0] });
    remaining = remaining.slice(picked.match.index + picked.match[0].length);
  }

  const nodes: ReactNode[] = [];
  let key = 0;
  for (const segment of segments) {
    if (segment.kind === "code") {
      // Code passes through verbatim — no link-ification.
      nodes.push(segment.value);
      continue;
    }
    const pattern = new RegExp(PROJECT_PATH_PATTERN.source, "g");
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(segment.value)) !== null) {
      if (match.index > cursor) {
        nodes.push(segment.value.slice(cursor, match.index));
      }
      const matched = match[0];
      // Stable key = cumulative index + matched content — prevents React
      // from reusing DOM nodes across different matches when a message
      // rerenders. Mutable counter alone let identical paths collide.
      const stableKey = `path-${key++}-${match.index}-${matched}`;
      nodes.push(
        <button
          key={stableKey}
          className="chat-path-chip"
          onClick={(e) => {
            e.preventDefault();
            onPathClick(matched);
          }}
          title={`Jump to ${matched}`}
          type="button"
        >
          {matched}
        </button>,
      );
      cursor = match.index + matched.length;
    }
    if (cursor < segment.value.length) {
      nodes.push(segment.value.slice(cursor));
    }
  }
  return nodes;
}

function normalizeAgentProvider(provider: string | undefined | null): "openclaw" | "hermes" {
  return String(provider || "").trim().toLowerCase() === "hermes" ? "hermes" : "openclaw";
}

function routeProviderLabel(provider: string | undefined | null) {
  const value = String(provider || "").trim();
  if (!value) return "";
  if (value.toLowerCase() === "openclaw") return "OpenClaw";
  if (value.toLowerCase() === "hermes") return "Hermes";
  return value;
}

function fallbackAgentSubtitle(settings: ForgeProjectData["settings"]) {
  const provider = normalizeAgentProvider(settings.agentProvider);
  switch (provider) {
    case "hermes":
      return "Local agent · Hermes";
    case "openclaw":
    default:
      return "Local wrapper · OpenClaw";
  }
}

function agentRuntimeLabel(settings: ForgeProjectData["settings"], meta?: OpenClawMeta | null) {
  if (meta) {
    const provider = routeProviderLabel(meta.provider);
    const model = meta.model ? String(meta.model).trim() : "";
    const transportLabel = provider === "Hermes" ? "Local agent" : "Local wrapper";
    if (provider && model) return `${transportLabel} · ${provider} · ${model}`;
    if (provider) return `${transportLabel} · ${provider}`;
  }
  return fallbackAgentSubtitle(settings);
}

type AgentWorkflowCheckpointId =
  | "scope"
  | "context"
  | "script"
  | "scenes"
  | "prompts"
  | "references"
  | "storyboards"
  | "generation"
  | "critique"
  | "timeline";

type AgentWorkflowStatus = "idle" | "running" | "done" | "error" | "cancelled";

type AgentWorkflowState = {
  activeId: AgentWorkflowCheckpointId;
  completedIds: AgentWorkflowCheckpointId[];
  lastToolName: string | null;
  phaseMood: AgentPhase["mood"];
  phaseVerb: string;
  status: AgentWorkflowStatus;
  updatedAt: number;
};

type PhaseCheckpoint = {
  checkpoint: string;
  methodId: AnvilMethodId;
};

type ScopeIntakeDraft = {
  aspect: string;
  audience: string;
  budget: string;
  format: string;
  goal: string;
  mustInclude: string;
  notes: string;
  platform: string;
  premise: string;
  provider: string;
  qualityTarget: string;
  references: string;
  runtime: string;
  tone: string;
};

const SCOPE_INTAKE_DRAFT_STORAGE_PREFIX = "anvil:scope-intake-draft:v1:";

const DEFAULT_SCOPE_INTAKE_DRAFT: ScopeIntakeDraft = {
  aspect: "16:9",
  audience: "",
  budget: "Balanced",
  format: "Short film",
  goal: "",
  mustInclude: "",
  notes: "",
  platform: "",
  premise: "",
  provider: "Use project settings",
  qualityTarget: "Reviewable",
  references: "",
  runtime: "60s",
  tone: "",
};

const SCOPE_INTAKE_OPTIONS = {
  format: ["Short film", "Ad", "Social video"],
  runtime: ["15s", "30s", "60s", "2-3 min"],
  aspect: ["16:9", "9:16", "1:1", "4:5"],
  budget: ["Lean", "Balanced", "High polish"],
  qualityTarget: ["Draft", "Reviewable", "Portfolio"],
  provider: ["Use project settings", "Seedance 2", "Veo", "Runway"],
} as const;

function normalizeScopeIntakeDraft(value: unknown): ScopeIntakeDraft {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<Record<keyof ScopeIntakeDraft, unknown>>
    : {};
  const next: ScopeIntakeDraft = { ...DEFAULT_SCOPE_INTAKE_DRAFT };
  for (const key of Object.keys(next) as Array<keyof ScopeIntakeDraft>) {
    if (typeof source[key] === "string") next[key] = source[key]!.trim();
  }
  return next;
}

function scopeIntakeDraftStorageKey(projectId: string | null) {
  return projectId ? `${SCOPE_INTAKE_DRAFT_STORAGE_PREFIX}${projectId}` : "";
}

function buildScopeIntakeVisibleMessage(draft: ScopeIntakeDraft) {
  return [
    "Add project notes",
    `${draft.format || "Short film"} · ${draft.runtime || "runtime TBD"} · ${draft.aspect || "aspect TBD"}`,
    draft.premise ? `Premise: ${draft.premise}` : "Premise: agent should help shape it",
  ].join("\n");
}

function buildScopeIntakePrompt(projectName: string, draft: ScopeIntakeDraft) {
  const lines = [
    `Project: ${projectName}`,
    "Phase: scope_intake.",
    "",
    "User scope answers:",
    `- Format: ${draft.format || "TBD"}`,
    `- Runtime target: ${draft.runtime || "TBD"}`,
    `- Aspect ratio: ${draft.aspect || "TBD"}`,
    `- Platform: ${draft.platform || "TBD"}`,
    `- Premise: ${draft.premise || "TBD; ask one compact follow-up if needed"}`,
    `- Tone: ${draft.tone || "TBD"}`,
    `- Goal: ${draft.goal || "TBD"}`,
    `- Audience: ${draft.audience || "TBD"}`,
    `- References: ${draft.references || "TBD"}`,
    `- Must include / avoid: ${draft.mustInclude || "TBD"}`,
    `- Generation budget: ${draft.budget || "Balanced"}`,
    `- Quality target: ${draft.qualityTarget || "Reviewable"}`,
    `- Preferred provider: ${draft.provider || "Use project settings"}`,
    `- Extra notes: ${draft.notes || "None"}`,
    "",
    "Save these user-supplied notes in story/intake.md (Project Scope), preserving existing content unless I requested a replacement.",
    "The fields are optional context. Do not infer a required planning sequence or create additional project files from this form alone.",
    "Ask a concise follow-up if the requested edit is unclear. Report the changed file and any unresolved question.",
  ];
  return lines.join("\n");
}

function phaseCheckpointCopy(_checkpoint: string) {
  return {
    title: "Request Ready",
    body: "Review the result and choose what you want to do next.",
    primary: "Continue request",
    revise: "Revise request",
  };
}

function nextMethodForCheckpoint(_checkpoint: string, methodId: string | null | undefined): AnvilMethodId {
  return nextLocalMethodId(methodId);
}

function checkpointAfterMethod(methodId: AnvilMethodId): PhaseCheckpoint {
  const phase = localMethodPhase(methodId);
  return {
    checkpoint: phase.checkpoint,
    methodId: phase.methodId,
  };
}

function buildContinuePhasePrompt(
  projectName: string,
  checkpoint: PhaseCheckpoint,
  nextMethodId: AnvilMethodId,
) {
  const nextPhase = localMethodPhase(nextMethodId);
  return [
    `Project: ${projectName}`,
    `Phase: ${nextPhase.phase}.`,
    `Current request: ${nextPhase.label}. Previous review marker: ${checkpoint.checkpoint}.`,
    "Continue the user's current request using the available project context.",
    "If the next action is unspecified, ask what the user wants to do. Do not start a prescribed production sequence.",
    "Confirm before paid media generation or destructive changes. Report the files changed and any unresolved question.",
  ].join("\n");
}

function buildRevisePhasePrompt(checkpoint: PhaseCheckpoint) {
  const copy = phaseCheckpointCopy(checkpoint.checkpoint);
  return `${copy.revise}. Keep the full rewrite in files and keep chat short. Focus on: `;
}

const AGENT_WORKFLOW_CHECKPOINTS: Array<{
  id: AgentWorkflowCheckpointId;
  label: string;
  short: string;
}> = [
  { id: "scope", label: "Scope", short: "Scope" },
  { id: "context", label: "Context", short: "Ctx" },
  { id: "script", label: "Master Script", short: "Script" },
  { id: "scenes", label: "Scenes", short: "Scenes" },
  { id: "prompts", label: "Shots / Prompts", short: "Prompts" },
  { id: "references", label: "References", short: "Refs" },
  { id: "storyboards", label: "Storyboards", short: "Boards" },
  { id: "generation", label: "Generation", short: "Gen" },
  { id: "critique", label: "Critique", short: "Review" },
  { id: "timeline", label: "Timeline", short: "Timeline" },
];

const LOCAL_METHOD_PHASES: Array<{
  checkpoint: string;
  label: string;
  methodId: AnvilMethodId;
  phase: string;
  workflowId: AgentWorkflowCheckpointId;
}> = [
  {
    methodId: "scope_intake",
    label: "Scope",
    phase: "intake",
    checkpoint: "review_scope",
    workflowId: "scope",
  },
  {
    methodId: "context_build",
    label: "Context",
    phase: "context",
    checkpoint: "review_context",
    workflowId: "context",
  },
  {
    methodId: "master_script",
    label: "Script",
    phase: "script",
    checkpoint: "review_master_script",
    workflowId: "script",
  },
  {
    methodId: "scene_prompt_plan",
    label: "Prompts",
    phase: "script_prompts",
    checkpoint: "review_script_prompts",
    workflowId: "prompts",
  },
  {
    methodId: "reference_images",
    label: "Refs",
    phase: "references",
    checkpoint: "review_bound_references",
    workflowId: "references",
  },
  {
    methodId: "storyboard_sheets",
    label: "Boards",
    phase: "storyboards",
    checkpoint: "review_storyboards",
    workflowId: "storyboards",
  },
  {
    methodId: "video_sequence",
    label: "Video",
    phase: "video",
    checkpoint: "review_video_batch",
    workflowId: "generation",
  },
  {
    methodId: "continuity_audit",
    label: "Audit",
    phase: "critique",
    checkpoint: "review_repairs",
    workflowId: "critique",
  },
  {
    methodId: "timeline_assembly",
    label: "Timeline",
    phase: "timeline",
    checkpoint: "review_timeline",
    workflowId: "timeline",
  },
];

const LOCAL_METHOD_PHASE_BY_ID = Object.fromEntries(
  LOCAL_METHOD_PHASES.map((phase) => [phase.methodId, phase]),
) as Record<AnvilMethodId, (typeof LOCAL_METHOD_PHASES)[number]>;

function normalizeLocalMethodId(value: string | null | undefined): AnvilMethodId {
  return value && value in LOCAL_METHOD_PHASE_BY_ID ? (value as AnvilMethodId) : "scope_intake";
}

function localMethodPhase(methodId: string | null | undefined) {
  return LOCAL_METHOD_PHASE_BY_ID[normalizeLocalMethodId(methodId)];
}

function nextLocalMethodId(methodId: string | null | undefined): AnvilMethodId {
  // Legacy method IDs remain valid, but the public sample does not choose a workflow step.
  return normalizeLocalMethodId(methodId);
}

const INITIAL_AGENT_WORKFLOW_STATE: AgentWorkflowState = {
  activeId: "scope",
  completedIds: [],
  lastToolName: null,
  phaseMood: "passive",
  phaseVerb: "Ready",
  status: "idle",
  updatedAt: 0,
};

function appendWorkflowCheckpoint(
  ids: AgentWorkflowCheckpointId[],
  id: AgentWorkflowCheckpointId,
) {
  return ids.includes(id) ? ids : [...ids, id];
}

function workflowPathCheckpoint(path: string): AgentWorkflowCheckpointId | null {
  const clean = String(path || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!clean) return null;
  if (
    clean === "ANVIL.md" ||
    clean.startsWith(".forge/") ||
    clean.startsWith("story/") ||
    clean.startsWith("canon/") ||
    clean.startsWith("context/")
  ) {
    return "context";
  }
  if (clean.startsWith("script/") || clean.includes("master-script")) return "script";
  if (clean.startsWith("scenes/")) return "scenes";
  if (clean.startsWith("shots/") || clean.startsWith("prompts/") || clean.startsWith("beats/")) {
    return "prompts";
  }
  if (
    clean.startsWith("assets/characters/") ||
    clean.startsWith("assets/locations/") ||
    clean.startsWith("assets/props/")
  ) {
    return "references";
  }
  if (clean.startsWith("assets/keyframes/") || clean.includes("storyboard")) return "storyboards";
  if (clean.startsWith("videos/") || clean.startsWith("assets/videos/")) return "generation";
  return null;
}

function collectWorkflowPathHints(args: Record<string, unknown>) {
  const paths: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && value.trim()) paths.push(value.trim());
  };
  push(args.path);
  push(args.to);
  push(args.mediaPath);
  push(args.videoPath);
  if (Array.isArray(args.paths)) {
    for (const item of args.paths) push(item);
  }
  if (Array.isArray(args.items)) {
    for (const item of args.items as Array<Record<string, unknown>>) {
      if (!item || typeof item !== "object") continue;
      push(item.path);
      push(item.to);
      push(item.mediaPath);
    }
  }
  return paths;
}

function workflowCheckpointForTool(call: ToolCall): AgentWorkflowCheckpointId {
  for (const path of collectWorkflowPathHints(call.args || {})) {
    const checkpoint = workflowPathCheckpoint(path);
    if (checkpoint) return checkpoint;
  }

  switch (call.name) {
    case "prefetch_context":
    case "read_project_context":
    case "read_story_bundle":
    case "list_magic_docs":
    case "read_magic_doc":
    case "create_magic_doc":
    case "update_magic_doc":
      return "context";
    case "list_scripts":
    case "create_script":
    case "set_active_script":
      return "script";
    case "create_scene":
    case "delete_scene":
    case "list_scenes":
    case "read_scene_bundle":
      return "scenes";
    case "create_prompt":
    case "delete_prompt":
    case "list_prompts":
    case "read_prompt_bundle":
    case "build_render_bundle":
    case "tighten_scene":
    case "set_prompt_continuity":
      return "prompts";
    case "generate_image":
    case "stage_reference_media":
    case "create_asset_entry":
    case "create_asset_entries":
    case "update_asset_entry":
    case "attach_media":
    case "move_asset_entry":
    case "sync_assets_from_disk":
      return "references";
    case "extract_frame":
      return "storyboards";
    case "generate_video":
    case "render_prompt_sequence":
    case "query_takes":
      return "generation";
    case "describe_images":
    case "compare_images":
    case "pick_best_reference":
    case "set_keeper":
    case "clear_keeper":
      return "critique";
    case "build_timeline":
    case "list_timeline":
    case "timeline_add_clip":
    case "timeline_remove_clip":
    case "timeline_move_clip":
    case "timeline_split_clip":
    case "timeline_set_trim":
    case "timeline_set_volume":
    case "timeline_set_fade":
    case "timeline_set_enabled":
    case "timeline_set_label":
    case "apply_timeline_batch":
    case "export_timeline":
      return "timeline";
    default:
      return "context";
  }
}

function advanceAgentWorkflowFromTool(
  current: AgentWorkflowState,
  call: ToolCall,
): AgentWorkflowState {
  const nextActiveId = workflowCheckpointForTool(call);
  const completedIds =
    current.status === "running" && current.activeId !== nextActiveId
      ? appendWorkflowCheckpoint(current.completedIds, current.activeId)
      : current.completedIds;

  return {
    ...current,
    activeId: nextActiveId,
    completedIds,
    lastToolName: call.name,
    status: "running",
    updatedAt: Date.now(),
  };
}

function completeAgentWorkflowTool(
  current: AgentWorkflowState,
  call: ToolCall,
  ok: boolean,
): AgentWorkflowState {
  const checkpoint = workflowCheckpointForTool(call);
  return {
    ...current,
    activeId: checkpoint,
    completedIds: ok
      ? appendWorkflowCheckpoint(current.completedIds, checkpoint)
      : current.completedIds,
    lastToolName: call.name,
    status: ok ? current.status : "error",
    updatedAt: Date.now(),
  };
}

function AgentWorkflowProgress({
  state,
  queuedCount,
}: {
  state: AgentWorkflowState;
  queuedCount: number;
}) {
  const activeIndex = AGENT_WORKFLOW_CHECKPOINTS.findIndex((step) => step.id === state.activeId);
  const active = AGENT_WORKFLOW_CHECKPOINTS[activeIndex] || AGENT_WORKFLOW_CHECKPOINTS[0];
  const statusLabel =
    state.status === "idle"
      ? "Ready"
      : state.status === "done"
        ? "Done"
        : state.status === "error"
          ? "Needs attention"
          : state.status === "cancelled"
            ? "Stopped"
            : state.phaseVerb || "Working";
  const stateLabel =
    state.status === "idle"
      ? "Ready for local workflow"
      : `${active.label} · ${statusLabel}`;

  return (
    <section
      className={`agent-workflow-panel is-${state.status} mood-${state.phaseMood}`}
      aria-label="Local workflow checkpoints"
    >
      <div className="agent-workflow-status">
        <span className="agent-workflow-kicker">Local workflow</span>
        <span className="agent-workflow-current">
          <span className="agent-workflow-current-dot" aria-hidden="true" />
          {stateLabel}
        </span>
        {queuedCount > 0 ? (
          <span className="agent-workflow-queue">{queuedCount} queued</span>
        ) : null}
      </div>
      <div className="agent-workflow-steps" role="list">
        {AGENT_WORKFLOW_CHECKPOINTS.map((step) => {
          const isActive = step.id === state.activeId && state.status !== "idle";
          const isDone = state.completedIds.includes(step.id);
          return (
            <div
              key={step.id}
              className={[
                "agent-workflow-step",
                isActive ? "active" : "",
                isDone ? "done" : "",
              ].filter(Boolean).join(" ")}
              role="listitem"
              title={step.label}
              aria-label={`${step.label}${isActive ? ", current" : isDone ? ", done" : ""}`}
            >
              <span className="agent-workflow-step-mark" aria-hidden="true" />
              <span className="agent-workflow-step-label">{step.short}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ScopeIntakePanel({
  busy,
  draft,
  onChange,
  onReset,
  onSubmit,
}: {
  busy: boolean;
  draft: ScopeIntakeDraft;
  onChange: <K extends keyof ScopeIntakeDraft>(key: K, value: ScopeIntakeDraft[K]) => void;
  onReset: () => void;
  onSubmit: () => void;
}) {
  const canSubmit = Boolean(draft.premise.trim() || draft.goal.trim() || draft.references.trim());
  const renderOptions = <K extends keyof typeof SCOPE_INTAKE_OPTIONS>(
    key: K,
    label: string,
  ) => (
    <div className="scope-intake-field">
      <div className="scope-intake-label">{label}</div>
      <div className="scope-intake-options">
        {SCOPE_INTAKE_OPTIONS[key].map((option) => {
          const active = draft[key] === option;
          return (
            <button
              key={option}
              className={`scope-intake-option${active ? " active" : ""}`}
              onClick={() => onChange(key, option as ScopeIntakeDraft[K])}
              type="button"
            >
              {option}
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <section className="scope-intake-panel" aria-label="Project notes">
      <div className="scope-intake-head">
        <div>
          <div className="scope-intake-kicker">New project flow</div>
          <h3>Define the video first</h3>
        </div>
        <button className="scope-intake-reset" type="button" onClick={onReset}>
          Reset
        </button>
      </div>
      <div className="scope-intake-grid">
        {renderOptions("format", "Format")}
        {renderOptions("runtime", "Runtime")}
        {renderOptions("aspect", "Aspect")}
        {renderOptions("qualityTarget", "Quality")}
        {renderOptions("budget", "Budget")}
        {renderOptions("provider", "Provider")}
      </div>
      <label className="scope-intake-field wide">
        <span className="scope-intake-label">Premise</span>
        <textarea
          value={draft.premise}
          onChange={(event) => onChange("premise", event.target.value)}
          placeholder="What is the film, ad, or short about?"
          rows={3}
        />
      </label>
      <div className="scope-intake-two">
        <label className="scope-intake-field">
          <span className="scope-intake-label">Tone</span>
          <input
            value={draft.tone}
            onChange={(event) => onChange("tone", event.target.value)}
            placeholder="Dark cinematic, playful, premium..."
          />
        </label>
        <label className="scope-intake-field">
          <span className="scope-intake-label">Platform</span>
          <input
            value={draft.platform}
            onChange={(event) => onChange("platform", event.target.value)}
            placeholder="YouTube, TikTok, website..."
          />
        </label>
      </div>
      <div className="scope-intake-two">
        <label className="scope-intake-field">
          <span className="scope-intake-label">Goal</span>
          <input
            value={draft.goal}
            onChange={(event) => onChange("goal", event.target.value)}
            placeholder="Impress, sell, explain, test..."
          />
        </label>
        <label className="scope-intake-field">
          <span className="scope-intake-label">Audience</span>
          <input
            value={draft.audience}
            onChange={(event) => onChange("audience", event.target.value)}
            placeholder="Who should care?"
          />
        </label>
      </div>
      <label className="scope-intake-field wide">
        <span className="scope-intake-label">References</span>
        <textarea
          value={draft.references}
          onChange={(event) => onChange("references", event.target.value)}
          placeholder="Films, brands, visual references, URLs, no-go examples..."
          rows={2}
        />
      </label>
      <label className="scope-intake-field wide">
        <span className="scope-intake-label">Must include / avoid</span>
        <textarea
          value={draft.mustInclude}
          onChange={(event) => onChange("mustInclude", event.target.value)}
          placeholder="Characters, product claims, locations, constraints..."
          rows={2}
        />
      </label>
      <label className="scope-intake-field wide">
        <span className="scope-intake-label">Notes</span>
        <textarea
          value={draft.notes}
          onChange={(event) => onChange("notes", event.target.value)}
          placeholder="Anything else the agent should know before writing files."
          rows={2}
        />
      </label>
      <div className="scope-intake-checkpoint">
        The agent will populate context, Master Script, scenes, and capped prompts, then stop before references.
      </div>
      <button
        className="scope-intake-submit"
        disabled={busy || !canSubmit}
        onClick={onSubmit}
        type="button"
      >
        Start script plan
      </button>
    </section>
  );
}

function PhaseCheckpointPanel({
  checkpoint,
  disabled,
  onContinue,
  onReview,
  onRevise,
}: {
  checkpoint: PhaseCheckpoint;
  disabled: boolean;
  onContinue: () => void;
  onReview: () => void;
  onRevise: () => void;
}) {
  const copy = phaseCheckpointCopy(checkpoint.checkpoint);
  return (
    <section className="phase-checkpoint-panel" aria-label={copy.title}>
      <div className="phase-checkpoint-copy">
        <div className="phase-checkpoint-kicker">Checkpoint</div>
        <h3>{copy.title}</h3>
        <p>{copy.body}</p>
      </div>
      <div className="phase-checkpoint-actions">
        <button type="button" onClick={onReview} disabled={disabled}>
          Review
        </button>
        <button type="button" onClick={onRevise} disabled={disabled}>
          {copy.revise}
        </button>
        <button type="button" className="primary" onClick={onContinue} disabled={disabled}>
          {copy.primary}
        </button>
      </div>
    </section>
  );
}

type TimelineAssemblyClip = {
  key: string;
  persistedId: string | null;
  sceneId: string;
  sceneTitle: string;
  shotId: string | null;
  shotTitle: string;
  promptId: string;
  promptTitle: string;
  video: VideoEntry | null;
  durationSec: number;
  segmentIndex: number | null;
  segmentCount: number | null;
  trimInSec: number | null;
  trimOutSec: number | null;
  enabled: boolean;
};

function roundTimelineSec(value: number) {
  return Math.round(value * 100) / 100;
}

function normalizedTimelineTrimIn(value: number | null | undefined) {
  const next = Number(value);
  return Number.isFinite(next) && next > 0.01 ? roundTimelineSec(next) : null;
}

function normalizedTimelineTrimOut(value: number | null | undefined, fullDurationSec: number) {
  const next = Number(value);
  if (!Number.isFinite(next) || next <= 0) return null;
  const capped = fullDurationSec > 0 ? Math.min(next, fullDurationSec) : next;
  if (fullDurationSec > 0 && capped >= fullDurationSec - 0.05) return null;
  return roundTimelineSec(capped);
}

function effectiveTimelineWindow(
  fullDurationSec: number,
  trimInSec: number | null | undefined,
  trimOutSec: number | null | undefined,
) {
  const safeDuration = Math.max(0, Number(fullDurationSec) || 0);
  const rawIn = Number(trimInSec);
  const rawOut = Number(trimOutSec);
  const unclampedIn = Number.isFinite(rawIn) && rawIn > 0 ? rawIn : 0;
  const unclampedOut = Number.isFinite(rawOut) && rawOut > 0 ? rawOut : safeDuration;
  const cappedOut = safeDuration > 0 ? Math.min(unclampedOut, safeDuration) : unclampedOut;
  const cappedIn = safeDuration > 0 ? Math.min(unclampedIn, cappedOut) : Math.min(unclampedIn, cappedOut);
  return {
    inSec: roundTimelineSec(Math.max(0, cappedIn)),
    outSec: roundTimelineSec(Math.max(cappedIn, cappedOut)),
  };
}

function timelinePlayableDuration(
  clip: Pick<TimelineAssemblyClip, "video" | "durationSec" | "trimInSec" | "trimOutSec">,
) {
  const fullDurationSec = Math.max(
    0,
    Number(clip.video?.durationSec) || Number(clip.durationSec) || 0,
  );
  if (!clip.video) return fullDurationSec;
  const window = effectiveTimelineWindow(fullDurationSec, clip.trimInSec, clip.trimOutSec);
  return roundTimelineSec(Math.max(0, window.outSec - window.inSec));
}

function isTimelineClipEnabled(
  clip: Pick<TimelineAssemblyClip, "enabled" | "video">,
) {
  return clip.enabled !== false && Boolean(clip.video);
}

function timelineActiveDuration(
  clip: Pick<TimelineAssemblyClip, "enabled" | "video" | "durationSec" | "trimInSec" | "trimOutSec">,
) {
  return isTimelineClipEnabled(clip) ? timelinePlayableDuration(clip) : 0;
}

function buildPersistedTimelineFromClips(clips: TimelineAssemblyClip[]): PersistedTimelineClip[] {
  return clips.map((clip, orderIndex) => {
    const fullDurationSec = Math.max(
      0,
      Number(clip.video?.durationSec) || Number(clip.durationSec) || 0,
    );
    return {
      id: clip.persistedId || `tl-${clip.promptId}`,
      promptId: clip.promptId,
      videoId: clip.video?.id || null,
      inSec: clip.video ? normalizedTimelineTrimIn(clip.trimInSec) : null,
      outSec: clip.video ? normalizedTimelineTrimOut(clip.trimOutSec, fullDurationSec) : null,
      enabled: clip.enabled !== false,
      orderIndex,
    };
  });
}

function resolveTimelineAssembly(project: ForgeProjectData | null | undefined): TimelineAssemblyClip[] {
  if (!project) return [];
  const videos = Array.isArray(project.videos) ? project.videos : [];
  const videosById = new Map(videos.map((video) => [video.id, video]));
  const masterScript = (project.script || []).find((entry): entry is ScriptEntry => entry.kind === "master");
  const scenes = sortScenesForDisplay(
    (project.script || []).filter((entry): entry is ScriptEntry => entry.kind === "scene"),
    masterScript?.content || "",
  );
  const prompts = Array.isArray(project.prompts) ? project.prompts : [];
  const autoClips: TimelineAssemblyClip[] = [];
  const pushPromptClip = (scene: ScriptEntry, prompt: PromptEntry) => {
    const takes = videos.filter((video) => video.promptId === prompt.id);
    const keeper = selectPromptKeeper(takes);
    const durationSec = Math.max(
      0,
      Number(keeper?.durationSec) || Number(prompt.durationSec) || 0,
    );

    autoClips.push({
      key: `auto:${prompt.id}`,
      persistedId: null,
      sceneId: scene.id,
      sceneTitle: scene.title || "Scene",
      shotId: null,
      shotTitle: "Scene prompt",
      promptId: prompt.id,
      promptTitle: prompt.title || "Prompt",
      video: keeper,
      durationSec,
      segmentIndex: typeof prompt.segmentIndex === "number" ? prompt.segmentIndex : null,
      segmentCount: typeof prompt.segmentCount === "number" ? prompt.segmentCount : null,
      trimInSec: keeper ? normalizedTimelineTrimIn(keeper.trimInSec) : null,
      trimOutSec: keeper ? normalizedTimelineTrimOut(keeper.trimOutSec, durationSec) : null,
      enabled: true,
    });
  };

  for (const scene of scenes) {
    const scenePrompts = sortPromptsForDisplay(
      prompts.filter((prompt) => promptBelongsToSceneForDisplay(prompt, scene)),
      scene,
    );
    for (const prompt of scenePrompts) {
      pushPromptClip(scene, prompt);
    }
  }

  const persistedOrder = (Array.isArray(project.timeline) ? project.timeline : [])
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const orderA = Number(a.entry?.orderIndex);
      const orderB = Number(b.entry?.orderIndex);
      const safeA = Number.isFinite(orderA) ? orderA : a.index;
      const safeB = Number.isFinite(orderB) ? orderB : b.index;
      return safeA - safeB || a.index - b.index;
    })
    .map(({ entry }) => entry);

  if (!persistedOrder.length) return autoClips;

  const autoByPromptId = new Map(autoClips.map((clip) => [clip.promptId, clip]));
  const usedPromptIds = new Set<string>();
  const orderedClips: TimelineAssemblyClip[] = [];

  for (let index = 0; index < persistedOrder.length; index += 1) {
    const entry = persistedOrder[index];
    if (!entry?.promptId) continue;
    const baseClip = autoByPromptId.get(entry.promptId);
    if (!baseClip) continue;
    const explicitVideo = entry.videoId ? videosById.get(entry.videoId) || null : null;
    const resolvedVideo =
      explicitVideo && explicitVideo.promptId === baseClip.promptId ? explicitVideo : baseClip.video;
    const durationSec = Math.max(
      0,
      Number(resolvedVideo?.durationSec) || Number(baseClip.durationSec) || 0,
    );
    const trimInSource =
      entry.inSec ??
      (resolvedVideo?.id === baseClip.video?.id ? baseClip.trimInSec : resolvedVideo?.trimInSec);
    const trimOutSource =
      entry.outSec ??
      (resolvedVideo?.id === baseClip.video?.id ? baseClip.trimOutSec : resolvedVideo?.trimOutSec);
    const persistedId =
      typeof entry.id === "string" && entry.id.trim()
        ? entry.id.trim()
        : `tl-${entry.promptId}-${index + 1}`;

    orderedClips.push({
      ...baseClip,
      key: persistedId,
      persistedId,
      video: resolvedVideo,
      durationSec,
      trimInSec: resolvedVideo ? normalizedTimelineTrimIn(trimInSource) : null,
      trimOutSec: resolvedVideo
        ? normalizedTimelineTrimOut(trimOutSource, durationSec)
        : null,
      enabled: entry.enabled !== false,
    });
    usedPromptIds.add(entry.promptId);
  }

  for (const clip of autoClips) {
    if (!usedPromptIds.has(clip.promptId)) orderedClips.push(clip);
  }

  return orderedClips;
}

type VideosWorkspaceSlot = {
  key: string;
  shotId: string | null;
  shotTitle: string;
  sceneId: string;
  sceneTitle: string;
  promptId: string;
  promptTitle: string;
  segmentIndex: number | null;
  segmentCount: number | null;
  video: VideoEntry | null;
  takes: VideoEntry[];
  destSubPath: string;
  shotDestSubPath: string;
};

const MASTER_VIDEO_DEST_SUBPATH = "_master";
const NEEDS_REVIEW_VIDEO_SCOPE = "needs-review";

function isMasterVideoEntry(video: VideoEntry | null | undefined) {
  if (!video || video.sceneId || video.shotId || video.promptId) return false;
  const cleanPath = String(video.path || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const relativeVideoPath = cleanPath.replace(/^assets\/videos\/?/, "");
  return relativeVideoPath === MASTER_VIDEO_DEST_SUBPATH || relativeVideoPath.startsWith(`${MASTER_VIDEO_DEST_SUBPATH}/`);
}

function sortVideosForBin<T extends Pick<VideoEntry, "generatedAt" | "path" | "takeIndex">>(items: T[]) {
  return [...items].sort(
    (a, b) =>
      String(b.generatedAt || "").localeCompare(String(a.generatedAt || "")) ||
      (Number(b.takeIndex) || 0) - (Number(a.takeIndex) || 0) ||
      String(a.path || "").localeCompare(String(b.path || "")),
  );
}

function sortPromptTakesForDisplay<T extends Pick<VideoEntry, "generatedAt" | "path" | "takeIndex" | "isKeeper">>(
  items: T[],
) {
  return [...items].sort(
    (a, b) =>
      Number(Boolean(b.isKeeper)) - Number(Boolean(a.isKeeper)) ||
      (Number(b.takeIndex) || 0) - (Number(a.takeIndex) || 0) ||
      String(b.generatedAt || "").localeCompare(String(a.generatedAt || "")) ||
      String(a.path || "").localeCompare(String(b.path || "")),
  );
}

function selectPromptKeeper<T extends VideoEntry>(items: T[]) {
  const explicitKeeper = items.find((video) => video.isKeeper);
  return explicitKeeper || sortPromptTakesForDisplay(items)[0] || null;
}

type VideosWorkspaceScope =
  | { kind: "master" }
  | { kind: "review" }
  | { kind: "scene"; sceneId: string; sceneTitle: string; scenePath: string | null }
  | {
      kind: "shot";
      shotId: string;
      shotTitle: string;
      sceneTitle: string;
      shotPath: string | null;
      scenePath: string | null;
    }
  | {
      kind: "prompt";
      promptId: string;
      shotId: string | null;
      shotTitle: string;
      sceneId: string | null;
      sceneTitle: string;
      promptPath: string | null;
      shotPath: string | null;
      scenePath: string | null;
    }
  | {
      kind: "take";
      videoId: string;
      sceneId: string | null;
      shotId: string | null;
      promptId: string | null;
    };

type VideosWorkspaceState = {
  videos: VideoEntry[];
  scenes: ScriptEntry[];
  prompts: PromptEntry[];
  selectedVideo: VideoEntry | null;
  selectedScene: ScriptEntry | null;
  selectedPrompt: PromptEntry | null;
  scope: VideosWorkspaceScope;
  timeline: VideosWorkspaceSlot[];
  scopedSlots: VideosWorkspaceSlot[];
  scopedLooseVideos: VideoEntry[];
  masterVideos: VideoEntry[];
  previewVideo: VideoEntry | null;
  previewSlot: VideosWorkspaceSlot | null;
  scopedVideoCount: number;
  scopedDuration: number;
  scopeLabel: string;
};

function slugFromWorkspacePath(path: string) {
  return (path || "").split("/").pop()?.replace(/\.[^.]+$/, "") || "";
}

function resolveVideosWorkspaceState(
  project: ForgeProjectData | null | undefined,
  selectedId: string,
): VideosWorkspaceState {
  const videos = Array.isArray(project?.videos) ? project.videos : [];
  const masterScript = (project?.script || []).find((entry): entry is ScriptEntry => entry.kind === "master");
  const scenes = sortScenesForDisplay(
    (project?.script || []).filter((entry): entry is ScriptEntry => entry.kind === "scene"),
    masterScript?.content || "",
  );
  const prompts = Array.isArray(project?.prompts) ? project.prompts : [];
  const timeline: VideosWorkspaceSlot[] = [];
  const masterVideos = sortVideosForBin(videos.filter((video) => isMasterVideoEntry(video)));
  const sceneIds = new Set(scenes.map((scene) => scene.id));
  const promptIds = new Set(prompts.map((prompt) => prompt.id));
  const needsReviewVideos = sortVideosForBin(
    videos.filter((video) => {
      if (isMasterVideoEntry(video)) return false;
      if (!video.promptId && !video.sceneId) return true;
      if (video.promptId && !promptIds.has(video.promptId)) return true;
      if (video.sceneId && !sceneIds.has(video.sceneId)) return true;
      return false;
    }),
  );
  for (const scene of scenes) {
    const sceneSlug = slugFromWorkspacePath(scene.path || "");
    const scenePrompts = sortPromptsForDisplay(
      prompts.filter((prompt) => promptBelongsToSceneForDisplay(prompt, scene)),
      scene,
    );
    for (const prompt of scenePrompts) {
      const promptSlug = slugFromWorkspacePath(prompt.path || "");
      const takes = sortPromptTakesForDisplay(videos.filter((video) => video.promptId === prompt.id));
      const keeper = selectPromptKeeper(takes);
      timeline.push({
        key: prompt.id,
        shotId: null,
        shotTitle: "Scene prompt",
        sceneId: scene.id,
        sceneTitle: scene.title || "Scene",
        promptId: prompt.id,
        promptTitle: prompt.title || "Prompt",
        segmentIndex: typeof prompt.segmentIndex === "number" ? prompt.segmentIndex : null,
        segmentCount: typeof prompt.segmentCount === "number" ? prompt.segmentCount : null,
        video: keeper,
        takes,
        destSubPath: [sceneSlug, promptSlug].filter(Boolean).join("/"),
        shotDestSubPath: sceneSlug,
      });
    }
  }

  const selectedVideo = videos.find((video) => video.id === selectedId) || null;
  const selectedPrompt =
    !selectedVideo && selectedId
      ? prompts.find((prompt) => prompt.id === selectedId) || null
      : null;
  const selectedScene =
    !selectedVideo && !selectedPrompt && selectedId
      ? scenes.find((scene) => scene.id === selectedId) || null
      : null;
  const selectedPromptScene = selectedPrompt
    ? scenes.find((scene) => scene.id === selectedPrompt.sceneId) ||
      scenes.find((scene) => promptBelongsToSceneForDisplay(selectedPrompt, scene)) ||
      null
    : null;

  const scope: VideosWorkspaceScope = selectedVideo
    ? {
        kind: "take",
        videoId: selectedVideo.id,
        sceneId: selectedVideo.sceneId,
        shotId: selectedVideo.shotId,
        promptId: selectedVideo.promptId,
      }
    : selectedId === NEEDS_REVIEW_VIDEO_SCOPE
      ? { kind: "review" }
      : selectedPrompt
        ? {
            kind: "prompt",
            promptId: selectedPrompt.id,
            shotId: null,
            shotTitle: "Scene prompt",
            sceneId: selectedPromptScene?.id || null,
            sceneTitle: selectedPromptScene?.title || "Scene",
            promptPath: selectedPrompt.path ?? null,
            shotPath: null,
            scenePath: selectedPromptScene?.path ?? null,
          }
      : selectedScene
        ? {
            kind: "scene",
            sceneId: selectedScene.id,
            sceneTitle: selectedScene.title || "Scene",
            scenePath: selectedScene.path ?? null,
          }
        : { kind: "master" };

  const scopedSlots =
    scope.kind === "master"
      ? []
      : scope.kind === "review"
        ? []
      : scope.kind === "scene"
        ? timeline.filter((slot) => slot.sceneId === scope.sceneId)
          : scope.kind === "prompt"
            ? timeline.filter((slot) => slot.promptId === scope.promptId)
          : scope.kind === "take" && scope.promptId
            ? timeline.filter((slot) => slot.promptId === scope.promptId)
              : scope.kind === "take" && scope.sceneId
                ? timeline.filter((slot) => slot.sceneId === scope.sceneId)
            : [];

  const scopedLooseVideos = sortVideosForBin(
    scope.kind === "master"
      ? masterVideos
      : scope.kind === "review"
        ? needsReviewVideos
      : scope.kind === "scene"
        ? videos.filter((video) => video.sceneId === scope.sceneId && !video.promptId)
          : scope.kind === "prompt"
            ? []
          : scope.kind === "take" && isMasterVideoEntry(selectedVideo)
            ? masterVideos
              : scope.kind === "take" && scope.sceneId && !scope.promptId
                ? videos.filter((video) => video.sceneId === scope.sceneId && !video.promptId)
                : [],
  );

  const previewVideo =
    selectedVideo
    || scopedLooseVideos[0]
    || scopedSlots.find((slot) => slot.video)?.video
    || (scope.kind === "take" ? videos.find((video) => video.id === scope.videoId) || null : null);
  const previewSlot = previewVideo
    ? timeline.find((slot) => slot.video?.id === previewVideo.id)
      || timeline.find((slot) => slot.takes.some((take) => take.id === previewVideo.id))
      || (previewVideo.promptId
        ? timeline.find((slot) => slot.promptId === previewVideo.promptId) || null
        : null)
    : null;
  const scopedVideoCount =
    scopedLooseVideos.length + scopedSlots.reduce((count, slot) => count + slot.takes.length, 0);
  const scopedDuration = scopedSlots.reduce(
    (total, slot) => total + slot.takes.reduce((sum, video) => sum + (Number(video.durationSec) || 0), 0),
    scopedLooseVideos.reduce((total, video) => total + (Number(video.durationSec) || 0), 0),
  );
  const scopeLabel =
    scope.kind === "master"
      ? "Stored videos"
      : scope.kind === "review"
        ? "Needs review"
      : scope.kind === "scene"
        ? scope.sceneTitle
          : scope.kind === "prompt"
            ? `${scope.sceneTitle} · ${scope.shotTitle}`
          : previewSlot
            ? `${previewSlot.sceneTitle} · ${previewSlot.shotTitle}`
            : previewVideo && isMasterVideoEntry(previewVideo)
              ? "Stored videos"
              : "Needs review";

  return {
    videos,
    scenes,
    prompts,
    selectedVideo,
    selectedScene,
    selectedPrompt,
    scope,
    timeline,
    scopedSlots,
    scopedLooseVideos,
    masterVideos,
    previewVideo,
    previewSlot,
    scopedVideoCount,
    scopedDuration,
    scopeLabel,
  };
}

const CHAT_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const CHAT_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const CHAT_DATE_YEAR_FORMATTER = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "2-digit" });
const CHAT_FULL_TIMESTAMP_FORMATTER = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const MarkdownEditor = lazy(async () => {
  const module = await import("./components/MarkdownEditor");
  return { default: module.MarkdownEditor };
});
const ProjectTerminalPanel = lazy(async () => {
  const module = await import("./components/ProjectTerminalPanel");
  return { default: module.ProjectTerminalPanel };
});
const SettingsModal = lazy(async () => {
  const module = await import("./components/SettingsModal");
  return { default: module.SettingsModal };
});
const SkillLibraryModal = lazy(async () => {
  const module = await import("./components/SkillLibraryModal");
  return { default: module.SkillLibraryModal };
});
class WorkshopSurfaceErrorBoundary extends Component<
  { children: ReactNode; onError?: (message: string) => void },
  { errorMessage: string | null }
> {
  constructor(props: { children: ReactNode; onError?: (message: string) => void }) {
    super(props);
    this.state = { errorMessage: null };
  }

  static getDerivedStateFromError(error: unknown) {
    return {
      errorMessage: error instanceof Error ? error.message : "Workshop failed to render.",
    };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    const message = error instanceof Error ? error.message : "Workshop failed to render.";
    console.error("Workshop surface crashed", error, info.componentStack);
    this.props.onError?.(message);
  }

  render() {
    if (this.state.errorMessage) {
      return (
        <div className="workshop-error-panel" role="alert">
          <div className="workshop-error-kicker">Workshop</div>
          <h2>Could not open Workshop</h2>
          <p>{this.state.errorMessage}</p>
        </div>
      );
    }

    return this.props.children;
  }
}

function MarkdownEditorFallback({ className }: { className?: string }) {
  return (
    <div className={`${className || ""} editor-loading`} aria-busy="true">
      Loading editor…
    </div>
  );
}

function LazyMarkdownEditor(props: MarkdownEditorProps) {
  return (
    <Suspense fallback={<MarkdownEditorFallback className={props.className} />}>
      <MarkdownEditor {...props} />
    </Suspense>
  );
}

function isSameLocalDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function parseChatDate(timestamp: string) {
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date : null;
}

function formatChatTimestamp(timestamp: string) {
  const date = parseChatDate(timestamp);
  if (!date) return "";
  const now = new Date();
  if (isSameLocalDay(date, now)) return CHAT_TIME_FORMATTER.format(date);
  return (date.getFullYear() === now.getFullYear() ? CHAT_DATE_FORMATTER : CHAT_DATE_YEAR_FORMATTER).format(date);
}

function formatFullChatTimestamp(timestamp: string) {
  const date = parseChatDate(timestamp);
  return date ? CHAT_FULL_TIMESTAMP_FORMATTER.format(date) : timestamp;
}

function revealActiveNavItemInOwnScroller(behavior: ScrollBehavior) {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      ".item-row.active, button.asset-tile-trigger[aria-pressed='true'], .asset-tile.active .asset-tile-trigger",
    ),
  );
  const active = candidates.find((node) => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  if (!active) return;

  const scroller = active.closest<HTMLElement>(".item-list, .asset-grid, .videos-clip-grid");
  if (!scroller) return;

  const itemRect = active.getBoundingClientRect();
  const scrollerRect = scroller.getBoundingClientRect();
  const padding = 10;
  let nextTop = scroller.scrollTop;

  if (itemRect.top < scrollerRect.top + padding) {
    nextTop -= scrollerRect.top + padding - itemRect.top;
  } else if (itemRect.bottom > scrollerRect.bottom - padding) {
    nextTop += itemRect.bottom - (scrollerRect.bottom - padding);
  } else {
    return;
  }

  scroller.scrollTo({ top: Math.max(0, nextTop), behavior });
}

interface AgentTask {
  attachments: ChatAttachment[];
  assistantMessage: ChatMessage;
  focusLock: FocusScope;
  hammerLabel: string | null;
  checkpointAfterDone?: PhaseCheckpoint | null;
  methodId?: string | null;
  promptText: string;
  requestTarget: ChatTarget;
  selection: { itemId: string; section: SectionId } | null;
  userMessage: ChatMessage;
}

const AGENT_MUTATING_TOOL_NAMES = new Set([
  "write_file",
  "edit_file",
  "create_scene",
  "create_prompt",
  "create_asset_entry",
  "create_asset_entries",
  "delete_asset_entry",
  "delete_asset_entries",
  "move_asset_entry",
  "set_title",
  "rename_paths",
  "sync_assets_from_disk",
  "sync_library_from_disk",
  "normalize_asset_media_names",
  "attach_media",
  "detach_media",
  "delete_media",
  "link_library_assets",
  "refresh_project_index",
  "run_safe_maintenance",
  "set_prompt_continuity",
  "create_magic_doc",
  "update_magic_doc",
  "delete_magic_doc",
  "update_pinboard",
  "remove_pinboard",
  "add_memory_topic",
  "delete_memory_topic",
  "generate_image",
  "generate_video",
  "generate_music",
  "tighten_scene",
  "set_active_script",
  "create_script",
  "timeline_add_clip",
  "timeline_remove_clip",
  "timeline_move_clip",
  "timeline_split_clip",
  "timeline_set_trim",
  "timeline_set_volume",
  "timeline_set_fade",
]);

function sanitizeChatMessage(message: ChatMessage): ChatMessage {
  const text =
    message.role === "assistant"
      ? sanitizeVisibleAgentText(message.text || "")
      : message.hammerAction
        ? message.text || buildCommandMessageText(message.hammerAction, message.target || null)
        : message.text || "";
  const sanitized: ChatMessage = {
    id: message.id,
    role: message.role,
    text,
    timestamp: message.timestamp,
    target: message.target || null,
    state: message.state === "pending" || message.state === "queued" || message.state === "error"
      ? message.state
      : "ready",
  };
  if (message.attachments?.length) sanitized.attachments = message.attachments;
  if (message.hammerAction) sanitized.hammerAction = message.hammerAction;
  return sanitized;
}

const AGENT_AVATAR_STORAGE_KEY = "anvil:agent-avatar:v2";
const LEGACY_AGENT_AVATAR_STORAGE_KEY = "anvil:agent-avatar:v1";
const DESKTOP_AUTH_PLACEHOLDER_EMAIL = "local@anvil.app";
const ANVIL_ACCOUNT_URL = "https://www.myriadanvil.com/app";
const ANVIL_DESKTOP_AGENT_ENDPOINT = "https://www.myriadanvil.com/api/anvil-agent/turn";

export function App() {
  const reducedMotion = useReducedMotion();
  const [handle, setHandle] = useState<ForgeProjectHandle | null>(null);
  const [activeSection, setActiveSection] = useState<SectionId>("story");
  const [lastAssetSection, setLastAssetSection] = useState<AssetSectionId>("media");
  const [mediaIndex, setMediaIndex] = useState<Record<string, MediaRecord>>({});
  // Live search box above the asset grid. Filters by name/label (case-
  // insensitive substring). Cleared on section switch so the box feels
  // fresh each time you move between Characters / Locations / etc.
  const [assetGridQuery, setAssetGridQuery] = useState("");
  const [allMediaCategoryFilter, setAllMediaCategoryFilter] = useState<AllMediaCategoryId>("unassigned");
  const [assetGridVisibleState, setAssetGridVisibleState] = useState<{ key: string; limit: number }>({
    key: "",
    limit: LOCAL_UI_LIMITS.assetGridInitialItems,
  });
  const assetSearchInputRef = useRef<HTMLInputElement | null>(null);
  const [selectedMediaIds, setSelectedMediaIds] = useState<Record<string, string>>({});
  const [brokenMediaIds, setBrokenMediaIds] = useState<Record<string, boolean>>({});
  const [selectedIds, setSelectedIds] = useState<Record<SectionId, string>>({
    story: "",
    script: "",
    dialogue: "",
    beats: "",
    shots: "",
    prompts: "",
    media: "",
    characters: "",
    locations: "",
    props: "",
    keyframes: "",
    audio: "",
    videos: "",
    timeline: "",
    workshop: "",
  });
  const [dialogueContext, setDialogueContext] = useState<{ sceneId: string; shotId: string }>({
    sceneId: "",
    shotId: "",
  });
  // Timeline playback state — null when idle, an index into the clips
  // array when assembly playback is walking the timeline. isPlaying is
  // a separate flag so pausing mid-clip keeps the current index.
  const [timelinePlayIndex, setTimelinePlayIndex] = useState<number | null>(null);
  const [timelinePlayStopAfterIndex, setTimelinePlayStopAfterIndex] = useState<number | null>(null);
  const [timelineIsPlaying, setTimelineIsPlaying] = useState<boolean>(false);
  // Live trim-drag state — non-null while the user is mid-drag on a
  // clip edge. Commits land on project.timeline's per-clip trim window,
  // not on the source VideoEntry, so Timeline behaves like a cut and
  // Videos remains the source-browser.
  const [draggingTrim, setDraggingTrim] = useState<{
    clipKey: string;
    videoId: string;
    edge: "in" | "out";
    startX: number;
    initialInSec: number;
    initialOutSec: number;
    fullDurationSec: number;
    clipWidthPx: number;
    previewInSec: number;
    previewOutSec: number;
  } | null>(null);
  // Clip reorder state — `reorderId` is the clip being dragged,
  // `reorderHoverId` is the clip its cursor is currently over (so the UI
  // can show a drop indicator). Persisted order lives on project.timeline.
  const [reorderId, setReorderId] = useState<string | null>(null);
  const [reorderHoverId, setReorderHoverId] = useState<string | null>(null);
  const timelineResolvedClipsRef = useRef<TimelineAssemblyClip[]>([]);
  const videoBinPreviewPlayerRef = useRef<HTMLVideoElement | null>(null);
  const videoBinAutoplayVideoIdRef = useRef<string | null>(null);
  const timelinePreviewVideoRef = useRef<HTMLVideoElement | null>(null);
  const videoPreviewLightboxPlayerRef = useRef<HTMLVideoElement | null>(null);
  const draggingTrimRef = useRef(draggingTrim);
  draggingTrimRef.current = draggingTrim;

  const playVideoBinPreview = useCallback(() => {
    const player = videoBinPreviewPlayerRef.current;
    if (!player) return;
    const playPromise = player.play();
    if (playPromise && typeof playPromise.catch === "function") {
      void playPromise.catch((err) => {
        // Surface Chromium media errors instead of silencing them — the
        // silent .catch pattern was the meta-bug behind Bug 3 / the
        // timeline audio death-spiral. Same shape, applied to App-level
        // <audio>/<video> previews.
        console.warn("[anvil] media play() rejected", { err: (err as { name?: string })?.name || String(err) });
      });
    }
  }, []);

  // Window-level mouse handlers for trim dragging. Re-attaches only when
  // the drag identity changes (drag-start / drag-end) — pixel movements
  // during the drag update setDraggingTrim's preview fields without
  // re-running this effect. Commits land on project.timeline on mouseup;
  // the local preview state carries the live trim until then so the UI
  // can render the new in/out points instantly.
  useEffect(() => {
    if (!draggingTrim) return;
    const initial = draggingTrim;
    const onMove = (event: MouseEvent) => {
      const deltaX = event.clientX - initial.startX;
      const secsPerPx = initial.clipWidthPx > 0
        ? initial.fullDurationSec / initial.clipWidthPx
        : 0;
      const deltaSec = deltaX * secsPerPx;
      setDraggingTrim((prev) => {
        if (!prev) return prev;
        if (prev.edge === "in") {
          const nextIn = Math.max(
            0,
            Math.min(prev.initialInSec + deltaSec, prev.previewOutSec - 0.25),
          );
          return { ...prev, previewInSec: Math.round(nextIn * 100) / 100 };
        }
        const nextOut = Math.min(
          prev.fullDurationSec,
          Math.max(prev.initialOutSec + deltaSec, prev.previewInSec + 0.25),
        );
        return { ...prev, previewOutSec: Math.round(nextOut * 100) / 100 };
      });
    };
    const onUp = () => {
      const latest = draggingTrimRef.current;
      if (!latest) return;
      const activeProject = project;
      setDraggingTrim(null);
      if (!activeProject) return;
      // Round trims to .01s and drop trivial changes.
      const movedIn = Math.abs(latest.previewInSec - latest.initialInSec) > 0.05;
      const movedOut = Math.abs(latest.previewOutSec - latest.initialOutSec) > 0.05;
      if (!movedIn && !movedOut) return;
      const currentClips = timelineResolvedClipsRef.current;
      if (!currentClips.length) return;
      const nextClips = currentClips.map((clip) => {
        if (clip.key !== latest.clipKey) return clip;
        return {
          ...clip,
          trimInSec: latest.previewInSec > 0.01 ? latest.previewInSec : null,
          trimOutSec:
            latest.previewOutSec > 0 && latest.previewOutSec < latest.fullDurationSec - 0.05
              ? latest.previewOutSec
              : null,
        };
      });
      timelineResolvedClipsRef.current = nextClips;
      queueSave({
        ...activeProject,
        timeline: buildPersistedTimelineFromClips(nextClips),
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // Only re-attach when the drag starts/stops, not on every preview tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draggingTrim?.clipKey, draggingTrim?.videoId, draggingTrim?.edge]);
  useEffect(() => {
    const previewVideo = timelinePreviewVideoRef.current;
    if (!previewVideo) return;
    if (timelineIsPlaying) {
      const playPromise = previewVideo.play();
      if (playPromise && typeof playPromise.catch === "function") {
        void playPromise.catch((err) => {
        // Surface Chromium media errors instead of silencing them — the
        // silent .catch pattern was the meta-bug behind Bug 3 / the
        // timeline audio death-spiral. Same shape, applied to App-level
        // <audio>/<video> previews.
        console.warn("[anvil] media play() rejected", { err: (err as { name?: string })?.name || String(err) });
      });
      }
      return;
    }
    previewVideo.pause();
  }, [timelineIsPlaying, timelinePlayIndex, selectedIds.timeline]);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  // Tick every 30s so the "Saved Xs/Xm ago" label stays reasonably fresh.
  // `persist()` also ticks immediately after a save so the first update
  // lands without delay.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const interval = window.setInterval(() => setNowTick((v) => v + 1), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  // Draggable column widths — persisted so the layout survives across
  // sessions. Defaults match the original CSS grid template (432/380).
  const RAIL_MIN = 280;
  const RAIL_MAX = 640;
  // Chat min raised from 300 → 360. The terminal panel renders xterm inside
  // here; widths under ~360 force ~38-char columns and break words mid-word
  // (zsh prompt + agent dialogue both become hard to read on the right edge).
  const CHAT_MIN = 360;
  const CHAT_MAX = 720;
  const CHAT_DEFAULT = 480;
  const LIBRARY_MIN = 240;
  const LIBRARY_MAX = 560;
  const LAYOUT_STORAGE_KEY = "anvil:layout-widths:v1";
  const [agentAvatar, setAgentAvatar] = useState<AgentAvatarId>(() => {
    try {
      const raw = localStorage.getItem(AGENT_AVATAR_STORAGE_KEY);
      if (raw && AGENT_AVATAR_OPTIONS.some((option) => option.id === raw)) {
        return raw as AgentAvatarId;
      }
      const legacy = localStorage.getItem(LEGACY_AGENT_AVATAR_STORAGE_KEY);
      if (legacy && AGENT_AVATAR_OPTIONS.some((option) => option.id === legacy) && legacy !== "fantasy") {
        return legacy as AgentAvatarId;
      }
      return "anvil";
    } catch {
      return "anvil";
    }
  });
  const [railWidth, setRailWidth] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
      if (!raw) return 432;
      const parsed = JSON.parse(raw);
      const n = Number(parsed?.rail);
      return Number.isFinite(n) ? Math.min(RAIL_MAX, Math.max(RAIL_MIN, n)) : 432;
    } catch { return 432; }
  });
  const [chatWidth, setChatWidth] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
      if (!raw) return CHAT_DEFAULT;
      const parsed = JSON.parse(raw);
      const n = Number(parsed?.chat);
      if (!Number.isFinite(n)) return CHAT_DEFAULT;
      // One-time migration: 380 was the old default and is too narrow for
      // the terminal. Bump anyone still on it to the new default. Users who
      // explicitly dragged the divider to a different value keep their pick.
      if (n === 380) return CHAT_DEFAULT;
      return Math.min(CHAT_MAX, Math.max(CHAT_MIN, n));
    } catch { return CHAT_DEFAULT; }
  });
  const [libraryPanelWidth, setLibraryPanelWidth] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
      if (!raw) return 320;
      const parsed = JSON.parse(raw);
      const n = Number(parsed?.library);
      return Number.isFinite(n) ? Math.min(LIBRARY_MAX, Math.max(LIBRARY_MIN, n)) : 320;
    } catch { return 320; }
  });
  const [draggingDivider, setDraggingDivider] = useState<"rail" | "chat" | "library" | null>(null);
  useEffect(() => {
    try {
      localStorage.setItem(
        LAYOUT_STORAGE_KEY,
        JSON.stringify({ rail: railWidth, chat: chatWidth, library: libraryPanelWidth }),
      );
    } catch {}
  }, [railWidth, chatWidth, libraryPanelWidth]);
  useEffect(() => {
    try {
      localStorage.setItem(AGENT_AVATAR_STORAGE_KEY, agentAvatar);
      localStorage.removeItem(LEGACY_AGENT_AVATAR_STORAGE_KEY);
    } catch {}
  }, [agentAvatar]);

  // Narrow viewports need smaller chrome so the editor stays usable. At
  // 1200px and below we clamp rail + chat so the editor gets at least
  // 440px. Above that threshold we leave the user's saved widths alone.
  useEffect(() => {
    function clampToViewport() {
      const vw = window.innerWidth;
      if (vw >= 1200) return;
      const editorMin = 440;
      const maxRail = Math.min(RAIL_MAX, Math.max(RAIL_MIN, Math.floor((vw - editorMin) * 0.55)));
      const maxChat = Math.min(CHAT_MAX, Math.max(CHAT_MIN, Math.floor((vw - editorMin) * 0.45)));
      setRailWidth((w) => Math.min(w, maxRail));
      setChatWidth((w) => Math.min(w, maxChat));
    }
    clampToViewport();
    window.addEventListener("resize", clampToViewport);
    return () => window.removeEventListener("resize", clampToViewport);
  }, []);

  const startDividerDrag = useCallback((which: "rail" | "chat" | "library", startEvent: React.MouseEvent) => {
    startEvent.preventDefault();
    const startX = startEvent.clientX;
    const startRail = railWidth;
    const startChat = chatWidth;
    const startLibrary = libraryPanelWidth;
    setDraggingDivider(which);
    const onMove = (e: MouseEvent) => {
      const delta = e.clientX - startX;
      if (which === "rail") {
        const next = Math.min(RAIL_MAX, Math.max(RAIL_MIN, startRail + delta));
        setRailWidth(next);
      } else if (which === "library") {
        // Library panel grows to the right (positive delta widens it).
        const next = Math.min(LIBRARY_MAX, Math.max(LIBRARY_MIN, startLibrary + delta));
        setLibraryPanelWidth(next);
      } else {
        // Chat grows when dragging LEFT (negative delta), so invert.
        const next = Math.min(CHAT_MAX, Math.max(CHAT_MIN, startChat - delta));
        setChatWidth(next);
      }
    };
    const onUp = () => {
      setDraggingDivider(null);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [railWidth, chatWidth, libraryPanelWidth]);
  // Session inbox / notice stack. Existing callsites still use the
  // setNotice(text) form; richer metadata is optional.
  const [notices, setNotices] = useState<Notice[]>([]);
  const [noticeLog, setNoticeLog] = useState<Notice[]>([]);
  const [showNoticeLog, setShowNoticeLog] = useState(false);
  const [showLowSignalNotices, setShowLowSignalNotices] = useState(false);
  const noticeLogTitleId = useId();
  // Unread tracking — badge counts notices added since the last time the
  // user opened the bell. Total log still grows; "unread"
  // is just a high-water mark the badge reads from.
  const [noticeLogReadCount, setNoticeLogReadCount] = useState(0);
  const unreadNoticeCount = Math.max(0, noticeLog.length - noticeLogReadCount);
  const noticeTimersRef = useRef<Map<string, number>>(new Map());
  // Clear any outstanding notice timers on unmount so we don't leak
  // window.setTimeout refs across session lifetimes.
  useEffect(() => {
    const timers = noticeTimersRef.current;
    return () => {
      for (const timerId of timers.values()) {
        window.clearTimeout(timerId);
      }
      timers.clear();
    };
  }, []);
  useEffect(() => {
    if (!showNoticeLog) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setShowNoticeLog(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showNoticeLog]);
  const dismissVisibleNotice = useCallback((noticeId: string) => {
    const timerId = noticeTimersRef.current.get(noticeId);
    if (timerId) {
      window.clearTimeout(timerId);
      noticeTimersRef.current.delete(noticeId);
    }
    setNotices((current) => current.filter((notice) => notice.id !== noticeId));
  }, []);
  const clearNoticeHistory = useCallback(() => {
    setNoticeLog([]);
    setNoticeLogReadCount(0);
    setShowLowSignalNotices(false);
  }, []);
  const setNotice = useCallback((text: string | null, type: NoticeType = "success", options: NoticeOptions = {}) => {
    if (!text) {
      setNotices([]);
      return;
    }
    const inferred = inferNoticeDefaults(text, type);
    const timestamp = Date.now();
    const baseNotice: Notice = {
      id: globalThis.crypto?.randomUUID?.() || `n-${timestamp}-${Math.random()}`,
      text,
      type,
      timestamp,
      category: options.category || inferred.category,
      importance: options.importance || inferred.importance,
      visibility: options.visibility || inferred.visibility,
      dedupeKey: options.dedupeKey || inferred.dedupeKey,
      count: 1,
      action: options.action,
    };
    setNoticeLog((current) => {
      const lastIndex = [...current]
        .map((notice, index) => ({ notice, index }))
        .reverse()
        .find(({ notice }) =>
          notice.dedupeKey === baseNotice.dedupeKey &&
          timestamp - notice.timestamp <= NOTICE_DEDUPE_WINDOW_MS,
        )?.index;
      if (typeof lastIndex === "number") {
        const next = [...current];
        const previous = next[lastIndex];
        next[lastIndex] = {
          ...previous,
          text: baseNotice.text,
          type: baseNotice.type,
          timestamp,
          category: baseNotice.category,
          importance: baseNotice.importance,
          visibility: baseNotice.visibility,
          action: baseNotice.action || previous.action,
          count: previous.count + 1,
        };
        return next.slice(-40);
      }
      return [...current.slice(-39), baseNotice];
    });
    if (baseNotice.visibility === "log") return;
    let visibleId = baseNotice.id;
    let visibleCount = 1;
    setNotices((current) => {
      const existing = current.find((notice) => notice.dedupeKey === baseNotice.dedupeKey);
      if (existing) {
        visibleId = existing.id;
        visibleCount = existing.count + 1;
        return current.map((notice) =>
          notice.id === existing.id
            ? {
                ...notice,
                text: baseNotice.text,
                type: baseNotice.type,
                timestamp,
                category: baseNotice.category,
                importance: baseNotice.importance,
                visibility: baseNotice.visibility,
                action: baseNotice.action || notice.action,
                count: visibleCount,
              }
            : notice,
        );
      }
      return [...current.slice(-2), baseNotice];
    });
    const previousTimer = noticeTimersRef.current.get(visibleId);
    if (previousTimer) {
      window.clearTimeout(previousTimer);
    }
    const timerId = window.setTimeout(() => {
      setNotices((current) => current.filter((notice) => notice.id !== visibleId));
      noticeTimersRef.current.delete(visibleId);
    }, baseNotice.importance === "attention" ? 9000 : 6000);
    noticeTimersRef.current.set(visibleId, timerId);
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [chatDraft, setChatDraft] = useState("");
  const [scopeIntakeDraft, setScopeIntakeDraft] = useState<ScopeIntakeDraft>(
    DEFAULT_SCOPE_INTAKE_DRAFT,
  );
  const [scopeIntakeOpen, setScopeIntakeOpen] = useState(false);
  const [phaseCheckpoint, setPhaseCheckpoint] = useState<PhaseCheckpoint | null>(null);
  const [composerAttachments, setComposerAttachments] = useState<ChatAttachment[]>([]);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [expandedMessageIds, setExpandedMessageIds] = useState<Record<string, boolean>>({});
  const [chatLoading, setChatLoading] = useState(false);
  const [compactChat, setCompactChat] = useState(true);
  const [touchedPaths, setTouchedPaths] = useState<Record<string, number>>({});
  const [agentEditingClipIds, setAgentEditingClipIds] = useState<Set<string>>(() => new Set());
  const [agentWorkflowState, setAgentWorkflowState] = useState<AgentWorkflowState>(
    INITIAL_AGENT_WORKFLOW_STATE,
  );
  const chatListRef = useRef<HTMLDivElement | null>(null);
  const chatStickToBottomRef = useRef(true);
  const touchedTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const agentClipIdTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const markTouchedPaths = useCallback((paths: string[], linger = 14_000) => {
    if (!paths.length) return;
    const now = Date.now();
    setTouchedPaths((current) => {
      const next = { ...current };
      for (const path of paths) next[path] = now;
      return next;
    });
    for (const path of paths) {
      const previousTimer = touchedTimers.current.get(path);
      if (previousTimer) clearTimeout(previousTimer);
      const timer = setTimeout(() => {
        setTouchedPaths((current) => {
          const rest = { ...current };
          delete rest[path];
          return rest;
        });
        touchedTimers.current.delete(path);
      }, linger);
      touchedTimers.current.set(path, timer);
    }
  }, []);
  const markAgentEditingClips = useCallback((ids: string[], linger = 14_000) => {
    if (!ids.length) return;
    setAgentEditingClipIds((current) => {
      const next = new Set(current);
      for (const id of ids) next.add(id);
      return next;
    });
    for (const id of ids) {
      const prev = agentClipIdTimers.current.get(id);
      if (prev) clearTimeout(prev);
      const timer = setTimeout(() => {
        setAgentEditingClipIds((current) => {
          if (!current.has(id)) return current;
          const next = new Set(current);
          next.delete(id);
          return next;
        });
        agentClipIdTimers.current.delete(id);
      }, linger);
      agentClipIdTimers.current.set(id, timer);
    }
  }, []);
  const [sending, setSending] = useState(false);
  const [inFlightRequestId, setInFlightRequestId] = useState<string | null>(null);
  // Wall-clock heartbeat tick. Re-evaluated every 3s while a request
  // is in-flight so pending messages can show "Ns since last activity"
  // and flip to a soft-stuck warning past a threshold. No effect when
  // nothing's in flight — avoids a useless background render loop.
  const [heartbeatNow, setHeartbeatNow] = useState(() => Date.now());
  useEffect(() => {
    if (!inFlightRequestId) return;
    const id = setInterval(() => setHeartbeatNow(Date.now()), 3_000);
    return () => clearInterval(id);
  }, [inFlightRequestId]);
  // Local "cancelling" latch — flips to true the instant the user clicks
  // Stop, so the UI shows feedback immediately instead of waiting for the
  // server-side runForgeAgent to actually unwind (which can take a turn
  // or two if a tool call is mid-flight). Cleared when inFlightRequestId
  // goes null.
  const [cancelling, setCancelling] = useState(false);
  const [agentQueue, setAgentQueue] = useState<AgentTask[]>([]);
  const [busy, setBusy] = useState<null | "create" | "create-pick" | "open" | "open-pick" | "upload" | "delete" | "settings" | "magic-sync" | "trim">(null);
  const startupProjectDir = useMemo(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("projectDir");
  }, []);
  const launchHideAtRef = useRef(performance.now() + (startupProjectDir ? 1200 : 900));
  const [startupOpenSettled, setStartupOpenSettled] = useState(() => !startupProjectDir);
  const [launchScreenPhase, setLaunchScreenPhase] = useState<"visible" | "exiting" | "hidden">("visible");
  const [appVersion, setAppVersion] = useState<{ version: string; build: string; commitCount?: number; appName?: string; variant?: string } | null>(null);
  const [desktopAuthState, setDesktopAuthState] = useState<"checking" | "signed-out" | "signed-in">(
    () => (SHOW_DESKTOP_ACCOUNT_GATE ? "checking" : "signed-in"),
  );
  const [desktopAuthBusy, setDesktopAuthBusy] = useState(false);
  const [desktopAuthError, setDesktopAuthError] = useState<string | null>(null);
  const [desktopAuthStatus, setDesktopAuthStatus] = useState<string | null>(null);
  // Plan / billing entitlement. Stub until Codex 1's `/api/billing/status`
  // ships; the shape is locked so the UI is wired now and only the data
  // source needs to be swapped in Phase 2 of the launch plan.
  const [accountEntitlement, setAccountEntitlement] = useState<AccountEntitlement>({
    plan: "free",
    status: "unknown",
  });
  const [recentProjects, setRecentProjects] = useState<RecentProjectEntry[]>([]);
  const [projectNameDraft, setProjectNameDraft] = useState("Anvil Project");
  const [showCreateProjectModal, setShowCreateProjectModal] = useState(false);
  const [showCreateStoryDocModal, setShowCreateStoryDocModal] = useState(false);
  const [storyDocTitleDraft, setStoryDocTitleDraft] = useState("");
  const [storyDocGroupDraft, setStoryDocGroupDraft] = useState<ContextDocGroup>("canon");
  const [storyDocSectionMode, setStoryDocSectionMode] = useState<"existing" | "new">("existing");
  const [storyDocCustomSectionDraft, setStoryDocCustomSectionDraft] = useState("");
  const [selectedMagicDocId, setSelectedMagicDocId] = useState<string | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<ForgeProjectData["settings"]>({
    hookToken: "",
    hookUrl: "",
    remoteAgentUrl: "",
    remoteAgentToken: "",
    remoteAgentTokenSaved: false,
    remoteAgentEnabled: false,
    methodServerUrl: "",
    methodServerToken: "",
    methodServerEnabled: false,
    sessionKey: "",
    agentProvider: "openclaw",
    agentBinPath: "",
    agentApprovalMode: "autonomous",
    agentBypassPermissions: true,
    agentMediaStaging: "direct",
    enabledSkillAddons: ["cinematic"],
    disabledSkills: [],
    agentModel: "",
    apiKey: "",
    anvilCredits: {
      image: { enabled: false, model: "nanobanana-pro" },
      video: { enabled: false, model: "seedance-2.0" },
    },
  });
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showSkillLibraryModal, setShowSkillLibraryModal] = useState(false);
  const [agentProviders, setAgentProviders] = useState<Array<{ id: string; label: string; installHint: string }>>([]);
  useEffect(() => {
    if (!showSettingsModal) return;
    void window.forgeDesktop.listAgentProviders()
      .then((list) => setAgentProviders(Array.isArray(list) ? list : []))
      .catch(() => setAgentProviders([]));
  }, [showSettingsModal]);
  useEffect(() => {
    if (!SHOW_DESKTOP_ACCOUNT_GATE) return;
    let cancelled = false;
    setDesktopAuthState("checking");
    void window.forgeDesktop.getDesktopAccountSession()
      .then((result) => {
        if (cancelled) return;
        const entitlement: AccountEntitlement = result?.entitlement || { plan: "free", status: "unknown" };
        setAccountEntitlement(entitlement);
        if (result?.ok) {
          setDesktopAuthState("signed-in");
          setDesktopAuthStatus(null);
          setDesktopAuthError(null);
        } else {
          setDesktopAuthState("signed-out");
          setDesktopAuthStatus(result?.message || "Sign in to Anvil to continue.");
        }
      })
      .catch((authError) => {
        if (cancelled) return;
        setDesktopAuthState("signed-out");
        setDesktopAuthError(authError instanceof Error ? authError.message : "Account check failed.");
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const [showAssetPreviewLightbox, setShowAssetPreviewLightbox] = useState(false);
  const [showVideoPreviewLightbox, setShowVideoPreviewLightbox] = useState(false);
  const [videoNoteDraft, setVideoNoteDraft] = useState("");
  const [assetVideoTrimDrafts, setAssetVideoTrimDrafts] = useState<Record<string, { start: string; end: string }>>({});
  const lightboxDescId = useId();
  const videoLightboxDescId = useId();
  // Capture activeElement when the lightbox opens; restore on close so
  // keyboard users land back on the asset-hero-media trigger they came
  // from instead of dropping focus to <body>.
  useEffect(() => {
    if (!showAssetPreviewLightbox) return;
    const prevFocus = document.activeElement as HTMLElement | null;
    return () => {
      if (prevFocus && typeof prevFocus.focus === "function" && document.contains(prevFocus)) {
        prevFocus.focus();
      }
    };
  }, [showAssetPreviewLightbox]);
  useEffect(() => {
    if (!showVideoPreviewLightbox) return;
    const prevFocus = document.activeElement as HTMLElement | null;
    return () => {
      if (prevFocus && typeof prevFocus.focus === "function" && document.contains(prevFocus)) {
        prevFocus.focus();
      }
    };
  }, [showVideoPreviewLightbox]);
  const [showHeaderMenu, setShowHeaderMenu] = useState(false);
  const [showChatMenu, setShowChatMenu] = useState(false);
  const [showAvatarMenu, setShowAvatarMenu] = useState(false);
  const [projectContextDraft, setProjectContextDraft] = useState("");
  const [projectContextSelected, setProjectContextSelected] = useState(false);
  const [agentNoteSelected, setAgentNoteSelected] = useState(false);
  const [agentNoteDraft, setAgentNoteDraft] = useState("");
  const [assetContextSelected, setAssetContextSelected] = useState(false);
  const [assetLibrarySelected, setAssetLibrarySelected] = useState(false);
  const [assetContextGuide, setAssetContextGuide] = useState<AssetContextGuideEntry | null>(null);
  const [assetContextGuideLoading, setAssetContextGuideLoading] = useState(false);
  const [pinboard, setPinboard] = useState<PinboardEntry[]>([]);
  const [pinboardFilter, setPinboardFilter] = useState<string>("all");
  const [pinboardSelected, setPinboardSelected] = useState(false);
  const [focusedPinboardId, setFocusedPinboardId] = useState<string | null>(null);
  // Editorial state for the Pinboard: a draft for the "+ New pin"
  // form, and an in-place edit draft keyed by the entry being edited.
  // Users can author their own entries + overwrite any existing one
  // without waiting for the agent to propose first.
  const [newPinDraft, setNewPinDraft] = useState<{ category: PinboardEntry["category"]; text: string } | null>(null);
  const [editingPinId, setEditingPinId] = useState<string | null>(null);
  const [editingPinDraft, setEditingPinDraft] = useState("");
  // Collapsed-state map for the Context sidebar's groups. In-memory only —
  // all groups start expanded each session. Extending to persistent storage
  // if we ever need it is a one-line localStorage write.
  const [collapsedContextGroups, setCollapsedContextGroups] = useState<Record<string, boolean>>({});
  // "Use this media" picker on the Media library view — pick a
  // library file and link it to a character / location / prop /
  // keyframe / audio entry.
  const [attachPickerOpen, setAttachPickerOpen] = useState(false);
  const [attachPickerSection, setAttachPickerSection] = useState<"characters" | "locations" | "props" | "keyframes" | "audio">("characters");
  const [attachBusy, setAttachBusy] = useState(false);
  // Esc closes the inline attach picker. Backdrop-click isn't a fit since the
  // picker renders inline (not modal); the only other dismissal is the close
  // button — keyboard users were stuck without this.
  useEffect(() => {
    if (!attachPickerOpen) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setAttachPickerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [attachPickerOpen]);
  // Reverse direction: "Pick from library" — browse the project
  // media index and attach a selected file TO the currently-open
  // asset entry. Lets users populate a character/location entry
  // from already-uploaded media without re-running the OS file
  // picker (which would duplicate files on disk).
  const [libraryPanelOpen, setLibraryPanelOpen] = useState(false);
  const [libraryPanelFilter, setLibraryPanelFilter] = useState<"all" | "image" | "audio">("all");
  const [libraryPanelQuery, setLibraryPanelQuery] = useState("");
  // Temporary trash view. Internally this still uses assets/inbox/ for
  // compatibility with existing projects, but user-facing behavior is a
  // recoverable trash lane: deleted media can be restored to All media.
  const [inboxView, setInboxView] = useState(false);
  // Sub-tab for sections that ship a Single | Sheet split.
  // Characters: Single (matte ref headshot) ↔ Sheet (multi-angle + identity card).
  // Keyframes: Single (one-frame still) ↔ Sheet (storyboard sheet across shots).
  // Other sections ignore this state. Resets to "single" on section change so
  // the user always lands on the canonical view first.
  const [assetSubView, setAssetSubView] = useState<AssetEntryKind>("single");
  // Audio sub-tab — Music | Voice | SFX | Ambient. Discriminator is the
  // existing `audioKind` field on AssetEntry. Legacy entries with no
  // audioKind default to "music" per the type comment, so they land in
  // the Music tab automatically. Resets to "music" on section change.
  const [audioSubView, setAudioSubView] = useState<AudioKind>("music");
  const [inboxFiles, setInboxFiles] = useState<InboxFile[]>([]);
  const [inboxBusy, setInboxBusy] = useState<string | null>(null);
  const [inboxPreview, setInboxPreview] = useState<InboxFile | null>(null);
  const [pendingInboxJobs, setPendingInboxJobs] = useState<InboxPendingJob[]>([]);
  const [pendingInboxMarkers, setPendingInboxMarkers] = useState<InboxPendingJob[]>([]);
  const visiblePendingInboxJobs = [
    ...pendingInboxJobs,
    ...pendingInboxMarkers.filter(
      (marker) => !pendingInboxJobs.some((job) => job.id === marker.id),
    ),
  ];
  const visiblePendingInboxJobCount = visiblePendingInboxJobs.length;
  // Re-render once a second while jobs are running so the elapsed-time
  // counter on each pending tile actually moves. Only wired up when at
  // least one job is in flight to avoid background renders.
  const [, setInboxJobTick] = useState(0);
  useEffect(() => {
    if (visiblePendingInboxJobCount === 0) return;
    const handle = window.setInterval(() => setInboxJobTick((tick) => tick + 1), 1000);
    return () => window.clearInterval(handle);
  }, [visiblePendingInboxJobCount]);
  const deferredAssetGridQuery = useDeferredValue(assetGridQuery);
  const deferredLibraryPanelQuery = useDeferredValue(libraryPanelQuery);
  // Highlight state for the panel's file-drop target. Flips true on
  // `dragenter` with a File-type drag, flips back on leave or drop.
  const [libraryDragOver, setLibraryDragOver] = useState(false);
  const [videosDragOver, setVideosDragOver] = useState(false);
  const pinboardPanelRef = useRef<HTMLDivElement | null>(null);
  const projectContextSaveTimer = useRef<number | null>(null);
  const agentNoteSaveTimer = useRef<number | null>(null);
  const assetContextGuideSaveTimer = useRef<number | null>(null);
  const [sectionFormatSelected, setSectionFormatSelected] = useState<FormatKind | null>(null);
  const [sectionFormatDraft, setSectionFormatDraft] = useState<Record<FormatKind, string>>({
    script: "",
    prompts: "",
  });
  const sectionFormatSaveTimer = useRef<number | null>(null);
  const saveTimer = useRef<number | null>(null);
  const chatSaveTimer = useRef<number | null>(null);
  const chatReadyRef = useRef(false);
  const ignoreProjectChangesUntilRef = useRef(0);
  const activeProjectDirRef = useRef("");
  // Unmount cleanup — clear every outstanding debounced save timer so a
  // pending persist() doesn't fire against a stale (torn-down) component.
  // Timers themselves are cleared mid-flight in their respective handlers,
  // but this covers the case where App unmounts before the debounce fires.
  useEffect(() => {
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      if (chatSaveTimer.current) window.clearTimeout(chatSaveTimer.current);
      if (projectContextSaveTimer.current) window.clearTimeout(projectContextSaveTimer.current);
      if (agentNoteSaveTimer.current) window.clearTimeout(agentNoteSaveTimer.current);
      if (assetContextGuideSaveTimer.current) window.clearTimeout(assetContextGuideSaveTimer.current);
      if (sectionFormatSaveTimer.current) window.clearTimeout(sectionFormatSaveTimer.current);
    };
  }, []);
  const lastDraftItemKeyRef = useRef("");
  const [editingField, setEditingField] = useState<null | "title" | "content" | "duration">(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [contentDraft, setContentDraft] = useState("");
  const [durationDraft, setDurationDraft] = useState("");
  // Inline row-badge duration editor. Keyed by `${section}:${itemId}` so
  // exactly one row is in edit mode at a time. Replaces the earlier
  // `window.prompt()`-based flow that silently returned null in Electron
  // (native prompt() is blocked in BrowserWindow webContents by default,
  // so Codex's ae8370b click-to-edit shipped non-functional).
  const [editingDurationKey, setEditingDurationKey] = useState<string | null>(null);
  // Draft state for the inline duration editor lives inside RuntimeBadge;
  // App only tracks which row is editing. Previously draft was App state,
  // and every keystroke re-rendered all ~1500 badges on large projects.
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [agentPrimarySelected, setAgentPrimarySelected] = useState(false);
  const [expandedPrimary, setExpandedPrimary] = useState<PrimarySectionId | null>(null);
  const [scriptSubrailHidden, setScriptSubrailHidden] = useState(false);
  const [draggingItemId, setDraggingItemId] = useState<string | null>(null);
  const draggingItemIdRef = useRef<string | null>(null);
  const dragOverRef = useRef<DragOver | null>(null);
  const suppressDraggedClickRef = useRef<{ id: string | null; until: number }>({
    id: null,
    until: 0,
  });
  // Drop indicator carries position (above/below target row) so users can
  // see exactly where the dragged item will land instead of guessing from
  // a whole-row highlight. State updates only when id OR position changes
  // — raw mousemove events fire at ~60hz, so this gates the re-render rate.
  type DragOver = {
    id: string;
    mode: "group" | "reorder";
    position: "above" | "below" | "before" | "after";
  };
  const [dragOver, setDragOver] = useState<DragOver | null>(null);
  // Focus-mode: structured scope — file, scene subtree, shot, readonly, or none.
  // Focus-lock state. ALWAYS scoped to the currently-open project — a lock on
  // Project A would otherwise carry scenePath/shotPath refs that don't resolve
  // in Project B, making every agent write refuse silently. Reset effect below
  // watches activeProjectDir and clears on switch.
  const [focusScope, setFocusScope] = useState<FocusScope>({ kind: "none" });
  const {
    open: lockMenuOpen,
    setOpen: setLockMenuOpen,
    close: closeLockMenu,
    ref: lockMenuRef,
  } = usePopover<HTMLDivElement>();
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);
  const assetEditorRef = useRef<HTMLDivElement | null>(null);
  const assetVideoPlayerRef = useRef<HTMLVideoElement | null>(null);
  const editorTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const headerMenuRef = useRef<HTMLDivElement | null>(null);
  const chatMenuRef = useRef<HTMLDivElement | null>(null);
  const avatarMenuRef = useRef<HTMLDivElement | null>(null);
  const creatingItemRef = useRef(false);
  const [creatingSection, setCreatingSection] = useState<SectionId | null>(null);
  const agentQueueRef = useRef<AgentTask[]>([]);

  const project = handle?.project ?? null;
  const videosWorkspace = useMemo(
    () => resolveVideosWorkspaceState(project, selectedIds.videos || ""),
    [project, selectedIds.videos],
  );
  const videoBinItems = useMemo(
    () => sortVideosForBin(Array.isArray(project?.videos) ? project.videos : []),
    [project?.videos],
  );
  const selectedVideo = videoBinItems.find((video) => video.id === selectedIds.videos) || null;
  type AssetCollectionKey = "library" | "characters" | "locations" | "props" | "keyframes" | "audio";
  type AssetOwner = { section: AssetSectionId; collectionKey: AssetCollectionKey };
  const assetOwnerById = useMemo(() => {
    const next = new Map<string, AssetOwner>();
    if (!project) return next;
    for (const section of ["characters", "locations", "props", "keyframes", "audio"] as const) {
      for (const asset of project[section] || []) {
        next.set(asset.id, { section, collectionKey: section });
      }
    }
    for (const asset of project.library || []) {
      if (!next.has(asset.id)) {
        next.set(asset.id, { section: "media", collectionKey: "library" });
      }
    }
    return next;
  }, [
    project?.audio,
    project?.characters,
    project?.keyframes,
    project?.library,
    project?.locations,
    project?.props,
  ]);
  const selectAssetItem = useCallback(
    (section: AssetSectionId, itemId: string, owner?: AssetOwner | null) => {
      setSelectedIds((current) => {
        const ownerSection = owner?.section;
        if (current[section] === itemId && (!ownerSection || current[ownerSection] === itemId)) {
          return current;
        }
        return {
          ...current,
          [section]: itemId,
          ...(ownerSection ? { [ownerSection]: itemId } : {}),
        };
      });
    },
    [],
  );
  const markMediaBroken = useCallback((mediaId: string, broken: boolean) => {
    setBrokenMediaIds((current) => {
      if (Boolean(current[mediaId]) === broken) return current;
      return { ...current, [mediaId]: broken };
    });
  }, []);
  const activeCustomSubsectionForNav =
    typeof activeSection === "string" && activeSection.startsWith("custom:")
      ? (Array.isArray(project?.customSubsections)
          ? project.customSubsections.find((sub) => sub.id === activeSection) || null
          : null)
      : null;
  const activePrimary = activeCustomSubsectionForNav?.primary || primaryForSection(activeSection);
  const selectedPrimary = SHOW_AGENT_SURFACE && agentPrimarySelected ? "agent" : activePrimary;
  // Sub-rail toggles per primary. It auto-opens when a primary has
  // built-in or custom items to show; empty primaries stay collapsed
  // until the user re-clicks the primary icon to surface the + button.
  const childRailPrimary = expandedPrimary ?? activePrimary;
  const childRailVisible = expandedPrimary !== null;
  const customSubsectionsForPrimary = useMemo(() => {
    const all = Array.isArray(project?.customSubsections) ? project!.customSubsections : [];
    return all.filter((sub) => sub.primary === childRailPrimary);
  }, [project?.customSubsections, childRailPrimary]);
  const builtinSubrailItemCount =
    childRailPrimary === "assets"
      ? ASSET_NAV_SECTIONS.length
      : childRailPrimary === "script" && !scriptSubrailHidden
        ? 1
        : 0;
  const customSubsectionLimitReached =
    customSubsectionsForPrimary.length >= LOCAL_UI_LIMITS.customSubsectionsPerPrimary;
  const subrailDensity =
    builtinSubrailItemCount + customSubsectionsForPrimary.length >= LOCAL_UI_LIMITS.compactSubrailAt
      ? "compact"
      : "normal";
  const primaryHasBuiltinSubrail = useCallback(
    (primary: PrimarySectionId) => primary === "assets" || (primary === "script" && !scriptSubrailHidden),
    [scriptSubrailHidden],
  );
  const subrailHasItems = useCallback(
    (primary: PrimarySectionId) => {
      if (primary === "script" && scriptSubrailHidden) return false;
      if (primaryHasBuiltinSubrail(primary)) return true;
      const all = Array.isArray(project?.customSubsections) ? project!.customSubsections : [];
      return all.some((sub) => sub.primary === primary);
    },
    [project?.customSubsections, primaryHasBuiltinSubrail, scriptSubrailHidden],
  );
  const subrailHasChildren = childRailVisible && subrailHasItems(childRailPrimary);
  const effectiveChatCollapsed = chatCollapsed || !SHOW_PROJECT_TERMINAL_SURFACE;

  // Pre-seed the script-primary subrail with one md-folder subsection —
  // Drafts — on the first open of any project that hasn't been seeded
  // yet. It appears ahead of the Master Script icon in the rail and
  // behaves like any user-created customSubsection (kind="docs"): list
  // of md docs + add/rename/delete. Once seeded, the meta flag flips to
  // true and never re-seeds; if the user deletes it it stays gone.
  // Existing projects with any script-primary subsections are treated
  // as already seeded so we don't pile duplicates on top. Users can add
  // more sections (Characters / Beats / Dialogue / etc.) via the rail
  // + button.
  const scriptSeedInFlightRef = useRef(false);
  useEffect(() => {
    if (!project || !handle?.projectDir) return;
    if (project.project.scriptSubsectionsSeeded) return;
    if (scriptSeedInFlightRef.current) return;
    const existing = (project.customSubsections || []).filter((sub) => sub.primary === "script");
    if (existing.length > 0) {
      // Already has script subsections — mark seeded and move on.
      queueSave({
        ...project,
        project: { ...project.project, scriptSubsectionsSeeded: true },
      });
      return;
    }
    scriptSeedInFlightRef.current = true;
    const projectDir = handle.projectDir;
    const baseProject = project;
    void (async () => {
      const seedNames = ["Drafts"];
      const created: CustomSubsection[] = [];
      for (const name of seedNames) {
        try {
          const result = await window.forgeDesktop.createCustomSubsection({
            projectDir,
            name,
            primary: "script",
            kind: "docs",
            instructions: "",
          });
          const id: CustomSubsectionId = `custom:${
            typeof crypto !== "undefined" && crypto.randomUUID
              ? crypto.randomUUID()
              : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
          }`;
          const now = new Date().toISOString();
          created.push({
            id,
            primary: "script",
            name,
            kind: "docs",
            folder: result.folder,
            instructionsPath: result.instructionsPath,
            fileExtensions: [".md"],
            createdAt: now,
            updatedAt: now,
          });
          // Seed four starter docs inside Drafts — one md file each for
          // the common "laws of the film" sections (Draft / Character /
          // Dialogue / Beat sheet). User can rename/delete any of them.
          if (name === "Drafts") {
            const starterDocs: Array<{ title: string; hint: string }> = [
              { title: "Draft", hint: "Free-form notes, early ideas, scratchpad." },
              { title: "Character", hint: "Cast bios, voice, arc." },
              { title: "Dialogue", hint: "Lines, exchanges, voice patterns." },
              { title: "Beat sheet", hint: "Structural beats, story milestones." },
            ];
            for (const doc of starterDocs) {
              try {
                const docResult = await window.forgeDesktop.createCustomSubsectionDoc(
                  projectDir,
                  result.folder,
                  doc.title,
                );
                const body = [
                  `# ${doc.title}`,
                  "",
                  `_${doc.hint}_`,
                  "",
                ].join("\n");
                await window.forgeDesktop.writeCustomSubsectionDoc(
                  projectDir,
                  docResult.path,
                  body,
                );
              } catch (docErr) {
                console.warn(`Could not seed starter doc "${doc.title}" in "${name}":`, docErr);
              }
            }
          }
        } catch (err) {
          console.warn(`Could not seed script subsection "${name}":`, err);
        }
      }
      // Match the existing commitNewSubsection pattern: closure-captured
      // project state is acceptable since the seed runs once per project
      // lifetime and the disk watcher's ignore window swallows the resulting
      // project-changed event.
      queueSave({
        ...baseProject,
        customSubsections: [...(baseProject.customSubsections || []), ...created],
        project: { ...baseProject.project, scriptSubsectionsSeeded: true },
      });
      scriptSeedInFlightRef.current = false;
    })();
  }, [project?.project.id, project?.project.scriptSubsectionsSeeded, handle?.projectDir]);

  useEffect(() => {
    if (!SHOW_WORKSHOP_SURFACE && (activeSection === "videos" || activeSection === "timeline")) {
      setActiveSection("script");
      setExpandedPrimary("script");
    }
  }, [activeSection]);

  useEffect(() => {
    setAgentPrimarySelected(false);
  }, [activeSection]);

  // Reset Single|Sheet sub-tab whenever the section changes so the user
  // lands on the canonical Single view first regardless of where they
  // last left it.
  useEffect(() => {
    setAssetSubView("single");
    setAudioSubView("music");
  }, [activeSection]);

  useEffect(() => {
    if (chatCollapsed) setAgentPrimarySelected(false);
  }, [chatCollapsed]);

  useEffect(() => {
    if (!SHOW_AGENT_SURFACE && pinboardSelected) {
      setPinboardSelected(false);
    }
    if (!SHOW_AGENT_SURFACE && focusScope.kind !== "none") {
      setFocusScope({ kind: "none" });
    }
  }, [focusScope.kind, pinboardSelected]);

  useEffect(() => {
    if (SHOW_INTERNAL_CONTEXT_SURFACES) return;
    if (agentNoteSelected) setAgentNoteSelected(false);
  }, [agentNoteSelected, assetContextSelected, assetLibrarySelected]);

  useEffect(() => {
    let cancelled = false;
    void window.forgeDesktop.getAppVersion().then((info) => {
      if (!cancelled) setAppVersion(info);
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshRecentProjects = useCallback(() => {
    return window.forgeDesktop
      .getRecentProjects()
      .then((items) => setRecentProjects(Array.isArray(items) ? items : []))
      .catch(() => setRecentProjects([]));
  }, []);

  useEffect(() => {
    if (desktopAuthState !== "signed-in") return;
    void refreshRecentProjects();
  }, [desktopAuthState, refreshRecentProjects]);

  useEffect(() => {
    activeProjectDirRef.current = handle?.projectDir || "";
  }, [handle?.projectDir]);

  const applyOpenedProject = useCallback((next: ForgeProjectHandle, noticeText: string) => {
    startTransition(() => {
      setHandle(next);
    });
    undoStack.current = [];
    redoStack.current = [];
    setNotice(noticeText);
    setError(null);
    void refreshRecentProjects();
  }, [refreshRecentProjects]);

  const suppressProjectWatcherRefresh = useCallback((ms = 1500) => {
    ignoreProjectChangesUntilRef.current = Math.max(
      ignoreProjectChangesUntilRef.current,
      Date.now() + ms,
    );
  }, []);

  const applyProjectData = useCallback((nextProject: ForgeProjectData | null, suppressMs = 1500) => {
    if (!nextProject) return;
    if (suppressMs > 0) suppressProjectWatcherRefresh(suppressMs);
    startTransition(() => {
      setHandle((current) => (current ? { ...current, project: nextProject } : current));
    });
  }, [suppressProjectWatcherRefresh]);

  const applyProjectHandle = useCallback((next: ForgeProjectHandle | null, suppressMs = 1500) => {
    if (!next) return null;
    if (suppressMs > 0) suppressProjectWatcherRefresh(suppressMs);
    startTransition(() => {
      setHandle(next);
    });
    return next;
  }, [suppressProjectWatcherRefresh]);

  const refreshDesktopAccountStatus = useCallback(async (announce = false) => {
    if (!window.forgeDesktop?.getDesktopAccountStatus || !window.forgeDesktop?.getDesktopAccountSession) {
      setAccountEntitlement({ plan: "free", status: "unknown" });
      return null;
    }
    try {
      const result = handle?.projectDir
        ? await window.forgeDesktop.getDesktopAccountStatus(handle.projectDir)
        : await window.forgeDesktop.getDesktopAccountSession();
      const entitlement: AccountEntitlement = result?.entitlement || { plan: "free", status: "unknown" };
      setAccountEntitlement(entitlement);
      if (result?.ok) {
        setDesktopAuthState("signed-in");
      }
      if (announce) {
        if (result?.ok) {
          const planLabel =
            entitlement.status === "trialing"
              ? "Membership trial"
              : entitlement.plan === "pro" || entitlement.plan === "studio"
                  ? "Membership"
                  : "Free";
          setNotice(`Desktop account connected: ${planLabel}.`);
        } else if (result?.message) {
          setNotice(result.message, "error");
        }
      }
      return result;
    } catch (statusError) {
      setAccountEntitlement({ plan: "free", status: "unknown" });
      if (announce) {
        setNotice(statusError instanceof Error ? statusError.message : "Account status check failed.", "error");
      }
      return null;
    }
  }, [handle?.projectDir, setNotice]);

  useEffect(() => {
    void refreshDesktopAccountStatus(false);
  }, [refreshDesktopAccountStatus]);

  const refreshProjectCompanionState = useCallback(async (projectDir: string) => {
    const targetDir = String(projectDir || "").trim();
    if (!targetDir) return;
    const [mediaIndexResult, pinboardResult] = await Promise.all([
      window.forgeDesktop
        .getMediaIndex(targetDir)
        .then((value) => ({ ok: true as const, value }))
        .catch(() => ({ ok: false as const })),
      window.forgeDesktop
        .getPinboard(targetDir)
        .then((value) => ({ ok: true as const, value }))
        .catch(() => ({ ok: false as const })),
    ]);
    if (activeProjectDirRef.current !== targetDir) {
      return;
    }
    if (mediaIndexResult.ok) {
      setMediaIndex(mediaIndexResult.value);
    }
    if (pinboardResult.ok) {
      setPinboard(Array.isArray(pinboardResult.value) ? pinboardResult.value : []);
    }
  }, []);

  const refreshCurrentProject = useCallback(async (suppressMs = 1500) => {
    if (!handle?.projectDir) return null;
    const projectDir = handle.projectDir;
    const [next] = await Promise.all([
      window.forgeDesktop.openProjectAtPath(projectDir),
      refreshProjectCompanionState(projectDir),
    ]);
    if (next) applyProjectHandle(next, suppressMs);
    return next;
  }, [applyProjectHandle, handle?.projectDir, refreshProjectCompanionState]);

  const refreshInbox = useCallback(async () => {
    if (!handle?.projectDir) {
      setInboxFiles([]);
      setPendingInboxMarkers([]);
      return;
    }
    try {
      const [files, pending] = await Promise.all([
        window.forgeDesktop.listInboxFiles(handle.projectDir),
        window.forgeDesktop.listInboxPending(handle.projectDir),
      ]);
      setInboxFiles(Array.isArray(files) ? files : []);
      setPendingInboxMarkers(Array.isArray(pending) ? pending : []);
    } catch {
      setInboxFiles([]);
      setPendingInboxMarkers([]);
    }
  }, [handle?.projectDir]);

  // Refresh inbox count whenever the user opens the project or toggles
  // into inbox view. Cheap (one readdir + statfs per file) so polling on
  // toggle is fine; a watcher is overkill for this surface.
  useEffect(() => {
    void refreshInbox();
  }, [refreshInbox, inboxView]);

  // Inbox toggle only makes sense on Assets > Media. If the user
  // navigates away (sub-rail, primary swap), drop back to All-media
  // automatically so the + import button comes back and the manifest
  // reflects what's on screen.
  useEffect(() => {
    if (activeSection !== "media") {
      setInboxView(false);
    }
  }, [activeSection]);

  // Drop the previewed inbox file when leaving inbox view so the
  // editor pane doesn't keep stale state on next entry.
  useEffect(() => {
    if (!inboxView) setInboxPreview(null);
  }, [inboxView]);

  // If the previewed file disappears (after Delete or Send to library),
  // clear the preview so the editor pane returns to the empty-state hint.
  useEffect(() => {
    if (!inboxPreview) return;
    const stillThere = inboxFiles.some((file) => file.relPath === inboxPreview.relPath);
    if (!stillThere) setInboxPreview(null);
  }, [inboxFiles, inboxPreview]);

  // Subscribe to main-process inbox events. Two purposes: real-time
  // refresh when files appear/disappear in assets/inbox/, and pending-tile
  // lifecycle for built-in generate_image / generate_video / generate_music tools.
  useEffect(() => {
    const off = window.forgeDesktop.onInboxEvent((event) => {
      if (event.kind === "files-changed") {
        void refreshInbox();
        return;
      }
      if (event.kind === "job-started") {
        if (event.section && event.section !== "inbox") return;
        setPendingInboxJobs((current) => {
          if (current.some((job) => job.id === event.id)) return current;
          return [
            ...current,
            {
              id: event.id,
              capability: event.capability,
              prompt: event.prompt || "",
              model: event.model,
              section: event.section,
              startedAt: Date.now(),
            },
          ];
        });
        return;
      }
      if (event.kind === "job-completed" || event.kind === "job-failed") {
        setPendingInboxJobs((current) => current.filter((job) => job.id !== event.id));
        if (event.kind === "job-completed") {
          const saved = Array.isArray(event.savedPaths) && event.savedPaths.length
            ? event.savedPaths[0]
            : null;
          if (saved) setNotice(`Saved: ${saved}`);
        } else {
          setError(`Generation failed: ${event.error}`);
        }
      }
    });
    return off;
  }, [refreshInbox, setError, setNotice]);

  const moveInboxToLibrary = useCallback(async (file: InboxFile) => {
    if (!handle?.projectDir) return;
    setInboxBusy(file.relPath);
    try {
      await window.forgeDesktop.moveInboxToLibrary(handle.projectDir, file.name);
      await refreshInbox();
      await refreshCurrentProject();
      setNotice(`Restored "${file.name}" to All media.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Restore failed.");
    } finally {
      setInboxBusy(null);
    }
  }, [handle?.projectDir, refreshCurrentProject, refreshInbox, setError, setNotice]);

  const deleteInboxFileNow = useCallback(async (file: InboxFile) => {
    if (!handle?.projectDir) return;
    setInboxBusy(file.relPath);
    try {
      await window.forgeDesktop.deleteInboxFile(handle.projectDir, file.name);
      await refreshInbox();
      setNotice(`Permanently deleted "${file.name}".`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Trash delete failed.");
    } finally {
      setInboxBusy(null);
    }
  }, [handle?.projectDir, refreshInbox, setError, setNotice]);

  const revealInboxFile = useCallback(async (file: InboxFile) => {
    if (!handle?.projectDir) return;
    try {
      await window.forgeDesktop.revealPath(handle.projectDir, file.relPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reveal failed.");
    }
  }, [handle?.projectDir, setError]);

  useEffect(() => {
    if (!startupProjectDir) {
      return;
    }
    if (desktopAuthState !== "signed-in") {
      return;
    }

    let cancelled = false;
    setBusy("open");
    setError(null);

    void window.forgeDesktop
      .openProjectAtPath(startupProjectDir)
      .then((next) => {
        if (cancelled || !next) return;
        applyOpenedProject(next, `Opened ${next.project.project.name}`);
      })
      .catch((openError) => {
        if (cancelled) return;
        setError(openError instanceof Error ? openError.message : "Open project failed.");
      })
      .finally(() => {
        if (!cancelled) {
          setBusy(null);
          setStartupOpenSettled(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [applyOpenedProject, desktopAuthState, startupProjectDir]);

  useEffect(() => {
    if (launchScreenPhase !== "visible" || !startupOpenSettled) return;
    const delayMs = Math.max(0, launchHideAtRef.current - performance.now());
    const timer = window.setTimeout(() => setLaunchScreenPhase("exiting"), delayMs);
    return () => window.clearTimeout(timer);
  }, [launchScreenPhase, startupOpenSettled]);

  useEffect(() => {
    if (launchScreenPhase !== "exiting") return;
    const timer = window.setTimeout(() => setLaunchScreenPhase("hidden"), 520);
    return () => window.clearTimeout(timer);
  }, [launchScreenPhase]);

  useEffect(() => {
    if (isAssetSection(activeSection)) {
      setLastAssetSection(activeSection);
    }
  }, [activeSection]);

  useEffect(() => {
    if (activeSection === "dialogue" || activeSection === "prompts") {
      setExpandedPrimary("script");
      return;
    }
    if (isAssetSection(activeSection)) {
      setExpandedPrimary((current) => current ?? "assets");
    }
  }, [activeSection]);

  const activeItems = useMemo(() => {
    if (!project) {
      return [];
    }
    return getSectionItems(project, activeSection);
  }, [project, activeSection]);
  const launchScreenMode: "boot" | "opening" | "handoff" = startupProjectDir
    ? (project ? "handoff" : "opening")
    : "boot";
  const launchScreen = launchScreenPhase === "hidden"
    ? null
    : (
      <LaunchScreen
        appVersion={appVersion}
        phase={launchScreenPhase}
        mode={launchScreenMode}
      />
    );
  const magicDocEntries = useMemo(() => project?.magicDocs || [], [project?.magicDocs]);
  const visibleMagicDocEntries = useMemo(
    () => (SHOW_MAGIC_DOC_SURFACE ? magicDocEntries : []),
    [magicDocEntries],
  );
  const selectedMagicDoc =
    activeSection === "story" && selectedMagicDocId
      ? visibleMagicDocEntries.find((entry) => entry.id === selectedMagicDocId) || null
      : null;
  const activeCustomSubsection: CustomSubsection | null = useMemo(() => {
    if (typeof activeSection !== "string" || !activeSection.startsWith("custom:")) return null;
    const subs = Array.isArray(project?.customSubsections) ? project!.customSubsections : [];
    return subs.find((sub) => sub.id === activeSection) || null;
  }, [activeSection, project?.customSubsections]);
  const [customSubsectionInstructions, setCustomSubsectionInstructions] = useState<{
    id: string;
    text: string;
    dirty: boolean;
    saving: boolean;
  } | null>(null);
  const [customSubsectionFiles, setCustomSubsectionFiles] = useState<{
    id: string;
    files: Array<{ name: string; path: string; sizeBytes: number; modifiedAt: string; ext: string }>;
  } | null>(null);
  const [customSubsectionFilesRefreshKey, setCustomSubsectionFilesRefreshKey] = useState(0);
  // Inline doc editor — only used when the active subsection is kind "docs".
  // Tracks which file is currently being edited and the draft text.
  const [customSubsectionDoc, setCustomSubsectionDoc] = useState<{
    subsectionId: string;
    filePath: string;
    title: string;
    savedTitle: string;
    text: string;
    savedText: string;
    dirty: boolean;
    saving: boolean;
  } | null>(null);
  const customSubsectionDocLoadTokenRef = useRef(0);
  const customSubsectionDocSaveTimer = useRef<number | null>(null);
  const activeCustomSubsectionDocs = useMemo(() => {
    if (!activeCustomSubsection || customSubsectionFiles?.id !== activeCustomSubsection.id) return [];
    return customSubsectionFiles.files.filter((file) => file.ext === ".md");
  }, [activeCustomSubsection, customSubsectionFiles]);
  const customSubsectionDocLimitReached =
    activeCustomSubsection?.kind === "docs" &&
    activeCustomSubsectionDocs.length >= LOCAL_UI_LIMITS.customSubsectionDocs;
  const [newDocPrompt, setNewDocPrompt] = useState<
    { subsectionId: string; folder: string; draft: string; busy: boolean } | null
  >(null);
  // Inline rename for custom subsections (sub-rail label, name panel) and
  // docs inside them (list rows). Double-click a label to enter rename mode;
  // Enter or blur commits, Escape cancels.
  const [inlineRename, setInlineRename] = useState<
    | { kind: "subsection"; id: CustomSubsectionId; draft: string }
    | { kind: "subsection-doc"; filePath: string; draft: string }
    | null
  >(null);
  const [customSubsectionRailMenu, setCustomSubsectionRailMenu] = useState<
    { id: CustomSubsectionId; name: string; folder: string; x: number; y: number } | null
  >(null);

  useEffect(() => {
    return () => {
      if (customSubsectionDocSaveTimer.current) {
        window.clearTimeout(customSubsectionDocSaveTimer.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!customSubsectionDoc?.dirty || customSubsectionDoc.saving || !handle?.projectDir) return;
    if (customSubsectionDocSaveTimer.current) {
      window.clearTimeout(customSubsectionDocSaveTimer.current);
    }
    const projectDir = handle.projectDir;
    const filePath = customSubsectionDoc.filePath;
    const text = customSubsectionDoc.text;
    customSubsectionDocSaveTimer.current = window.setTimeout(() => {
      customSubsectionDocSaveTimer.current = null;
      void window.forgeDesktop
        .writeCustomSubsectionDoc(projectDir, filePath, text)
        .then(() => {
          setCustomSubsectionDoc((prev) =>
            prev && prev.filePath === filePath
              ? { ...prev, savedText: text, dirty: prev.text !== text }
              : prev,
          );
          setCustomSubsectionFilesRefreshKey((n) => n + 1);
        })
        .catch((err) => {
          setError(err instanceof Error ? err.message : "Could not auto-save doc.");
        });
    }, 400);
    return () => {
      if (customSubsectionDocSaveTimer.current) {
        window.clearTimeout(customSubsectionDocSaveTimer.current);
        customSubsectionDocSaveTimer.current = null;
      }
    };
  }, [
    customSubsectionDoc?.dirty,
    customSubsectionDoc?.filePath,
    customSubsectionDoc?.saving,
    customSubsectionDoc?.text,
    handle?.projectDir,
  ]);

  useEffect(() => {
    if (!activeCustomSubsection || !handle?.projectDir) {
      setCustomSubsectionInstructions(null);
      return;
    }
    if (customSubsectionInstructions?.id === activeCustomSubsection.id) return;
    let cancelled = false;
    void window.forgeDesktop
      .readCustomSubsectionInstructions(handle.projectDir, activeCustomSubsection.instructionsPath)
      .then((text) => {
        if (cancelled) return;
        setCustomSubsectionInstructions({ id: activeCustomSubsection.id, text: text || "", dirty: false, saving: false });
      })
      .catch(() => {
        if (cancelled) return;
        setCustomSubsectionInstructions({ id: activeCustomSubsection.id, text: "", dirty: false, saving: false });
      });
    return () => {
      cancelled = true;
    };
  }, [activeCustomSubsection, handle?.projectDir, customSubsectionInstructions?.id]);

  useEffect(() => {
    customSubsectionDocLoadTokenRef.current += 1;
  }, [activeCustomSubsection?.id, handle?.projectDir]);

  useEffect(() => {
    // Reset the inline doc editor when the user navigates to a different
    // subsection so the editor doesn't try to render against the wrong
    // file path. If the doc has unsaved edits, fire a best-effort
    // background save so we don't lose the user's work just because they
    // clicked elsewhere on the rail.
    const flushDirty = (prev: typeof customSubsectionDoc) => {
      if (prev && prev.dirty && prev.text !== prev.savedText && handle?.projectDir) {
        void window.forgeDesktop
          .writeCustomSubsectionDoc(handle.projectDir, prev.filePath, prev.text)
          .catch((err) => {
            setError(err instanceof Error ? err.message : "Could not auto-save doc.");
          });
      }
    };
    if (!activeCustomSubsection) {
      flushDirty(customSubsectionDoc);
      setCustomSubsectionDoc(null);
      return;
    }
    if (customSubsectionDoc && customSubsectionDoc.subsectionId !== activeCustomSubsection.id) {
      flushDirty(customSubsectionDoc);
      setCustomSubsectionDoc(null);
    }
  }, [activeCustomSubsection, customSubsectionDoc, handle?.projectDir]);

  useEffect(() => {
    if (!activeCustomSubsection || !handle?.projectDir) {
      setCustomSubsectionFiles(null);
      return;
    }
    let cancelled = false;
    void window.forgeDesktop
      .listCustomSubsectionFiles(
        handle.projectDir,
        activeCustomSubsection.folder,
        activeCustomSubsection.fileExtensions,
      )
      .then((result) => {
        if (cancelled) return;
        setCustomSubsectionFiles({ id: activeCustomSubsection.id, files: result.files });
      })
      .catch(() => {
        if (cancelled) return;
        setCustomSubsectionFiles({ id: activeCustomSubsection.id, files: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [activeCustomSubsection, handle?.projectDir, customSubsectionFilesRefreshKey]);

  useEffect(() => {
    if (activeCustomSubsection?.kind !== "docs") return;
    if (customSubsectionDoc) return;
    if (customSubsectionFiles?.id !== activeCustomSubsection.id) return;
    const firstDoc = customSubsectionFiles.files.find((file) => file.ext === ".md");
    if (firstDoc) void openCustomSubsectionDoc(firstDoc.path);
  }, [activeCustomSubsection?.id, activeCustomSubsection?.kind, customSubsectionDoc, customSubsectionFiles]);

  const selectedId = selectedIds[activeSection];
  const selectedItem =
    selectedMagicDoc || assetContextSelected || assetLibrarySelected
      ? null
      : activeSection === "videos"
        ? activeItems.find((item) => item.id === selectedId) || null
        : activeItems.find((item) => item.id === selectedId) ??
          activeItems[0] ??
          null;

  useEffect(() => {
    if (
      assetContextSelected &&
      (activeSection !== "story" || projectContextSelected || pinboardSelected || sectionFormatSelected || selectedMagicDocId || assetLibrarySelected)
    ) {
      setAssetContextSelected(false);
    }
    if (
      assetLibrarySelected &&
      (activeSection !== "story" || projectContextSelected || pinboardSelected || sectionFormatSelected || selectedMagicDocId || assetContextSelected)
    ) {
      setAssetLibrarySelected(false);
    }
  }, [activeSection, assetContextSelected, assetLibrarySelected, pinboardSelected, projectContextSelected, sectionFormatSelected, selectedMagicDocId]);

  const handleGlobalKeyDown = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.defaultPrevented) {
      return;
    }

    const target = event.target as HTMLElement | null;
    const isEditable = Boolean(
      target &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable),
    );
    const key = event.key.toLowerCase();

    // Cmd+Z = undo, Cmd+Shift+Z = redo. Skip when the user is typing
    // inside an input / textarea / contentEditable surface (CodeMirror
    // editor, title inputs, etc.) so the editor's own native undo
    // history takes the keystroke. Without this guard the project
    // structure undo stack collides with text edits — Cmd+Z mid-typing
    // would rewind a previously-deleted scene instead of the user's
    // last paragraph, surprising and lossy.
    if (key === "z" && !event.altKey && !isEditable) {
      event.preventDefault();
      if (event.shiftKey) {
        redo();
      } else {
        undo();
      }
      return;
    }

    if (SHOW_AGENT_SURFACE && key === "k" && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      setAgentPrimarySelected(true);
      setChatCollapsed(false);
      window.requestAnimationFrame(() => {
        chatInputRef.current?.focus();
        chatInputRef.current?.select();
      });
      return;
    }

    // ⌘F — focus the asset-grid search box when in Assets. Lets
    // keyboard-first users find an asset in a 50+ grid without reaching
    // for the mouse. Browser default find-in-page is suppressed here
    // because Anvil has no in-page text to find — the relevant search
    // is always the asset grid.
    if (key === "f" && !event.shiftKey && !event.altKey && activePrimary === "assets") {
      event.preventDefault();
      assetSearchInputRef.current?.focus();
      assetSearchInputRef.current?.select();
      return;
    }

    if (SHOW_AGENT_SURFACE && key === "." && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      setChatCollapsed((current) => !current);
      return;
    }

    if (key === "n" && !event.shiftKey && !event.altKey && !isEditable && project && activePrimary !== "workshop" && activeSection !== "media") {
      event.preventDefault();
      void createItem();
      return;
    }

    // ⌘⇧N — insert-after-current. Routes to insertSceneAfter /
    // insertShotAfter when a scene / shot is selected, letting power-users
    // add a new sibling mid-list without context-menu round-trips (F13 from
    // the add-button audit). Prompts use createItem (no insert-after
    // helper).
    if (key === "n" && event.shiftKey && !event.altKey && !isEditable && project && activePrimary === "script" && selectedItem) {
      if (activeSection === "script" && "kind" in selectedItem && (selectedItem as ScriptEntry).kind === "scene") {
        event.preventDefault();
        insertSceneAfter(selectedItem.id);
        return;
      }
    }

    // ⌘⌫ (Cmd+Delete/Backspace) — delete the selected asset. In All Media,
    // the request resolves back to the real owning section before deletion.
    // Only fires when focus isn't in an editable field so typing Delete in
    // a textarea doesn't nuke the row.
    if (
      (event.key === "Backspace" || event.key === "Delete") &&
      !event.shiftKey &&
      !event.altKey &&
      !isEditable &&
      project &&
      isAssetSection(activeSection) &&
      selectedItem
    ) {
      event.preventDefault();
      requestAssetDelete(activeSection, selectedItem as AssetEntry);
      return;
    }

    // ⌘C — copy the selected asset's first image to the system clipboard.
    // Guarded on !isEditable so regular ⌘C in the editor still works as a
    // text copy. Only fires on asset sections (characters/locations/props/
    // keyframes/audio/library) with an asset selected that has an image
    // media entry; audio or notes-only assets fall through to normal ⌘C.
    if (
      key === "c" &&
      !event.shiftKey &&
      !event.altKey &&
      !isEditable &&
      project &&
      handle &&
      isAssetSection(activeSection) &&
      selectedItem &&
      "media" in selectedItem
    ) {
      const firstMedia = firstRenderableAssetMedia(
        (selectedItem as AssetEntry).media || [],
        brokenMediaIds,
      );
      if (firstMedia && firstMedia.kind === "image" && firstMedia.path) {
        event.preventDefault();
        const label = (selectedItem as AssetEntry).name ||
          (selectedItem as AssetEntry).title || "Asset";
        const projectDir = handle.projectDir;
        const mediaPath = firstMedia.path;
        void (async () => {
          try {
            const result = await window.forgeDesktop.copyImageToClipboard(projectDir, mediaPath);
            if (result.ok) {
              setNotice(`Copied ${label} to clipboard. ⌘V to paste.`);
            } else if (result.reason === "too-large") {
              setNotice(`${label} is too large to copy as an image.`);
            } else if (result.reason === "missing") {
              setNotice(`${label}'s file is missing on disk.`);
            }
          } catch (err) {
            setError(err instanceof Error ? err.message : "Copy failed.");
          }
        })();
        return;
      }
    }

    // ⌘⇧P — open pinboard (triage-friendly shortcut; most-confirmed action
    // in a session). ⌘⇧L — toggle focus-lock picker. Both are the
    // highest-frequency affordances that were previously mouse-only.
    if (key === "p" && event.shiftKey && !event.altKey && project) {
      event.preventDefault();
      activatePrimary("story");
      setPinboardSelected(true);
      setProjectContextSelected(false);
      setAssetContextSelected(false);
      setAssetLibrarySelected(false);
      setSectionFormatSelected(null);
      setSelectedMagicDocId(null);
      return;
    }
    if (key === "l" && event.shiftKey && !event.altKey && project) {
      event.preventDefault();
      // Always toggle the menu — the menu itself carries a "Release" action
      // when a lock is active. Previous behavior swapped between release and
      // open-menu based on state, which was inconsistent (L1 from the
      // 2026-04-21 focus-lock audit).
      setLockMenuOpen((current) => !current);
      return;
    }

    // ⌘G → previously a "jump to turn by number" prompt. Removed because
    // it used `window.prompt()`, which Electron silently blocks in
    // BrowserWindow webContents — the feature never functioned. Re-add
    // as an inline command-palette input if the need comes back; scroll
    // works for now.

    // ⌘⇧⏎ → fire the first item-action for the current selection.
    if (SHOW_AGENT_SURFACE && event.key === "Enter" && event.shiftKey && !event.altKey && !isEditable && project) {
      event.preventDefault();
      if (sending) return;
      // Lazy-import to avoid circularity at module init; keeps the
      // keyboard handler in App.tsx self-contained.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getAgentActions } = require("./lib/agent-actions") as typeof import("./lib/agent-actions");
      const [target] = getAgentActions({
        activeSection,
        activePrimary,
        selectedItem,
        projectContextSelected,
        sectionFormatSelected,
        selectedMagicDoc: Boolean(selectedMagicDoc) || assetContextSelected,
        pinboardSelected,
      });
      if (target) {
        void sendAgentMessage(target.message, target.label);
      }
      return;
    }

    // Cmd+<digit> → primary section. Only consume the keystroke if the
    // digit actually maps to a section — previously 4/5 were also
    // preventDefaulted (stale from when there were 5 primaries) and
    // silently swallowed the user's input.
    if (!event.shiftKey && !event.altKey && /^[1-9]$/.test(event.key)) {
      const index = Number(event.key) - 1;
      const target = PRIMARY_SECTIONS[index];
      if (target) {
        event.preventDefault();
        activatePrimary(target);
      }
    }
  });

  useEffect(() => {
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, []);

  // ArrowUp / ArrowDown navigation across tree rows when focus is already
  // on a row button. querySelectorAll returns only rendered .item-row buttons,
  // so collapsed scenes are naturally skipped. Focus movement on a button
  // triggers its onClick handler (we call .click() so the selection state
  // updates and the editor pane follows).
  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const active = document.activeElement as HTMLElement | null;
      if (!active || !active.classList.contains("item-row")) return;
      const rows = Array.from(
        document.querySelectorAll<HTMLButtonElement>("button.item-row"),
      );
      const idx = rows.indexOf(active as HTMLButtonElement);
      if (idx < 0) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const nextIdx = Math.max(0, Math.min(rows.length - 1, idx + delta));
      if (nextIdx === idx) return;
      event.preventDefault();
      rows[nextIdx].focus();
      rows[nextIdx].click();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // ArrowUp/Down/Left/Right navigation across asset tiles when focus is on
  // a tile-trigger button. Up/Down step by the current column count
  // (computed from the grid container's resolved gridTemplateColumns so it
  // tracks the responsive auto-fill). Without this, keyboard users had to
  // Tab through every tile + every delete button to traverse a 100-asset
  // section — 200 tab stops just to reach the bottom row.
  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if (
        event.key !== "ArrowUp" &&
        event.key !== "ArrowDown" &&
        event.key !== "ArrowLeft" &&
        event.key !== "ArrowRight"
      ) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const active = document.activeElement as HTMLElement | null;
      if (!active || !active.classList.contains("asset-tile-trigger")) return;
      const tiles = Array.from(
        document.querySelectorAll<HTMLButtonElement>("button.asset-tile-trigger"),
      );
      const idx = tiles.indexOf(active as HTMLButtonElement);
      if (idx < 0) return;
      let nextIdx = idx;
      if (event.key === "ArrowLeft") {
        nextIdx = Math.max(0, idx - 1);
      } else if (event.key === "ArrowRight") {
        nextIdx = Math.min(tiles.length - 1, idx + 1);
      } else {
        const grid = tiles[0].closest(".asset-grid") as HTMLElement | null;
        let cols = 1;
        if (grid) {
          const tpc = window.getComputedStyle(grid).gridTemplateColumns;
          if (tpc && tpc !== "none") {
            cols = tpc.split(" ").filter(Boolean).length || 1;
          }
        }
        if (event.key === "ArrowUp") {
          nextIdx = Math.max(0, idx - cols);
        } else {
          nextIdx = Math.min(tiles.length - 1, idx + cols);
        }
      }
      if (nextIdx === idx) return;
      event.preventDefault();
      tiles[nextIdx].focus();
      tiles[nextIdx].click();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // When the pinboard is opened (via ⌘⇧P or nav), focus the panel so J/K
  // keyboard navigation works immediately without a mouse click.
  useEffect(() => {
    if (pinboardSelected) {
      const node = pinboardPanelRef.current;
      if (node) node.focus();
    }
  }, [pinboardSelected]);

  useEffect(() => {
    if (!showHeaderMenu) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!headerMenuRef.current?.contains(event.target as Node)) {
        setShowHeaderMenu(false);
      }
    };

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowHeaderMenu(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [showHeaderMenu]);

  useEffect(() => {
    if (!showChatMenu) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!chatMenuRef.current?.contains(event.target as Node)) {
        setShowChatMenu(false);
      }
    };

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowChatMenu(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [showChatMenu]);

  useEffect(() => {
    if (!showAvatarMenu) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!avatarMenuRef.current?.contains(event.target as Node)) {
        setShowAvatarMenu(false);
      }
    };

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowAvatarMenu(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [showAvatarMenu]);

  useEffect(() => {
    if (!lockMenuOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!lockMenuRef.current?.contains(event.target as Node)) {
        setLockMenuOpen(false);
      }
    };

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setLockMenuOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [lockMenuOpen]);

  const queuedAgentCount = agentQueue.length;
  const combinedChatHistory = useMemo(
    () => [
      ...chatHistory,
      ...agentQueue.flatMap((task) => [task.userMessage, task.assistantMessage]),
    ],
    [chatHistory, agentQueue],
  );

  function updateChatStickiness(node: HTMLDivElement | null) {
    if (!node) return;
    const threshold = 120;
    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    chatStickToBottomRef.current = distanceFromBottom <= threshold;
  }

  function handleChatScroll(event: UIEvent<HTMLDivElement>) {
    updateChatStickiness(event.currentTarget);
  }

  const sortedAllMediaItems = useMemo(() => {
    if (activePrimary !== "assets" || activeSection !== "media") return activeItems;
    const seen = new Set<string>();
    const originalIndexById = new Map<string, number>();
    const uniqueItems = activeItems.filter((item, index) => {
      originalIndexById.set(item.id, index);
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
    return [...uniqueItems].sort((a, b) => {
      const ownerA = assetOwnerById.get(a.id)?.section || "media";
      const ownerB = assetOwnerById.get(b.id)?.section || "media";
      const rank = ALL_MEDIA_CATEGORY_RANK[ownerA] - ALL_MEDIA_CATEGORY_RANK[ownerB];
      if (rank) return rank;
      return (originalIndexById.get(a.id) ?? 0) - (originalIndexById.get(b.id) ?? 0);
    });
  }, [activeItems, activePrimary, activeSection, assetOwnerById]);
  // Library entries live in `assetOwnerById` so drag-drop, selection, and
  // the All-media sort can resolve their owning collection — but for the
  // user-facing tabs, library means "not bound to any specific named
  // asset", i.e. unassigned (or generated, when the underlying media
  // record was created by a generation tool).
  //
  // Bucket priority: Assigned (bound to a real section) > Generated
  // (unbound or library-only AND sourced from generation) > Unassigned
  // (everything else). Generated reads as a staging area — a generated
  // file leaves it the moment the user binds it to a character / location
  // / prop / keyframe / audio entry.
  const generatedMediaPaths = useMemo(() => {
    const paths = new Set<string>();
    for (const record of Object.values(mediaIndex)) {
      if (record?.source === "generation" && typeof record.path === "string") {
        paths.add(record.path);
      }
    }
    return paths;
  }, [mediaIndex]);
  const assetIsGenerated = (entry: { media?: Array<{ path?: string | null }> } | undefined | null) => {
    if (!entry || !Array.isArray(entry.media) || entry.media.length === 0) return false;
    return entry.media.some((m) => typeof m?.path === "string" && generatedMediaPaths.has(m.path));
  };
  const bucketForItem = (item: SectionEntry): AllMediaCategoryId => {
    const owner = assetOwnerById.get(item.id);
    if (owner && owner.collectionKey !== "library") return "assigned";
    if (assetIsGenerated(item as AssetEntry)) return "generated";
    return "unassigned";
  };
  const categoryFilteredActiveItems = useMemo(() => {
    if (activePrimary !== "assets" || activeSection !== "media") {
      return sortedAllMediaItems;
    }
    return sortedAllMediaItems.filter((item) => bucketForItem(item) === allMediaCategoryFilter);
  }, [activePrimary, activeSection, allMediaCategoryFilter, assetOwnerById, generatedMediaPaths, sortedAllMediaItems]);
  const allMediaCategoryCounts = useMemo(() => {
    const counts: Record<AllMediaCategoryId, number> = { unassigned: 0, assigned: 0, generated: 0 };
    if (activePrimary !== "assets" || activeSection !== "media") return counts;
    for (const item of sortedAllMediaItems) {
      counts[bucketForItem(item)] += 1;
    }
    return counts;
  }, [activePrimary, activeSection, assetOwnerById, generatedMediaPaths, sortedAllMediaItems]);
  // Filter assets by category + search query (name/label substring,
  // case-insensitive). Other primaries pass through unchanged so
  // script/story rendering is untouched. Uses getEntryLabel so each
  // section's canonical label drives the match.
  const filteredActiveItems = useMemo(() => {
    const sourceItems =
      activePrimary === "assets" && activeSection === "media"
        ? categoryFilteredActiveItems
        : activeItems;
    // Single | Sheet split applies to characters + locations + keyframes.
    // Anything not exactly "sheet" rolls into Single — keeps legacy
    // entries (no kind), corrupted writes, and unknown future kinds
    // visible instead of disappearing into a tab the user can't reach.
    // Audio uses a 4-way audioKind split (Music | Voice | SFX | Ambient).
    const kindFiltered = (() => {
      if (activePrimary !== "assets") return sourceItems;
      if (
        activeSection === "characters" ||
        activeSection === "locations" ||
        activeSection === "keyframes"
      ) {
        return sourceItems.filter((item) => {
          const rawKind = (item as AssetEntry).kind;
          const normalizedKind = rawKind === "sheet" ? "sheet" : "single";
          return normalizedKind === assetSubView;
        });
      }
      if (activeSection === "audio") {
        return sourceItems.filter((item) => {
          const raw = (item as AssetEntry).audioKind;
          const normalized: AudioKind =
            raw === "voiceover" || raw === "sfx" || raw === "ambient" ? raw : "music";
          return normalized === audioSubView;
        });
      }
      return sourceItems;
    })();
    if (activePrimary !== "assets" || !deferredAssetGridQuery.trim()) return kindFiltered;
    const q = deferredAssetGridQuery.trim().toLowerCase();
    return kindFiltered.filter((item) =>
      getEntryLabel(activeSection, item).toLowerCase().includes(q),
    );
  }, [activeItems, activePrimary, activeSection, assetSubView, audioSubView, categoryFilteredActiveItems, deferredAssetGridQuery]);
  const assetGridPagingKey =
    activePrimary === "assets"
      ? `${activeSection}:${allMediaCategoryFilter}:${deferredAssetGridQuery.trim().toLowerCase()}`
      : `${activePrimary}:${activeSection}`;
  const assetGridVisibleLimit =
    assetGridVisibleState.key === assetGridPagingKey
      ? assetGridVisibleState.limit
      : LOCAL_UI_LIMITS.assetGridInitialItems;
  const visibleFilteredActiveItems = useMemo(
    () =>
      activePrimary === "assets" && activeSection !== "videos"
        ? filteredActiveItems.slice(0, assetGridVisibleLimit)
        : filteredActiveItems,
    [activePrimary, activeSection, assetGridVisibleLimit, filteredActiveItems],
  );
  const hiddenFilteredActiveItemCount =
    activePrimary === "assets" && activeSection !== "videos"
      ? Math.max(0, filteredActiveItems.length - visibleFilteredActiveItems.length)
      : 0;
  const showMoreAssetGridItems = useCallback(() => {
    setAssetGridVisibleState((current) => {
      const currentLimit =
        current.key === assetGridPagingKey ? current.limit : LOCAL_UI_LIMITS.assetGridInitialItems;
      return {
        key: assetGridPagingKey,
        limit: currentLimit + LOCAL_UI_LIMITS.assetGridPageSize,
      };
    });
  }, [assetGridPagingKey]);
  // Clear the search box when switching between asset sections — avoids a
  // stale "only 3 of 80 shown" count that the user forgot they filtered.
  useEffect(() => {
    setAssetGridQuery("");
    if (activeSection !== "media") setAllMediaCategoryFilter("unassigned");
  }, [activeSection]);
  useEffect(() => {
    if (activeSection !== "media") return;
    if (!categoryFilteredActiveItems.length) return;
    if (categoryFilteredActiveItems.some((item) => item.id === selectedIds.media)) return;
    setSelectedIds((current) => ({ ...current, media: categoryFilteredActiveItems[0].id }));
  }, [activeSection, allMediaCategoryFilter, categoryFilteredActiveItems, selectedIds.media]);
  // Pre-resolve every rendered asset's first-renderable thumbnail in one
  // pass keyed on the items + brokenMediaIds set. Was: one
  // firstRenderableAssetMedia walk per tile per render — for a 500-asset
  // section that's 500 walks on every unrelated re-render (selection,
  // drag state, etc.). Keyed on the paged visible items so large libraries
  // don't do hidden thumbnail work.
  const tileThumbsByAssetId = useMemo(() => {
    const out = new Map<string, ReturnType<typeof firstRenderableAssetMedia>>();
    if (activePrimary !== "assets") return out;
    for (const item of visibleFilteredActiveItems) {
      const a = item as AssetEntry;
      out.set(a.id, firstRenderableAssetMedia(a.media || [], brokenMediaIds));
    }
    return out;
  }, [activePrimary, visibleFilteredActiveItems, brokenMediaIds]);
  const visibleOrderById = useMemo(() => {
    const orderMap = new Map<string, number>();
    let ordinal = 0;
    for (const item of visibleFilteredActiveItems) {
      if (activeSection === "script" && (item as ScriptEntry).kind === "master") {
        continue;
      }
      ordinal += 1;
      orderMap.set(item.id, ordinal);
    }
    return orderMap;
  }, [visibleFilteredActiveItems, activeSection]);

  const activeSessionKey = project?.settings.sessionKey || "";
  const activeProjectDir = handle?.projectDir || "";
  const headerRecentProjects = useMemo(
    () => recentProjects.filter((entry) => entry.projectDir !== activeProjectDir).slice(0, 4),
    [activeProjectDir, recentProjects],
  );
  // Multi-script state — every kind="master" entry in project.script[]
  // is a peer script. Master Script (script/master-script.md) is just
  // the first one; secondary scripts (script/<slug>.md) live alongside.
  const masterScriptPathConst = MASTER_SCRIPT_PATH;
  const masterScripts = useMemo(
    () =>
      ((project?.script || []) as ScriptEntry[])
        .filter((entry) => entry.kind === "master")
        .slice()
        .sort((a, b) => {
          if (a.path === masterScriptPathConst) return -1;
          if (b.path === masterScriptPathConst) return 1;
          return String(a.path).localeCompare(String(b.path));
        }),
    [project],
  );
  const [activeScriptPath, setActiveScriptPath] = useState<string>(masterScriptPathConst);
  useEffect(() => {
    if (masterScripts.length === 0) return;
    if (!masterScripts.some((entry) => entry.path === activeScriptPath)) {
      setActiveScriptPath(masterScriptPathConst);
    }
  }, [masterScripts, activeScriptPath]);
  const activeScriptEntry = useMemo(
    () =>
      masterScripts.find((entry) => entry.path === activeScriptPath) ||
      masterScripts.find((entry) => entry.path === masterScriptPathConst) ||
      masterScripts[0] ||
      null,
    [masterScripts, activeScriptPath],
  );

  // Every scene in the project, across all scripts. Used for
  // project-wide ordinal counters and any cross-script view.
  const allSceneEntries = useMemo(
    () => ((project?.script || []) as ScriptEntry[]).filter((entry) => entry.kind === "scene"),
    [project],
  );
  // Scenes that belong to the currently-active script. Empty/missing
  // parentScriptPath maps to Master Script (legacy single-film
  // projects), so existing scenes keep showing under Master Script
  // without any data migration.
  const sceneEntries = useMemo(() => {
    const active = activeScriptPath || masterScriptPathConst;
    const filtered = allSceneEntries.filter((entry) => {
      const parent = (entry.parentScriptPath || "").trim();
      if (active === masterScriptPathConst) return !parent || parent === masterScriptPathConst;
      return parent === active;
    });
    return sortScenesForDisplay(filtered, activeScriptEntry?.content || "");
  }, [allSceneEntries, activeScriptPath, activeScriptEntry?.content]);
  const findSceneForPrompt = useCallback((prompt: PromptEntry | null | undefined, scenePool: ScriptEntry[] = allSceneEntries) => {
    if (!prompt) return null;
    return (
      scenePool.find((entry) => prompt.sceneId && entry.id === prompt.sceneId) ||
      scenePool.find((entry) => promptBelongsToSceneForDisplay(prompt, entry)) ||
      null
    );
  }, [allSceneEntries]);
  // Master script is the parent of all scenes — its total runtime is the
  // sum of each scene's runtime (explicit durationSec if set, else summed
  // from that scene's prompts via sceneDurationById).
  const clipDurationBySceneId = useMemo(() => {
    const allPrompts = project?.prompts || [];
    const scenesById = new Map(sceneEntries.map((scene) => [scene.id, scene]));
    // A prompt is a "sequence container" if any other prompt names it
    // as parentPromptId. Containers contribute 0 to scene totals so
    // we don't double-count parent + children when a beat was split
    // into sub-prompts to cover > 15s. Children contribute their own
    // duration normally.
    const idsWithChildren = new Set<string>();
    for (const p of allPrompts) {
      if (p.parentPromptId) idsWithChildren.add(p.parentPromptId);
    }
    const totals = new Map<string, number>();
    for (const prompt of allPrompts) {
      const scene =
        (prompt.sceneId ? scenesById.get(prompt.sceneId) || null : null) ||
        sceneEntries.find((entry) => promptBelongsToSceneForDisplay(prompt, entry)) ||
        null;
      if (!scene) continue;
      if (idsWithChildren.has(prompt.id)) continue;
      totals.set(scene.id, (totals.get(scene.id) || 0) + clipDurationSeconds(prompt.durationSec));
    }
    return totals;
  }, [project?.prompts, sceneEntries]);
  const sceneDurationById = useMemo(() => {
    return new Map<string, number>(clipDurationBySceneId);
  }, [clipDurationBySceneId]);
  const masterScriptDurationSec = useMemo(() => {
    // Master "actual" runtime. Rule: prefer the DERIVED total (sum of
    // prompts/beats/orphan-shots) when it's > 0, since that's what the
    // user has actually written. Fall back to scene's EXPLICIT
    // durationSec only when the scene has no content yet — explicit
    // is a target/placeholder; once content exists, actual reflects
    // what's really there even if it differs from the target.
    //
    // Pre-fix bug: explicit always won, so a scene with target=60s
    // and 30s of actual prompts inflated master "actual" by +30s,
    // making the badge's actual-vs-target delta lie.
    let total = 0;
    for (const scene of sceneEntries) {
      const derived = sceneDurationById.get(scene.id) || 0;
      if (derived > 0) {
        total += derived;
        continue;
      }
      const explicit = Number(scene.durationSec);
      if (Number.isFinite(explicit) && explicit > 0) {
        total += Math.round(explicit);
      }
    }
    return total || null;
  }, [sceneEntries, sceneDurationById]);
  const promptsBySceneId = useMemo(() => {
    const map = new Map<string, PromptEntry[]>();
    const scenesById = new Map(sceneEntries.map((scene) => [scene.id, scene]));
    for (const scene of sceneEntries) map.set(scene.id, []);
    for (const prompt of project?.prompts || []) {
      const scene =
        (prompt.sceneId ? scenesById.get(prompt.sceneId) || null : null) ||
        sceneEntries.find((entry) => promptBelongsToSceneForDisplay(prompt, entry)) ||
        null;
      if (!scene) continue;
      const list = map.get(scene.id) || [];
      list.push(prompt);
      map.set(scene.id, list);
    }
    for (const [key, list] of map) {
      map.set(key, sortPromptsForDisplay(list, scenesById.get(key) || null));
    }
    return map;
  }, [project?.prompts, sceneEntries]);
  const dialogueDoc = useMemo(
    () => ((project?.dialogue || [])[0] as DialogueEntry | null) || null,
    [project?.dialogue],
  );
  const masterScriptEntry = activeScriptEntry;

  useEffect(() => {
    if (activePrimary !== "script") return;
    if (activeSection !== "dialogue") return;
    setActiveSection("script");
    if (masterScriptEntry?.id) {
      setSelectedIds((current) => ({ ...current, script: masterScriptEntry.id }));
    }
  }, [activePrimary, activeSection, masterScriptEntry?.id]);

  // Entity dictionary the MarkdownEditor highlighter consumes — character /
  // location / prop / keyframe / audio / library. Built from asset names so
  // updates flow automatically when the user adds assets, and so a brand-new
  // project gets consistent highlighting the moment assets are created with
  // no hardcoded names anywhere in the match path.
  //
  const promptHighlightEntities = useMemo(() => {
    return {
      characters: (project?.characters || []).map((c) => c.name).filter(Boolean),
      locations: (project?.locations || []).map((l) => l.name).filter(Boolean),
      props: (project?.props || []).map((p) => p.name).filter(Boolean),
      keyframes: (project?.keyframes || []).map((k) => k.name).filter(Boolean),
      audio: (project?.audio || []).map((a) => a.name).filter(Boolean),
      library: (project?.library || []).map((l) => l.name).filter(Boolean),
    };
  }, [
    project?.characters,
    project?.locations,
    project?.props,
    project?.keyframes,
    project?.audio,
    project?.library,
  ]);
  // Which scenes are collapsed in the Script tree. `sceneId → false`
  // means collapsed; missing key defaults to expanded. Persisted per
  // project.id in localStorage so a long project doesn't lose its
  // "only scene 7 expanded" state on reload.
  const [expandedSceneIds, setExpandedSceneIds] = useState<Record<string, boolean>>({});
  const [masterScriptTreeExpanded, setMasterScriptTreeExpanded] = useState(true);
  const [expandedBeatIds, setExpandedBeatIds] = useState<Record<string, boolean>>({});
  const projectId = project?.project?.id ?? null;
  useEffect(() => {
    if (!projectId) {
      setScriptSubrailHidden(false);
      return;
    }
    try {
      setScriptSubrailHidden(localStorage.getItem(`anvil.scriptSubrailHidden.${projectId}`) === "1");
    } catch {
      setScriptSubrailHidden(false);
    }
  }, [projectId]);
  useEffect(() => {
    if (!projectId) return;
    try {
      localStorage.setItem(`anvil.scriptSubrailHidden.${projectId}`, scriptSubrailHidden ? "1" : "0");
    } catch {
      // Best-effort UI preference.
    }
  }, [projectId, scriptSubrailHidden]);
  useEffect(() => {
    if (!projectId) {
      setScopeIntakeDraft(DEFAULT_SCOPE_INTAKE_DRAFT);
      setScopeIntakeOpen(false);
      setPhaseCheckpoint(null);
      return;
    }
    const key = scopeIntakeDraftStorageKey(projectId);
    try {
      const raw = localStorage.getItem(key);
      setScopeIntakeDraft(raw ? normalizeScopeIntakeDraft(JSON.parse(raw)) : DEFAULT_SCOPE_INTAKE_DRAFT);
    } catch {
      setScopeIntakeDraft(DEFAULT_SCOPE_INTAKE_DRAFT);
    }
    setPhaseCheckpoint(null);
  }, [projectId]);
  useEffect(() => {
    if (!projectId) return;
    const key = scopeIntakeDraftStorageKey(projectId);
    try {
      localStorage.setItem(key, JSON.stringify(scopeIntakeDraft));
    } catch {
      // Local storage may be disabled or full; project notes still works in memory.
    }
  }, [projectId, scopeIntakeDraft]);
  useEffect(() => {
    if (!projectId) {
      setExpandedSceneIds({});
      setMasterScriptTreeExpanded(true);
      setExpandedBeatIds({});
      return;
    }
    try {
      setMasterScriptTreeExpanded(localStorage.getItem(`anvil.masterScriptExpanded.${projectId}`) !== "false");
    } catch {
      setMasterScriptTreeExpanded(true);
    }
    try {
      const raw = localStorage.getItem(`anvil.expandedScenes.${projectId}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          setExpandedSceneIds(parsed as Record<string, boolean>);
          return;
        }
      }
    } catch {
      // Malformed JSON or localStorage disabled — fall through to default.
    }
    setExpandedSceneIds({});
  }, [projectId]);
  useEffect(() => {
    if (!projectId) return;
    try {
      localStorage.setItem(
        `anvil.masterScriptExpanded.${projectId}`,
        masterScriptTreeExpanded ? "true" : "false",
      );
    } catch {
      // localStorage can be disabled / full — silently skip persistence.
    }
  }, [masterScriptTreeExpanded, projectId]);
  useEffect(() => {
    if (!projectId) return;
    try {
      const raw = localStorage.getItem(`anvil.expandedBeats.${projectId}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          setExpandedBeatIds(parsed as Record<string, boolean>);
          return;
        }
      }
    } catch {
      // Malformed JSON or localStorage disabled — fall through to default.
    }
    setExpandedBeatIds({});
  }, [projectId]);
  useEffect(() => {
    if (!projectId) return;
    try {
      localStorage.setItem(
        `anvil.expandedScenes.${projectId}`,
        JSON.stringify(expandedSceneIds),
      );
    } catch {
      // localStorage can be disabled / full — silently skip persistence.
    }
  }, [expandedSceneIds, projectId]);
  useEffect(() => {
    if (!projectId) return;
    try {
      localStorage.setItem(
        `anvil.expandedBeats.${projectId}`,
        JSON.stringify(expandedBeatIds),
      );
    } catch {
      // localStorage can be disabled / full — silently skip persistence.
    }
  }, [expandedBeatIds, projectId]);
  // Restore the user's last-active section + selected items per project
  // on open. Without this, every session reopen drops the user back at
  // "story" with no item selected — on a 40-scene project that's 5+
  // navigation clicks before any work begins. The biggest single QoL
  // papercut in a normal editing day.
  useEffect(() => {
    if (!projectId) return;
    try {
      const rawSection = localStorage.getItem(`anvil.activeSection.${projectId}`);
      if (rawSection) setActiveSection(rawSection as SectionId);
    } catch {
      // localStorage disabled or quota — silently fall through to default.
    }
    try {
      const raw = localStorage.getItem(`anvil.selectedIds.${projectId}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          setSelectedIds((current) => ({ ...current, ...(parsed as Record<string, string>) }));
        }
      }
    } catch {
      // Malformed JSON — fall through to default.
    }
  }, [projectId]);
  useEffect(() => {
    if (!projectId) return;
    try {
      localStorage.setItem(`anvil.activeSection.${projectId}`, activeSection);
    } catch {
      // localStorage can be disabled / full — silently skip persistence.
    }
  }, [activeSection, projectId]);
  useEffect(() => {
    if (!projectId) return;
    try {
      localStorage.setItem(
        `anvil.selectedIds.${projectId}`,
        JSON.stringify(selectedIds),
      );
    } catch {
      // localStorage can be disabled / full — silently skip persistence.
    }
  }, [selectedIds, projectId]);
  // Persist context-group collapse state. Story sidebar groups (Project
  // / Canon / Asset / Agent / custom) re-expanded every session before
  // this — on a project with multiple custom groups the sidebar was
  // consistently cluttered on load.
  useEffect(() => {
    if (!projectId) return;
    try {
      const raw = localStorage.getItem(`anvil.collapsedContextGroups.${projectId}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          setCollapsedContextGroups(parsed as Record<string, boolean>);
          return;
        }
      }
    } catch {
      // Malformed JSON — fall through to default.
    }
    setCollapsedContextGroups({});
  }, [projectId]);
  useEffect(() => {
    if (!projectId) return;
    try {
      localStorage.setItem(
        `anvil.collapsedContextGroups.${projectId}`,
        JSON.stringify(collapsedContextGroups),
      );
    } catch {
      // localStorage can be disabled / full — silently skip persistence.
    }
  }, [collapsedContextGroups, projectId]);
  // Persist the last Assets subsection per project so the next session
  // lands back on Keyframes / Audio / etc. rather than snapping to the
  // default Media tab. Same pattern as expandedSceneIds above. Resets to
  // "media" on project switch when no saved value exists — prevents a
  // stale value leaking from the previous project.
  useEffect(() => {
    if (!projectId) {
      setLastAssetSection("media");
      return;
    }
    try {
      const raw = localStorage.getItem(`anvil.lastAssetSection.${projectId}`);
      if (raw && ASSET_SECTIONS.includes(raw as AssetSectionId)) {
        setLastAssetSection(raw as AssetSectionId);
        return;
      }
    } catch {
      // Malformed value or localStorage disabled — fall through to default.
    }
    setLastAssetSection("media");
  }, [projectId]);
  useEffect(() => {
    if (!projectId) return;
    try {
      localStorage.setItem(`anvil.lastAssetSection.${projectId}`, lastAssetSection);
    } catch {
      // Best-effort — absence just means fallback to "media" next session.
    }
  }, [lastAssetSection, projectId]);
  const [sceneContextMenu, setSceneContextMenu] = useState<{ sceneId: string; x: number; y: number } | null>(null);
  // Right-click menu on the Master Script row — global script-tree
  // operations (add scene at top/bottom, expand/collapse all). Lets us
  // hide buttons from the always-visible UI to keep the tree clean
  // while still giving power users the affordance.
  const [masterScriptContextMenu, setMasterScriptContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [scriptRailContextMenu, setScriptRailContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [clipContextMenu, setClipContextMenu] = useState<{ promptId: string; x: number; y: number } | null>(null);
  // Right-click menu on asset tiles — reveals OS-level file operations so
  // the user can ship a character portrait / audio cue to Discord / Slack /
  // browser without rooting around the filesystem manually. Wraps existing
  // IPCs (revealPath) + new copyImageToClipboard.
  const [assetContextMenu, setAssetContextMenu] = useState<
    { section: AssetSectionId; assetId: string; x: number; y: number } | null
  >(null);
  const [assetContextLibraryOpen, setAssetContextLibraryOpen] = useState(false);
  const [assetContextLibraryQuery, setAssetContextLibraryQuery] = useState("");
  const deferredAssetContextLibraryQuery = useDeferredValue(assetContextLibraryQuery);
  // Right-click on a linked-asset chip (in LinkedAssetRail). Mirrors the
  // asset-tile menu but scoped to the clicked chip — Copy path / Copy
  // image / Reveal / Unlink.
  const [linkedChipContextMenu, setLinkedChipContextMenu] = useState<
    { section: AssetSectionId; assetId: string; x: number; y: number } | null
  >(null);
  // "+ Add media" popover on the asset editor's meta-row. Keeps upload,
  // library, and generation-prompt entry behind one action.
  const [addVariantMenu, setAddVariantMenu] = useState<{ x: number; y: number } | null>(null);
  const selectedStoryDoc =
    activeSection === "story" && selectedItem && !selectedMagicDoc
      ? describeContextDoc(selectedItem as StoryEntry)
      : null;
  const agentBusy = Boolean(inFlightRequestId || sending || queuedAgentCount);
  const selectedItemKey = selectedMagicDoc
    ? `magic:${selectedMagicDoc.id}`
    : assetContextSelected
      ? "asset-context"
    : assetLibrarySelected
      ? "asset-library"
    : agentNoteSelected
      ? "agent-note"
    : selectedItem
      ? `${activeSection}:${selectedItem.id}`
      : "";
  const selectedTitle = assetContextSelected
    ? "Asset Context"
    : assetLibrarySelected
      ? "Asset Library"
    : agentNoteSelected
      ? AGENT_NOTE_LABEL
    : selectedMagicDoc
      ? selectedMagicDoc.name
      : selectedItem
        ? getEntryLabel(activeSection, selectedItem)
        : "";
  useEffect(() => {
    if (agentNoteSelected && activeSection !== "story") {
      setAgentNoteSelected(false);
    }
  }, [activeSection, agentNoteSelected]);
  useEffect(() => {
    if (!showAssetPreviewLightbox) return;
    if (!isAssetSection(activeSection) || !selectedItem || !("media" in selectedItem)) {
      setShowAssetPreviewLightbox(false);
    }
  }, [activeSection, selectedItem, showAssetPreviewLightbox]);
  useEffect(() => {
    if (!showVideoPreviewLightbox) return;
    if (activeSection !== "videos" || !handle?.projectDir || !videosWorkspace.previewVideo) {
      setShowVideoPreviewLightbox(false);
    }
  }, [
    activeSection,
    handle?.projectDir,
    showVideoPreviewLightbox,
    videosWorkspace.previewVideo,
  ]);
  useEffect(() => {
    setVideoNoteDraft(selectedVideo?.note || "");
  }, [selectedVideo?.id, selectedVideo?.note]);
  const selectedContent = selectedMagicDoc?.content ?? selectedItem?.content ?? "";
  const selectedDurationSec =
    activeSection === "script" || activeSection === "prompts"
      ? Number((selectedItem as ScriptEntry | PromptEntry | null)?.durationSec)
      : NaN;
  const selectedStoredDurationSec =
    Number.isFinite(selectedDurationSec) && selectedDurationSec > 0 ? Math.round(selectedDurationSec) : null;
  const selectedSceneIdentifierLabel =
    activeSection === "script" && selectedItem ? sceneIdentifierLabel(selectedItem as ScriptEntry) : "";
  const durationLimit = 3600; // 1 hour max — sanity cap

  useEffect(() => {
    if (activeSection === "videos") {
      if (videoBinItems.some((video) => video.id === selectedId)) return;
      const nextVideoId = videoBinItems[0]?.id || "";
      if (selectedId !== nextVideoId) {
        setSelectedIds((current) => ({ ...current, videos: nextVideoId }));
      }
      return;
    }
    if (selectedItem && selectedItem.id !== selectedId) {
      setSelectedIds((current) => ({ ...current, [activeSection]: selectedItem.id }));
    }
  }, [activeSection, selectedId, selectedItem, videoBinItems]);

  useEffect(() => {
    if (activeSection !== "videos") return;
    const videoId = videosWorkspace.previewVideo?.id || null;
    if (!videoId || videoBinAutoplayVideoIdRef.current !== videoId) return;
    videoBinAutoplayVideoIdRef.current = null;
    window.requestAnimationFrame(playVideoBinPreview);
  }, [activeSection, playVideoBinPreview, videosWorkspace.previewVideo?.id]);

  useEffect(() => {
    if (activeSection !== "story") {
      if (selectedMagicDocId) {
        setSelectedMagicDocId(null);
      }
      return;
    }
    if (!selectedMagicDocId) return;
    if (!visibleMagicDocEntries.some((entry) => entry.id === selectedMagicDocId)) {
      setSelectedMagicDocId(null);
    }
  }, [activeSection, selectedMagicDocId, visibleMagicDocEntries]);

  useEffect(() => {
    if (selectedItemKey !== lastDraftItemKeyRef.current) {
      lastDraftItemKeyRef.current = selectedItemKey;
      setTitleDraft(selectedTitle);
      setContentDraft(selectedContent);
      setDurationDraft(selectedStoredDurationSec ? String(selectedStoredDurationSec) : "");
      setEditingField(null);
      return;
    }

    if (editingField !== "title" && titleDraft !== selectedTitle) {
      setTitleDraft(selectedTitle);
    }

    if (editingField !== "content" && contentDraft !== selectedContent) {
      setContentDraft(selectedContent);
    }

    const normalizedDurationDraft = selectedStoredDurationSec ? String(selectedStoredDurationSec) : "";
    if (editingField !== "duration" && durationDraft !== normalizedDurationDraft) {
      setDurationDraft(normalizedDurationDraft);
    }
  }, [contentDraft, durationDraft, editingField, selectedContent, selectedItemKey, selectedStoredDurationSec, selectedTitle, titleDraft]);

  useEffect(() => {
    if (!isAssetSection(activeSection)) {
      return;
    }
    if (assetEditorRef.current) {
      assetEditorRef.current.scrollTop = 0;
    }
  }, [activeSection, selectedItemKey]);

  // Reset focus-lock whenever the open project changes. A lock's scenePath /
  // shotPath / path refers to THIS project's filesystem; carrying it across a
  // switch makes the new project's agent refuse every write with a misleading
  // "locked to scene X" error pointing at a path that no longer exists.
  useEffect(() => {
    setFocusScope({ kind: "none" });
    setLockMenuOpen(false);
  }, [activeProjectDir]);

  // F12 — scroll the active item-row into view on selection change (e.g.,
  // after a create, or when an agent tool selects an entity). Skips the
  // scroll when the row is already fully in the viewport so normal clicks
  // on visible rows don't jump. Keep this scoped to the owning list/grid:
  // native scrollIntoView can walk up to the app shell and make unrelated
  // panes lurch when add/delete changes selection.
  useEffect(() => {
    if (!selectedItemKey) return;
    const frame = window.requestAnimationFrame(() => {
      revealActiveNavItemInOwnScroller(reducedMotion ? "auto" : "smooth");
    });
    return () => window.cancelAnimationFrame(frame);
  }, [reducedMotion, selectedItemKey]);

  // L5 — gentle notice when the user navigates outside the locked scope.
  // Only fires on ACTIVE locks (not readonly / none), and only when the
  // newly-selected path is genuinely out-of-scope. Avoids spamming for
  // in-scope navigation.
  const lastOutOfScopePathRef = useRef<string | null>(null);
  useEffect(() => {
    if (focusScope.kind === "none" || focusScope.kind === "readonly") {
      lastOutOfScopePathRef.current = null;
      return;
    }
    const targetPath = projectContextSelected
	      ? "ANVIL.md"
	      : agentNoteSelected
	        ? AGENT_NOTE_PATH
	      : assetContextSelected
	        ? assetContextGuide?.path || ".forge/asset-context/guide.md"
	      : assetLibrarySelected
	        ? null
	      : selectedMagicDoc
        ? selectedMagicDoc.path
        : selectedItem?.path || null;
    if (!targetPath) {
      lastOutOfScopePathRef.current = null;
      return;
    }
    if (isPathInScope(focusScope, targetPath)) {
      lastOutOfScopePathRef.current = null;
      return;
    }
    // Skip if we've already flagged the same out-of-scope path — avoids
    // re-firing on unrelated re-renders (e.g., sibling state updates).
    if (lastOutOfScopePathRef.current === targetPath) return;
    lastOutOfScopePathRef.current = targetPath;
    setNotice("Outside lock scope. Release lock to allow writes.", "info", {
      category: "lock",
      importance: "attention",
      action: { label: "Release", target: { kind: "release-lock" } },
      dedupeKey: "lock:outside-scope",
    });
	  }, [agentNoteSelected, assetContextGuide?.path, assetContextSelected, assetLibrarySelected, focusScope, projectContextSelected, selectedMagicDoc, selectedItem]);

  useEffect(() => {
    if (!activeProjectDir) {
      setProjectContextDraft("");
      setProjectContextSelected(false);
      setAgentNoteSelected(false);
      setAgentNoteDraft("");
      setAssetContextSelected(false);
      setAssetLibrarySelected(false);
      setAssetContextGuide(null);
      setAssetContextGuideLoading(false);
      setPinboardSelected(false);
      setSectionFormatDraft({ script: "", prompts: "" });
      setSectionFormatSelected(null);
      return;
    }
    let cancelled = false;
    void window.forgeDesktop
      .readProjectContext(activeProjectDir, project?.project.name)
      .then((text) => {
        if (!cancelled) setProjectContextDraft(text || "");
      })
      .catch(() => {});
    void window.forgeDesktop
      .readAgentNote(activeProjectDir)
      .then((note) => {
        if (!cancelled) setAgentNoteDraft(note.content || "");
      })
      .catch(() => {});
    (["script", "prompts"] as FormatKind[]).forEach((kind) => {
      void window.forgeDesktop
        .readSectionConvention(activeProjectDir, kind)
        .then((text) => {
          if (!cancelled) {
            setSectionFormatDraft((current) => ({ ...current, [kind]: text || "" }));
          }
        })
        .catch(() => {});
    });
    return () => {
      cancelled = true;
    };
  }, [activeProjectDir, project?.project.name]);

  useEffect(() => {
    if (!activeProjectDir || !assetContextSelected) {
      setAssetContextGuideLoading(false);
      return;
    }
    let cancelled = false;
    setAssetContextGuideLoading(true);
    void window.forgeDesktop
      .readAssetContextGuide(activeProjectDir)
      .then((guide) => {
        if (!cancelled) {
          setAssetContextGuide(guide);
          setAssetContextGuideLoading(false);
        }
      })
      .catch((readError) => {
        if (!cancelled) {
          setError(readError instanceof Error ? readError.message : "Failed to load Asset Context guide.");
          setAssetContextGuideLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeProjectDir, assetContextSelected]);

  useEffect(() => {
    if (!activeProjectDir || !activeSessionKey) {
      setChatHistory([]);
      setComposerAttachments([]);
      setChatLoading(false);
      chatReadyRef.current = false;
      return;
    }

    let cancelled = false;
    chatReadyRef.current = false;
    setChatLoading(true);
    setChatHistory([]);
    chatStickToBottomRef.current = true;

    void window.forgeDesktop
      .loadChatHistory(activeProjectDir, activeSessionKey)
      .then((history) => {
        if (cancelled) return;
        setChatHistory(Array.isArray(history) ? history.map(sanitizeChatMessage) : []);
        chatReadyRef.current = true;
        setChatLoading(false);
      })
      .catch((historyError) => {
        if (cancelled) return;
        setError(historyError instanceof Error ? historyError.message : "Failed to load chat history.");
        setChatHistory([]);
        chatReadyRef.current = true;
        setChatLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeProjectDir, activeSessionKey]);

  useEffect(() => {
    if (!activeProjectDir || !activeSessionKey || !chatReadyRef.current) {
      return;
    }

    if (chatSaveTimer.current) {
      window.clearTimeout(chatSaveTimer.current);
    }

    chatSaveTimer.current = window.setTimeout(() => {
      void window.forgeDesktop
        .saveChatHistory(activeProjectDir, activeSessionKey, chatHistory.map(sanitizeChatMessage))
        .catch((historyError) => {
          setError(historyError instanceof Error ? historyError.message : "Failed to save chat history.");
        });
    }, 250);

    return () => {
      if (chatSaveTimer.current) {
        window.clearTimeout(chatSaveTimer.current);
      }
    };
  }, [activeProjectDir, activeSessionKey, chatHistory]);

  useEffect(() => {
    const node = chatListRef.current;
    if (!node || !chatStickToBottomRef.current) return;
    // Only auto-scroll when the user is already at/near the bottom. During
    // long agent turns a tool call update every second would otherwise yank
    // the user back while they're trying to re-read an earlier message.
    const frame = window.requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight;
      updateChatStickiness(node);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [combinedChatHistory]);

  useEffect(() => {
    agentQueueRef.current = agentQueue;
  }, [agentQueue]);

  useEffect(() => {
    setAgentQueue([]);
  }, [activeProjectDir, activeSessionKey]);

  useEffect(() => {
    setBrokenMediaIds({});
  }, [activeProjectDir, project?.project.updatedAt]);

  async function clearChat() {
    chatStickToBottomRef.current = true;
    setChatHistory([]);
    setAgentQueue([]);
    setExpandedMessageIds({});
    if (activeProjectDir && activeSessionKey) {
      try {
        await window.forgeDesktop.saveChatHistory(activeProjectDir, activeSessionKey, []);
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : "Failed to clear chat history.");
      }
    }
  }

  async function uploadChatAttachments() {
    if (!handle) return;
    setBusy("upload");
    setError(null);
    try {
      const uploaded = await window.forgeDesktop.uploadChatAttachments(handle.projectDir);
      if (!uploaded.length) return;
      setComposerAttachments((current) => [...current, ...uploaded]);
      setNotice(`${uploaded.length} file${uploaded.length === 1 ? "" : "s"} attached to chat.`);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Attachment upload failed.");
    } finally {
      setBusy(null);
    }
  }

  function removeComposerAttachment(attachmentId: string) {
    setComposerAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId));
  }

  useEffect(() => {
    if (!handle?.projectDir) {
      return;
    }

    let cancelled = false;
    const unsubscribe = window.forgeDesktop.onProjectChanged(() => {
      if (Date.now() < ignoreProjectChangesUntilRef.current) {
        return;
      }

      void Promise.all([
        window.forgeDesktop.openProjectAtPath(handle.projectDir),
        refreshProjectCompanionState(handle.projectDir),
      ])
        .then(([next]) => {
          if (!cancelled && next) {
            applyProjectHandle(next, 0);
          }
        })
        .catch((watchError) => {
          if (!cancelled) {
            setError(watchError instanceof Error ? watchError.message : "Project refresh failed.");
          }
        });
    });

    void window.forgeDesktop.watchProject(handle.projectDir).catch((watchError) => {
      if (!cancelled) {
        setError(watchError instanceof Error ? watchError.message : "Project watch failed.");
      }
    });

    void refreshProjectCompanionState(handle.projectDir).catch(() => {});

    return () => {
      cancelled = true;
      unsubscribe();
      void window.forgeDesktop.unwatchProject(handle.projectDir).catch(() => {});
    };
  }, [applyProjectHandle, handle?.projectDir, refreshProjectCompanionState]);

  async function persist(nextProject: ForgeProjectData) {
    if (!handle) return;
    setSaveState("saving");
    // Extend (don't clobber) queueSave's longer buffer, and use a 5s
    // pre-save window so a slow saveProject() doesn't expose its own
    // post-save fs event to the watcher reload path.
    ignoreProjectChangesUntilRef.current = Math.max(
      ignoreProjectChangesUntilRef.current,
      Date.now() + 5000,
    );
    try {
      const saved = await window.forgeDesktop.saveProject(handle.projectDir, nextProject);
      setHandle({ ...handle, project: saved });
      setSaveState("saved");
      setLastSavedAt(Date.now());
      // Re-extend AFTER the write completes so chokidar's post-save event
      // arrives inside the ignore window regardless of how long saveProject
      // took. Makes the window relative to save completion, not save start.
      ignoreProjectChangesUntilRef.current = Math.max(
        ignoreProjectChangesUntilRef.current,
        Date.now() + 1500,
      );
      // Force an immediate re-render of the "Saved Xs ago" label so the
      // user sees "Saved just now" right away, not stale "Unsaved" for up
      // to the 60s polling tick.
      setNowTick((v) => v + 1);
    } catch (saveError) {
      setSaveState("failed");
      throw saveError;
    }
  }

  // Undo/redo history — stores project snapshots before each mutation.
  // Cmd+Z pops the undo stack, Cmd+Shift+Z pushes to redo.
  const MAX_UNDO = 50;
  const undoStack = useRef<ForgeProjectData[]>([]);
  const redoStack = useRef<ForgeProjectData[]>([]);

  function queueSave(nextProject: ForgeProjectData) {
    // Push current state onto undo stack before applying the change
    if (project) {
      undoStack.current = [...undoStack.current.slice(-(MAX_UNDO - 1)), project];
      redoStack.current = []; // new action clears redo
    }
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
    }
    // Close the disk-watcher race: extend the ignore window from NOW to
    // persist-fire-time + save-completion + safety. Without this, the
    // 400ms debounce window was open to project-changed events clobbering
    // local mutations (click × → state updates → watcher fires → re-read
    // disk → old state restored). persist() will also extend this when it
    // actually runs.
    ignoreProjectChangesUntilRef.current = Math.max(
      ignoreProjectChangesUntilRef.current,
      Date.now() + 2500,
    );
    setHandle((current) => (current ? { ...current, project: nextProject } : current));
    saveTimer.current = window.setTimeout(() => {
      void persist(nextProject).catch((saveError) => {
        setError(saveError instanceof Error ? saveError.message : "Save failed.");
      });
    }, 400);
  }

  function undo() {
    if (undoStack.current.length === 0) return;
    const prev = undoStack.current[undoStack.current.length - 1];
    undoStack.current = undoStack.current.slice(0, -1);
    if (project) {
      redoStack.current = [...redoStack.current, project];
    }
    setHandle((current) => (current ? { ...current, project: prev } : current));
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void persist(prev).catch((saveError) => {
        setError(saveError instanceof Error ? saveError.message : "Save failed.");
      });
    }, 400);
    setNotice("Undo");
  }

  function redo() {
    if (redoStack.current.length === 0) return;
    const next = redoStack.current[redoStack.current.length - 1];
    redoStack.current = redoStack.current.slice(0, -1);
    if (project) {
      undoStack.current = [...undoStack.current, project];
    }
    setHandle((current) => (current ? { ...current, project: next } : current));
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void persist(next).catch((saveError) => {
        setError(saveError instanceof Error ? saveError.message : "Save failed.");
      });
    }, 400);
    setNotice("Redo");
  }

  async function commitNewSubsection(
    primary: PrimarySectionId,
    rawName: string,
    kind: CustomSubsectionKind,
    instructionsDraft: string,
  ) {
    const trimmed = rawName.trim();
    if (!trimmed || !project || !handle) return;
    if (primary === "agent") {
      setError("Custom subsections can't live under the Agent primary.");
      return;
    }
    const existing = Array.isArray(project.customSubsections) ? project.customSubsections : [];
    const existingForPrimary = existing.filter((sub) => sub.primary === primary);
    if (existingForPrimary.length >= LOCAL_UI_LIMITS.customSubsectionsPerPrimary) {
      setNotice(
        `${PRIMARY_LABELS[primary]} is limited to ${LOCAL_UI_LIMITS.customSubsectionsPerPrimary} custom sections. Rename or reuse one before adding more.`,
        "info",
      );
      return;
    }
    const narrowedPrimary: "story" | "script" | "assets" | "workshop" = primary;
    try {
      const created = await window.forgeDesktop.createCustomSubsection({
        projectDir: handle.projectDir,
        name: trimmed,
        primary: narrowedPrimary,
        kind,
        instructions: instructionsDraft.trim(),
      });
      const now = new Date().toISOString();
      const id: CustomSubsectionId = `custom:${
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
      }`;
      const fileExtensions = (() => {
        switch (kind) {
          case "docs": return [".md"];
          case "gallery": return [".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".mov", ".webm"];
          case "audio": return [".mp3", ".wav", ".m4a", ".ogg", ".flac"];
          default: return undefined;
        }
      })();
      const entry: CustomSubsection = {
        id,
        primary: narrowedPrimary,
        name: trimmed,
        kind,
        folder: created.folder,
        instructionsPath: created.instructionsPath,
        ...(fileExtensions ? { fileExtensions } : {}),
        createdAt: now,
        updatedAt: now,
      };
      queueSave({ ...project, customSubsections: [...existing, entry] });
      setExpandedPrimary(primary);
      setActiveSection(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not create subsection.";
      setError(message);
    }
  }

  async function commitInlineRename() {
    if (!inlineRename) return;
    const trimmed = inlineRename.draft.trim();
    if (!trimmed) {
      setInlineRename(null);
      return;
    }

    if (inlineRename.kind === "subsection") {
      if (!project) {
        setInlineRename(null);
        return;
      }
      const subs = Array.isArray(project.customSubsections) ? project.customSubsections : [];
      const target = subs.find((sub) => sub.id === inlineRename.id);
      if (!target || trimmed === target.name) {
        setInlineRename(null);
        return;
      }
      const next = subs.map((sub) =>
        sub.id === inlineRename.id
          ? { ...sub, name: trimmed, updatedAt: new Date().toISOString() }
          : sub,
      );
      queueSave({ ...project, customSubsections: next });
      setNotice(`Renamed to "${trimmed}".`);
      setInlineRename(null);
      return;
    }

    // subsection-doc — renames the file on disk via IPC. Save first if the
    // file is the currently-open editor doc and has unsaved changes.
    if (!handle?.projectDir) {
      setInlineRename(null);
      return;
    }
    const sourcePath = inlineRename.filePath;
    setInlineRename(null);
    if (customSubsectionDoc?.filePath === sourcePath && customSubsectionDoc.dirty) {
      const saved = await saveCustomSubsectionDoc();
      if (!saved) return;
    }
    try {
      const renamed = await window.forgeDesktop.renameCustomSubsectionDoc(
        handle.projectDir,
        sourcePath,
        trimmed,
      );
      setCustomSubsectionDoc((prev) =>
        prev && prev.filePath === sourcePath
          ? { ...prev, filePath: renamed.path, title: renamed.title, savedTitle: renamed.title }
          : prev,
      );
      setCustomSubsectionFilesRefreshKey((n) => n + 1);
      setNotice(`Renamed to "${trimmed}".`);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not rename.");
    }
  }

  // Returns the inline-rename <input> for the current renaming target.
  // Used by sub-rail labels, the subsection name panel, and doc list rows.
  function renderInlineRenameInput(className: string) {
    if (!inlineRename) return null;
    return (
      <input
        autoFocus
        type="text"
        className={className}
        value={inlineRename.draft}
        onChange={(e) =>
          setInlineRename((prev) => (prev ? { ...prev, draft: e.target.value } : prev))
        }
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commitInlineRename();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setInlineRename(null);
          }
          e.stopPropagation();
        }}
        onBlur={() => void commitInlineRename()}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onFocus={(e) => e.target.select()}
      />
    );
  }

  async function commitDeleteSubsection(target: { id: string; folder: string; name: string }) {
    if (!project || !handle?.projectDir) return;
    const { id, folder, name } = target;
    try {
      await window.forgeDesktop.deleteCustomSubsection(handle.projectDir, folder);
      const subs = Array.isArray(project.customSubsections) ? project.customSubsections : [];
      const deletedSubsection = subs.find((sub) => sub.id === id) || null;
      const next = subs.filter((sub) => sub.id !== id);
      queueSave({ ...project, customSubsections: next });
      if (activeSection === id) {
        const fallbackPrimary = deletedSubsection?.primary || "story";
        setActiveSection(fallbackPrimary === "script" ? "script" : "story");
        setExpandedPrimary(fallbackPrimary === "script" ? "script" : null);
      }
      setNotice(`Deleted "${name}".`);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not delete subsection.");
    }
  }

  function commitRemoveSubsectionFromRail(target: { id: CustomSubsectionId; name: string }) {
    if (!project) return;
    const subs = Array.isArray(project.customSubsections) ? project.customSubsections : [];
    const removed = subs.find((sub) => sub.id === target.id) || null;
    if (!removed) return;
    queueSave({ ...project, customSubsections: subs.filter((sub) => sub.id !== target.id) });
    if (activeSection === target.id) {
      switch (removed.primary) {
        case "script":
          setActiveSection("script");
          setExpandedPrimary("script");
          break;
        case "assets":
          setActiveSection("media");
          setExpandedPrimary("assets");
          break;
        case "workshop":
          setActiveSection("workshop");
          setExpandedPrimary("workshop");
          break;
        case "story":
        default:
          setActiveSection("story");
          setExpandedPrimary("story");
          break;
      }
    }
    setNotice(`Removed "${target.name}" from the rail. Files stayed on disk.`, "info");
  }

  function setScriptSubrailHiddenFromMenu(nextHidden: boolean) {
    setScriptSubrailHidden(nextHidden);
    if (nextHidden) {
      if (activeCustomSubsectionForNav?.primary === "script") {
        setActiveSection("script");
        setActiveScriptPath(masterScriptPathConst);
      }
      setExpandedPrimary(null);
      setNotice("Script sub-rail hidden. Right-click Script to show it again.", "info");
      return;
    }
    setExpandedPrimary("script");
    setNotice("Script sub-rail restored.", "info");
  }

  async function openCustomSubsectionDoc(filePath: string) {
    if (!activeCustomSubsection || !handle?.projectDir) return;
    if (customSubsectionDoc?.filePath === filePath) return;
    if (customSubsectionDoc?.dirty) {
      const saved = await saveCustomSubsectionDoc();
      if (!saved) return;
    }
    const loadToken = customSubsectionDocLoadTokenRef.current + 1;
    customSubsectionDocLoadTokenRef.current = loadToken;
    const subsectionId = activeCustomSubsection.id;
    try {
      const text = await window.forgeDesktop.readCustomSubsectionDoc(handle.projectDir, filePath);
      const title = markdownDocTitleFromPath(filePath);
      if (customSubsectionDocLoadTokenRef.current !== loadToken) return;
      setCustomSubsectionDoc({
        subsectionId,
        filePath,
        title,
        savedTitle: title,
        text,
        savedText: text,
        dirty: false,
        saving: false,
      });
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not open doc.");
    }
  }

  async function saveCustomSubsectionDoc(): Promise<boolean> {
    if (!customSubsectionDoc || !handle?.projectDir) return false;
    if (!customSubsectionDoc.dirty || customSubsectionDoc.saving) return true;
    if (customSubsectionDocSaveTimer.current) {
      window.clearTimeout(customSubsectionDocSaveTimer.current);
      customSubsectionDocSaveTimer.current = null;
    }
    const snapshot = customSubsectionDoc.text;
    const targetPath = customSubsectionDoc.filePath;
    setCustomSubsectionDoc((prev) => (prev ? { ...prev, saving: true } : prev));
    try {
      await window.forgeDesktop.writeCustomSubsectionDoc(
        handle.projectDir,
        targetPath,
        snapshot,
      );
      setCustomSubsectionDoc((prev) =>
        prev && prev.filePath === targetPath
          ? { ...prev, savedText: snapshot, dirty: prev.text !== snapshot, saving: false }
          : prev,
      );
      setCustomSubsectionFilesRefreshKey((n) => n + 1);
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not save doc.");
      setCustomSubsectionDoc((prev) => (prev ? { ...prev, saving: false } : prev));
      return false;
    }
  }

  async function renameCustomSubsectionDocFromTitle() {
    if (!customSubsectionDoc || !handle?.projectDir) return;
    const requestedTitle = customSubsectionDoc.title.trim();
    if (!requestedTitle) {
      setCustomSubsectionDoc((prev) =>
        prev ? { ...prev, title: prev.savedTitle } : prev,
      );
      return;
    }
    if (requestedTitle === customSubsectionDoc.savedTitle) return;
    const saved = await saveCustomSubsectionDoc();
    if (!saved) return;
    const sourcePath = customSubsectionDoc.filePath;
    setCustomSubsectionDoc((prev) => (prev ? { ...prev, saving: true } : prev));
    try {
      const renamed = await window.forgeDesktop.renameCustomSubsectionDoc(
        handle.projectDir,
        sourcePath,
        requestedTitle,
      );
      setCustomSubsectionDoc((prev) =>
        prev && prev.filePath === sourcePath
          ? {
              ...prev,
              filePath: renamed.path,
              title: renamed.title,
              savedTitle: renamed.title,
              saving: false,
            }
          : prev,
      );
      setCustomSubsectionFilesRefreshKey((n) => n + 1);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not rename doc.");
      setCustomSubsectionDoc((prev) => (prev ? { ...prev, saving: false } : prev));
    }
  }

  async function createCustomSubsectionDocNow(rawTitle = "Untitled") {
    if (!handle?.projectDir || !activeCustomSubsection) return;
    if (customSubsectionDocLimitReached) {
      setNotice(
        `${activeCustomSubsection.name} is limited to ${LOCAL_UI_LIMITS.customSubsectionDocs} markdown docs. Merge or delete old docs before adding more.`,
        "info",
      );
      return;
    }
    const title = rawTitle.trim() || "Untitled";
    try {
      const created = await window.forgeDesktop.createCustomSubsectionDoc(
        handle.projectDir,
        activeCustomSubsection.folder,
        title,
      );
      setCustomSubsectionDoc({
        subsectionId: activeCustomSubsection.id,
        filePath: created.path,
        title: created.title,
        savedTitle: created.title,
        text: created.text,
        savedText: created.text,
        dirty: false,
        saving: false,
      });
      setCustomSubsectionFilesRefreshKey((n) => n + 1);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not create doc.");
    }
  }

  async function commitNewDoc() {
    if (!newDocPrompt || !handle?.projectDir || !activeCustomSubsection) return;
    const trimmed = newDocPrompt.draft.trim();
    if (!trimmed) return;
    setNewDocPrompt((prev) => (prev ? { ...prev, busy: true } : prev));
    try {
      await createCustomSubsectionDocNow(trimmed);
      setNewDocPrompt(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not create doc.");
      setNewDocPrompt((prev) => (prev ? { ...prev, busy: false } : prev));
    }
  }

  function resolveAssetTarget(section: AssetSectionId, assetId: string): AssetOwner | null {
    if (section !== "media") {
      return {
        section,
        collectionKey: section as Exclude<AssetCollectionKey, "library">,
      };
    }
    return assetOwnerById.get(assetId) || null;
  }

  function patchSelected(content: string) {
    if (!project || !selectedItem) return;
    if (isAssetSection(activeSection)) {
      const target = resolveAssetTarget(activeSection, selectedItem.id);
      if (!target) return;
      const nextSectionItems = ((project[target.collectionKey] || []) as AssetEntry[]).map((item) =>
        item.id === selectedItem.id
          ? { ...item, content, name: getEntryLabel(target.section, item) }
          : item,
      );
      queueSave({ ...project, [target.collectionKey]: nextSectionItems });
      return;
    }
    const nextSectionItems = getSectionItems(project, activeSection).map((item) =>
      item.id === selectedItem.id
        ? { ...item, content }
        : item,
    );
    queueSave({ ...project, [activeSection]: nextSectionItems });
  }

  function patchEntryMeta(section: SectionId, itemId: string, patch: Record<string, unknown>) {
    if (!project) return;
    if (isAssetSection(section)) {
      const target = resolveAssetTarget(section, itemId);
      if (!target) return;
      const sectionItems = (project[target.collectionKey] || []) as AssetEntry[];
      const targetItem = sectionItems.find((item) => item.id === itemId) || null;
      if (!targetItem) return;
      const nextSectionItems = sectionItems.map((item) =>
        item.id === itemId ? { ...item, ...patch } : item,
      );
      queueSave({ ...project, [target.collectionKey]: nextSectionItems });
      return;
    }
    const sectionItems = getSectionItems(project, section);
    const targetItem = sectionItems.find((item) => item.id === itemId) || null;
    if (!targetItem) return;

    // Runtime cascade: master → scenes, scene → beats, beat → shots, shot → siblings.
    // The logic lives in src/lib/runtime-cascade.ts so it's testable in
    // isolation. Each helper returns a partial project diff or null; null
    // means "no cascade applies" and we fall through to pin policy.
    if (section === "script" && "durationSec" in patch) {
      const entry = targetItem as ScriptEntry;
      if (entry.kind === "master") {
        const result = cascadeMasterToScenes(project, entry.id, patch);
        if (result) {
          queueSave({ ...project, ...result });
          return;
        }
      }
    }
    // Default: pin policy — only sets THIS item.
    const nextSectionItems = sectionItems.map((item) =>
      item.id === itemId ? { ...item, ...patch } : item,
    );
    queueSave({ ...project, [section]: nextSectionItems });
  }

  function patchSelectedMeta(patch: Record<string, unknown>) {
    if (!selectedItem) return;
    patchEntryMeta(activeSection, selectedItem.id, patch);
  }

  // `window.prompt()` is blocked in Electron BrowserWindow contexts —
  // we switched to an inline-edit pattern. `editingDurationKey` tracks
  // which row is editing; the draft string lives inside RuntimeBadge
  // (local useState) so keystrokes don't re-render the whole App tree.
  function startDurationEdit(section: "script" | "prompts", itemId: string) {
    setEditingDurationKey(`${section}:${itemId}`);
  }

  function initialDurationDraft(currentDurationSec: number | null | undefined) {
    return currentDurationSec && currentDurationSec > 0
      ? String(Math.round(currentDurationSec))
      : "";
  }

  function commitDurationEdit(
    section: "script" | "prompts",
    itemId: string,
    draft: string,
  ) {
    const limit = section === "prompts" ? SEEDANCE_CLIP_MAX_SEC : durationLimit;
    const parsed = parseDurationInput(draft, limit);
    const value =
      section === "prompts" && parsed.value !== null
        ? Math.max(SEEDANCE_CLIP_MIN_SEC, Math.min(SEEDANCE_CLIP_MAX_SEC, parsed.value))
        : parsed.value;
    patchEntryMeta(section, itemId, { durationSec: value });
    setEditingDurationKey(null);
  }

  function cancelDurationEdit() {
    setEditingDurationKey(null);
  }

  // Explicit redistribute: user clicks "Distribute to shots" on a scene,
  // or "Distribute to scenes" on master. Uses distributeEvenly for exact sums.
  function redistributeDurationToChildren(
    parentId: string,
    policy: "equal" | "scale" = "equal",
  ) {
    if (!project) return;
    const entry = project.script.find((e) => e.id === parentId);
    if (!entry) return;
    const parentDur = Number(entry.durationSec);
    if (!Number.isFinite(parentDur) || parentDur <= 0) {
      setNotice("Set a target duration first.");
      return;
    }
    const totalSec = Math.round(parentDur);

    if (entry.kind === "master") {
      const scenes = project.script.filter((e) => e.kind === "scene");
      if (scenes.length === 0) return;
      if (policy === "scale") {
        const oldValues = scenes.map((s) => {
          const explicit = Number(s.durationSec);
          const derived = sceneDurationById.get(s.id) || 0;
          return Number.isFinite(explicit) && explicit > 0 ? Math.round(explicit) : derived;
        });
        const scaled = scaleProportionally(oldValues, totalSec);
        if (!scaled) {
          setNotice("Cannot scale — children exceed target.");
          return;
        }
        const sceneIds = scenes.map((s) => s.id);
        const nextScript = project.script.map((e) => {
          const idx = sceneIds.indexOf(e.id);
          return idx >= 0 ? { ...e, durationSec: scaled[idx] } : e;
        });
        queueSave({ ...project, script: nextScript });
        setNotice(`Scaled ${scenes.length} scenes to fit ${formatDurationLabel(totalSec)}.`);
      } else {
        const perScene = distributeEvenly(totalSec, scenes.length);
        const sceneIds = scenes.map((s) => s.id);
        const nextScript = project.script.map((e) => {
          const idx = sceneIds.indexOf(e.id);
          return idx >= 0 ? { ...e, durationSec: perScene[idx] } : e;
        });
        queueSave({ ...project, script: nextScript });
        setNotice(`Distributed ${formatDurationLabel(totalSec)} equally across ${scenes.length} scenes.`);
      }
      return;
    }

    if (entry.kind === "scene") {
      // Distribute scene runtime across LEAF prompts only — skip
      // parent containers (prompts that have children). A container's
      // own durationSec is ignored at the totals level (see
      // clipDurationBySceneId), so writing a duration into it here
      // would orphan time that never shows up anywhere. Children
      // carry the real runtime.
      const idsWithChildren = new Set<string>();
      for (const p of project.prompts || []) {
        if (p.parentPromptId) idsWithChildren.add(p.parentPromptId);
      }
      const sceneClips = (project.prompts || [])
        .filter((prompt) => promptBelongsToSceneForDisplay(prompt, entry))
        .filter((prompt) => !idsWithChildren.has(prompt.id));
      if (sceneClips.length > 0) {
        if (totalSec > sceneClips.length * SEEDANCE_CLIP_MAX_SEC) {
          const needed = Math.ceil(totalSec / SEEDANCE_CLIP_MAX_SEC);
          setNotice(`Add ${needed - sceneClips.length} more prompt${needed - sceneClips.length === 1 ? "" : "s"} — Seedance prompts cap at 15s.`);
          return;
        }
        if (totalSec < sceneClips.length * SEEDANCE_CLIP_MIN_SEC) {
          setNotice(`Scene target is below Seedance's 5s floor for ${sceneClips.length} prompts.`);
          return;
        }

        const clipIds = sceneClips.map((prompt) => prompt.id);
        let nextDurations: number[] | null = null;
        if (policy === "scale") {
          const oldValues = sceneClips.map((prompt) => clipDurationSeconds(prompt.durationSec));
          const scaled = scaleProportionally(oldValues, totalSec);
          if (scaled && scaled.every((value) => value >= SEEDANCE_CLIP_MIN_SEC && value <= SEEDANCE_CLIP_MAX_SEC)) {
            nextDurations = scaled;
          }
        }
        if (!nextDurations) {
          nextDurations = distributeEvenly(totalSec, sceneClips.length);
        }
        if (!nextDurations.every((value) => value >= SEEDANCE_CLIP_MIN_SEC && value <= SEEDANCE_CLIP_MAX_SEC)) {
          setNotice("Cannot distribute scene runtime inside Seedance's 5-15s prompt range.");
          return;
        }

        const nextPrompts = project.prompts.map((prompt) => {
          const idx = clipIds.indexOf(prompt.id);
          return idx >= 0 ? { ...prompt, durationSec: nextDurations[idx] ?? DEFAULT_CLIP_DURATION_SEC } : prompt;
        });
        queueSave({ ...project, prompts: nextPrompts });
        setNotice(`Distributed ${formatDurationLabel(totalSec)} across ${sceneClips.length} prompts.`);
        return;
      }

    }
  }

  async function openProject() {
    setBusy("open-pick");
    setError(null);
    try {
      const next = await window.forgeDesktop.openProject();
      if (next) {
        applyOpenedProject(next, `Opened ${next.project.project.name}`);
      }
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : "Open project failed.");
    } finally {
      setBusy(null);
    }
  }

  async function openRecentProject(projectDir: string) {
    setBusy("open");
    setError(null);
    try {
      const next = await window.forgeDesktop.openRecentProject(projectDir);
      if (next) {
        applyOpenedProject(next, `Opened ${next.project.project.name}`);
      }
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : "Open recent project failed.");
      void refreshRecentProjects();
    } finally {
      setBusy(null);
    }
  }

  async function revealCurrentProjectFolder() {
    if (!handle) return;
    try {
      await window.forgeDesktop.revealPath(handle.projectDir);
      setNotice(`Opened ${project?.project.name || "project"} in Finder.`);
    } catch (revealError) {
      setError(revealError instanceof Error ? revealError.message : "Reveal project folder failed.");
    }
  }

  async function openProjectTerminal() {
    if (!handle) return;
    try {
      await window.forgeDesktop.openProjectTerminal(handle.projectDir, "shell");
      setNotice(`Opened terminal in the project folder.`, "success", {
        category: "project",
        visibility: "toast",
        importance: "low",
        dedupeKey: "project:terminal:shell",
      });
    } catch (terminalError) {
      setError(terminalError instanceof Error ? terminalError.message : "Open terminal failed.");
    }
  }

  function openCreateProjectModal() {
    setProjectNameDraft("Anvil Project");
    setShowCreateProjectModal(true);
    setError(null);
  }

  async function submitCreateProject() {
    const name = projectNameDraft.trim();
    if (!name) {
      setError("Project name is required.");
      return;
    }

    setBusy("create-pick");
    setError(null);
    try {
      const next = await window.forgeDesktop.createProject(name);
      if (next) {
        applyOpenedProject(next, `Created ${next.project.project.name}`);
        setShowCreateProjectModal(false);
      }
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Create project failed.");
    } finally {
      setBusy(null);
    }
  }

  const jumpToAsset = useCallback((section: SectionId, assetId: string) => {
    setProjectContextSelected(false);
    setAgentNoteSelected(false);
    setAssetContextSelected(false);
    setAssetLibrarySelected(false);
    setPinboardSelected(false);
    setSectionFormatSelected(null);
    setSelectedMagicDocId(null);
    setActiveSection(section);
    setSelectedIds((current) => ({ ...current, [section]: assetId }));
    // Sync the expanded sub-rail to the section's primary so the user actually
    // sees the navigation land. Without this, jumping from a scene/shot row
    // (script primary) into a character (assets primary) silently flipped
    // activeSection but kept the script sub-rail expanded — read as "click
    // did nothing" because the visible rail never moved.
    setExpandedPrimary(primaryForSection(section));
  }, []);

  // Navigate the main pane to a project-relative path. Used by clickable
  // path chips in agent replies. Best-effort — if the path doesn't match a
  // known entry we surface a notice rather than silently doing nothing.
  const jumpToPath = useCallback((rawPath: string) => {
    if (!project) return;
    const path = rawPath.replace(/^\.\//, "").replace(/^\/+/, "");
    if (path === "ANVIL.md") {
      setPinboardSelected(false);
      setAssetContextSelected(false);
      setAssetLibrarySelected(false);
      setAgentNoteSelected(false);
      setSectionFormatSelected(null);
      setSelectedMagicDocId(null);
      setActiveSection("story");
      setProjectContextSelected(true);
      return;
    }
    if (path === "AGENT.md" || path === "AGENTS.md" || path === "CLAUDE.md" || path === AGENT_NOTE_PATH) {
      if (!SHOW_INTERNAL_CONTEXT_SURFACES) {
        setNotice("Agent support notes are hidden in the local-first Context view.", "info", {
          category: "story",
          visibility: "log",
          importance: "low",
          dedupeKey: "story:hidden-agent-note",
        });
        return;
      }
      setPinboardSelected(false);
      setAssetContextSelected(false);
      setAssetLibrarySelected(false);
      setProjectContextSelected(false);
      setSectionFormatSelected(null);
      setSelectedMagicDocId(null);
      setActiveSection("story");
      setExpandedPrimary("story");
      setAgentNoteSelected(true);
      return;
    }
    if (path === ".forge/asset-context/guide.md" || path.startsWith(".forge/asset-context/")) {
      if (!SHOW_INTERNAL_CONTEXT_SURFACES) {
        setNotice("Internal asset-context support files are hidden from the Context view.", "info", {
          category: "story",
          visibility: "log",
          importance: "low",
          dedupeKey: "story:hidden-asset-context",
        });
        return;
      }
      setPinboardSelected(false);
      setAssetLibrarySelected(false);
      setProjectContextSelected(false);
      setAgentNoteSelected(false);
      setSectionFormatSelected(null);
      setSelectedMagicDocId(null);
      setActiveSection("story");
      setExpandedPrimary("story");
      setAssetContextSelected(true);
      return;
    }
    const find = <T extends { id: string; path?: string | null }>(list: T[]): T | null =>
      list.find((e) => (e.path || "").replace(/^\.\//, "") === path) || null;
    const scriptHit = find(project.script);
    if (scriptHit) {
      jumpToAsset("script", scriptHit.id);
      return;
    }
    const dialogueHit = find(project.dialogue || []);
    if (dialogueHit) {
      jumpToAsset("dialogue", dialogueHit.id);
      return;
    }
    const promptHit = find(project.prompts);
    if (promptHit) {
      jumpToAsset("prompts", promptHit.id);
      return;
    }
    const storyHit = find(project.story);
    if (storyHit) {
      jumpToAsset("story", storyHit.id);
      return;
    }
    for (const section of ["characters", "locations", "props", "keyframes", "audio"] as const) {
      const hit = find(project[section]);
      if (hit) {
        jumpToAsset(section, hit.id);
        return;
      }
    }
    const customHit = (Array.isArray(project.customSubsections) ? project.customSubsections : []).find((sub) => {
      const folder = (sub.folder || "").replace(/\/+$/, "");
      return path === sub.instructionsPath || (folder && path.startsWith(`${folder}/`));
    });
    if (customHit) {
      setPinboardSelected(false);
      setAssetContextSelected(false);
      setAssetLibrarySelected(false);
      setProjectContextSelected(false);
      setAgentNoteSelected(false);
      setSectionFormatSelected(null);
      setSelectedMagicDocId(null);
      setActiveSection(customHit.id);
      setExpandedPrimary(customHit.primary);
      if (path !== customHit.instructionsPath && path.endsWith(".md") && handle?.projectDir) {
        const loadToken = customSubsectionDocLoadTokenRef.current + 1;
        customSubsectionDocLoadTokenRef.current = loadToken;
        void window.forgeDesktop
          .readCustomSubsectionDoc(handle.projectDir, path)
          .then((text) => {
            if (customSubsectionDocLoadTokenRef.current !== loadToken) return;
            const title = markdownDocTitleFromPath(path);
            setCustomSubsectionDoc({
              subsectionId: customHit.id,
              filePath: path,
              title,
              savedTitle: title,
              text,
              savedText: text,
              dirty: false,
              saving: false,
            });
          })
          .catch((error) => {
            setError(error instanceof Error ? error.message : "Could not open doc.");
          });
      } else {
        setCustomSubsectionDoc(null);
      }
      return;
    }
    setNotice(`Couldn't locate "${path}" in the project.`, "info");
  }, [handle?.projectDir, project, jumpToAsset, setNotice]);

  const openNoticeTarget = useCallback((target: NoticeActionTarget) => {
    if (target.kind === "revealPath" || target.kind === "release-lock" || target.kind === "settings") return;
    if (target.kind === "magicDoc") {
      if (!SHOW_MAGIC_DOC_SURFACE) {
        setShowNoticeLog(false);
        setNotice("Source summaries are internal in this build.", "info", {
          category: "story",
          visibility: "log",
          importance: "low",
          dedupeKey: "story:hidden-magic-doc",
        });
        return;
      }
      setProjectContextSelected(false);
      setAssetContextSelected(false);
      setAssetLibrarySelected(false);
      setPinboardSelected(false);
      setSectionFormatSelected(null);
      setActiveSection("story");
      setExpandedPrimary("story");
      setSelectedMagicDocId(target.id);
      return;
    }
    if (target.kind === "video") {
      if (!SHOW_WORKSHOP_SURFACE) {
        setShowNoticeLog(false);
        setNotice("Workshop is archived in this production build.", "info", {
          category: "videos",
          visibility: "log",
          importance: "low",
          dedupeKey: "workshop:archived",
        });
        return;
      }
      setProjectContextSelected(false);
      setAssetContextSelected(false);
      setAssetLibrarySelected(false);
      setPinboardSelected(false);
      setSectionFormatSelected(null);
      setSelectedMagicDocId(null);
      setActiveSection("workshop");
      setExpandedPrimary("workshop");
      setSelectedIds((current) => ({ ...current, videos: target.id }));
      return;
    }
    if (target.kind === "section") {
      setProjectContextSelected(false);
      setAssetContextSelected(false);
      setAssetLibrarySelected(false);
      setPinboardSelected(false);
      setSectionFormatSelected(null);
      setSelectedMagicDocId(null);
      setActiveSection(target.section);
      setExpandedPrimary(primaryForSection(target.section));
      if (target.itemId) {
        setSelectedIds((current) => ({ ...current, [target.section]: target.itemId || "" }));
      }
      return;
    }
	  }, [jumpToAsset]);

  const runNoticeAction = useCallback((target: NoticeActionTarget) => {
    if (target.kind === "revealPath") {
      if (!handle?.projectDir || !window.forgeDesktop?.revealPath) return;
      setShowNoticeLog(false);
      void window.forgeDesktop.revealPath(handle.projectDir, target.relativePath).catch((revealError) => {
        setError(revealError instanceof Error ? revealError.message : "Reveal failed.");
      });
      return;
    }
    if (target.kind === "release-lock") {
      setFocusScope({ kind: "none" });
      setShowNoticeLog(false);
      setNotice("Focus lock released.", "info");
      return;
    }
    if (target.kind === "settings") {
      setShowNoticeLog(false);
      setShowHeaderMenu(false);
      openSettingsModal();
      return;
    }
    setShowNoticeLog(false);
    openNoticeTarget(target);
  }, [handle?.projectDir, openNoticeTarget, openSettingsModal, setNotice]);

  function activatePrimary(next: PrimarySectionId) {
    if (next === "agent") {
      if (!SHOW_AGENT_SURFACE) return;
      setAgentPrimarySelected(true);
      setChatCollapsed(false);
      window.requestAnimationFrame(() => {
        chatInputRef.current?.focus();
      });
      return;
    }
    setAgentPrimarySelected(false);
    // Sub-rail toggle policy:
    //   - First click on a primary that has items → open the rail
    //   - First click on an empty primary → activate it but leave the
    //     rail collapsed; click again to surface the + button
    //   - Click on an already-active primary → toggle the rail
    const primaryAlreadyActive = activePrimary === next;
    const railToggle = (primary: PrimarySectionId) =>
      setExpandedPrimary((current) => {
        if (current === primary) return null; // collapse open rail
        if (primaryAlreadyActive) return primary; // re-click on active opens, even when empty
        return subrailHasItems(primary) ? primary : null; // first click: only open if items
      });
    if (next === "story") {
      const currentlyStory = activePrimary === "story";
      railToggle("story");
      if (!currentlyStory) {
        setActiveSection("story");
        setSectionFormatSelected(null);
        setPinboardSelected(false);
        setAssetContextSelected(false);
        setAssetLibrarySelected(false);
        setProjectContextSelected(!selectedIds.story);
      }
      return;
    }
    if (next === "script") {
      setProjectContextSelected(false);
      setAssetContextSelected(false);
      setAssetLibrarySelected(false);
      setPinboardSelected(false);
      setSectionFormatSelected(null);
      setActiveSection("script");
      railToggle("script");
      return;
    }
    if (next === "assets") {
      setProjectContextSelected(false);
      setAssetContextSelected(false);
      setAssetLibrarySelected(false);
      setPinboardSelected(false);
      setSectionFormatSelected(null);
      setActiveSection(lastAssetSection);
      railToggle("assets");
      return;
    }
    if (next === "workshop") {
      if (!SHOW_WORKSHOP_SURFACE) return;
      // Workshop is a leaf primary — no sub-rail. Click goes straight
      // to the NLE; never expand the rail column for it.
      setProjectContextSelected(false);
      setAssetContextSelected(false);
      setAssetLibrarySelected(false);
      setPinboardSelected(false);
      setSectionFormatSelected(null);
      setSelectedMagicDocId(null);
      setActiveSection("workshop");
      setExpandedPrimary(null);
      return;
    }
  }

  function reorderSectionItems(
    section: SectionId,
    sourceId: string,
    targetId: string,
    position: DragOver["position"] = "below",
  ) {
    if (!project || sourceId === targetId) return;
    if (section === "media" || section === "timeline") return;
    const sectionItems = getSectionItems(project, section);
    const fromIndex = sectionItems.findIndex((item) => item.id === sourceId);
    const targetIndex = sectionItems.findIndex((item) => item.id === targetId);
    if (fromIndex < 0 || targetIndex < 0) return;

    let reorderedScriptParentPath: string | null = null;

    // Guard: never move the master script entry, and never let a scene
    // drag imply a cross-script parent move. Scene order is persisted
    // below as explicit sceneOrder frontmatter + the script's
    // "Scene file order" block.
    if (section === "script") {
      const source = sectionItems[fromIndex] as ScriptEntry;
      const target = sectionItems[targetIndex] as ScriptEntry;
      if (source.kind === "master" || target.kind === "master") return;
      const sourceParent = sceneParentScriptPath(source);
      const targetParent = sceneParentScriptPath(target);
      if (sourceParent !== targetParent) {
        setNotice("Can't drag scenes across scripts. Move within the same script.");
        return;
      }
      reorderedScriptParentPath = sourceParent;
    }

    // Guard: block cross-parent reorder for nested script units. Reordering
    // changes array order only; it must not silently imply a parent move.
    if (section === "prompts") {
      const source = sectionItems[fromIndex] as PromptEntry;
      const target = sectionItems[targetIndex] as PromptEntry;
      const sourceScene = findSceneForPrompt(source);
      const targetScene = findSceneForPrompt(target);
      if ((sourceScene?.id || source.sceneId || "") !== (targetScene?.id || target.sceneId || "")) {
        setNotice("Can't drag prompts across scenes. Move within the same scene.");
        return;
      }
    }

    // Translate (target, position) into the post-removal insert index.
    // After splicing source out at fromIndex, indices to the right shift
    // down by 1, so the target moves from T to T-1 iff fromIndex < T.
    let toIndex: number;
    const insertAfter = position === "below" || position === "after";
    if (insertAfter) {
      toIndex = fromIndex < targetIndex ? targetIndex : targetIndex + 1;
    } else {
      toIndex = fromIndex < targetIndex ? targetIndex - 1 : targetIndex;
    }
    if (fromIndex === toIndex) return;

    const movedItems = moveItem(sectionItems, fromIndex, toIndex);
    let nextSectionItems =
      section === "script" && reorderedScriptParentPath
        ? persistSceneOrderForScript(movedItems as ScriptEntry[], reorderedScriptParentPath)
        : movedItems;
    if (section === "prompts") {
      const source = sectionItems[fromIndex] as PromptEntry;
      const sourceScene = findSceneForPrompt(source);
      if (sourceScene) {
        const scenePrompts = (nextSectionItems as PromptEntry[]).filter((item) => promptBelongsToSceneForDisplay(item, sourceScene));
        const sequenceById = new Map(
          scenePrompts.map((prompt, index) => [
            prompt.id,
            {
              prevPromptId: index > 0 ? scenePrompts[index - 1]?.id || null : null,
              segmentIndex: index + 1,
            },
          ]),
        );
        nextSectionItems = (nextSectionItems as PromptEntry[]).map((prompt) => {
          const sequence = sequenceById.get(prompt.id);
          if (!sequence) return prompt;
          return {
            ...prompt,
            prevPromptId: sequence.prevPromptId,
            segmentIndex: sequence.segmentIndex,
          };
        });
      }
    }
    setSelectedIds((current) => ({ ...current, [section]: sourceId }));
    queueSave({ ...project, [section]: nextSectionItems });
  }

  function reorderActiveSectionItems(
    sourceId: string,
    targetId: string,
    position: DragOver["position"] = "below",
  ) {
    reorderSectionItems(activeSection, sourceId, targetId, position);
  }

  function reorderAssetOwnerItems(
    sourceId: string,
    targetId: string,
    position: DragOver["position"],
    owner: AssetOwner,
  ) {
    if (!project || sourceId === targetId) return;
    const sectionItems = ((project[owner.collectionKey] || []) as AssetEntry[]);
    const fromIndex = sectionItems.findIndex((item) => item.id === sourceId);
    const targetIndex = sectionItems.findIndex((item) => item.id === targetId);
    if (fromIndex < 0 || targetIndex < 0) return;
    const insertAfter = position === "below" || position === "after";
    const toIndex = insertAfter
      ? fromIndex < targetIndex ? targetIndex : targetIndex + 1
      : fromIndex < targetIndex ? targetIndex - 1 : targetIndex;
    if (fromIndex === toIndex) return;
    const nextSectionItems = moveItem(sectionItems, fromIndex, toIndex);
    setSelectedIds((current) => ({
      ...current,
      [activeSection]: sourceId,
      [owner.section]: sourceId,
    }));
    queueSave({ ...project, [owner.collectionKey]: nextSectionItems });
  }

  // Insert a new scene at a specific position (after the given scene ID)
  function insertSceneAfter(afterSceneId: string) {
    if (!project) return;
    const scenes = project.script.filter((e) => (e as ScriptEntry).kind === "scene") as ScriptEntry[];
    const afterIndex = scenes.findIndex((s) => s.id === afterSceneId);
    // Insert after the target scene in the script array
    const scriptInsertIndex = project.script.findIndex((e) => e.id === afterSceneId);
    if (afterIndex < 0 || scriptInsertIndex < 0) {
      setNotice("That scene is no longer available.", "error");
      return;
    }
    const newScene = createScriptSceneEntry(project);
    const nextScript = [...project.script];
    nextScript.splice(scriptInsertIndex + 1, 0, newScene);
    queueSave({ ...project, script: nextScript });
    setMasterScriptTreeExpanded(true);
    setExpandedSceneIds((current) => ({ ...current, [newScene.id]: true }));
    jumpToAsset("script", newScene.id);
    setNotice(`New scene inserted after "${getEntryLabel("script", scenes[afterIndex])}".`);
  }

  function insertSceneBefore(beforeSceneId: string) {
    if (!project) return;
    const scenes = project.script.filter((e) => (e as ScriptEntry).kind === "scene") as ScriptEntry[];
    const beforeIndex = scenes.findIndex((s) => s.id === beforeSceneId);
    const scriptInsertIndex = project.script.findIndex((e) => e.id === beforeSceneId);
    if (beforeIndex < 0 || scriptInsertIndex < 0) {
      setNotice("That scene is no longer available.", "error");
      return;
    }
    const newScene = createScriptSceneEntry(project);
    const nextScript = [...project.script];
    nextScript.splice(scriptInsertIndex, 0, newScene);
    queueSave({ ...project, script: nextScript });
    setMasterScriptTreeExpanded(true);
    setExpandedSceneIds((current) => ({ ...current, [newScene.id]: true }));
    jumpToAsset("script", newScene.id);
    setNotice(`New scene inserted before "${getEntryLabel("script", scenes[beforeIndex])}".`);
  }

  // "Add scene at top" — convenience for the master-row context menu so
  // the user doesn't have to scroll to scene 1 just to insert ahead of
  // it. Mirrors createItem's path but pins position 0.
  function insertSceneAtTop() {
    if (!project) return;
    const newScene = createScriptSceneEntry(project);
    const firstSceneIndex = project.script.findIndex(
      (e) => (e as ScriptEntry).kind === "scene",
    );
    const nextScript = [...project.script];
    if (firstSceneIndex < 0) {
      // No scenes yet — append after Master Script.
      nextScript.push(newScene);
    } else {
      nextScript.splice(firstSceneIndex, 0, newScene);
    }
    queueSave({ ...project, script: nextScript });
    setMasterScriptTreeExpanded(true);
    setExpandedSceneIds((current) => ({ ...current, [newScene.id]: true }));
    jumpToAsset("script", newScene.id);
    setNotice("New scene inserted at top.");
  }


  function hierarchyTitleText(title: string) {
    return String(title || "")
      .replace(/^\s*\d+(?:\.\d+)*\s*[—\-:·]\s*/u, "")
      .trim();
  }

  function hierarchyNumber(value: number) {
    return String(Math.max(1, value)).padStart(2, "0");
  }

  function clipTitleForOrder(scene: ScriptEntry, clip: PromptEntry, order: number) {
    const sceneNumber = hierarchyNumber(sceneEntries.findIndex((entry) => entry.id === scene.id) + 1);
    const existingBase = hierarchyTitleText(getEntryLabel("prompts", clip)) || `Prompt ${hierarchyNumber(order)}`;
    const normalizedBase = /^(Clip|Prompt)\s+\d+$/i.test(existingBase)
      ? `Prompt ${hierarchyNumber(order)}`
      : existingBase;
    return `${sceneNumber}.${hierarchyNumber(order)} — ${normalizedBase}`;
  }

  function appendClipToScene(sceneId: string) {
    if (!project) return;
    const scene = sceneEntries.find((entry) => entry.id === sceneId);
    if (!scene) return;

    const sceneClips = promptsBySceneId.get(sceneId) || [];
    const clipIndex = sceneClips.length + 1;
    const sceneNumber = hierarchyNumber(sceneEntries.findIndex((entry) => entry.id === sceneId) + 1);
    const previousClip = sceneClips[sceneClips.length - 1] || null;
    const baseTitle = `Prompt ${hierarchyNumber(clipIndex)}`;
    const nextClip = {
      ...(createEntry("prompts", project.prompts.length, {
        defaultSceneId: scene.id,
        defaultScenePath: scene.path,
      }) as PromptEntry),
      prevPromptId: previousClip?.id || null,
      content: "15-second Seedance 2 prompt. A prompt can cover a segment of a long continuous shot, one complete shot, or a short multi-shot sequence. Describe only what belongs inside this prompt: visible action, camera order, setting, lighting, and continuity from the previous prompt.",
      durationSec: 15,
      segmentIndex: clipIndex,
      segmentStartSec: 0,
      segmentEndSec: 15,
      title: `${sceneNumber}.${hierarchyNumber(clipIndex)} — ${baseTitle}`,
    } satisfies PromptEntry;

    queueSave({ ...project, prompts: [...(project.prompts || []), nextClip] });
    jumpToAsset("prompts", nextClip.id);
    setNotice(`New 15s prompt added to "${getEntryLabel("script", scene)}".`);
  }

  function insertClipAfter(promptId: string) {
    if (!project) return;
    const targetClip = (project.prompts || []).find((entry) => entry.id === promptId);
    const scene = targetClip ? findSceneForPrompt(targetClip, sceneEntries) : null;
    if (!targetClip || !scene) return;

    const sceneClips = promptsBySceneId.get(scene.id) || [];
    const targetIndex = sceneClips.findIndex((entry) => entry.id === promptId);
    if (targetIndex < 0) return;
    const nextExistingClip = sceneClips[targetIndex + 1] || null;
    const insertOrder = targetIndex + 2;
    const sceneNumber = hierarchyNumber(sceneEntries.findIndex((entry) => entry.id === scene.id) + 1);
    const insertedClip = {
      ...(createEntry("prompts", project.prompts.length, {
        defaultSceneId: scene.id,
        defaultScenePath: scene.path,
      }) as PromptEntry),
      prevPromptId: targetClip.id,
      content: "15-second Seedance 2 prompt. Continue from the previous prompt. Describe only what belongs inside this prompt: visible action, camera order, setting, lighting, and continuity.",
      durationSec: 15,
      segmentIndex: insertOrder,
      segmentStartSec: 0,
      segmentEndSec: 15,
      title: `${sceneNumber}.${hierarchyNumber(insertOrder)} — Prompt ${hierarchyNumber(insertOrder)}`,
    } satisfies PromptEntry;

    const orderedSceneClips = [
      ...sceneClips.slice(0, targetIndex + 1),
      insertedClip,
      ...sceneClips.slice(targetIndex + 1),
    ];
    const clipOrderById = new Map(orderedSceneClips.map((entry, index) => [entry.id, index + 1]));
    const targetArrayIndex = (project.prompts || []).findIndex((entry) => entry.id === promptId);
    const insertedPrompts = [...(project.prompts || [])];
    insertedPrompts.splice(targetArrayIndex + 1, 0, insertedClip);
    const nextPrompts = insertedPrompts.map((entry) => {
      let nextEntry = entry;
      if (
        nextExistingClip &&
        entry.id === nextExistingClip.id &&
        promptContinuityPrevId(entry) === targetClip.id
      ) {
        nextEntry = {
          ...nextEntry,
          prevPromptId: insertedClip.id,
        };
      }
      const nextOrder = clipOrderById.get(entry.id);
      if (!nextOrder) return nextEntry;
      return {
        ...nextEntry,
        segmentIndex: nextOrder,
        title: clipTitleForOrder(scene, nextEntry, nextOrder),
      };
    });

    queueSave({ ...project, prompts: nextPrompts });
    jumpToAsset("prompts", insertedClip.id);
    setNotice(`Inserted a 15s prompt after "${hierarchyTitleText(getEntryLabel("prompts", targetClip)) || getEntryLabel("prompts", targetClip)}".`);
  }

  // Add a sub-prompt under a parent prompt — used when a beat needs
  // more than the 15s ceiling and gets split into 2+ chunks. Sub-
  // prompts share the parent's scene + render together as a sequence.
  // Single-level only: if the user invokes this on an already-nested
  // sub-prompt, we hoist the new child to share the same parent so
  // the tree stays flat at depth 1.
  function addSubPromptTo(parentPromptId: string) {
    if (!project) return;
    const parent = (project.prompts || []).find((entry) => entry.id === parentPromptId);
    if (!parent) return;
    const scene = findSceneForPrompt(parent, sceneEntries);
    if (!scene) return;
    // Hoist nested-of-nested → same level (single-level rule).
    const effectiveParentId = parent.parentPromptId || parent.id;
    const siblings = (project.prompts || []).filter(
      (p) => p.parentPromptId === effectiveParentId,
    );
    const subOrdinal = siblings.length + 1;
    const newPrompt = {
      ...(createEntry("prompts", project.prompts.length, {
        defaultSceneId: scene.id,
        defaultScenePath: scene.path,
      }) as PromptEntry),
      parentPromptId: effectiveParentId,
      content: "Sub-prompt — 5-15s chunk of the parent sequence. Continue the parent's intent. Self-contained visual/audio direction.",
      durationSec: 15,
      title: `${hierarchyTitleText(getEntryLabel("prompts", parent)) || "Prompt"} · sub ${subOrdinal}`,
    } satisfies PromptEntry;
    const nextPrompts = [...(project.prompts || []), newPrompt];
    queueSave({ ...project, prompts: nextPrompts });
    jumpToAsset("prompts", newPrompt.id);
    setNotice(`Added sub-prompt under "${hierarchyTitleText(getEntryLabel("prompts", parent)) || getEntryLabel("prompts", parent)}".`);
  }

  function deleteClip(promptId: string) {
    if (!project) return;
    const prompt = (project.prompts || []).find((entry) => entry.id === promptId);
    if (!prompt) return;
    const scene = findSceneForPrompt(prompt, sceneEntries);
    const sceneClips = scene ? promptsBySceneId.get(scene.id) || [] : [];
    const clipIndex = sceneClips.findIndex((entry) => entry.id === promptId);
    const previousClip = clipIndex > 0 ? sceneClips[clipIndex - 1] : null;
    const nextClip = clipIndex >= 0 ? sceneClips[clipIndex + 1] || null : null;
    const remainingSceneClips = sceneClips.filter((entry) => entry.id !== promptId);
    const clipOrderById = new Map(remainingSceneClips.map((entry, index) => [entry.id, index + 1]));
    const clipLabel = hierarchyTitleText(getEntryLabel("prompts", prompt)) || getEntryLabel("prompts", prompt);

    const nextPrompts = (project.prompts || [])
      .filter((entry) => entry.id !== promptId)
      .map((entry) => {
        let nextEntry = entry;
        const referencesDeleted = promptContinuityPrevId(entry) === promptId;
        if (nextClip && entry.id === nextClip.id && referencesDeleted) {
          // Re-point the next clip's prevPromptId to whatever now sits
          // before it (or null when the deleted clip was at the head).
          nextEntry = {
            ...nextEntry,
            prevPromptId: previousClip?.id || null,
          };
        }

        const nextOrder = clipOrderById.get(entry.id);
        if (!nextOrder || !scene) return nextEntry;
        return {
          ...nextEntry,
          segmentIndex: nextOrder,
          title: clipTitleForOrder(scene, nextEntry, nextOrder),
        };
      });

    queueSave({ ...project, prompts: nextPrompts });
    setSelectedIds((current) => ({
      ...current,
      prompts: current.prompts === promptId ? nextClip?.id || previousClip?.id || "" : current.prompts,
    }));
    setNotice(`Deleted prompt "${clipLabel}".`);
  }

  function buildDialogueEntry() {
    return {
      ...(createEntry("dialogue", 0) as DialogueEntry),
      assetRefs: undefined,
      content: buildDialogueScaffold(sceneEntries),
      entityRefs: [],
      path: DIALOGUE_DOC_PATH,
      sceneId: null,
      scenePath: null,
      shotId: null,
      shotPath: null,
      suppressedRefs: [],
      title: DIALOGUE_DOC_TITLE,
    } satisfies DialogueEntry;
  }

  function openOrCreateDialogueDoc() {
    if (!project) return;
    setDialogueContext({ sceneId: "", shotId: "" });
    setProjectContextSelected(false);
    setPinboardSelected(false);
    setSectionFormatSelected(null);
    setActiveSection("dialogue");
    if (dialogueDoc) {
      const syncedContent = syncEmptyDialogueScaffold(dialogueDoc.content, sceneEntries);
      if (syncedContent !== String(dialogueDoc.content || "")) {
        const nextDialogue = { ...dialogueDoc, content: syncedContent };
        const nextDialogueEntries = (project.dialogue || []).length
          ? (project.dialogue || []).map((entry, index) => (index === 0 ? nextDialogue : entry))
          : [nextDialogue];
        queueSave({ ...project, dialogue: nextDialogueEntries });
      }
      setSelectedIds((current) => ({
        ...current,
        dialogue: dialogueDoc.id,
      }));
      jumpToAsset("dialogue", dialogueDoc.id);
      return;
    }
    const nextDialogue = buildDialogueEntry();
    queueSave({ ...project, dialogue: [nextDialogue] });
    jumpToAsset("dialogue", nextDialogue.id);
    setNotice("Created film dialogue doc.", "success", {
      category: "dialogue",
      action: { label: "Open", target: { kind: "section", section: "dialogue" } },
      dedupeKey: "dialogue:created-film-doc",
    });
  }

  function beginItemDrag(itemId: string) {
    draggingItemIdRef.current = itemId;
    dragOverRef.current = null;
    setDraggingItemId(itemId);
    setDragOver(null);
  }

  function endItemDrag() {
    const draggedId = draggingItemIdRef.current;
    if (draggedId) {
      suppressDraggedClickRef.current = { id: draggedId, until: Date.now() + 220 };
    }
    draggingItemIdRef.current = null;
    dragOverRef.current = null;
    setDraggingItemId(null);
    setDragOver(null);
  }

  function shouldSuppressDraggedClick(itemId: string) {
    const current = suppressDraggedClickRef.current;
    if (current.id !== itemId) return false;
    if (Date.now() <= current.until) return true;
    suppressDraggedClickRef.current = { id: null, until: 0 };
    return false;
  }

  function setCurrentDragOver(next: DragOver | null) {
    const current = dragOverRef.current;
    if (
      current?.id === next?.id &&
      current?.mode === next?.mode &&
      current?.position === next?.position
    ) {
      return;
    }
    dragOverRef.current = next;
    setDragOver(next);
  }

  function dropPositionForEvent(
    event: ReactDragEvent<HTMLElement>,
    layout: "row" | "grid",
  ): DragOver["position"] {
    const rect = event.currentTarget.getBoundingClientRect();
    if (layout === "grid") {
      return event.clientX < rect.left + rect.width / 2 ? "before" : "after";
    }
    return event.clientY < rect.top + rect.height / 2 ? "above" : "below";
  }

  // Compute drop position from the pointer relative to the target rect.
  // Asset cards are a grid, so they use before/after; script rows use
  // above/below. The ref is updated synchronously so drop doesn't read
  // stale React state when the user releases quickly.
  function updateDropIndicator(
    event: ReactDragEvent<HTMLElement>,
    targetId: string,
    mode: DragOver["mode"] = "reorder",
    layout: "row" | "grid" = "row",
  ) {
    setCurrentDragOver({
      id: targetId,
      mode,
      position: dropPositionForEvent(event, layout),
    });
  }

  function deleteScene(sceneId: string) {
    if (!project) return;
    const scene = project.script.find((s) => s.id === sceneId);
    if (!scene) return;
    const sceneEntry = scene as ScriptEntry;
    const promptIds = new Set(project.prompts.filter((p) => promptBelongsToSceneForDisplay(p, sceneEntry)).map((p) => p.id));
    const nextScript = project.script.filter((s) => s.id !== sceneId);
    const nextPrompts = project.prompts.filter((p) => !promptBelongsToSceneForDisplay(p, sceneEntry));
    const sceneEntriesBeforeDelete = project.script.filter((entry) => (entry as ScriptEntry).kind === "scene") as ScriptEntry[];
    const sceneIndex = sceneEntriesBeforeDelete.findIndex((s) => s.id === sceneId);
    const nextScenes = nextScript.filter((entry) => (entry as ScriptEntry).kind === "scene") as ScriptEntry[];
    const fallbackScriptId =
      nextScenes[Math.min(Math.max(sceneIndex, 0), nextScenes.length - 1)]?.id ||
      masterScriptEntry?.id ||
      "";
    queueSave({ ...project, script: nextScript, prompts: nextPrompts });
    setSelectedIds((current) => ({
      ...current,
      prompts: current.prompts && promptIds.has(current.prompts) ? "" : current.prompts,
      script: current.script === sceneId ? fallbackScriptId : current.script,
    }));
    setNotice(`Deleted scene "${getEntryLabel("script", scene)}" and its prompts.`);
  }

  // AssetGroup feature retired — the data layer was deleted on 2026-05-04
  // (electron/asset-groups.cjs). The renderer's mutation handlers, drag-
  // merge, and group picker were dropped in cut #7-leftover so the UI no
  // longer pretends to persist groupings that the next save would nuke.

  function openCreateStoryDocModal() {
    setStoryDocTitleDraft("");
    setStoryDocGroupDraft("canon");
    setStoryDocSectionMode("existing");
    setStoryDocCustomSectionDraft("");
    setSelectedMagicDocId(null);
    setShowCreateStoryDocModal(true);
  }

  async function deleteMediaVariant(assetId: string, mediaId: string) {
    if (!project || !selectedItem || !handle) return;
    if (!isAssetSection(activeSection) || activeSection === "media") return;
    const sectionItems = getSectionItems(project, activeSection) as AssetEntry[];
    const target = sectionItems.find((entry) => entry.id === assetId);
    if (!target) return;
    const media = target.media.find((m) => m.id === mediaId);
    if (!media) return;
    // The user explicitly clicked the × on this variant chip; that's the
    // intent. Electron's native window.confirm is suppressed by default
    // so the previous guard silently returned false and never fired the
    // detach — a broken affordance that erodes trust. The action is
    // recoverable too: the underlying file stays in the media library
    // and re-attaching restores the variant.
    setSelectedMediaIds((current) => {
      if (current[assetId] !== mediaId) return current;
      const remaining = target.media.filter((m) => m.id !== mediaId);
      return { ...current, [assetId]: remaining[0]?.id || "" };
    });
    setError(null);
    try {
      const saved = await window.forgeDesktop.detachAssetVariant(
        handle.projectDir,
        activeSection as "characters" | "locations" | "props" | "keyframes" | "audio",
        assetId,
        mediaId,
      );
      applyProjectData(saved, 1500);
      setNotice(`Removed variant "${media.label || "file"}" from ${target.name || "asset"}.`);
    } catch (detachError) {
      setError(detachError instanceof Error ? detachError.message : "Failed to remove variant.");
    }
  }

  function cycleSelectedAssetMedia(direction: -1 | 1) {
    if (!selectedAsset || !selectedAsset.media.length) return;
    const mediaItems = selectedAsset.media;
    const currentId = mediaPreview?.id || selectedMediaIds[selectedAsset.id] || mediaItems[0]?.id || "";
    const currentIndex = Math.max(0, mediaItems.findIndex((media) => media.id === currentId));
    const nextIndex = (currentIndex + direction + mediaItems.length) % mediaItems.length;
    const nextMedia = mediaItems[nextIndex];
    if (!nextMedia) return;
    setBrokenMediaIds((current) => {
      if (!current[nextMedia.id]) return current;
      const next = { ...current };
      delete next[nextMedia.id];
      return next;
    });
    setSelectedMediaIds((current) => ({
      ...current,
      [selectedAsset.id]: nextMedia.id,
    }));
  }

  function deleteCustomStoryDoc(docId: string) {
    if (!project) return;
    const target = project.story.find((entry) => entry.id === docId);
    if (!target) return;
    const descriptor = describeContextDoc(target);
    if (descriptor.builtIn) {
      setNotice("Built-in docs can't be deleted here; remove on disk.", "info");
      return;
    }
    const deletedIndex = project.story.findIndex((entry) => entry.id === docId);
    const nextStory = project.story.filter((entry) => entry.id !== docId);
    // Clear the selection so the editor doesn't try to render a gone entry.
    setSelectedIds((current) => {
      if (current.story !== docId) return current;
      const fallback = nextStory[Math.min(Math.max(deletedIndex, 0), nextStory.length - 1)]?.id || "";
      return { ...current, story: fallback };
    });
    queueSave({ ...project, story: nextStory });
    setNotice(`Deleted "${target.title}".`);
  }

  async function submitCreateStoryDoc() {
    if (!project) return;
    const rawTitle = storyDocTitleDraft.trim();
    if (!rawTitle) return;
    let targetGroup: ContextDocGroup = storyDocGroupDraft;
    if (storyDocSectionMode === "new") {
      const sectionSlug = slugifyContextGroup(storyDocCustomSectionDraft);
      if (!sectionSlug) return;
      if (RESERVED_CONTEXT_SECTION_SLUGS.has(sectionSlug)) {
        setNotice("Project, Canon, and Asset are built-in Context sections. Pick one above or use a different section name.", "info", {
          category: "story",
          visibility: "toast",
          importance: "normal",
          dedupeKey: `context-doc:reserved-section:${sectionSlug}`,
        });
        return;
      }
      targetGroup = sectionSlug;
    }
    // Route through the shared createEntry factory instead of hand-building
    // the StoryEntry inline (F1 from the add-button audit). Keeps story in
    // sync with every other section's create path; future createEntry
    // changes (path generation, slug rules, defaults) propagate here.
    const base = createEntry("story", project.story.length, {}) as StoryEntry;
    const nextItem: StoryEntry = {
      ...base,
      contextGroup: targetGroup,
      path: contextDocPathForGroup(targetGroup, rawTitle),
      title: rawTitle,
      content: `# ${rawTitle}\n\n`,
    };
    const nextProject = {
      ...project,
      story: [...project.story, nextItem],
    };
    setShowCreateStoryDocModal(false);
    queueSave(nextProject);
    jumpToAsset("story", nextItem.id);
    setNotice(`Created "${rawTitle}" in ${contextDocGroupLabel(targetGroup)}.`);
  }

  // `sectionOverride` (from context lane) lets callers pin the creation
  // to a specific section regardless of the currently-selected item —
  // e.g. the master-script "+" button always creates a NEW SCENE even
  // if the user has a shot/prompt selected. Without the override,
  // activeSection drives the target.
  // creatingItemRef (UI lane, F15) is a rapid-click guard — createItem
  // runs sync but React will re-fire on double-click / Enter-held and
  // create duplicates without this.
  async function createItem(sectionOverride?: SectionId) {
    const section = sectionOverride ?? activeSection;
    if (!project || section === "media") return;
    if (creatingItemRef.current) return;
    if (section === "story") {
      openCreateStoryDocModal();
      return;
    }
    if (section === "dialogue") {
      openOrCreateDialogueDoc();
      return;
    }
    if (isAssetSection(section)) {
      const existingCount = getSectionItems(project, section).length;
      if (existingCount >= LOCAL_UI_LIMITS.assetItemsPerSection) {
        setNotice(
          `${SECTION_LABELS[section]} is limited to ${formatUiLimit(LOCAL_UI_LIMITS.assetItemsPerSection)} items. Delete unused assets before adding more.`,
          "info",
        );
        return;
      }
    }
    if (sectionOverride && sectionOverride !== activeSection) {
      setActiveSection(sectionOverride);
    }
    creatingItemRef.current = true;
    setCreatingSection(section);
    try {
    const sectionItems = getSectionItems(project, section);
    // Count within the active Single|Sheet sub-view for sections that
    // ship the split, so the auto-numbering reads "Location 1, 2, 3..."
    // within Single and a separate "Location Sheet 1, 2, 3..." within
    // Sheet — instead of one global counter that jumps when the user
    // switches tabs.
    const itemCount = (() => {
      if (section === "script") {
        return (sectionItems as ScriptEntry[]).filter((entry) => entry.kind === "scene").length;
      }
      if (section === "characters" || section === "locations" || section === "keyframes") {
        return sectionItems.filter((entry) => {
          const itemKind = (entry as AssetEntry).kind === "sheet" ? "sheet" : "single";
          return itemKind === assetSubView;
        }).length;
      }
      if (section === "audio") {
        return sectionItems.filter((entry) => {
          const raw = (entry as AssetEntry).audioKind;
          const normalized: AudioKind =
            raw === "voiceover" || raw === "sfx" || raw === "ambient" ? raw : "music";
          return normalized === audioSubView;
        }).length;
      }
      return sectionItems.length;
    })();
    const selectedPromptForCreate =
      section === "prompts" && selectedItem && "sceneId" in selectedItem
        ? (selectedItem as PromptEntry)
        : null;
    const selectedPromptSceneForCreate = selectedPromptForCreate
      ? findSceneForPrompt(selectedPromptForCreate, sceneEntries)
      : null;
    const createOptions = {
      defaultSceneId:
        section === "prompts"
          ? selectedPromptSceneForCreate?.id ||
            ((selectedItem as ScriptEntry | null)?.kind === "scene" ? (selectedItem as ScriptEntry).id : "") ||
            sceneEntries[0]?.id ||
            ""
          : undefined,
      defaultScenePath:
        section === "prompts"
          ? selectedPromptSceneForCreate?.path ||
            ((selectedItem as ScriptEntry | null)?.kind === "scene" ? (selectedItem as ScriptEntry).path : null) ||
            sceneEntries[0]?.path ||
            null
          : undefined,
    };
    const nextItems =
      section === "prompts"
        ? (() => {
            const segments = buildPromptSegments(undefined);
            let prevPromptId: string | null = null;
            return segments.map((segment, index) => {
              const nextPrompt = createEntry(section, itemCount + index, createOptions) as PromptEntry;
              const splitSuffix = segments.length > 1 ? ` Part ${segment.segmentIndex}` : "";
              const linkedPrevId =
                prevPromptId && segment.segmentIndex && segment.segmentIndex > 1
                  ? prevPromptId
                  : null;
              prevPromptId = nextPrompt.id;
              return {
                ...nextPrompt,
                prevPromptId: linkedPrevId,
                durationSec: segment.durationSec || 15,
                segmentCount: segment.segmentCount,
                segmentEndSec: segment.segmentEndSec || 15,
                segmentIndex: segment.segmentIndex,
                segmentStartSec: segment.segmentStartSec || 0,
                title: `${nextPrompt.title}${splitSuffix}`,
              };
            });
          })()
        : section === "script"
          ? [
              createScriptSceneEntry(
                project,
                // Tag the new scene with the active script's path. For
                // Master Script we leave it undefined (legacy single-
                // film semantics — no parent persisted on disk); for any
                // secondary script we set the parent so the scene only
                // appears under that script's tree.
                activeScriptPath && activeScriptPath !== masterScriptPathConst
                  ? activeScriptPath
                  : undefined,
              ) as SectionEntry,
            ]
          : [createEntry(section, itemCount, createOptions) as SectionEntry];
    // Tag fresh asset entries with the active Single|Sheet sub-view so the
    // new card appears in the tab the user just clicked + from (instead of
    // defaulting to Single, which routed every "+" click to the original
    // tab regardless of selection). Only applies to characters/locations/
    // keyframes — other sections don't render the sub-tabs and `kind` is
    // ignored on them. Sub-view was force-reset to "single" on section
    // switch (see useEffect on activeSection), so for prompts/script/etc
    // this branch is a no-op even when assetSubView happens to read "sheet".
    // Tag fresh entries with the active sub-view so they appear in the tab
    // the user just clicked + from. Two tag families:
    //   - Single|Sheet for characters/locations/keyframes (kind field)
    //   - Music|Voice|SFX|Ambient for audio (audioKind field)
    // Both also rewrite the auto-name with the variant suffix so the tab
    // counters read sequentially within each tab instead of sharing a
    // single global count.
    const taggedNextItems = (() => {
      if (
        (section === "characters" || section === "locations" || section === "keyframes") &&
        assetSubView === "sheet"
      ) {
        const sheetLabel =
          section === "characters"
            ? "Character Sheet"
            : section === "locations"
              ? "Location Sheet"
              : "Keyframe Sheet";
        return nextItems.map((entry, index) => {
          const sheetName = `${sheetLabel} ${itemCount + index + 1}`;
          return { ...entry, kind: "sheet" as const, title: sheetName, name: sheetName };
        });
      }
      if (section === "audio") {
        const audioLabel: Record<AudioKind, string> = {
          music: "Music",
          voiceover: "Voice",
          sfx: "SFX",
          ambient: "Ambient",
        };
        return nextItems.map((entry, index) => {
          const audioName = `${audioLabel[audioSubView]} ${itemCount + index + 1}`;
          return { ...entry, audioKind: audioSubView, title: audioName, name: audioName };
        });
      }
      return nextItems;
    })();
    const nextProject = {
      ...project,
      [section]: [...sectionItems, ...taggedNextItems],
    };
      queueSave(nextProject);
      const createdId = taggedNextItems[0]?.id || "";
      if (createdId) {
        if (section === "script") {
          setMasterScriptTreeExpanded(true);
          setExpandedSceneIds((current) => ({ ...current, [createdId]: true }));
        }
        jumpToAsset(section, createdId);
        const sheetSuffix =
          (section === "characters" || section === "locations" || section === "keyframes") &&
          assetSubView === "sheet"
            ? section === "keyframes"
              ? " storyboard sheet"
              : " sheet"
            : "";
        const label = taggedNextItems.length > 1
          ? `${taggedNextItems.length} new ${SECTION_LABELS[section].toLowerCase()}${sheetSuffix}`
          : `New ${SECTION_LABELS[section].toLowerCase().replace(/s$/, "")}${sheetSuffix}`;
        setNotice(`${label} created.`);
      }
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : `Create ${SECTION_LABELS[section].toLowerCase()} failed.`);
    } finally {
      creatingItemRef.current = false;
      setCreatingSection(null);
    }
  }

  async function syncSelectedMagicDoc(force = false) {
    if (!handle || !selectedMagicDoc) return;
    setBusy("magic-sync");
    setError(null);
    try {
      const next = await window.forgeDesktop.syncMagicDoc(handle.projectDir, selectedMagicDoc.name, force);
      if (next) {
        applyProjectHandle(next, 1500);
      }
      // Surface the backend's skipped/reason envelope instead of a
      // fake success toast. If the doc had no readable sources,
      // tell the user exactly that — previously the button just
      // returned "Synced" with no actual rebuild.
      if (next?.skipped) {
        const scopeErrors = Array.isArray(next.scopeErrors) ? next.scopeErrors : [];
        if (scopeErrors.length > 0) {
          setError(`${selectedMagicDoc.name}: ${scopeErrors.join(" · ")}`);
        } else if (next.scopeResolvedCount === 0) {
          setError(`${selectedMagicDoc.name}: no readable sources. Add descriptions, then sync again.`);
        } else {
          setNotice(`${selectedMagicDoc.name} is up to date — sources haven't changed.`, "info", {
            category: "story",
            visibility: "log",
            importance: "low",
            action: { label: "Open", target: { kind: "magicDoc", id: selectedMagicDoc.id } },
            dedupeKey: `story:up-to-date:${selectedMagicDoc.id}`,
          });
        }
        return;
      }
      setNotice(force ? `Regenerated "${selectedMagicDoc.name}".` : `Synced "${selectedMagicDoc.name}".`, "success", {
        category: "story",
        action: { label: "Open", target: { kind: "magicDoc", id: selectedMagicDoc.id } },
        dedupeKey: `story:sync:${selectedMagicDoc.id}:${force ? "force" : "normal"}`,
      });
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : "Failed to sync magic doc.");
    } finally {
      setBusy(null);
    }
  }

  async function uploadAssetContextGuideReferences() {
    if (!handle) return;
    const before = assetContextGuide?.references?.length || 0;
    setError(null);
    try {
      const next = await window.forgeDesktop.uploadAssetContextGuideReferences(handle.projectDir);
      setAssetContextGuide(next);
      const added = Math.max(0, (next.references?.length || 0) - before);
      setNotice(added
        ? `Added ${added} Asset Context reference image${added === 1 ? "" : "s"}.`
        : "No compatible reference image added.",
        added ? "success" : "info", {
        category: "assets",
        visibility: added ? "toast" : "log",
        importance: added ? "normal" : "low",
        dedupeKey: "asset-context:refs",
      });
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Failed to upload reference images.");
    }
  }

  async function addAssetContextReferenceFromLibrary(record: MediaRecord) {
    if (!handle) return;
    const before = assetContextGuide?.references?.length || 0;
    setError(null);
    try {
      const next = await window.forgeDesktop.addAssetContextGuideReferencePaths(handle.projectDir, [record.path]);
      setAssetContextGuide(next);
      const after = next.references?.length || 0;
      setNotice(after > before ? "Added reference image." : "No compatible image added.", after > before ? "success" : "info", {
        category: "assets",
        visibility: "log",
        importance: "low",
        dedupeKey: `asset-context:library:${record.path}`,
      });
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : "Failed to add library reference.");
    }
  }

  async function revealAssetContextGuide(relativePath?: string) {
    if (!handle) return;
    const targetPath = relativePath || assetContextGuide?.path;
    if (!targetPath) return;
    setError(null);
    try {
      await window.forgeDesktop.revealPath(handle.projectDir, targetPath);
      setNotice("Opened Asset Context in Finder.", "info", {
        category: "assets",
        visibility: "log",
        importance: "low",
        dedupeKey: `asset-context:reveal:${targetPath}`,
      });
    } catch (revealError) {
      setError(revealError instanceof Error ? revealError.message : "Failed to reveal Asset Context.");
    }
  }

  async function deleteAssetContextGuideReference(relativePath: string) {
    if (!handle) return;
    setError(null);
    try {
      const next = await window.forgeDesktop.deleteAssetContextGuideReference(handle.projectDir, relativePath);
      setAssetContextGuide(next);
      setNotice("Removed reference image.", "info", {
        category: "assets",
        visibility: "log",
        importance: "low",
        dedupeKey: `asset-context:delete:${relativePath}`,
      });
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Failed to remove reference image.");
    }
  }

  function updateAssetVideoTrimDraft(patch: Partial<{ start: string; end: string }>) {
    if (!assetTrimDraftKey || !previewIsVideo) return;
    setAssetVideoTrimDrafts((current) => {
      const base = current[assetTrimDraftKey] || {
        start: "0",
        end: formatTrimPointInput(previewDurationSec),
      };
      return {
        ...current,
        [assetTrimDraftKey]: {
          start: patch.start ?? base.start,
          end: patch.end ?? base.end,
        },
      };
    });
  }

  function markAssetVideoTrim(boundary: "start" | "end") {
    const player = assetVideoPlayerRef.current;
    if (!player) return;
    const currentPoint = formatTrimPointInput(player.currentTime);
    updateAssetVideoTrimDraft(boundary === "start" ? { start: currentPoint } : { end: currentPoint });
  }

  async function saveTrimmedAssetVideo() {
    if (!handle || !project || !selectedAsset || !mediaPreview || !previewIsVideo || !assetVideoTrimDraft || !isAssetSection(activeSection)) {
      return;
    }
    if (selectedAsset.media.length >= LOCAL_UI_LIMITS.assetVariantsPerAsset) {
      setNotice(
        `${getEntryLabel(activeSection, selectedAsset)} already has ${LOCAL_UI_LIMITS.assetVariantsPerAsset} media variants. Remove unused variants before saving another trim.`,
        "info",
      );
      return;
    }

    const startRaw = Number.parseFloat(String(assetVideoTrimDraft.start || "").trim());
    const endText = String(assetVideoTrimDraft.end || "").trim();
    const endRaw = endText ? Number.parseFloat(endText) : null;
    const startSec = Number.isFinite(startRaw) && startRaw >= 0 ? startRaw : 0;
    const endSec = endRaw !== null && Number.isFinite(endRaw) && endRaw > 0 ? endRaw : null;
    const clampedEndSec =
      previewDurationSec && endSec !== null ? Math.min(endSec, previewDurationSec) : endSec;

    if (previewDurationSec && startSec >= previewDurationSec) {
      setNotice("Trim start is past the end of this video.", "error");
      return;
    }
    if (clampedEndSec !== null && clampedEndSec <= startSec) {
      setNotice("Trim end must be after trim start.", "error");
      return;
    }

    setBusy("trim");
    setError(null);
    try {
      const result = await window.forgeDesktop.trimAssetMedia(
        handle.projectDir,
        activeSection,
        selectedAsset.id,
        mediaPreview.id,
        {
          startSec,
          endSec: clampedEndSec,
        },
      );
      applyProjectHandle(result.project, 1500);
      setSelectedMediaIds((current) => ({
        ...current,
        [selectedAsset.id]: result.mediaId,
      }));
      setNotice("Saved trimmed video as a new variant.", "success", {
        category: "assets",
        visibility: "toast",
        dedupeKey: `trim-asset-video:${result.path}`,
      });
    } catch (trimError) {
      setError(trimError instanceof Error ? trimError.message : "Failed to trim video.");
    } finally {
      setBusy(null);
    }
  }

  async function uploadAssetMedia() {
    if (!project || !isAssetSection(activeSection) || !handle) return;
    if (activeSection === "media") {
      const existingMediaItems = getSectionItems(project, "media").length;
      if (existingMediaItems >= LOCAL_UI_LIMITS.assetItemsPerSection) {
        setNotice(
          `Media is limited to ${formatUiLimit(LOCAL_UI_LIMITS.assetItemsPerSection)} items. Delete unused assets before importing more.`,
          "info",
        );
        return;
      }
    } else if (selectedItem) {
      const variantCount = ((selectedItem as AssetEntry).media || []).length;
      if (variantCount >= LOCAL_UI_LIMITS.assetVariantsPerAsset) {
        setNotice(
          `${getEntryLabel(activeSection, selectedItem)} already has ${LOCAL_UI_LIMITS.assetVariantsPerAsset} media variants. Remove unused variants before adding more.`,
          "info",
        );
        return;
      }
    }
    setBusy("upload");
    setError(null);
    try {
      if (activeSection === "media") {
        const uploaded = await window.forgeDesktop.uploadLibraryAssets(handle.projectDir);
        if (!uploaded.length) return;
        const refreshed = await refreshCurrentProject();
        if (refreshed) {
          const lastUploadedPath = uploaded[uploaded.length - 1]?.path || "";
          const matched = refreshed.project.library.find((entry: AssetEntry) =>
            (entry.media || []).some((m) => m.path === lastUploadedPath),
          );
          if (matched) {
            setSelectedIds((current) => ({ ...current, media: matched.id }));
          }
        }
        setNotice(`${uploaded.length} file${uploaded.length === 1 ? "" : "s"} added to media.`);
        return;
      }

      if (!selectedItem) return;
      const uploaded = await window.forgeDesktop.uploadAssets(
        handle.projectDir,
        activeSection,
        selectedItem.id,
        getEntryLabel(activeSection, selectedItem),
      );
      if (!uploaded.length) return;
      const nextProject = {
        ...project,
        [activeSection]: getSectionItems(project, activeSection).map((item) =>
          item.id === selectedItem.id
            ? { ...(item as AssetEntry), media: [...((item as AssetEntry).media || []), ...uploaded] }
            : item,
        ),
      };
      setSelectedMediaIds((current) => ({
        ...current,
        [selectedItem.id]: uploaded[uploaded.length - 1]?.id || current[selectedItem.id] || "",
      }));
      queueSave(nextProject);
      setNotice(`${uploaded.length} ${activeSection === "audio" ? "mp3" : "image"} file${uploaded.length === 1 ? "" : "s"} added.`);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Asset upload failed.");
    } finally {
      setBusy(null);
    }
  }

  // Attach every media variant of the currently-selected asset to a
  // chosen target entity (character / location / prop / keyframe /
  // audio). Closes the UX gap where users uploaded an asset entry
  // full of reference images and had no direct way to hook them to
  // the real character / location entry — they had to either
  // re-upload via that entity's "Upload" button or ask the agent.
  async function attachSelectedAssetToEntity(
    section: "characters" | "locations" | "props" | "keyframes" | "audio",
    entityId: string,
  ) {
    if (!project || !handle || !selectedAsset || !selectedAsset.media.length) return;
    setAttachBusy(true);
    try {
      const indexEntriesByPath = new Map(
        Object.values(mediaIndex).map((record) => [record.path, record] as const),
      );
      const seenMediaIds = new Set<string>();
      const missing: string[] = [];
      let skipped = 0;
      const attachable: Array<{
        mediaId: string;
        section: "characters" | "locations" | "props" | "keyframes" | "audio";
        entityId: string;
        mode: "reference";
      }> = [];
      for (const variant of selectedAsset.media) {
        const hit = indexEntriesByPath.get(variant.path);
        if (!hit) {
          missing.push(variant.label || variant.path);
          continue;
        }
        if (seenMediaIds.has(hit.id)) {
          skipped += 1;
          continue;
        }
        seenMediaIds.add(hit.id);
        attachable.push({
          mediaId: hit.id,
          section,
          entityId,
          mode: "reference",
        });
      }
      let attached = 0;
      let failed = 0;
      if (attachable.length > 0) {
        const batch = await window.forgeDesktop.attachMediaBatch(handle.projectDir, attachable);
        applyProjectData(batch.project, 1500);
        attached = batch.results.filter((result) => result.ok).length;
        failed = batch.results.length - attached;
        for (const result of batch.results) {
          if (!result.ok) {
            // eslint-disable-next-line no-console
            console.warn("attachMedia failed:", result.error);
          }
        }
      }
      const unresolved = missing.length + failed + skipped;
      if (attached > 0 && unresolved === 0) {
        setNotice(`Attached ${attached} variant${attached === 1 ? "" : "s"}.`, "info");
      } else if (attached > 0 && unresolved > 0) {
        setNotice(
          `Attached ${attached} variant${attached === 1 ? "" : "s"}; ${unresolved} skipped${missing.length && failed ? " or failed" : missing.length ? " (file not in media index)" : failed ? " during attach" : " as duplicates"}.`,
          "info",
        );
      } else {
        setNotice(
          missing.length > 0 && failed === 0
            ? "Attach failed. Scan media first."
            : `Attach failed: ${failed || unresolved} variant${(failed || unresolved) === 1 ? "" : "s"}.`,
          "error",
        );
      }
      setAttachPickerOpen(false);
    } finally {
      setAttachBusy(false);
    }
  }

  // Inverse of attachSelectedAssetToEntity — browse the media index
  // and attach a single file TO the currently-open asset entry. Used
  // by the "Pick from library" picker.
  async function attachLibraryMediaToSelectedAsset(mediaId: string) {
    if (!handle || !project || !selectedAsset || !isAssetSection(activeSection) || activeSection === "media") return;
    setAttachBusy(true);
    try {
      const attached = await window.forgeDesktop.attachMedia(
        handle.projectDir,
        mediaId,
        activeSection as "characters" | "locations" | "props" | "keyframes" | "audio",
        selectedAsset.id,
        "reference",
      );
      applyProjectData(attached.project, 1500);
      setNotice(`Attached to ${selectedAsset.name || selectedAsset.title || "asset"}.`);
      // Intentionally keep the picker open so the user can attach
      // multiple files in one session without re-opening.
    } catch (attachError) {
      setNotice(attachError instanceof Error ? attachError.message : "Attach failed.", "error");
    } finally {
      setAttachBusy(false);
    }
  }

  async function performAssetDelete(section: AssetSectionId, asset: AssetEntry) {
    if (!project || !handle || !isAssetSection(section)) return;
    const label = getEntryLabel(section, asset);

    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }

    const removedMediaIds = new Set(
      (Array.isArray(asset.media) ? asset.media : []).map((media) => media.id),
    );
    setBusy("delete");
    setError(null);
    try {
      const refreshed = await window.forgeDesktop.deleteAssetEntry(handle.projectDir, section, asset.id);
      if (!refreshed) {
        throw new Error("Failed to reload the project after deleting the asset.");
      }
      const fallbackAfterDelete = (targetSection: AssetSectionId) => {
        const beforeEntries = getSectionItems(project, targetSection);
        const afterEntries = getSectionItems(refreshed.project, targetSection);
        if (!afterEntries.length) return "";
        const removedIndex = beforeEntries.findIndex((entry) => entry.id === asset.id);
        const fallbackIndex = removedIndex >= 0
          ? Math.min(removedIndex, afterEntries.length - 1)
          : 0;
        return afterEntries[fallbackIndex]?.id || "";
      };
      applyProjectHandle(refreshed, 1500);
      setSelectedIds((current) => {
        let changed = false;
        const nextSelected = { ...current };
        if (current[section] === asset.id) {
          nextSelected[section] = fallbackAfterDelete(section);
          changed = true;
        }
        if (current.media === asset.id) {
          nextSelected.media = fallbackAfterDelete("media");
          changed = true;
        }
        return changed ? nextSelected : current;
      });
      setSelectedMediaIds((current) => {
        const next = { ...current };
        delete next[asset.id];
        return next;
      });
      setBrokenMediaIds((current) => {
        const next = { ...current };
        for (const mediaId of removedMediaIds) {
          delete next[mediaId];
        }
        return next;
      });
      setNotice(`${label} moved to temporary trash.`);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Asset delete failed.");
    } finally {
      setBusy(null);
    }
  }

  function requestAssetDelete(section: AssetSectionId, asset: AssetEntry) {
    const target = resolveAssetTarget(section, asset.id);
    if (!target) {
      setNotice("Couldn't find the source entry for this media item.", "error");
      return;
    }
    void performAssetDelete(target.section, asset);
  }

  function saveSelectedVideoNote() {
    if (!project || !selectedVideo) return;
    const nextNote = videoNoteDraft.trim();
    const currentNote = String(selectedVideo.note || "").trim();
    if (nextNote === currentNote) return;
    const nextVideos = (project.videos || []).map((video) =>
      video.id === selectedVideo.id ? { ...video, note: nextNote } : video,
    );
    queueSave({ ...project, videos: nextVideos });
    setNotice(nextNote ? "Updated take note." : "Cleared take note.", "success", {
      category: "videos",
      visibility: "log",
      importance: "low",
      dedupeKey: `videos:note:${selectedVideo.id}:${nextNote}`,
    });
  }

  async function performVideoDelete(video: VideoEntry) {
    if (!handle?.projectDir) return;
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const peerTake = (project?.videos || [])
      .filter((candidate) => candidate.id !== video.id && candidate.promptId && candidate.promptId === video.promptId)
      .sort(
        (a, b) =>
          (a.takeIndex || 0) - (b.takeIndex || 0) ||
          String(a.generatedAt || "").localeCompare(String(b.generatedAt || "")),
      )[0] || null;
    const fallbackSelection = peerTake?.id || "";
    setBusy("delete");
    setError(null);
    try {
      const refreshed = await window.forgeDesktop.deleteVideoEntry(handle.projectDir, video.id);
      if (!refreshed) {
        throw new Error("Failed to reload the project after deleting the take.");
      }
      applyProjectHandle(refreshed, 1500);
      setSelectedIds((current) => ({ ...current, videos: fallbackSelection }));
      setShowVideoPreviewLightbox(false);
      setNotice(`Deleted take ${String(video.takeIndex).padStart(2, "0")}.`, "success", {
        category: "videos",
      });
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Video delete failed.");
    } finally {
      setBusy(null);
    }
  }

  function completeDesktopAuth(mode: "login" | "signup") {
    void window.forgeDesktop.openExternal(
      `${ANVIL_ACCOUNT_URL}/login?desktop=1&next=${encodeURIComponent("/app?desktop=1")}`,
    ).catch(() => {});
    setDesktopAuthError(null);
    setDesktopAuthStatus(
      mode === "signup"
        ? "Account page opened. Create your account, then paste the desktop token here."
        : "Account page opened. Paste the desktop token here after signing in.",
    );
  }

  async function connectDesktopAuthToken(token: string) {
    setDesktopAuthBusy(true);
    setDesktopAuthError(null);
    setDesktopAuthStatus("Checking desktop token...");
    try {
      const result = await window.forgeDesktop.connectDesktopAccountSession({
        token,
        endpoint: ANVIL_DESKTOP_AGENT_ENDPOINT,
      });
      const entitlement: AccountEntitlement = result?.entitlement || { plan: "free", status: "unknown" };
      setAccountEntitlement(entitlement);
      if (!result?.ok) {
        throw new Error(result?.message || "Desktop token was not accepted.");
      }
      setDesktopAuthState("signed-in");
      setDesktopAuthStatus(null);
      setNotice("Anvil account connected. Trial access is ready.", "success");
    } catch (authError) {
      setDesktopAuthError(authError instanceof Error ? authError.message : "Desktop token check failed.");
      setDesktopAuthStatus(null);
    } finally {
      setDesktopAuthBusy(false);
    }
  }

  async function signOutDesktopPlaceholder() {
    await window.forgeDesktop.clearDesktopAccountSession().catch(() => null);
    setShowSettingsModal(false);
    setDesktopAuthState("signed-out");
    setAccountEntitlement({ plan: "free", status: "unknown" });
  }

  function openSettingsModal() {
    if (!project) return;
    setSettingsDraft({
      hookToken: project.settings.hookToken || "",
      hookUrl: project.settings.hookUrl || "",
      remoteAgentUrl: project.settings.remoteAgentUrl || "",
      remoteAgentToken: project.settings.remoteAgentToken || "",
      remoteAgentTokenSaved: project.settings.remoteAgentTokenSaved === true,
      remoteAgentEnabled: project.settings.remoteAgentEnabled === true,
      methodServerUrl: project.settings.methodServerUrl || "",
      methodServerToken: project.settings.methodServerToken || "",
      methodServerEnabled: project.settings.methodServerEnabled === true,
      sessionKey: project.settings.sessionKey || "",
      // Hosted agent providers were removed. Old projects fall back to
      // OpenClaw's CLI-auth path instead of landing on an unsupported
      // hidden selection in Settings.
      agentProvider: normalizeAgentProvider(project.settings.agentProvider),
      agentBinPath: project.settings.agentBinPath || "",
      agentApprovalMode: project.settings.agentApprovalMode === "ask" ? "ask" : "autonomous",
      agentBypassPermissions: project.settings.agentApprovalMode === "ask" ? false : true,
      agentMediaStaging: project.settings.agentMediaStaging === "inbox" ? "inbox" : "direct",
      enabledSkillAddons: Array.isArray(project.settings.enabledSkillAddons)
        ? [...project.settings.enabledSkillAddons]
        : [],
      disabledSkills: Array.isArray(project.settings.disabledSkills)
        ? [...project.settings.disabledSkills]
        : [],
      agentModel: "",
      customAgentEndpoint: "",
      apiKey: "",
      apiKeys: {},
      mediaKeys: project.settings.mediaKeys
        ? { ...project.settings.mediaKeys }
        : {},
      mediaModels: project.settings.mediaModels
        ? { ...project.settings.mediaModels }
        : {},
      anvilCredits: project.settings.anvilCredits
        ? {
            image: project.settings.anvilCredits.image ? { ...project.settings.anvilCredits.image } : undefined,
            video: project.settings.anvilCredits.video ? { ...project.settings.anvilCredits.video } : undefined,
          }
        : {
            image: { enabled: false, model: project.settings.mediaModels?.image || "nanobanana-pro" },
            video: { enabled: false, model: project.settings.mediaModels?.video || "seedance-2.0" },
          },
      mediaMode: project.settings.mediaMode || "one",
      evolinkApiKey: project.settings.evolinkApiKey || "",
      apiProviders: Array.isArray(project.settings.apiProviders)
        ? project.settings.apiProviders.map((entry) => ({ ...entry }))
        : [],
    });
    setShowSettingsModal(true);
    setError(null);
  }

  function openSkillLibraryModal() {
    if (!project || !handle?.projectDir) return;
    setShowSkillLibraryModal(true);
    setError(null);
  }

  async function submitSettings() {
    if (!project) return;
    const fallbackSession = `hook:shotforge:${project.project.id}`;
    const provider = normalizeAgentProvider(settingsDraft.agentProvider);
    const cleanedApiProviders = Array.isArray(settingsDraft.apiProviders)
      ? settingsDraft.apiProviders.filter(
          (p) =>
            (typeof p?.label === "string" && p.label.trim())
            || (typeof p?.apiKey === "string" && p.apiKey.trim())
            || (typeof p?.docs === "string" && p.docs.trim()),
        )
      : [];
    const hasExternalProviders = cleanedApiProviders.length > 0;
    const anvilCredits: Required<NonNullable<ForgeProjectData["settings"]["anvilCredits"]>> = {
      image: {
        enabled: false,
        model: (settingsDraft.anvilCredits?.image?.model || settingsDraft.mediaModels?.image || "nanobanana-pro").trim(),
      },
      video: {
        enabled: false,
        model: (settingsDraft.anvilCredits?.video?.model || settingsDraft.mediaModels?.video || "seedance-2.0").trim(),
      },
    };
    const imageCreditModel = anvilCredits.image.model || "nanobanana-pro";
    const videoCreditModel = anvilCredits.video.model || "seedance-2.0";
    const hasAnvilCreditGeneration = Boolean(anvilCredits.image?.enabled || anvilCredits.video?.enabled);
    const remoteAgentToken = settingsDraft.remoteAgentToken?.trim() || "";
    const remoteAgentTokenSaved = settingsDraft.remoteAgentTokenSaved === true && !remoteAgentToken;
    const next: ForgeProjectData["settings"] = {
      hookToken: settingsDraft.hookToken.trim(),
      hookUrl: settingsDraft.hookUrl.trim(),
      remoteAgentUrl:
        settingsDraft.remoteAgentUrl?.trim() ||
        (settingsDraft.remoteAgentEnabled || remoteAgentToken || remoteAgentTokenSaved
          ? ANVIL_DESKTOP_AGENT_ENDPOINT
          : ""),
      remoteAgentToken,
      remoteAgentTokenSaved,
      remoteAgentEnabled: settingsDraft.remoteAgentEnabled === true || Boolean(remoteAgentToken || remoteAgentTokenSaved),
      methodServerUrl: settingsDraft.methodServerUrl?.trim() || "",
      methodServerToken: settingsDraft.methodServerToken?.trim() || "",
      methodServerEnabled: settingsDraft.methodServerEnabled === true,
      sessionKey: settingsDraft.sessionKey.trim() || fallbackSession,
      agentProvider: provider,
      agentBinPath: (settingsDraft.agentBinPath || "").trim(),
      agentApprovalMode: settingsDraft.agentApprovalMode === "ask" ? "ask" : "autonomous",
      agentBypassPermissions: settingsDraft.agentApprovalMode === "ask" ? false : true,
      agentMediaStaging: settingsDraft.agentMediaStaging === "inbox" ? "inbox" : "direct",
      enabledSkillAddons: Array.isArray(settingsDraft.enabledSkillAddons)
        ? [...settingsDraft.enabledSkillAddons]
        : [],
      disabledSkills: Array.isArray(settingsDraft.disabledSkills)
        ? [...settingsDraft.disabledSkills]
        : [],
      agentModel: "",
      customAgentEndpoint: "",
      apiKey: "",
      apiKeys: {},
      mediaKeys: hasExternalProviders ? (() => {
        const source = settingsDraft.mediaKeys || {};
        const out: NonNullable<ForgeProjectData["settings"]["mediaKeys"]> = {};
        for (const cap of ["image", "video", "music", "voice"] as const) {
          const v = (source[cap] || "").trim();
          if (v) out[cap] = v;
        }
        return out;
      })() : {},
      mediaModels: hasExternalProviders || hasAnvilCreditGeneration ? (() => {
        const source = settingsDraft.mediaModels || {};
        const out: NonNullable<ForgeProjectData["settings"]["mediaModels"]> = {};
        for (const cap of ["image", "video", "music", "voice"] as const) {
          const model = cap === "image" ? imageCreditModel || source[cap]
            : cap === "video" ? videoCreditModel || source[cap]
            : source[cap];
          const v = (model || "").trim();
          if (v) out[cap] = v;
        }
        return out;
      })() : {},
      anvilCredits,
      mediaMode: settingsDraft.mediaMode || "one",
      // Mirror the image-key back to evolinkApiKey so the existing
      // EvoLink-only adapter (evolink.cjs) keeps working until per-
      // capability adapters land. Using image as the mirror source is
      // a heuristic — most users paste the same EvoLink key across
      // image/video/music today.
      evolinkApiKey: hasExternalProviders ? (() => {
        const image = (settingsDraft.mediaKeys?.image || "").trim();
        if (image) return image;
        return (settingsDraft.evolinkApiKey || "").trim();
      })() : "",
      // Pass-through the provider registry. Each entry's apiKey lands
      // in the encrypted secrets blob (main process strips it from
      // project.json on write); label / docs / endpoint roundtrip
      // through project.json. Drop entries with no label AND no key —
      // those are blank "Add provider" rows the user opened then
      // abandoned without typing anything.
      apiProviders: cleanedApiProviders,
    };
    setBusy("settings");
    try {
      const nextProject = { ...project, settings: next };
      if (handle?.projectDir) {
        const saved = await window.forgeDesktop.saveProjectSettings(handle.projectDir, nextProject);
        applyProjectData(saved, 1500);
        // Re-seed the draft from what main returned so subsequent
        // edits diff against persisted state (provider apiKey field
        // gets re-populated from the encrypted blob, etc).
        setSettingsDraft(saved.settings);
        await refreshDesktopAccountStatus(false);
      }
      setError(null);
      setNotice("Settings saved.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save settings.");
    } finally {
      setBusy(null);
    }
  }

  async function saveSkillLibrarySettings(payload: { enabledSkillAddons: SkillAddonGroupId[]; disabledSkills: string[] }) {
    if (!project || !handle?.projectDir) return;
    const nextProject = {
      ...project,
      settings: {
        ...project.settings,
        enabledSkillAddons: payload.enabledSkillAddons,
        disabledSkills: payload.disabledSkills,
      },
    };
    setBusy("settings");
    try {
      const saved = await window.forgeDesktop.saveProjectSettings(handle.projectDir, nextProject);
      applyProjectData(saved, 1500);
      setSettingsDraft(saved.settings);
      setError(null);
      setNotice("Anvil Skills saved.");
    } finally {
      setBusy(null);
    }
  }

  function buildAgentTask(
    rawMessage: string,
    attachments: ChatAttachment[] = composerAttachments,
    hammerLabel: string | null = null,
    assistantState: "pending" | "queued" = "pending",
    visibleMessageOverride: string | null = null,
    methodId: string | null = null,
    checkpointAfterDone: PhaseCheckpoint | null = null,
  ): AgentTask | null {
    if (!project) return null;
    const promptText = String(rawMessage || "").trim();
    const normalizedAttachments = Array.isArray(attachments) ? [...attachments] : [];
    if (!promptText && !normalizedAttachments.length) return null;
    const requestTarget: ChatTarget = {
      section: activeSection,
      itemId: selectedItem?.id ?? null,
      label: selectedItem ? getEntryLabel(activeSection, selectedItem) : SECTION_LABELS[activeSection],
    };
    const visibleMessage = visibleMessageOverride || (hammerLabel
      ? buildCommandMessageText(hammerLabel, requestTarget)
      : promptText);
    const userMessage = buildUserMessage(visibleMessage, requestTarget, normalizedAttachments);
    if (hammerLabel) userMessage.hammerAction = hammerLabel;
    return {
      attachments: normalizedAttachments,
      assistantMessage:
        assistantState === "queued"
          ? buildQueuedAssistantMessage(requestTarget)
          : buildPendingAssistantMessage(requestTarget),
      focusLock: focusScope,
      hammerLabel,
      checkpointAfterDone,
      methodId,
      promptText,
      requestTarget,
      selection: selectedItem ? { itemId: selectedItem.id, section: activeSection } : null,
      userMessage,
    };
  }

  function blockAppExtractionTask(task: AgentTask, clearComposer: boolean) {
    const guard = detectAppExtractionRequest(task.promptText || task.userMessage.text || "");
    if (!guard.blocked) return false;
    const assistantMessage: ChatMessage = {
      ...task.assistantMessage,
      activity: [],
      meta: null,
      state: "ready",
      text: APP_EXTRACTION_REFUSAL,
      timestamp: new Date().toISOString(),
    };
    chatStickToBottomRef.current = true;
    setChatHistory((current) => [...current, task.userMessage, assistantMessage]);
    setNotice("Internal app details stay private. Ask for user-facing help instead.", "info");
    if (clearComposer) {
      setChatDraft("");
      setComposerAttachments([]);
    }
    return true;
  }

  function queueAgentTask(task: AgentTask) {
    if (blockAppExtractionTask(task, false)) return;
    chatStickToBottomRef.current = true;
    const queuedTask: AgentTask = {
      ...task,
      assistantMessage: {
        ...task.assistantMessage,
        state: "queued",
        text: "Queued · waiting for the current run to finish.",
      },
    };
    const nextCount = agentQueueRef.current.length + 1;
    setAgentQueue((current) => [...current, queuedTask]);
    setNotice(
      `Queued ${nextCount} agent task${nextCount === 1 ? "" : "s"}${inFlightRequestId ? " behind the current run" : ""}.`,
      "info",
    );
  }

  function queueComposerTask() {
    const task = buildAgentTask(chatDraft, composerAttachments, null, "queued");
    if (!task) return;
    setChatDraft("");
    setComposerAttachments([]);
    queueAgentTask(task);
  }

  function resolveTaskSelection(task: AgentTask) {
    if (!task.selection?.itemId || !project) return null;
    const items = getSectionItems(project, task.selection.section);
    const current = items.find((item) => item.id === task.selection?.itemId);
    if (!current) return null;
    return {
      id: current.id,
      label: getEntryLabel(task.selection.section, current),
      section: task.selection.section,
      type: SECTION_LABELS[task.selection.section],
      content: current.content,
      path: current.path,
    };
  }

  function updateMessage(messageId: string, patch: Partial<ChatMessage>) {
    setChatHistory((current) =>
      current.map((message) => (message.id === messageId ? { ...message, ...patch } : message)),
    );
  }

  function toggleMessageExpanded(messageId: string) {
    setExpandedMessageIds((current) => ({
      ...current,
      [messageId]: !current[messageId],
    }));
  }

  function sendAgentMessage(message: string, label?: string) {
    if (!project || chatLoading) return;
    const task = buildAgentTask(message, [], label || null, "pending");
    if (!task) return;
    if (inFlightRequestId || sending || agentQueueRef.current.length) {
      queueAgentTask(task);
      return;
    }
    void askOpenClaw(task);
  }

  function updateScopeIntakeField<K extends keyof ScopeIntakeDraft>(
    key: K,
    value: ScopeIntakeDraft[K],
  ) {
    setScopeIntakeDraft((current) => ({
      ...current,
      [key]: value,
    }));
  }

  function resetScopeIntake() {
    setScopeIntakeDraft(DEFAULT_SCOPE_INTAKE_DRAFT);
  }

  function submitScopeIntake() {
    if (!project || chatLoading) return;
    const prompt = buildScopeIntakePrompt(project.project.name, scopeIntakeDraft);
    const visibleMessage = buildScopeIntakeVisibleMessage(scopeIntakeDraft);
    const task = buildAgentTask(
      prompt,
      [],
      "Project notes",
      "pending",
      visibleMessage,
      "scope_intake",
      { methodId: "scene_prompt_plan", checkpoint: "review_script_prompts" },
    );
    if (!task) return;
    setScopeIntakeOpen(false);
    if (inFlightRequestId || sending || agentQueueRef.current.length) {
      queueAgentTask(task);
      return;
    }
    void askOpenClaw(task);
  }

  function reviewPhaseCheckpoint() {
    if (!phaseCheckpoint) return;
    switch (phaseCheckpoint.checkpoint) {
      case "review_script_prompts":
        if (masterScriptEntry?.path) {
          jumpToPath(masterScriptEntry.path);
        } else {
          setActiveSection("script");
          setExpandedPrimary("script");
        }
        setMasterScriptTreeExpanded(true);
        break;
      case "review_bound_references":
        setActiveSection("media");
        setExpandedPrimary("assets");
        break;
      case "review_storyboards":
        setActiveSection("keyframes");
        setExpandedPrimary("assets");
        break;
      case "review_video_batch":
      case "review_repairs":
        setActiveSection(SHOW_WORKSHOP_SURFACE ? "workshop" : "videos");
        setExpandedPrimary(SHOW_WORKSHOP_SURFACE ? "workshop" : "assets");
        break;
      default:
        break;
    }
  }

  function revisePhaseCheckpoint() {
    if (!phaseCheckpoint) return;
    const template = buildRevisePhasePrompt(phaseCheckpoint);
    setChatDraft(template);
    setTimeout(() => {
      const node = chatInputRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(template.length, template.length);
    }, 0);
  }

  function continuePhaseCheckpoint() {
    if (!project || !phaseCheckpoint || chatLoading) return;
    const nextMethodId = nextMethodForCheckpoint(phaseCheckpoint.checkpoint, phaseCheckpoint.methodId);
    const nextPhase = localMethodPhase(nextMethodId);
    const prompt = buildContinuePhasePrompt(project.project.name, phaseCheckpoint, nextMethodId);
    const task = buildAgentTask(
      prompt,
      [],
      `Continue to ${nextPhase.label}`,
      "pending",
      `Continue to ${nextPhase.label}`,
      nextMethodId,
      checkpointAfterMethod(nextMethodId),
    );
    if (!task) return;
    setPhaseCheckpoint(null);
    if (inFlightRequestId || sending || agentQueueRef.current.length) {
      queueAgentTask(task);
      return;
    }
    void askOpenClaw(task);
  }

  async function askOpenClaw(preparedTask?: AgentTask) {
    const task = preparedTask ?? buildAgentTask(chatDraft, composerAttachments, null, "pending");
    if (!task || !project || chatLoading || sending) return;
    if (blockAppExtractionTask(task, !preparedTask)) return;
    const promptText = task.promptText;
    const attachmentsForMessage = task.attachments;
    setSending(true);
    setError(null);
    if (!preparedTask) {
      setChatDraft("");
      setComposerAttachments([]);
    }
    setPhaseCheckpoint(null);
    const nextUserMessage = task.userMessage;
    const assistantId = task.assistantMessage.id;
    const requestId = crypto.randomUUID();
    const startedAt = performance.now();
    setInFlightRequestId(requestId);
    setAgentWorkflowState({
      ...INITIAL_AGENT_WORKFLOW_STATE,
      activeId: "scope",
      phaseMood: "active",
      phaseVerb: task.hammerLabel === "Project notes" ? "Intake" : "Starting",
      status: "running",
      updatedAt: Date.now(),
    });
    // Auto-timeout: if the agent doesn't respond within 10 minutes,
    // clear the stuck state so the UI isn't permanently locked.
    const stuckTimer = setTimeout(() => {
      setInFlightRequestId((current) => {
        if (current === requestId) {
          setSending(false);
          setAgentWorkflowState((workflow) => ({
            ...workflow,
            phaseMood: "done",
            phaseVerb: "Timed out",
            status: "error",
            updatedAt: Date.now(),
          }));
          setNotice("Agent request timed out after 10 minutes.");
          return null;
        }
        return current;
      });
    }, 10 * 60 * 1000);
    const nextAssistantMessage: ChatMessage = {
      ...task.assistantMessage,
      requestId,
      activity: [],
      state: "pending",
      text: "",
    };
    chatStickToBottomRef.current = true;
    setChatHistory((current) => [...current, nextUserMessage, nextAssistantMessage]);

    let agentMutatedProject = false;
    const pathsFromCall = (call: { name: string; args: Record<string, unknown> }): string[] => {
      const paths: string[] = [];
      if (!AGENT_MUTATING_TOOL_NAMES.has(call.name)) return paths;
      const args = call.args || {};
      if (typeof args.path === "string") paths.push(args.path);
      if (Array.isArray(args.paths)) {
        for (const item of args.paths) {
          if (typeof item === "string") paths.push(item);
        }
      }
      if (Array.isArray(args.items)) {
        for (const item of args.items as Array<{ path?: unknown; to?: unknown }>) {
          if (item && typeof item.path === "string") paths.push(item.path);
          if (item && typeof item.to === "string") paths.push(item.to);
        }
      }
      // Workshop NLE: also pulse the underlying media path so the bin
      // card + timeline clip both glow when the agent is editing them.
      if (call.name.startsWith("timeline_") && typeof args.mediaPath === "string") {
        paths.push(args.mediaPath);
      }
      return paths;
    };
    const clipIdsFromCall = (call: { name: string; args: Record<string, unknown> }): string[] => {
      const ids: string[] = [];
      if (!call.name.startsWith("timeline_")) return ids;
      const args = call.args || {};
      if (typeof args.clipId === "string") ids.push(args.clipId);
      return ids;
    };
    const unsubscribe = window.forgeDesktop.onAgentEvent((message) => {
      if (message.requestId !== requestId) return;
      const { event } = message;
      // Every event is a heartbeat — bump lastActivityAt on the target
      // message so the renderer can surface "still working · Ns since
      // last activity" and distinguish a slow-but-healthy turn from a
      // truly stuck one.
      const heartbeatAt = Date.now();
      const stampHeartbeat = (m: ChatMessage) =>
        m.id === assistantId ? { ...m, lastActivityAt: heartbeatAt } : m;
      if (event.type === "tool:call") {
        if (event.call.mutating || AGENT_MUTATING_TOOL_NAMES.has(event.call.name)) {
          agentMutatedProject = true;
        }
        setAgentWorkflowState((current) => advanceAgentWorkflowFromTool(current, event.call));
        markTouchedPaths(pathsFromCall(event.call), 30_000);
        markAgentEditingClips(clipIdsFromCall(event.call), 30_000);
        setChatHistory((current) =>
          current.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  lastActivityAt: heartbeatAt,
                  activity: [
                    ...(m.activity || []),
                    { turn: event.turn, call: event.call, result: undefined, startedAt: heartbeatAt },
                  ],
                }
              : m,
          ),
        );
      } else if (event.type === "tool:result") {
        setAgentWorkflowState((current) =>
          completeAgentWorkflowTool(current, event.call, event.result.ok),
        );
        markTouchedPaths(pathsFromCall(event.call), 2_200);
        markAgentEditingClips(clipIdsFromCall(event.call), 2_200);
        setChatHistory((current) =>
          current.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  lastActivityAt: heartbeatAt,
                  activity: (m.activity || []).map((item) =>
                    item.call.id === event.call.id ? { ...item, result: event.result } : item,
                  ),
                }
              : m,
          ),
        );
      } else if (event.type === "reply:preview") {
        setChatHistory((current) =>
          current.map((m) =>
            m.id === assistantId && m.state === "pending"
              ? { ...m, text: sanitizeVisibleAgentText(event.reply), lastActivityAt: heartbeatAt }
              : m,
          ),
        );
      } else if (event.type === "phase") {
        setAgentWorkflowState((current) => ({
          ...current,
          phaseMood: event.phase.mood,
          phaseVerb: event.phase.verb,
          status: current.status === "idle" ? "running" : current.status,
          updatedAt: Date.now(),
        }));
        setChatHistory((current) => current.map(stampHeartbeat));
      }
    });

    try {
      // Rule-based intent classifier — renderer-side, zero LLM cost.
      // MUST sit inside the try/catch: any throw here would otherwise
      // skip the finally block below, leaving the UI wedged in the
      // in-flight state with Cancel unable to recover (sending=true,
      // inFlightRequestId !== null, no cleanup).
      let classification: { intent: string; reason: string; confidence: string } = {
        intent: "unclear",
        reason: "classifier not reached",
        confidence: "low",
      };
      try {
        const classifierInput: ClassifierInput = (() => {
          const selItem = task.selection?.itemId
            ? getSectionItems(project, task.selection.section).find(
                (item) => item.id === task.selection?.itemId,
              )
            : null;
          const scriptKind =
            task.selection?.section === "script" && selItem && "kind" in selItem
              ? ((selItem as { kind: "master" | "scene" }).kind ?? null)
              : null;
          let canContinue: boolean | undefined;
          if (task.selection?.section === "prompts" && selItem) {
            const prompt = selItem as { segmentIndex?: number | null; segmentCount?: number | null };
            const isLast =
              prompt.segmentIndex != null &&
              prompt.segmentCount != null &&
              prompt.segmentIndex === prompt.segmentCount;
            canContinue = isLast || prompt.segmentCount == null;
          }
          return {
            message: promptText,
            selection: {
              section: task.selection?.section ?? null,
              itemId: task.selection?.itemId ?? null,
              scriptKind,
              canContinue,
            },
            projectContextSelected,
            sectionFormatSelected,
            pinboardSelected,
            hammerLabel: task.hammerLabel,
            focusScope: task.focusLock,
            hasAttachment: attachmentsForMessage.length > 0,
          };
        })();
        classification = classifyIntent(classifierInput);
      } catch (classifierError) {
        // Never let a classifier bug wedge the agent send path —
        // degrade to 'unclear' and proceed as if no intent was detected.
        // eslint-disable-next-line no-console
        console.warn("intent classifier failed:", classifierError);
      }

      const payload = {
        session: project.settings.sessionKey,
        app: "forge",
        methodId: task.methodId || undefined,
        message: promptText,
        context: {
          project: {
            id: project.project.id,
            name: project.project.name,
            dir: handle?.projectDir || "",
          },
          projectShape: (() => {
            const scenesArr = project.script.filter((e) => e.kind === "scene");
            const masterEntry = project.script.find((e) => e.kind === "master");
            const masterTarget = Number(masterEntry?.durationSec);
            const promptSumByScene = new Map<string, number>();
            for (const prompt of project.prompts) {
              const dur = Number(prompt.durationSec);
              if (!Number.isFinite(dur) || dur <= 0) continue;
              const scene = findSceneForPrompt(prompt, scenesArr);
              if (!scene) continue;
              promptSumByScene.set(scene.id, (promptSumByScene.get(scene.id) || 0) + dur);
            }
            const scenesActualSec = scenesArr.reduce((sum, scene) => {
              const explicit = Number(scene.durationSec);
              const derived = promptSumByScene.get(scene.id) || 0;
              return sum + (Number.isFinite(explicit) && explicit > 0 ? explicit : derived);
            }, 0);
            const promptsOverCap = project.prompts.filter((p) => {
              const d = Number(p.durationSec);
              return Number.isFinite(d) && d > 15;
            }).length;
            return {
              scenes: scenesArr.length,
              prompts: project.prompts.length,
              assets:
                project.characters.length +
                project.locations.length +
                project.props.length +
                project.keyframes.length +
                project.audio.length,
              masterTargetSec:
                Number.isFinite(masterTarget) && masterTarget > 0 ? Math.round(masterTarget) : null,
              scenesActualSec: Math.round(scenesActualSec),
              promptsOverCap,
              customCanonSections: (Array.isArray(project.customSubsections) ? project.customSubsections : [])
                .filter((section) => section.primary === "script")
                .map((section) => ({
                  id: section.id,
                  name: section.name,
                  kind: section.kind,
                  folder: section.folder,
                  instructionsPath: section.instructionsPath,
                })),
            };
          })(),
          selection: resolveTaskSelection(task),
          attachments: attachmentsForMessage.map((attachment) => ({
            id: attachment.id,
            kind: attachment.kind,
            label: attachment.label,
            path: attachment.path,
            size: attachment.size,
          })),
          focusLock: task.focusLock,
          intent: {
            id: classification.intent,
            reason: classification.reason,
            confidence: classification.confidence,
            entityId: task.selection?.itemId ?? null,
          },
        },
      };

      const result = await window.forgeDesktop.askAgent(requestId, project.settings, payload);
      const elapsedMs = performance.now() - startedAt;
      const stats = {
        elapsedMs,
        turns:
          typeof result.turnCount === "number"
            ? result.turnCount
            : Array.isArray(result.turns)
              ? result.turns.length
              : 0,
        terminated: typeof result.terminated === "string" ? result.terminated : "done",
      };
      updateMessage(assistantId, {
        meta: result.meta ?? null,
        state: "ready",
        text: sanitizeVisibleAgentText(result.reply || "Done."),
        stats,
      });
      const completionCheckpoint =
        stats.terminated === "aborted" ? null : task.checkpointAfterDone || null;
      if (completionCheckpoint) {
        setPhaseCheckpoint(completionCheckpoint);
      }
      setAgentWorkflowState((current) => ({
        ...current,
        activeId: completionCheckpoint
          ? localMethodPhase(completionCheckpoint.methodId).workflowId
          : current.activeId,
        completedIds:
          stats.terminated === "aborted"
            ? current.completedIds
            : completionCheckpoint
              ? appendWorkflowCheckpoint(
                  appendWorkflowCheckpoint(current.completedIds, current.activeId),
                  localMethodPhase(completionCheckpoint.methodId).workflowId,
                )
              : appendWorkflowCheckpoint(current.completedIds, current.activeId),
        phaseMood: "done",
        phaseVerb: stats.terminated === "aborted" ? "Stopped" : "Done",
        status: stats.terminated === "aborted" ? "cancelled" : "done",
        updatedAt: Date.now(),
      }));
    } catch (requestError) {
      const requestErrorText = sanitizeVisibleAgentText(
        requestError instanceof Error ? requestError.message : "Agent request failed.",
      );
      updateMessage(assistantId, {
        meta: null,
        state: "error",
        text: requestErrorText,
      });
      setAgentWorkflowState((current) => ({
        ...current,
        phaseMood: "done",
        phaseVerb: "Failed",
        status: "error",
        updatedAt: Date.now(),
      }));
      setError(requestErrorText);
    } finally {
      // UI unlock FIRST — do not let a slow post-turn project reload
      // wedge the composer. Previously setSending(false) lived after
      // the await below, so if openProjectAtPath hung the Send button
      // stayed disabled even though the agent had finished / been
      // cancelled. Clearing sending/flight/phase up front guarantees
      // Cancel always unwinds.
      clearTimeout(stuckTimer);
      setInFlightRequestId(null);
      setCancelling(false);
      setSending(false);
      unsubscribe();
      // Clear any lingering touched-path pulses
      for (const timer of touchedTimers.current.values()) clearTimeout(timer);
      touchedTimers.current.clear();
      setTouchedPaths({});
      for (const timer of agentClipIdTimers.current.values()) clearTimeout(timer);
      agentClipIdTimers.current.clear();
      setAgentEditingClipIds(new Set());
      // Let the project watcher refresh disk-backed state when agent
      // writes land. This avoids an unconditional full reopen after
      // every ask, including read-only turns.
      if (agentMutatedProject) {
        try {
          await refreshCurrentProject();
        } catch {}
      }
    }
  }

  function handleChatKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) {
      return;
    }
    event.preventDefault();
    if (chatLoading || (!chatDraft.trim() && !composerAttachments.length)) {
      return;
    }
    if (inFlightRequestId || sending || agentQueueRef.current.length) {
      queueComposerTask();
      return;
    }
    void askOpenClaw();
  }

  useEffect(() => {
    if (!project || chatLoading || sending || inFlightRequestId || agentQueue.length === 0) {
      return;
    }
    const [nextTask, ...rest] = agentQueue;
    setAgentQueue(rest);
    void askOpenClaw(nextTask);
  }, [agentQueue, chatLoading, inFlightRequestId, project, sending]);

  const touchedPathSet = useMemo(() => new Set(Object.keys(touchedPaths)), [touchedPaths]);
  const sectionForTouchedPath = (p: string): PrimarySectionId | null => {
    if (p.startsWith("story/") || p === "ANVIL.md") return "story";
    if (p.startsWith("dialogue/") || p.startsWith("scenes/") || p.startsWith("script/") || p.startsWith("beats/") || p.startsWith("shots/") || p.startsWith("prompts/")) return "script";
    if (p.startsWith("assets/videos/")) return "assets";
    if (SHOW_WORKSHOP_SURFACE && p.startsWith("assets/exports/")) return "workshop";
    if (p.startsWith("assets/") || p.startsWith(".forge/project.json") || p.startsWith(".forge/index.json")) return "assets";
    return null;
  };
  const touchedPrimarySet = useMemo(() => {
    const out = new Set<PrimarySectionId>();
    for (const p of touchedPathSet) {
      const sec = sectionForTouchedPath(p);
      if (sec) out.add(sec);
    }
    return out;
  }, [touchedPathSet]);
  const touchedFilesBySection = useMemo(() => {
    const out: Record<string, string[]> = {};
    const entries = Object.entries(touchedPaths).sort((a, b) => b[1] - a[1]);
    for (const [path] of entries) {
      const sec = sectionForTouchedPath(path);
      if (!sec) continue;
      const list = out[sec] || (out[sec] = []);
      if (list.length < 3) {
        const base = path.split("/").pop() || path;
        if (!list.includes(base)) list.push(base);
      }
    }
    return out as Record<PrimarySectionId, string[]>;
  }, [touchedPaths]);
  const isItemTouched = (item: { path?: string; id?: string; media?: Array<{ path?: string }> } | null) => {
    if (!item) return false;
    if (item.path && touchedPathSet.has(item.path)) return true;
    if (Array.isArray(item.media)) {
      for (const media of item.media) {
        if (media?.path && touchedPathSet.has(media.path)) return true;
      }
    }
    return false;
  };

  // Asset-preview derivations must sit ABOVE the no-project early return
  // because the lightbox keyboard useEffect below depends on them. Hooks
  // must run in the same order on every render; placing useEffect after
  // the early return triggers React error #310 when the user opens a
  // project (the transition renders more hooks than the previous one).
  const selectedAsset =
    isAssetSection(activeSection) && selectedItem && "media" in selectedItem ? (selectedItem as AssetEntry) : null;
  const selectedAssetOwner =
    isAssetSection(activeSection) && selectedAsset
      ? activeSection === "media"
        ? assetOwnerById.get(selectedAsset.id) || null
        : {
            section: activeSection,
            collectionKey: activeSection as Exclude<AssetCollectionKey, "library">,
          }
      : null;
  const selectedMediaId = selectedAsset ? selectedMediaIds[selectedAsset.id] || "" : "";
  const explicitSelectedMedia =
    selectedAsset?.media.find((media) => media.id === selectedMediaId) || null;
  const mediaPreview =
    explicitSelectedMedia ||
    firstRenderableAssetMedia(selectedAsset?.media || [], brokenMediaIds);
  const selectedAssetMediaCount = selectedAsset?.media.length || 0;
  const libraryPanelAttachedPaths = useMemo(
    () => new Set((selectedAsset?.media || []).map((media) => media.path)),
    [selectedAsset?.media],
  );
  const assetContextLibraryRecords = useMemo(() => {
    if (!assetContextLibraryOpen || !handle) return [];
    const query = deferredAssetContextLibraryQuery.trim().toLowerCase();
    return Object.values(mediaIndex)
      .filter((record) => record.kind === "image")
      .filter((record) => !record.path.startsWith(".forge/asset-context/"))
      .filter((record) => !query || record.path.toLowerCase().includes(query))
      .sort((a, b) => a.path.localeCompare(b.path));
  }, [assetContextLibraryOpen, deferredAssetContextLibraryQuery, handle, mediaIndex]);
  const libraryPanelRecords = useMemo(() => {
    if (!libraryPanelOpen || !selectedAsset || activeSection === "media" || !handle) {
      return [];
    }
    const query = deferredLibraryPanelQuery.trim().toLowerCase();
    return Object.values(mediaIndex)
      .filter((record) => libraryPanelFilter === "all" || record.kind === libraryPanelFilter)
      .filter((record) => !query || record.path.toLowerCase().includes(query))
      .sort((a, b) => a.path.localeCompare(b.path));
  }, [
    activeSection,
    deferredLibraryPanelQuery,
    handle,
    libraryPanelFilter,
    libraryPanelOpen,
    mediaIndex,
    selectedAsset,
  ]);
  const mediaPreviewPath = String(mediaPreview?.path || mediaPreview?.fileUrl || "");
  const previewIsVideo =
    Boolean(mediaPreview) &&
    mediaPreview.kind !== "audio" &&
    /\.(mp4|m4v|mov|webm|ogv)$/i.test(mediaPreviewPath);
  const assetTrimDraftKey = selectedAsset && mediaPreview ? `${selectedAsset.id}:${mediaPreview.id}` : "";
  const previewDurationSec =
    Number.isFinite(Number(mediaPreview?.durationSec)) && Number(mediaPreview?.durationSec) > 0
      ? Number(mediaPreview?.durationSec)
      : null;
  const assetVideoTrimDraft =
    assetTrimDraftKey && previewIsVideo
      ? (
          assetVideoTrimDrafts[assetTrimDraftKey] || {
            start: "0",
            end: formatTrimPointInput(previewDurationSec),
          }
        )
      : null;
  const previewMissing = Boolean(mediaPreview && (!mediaPreview.fileUrl || brokenMediaIds[mediaPreview.id]));
  const lowSignalNoticeCount = useMemo(
    () => noticeLog.filter((notice) => notice.importance === "low").length,
    [noticeLog],
  );
  const visibleNoticeLog = useMemo(
    () => (
      [...noticeLog].reverse().filter((notice) => showLowSignalNotices || notice.importance !== "low")
    ),
    [noticeLog, showLowSignalNotices],
  );
  const sessionNoticeCards = useMemo<SessionNoticeCard[]>(() => {
    const cards: SessionNoticeCard[] = [];
    if (error || saveState === "failed") {
      cards.push({
        key: `error:${error || saveState}`,
        tone: "attention",
        title: "App needs attention",
        detail: error || "The last save failed. Resolve this before closing the project.",
      });
    }
    if (SHOW_AGENT_SURFACE && (sending || inFlightRequestId)) {
      cards.push({
        key: `agent:running:${queuedAgentCount}`,
        tone: "working",
        title: "Agent running",
        detail: queuedAgentCount > 0
          ? `${queuedAgentCount} queued task${queuedAgentCount === 1 ? "" : "s"} will run next.`
          : "The current request is still in progress.",
      });
    } else if (SHOW_AGENT_SURFACE && queuedAgentCount > 0) {
      cards.push({
        key: `agent:queued:${queuedAgentCount}`,
        tone: "info",
        title: "Queued agent tasks",
        detail: `${queuedAgentCount} queued message${queuedAgentCount === 1 ? "" : "s"} waiting to run.`,
      });
    }
    if (SHOW_AGENT_SURFACE && focusScope.kind !== "none") {
      cards.push({
        key: `lock:${focusScope.kind}:${"path" in focusScope ? focusScope.path || "" : ""}:${"sceneId" in focusScope ? focusScope.sceneId || "" : ""}:${"shotId" in focusScope ? focusScope.shotId || "" : ""}`,
        tone: focusScope.kind === "readonly" ? "attention" : "info",
        title: "Focus lock active",
        detail: fullLockLabel(focusScope) || "Focus lock is active.",
        action: { label: "Release", target: { kind: "release-lock" } },
      });
    }
    return cards;
  }, [error, focusScope, inFlightRequestId, queuedAgentCount, saveState, sending]);
  const sessionAttentionCount = useMemo(
    () => sessionNoticeCards.filter((card) => card.tone === "attention").length,
    [sessionNoticeCards],
  );
  const noticeBadgeCount = sessionAttentionCount > 0 ? sessionAttentionCount : unreadNoticeCount;

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;

      const target = event.target as HTMLElement | null;
      const isEditable = Boolean(
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable),
      );
      if (isEditable) return;

      if (event.key === "Escape" && showAssetPreviewLightbox) {
        event.preventDefault();
        setShowAssetPreviewLightbox(false);
        return;
      }

      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        if (!selectedAsset || selectedAsset.media.length < 2) return;
        if (showCreateProjectModal || showCreateStoryDocModal || showSettingsModal || showSkillLibraryModal) return;
        // If focus is on an asset tile, the asset-grid keyboard nav owns the
        // arrow keys — leave media-cycling for when focus is elsewhere.
        const active = document.activeElement as HTMLElement | null;
        if (active?.classList.contains("asset-tile-trigger")) return;
        event.preventDefault();
        cycleSelectedAssetMedia(event.key === "ArrowLeft" ? -1 : 1);
        return;
      }

      if (event.key !== " " && event.code !== "Space") return;
      if (showCreateProjectModal || showCreateStoryDocModal || showSettingsModal || showSkillLibraryModal) return;
      if (!selectedAsset || !mediaPreview || previewMissing) return;
      if (mediaPreview.kind === "audio") return;

      event.preventDefault();
      setShowAssetPreviewLightbox((current) => !current);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    mediaPreview,
    previewMissing,
    selectedAsset,
    showAssetPreviewLightbox,
    showCreateProjectModal,
    showCreateStoryDocModal,
    showSettingsModal,
    showSkillLibraryModal,
  ]);
  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;

      const target = event.target as HTMLElement | null;
      const isEditable = Boolean(
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable),
      );
      if (isEditable) return;

      if (event.key === "Escape" && showVideoPreviewLightbox) {
        event.preventDefault();
        setShowVideoPreviewLightbox(false);
        return;
      }

      if (activeSection !== "videos") return;
      if (showCreateProjectModal || showCreateStoryDocModal || showSettingsModal || showSkillLibraryModal) return;
      if (!handle?.projectDir || !videosWorkspace.previewVideo) return;
      if (event.key !== " " && event.code !== "Space") return;

      event.preventDefault();
      if (!showVideoPreviewLightbox) {
        setShowVideoPreviewLightbox(true);
        return;
      }

      const player = videoPreviewLightboxPlayerRef.current;
      if (!player) return;
      if (player.paused) {
        const playPromise = player.play();
        if (playPromise && typeof playPromise.catch === "function") {
          void playPromise.catch((err) => {
        // Surface Chromium media errors instead of silencing them — the
        // silent .catch pattern was the meta-bug behind Bug 3 / the
        // timeline audio death-spiral. Same shape, applied to App-level
        // <audio>/<video> previews.
        console.warn("[anvil] media play() rejected", { err: (err as { name?: string })?.name || String(err) });
      });
        }
        return;
      }
      player.pause();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    activeSection,
    handle?.projectDir,
    showCreateProjectModal,
    showCreateStoryDocModal,
    showSettingsModal,
    showSkillLibraryModal,
    showVideoPreviewLightbox,
    videosWorkspace.previewVideo,
  ]);
  useEffect(() => {
    if (!showVideoPreviewLightbox) return;
    const player = videoPreviewLightboxPlayerRef.current;
    if (!player) return;
    const playPromise = player.play();
    if (playPromise && typeof playPromise.catch === "function") {
      void playPromise.catch((err) => {
        // Surface Chromium media errors instead of silencing them — the
        // silent .catch pattern was the meta-bug behind Bug 3 / the
        // timeline audio death-spiral. Same shape, applied to App-level
        // <audio>/<video> previews.
        console.warn("[anvil] media play() rejected", { err: (err as { name?: string })?.name || String(err) });
      });
    }
  }, [showVideoPreviewLightbox, videosWorkspace.previewVideo?.id]);

  if (SHOW_DESKTOP_ACCOUNT_GATE && desktopAuthState !== "signed-in") {
    return (
      <DesktopLoginGate
        appVersion={appVersion}
        onLogin={() => completeDesktopAuth("login")}
        onSignUp={() => completeDesktopAuth("signup")}
        onConnectToken={connectDesktopAuthToken}
        busy={desktopAuthBusy || desktopAuthState === "checking"}
        error={desktopAuthError}
        status={
          desktopAuthState === "checking"
            ? "Checking saved account..."
            : desktopAuthStatus
        }
      />
    );
  }

  if (!project || !handle) {
    return (
      <>
        <WelcomeScreen
          appVersion={appVersion}
          busy={busy}
          error={error}
          recentProjects={recentProjects}
          showCreateProjectModal={showCreateProjectModal}
          projectNameDraft={projectNameDraft}
          onOpenProject={() => void openProject()}
          onOpenRecentProject={(projectDir) => void openRecentProject(projectDir)}
          onOpenCreateModal={openCreateProjectModal}
          onCancelCreateModal={() => setShowCreateProjectModal(false)}
          onSubmitCreateModal={() => void submitCreateProject()}
          onProjectNameChange={setProjectNameDraft}
        />
        {launchScreen}
      </>
    );
  }

  // Plain non-hook derivations that only matter once a project is open.
  // Left BELOW the early return so they don't compute on the welcome
  // screen; safe because they don't call any hooks.
  // Cache-busting key for media URLs. Bumps only when a media file is
  // actually added/removed (mediaIndex identity changes) — not on every
  // text edit, which was causing "variant-select is glitchy / delayed"
  // by re-fetching all images via the anvil-asset:// protocol.
  const mediaRefreshKey = `${activeProjectDir}:${Object.keys(mediaIndex).length}`;
  let latestAgentMeta: OpenClawMeta | null = null;
  for (let i = combinedChatHistory.length - 1; i >= 0; i -= 1) {
    const message = combinedChatHistory[i];
    if (message.role === "assistant" && message.meta) {
      latestAgentMeta = message.meta;
      break;
    }
  }

  return (
    <div className="desktop-shell">
      <header className="desktop-header">
        <div className="desktop-header-copy">
          <ProjectHeaderMenu
            appVersion={appVersion}
            busy={busy}
            inFlight={Boolean(inFlightRequestId)}
            menuRef={headerMenuRef}
            onCreateProject={openCreateProjectModal}
            onOpenProject={openProject}
            onRecentProjectOpen={openRecentProject}
            onRevealCurrentProjectFolder={revealCurrentProjectFolder}
            onSettingsOpen={openSettingsModal}
            onSkillLibraryOpen={openSkillLibraryModal}
            open={showHeaderMenu}
            recentProjects={headerRecentProjects}
            setOpen={setShowHeaderMenu}
          >
            <div className="desktop-header-title-row">
              <h1>{project.project.name}</h1>
              {(() => {
                // Persistent save indicator. Green dot + "Saved Xs ago" after
                // a successful save; amber pulse during save; red when failed.
                // Tooltip surfaces the exact time so the user can verify.
                const savedText = lastSavedAt
                  ? (() => {
                      const delta = Math.max(0, Math.floor((Date.now() - lastSavedAt) / 1000));
                      if (delta < 5) return "Saved just now";
                      if (delta < 60) return `Saved ${delta}s ago`;
                      if (delta < 3600) return `Saved ${Math.floor(delta / 60)}m ago`;
                      return `Saved ${Math.floor(delta / 3600)}h ago`;
                    })()
                  : null;
                return (
                  <div
                    className={`save-indicator save-indicator-${saveState}`}
                    title={
                      saveState === "saving" ? "Saving to disk…"
                        : saveState === "failed" ? "Save failed — changes not persisted"
                        : lastSavedAt ? `Saved at ${new Date(lastSavedAt).toLocaleTimeString()}`
                        : "Not saved yet"
                    }
                  >
                    <span className="save-indicator-dot" aria-hidden="true" />
                    <span className="save-indicator-text">
                      {saveState === "saving" ? "Saving…"
                        : saveState === "failed" ? "Save failed"
                        : savedText || "Unsaved"}
                    </span>
                  </div>
                );
              })()}
            </div>
            <div className="header-meta" title={handle.projectDir}>{handle.projectDir}</div>
          </ProjectHeaderMenu>
        </div>
        <div className="desktop-header-actions">
          <button
            className="ghost-btn compact icon-btn header-notice-btn icon-hover-tooltip tooltip-bottom"
            onClick={() => {
              setShowNoticeLog(true);
              // Mark everything currently in the log as read. Total log
              // still grows up to 20; this just resets the unread badge.
              setNoticeLogReadCount(noticeLog.length);
            }}
            data-tooltip={
              sessionAttentionCount > 0
                ? `Session inbox · ${sessionAttentionCount} attention${sessionAttentionCount === 1 ? "" : " items"}${unreadNoticeCount > 0 ? ` · ${unreadNoticeCount} new` : ""}`
                : unreadNoticeCount > 0
                  ? `Session inbox · ${unreadNoticeCount} new`
                  : `Session inbox${noticeLog.length > 0 ? ` · ${noticeLog.length} activity` : ""}`
            }
            aria-label="Open session notice log"
            type="button"
          >
            <NoticeBellIcon />
            {noticeBadgeCount > 0 ? (
              <span className={`header-notice-count ${sessionAttentionCount > 0 ? "attention" : ""}`}>{noticeBadgeCount}</span>
            ) : null}
          </button>
          <button
            className={`ghost-btn compact icon-btn header-notice-btn header-trash-btn icon-hover-tooltip tooltip-bottom${inboxView ? " active" : ""}`}
            onClick={() => {
              if (inboxView) {
                setInboxView(false);
                return;
              }
              setProjectContextSelected(false);
              setPinboardSelected(false);
              setSectionFormatSelected(null);
              setSelectedMagicDocId(null);
              setActiveSection("media");
              setExpandedPrimary("assets");
              setInboxView(true);
            }}
            data-tooltip={inboxView
              ? "Back to All media"
              : `Temporary trash${(inboxFiles.length + visiblePendingInboxJobCount) ? ` · ${inboxFiles.length + visiblePendingInboxJobCount}` : ""}${visiblePendingInboxJobCount ? ` (${visiblePendingInboxJobCount} generating)` : ""}`}
            aria-label={inboxView ? "Back to All media" : "Open temporary trash"}
            aria-pressed={inboxView}
            type="button"
          >
            <TemporaryTrashIcon />
            {!inboxView && (inboxFiles.length + visiblePendingInboxJobCount) > 0 ? (
              <span className={`header-notice-count${visiblePendingInboxJobCount ? " attention" : ""}`}>
                {inboxFiles.length + visiblePendingInboxJobCount}
              </span>
            ) : null}
          </button>
          <button
            className="ghost-btn compact header-undo-btn has-art-icon"
            onClick={undo}
            disabled={undoStack.current.length === 0}
            title="Undo (⌘Z)"
            type="button"
          >
            <UndoIcon />
            <span className="header-undo-label">Undo</span>
          </button>
          <button
            className="ghost-btn compact header-undo-btn has-art-icon"
            onClick={redo}
            disabled={redoStack.current.length === 0}
            title="Redo (⌘⇧Z)"
            type="button"
          >
            <RedoIcon />
            <span className="header-undo-label">Redo</span>
          </button>
          <MediaUploadButton
            projectDir={activeProjectDir}
            onNotice={setNotice}
            onError={setError}
            onProjectReload={() => {
              void refreshCurrentProject().catch((reloadError) => {
                setError(reloadError instanceof Error ? reloadError.message : "Project refresh failed.");
              });
            }}
            onGoToMedia={() => {
              setProjectContextSelected(false);
              setPinboardSelected(false);
              setSectionFormatSelected(null);
              setSelectedMagicDocId(null);
              setActiveSection("media");
              setExpandedPrimary("assets");
            }}
          />
          {/* Settings gear moved to the bottom of the left rail. */}
        </div>
      </header>

      {notices.length > 0 || error ? (
        <div className="notice-stack" role="status" aria-live="polite" aria-atomic="false">
          {notices.map((n) => (
            <div
              key={n.id}
              className={`notice ${n.type === "error" ? "error" : n.type === "info" ? "info" : "success"} notice-importance-${n.importance}`}
              role={n.type === "error" ? "alert" : undefined}
            >
              <div className="notice-main">
                <span className={`notice-category notice-category-${n.category}`}>{noticeCategoryLabel(n.category)}</span>
                <span className="notice-text">{n.text}</span>
                {n.count > 1 ? <span className="notice-repeat">×{n.count}</span> : null}
              </div>
              <div className="notice-inline-actions">
                {n.action ? (
                  <button
                    className="notice-action-btn"
                    onClick={() => runNoticeAction(n.action!.target)}
                    type="button"
                  >
                    {n.action.label}
                  </button>
                ) : null}
                <button
                  className="notice-dismiss-btn"
                  onClick={() => dismissVisibleNotice(n.id)}
                  type="button"
                  aria-label="Dismiss notice"
                  title="Dismiss"
                >
                  ×
                </button>
              </div>
            </div>
          ))}
          {error ? <div className="notice error" role="alert">{error}</div> : null}
        </div>
      ) : null}
      {showNoticeLog ? (
        <div className="notice-log-backdrop" onClick={() => setShowNoticeLog(false)}>
          <div
            className="notice-log"
            role="dialog"
            aria-modal="true"
            aria-labelledby={noticeLogTitleId}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="notice-log-head">
              <div>
                <div className="notice-log-title" id={noticeLogTitleId}>Session</div>
                <div className="notice-log-subtitle">
                  {[
                    sessionNoticeCards.length > 0
                      ? `${sessionNoticeCards.length} current`
                      : null,
                    noticeLog.length > 0
                      ? `${noticeLog.length} event${noticeLog.length === 1 ? "" : "s"}`
                      : "No activity",
                  ].filter(Boolean).join(" · ")}
                </div>
              </div>
              <div className="notice-log-head-actions">
                {noticeLog.length > 0 ? (
                  <button
                    className="ghost-btn compact"
                    onClick={clearNoticeHistory}
                    type="button"
                  >
                    Clear
                  </button>
                ) : null}
                <button
                  autoFocus
                  className="ghost-btn compact"
                  onClick={() => setShowNoticeLog(false)}
                  type="button"
                >
                  Done
                </button>
              </div>
            </div>
            <div className="notice-log-body">
              {sessionNoticeCards.length > 0 ? (
                <section className="notice-log-section">
                  <div className="notice-log-section-title">Current session</div>
                  <div className="notice-session-card-list">
                    {sessionNoticeCards.map((card) => (
                      <div key={card.key} className={`notice-session-card tone-${card.tone}`}>
                        <div className="notice-session-card-copy">
                          <div className="notice-session-card-title">{card.title}</div>
                          <div className="notice-session-card-detail">{card.detail}</div>
                        </div>
                        {card.action ? (
                          <button
                            className="notice-session-card-action"
                            onClick={() => runNoticeAction(card.action!.target)}
                            type="button"
                          >
                            {card.action.label}
                          </button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}
              <section className="notice-log-section">
                <div className="notice-log-section-head">
                  <div className="notice-log-section-title">Activity</div>
                  {lowSignalNoticeCount > 0 ? (
                    <button
                      className="notice-log-toggle"
                      onClick={() => setShowLowSignalNotices((current) => !current)}
                      type="button"
                    >
                      {showLowSignalNotices ? "Hide low signal" : `Show hidden (${lowSignalNoticeCount})`}
                    </button>
                  ) : null}
                </div>
                {visibleNoticeLog.length === 0 ? (
                  <div className="notice-log-empty">
                    {noticeLog.length === 0 ? "Nothing yet." : "Only hidden activity remains."}
                  </div>
                ) : (
                  visibleNoticeLog.map((n) => (
                    <div key={n.id} className={`notice-log-entry notice-log-${n.type}`}>
                      <div className="notice-log-meta">
                        <time className="notice-log-time" dateTime={new Date(n.timestamp).toISOString()}>
                          {new Date(n.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                        </time>
                        <span className={`notice-log-category category-${n.category}`}>{noticeCategoryLabel(n.category)}</span>
                        {n.count > 1 ? <span className="notice-log-repeat">×{n.count}</span> : null}
                      </div>
                      <div className="notice-log-entry-main">
                        <span className="notice-log-text">{n.text}</span>
                        {n.action ? (
                          <button
                            className="notice-log-action"
                            onClick={() => runNoticeAction(n.action!.target)}
                            type="button"
                          >
                            {n.action.label}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ))
                )}
              </section>
            </div>
          </div>
        </div>
      ) : null}

      <div
        className={[
          "workspace-grid",
          effectiveChatCollapsed ? "chat-collapsed" : "",
          childRailVisible ? "script-expanded" : "",
          draggingDivider ? "is-dragging" : "",
          activeSection === "workshop" ? "workshop-full" : "",
        ].filter(Boolean).join(" ")}
        style={{
          // Inline grid template overrides the CSS default so dragging
          // the dividers persists width across sessions. The chat column
          // collapses via the .chat-collapsed class which takes precedence.
          // When the media library panel is open AND an asset is selected
          // (so there's a valid attach target), a fixed 320px column is
          // inserted between the left rail and the editor.
          gridTemplateColumns: (() => {
            const libraryColumn =
              libraryPanelOpen && selectedAsset && activeSection !== "media"
                ? `${libraryPanelWidth}px `
                : "";
            // Workshop is a leaf primary — no sub-rail at all — so the
            // rail column is permanently 66px (just primary icons) and
            // the editor pane gets every other pixel. Other sections
            // keep full railWidth so the items list stays readable.
            const railColumn =
              activeSection === "workshop" ? "66px" : `${railWidth}px`;
            return effectiveChatCollapsed
              ? `${railColumn} ${libraryColumn}minmax(0, 1fr)`
              : `${railColumn} ${libraryColumn}minmax(0, 1fr) ${chatWidth}px`;
          })(),
        }}
      >
        <aside className={[
          "left-rail",
          childRailVisible ? "script-children-open" : "",
          // Collapse the 52px subrail grid track to 0 for primaries
          // that don't render a sub-rail (story / workshop).
          // Assets and Canon have built-in sub-rail entries.
          subrailHasChildren
          && childRailPrimary !== "story"
          && childRailPrimary !== "workshop"
            ? ""
            : "subrail-hidden",
        ].filter(Boolean).join(" ")}>
          <div className="primary-rail">
            {PRIMARY_SECTIONS.map((section) => (
              <div
                key={section}
                className="primary-rail-group"
              >
                <button
                  className={[
                    "rail-btn",
                    section === selectedPrimary ? "active" : "",
                    touchedPrimarySet.has(section) ? "touched" : "",
                  ].filter(Boolean).join(" ")}
                  data-icon-key={section}
                  onClick={() => activatePrimary(section)}
                  onContextMenu={(event) => {
                    if (section !== "script") return;
                    event.preventDefault();
                    setScriptRailContextMenu({ x: event.clientX, y: event.clientY });
                  }}
                  aria-label={PRIMARY_LABELS[section]}
                  title={section === "script" ? "Script — right-click to hide/show sub-rail" : undefined}
                  type="button"
                >
                  <span className="rail-icon">{primaryIconForSection(section)}</span>
                  <span className="rail-btn-label">{PRIMARY_LABELS[section]}</span>
                </button>
                {touchedPrimarySet.has(section) && (touchedFilesBySection[section]?.length ?? 0) > 0 && (
                  <div className="rail-touched-files" role="status" aria-live="polite">
                    <span className="rail-touched-files-label">editing</span>
                    {touchedFilesBySection[section]!.map((name) => (
                      <span key={name} className="rail-touched-files-name">{name}</span>
                    ))}
                  </div>
                )}
              </div>
            ))}
            <div className="primary-rail-spacer" aria-hidden="true" />
            <div className="primary-rail-group primary-rail-bottom">
              {SHOW_DESKTOP_ACCOUNT_GATE ? (
                <button
                  className="rail-btn rail-btn-profile"
                  onClick={openSettingsModal}
                  type="button"
                  data-plan={accountEntitlement.plan === "studio" ? "pro" : accountEntitlement.plan}
                  aria-label={`Account · ${accountEntitlement.plan}${desktopAuthState === "signed-in" ? ` · ${DESKTOP_AUTH_PLACEHOLDER_EMAIL}` : ""}`}
                  title={
                    desktopAuthState === "signed-in"
                      ? `${DESKTOP_AUTH_PLACEHOLDER_EMAIL}\n${
                          accountEntitlement.plan === "free"
                            ? "Free plan · click to upgrade"
                            : accountEntitlement.plan === "pro" || accountEntitlement.plan === "studio"
                              ? accountEntitlement.status === "trialing"
                                ? "Membership trial · manage subscription"
                                : "Membership · manage subscription"
                              : "Membership · manage subscription"
                        }`
                      : "Sign in"
                  }
                >
                  <span className="rail-icon rail-profile-avatar" aria-hidden="true">
                    {desktopAuthState === "signed-in"
                      ? (DESKTOP_AUTH_PLACEHOLDER_EMAIL.charAt(0).toUpperCase() || "?")
                      : "?"}
                  </span>
                  <span className="rail-btn-label">
                    {accountEntitlement.plan === "free"
                      ? "Free"
                      : accountEntitlement.plan === "pro" || accountEntitlement.plan === "studio"
                        ? accountEntitlement.status === "trialing" ? "Trial" : "Member"
                        : "Member"}
                  </span>
                </button>
              ) : null}
              <button
                className="rail-btn rail-btn-settings"
                onClick={openSettingsModal}
                type="button"
                aria-label="Settings"
              >
                <span className="rail-icon"><SettingsIcon /></span>
                <span className="rail-btn-label">Settings</span>
              </button>
            </div>
          </div>

          {/* Always render the subrail container — even when empty —
              so CSS Grid auto-flow keeps the items list in its `1fr`
              slot. Null-rendering would let the items list collapse
              into the empty 52px subrail track. For story/workshop
              we render the container empty + apply subrail-hidden so
              the track shrinks to 0 and the items column gets all the
              remaining rail width. */}
          {childRailPrimary === "workshop" || childRailPrimary === "story" || (childRailPrimary === "script" && scriptSubrailHidden) ? (
            <div className="script-subrail subrail-empty" aria-hidden="true" />
          ) : (
          <div
            className={[
              "script-subrail",
              subrailHasChildren ? "visible" : "hidden",
            ].join(" ")}
            role="tablist"
            aria-label={`${PRIMARY_LABELS[childRailPrimary]} sections`}
            aria-hidden={!subrailHasChildren}
            data-density={subrailDensity}
          >
            {childRailPrimary === "assets"
              ? ASSET_NAV_SECTIONS.map((section) => {
                  const videoSection = section === "videos";
                  return (
                    <button
                      key={section}
                      className={[
                        "script-rail-btn",
                        activeSection === section ? "active" : "",
                      ].filter(Boolean).join(" ")}
                      data-icon-key={section}
                      onClick={() => {
                        setAgentPrimarySelected(false);
                        setActiveSection(section);
                        setExpandedPrimary("assets");
                      }}
                      aria-label={videoSection ? SECTION_LABELS.videos : ASSET_SECTION_DETAILS[section].label}
                      title={videoSection ? SECTION_LABELS.videos : ASSET_SECTION_DETAILS[section].label}
                      type="button"
                      tabIndex={childRailVisible ? 0 : -1}
                    >
                      <span className="script-rail-btn-icon">
                        {videoSection ? <VideoMirrorIcon /> : assetIconForSection(section)}
                      </span>
                      <span className="script-rail-btn-label">
                        {videoSection ? SECTION_LABELS.videos : ASSET_SECTION_DETAILS[section].label}
                      </span>
                    </button>
                  );
                })
              : null}
            {customSubsectionsForPrimary.map((sub) => {
                const isRenaming = inlineRename?.kind === "subsection" && inlineRename.id === sub.id;
                const requestDelete = () =>
                  void commitDeleteSubsection({
                    id: sub.id,
                    name: sub.name,
                    folder: sub.folder,
                  });
                return (
                <div
                  key={sub.id}
                  className={[
                    "script-rail-btn-wrap",
                    "script-rail-btn-wrap-custom",
                    activeSection === sub.id ? "is-active" : "",
                  ].filter(Boolean).join(" ")}
                  role="presentation"
                >
                  <button
                    className={[
                      "script-rail-btn",
                      "script-rail-btn-custom",
                      activeSection === sub.id ? "active" : "",
                    ].filter(Boolean).join(" ")}
                    data-icon-key={sub.id}
                    onClick={() => {
                      if (isRenaming) return;
                      setAgentPrimarySelected(false);
                      setProjectContextSelected(false);
                      setPinboardSelected(false);
                      setSectionFormatSelected(null);
                      setSelectedMagicDocId(null);
                      setActiveSection(sub.id);
                      setExpandedPrimary(childRailPrimary);
                    }}
                    onDoubleClick={(e) => {
                      e.preventDefault();
                      setInlineRename({ kind: "subsection", id: sub.id, draft: sub.name });
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setCustomSubsectionRailMenu({
                        id: sub.id,
                        name: sub.name,
                        folder: sub.folder,
                        x: e.clientX,
                        y: e.clientY,
                      });
                    }}
                    onKeyDown={(e) => {
                      if (isRenaming) return;
                      if (e.key === "Delete" || e.key === "Backspace") {
                        e.preventDefault();
                        requestDelete();
                      }
                    }}
                    aria-label={sub.name}
                    title={isRenaming ? undefined : `${sub.name} — double-click to rename · right-click for more`}
                    type="button"
                    tabIndex={childRailVisible ? 0 : -1}
                  >
                    {childRailPrimary === "script" ? (
                      <span className="script-rail-btn-icon script-rail-btn-icon-canon">
                        {primaryIconForSection("script")}
                      </span>
                    ) : (
                      <span className="script-rail-btn-icon script-rail-btn-icon-custom">
                        {sub.icon || sub.name.trim().charAt(0).toUpperCase() || "·"}
                      </span>
                    )}
                    {isRenaming
                      ? renderInlineRenameInput("script-rail-btn-label script-rail-btn-label-editing")
                      : <span className="script-rail-btn-label">{sub.name}</span>}
                  </button>
                </div>
                );
              })}
            {childRailPrimary === "script" ? (
              <button
                className={[
                  "script-rail-btn",
                  activeSection === "script" && !activeCustomSubsectionForNav ? "active" : "",
                ].filter(Boolean).join(" ")}
                data-icon-key="script"
                onClick={() => {
                  setAgentPrimarySelected(false);
                  setProjectContextSelected(false);
                  setPinboardSelected(false);
                  setSectionFormatSelected(null);
                  setSelectedMagicDocId(null);
                  setActiveScriptPath(masterScriptPathConst);
                  setActiveSection("script");
                  setExpandedPrimary("script");
                }}
                aria-label="Script"
                title="Script — Master Script + scenes & prompts"
                type="button"
                tabIndex={childRailVisible ? 0 : -1}
              >
                <span className="script-rail-btn-icon script-rail-btn-icon-canon">
                  {primaryIconForSection("script")}
                </span>
                <span className="script-rail-btn-label">Script</span>
              </button>
            ) : null}
            {childRailPrimary === "assets" ? null : (
            <button
              className="script-rail-btn script-rail-btn-add"
              onClick={() => {
                if (!customSubsectionLimitReached) {
                  void commitNewSubsection(childRailPrimary, "Untitled", "docs", "");
                }
              }}
              aria-label={`Add subsection to ${PRIMARY_LABELS[childRailPrimary]}`}
              title={
                customSubsectionLimitReached
                  ? `${PRIMARY_LABELS[childRailPrimary]} is limited to ${LOCAL_UI_LIMITS.customSubsectionsPerPrimary} custom sections`
                  : `Add subsection to ${PRIMARY_LABELS[childRailPrimary]}`
              }
              type="button"
              disabled={customSubsectionLimitReached}
              tabIndex={childRailVisible ? 0 : -1}
            >
              <span className="script-rail-btn-icon script-rail-btn-icon-add" aria-hidden>+</span>
            </button>
            )}
          </div>
          )}

          <div className="context-pane">
            {activePrimary !== "script" ? (
              <div className="context-header">
                <div>
                  <div className="context-title-row">
                    <div className="context-title">{PRIMARY_LABELS[activePrimary]}</div>
                    {filteredActiveItems.length !== activeItems.length ? (
                      <div className="context-count">{filteredActiveItems.length} of {activeItems.length}</div>
                    ) : null}
                  </div>
                  <div className="context-subtitle">
                    {activePrimary === "assets" && activeSection === "media" && inboxView ? (
                      <button
                        type="button"
                        className="context-subtitle-back"
                        onClick={() => setInboxView(false)}
                        title="Back to All media"
                      >
                        ← Temporary trash · {inboxFiles.length + visiblePendingInboxJobCount}
                        {visiblePendingInboxJobCount ? ` (${visiblePendingInboxJobCount} generating)` : ""}
                      </button>
                    ) : (
                      contextSubtitle(activePrimary, activeSection)
                    )}
                  </div>
                  {activePrimary === "assets" &&
                  (activeSection === "characters" ||
                    activeSection === "locations" ||
                    activeSection === "keyframes") ? (
                    <div
                      className="asset-subview-tabs"
                      role="tablist"
                      aria-label={`${
                        activeSection === "characters"
                          ? "Character"
                          : activeSection === "locations"
                            ? "Location"
                            : "Keyframe"
                      } view`}
                    >
                      <button
                        type="button"
                        role="tab"
                        aria-selected={assetSubView === "single"}
                        className={`asset-subview-tab${assetSubView === "single" ? " active" : ""}`}
                        onClick={() => setAssetSubView("single")}
                      >
                        {activeSection === "keyframes" ? "Keyframes" : "Single"}
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={assetSubView === "sheet"}
                        className={`asset-subview-tab${assetSubView === "sheet" ? " active" : ""}`}
                        onClick={() => setAssetSubView("sheet")}
                      >
                        {activeSection === "keyframes" ? "Storyboard sheet" : "Sheet"}
                      </button>
                    </div>
                  ) : null}
                  {activePrimary === "assets" && activeSection === "audio" ? (
                    <div className="asset-subview-tabs" role="tablist" aria-label="Audio kind">
                      {(["music", "voiceover", "sfx", "ambient"] as const).map((kind) => {
                        const label =
                          kind === "music"
                            ? "Music"
                            : kind === "voiceover"
                              ? "Voice"
                              : kind === "sfx"
                                ? "SFX"
                                : "Ambient";
                        return (
                          <button
                            key={kind}
                            type="button"
                            role="tab"
                            aria-selected={audioSubView === kind}
                            className={`asset-subview-tab${audioSubView === kind ? " active" : ""}`}
                            onClick={() => setAudioSubView(kind)}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
                <div className="context-header-actions">
                  {activePrimary !== "workshop" && activeSection !== "videos" && !activeCustomSubsection && !inboxView ? (
                    <button
                      className="ghost-btn compact icon-btn context-create-btn"
                      disabled={activeSection === "media" ? busy === "upload" : creatingSection === activeSection}
                      aria-busy={activeSection === "media" ? busy === "upload" : creatingSection === activeSection}
                      onClick={() => {
                        if (activeSection === "media") {
                          void uploadAssetMedia();
                          return;
                        }
                        void createItem();
                      }}
                      title={
                        activeSection === "media"
                          ? "Import media (⌘N)"
                          : `${createLabelForSection(activeSection)} (⌘N)`
                      }
                      aria-label={
                        activeSection === "media"
                          ? "Import media"
                          : createLabelForSection(activeSection)
                      }
                      type="button"
                    >
                      ＋
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
            {/* Script tab skips the context-header — the master script
                sticky row serves as the header, saving ~60px of vertical
                space so the tree starts at the very top of the pane. */}

            {activeCustomSubsection ? (
              <div
                className="item-list item-list-custom-subsection"
                data-doc-density={
                  activeCustomSubsectionDocs.length >= LOCAL_UI_LIMITS.compactDocListAt ? "compact" : "normal"
                }
              >
                <div className="custom-subsection-name-panel" title={activeCustomSubsection.folder}>
                  {inlineRename?.kind === "subsection" && inlineRename.id === activeCustomSubsection.id ? (
                    renderInlineRenameInput("custom-subsection-name-label custom-subsection-name-label-editing")
                  ) : (
                    <span
                      className="custom-subsection-name-label"
                      onDoubleClick={() =>
                        setInlineRename({
                          kind: "subsection",
                          id: activeCustomSubsection.id,
                          draft: activeCustomSubsection.name,
                        })
                      }
                      title="Double-click to rename"
                    >
                      {activeCustomSubsection.name}
                    </span>
                  )}
                  {activeCustomSubsection.kind === "docs" ? (
                    <span className="custom-subsection-name-count" title={`${activeCustomSubsectionDocs.length} markdown docs`}>
                      {activeCustomSubsectionDocs.length}/{LOCAL_UI_LIMITS.customSubsectionDocs}
                    </span>
                  ) : null}
	                  {activeCustomSubsection.kind === "docs" ? (
	                    <button
	                      type="button"
	                      className="custom-subsection-name-add"
	                      onClick={() => void createCustomSubsectionDocNow()}
	                      title={
                          customSubsectionDocLimitReached
                            ? `Limit reached: ${LOCAL_UI_LIMITS.customSubsectionDocs} markdown docs`
                            : "New markdown doc"
                        }
	                      aria-label="New markdown doc"
                        disabled={customSubsectionDocLimitReached}
	                    >
                      +
                    </button>
                  ) : null}
                </div>
                {activeCustomSubsection.kind === "docs" ? (
                  <>
                    {customSubsectionDocLimitReached ? (
                      <div className="custom-subsection-limit-note">
                        Doc limit reached. Merge or delete old docs before adding more.
                      </div>
                    ) : null}
	                    {activeCustomSubsectionDocs.map((file) => {
	                        const label = file.name.replace(/\.md$/i, "");
                        const isRenaming = inlineRename?.kind === "subsection-doc" && inlineRename.filePath === file.path;
                        const content = isRenaming ? (
                          renderInlineRenameInput("item-row-label item-row-label-editing")
                        ) : (
	                          <span className="item-row-content">
	                            <span className="item-row-label">{label}</span>
	                          </span>
	                        );
                        return (
                          <button
                            key={file.path}
                            type="button"
                            className={[
	                              "item-row",
	                              "custom-subsection-nav-row",
	                              customSubsectionDoc?.filePath === file.path ? "active" : "",
	                            ].filter(Boolean).join(" ")}
	                            onClick={() => {
                              if (isRenaming) return;
                              void openCustomSubsectionDoc(file.path);
                            }}
                            onDoubleClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setInlineRename({ kind: "subsection-doc", filePath: file.path, draft: label });
                            }}
	                            title={isRenaming ? undefined : `${file.path} — double-click to rename`}
	                          >
	                            {content}
	                          </button>
	                        );
	                      })}
                    {customSubsectionFiles?.id === activeCustomSubsection.id &&
                    activeCustomSubsectionDocs.length === 0 ? (
                      <div className="custom-subsection-nav-empty">No markdown docs.</div>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : activePrimary === "assets" && activeSection === "media" && inboxView ? (
              <div className="asset-grid asset-grid-inbox">
                {visiblePendingInboxJobCount === 0 && inboxFiles.length === 0 ? (
                  <div className="item-list-empty">Temporary trash is empty.</div>
                ) : (
                  <>
                  {visiblePendingInboxJobs.map((job) => {
                    const elapsedSec = Math.max(0, Math.floor((Date.now() - job.startedAt) / 1000));
                    const elapsedLabel = elapsedSec >= 60
                      ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`
                      : `${elapsedSec}s`;
                    return (
                      <div key={job.id} className="asset-tile asset-tile-inbox asset-tile-inbox-pending">
                        <div className="asset-tile-inbox-shimmer" aria-label="Generating">
                          <div className="asset-tile-inbox-shimmer-icon">
                            {job.capability === "video" ? "▶" : job.capability === "music" || job.capability === "audio" ? "♪" : "◷"}
                          </div>
                          <div className="asset-tile-inbox-shimmer-label">
                            Generating {job.capability}…
                          </div>
                        </div>
                        <div className="asset-tile-label asset-tile-label-inbox">
                          <span className="asset-tile-name" title={job.prompt}>{job.prompt || "(no prompt)"}</span>
                          <span className="asset-tile-meta">{elapsedLabel}{job.model ? ` · ${job.model}` : ""}</span>
                        </div>
                      </div>
                    );
                  })}
                  {inboxFiles.map((file) => {
                    const busy = inboxBusy === file.relPath;
                    const sizeKb = file.size >= 1024 ? `${(file.size / 1024).toFixed(0)} KB` : `${file.size} B`;
                    return (
                      <div
                        key={file.relPath}
                        className={`asset-tile asset-tile-inbox${busy ? " busy" : ""}`}
                      >
                        <button
                          type="button"
                          className="asset-tile-inbox-preview"
                          onClick={() => setInboxPreview(file)}
                          title={`Preview ${file.name}`}
                          aria-label={`Preview ${file.name}`}
                        >
                          {file.kind === "image" ? (
                            <img
                              src={file.fileUrl}
                              alt=""
                              className="asset-tile-thumb"
                              draggable={false}
                              onError={(event) => {
                                (event.currentTarget as HTMLImageElement).style.display = "none";
                              }}
                            />
                          ) : (
                            <div className={`asset-tile-placeholder asset-tile-placeholder-${file.kind}`}>
                              {file.kind.charAt(0).toUpperCase()}
                            </div>
                          )}
                        </button>
                        <button
                          type="button"
                          className="asset-tile-inbox-delete"
                          disabled={busy}
                          onClick={() => void deleteInboxFileNow(file)}
                          title="Delete permanently"
                          aria-label="Delete permanently"
                        >
                          ×
                        </button>
                        <div className="asset-tile-label asset-tile-label-inbox">
                          <span className="asset-tile-name" title={file.name}>{file.name}</span>
                          <span className="asset-tile-meta">{sizeKb}</span>
                        </div>
                        <button
                          type="button"
                          className="asset-tile-inbox-primary"
                          disabled={busy}
                          onClick={() => void moveInboxToLibrary(file)}
                          title="Restore to All media"
                        >
                          Restore
                        </button>
                      </div>
                    );
                  })}
                  </>
                )}
              </div>
            ) : activePrimary === "assets" && activeSection !== "videos" ? (
              <>
              {activeSection === "media" ? (
                <div className="asset-category-strip" role="tablist" aria-label="Media category">
                  {ALL_MEDIA_CATEGORY_FILTERS.map((filter) => {
                    const active = allMediaCategoryFilter === filter.id;
                    const count = allMediaCategoryCounts[filter.id] || 0;
                    return (
                      <button
                        key={filter.id}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        aria-label={`${filter.label} media (${count})`}
                        className={`asset-category-tab${active ? " active" : ""}`}
                        onClick={() => setAllMediaCategoryFilter(filter.id)}
                        title={`${filter.label} · ${count}`}
                      >
                        <span className="asset-category-label">{filter.label}</span>
                        {count > 0 ? (
                          <span className="asset-category-count">{count}</span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
              <div className="asset-grid">
                {filteredActiveItems.length ? (
                  <>
                  {visibleFilteredActiveItems.map((item) => {
                    const assetItem = item as AssetEntry;
                    const thumb = tileThumbsByAssetId.get(assetItem.id);
                    const label = getEntryLabel(activeSection, item);
                    const initial = label.trim().charAt(0).toUpperCase() || "?";
                    const isActive = selectedItem?.id === item.id;
                    const thumbBroken = thumb ? brokenMediaIds[thumb.id] : false;
                    const tileSection = isAssetSection(activeSection) ? activeSection : "media";
                    const assetOwner =
                      tileSection === "media"
                        ? assetOwnerById.get(assetItem.id) || null
                        : {
                            section: tileSection,
                            collectionKey: tileSection as Exclude<AssetCollectionKey, "library">,
                          };
                    return (
	                      <div
	                        key={item.id}
	                        className={[
                          "asset-tile",
                          isActive ? "active" : "",
                          draggingItemId === item.id ? "dragging" : "",
                          dragOver?.id === item.id && draggingItemId && draggingItemId !== item.id
                            ? dragOver.position === "before"
                              ? "drop-target-before"
                              : dragOver.position === "after"
                                ? "drop-target-after"
                                : dragOver.position === "above"
                                  ? "drop-target-above"
                                  : "drop-target-below"
                            : "",
                          isItemTouched(assetItem) ? "touched" : "",
                        ].filter(Boolean).join(" ")}
	                        onContextMenu={(event) => {
	                          event.preventDefault();
	                          selectAssetItem(tileSection, item.id, assetOwner);
	                          setAssetContextMenu({
	                            section: assetOwner?.section || tileSection,
	                            assetId: assetItem.id,
                            x: event.clientX,
	                            y: event.clientY,
	                          });
	                        }}
	                        onDragOver={(event) => {
	                          const activeDragId = draggingItemIdRef.current || draggingItemId;
	                          if (!activeDragId || activeDragId === item.id) return;
	                          event.preventDefault();
	                          const sourceOwner = assetOwnerById.get(activeDragId);
	                          if (
	                            activeSection === "media" &&
	                            sourceOwner?.collectionKey !== assetOwner?.collectionKey
	                          ) {
	                            event.dataTransfer.dropEffect = "none";
	                            setCurrentDragOver(null);
	                            return;
	                          }
	                          const groupDrop = event.shiftKey && activeSection !== "media";
	                          event.dataTransfer.dropEffect = groupDrop ? "link" : "move";
	                          if (groupDrop) {
	                            setCurrentDragOver({ id: item.id, mode: "group", position: "before" });
	                            return;
	                          }
	                          updateDropIndicator(event, item.id, "reorder", "grid");
	                        }}
	                        onDrop={(event) => {
	                          event.preventDefault();
	                          const sourceId =
	                            event.dataTransfer.getData("text/plain") ||
	                            draggingItemIdRef.current ||
	                            draggingItemId;
	                          if (sourceId) {
	                            const currentDrop = dragOverRef.current;
	                            const dropPosition =
	                              currentDrop?.id === item.id
	                                ? currentDrop.position
	                                : dropPositionForEvent(event, "grid");
	                            if (activeSection === "media") {
	                              const sourceOwner = assetOwnerById.get(sourceId);
	                              if (!sourceOwner || !assetOwner) {
	                                setNotice("Couldn't find the source section for this media item.", "error");
	                                endItemDrag();
	                                return;
	                              }
	                              if (sourceOwner.collectionKey !== assetOwner.collectionKey) {
	                                setNotice(
	                                  "All Media can reorder within the same source section only. Open the source section to move items across groups.",
	                                  "info",
	                                );
	                                endItemDrag();
	                                return;
	                              }
	                              reorderAssetOwnerItems(sourceId, item.id, dropPosition, sourceOwner);
	                            } else {
	                              reorderActiveSectionItems(sourceId, item.id, dropPosition);
	                            }
	                          }
	                          endItemDrag();
	                        }}
	                      >
	                        <button
	                          className="asset-tile-trigger"
	                          type="button"
		                          aria-pressed={isActive}
                              onPointerDown={(event) => {
                                if (event.button !== 0) return;
                                if (shouldSuppressDraggedClick(item.id)) return;
                                selectAssetItem(tileSection, item.id, assetOwner);
                              }}
		                          onClick={() => {
		                            if (shouldSuppressDraggedClick(item.id)) return;
		                            selectAssetItem(tileSection, item.id, assetOwner);
                          }}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            // Select the tile first so ⌘C / keyboard ops target it.
                            selectAssetItem(tileSection, item.id, assetOwner);
                            setAssetContextMenu({
                              section: assetOwner?.section || tileSection,
                              assetId: item.id,
                              x: event.clientX,
	                              y: event.clientY,
	                            });
	                          }}
	                          aria-label={label}
	                        >
                          <span className="asset-tile-media">
                            {thumb && thumb.kind === "image" && thumb.fileUrl && !thumbBroken ? (
                              <img
                                src={mediaSrc(thumb, mediaRefreshKey)}
                                alt={label}
                                draggable={false}
                                loading="lazy"
                                onError={() => markMediaBroken(thumb.id, true)}
                                onLoad={() => markMediaBroken(thumb.id, false)}
                              />
                            ) : thumb && thumb.kind === "video" && thumb.fileUrl && !thumbBroken ? (
                              <video
                                src={mediaSrc(thumb, mediaRefreshKey)}
                                className="asset-tile-thumb"
                                muted
                                playsInline
                                preload="metadata"
                                onError={() => markMediaBroken(thumb.id, true)}
                                onLoadedData={() => markMediaBroken(thumb.id, false)}
                              />
                            ) : thumb && thumb.kind === "audio" ? (
                              <span className="asset-tile-glyph"><AudioWaveIcon /></span>
                            ) : (
                              <span className="asset-tile-initial">{initial}</span>
                            )}
                          </span>
                          <span className="asset-tile-label-row">
                            <span className="asset-tile-order">{visibleOrderById.get(item.id) ?? ""}</span>
                            <span className="asset-tile-label">{label}</span>
	                          </span>
	                        </button>
	                        {assetOwner ? (
	                          <button
	                            type="button"
	                            className="asset-tile-drag-handle"
	                            draggable
	                            onMouseDown={(event) => event.stopPropagation()}
	                            onPointerDown={(event) => event.stopPropagation()}
	                            onClick={(event) => event.stopPropagation()}
	                            onDragStart={(event) => {
	                              beginItemDrag(item.id);
	                              selectAssetItem(tileSection, item.id, assetOwner);
	                              event.dataTransfer.effectAllowed = "move";
	                              event.dataTransfer.setData("text/plain", item.id);
	                              const tile = event.currentTarget.closest(".asset-tile") as HTMLElement | null;
	                              event.dataTransfer.setDragImage(tile || event.currentTarget, 36, 36);
	                            }}
	                            onDragEnd={endItemDrag}
	                            title={`Drag to reorder ${label}${isAssetSection(activeSection) ? " · hold Shift and drop on another asset to group" : ""}`}
	                            aria-label={`Drag to reorder ${label}`}
	                          >
	                            <span className="asset-tile-drag-hand" aria-hidden="true">
	                              <svg viewBox="0 0 24 24" focusable="false">
	                                <path d="M8.7 10.5V6.1a1.15 1.15 0 0 1 2.3 0v4.1" />
	                                <path d="M11 10.1V5a1.15 1.15 0 0 1 2.3 0v5.1" />
	                                <path d="M13.3 10.5V6.2a1.15 1.15 0 0 1 2.3 0v5.2" />
	                                <path d="M15.6 11.7V8.4a1.1 1.1 0 0 1 2.2 0v5.4c0 3.8-2.2 6.2-5.7 6.2h-.9c-2.2 0-3.8-.9-4.9-2.7L4.4 14a1.15 1.15 0 0 1 1.9-1.3l2.4 2.5" />
	                              </svg>
	                            </span>
	                          </button>
	                        ) : null}
	                        <button
	                          type="button"
	                          className="asset-tile-delete"
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.stopPropagation();
                            requestAssetDelete(tileSection, item as AssetEntry);
                          }}
                          title={
                            assetOwner && activeSection === "media" && assetOwner.section !== "media"
                              ? `Delete ${label} from ${SECTION_LABELS[assetOwner.section]}`
                              : `Delete ${label}`
                          }
                          aria-label={`Delete ${label}`}
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                  {hiddenFilteredActiveItemCount > 0 ? (
                    <button
                      className="asset-grid-show-more"
                      type="button"
                      onClick={showMoreAssetGridItems}
                    >
                      Show {Math.min(hiddenFilteredActiveItemCount, LOCAL_UI_LIMITS.assetGridPageSize)} more
                    </button>
                  ) : null}
                  </>
                ) : activeSection === "story" && visibleMagicDocEntries.length ? null : assetGridQuery && activeItems.length > 0 ? (
                  <div className="item-list-empty">
                    No {(SECTION_LABELS[activeSection] || "items").toLowerCase()} match
                    <em>"{assetGridQuery}"</em>.
                    <button
                      className="ghost-btn compact item-list-empty-action"
                      type="button"
                      onClick={() => setAssetGridQuery("")}
                    >
                      Clear filter
                    </button>
                  </div>
                ) : (
                  <div className="item-list-empty">
                    No {(SECTION_LABELS[activeSection] || "items").toLowerCase()} yet.
                    {activeSection === "media" ? null : (
                      <button
                        className="ghost-btn compact item-list-empty-action asset-empty-create-btn"
                        type="button"
                        disabled={creatingSection === activeSection}
                        onClick={() => void createItem()}
                      >
                        {creatingSection === activeSection ? "Creating..." : `＋ ${createLabelForSection(activeSection)}`}
                      </button>
                    )}
                  </div>
                )}
              </div>
              </>
            ) : activePrimary === "script" ? (
              <>
              <div className="item-list">
			                {/* Simple script spine: Master Script is the authored
			                    film document; prompts are the visible generation
			                    units. Scenes only group prompts. */}
				                <div className="script-tree-header">
			                  {masterScriptEntry ? (
                      <>
                        <div className="script-tree-top-actions">
                          <button
                            className="ghost-btn compact script-tree-create-btn script-tree-master-create-btn icon-only"
                            type="button"
                            aria-label="Add scene"
                            disabled={creatingSection === "script"}
                            onClick={() => void createItem("script")}
                            title="Add scene (right-click for more)"
                            onContextMenu={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              setMasterScriptContextMenu({ x: event.clientX, y: event.clientY });
                            }}
                          >
                            +
                          </button>
                        </div>
	                      <div className="script-tree-master-row-shell">
	                        <button
	                          className="script-tree-toggle script-tree-master-toggle"
                          onClick={() => setMasterScriptTreeExpanded((current) => !current)}
                          type="button"
                          aria-expanded={masterScriptTreeExpanded}
                          aria-label={`${masterScriptTreeExpanded ? "Collapse" : "Expand"} Master Script scenes`}
                          title={masterScriptTreeExpanded ? "Collapse scenes" : "Expand scenes"}
                        >
                          {masterScriptTreeExpanded ? "▾" : "▸"}
                        </button>
                        <button
                          className={[
                            "item-row",
                            "script-tree-master",
                            !projectContextSelected && !pinboardSelected && !sectionFormatSelected && activeSection === "script" && selectedItem?.id === masterScriptEntry.id ? "active" : "",
                            isItemTouched(masterScriptEntry as { path?: string }) ? "touched" : "",
                          ].filter(Boolean).join(" ")}
                          onClick={() => {
                            setProjectContextSelected(false);
                            setPinboardSelected(false);
                            setSectionFormatSelected(null);
                            setActiveSection("script");
                            setSelectedIds((current) => ({ ...current, script: masterScriptEntry.id }));
                          }}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            setMasterScriptContextMenu({ x: event.clientX, y: event.clientY });
                          }}
                          type="button"
                        >
                          <span className="item-row-content">
                            <span className="item-row-label">{getEntryLabel("script", masterScriptEntry)}</span>
                            <span className="script-tree-row-note">
                              {sceneEntries.length} scene{sceneEntries.length === 1 ? "" : "s"} · {(project?.prompts || []).length} prompt{(project?.prompts || []).length === 1 ? "" : "s"}
                            </span>
                            {(() => {
                              const masterExplicit = Number(masterScriptEntry?.durationSec);
                              const hasTarget = Number.isFinite(masterExplicit) && masterExplicit > 0;
                              const actual = masterScriptDurationSec || 0;
                              const display = actual || (hasTarget ? Math.round(masterExplicit) : 0);
                              const delta = hasTarget ? actual - Math.round(masterExplicit) : 0;
                              return (
                                <RuntimeBadge
                                  editing={editingDurationKey === `script:${masterScriptEntry.id}`}
                                  initialDraft={initialDurationDraft(masterScriptEntry.durationSec ?? null)}
                                  onEditCommit={(draft) => commitDurationEdit("script", masterScriptEntry.id, draft)}
                                  onEditCancel={cancelDurationEdit}
                                  onEditStart={() => startDurationEdit("script", masterScriptEntry.id)}
                                  value={display || null}
                                  isTotal
                                  tooltip={display
                                    ? (hasTarget
                                      ? `Target ${formatDurationLabel(masterExplicit)} · actual ${formatDurationLabel(actual)}${delta > 0 ? ` — ${delta}s over target` : delta < 0 ? ` — ${Math.abs(delta)}s under target` : " — on target"} · click to edit target`
		                                      : `Total from ${(project?.prompts || []).length} prompt${(project?.prompts || []).length === 1 ? "" : "s"} · click to set target`)
                                    : "No target runtime set · click to set"
                                  }
                                  delta={delta}
                                  deltaTooltip={delta > 0
		                                    ? `Prompts are ${delta}s over master target`
	                                    : delta < 0
		                                      ? `Prompts are ${Math.abs(delta)}s under master target`
                                      : ""}
                                  onSyncClick={() =>
                                    redistributeDurationToChildren(masterScriptEntry.id, "scale")
                                  }
                                />
                              );
                            })()}
	                          </span>
	                        </button>
	                      </div>
                      </>
		                  ) : (
		                    <div className="script-tree-master-label">Script</div>
		                  )}
	                </div>
		                {/* Scenes organize prompts but stay editable so users can
		                    name/describe location-event groups directly. */}
                {masterScriptTreeExpanded || sceneEntries.length === 0 ? (
                  <div className="script-tree-master-children">
	                {sceneEntries.length === 0 ? (
	                  <div className="item-list-empty script-tree-empty-state">
		                    <span>No scenes yet.</span>
                        <button
                          className="ghost-btn compact script-tree-create-btn"
                          type="button"
                          aria-label="Add first scene"
                          disabled={creatingSection === "script"}
                          onClick={() => void createItem("script")}
                          title="Add first scene"
                        >
                          + Add first scene
                        </button>
	                  </div>
                ) : (
		                  sceneEntries.map((scene, sceneIndex) => {
		                    const sceneClips = promptsBySceneId.get(scene.id) || [];
		                    const sceneLabel = hierarchyTitleText(getEntryLabel("script", scene)) || getEntryLabel("script", scene);
	                    const isExpanded = expandedSceneIds[scene.id] !== false;
	                    const sceneTotalSec = sceneDurationById.get(scene.id) || 0;
	                    return (
	                      <div key={scene.id} className="script-tree-scene">
                        <div className="script-tree-scene-row-shell">
                          <button
                            className="script-tree-toggle"
                            onClick={() => {
                              setExpandedSceneIds((current) => ({ ...current, [scene.id]: !isExpanded }));
                            }}
                            type="button"
                            aria-expanded={isExpanded}
	                            aria-label={`${isExpanded ? "Collapse" : "Expand"} ${getEntryLabel("script", scene)}`}
	                            title={isExpanded ? "Collapse group" : "Expand group"}
                          >
                            {isExpanded ? "▾" : "▸"}
                          </button>
                          <button
	                            className={[
	                              "item-row",
	                              "script-tree-scene-row",
                                !projectContextSelected && !pinboardSelected && !sectionFormatSelected && activeSection === "script" && selectedItem?.id === scene.id ? "active" : "",
	                              draggingItemId === scene.id ? "dragging" : "",
                              dragOver?.id === scene.id && draggingItemId && draggingItemId !== scene.id
                                ? (dragOver.position === "above" ? "drop-target-above" : "drop-target-below")
                                : "",
                              isItemTouched(scene as { path?: string }) ? "touched" : "",
                            ].filter(Boolean).join(" ")}
		                            onClick={() => {
		                              if (shouldSuppressDraggedClick(scene.id)) return;
	                                setProjectContextSelected(false);
                                setPinboardSelected(false);
                                setSectionFormatSelected(null);
                                setActiveSection("script");
	                                setSelectedIds((current) => ({ ...current, script: scene.id }));
		                            }}
	                            onDragOver={(event) => {
	                              const activeDragId = draggingItemIdRef.current || draggingItemId;
	                              if (!activeDragId || activeDragId === scene.id) return;
	                              if (!project?.script.some((entry) => entry.id === activeDragId)) return;
	                              event.preventDefault();
	                              event.dataTransfer.dropEffect = "move";
	                              updateDropIndicator(event, scene.id);
                            }}
                            onDrop={(event) => {
                              event.preventDefault();
                              const sourceId =
	                                event.dataTransfer.getData("text/plain") ||
	                                draggingItemIdRef.current ||
	                                draggingItemId;
	                              if (!sourceId || !project?.script.some((entry) => entry.id === sourceId)) {
	                                endItemDrag();
	                                return;
	                              }
	                              const currentDrop = dragOverRef.current;
	                              const dropPosition =
	                                currentDrop?.id === scene.id
	                                  ? currentDrop.position
	                                  : dropPositionForEvent(event, "row");
	                              setActiveSection("script");
	                              reorderSectionItems("script", sourceId, scene.id, dropPosition);
	                              endItemDrag();
	                            }}
	                            onContextMenu={(event) => {
	                              event.preventDefault();
	                              event.stopPropagation();
	                              setProjectContextSelected(false);
	                              setPinboardSelected(false);
	                              setSectionFormatSelected(null);
	                              setActiveSection("script");
	                              setSelectedIds((current) => ({ ...current, script: scene.id }));
	                              setClipContextMenu(null);
	                              setSceneContextMenu({ sceneId: scene.id, x: event.clientX, y: event.clientY });
	                            }}
                            type="button"
		                            title={`${sceneLabel}${sceneTotalSec ? ` · ${formatDurationLabel(sceneTotalSec)}` : ""} · click to edit scene · caret expands prompts`}
	                          >
	                            <span
	                              className="item-row-drag-handle"
	                              draggable
	                              onMouseDown={(event) => event.stopPropagation()}
	                              onPointerDown={(event) => event.stopPropagation()}
	                              onClick={(event) => event.stopPropagation()}
	                              onDragStart={(event) => {
	                                event.stopPropagation();
	                                beginItemDrag(scene.id);
	                                setActiveSection("script");
	                                setSelectedIds((current) => ({ ...current, script: scene.id }));
	                                event.dataTransfer.effectAllowed = "move";
	                                event.dataTransfer.setData("text/plain", scene.id);
	                                const row = event.currentTarget.closest(".script-tree-scene-row") as HTMLElement | null;
	                                if (row) event.dataTransfer.setDragImage(row, 16, 12);
	                              }}
	                              onDragEnd={endItemDrag}
	                              title={`Drag to reorder ${sceneLabel}`}
	                              aria-label={`Drag to reorder ${sceneLabel}`}
	                            >
	                              ⋮⋮
	                            </span>
	                            <span className="item-row-content">
		                              <span className="item-row-order">{sceneIndex + 1}</span>
	                              <span className="item-row-label">{sceneLabel}</span>
                                {sceneTotalSec ? (
                                  <RuntimeBadge
                                    editing={editingDurationKey === `script:${scene.id}`}
                                    initialDraft={initialDurationDraft(scene.durationSec ?? sceneTotalSec)}
                                    onEditCommit={(draft) => commitDurationEdit("script", scene.id, draft)}
                                    onEditCancel={cancelDurationEdit}
                                    onEditStart={() => startDurationEdit("script", scene.id)}
                                    value={sceneTotalSec}
                                    text={formatDurationLabel(sceneTotalSec)}
	                                    tooltip={`${formatDurationLabel(sceneTotalSec)} total · right-click for prompt actions`}
                                  />
                                ) : null}
	                            </span>
                          </button>
                        </div>
                        {isExpanded ? (
                          <div className="script-tree-clips">
                            {sceneClips.length === 0 ? (
                              <div className="script-tree-empty">
	                                <span>No prompts yet</span>
                                  <button
                                    className="ghost-btn compact script-tree-create-btn"
                                    type="button"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      appendClipToScene(scene.id);
                                    }}
                                  >
                                    + 15s prompt
                                  </button>
                              </div>
                            ) : (
                              sceneClips.map((prompt, promptIndex) => {
                                const clipActive = !projectContextSelected && !pinboardSelected && !sectionFormatSelected && activeSection === "prompts" && selectedItem?.id === prompt.id;
                                const clipDuration = clipDurationSeconds(prompt.durationSec);
                                const timeLabel = formatDurationLabel(clipDuration);
	                                const clipLabel = hierarchyTitleText(getEntryLabel("prompts", prompt)) || `Prompt ${promptIndex + 1}`;
                                // Sub-prompts get an indent + connector line in CSS.
                                // The reordering above guarantees they sit immediately
                                // below their parent in the iteration order.
                                const isSubPrompt = !!prompt.parentPromptId
                                  && sceneClips.some((p) => p.id === prompt.parentPromptId);
                                return (
	                                  <div
	                                    key={prompt.id}
	                                    className={[
	                                      "item-row",
	                                      "script-tree-segment-row",
	                                      "script-tree-clip-row",
                                      isSubPrompt ? "is-sub-prompt" : "",
	                                      clipActive ? "active" : "",
	                                      draggingItemId === prompt.id ? "dragging" : "",
	                                      dragOver?.id === prompt.id && draggingItemId && draggingItemId !== prompt.id
	                                        ? (dragOver.position === "above" ? "drop-target-above" : "drop-target-below")
	                                        : "",
	                                      isItemTouched(prompt as { path?: string }) ? "touched" : "",
	                                    ].filter(Boolean).join(" ")}
		                                    onContextMenu={(event) => {
		                                      event.preventDefault();
	                                      event.stopPropagation();
	                                      setProjectContextSelected(false);
	                                      setPinboardSelected(false);
	                                      setSectionFormatSelected(null);
	                                      setActiveSection("prompts");
	                                      setSelectedIds((current) => ({ ...current, prompts: prompt.id }));
	                                      setSceneContextMenu(null);
		                                      setClipContextMenu({ promptId: prompt.id, x: event.clientX, y: event.clientY });
	                                    }}
	                                    onDragOver={(event) => {
	                                      const activeDragId = draggingItemIdRef.current || draggingItemId;
	                                      if (!activeDragId || activeDragId === prompt.id) return;
	                                      if (!project?.prompts.some((entry) => entry.id === activeDragId)) return;
	                                      event.preventDefault();
	                                      event.dataTransfer.dropEffect = "move";
	                                      updateDropIndicator(event, prompt.id);
	                                    }}
	                                    onDrop={(event) => {
	                                      event.preventDefault();
	                                      const sourceId =
	                                        event.dataTransfer.getData("text/plain") ||
	                                        draggingItemIdRef.current ||
	                                        draggingItemId;
	                                      if (sourceId && project?.prompts.some((entry) => entry.id === sourceId)) {
	                                        const currentDrop = dragOverRef.current;
	                                        const dropPosition =
	                                          currentDrop?.id === prompt.id
	                                            ? currentDrop.position
	                                            : dropPositionForEvent(event, "row");
	                                        setActiveSection("prompts");
	                                        reorderSectionItems("prompts", sourceId, prompt.id, dropPosition);
	                                      }
	                                      endItemDrag();
	                                    }}
	                                  >
	                                    <button
	                                      className="script-tree-segment-select script-tree-clip-select"
	                                      onClick={() => {
	                                        if (shouldSuppressDraggedClick(prompt.id)) return;
	                                        setClipContextMenu(null);
	                                        setProjectContextSelected(false);
                                        setPinboardSelected(false);
                                        setSectionFormatSelected(null);
                                        setActiveSection("prompts");
                                        setSelectedIds((current) => ({ ...current, prompts: prompt.id }));
                                      }}
                                      type="button"
                                      title={[
	                                        `Prompt ${promptIndex + 1}`,
                                        timeLabel,
                                        prompt.content ? `${prompt.content.length} chars` : "empty",
	                                      ].filter(Boolean).join(" · ")}
	                                    >
	                                      <span
	                                        className="item-row-drag-handle"
	                                        draggable
	                                        onMouseDown={(event) => event.stopPropagation()}
	                                        onPointerDown={(event) => event.stopPropagation()}
	                                        onClick={(event) => event.stopPropagation()}
	                                        onDragStart={(event) => {
	                                          event.stopPropagation();
	                                          beginItemDrag(prompt.id);
	                                          setActiveSection("prompts");
	                                          setSelectedIds((current) => ({ ...current, prompts: prompt.id }));
	                                          event.dataTransfer.effectAllowed = "move";
	                                          event.dataTransfer.setData("text/plain", prompt.id);
	                                          const row = event.currentTarget.closest(".script-tree-segment-row") as HTMLElement | null;
	                                          if (row) event.dataTransfer.setDragImage(row, 16, 12);
	                                        }}
	                                        onDragEnd={endItemDrag}
	                                        title={`Drag to reorder ${clipLabel}`}
	                                        aria-label={`Drag to reorder ${clipLabel}`}
	                                      >
	                                        ⋮⋮
	                                      </span>
	                                      <span className="item-row-content">
	                                        <span className="item-row-order">{promptIndex + 1}</span>
                                        <span className="item-row-label">{clipLabel}</span>
                                        <RuntimeBadge
                                          editing={editingDurationKey === `prompts:${prompt.id}`}
                                          initialDraft={initialDurationDraft(clipDuration)}
                                          onEditCommit={(draft) => commitDurationEdit("prompts", prompt.id, draft)}
                                          onEditCancel={cancelDurationEdit}
                                          onEditStart={() => startDurationEdit("prompts", prompt.id)}
                                          value={clipDuration}
                                          text={timeLabel}
                                          tooltip={`${timeLabel} · Seedance range 5-15s · click to edit`}
                                        />
                                        {!prompt.content ? (
                                          <span className="script-tree-seg-empty">Draft</span>
                                        ) : null}
                                      </span>
                                    </button>
                                  </div>
                                );
                              })
                            )}
                          </div>
                        ) : null}
                      </div>
                    );
                  })
                )}
                  </div>
                ) : null}
              </div>
		              {/* Scene context menu — right-click on a scene row */}
	              {sceneContextMenu ? (
	                <PositionedContextMenu
		                  ariaLabel="Scene prompt actions"
                  onClose={() => setSceneContextMenu(null)}
                  x={sceneContextMenu.x}
                  y={sceneContextMenu.y}
                  title={(() => {
                    const sc = project?.script.find((s) => s.id === sceneContextMenu.sceneId);
                    return sc ? getEntryLabel("script", sc) : "Scene";
                  })()}
                >
	                  <button
	                    className="shot-context-menu-item"
	                    onClick={() => {
	                      appendClipToScene(sceneContextMenu.sceneId);
	                      setSceneContextMenu(null);
	                    }}
                    role="menuitem"
                    type="button"
                  >
		                    Add 15s prompt
	                  </button>
                  <div className="shot-context-menu-divider" />
                  <button
                    className="shot-context-menu-item"
                    onClick={() => {
                      insertSceneBefore(sceneContextMenu.sceneId);
                      setSceneContextMenu(null);
                    }}
                    role="menuitem"
                    type="button"
                  >
                    Insert scene before
                  </button>
                  <button
                    className="shot-context-menu-item"
                    onClick={() => {
                      insertSceneAfter(sceneContextMenu.sceneId);
                      setSceneContextMenu(null);
                    }}
                    role="menuitem"
                    type="button"
                  >
	                    Insert scene after
                  </button>
                  <div className="shot-context-menu-divider" />
                  <button
                    className="shot-context-menu-item danger"
                    onClick={() => {
                      deleteScene(sceneContextMenu.sceneId);
                      setSceneContextMenu(null);
                    }}
                    role="menuitem"
                    type="button"
                  >
		                    Delete scene
		                    <span className="shot-context-menu-hint">
			                      Deletes prompts in this scene
		                    </span>
                  </button>
                </PositionedContextMenu>
              ) : null}
              {/* Master Script row context menu — global script-tree
                  operations. Right-click on the Master Script row OR
                  on the "+" button in the top actions area. */}
              {masterScriptContextMenu ? (
                <PositionedContextMenu
                  ariaLabel="Script tree actions"
                  onClose={() => setMasterScriptContextMenu(null)}
                  x={masterScriptContextMenu.x}
                  y={masterScriptContextMenu.y}
                  title="Script tree"
                >
                  <button
                    className="shot-context-menu-item"
                    onClick={() => {
                      void createItem("script");
                      setMasterScriptContextMenu(null);
                    }}
                    role="menuitem"
                    type="button"
                  >
                    Add scene
                  </button>
                  <button
                    className="shot-context-menu-item"
                    onClick={() => {
                      insertSceneAtTop();
                      setMasterScriptContextMenu(null);
                    }}
                    role="menuitem"
                    type="button"
                  >
                    Add scene at top
                  </button>
                </PositionedContextMenu>
              ) : null}
	              {/* Prompt context menu — right-click on a prompt row */}
              {clipContextMenu ? (
                <PositionedContextMenu
	                  ariaLabel="Prompt actions"
                  onClose={() => setClipContextMenu(null)}
                  x={clipContextMenu.x}
                  y={clipContextMenu.y}
                  title={(() => {
                    const clip = project?.prompts.find((prompt) => prompt.id === clipContextMenu.promptId);
                    return clip
                      ? hierarchyTitleText(getEntryLabel("prompts", clip)) || getEntryLabel("prompts", clip)
	                      : "Prompt";
                  })()}
                >
                  <button
                    className="shot-context-menu-item"
                    onClick={() => {
                      insertClipAfter(clipContextMenu.promptId);
                      setClipContextMenu(null);
                    }}
                    role="menuitem"
                    type="button"
                  >
	                    Insert 15s prompt after
                  </button>
                  <button
                    className="shot-context-menu-item"
                    onClick={() => {
                      addSubPromptTo(clipContextMenu.promptId);
                      setClipContextMenu(null);
                    }}
                    role="menuitem"
                    type="button"
                  >
                    Add sub-prompt
                    <span className="shot-context-menu-hint">
                      For a beat &gt; 15s — splits into chunks
                    </span>
                  </button>
                  <div className="shot-context-menu-divider" />
                  <button
                    className="shot-context-menu-item danger"
                    onClick={() => {
                      deleteClip(clipContextMenu.promptId);
                      setClipContextMenu(null);
                    }}
                    role="menuitem"
                    type="button"
                  >
	                    Delete prompt
                  </button>
                </PositionedContextMenu>
              ) : null}
              {scriptRailContextMenu ? (
                <PositionedContextMenu
                  ariaLabel="Script rail actions"
                  onClose={() => setScriptRailContextMenu(null)}
                  x={scriptRailContextMenu.x}
                  y={scriptRailContextMenu.y}
                  title="Script"
                >
                  <button
                    className="shot-context-menu-item"
                    onClick={() => {
                      setScriptSubrailHiddenFromMenu(!scriptSubrailHidden);
                      setScriptRailContextMenu(null);
                    }}
                    role="menuitem"
                    type="button"
                  >
                    {scriptSubrailHidden ? "Show sub-rail" : "Hide sub-rail"}
                    <span className="shot-context-menu-hint">
                      {scriptSubrailHidden ? "Restore icons" : "Keep files"}
                    </span>
                  </button>
                </PositionedContextMenu>
              ) : null}
              {customSubsectionRailMenu ? (
                <PositionedContextMenu
                  ariaLabel="Subsection actions"
                  onClose={() => setCustomSubsectionRailMenu(null)}
                  x={customSubsectionRailMenu.x}
                  y={customSubsectionRailMenu.y}
                  title={customSubsectionRailMenu.name}
                >
                  <button
                    className="shot-context-menu-item"
                    onClick={() => {
                      commitRemoveSubsectionFromRail({
                        id: customSubsectionRailMenu.id,
                        name: customSubsectionRailMenu.name,
                      });
                      setCustomSubsectionRailMenu(null);
                    }}
                    role="menuitem"
                    type="button"
                  >
                    Remove from rail
                    <span className="shot-context-menu-hint">Keep files</span>
                  </button>
                  <div className="shot-context-menu-divider" />
                  <button
                    className="shot-context-menu-item"
                    onClick={() => {
                      setInlineRename({
                        kind: "subsection",
                        id: customSubsectionRailMenu.id,
                        draft: customSubsectionRailMenu.name,
                      });
                      setCustomSubsectionRailMenu(null);
                    }}
                    role="menuitem"
                    type="button"
                  >
                    Rename
                  </button>
                  <div className="shot-context-menu-divider" />
                  <button
                    className="shot-context-menu-item danger"
                    onClick={() => {
                      void commitDeleteSubsection({
                        id: customSubsectionRailMenu.id,
                        name: customSubsectionRailMenu.name,
                        folder: customSubsectionRailMenu.folder,
                      });
                      setCustomSubsectionRailMenu(null);
                    }}
                    role="menuitem"
                    type="button"
                  >
                    Delete subsection
                    <span className="shot-context-menu-hint">Deletes folder</span>
                  </button>
                </PositionedContextMenu>
              ) : null}
              </>
            ) : (
              <div className={`item-list${activeSection === "story" ? " item-list-grouped" : ""}`}>
                {activeSection === "story" ? (
                  <>
	                    {/*
	                      Context sidebar is intentionally small:
	                      Project/canon markdown first. Internal agent/source
	                      summaries are hidden unless a developer flag exposes
	                      them for audit.
	                    */}
	                    {(() => {
	                      const storyDocs = (filteredActiveItems as StoryEntry[]).filter(
	                        (item) => !HIDDEN_LEGACY_CONTEXT_DOCS.has(normalizeReadOnlyPath(item.path).toLowerCase()),
	                      );
	                      const projectDocs = storyDocs.filter((item) => contextDocGroup(item) === "project");
	                      const canonDocs = storyDocs.filter((item) => contextDocGroup(item) === "canon");
	                      const assetContextDocs = storyDocs.filter((item) => contextDocGroup(item) === "asset");
	                      const showAssetContextSection = true;
                      const customGroupBuckets = new Map<string, StoryEntry[]>();
                      for (const item of storyDocs) {
                        const group = contextDocGroup(item);
                        if (isBuiltInContextGroup(group)) continue;
                        const bucket = customGroupBuckets.get(group) || [];
                        bucket.push(item);
                        customGroupBuckets.set(group, bucket);
                      }
                      const customGroupSections = [...customGroupBuckets.entries()].sort(([a], [b]) =>
                        a.localeCompare(b),
                      );
	                      const toggleGroup = (key: string) => {
                        setCollapsedContextGroups((current) => ({
                          ...current,
                          [key]: !current[key],
                        }));
                      };
                      const groupLabel = (key: string, text: string) => {
                        const collapsed = Boolean(collapsedContextGroups[key]);
                        return (
                          <button
                            type="button"
                            className={`item-list-group-label item-list-group-toggle${collapsed ? " collapsed" : ""}`}
                            onClick={() => toggleGroup(key)}
                            aria-expanded={!collapsed}
                            title={collapsed ? "Expand" : "Collapse"}
                          >
                            <span className="item-list-group-chevron" aria-hidden="true">▾</span>
                            <span>{text}</span>
                          </button>
                        );
                      };
	                      const isCollapsed = (key: string) => Boolean(collapsedContextGroups[key]);
	                      const renderContextDocRow = (item: StoryEntry) => {
	                        const storyDescriptor = describeContextDoc(item);
	                        return (
	                          <button
	                            key={item.id}
	                            className={[
	                              "item-row",
	                              "context-doc-row",
	                              `context-doc-row-${storyDescriptor.accent}`,
	                              !assetContextSelected && !assetLibrarySelected && !agentNoteSelected && !projectContextSelected && !pinboardSelected && !sectionFormatSelected && selectedItem?.id === item.id ? "active" : "",
	                              isItemTouched(item as { path?: string; id?: string }) ? "touched" : "",
	                            ].filter(Boolean).join(" ")}
	                            onClick={() => {
	                              setProjectContextSelected(false);
	                              setAgentNoteSelected(false);
	                              setAssetContextSelected(false);
	                              setAssetLibrarySelected(false);
	                              setPinboardSelected(false);
	                              setSectionFormatSelected(null);
	                              setSelectedMagicDocId(null);
	                              setSelectedIds((current) => ({ ...current, story: item.id }));
	                            }}
	                            title={item.path}
	                            type="button"
	                          >
	                            <span className={`context-doc-dot tone-${storyDescriptor.accent}`} />
	                            <span className="item-row-label">{getEntryLabel("story", item)}</span>
	                          </button>
	                        );
	                      };
	                      const renderAssetContextGuideRow = () => (
	                        <button
	                          className={[
	                            "item-row",
	                            "context-doc-row",
	                            "context-doc-row-custom",
	                            assetContextSelected ? "active" : "",
	                            isItemTouched({ path: assetContextGuide?.path || ".forge/asset-context/guide.md" }) ? "touched" : "",
	                          ].filter(Boolean).join(" ")}
	                          onClick={() => {
	                            setProjectContextSelected(false);
	                            setAgentNoteSelected(false);
	                            setAssetLibrarySelected(false);
	                            setPinboardSelected(false);
	                            setSectionFormatSelected(null);
	                            setSelectedMagicDocId(null);
	                            setAssetContextSelected(true);
	                          }}
	                          title={assetContextGuide?.path || ".forge/asset-context/guide.md"}
	                          type="button"
	                        >
	                          <span className="context-doc-dot tone-custom" />
	                          <span className="item-row-label">Asset context</span>
	                        </button>
	                      );
	                      const renderAssetLibraryRow = () => (
	                        <button
	                          className={[
	                            "item-row",
	                            "context-doc-row",
	                            "context-doc-row-custom",
	                            assetLibrarySelected ? "active" : "",
	                          ].filter(Boolean).join(" ")}
	                          onClick={() => {
	                            setProjectContextSelected(false);
	                            setAgentNoteSelected(false);
	                            setAssetContextSelected(false);
	                            setPinboardSelected(false);
	                            setSectionFormatSelected(null);
	                            setSelectedMagicDocId(null);
	                            setAssetLibrarySelected(true);
	                          }}
	                          title="Combined character, location, prop, keyframe, and audio inventory"
	                          type="button"
	                        >
	                          <span className="context-doc-dot tone-custom" />
	                          <span className="item-row-label">Asset library</span>
	                        </button>
	                      );
	                      const renderAgentNoteRow = () => (
	                        <button
                          className={[
                            "item-row",
                            "context-doc-row",
                            "context-doc-row-custom",
                            agentNoteSelected ? "active" : "",
                            isItemTouched({ path: AGENT_NOTE_PATH }) ? "touched" : "",
                          ].filter(Boolean).join(" ")}
	                          onClick={() => {
	                            setProjectContextSelected(false);
	                            setAssetContextSelected(false);
	                            setAssetLibrarySelected(false);
	                            setPinboardSelected(false);
	                            setSectionFormatSelected(null);
	                            setSelectedMagicDocId(null);
	                            setAgentNoteSelected(true);
	                          }}
                          title={AGENT_NOTE_PURPOSE}
                          type="button"
                        >
                          <span className="context-doc-dot tone-custom" />
                          <span className="item-row-label">{AGENT_NOTE_LABEL}</span>
                        </button>
                      );
                      return (
                        <>
                          <div className="item-list-section">
                            {groupLabel("project", "Project context")}
                            {!isCollapsed("project") ? (
                              projectDocs.length ? (
                                projectDocs.map(renderContextDocRow)
                              ) : (
                                <div className="item-list-empty">No project scope yet.</div>
                              )
                            ) : null}
                          </div>
                          <div className="item-list-section">
                            {groupLabel("canon", "Canon context")}
                            {!isCollapsed("canon") ? (
                              canonDocs.length ? (
                                canonDocs.map(renderContextDocRow)
                              ) : (
                                <div className="item-list-empty">No canon context yet.</div>
                              )
	                            ) : null}
	                          </div>
		                          {showAssetContextSection ? (
		                            <div className="item-list-section item-list-asset-context">
		                              {groupLabel("asset", "Asset context")}
		                              {!isCollapsed("asset") ? (
		                                <>
		                                  {renderAssetContextGuideRow()}
		                                  {renderAssetLibraryRow()}
		                                  {assetContextDocs.map(renderContextDocRow)}
		                                </>
		                              ) : null}
		                            </div>
		                          ) : null}
                          {customGroupSections.map(([group, docs]) => {
                            const groupKey = `custom-${group}`;
                            return (
                              <div key={groupKey} className="item-list-section item-list-custom-context">
                                {groupLabel(groupKey, contextGroupDisplayLabel(group))}
                                {!isCollapsed(groupKey) ? docs.map(renderContextDocRow) : null}
                              </div>
                            );
                          })}
	                          {SHOW_INTERNAL_CONTEXT_SURFACES ? (
	                            <div className="item-list-section">
	                              {groupLabel("agent-docs", "Agent context")}
	                              {!isCollapsed("agent-docs") ? (
		                                <>
		                                  {renderAgentNoteRow()}
		                                </>
	                              ) : null}
	                            </div>
	                          ) : null}
                          {SHOW_AGENT_SURFACE ? (
                            <div className="item-list-section item-list-agent-context">
                              {groupLabel("agent", "Memory & rules")}
                              {!isCollapsed("agent") ? (
                                <>
                                  <button
                                    className={[
                                      "item-row",
                                      pinboardSelected ? "active" : "",
                                    ].filter(Boolean).join(" ")}
	                                    onClick={() => {
	                                      setPinboardSelected(true);
	                                      setProjectContextSelected(false);
	                                      setAgentNoteSelected(false);
	                                      setAssetContextSelected(false);
	                                      setAssetLibrarySelected(false);
	                                      setSectionFormatSelected(null);
	                                      setSelectedMagicDocId(null);
	                                    }}
                                    type="button"
                                  >
                                    <span className="item-row-glyph" aria-hidden="true">{"\uD83D\uDCCC"}</span>
                                    <span className="item-row-label">Pinboard</span>
                                    <span className="item-row-badge">{pinboard.length}</span>
                                  </button>
                                </>
                              ) : null}
                            </div>
                          ) : null}
                        </>
                      );
                    })()}
                  </>
			          ) : activeSection === "videos" ? (
                  (() => {
                    const query = deferredAssetGridQuery.trim().toLowerCase();
                    const visibleVideos = query
                      ? videoBinItems.filter((video) => {
                          const basename = video.path.split("/").pop() || "";
                          return [
                            video.note,
                            video.path,
                            basename,
                            video.generator || "",
                          ].some((value) => String(value || "").toLowerCase().includes(query));
                        })
                      : videoBinItems;
                    const selectVideoNode = (id: string) => {
                      setProjectContextSelected(false);
                      setPinboardSelected(false);
                      setSectionFormatSelected(null);
                      setSelectedMagicDocId(null);
                      videoBinAutoplayVideoIdRef.current = id;
                      setSelectedIds((c) => ({ ...c, videos: id }));
                    };

                    return (
                      <div className="asset-grid video-bin-asset-grid">
                        {visibleVideos.length ? (
                          visibleVideos.map((video, index) => {
                            const basename = video.path.split("/").pop() || "video";
                            const label = String(video.note || "").trim() || basename;
                            const durationLabel =
                              typeof video.durationSec === "number" && Number.isFinite(video.durationSec) && video.durationSec > 0
                                ? `${Math.round(video.durationSec)}s`
                                : "";
                            const videoSrc = handle?.projectDir
                              ? indexMediaSrc(handle.projectDir, video.path, mediaRefreshKey)
                              : "";
                            const isActive = selectedVideo?.id === video.id;
                            return (
                              <div
                                key={video.id}
                                className={[
                                  "asset-tile",
                                  "asset-tile-video-bin",
                                  isActive ? "active" : "",
                                ].filter(Boolean).join(" ")}
                              >
                                <button
                                  className="asset-tile-trigger"
                                  type="button"
                                  aria-pressed={isActive}
                                  aria-label={`Preview ${label}`}
                                  title={`${label} · ${video.path}`}
                                  onClick={() => selectVideoNode(video.id)}
                                >
                                  <span className="asset-tile-media asset-tile-video-media">
                                    {videoSrc ? (
                                      <video
                                        className="asset-tile-video-thumb"
                                        src={videoSrc}
                                        preload="metadata"
                                        muted
                                        playsInline
                                      />
                                    ) : (
                                      <span className="asset-tile-glyph"><VideoCameraIcon /></span>
                                    )}
                                    {/* corner mirror-icon badge removed per UX feedback */}
                                  </span>
                                  <span className="asset-tile-label-row">
                                    <span className="asset-tile-order">{index + 1}</span>
                                    <span className="asset-tile-label">{label}</span>
                                  </span>
                                  <span className="asset-tile-video-meta">
                                    {durationLabel || basename}
                                  </span>
                                </button>
                              </div>
                            );
                          })
                        ) : (
                          <div className="item-list-empty">
                            {assetGridQuery ? `No videos match "${assetGridQuery}".` : "No videos yet."}
                          </div>
                        )}
                      </div>
                    );
                  })()
                ) : activeSection === "timeline" ? (
                  <div className="item-list-empty">
                    Open the timeline in the main pane.
                  </div>
                ) : filteredActiveItems.length ? (
                  filteredActiveItems.map((item) => {
                    const storyDescriptor = null;
                    return (
                      <button
                        key={item.id}
                        className={[
                          "item-row",
                          !projectContextSelected && !pinboardSelected && !sectionFormatSelected && selectedItem?.id === item.id ? "active" : "",
                          isItemTouched(item as { path?: string; id?: string }) ? "touched" : "",
                        ].filter(Boolean).join(" ")}
                        onClick={() => {
                          setProjectContextSelected(false);
                          setPinboardSelected(false);
                          setSectionFormatSelected(null);
                          setSelectedMagicDocId(null);
                          setSelectedIds((current) => ({ ...current, [activeSection]: item.id }));
                        }}
                      >
                        {storyDescriptor ? <span className={`context-doc-dot`} /> : null}
                        <span>{getEntryLabel(activeSection, item)}</span>
                      </button>
                    );
                  })
                ) : (
                  <div className="item-list-empty">
                    {`No ${(SECTION_LABELS[activeSection] || "items").toLowerCase()} yet.`}
                  </div>
                )}
              </div>
            )}
          </div>
        </aside>

        {libraryPanelOpen && selectedAsset && activeSection !== "media" && handle ? (() => {
          const allMediaCount = Object.keys(mediaIndex).length;
          // File-drop handler for the panel body. Extracts absolute
          // paths from the native drop event (Electron augments File
          // with `.path`) and hands them to forge:drop-library-files,
          // which copies into assets/library/ + rebuilds the media
          // index. The panel stays open post-drop so the newly-added
          // files appear in the grid immediately.
          const onPanelDragOver = (event: React.DragEvent) => {
            if (!event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            if (!libraryDragOver) setLibraryDragOver(true);
          };
          const onPanelDragLeave = (event: React.DragEvent) => {
            // dragleave fires when moving over child elements; only
            // reset when leaving the panel root entirely.
            if (event.currentTarget === event.target) setLibraryDragOver(false);
          };
          const onPanelDrop = async (event: React.DragEvent) => {
            event.preventDefault();
            setLibraryDragOver(false);
            if (!handle) return;
            const files = event.dataTransfer.files;
            if (!files.length) return;
            const paths: string[] = [];
            for (let i = 0; i < files.length; i++) {
              const p = (files[i] as unknown as { path?: string }).path;
              if (p) paths.push(p);
            }
            if (!paths.length) return;
            try {
              const result = await window.forgeDesktop.dropLibraryFiles(handle.projectDir, paths);
              if (result.length) {
                setNotice(`${result.length} file${result.length === 1 ? "" : "s"} added to library.`);
                await refreshCurrentProject();
              }
            } catch (dropError) {
              setNotice(dropError instanceof Error ? dropError.message : "File drop failed.", "error");
            }
          };
          return (
            <aside
              className={`library-panel${libraryDragOver ? " drag-over" : ""}`}
              aria-label="Media library panel"
              onDragOver={onPanelDragOver}
              onDragLeave={onPanelDragLeave}
              onDrop={(e) => void onPanelDrop(e)}
            >
              <div className="library-panel-head">
                <div className="library-panel-title">
                  <span className="library-panel-title-label">Library</span>
                  <span className="library-panel-count">{libraryPanelRecords.length} / {allMediaCount}</span>
                </div>
                <button
                  type="button"
                  className="library-panel-close"
                  onClick={() => setLibraryPanelOpen(false)}
                  aria-label="Close library panel"
                  title="Close library panel"
                >
                  ×
                </button>
              </div>
              <div className="library-panel-target">
                Attaching to <strong>{selectedAsset.name || selectedAsset.title || "asset"}</strong>
              </div>
              <div className="library-panel-controls">
                <input
                  className="library-panel-search"
                  type="search"
                  name="media-library-search"
                  autoComplete="off"
                  placeholder="Filter by filename…"
                  value={libraryPanelQuery}
                  onChange={(e) => setLibraryPanelQuery(e.target.value)}
                  aria-label="Search media library"
                />
                <div
                  className="library-panel-filters"
                  role="tablist"
                  aria-label="Filter by media kind"
                  onKeyDown={(event) => {
                    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                    event.preventDefault();
                    const order = ["all", "image", "audio"] as const;
                    const idx = order.indexOf(libraryPanelFilter);
                    const next = event.key === "ArrowRight"
                      ? order[(idx + 1) % order.length]
                      : order[(idx - 1 + order.length) % order.length];
                    setLibraryPanelFilter(next);
                  }}
                >
                  {(["all", "image", "audio"] as const).map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      role="tab"
                      aria-selected={libraryPanelFilter === kind}
                      tabIndex={libraryPanelFilter === kind ? 0 : -1}
                      className={`library-panel-filter${libraryPanelFilter === kind ? " active" : ""}`}
                      onClick={() => setLibraryPanelFilter(kind)}
                    >
                      {kind === "all" ? "All" : kind === "image" ? "Images" : "Audio"}
                    </button>
                  ))}
                </div>
              </div>
              <div className="library-panel-hint">
                Drop files or click a card to attach
              </div>
              {libraryPanelRecords.length ? (
                <div className="library-panel-grid">
                  {libraryPanelRecords.map((record) => {
                    const basename = record.path.split("/").pop() || record.path;
                    const isAttached = libraryPanelAttachedPaths.has(record.path);
                    const isImage = record.kind === "image";
                    return (
                      <button
                        key={record.id}
                        type="button"
                        className={`library-panel-card${isAttached ? " attached" : ""}`}
                        onClick={() => {
                          if (isAttached || attachBusy) return;
                          void attachLibraryMediaToSelectedAsset(record.id);
                        }}
                        disabled={isAttached || attachBusy}
                        title={isAttached ? "Already attached to this asset" : `Attach ${basename}`}
                        draggable={!isAttached}
                        onDragStart={(e) => {
                          e.dataTransfer.setData("application/x-anvil-media-id", record.id);
                          e.dataTransfer.setData("text/plain", basename);
                          e.dataTransfer.effectAllowed = "link";
                        }}
                      >
                        {isImage ? (
                          <img
                            className="library-panel-thumb"
                            src={indexMediaSrc(handle.projectDir, record.path, mediaRefreshKey)}
                            alt={basename}
                            loading="lazy"
                          />
                        ) : (
                          <div className="library-panel-thumb library-panel-thumb-glyph">
                            {record.kind === "audio" ? <AudioWaveIcon /> : <MediaFileIcon />}
                          </div>
                        )}
                        <div className="library-panel-name" title={basename}>{basename}</div>
                        {isAttached ? <div className="library-panel-attached">Attached</div> : null}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="library-panel-empty">
                  {deferredLibraryPanelQuery.trim() || libraryPanelFilter !== "all"
                    ? "No matches."
                    : "No media yet. Drop files here."}
                </div>
              )}
            </aside>
          );
        })() : null}

        {libraryPanelOpen && selectedAsset && activeSection !== "media" ? (
          <div
            className={`col-divider col-divider-library${draggingDivider === "library" ? " active" : ""}`}
            style={{ left: `${railWidth + libraryPanelWidth - 3}px` }}
            onMouseDown={(e) => startDividerDrag("library", e)}
            role="separator"
            aria-label="Resize media library panel"
            aria-orientation="vertical"
            title="Drag to resize"
          >
            <span className="col-divider-grip" aria-hidden="true" />
          </div>
        ) : null}

        {/* Draggable divider between left-rail and editor. Hidden ONLY
            on Workshop (where the rail is locked to 66px icons-only and
            the editor needs every spare pixel). For every other primary
            — including Context, Canon, and Assets — the rail's items
            column benefits from being resizable, even if the subrail
            track itself is collapsed. */}
        {activeSection !== "workshop" ? (
          <div
            className={`col-divider col-divider-rail${draggingDivider === "rail" ? " active" : ""}`}
            style={{ left: `${railWidth - 3}px` }}
            onMouseDown={(e) => startDividerDrag("rail", e)}
            role="separator"
            aria-label="Resize left rail"
            aria-orientation="vertical"
            title="Drag to resize"
          >
            <span className="col-divider-grip" aria-hidden="true" />
          </div>
        ) : null}

        {activePrimary === "assets" && activeSection === "media" && inboxView ? (
          <main className="editor-pane editor-pane-inbox">
            {inboxPreview ? (() => {
              const file = inboxPreview;
              const busy = inboxBusy === file.relPath;
              const sizeLabel = file.size >= 1024 * 1024
                ? `${(file.size / (1024 * 1024)).toFixed(1)} MB`
                : file.size >= 1024
                  ? `${(file.size / 1024).toFixed(0)} KB`
                  : `${file.size} B`;
              return (
                <>
                  <div className="editor-head">
                    <div className="editor-head-title">
                      <h2 className="editor-title-empty" style={{ color: "#ffffff", fontWeight: 600 }}>
                        {file.name}
                      </h2>
                      <div className="editor-path" title={file.relPath}>
                        {file.relPath} · {file.kind} · {sizeLabel}
                      </div>
                    </div>
                  </div>
                  <div className="editor-body editor-body-inbox">
                    <div className="inbox-editor-media">
                      {file.kind === "image" ? (
                        <img src={file.fileUrl} alt={file.name} className="inbox-editor-image" />
                      ) : file.kind === "video" ? (
                        <video src={file.fileUrl} controls className="inbox-editor-video" />
                      ) : file.kind === "audio" ? (
                        <audio src={file.fileUrl} controls className="inbox-editor-audio" />
                      ) : (
                        <div className="inbox-preview-placeholder">
                          Can't preview <code>{file.kind}</code> here. Use Reveal to open it in Finder.
                        </div>
                      )}
                    </div>
                    <div className="inbox-editor-actions">
                      <button
                        type="button"
                        className="primary-btn"
                        disabled={busy}
                        onClick={() => void moveInboxToLibrary(file)}
                      >
                        Restore to All media
                      </button>
                      <button
                        type="button"
                        className="ghost-btn compact"
                        disabled={busy}
                        onClick={() => void revealInboxFile(file)}
                      >
                        Reveal in Finder
                      </button>
                      <button
                        type="button"
                        className="ghost-btn compact danger-btn"
                        disabled={busy}
                        onClick={() => void deleteInboxFileNow(file)}
                      >
                        Delete permanently
                      </button>
                    </div>
                  </div>
                </>
              );
            })() : (
              <div className="editor-empty editor-empty-inbox">
                <h2 className="editor-title-empty" style={{ color: "#ffffff", fontWeight: 600 }}>Temporary trash</h2>
              </div>
            )}
          </main>
        ) : activeCustomSubsection ? (
          <main className="editor-pane editor-pane-custom-subsection">
            {activeCustomSubsection.kind === "docs" && customSubsectionDoc?.subsectionId === activeCustomSubsection.id ? (
              <>
                <div className="editor-head">
                  <div className="editor-head-title">
                    <input
                      className="editor-title-input"
                      name="custom-doc-title"
                      autoComplete="off"
                      aria-label="Markdown doc title"
                      value={customSubsectionDoc.title}
                      onChange={(event) => {
                        const value = event.target.value;
                        setCustomSubsectionDoc((prev) => (prev ? { ...prev, title: value } : prev));
                      }}
                      onBlur={() => void renameCustomSubsectionDocFromTitle()}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          event.currentTarget.blur();
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          setCustomSubsectionDoc((prev) =>
                            prev ? { ...prev, title: prev.savedTitle } : prev,
                          );
                          event.currentTarget.blur();
                        }
                      }}
                      placeholder="Untitled"
                      spellCheck={false}
                    />
                    <div className="editor-path" title={customSubsectionDoc.filePath}>
                      {customSubsectionDoc.filePath}
                    </div>
                  </div>
                  <div className="editor-head-actions custom-subsection-doc-head-actions">
                    <ReadOnlyToggle
                      project={project}
                      relativePath={customSubsectionDoc.filePath}
                      onToggle={(next) => {
                        if (!project) return;
                        queueSave(withTogglePathReadOnly(project, customSubsectionDoc.filePath, next));
                      }}
                    />
                  </div>
                </div>
                <div
                  className="custom-subsection-body custom-subsection-body-editor"
                  onKeyDownCapture={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                      event.preventDefault();
                      if (customSubsectionDoc.title.trim() !== customSubsectionDoc.savedTitle) {
                        void renameCustomSubsectionDocFromTitle();
                      } else {
                        void saveCustomSubsectionDoc();
                      }
                    }
                  }}
                >
                  <LazyMarkdownEditor
                    className="custom-subsection-doc-markdown cm-editor-host"
                    ariaLabel={`${customSubsectionDoc.savedTitle || "Markdown doc"} editor`}
                    value={customSubsectionDoc.text}
                    onChange={(value) => {
                      setCustomSubsectionDoc((prev) =>
                        prev && prev.subsectionId === activeCustomSubsection.id
                          ? { ...prev, text: value, dirty: value !== prev.savedText }
                          : prev,
                      );
                    }}
                    placeholder=""
                    spellCheck={false}
                  />
                </div>
              </>
            ) : activeCustomSubsection.kind === "docs" ? (
              <div className="custom-subsection-empty-editor">
                <input
                  key={activeCustomSubsection.id}
                  className="editor-title-input custom-subsection-title-input"
                  defaultValue={activeCustomSubsection.name}
                  placeholder="Untitled"
                  aria-label="Subsection title"
                  autoComplete="off"
                  spellCheck={false}
                  onBlur={(event) => {
                    const next = event.currentTarget.value.trim();
                    if (!project) return;
                    if (!next) {
                      event.currentTarget.value = activeCustomSubsection.name;
                      return;
                    }
                    if (next === activeCustomSubsection.name) return;
                    const subs = Array.isArray(project.customSubsections) ? project.customSubsections : [];
                    const updated = subs.map((sub) =>
                      sub.id === activeCustomSubsection.id
                        ? { ...sub, name: next, updatedAt: new Date().toISOString() }
                        : sub,
                    );
                    queueSave({ ...project, customSubsections: updated });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      event.currentTarget.blur();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      event.currentTarget.value = activeCustomSubsection.name;
                      event.currentTarget.blur();
                    }
                  }}
                />
              </div>
            ) : (
              <div className="custom-subsection-files custom-subsection-files-plain">
                {customSubsectionFiles?.id === activeCustomSubsection.id && customSubsectionFiles.files.length > 0 ? (
                  activeCustomSubsection.kind === "gallery" ? (
                    <div className="custom-subsection-files-grid">
                      {customSubsectionFiles.files.map((file) => (
                        <button
                          key={file.path}
                          type="button"
                          className="custom-subsection-file-tile"
                          onClick={() => {
                            if (!handle?.projectDir) return;
                            void window.forgeDesktop.revealPath(handle.projectDir, file.path);
                          }}
                          title={file.name}
                        >
                          <span className="custom-subsection-file-thumb">
                            {/\.(png|jpe?g|webp|gif|avif|svg)$/i.test(file.name) ? (
                              <img
                                src={indexMediaSrc(handle?.projectDir || "", file.path)}
                                alt=""
                                draggable={false}
                              />
                            ) : (
                              <span className="custom-subsection-file-glyph">▶</span>
                            )}
                          </span>
                          <span className="custom-subsection-file-name">{file.name}</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <ul className="custom-subsection-files-list">
                      {customSubsectionFiles.files.map((file) => (
                        <li key={file.path}>
                          <button
                            type="button"
                            className="custom-subsection-file-row"
                            onClick={() => {
                              if (!handle?.projectDir) return;
                              void window.forgeDesktop.revealPath(handle.projectDir, file.path);
                            }}
                            title={file.path}
                          >
                            <span className="custom-subsection-file-name">{file.name}</span>
                            <span className="custom-subsection-file-meta">
                              {(file.sizeBytes / 1024).toFixed(1)} KB · {file.ext.replace(/^\./, "") || "file"}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )
                ) : null}
              </div>
            )}
          </main>
        ) : (
        <main className="editor-pane">
          <div className="editor-head">
            <div className="editor-head-title">
	              {pinboardSelected ? (
	                <>{/* Pinboard title is rendered inside the panel below */}</>
	              ) : assetContextSelected ? (
	                <>
	                  <h2 className="editor-title-empty" style={{ color: "#ffffff", fontWeight: 600 }}>Asset Context</h2>
	                  <div className="editor-path" title={assetContextGuide?.path || ".forge/asset-context/guide.md"}>
	                    {assetContextGuide?.path || ".forge/asset-context/guide.md"}
	                  </div>
	                </>
	              ) : assetLibrarySelected ? (
	                <>
	                  <h2 className="editor-title-empty" style={{ color: "#ffffff", fontWeight: 600 }}>Asset Library</h2>
	                  <div className="editor-path" title="Live inventory from asset cards">
	                    Characters · Locations · Props · Keyframes · Audio
	                  </div>
	                </>
	              ) : projectContextSelected ? (
                <>
                  <div className="editor-title-row">
                    <h2 className="editor-title-empty" style={{ color: "#ffffff", fontWeight: 600 }}>Agent protocol</h2>
                    <ReadOnlyToggle
                      project={project}
                      relativePath="ANVIL.md"
                      onToggle={(next) => {
                        if (!project) return;
                        queueSave(withTogglePathReadOnly(project, "ANVIL.md", next));
                      }}
                    />
                  </div>
                  <div className="editor-path" title="ANVIL.md">ANVIL.md</div>
                </>
              ) : agentNoteSelected ? (
                <>
                  <div className="editor-title-row">
                    <h2 className="editor-title-empty" style={{ color: "#ffffff", fontWeight: 600 }}>{AGENT_NOTE_LABEL}</h2>
                    <ReadOnlyToggle
                      project={project}
                      relativePath={AGENT_NOTE_PATH}
                      onToggle={(next) => {
                        if (!project) return;
                        queueSave(withTogglePathReadOnly(project, AGENT_NOTE_PATH, next));
                      }}
                    />
                  </div>
                  <div className="editor-path" title={AGENT_NOTE_PATH}>{AGENT_NOTE_PATH}</div>
                </>
              ) : selectedMagicDoc ? (
                <>
                  <h2 className="editor-title-empty" style={{ color: "#ffffff", fontWeight: 600 }}>{selectedMagicDoc.name}</h2>
                  <div className="editor-path" title={selectedMagicDoc.path}>{selectedMagicDoc.path}</div>
                </>
              ) : sectionFormatSelected ? (
                <>
                  <h2 className="editor-title-empty" style={{ color: "#ffffff", fontWeight: 600 }}>{SECTION_FORMAT_LABELS[sectionFormatSelected].label}</h2>
                  <div className="editor-path">{SECTION_FORMAT_LABELS[sectionFormatSelected].pathHint}</div>
                </>
              ) : activeSection === "videos" ? (
                <>
                  <h2 className="editor-title-empty" style={{ color: "#ffffff", fontWeight: 600 }}>Video Bin</h2>
                  <div className="editor-path">Stored videos</div>
                </>
              ) : selectedItem ? (
                <div className="editor-title-row">
                  {activeSection === "script" && selectedSceneIdentifierLabel ? (
                    <span className="editor-title-index">{selectedSceneIdentifierLabel}</span>
                  ) : null}
                  <input
                    className="editor-title-input"
                    name="selected-item-title"
                    autoComplete="off"
                    aria-label="Selected item title"
                    value={titleDraft}
                    onFocus={() => setEditingField("title")}
                    onBlur={() => setEditingField(null)}
                    onChange={(event) => {
                      setTitleDraft(event.target.value);
                      patchSelectedMeta(
                        isAssetSection(activeSection)
                          ? { name: event.target.value, title: event.target.value }
                          : { title: event.target.value },
                      );
                    }}
                    placeholder="Untitled"
                    spellCheck={false}
                  />
                  {/* The story (context-docs) section already surfaces a
                      Read-only pill in the context-doc-helper card just
                      below the title row — rendering one here would
                      duplicate it. Other sections (script / shots /
                      prompts / assets) have no helper card, so they
                      need the inline pill. */}
                  {selectedItem.path && activeSection !== "story" && !isAssetSection(activeSection) ? (
                    <ReadOnlyToggle
                      project={project}
                      relativePath={selectedItem.path}
                      onToggle={(next) => {
                        if (!project) return;
                        queueSave(withTogglePathReadOnly(project, selectedItem.path, next));
                      }}
                    />
                  ) : null}
                </div>
              ) : (
                <h2 className="editor-title-empty">No {SECTION_LABELS[activeSection]} selected</h2>
              )}
              {!assetContextSelected && !projectContextSelected && !pinboardSelected && !selectedMagicDoc && activeSection !== "videos" && !isAssetSection(activeSection) && selectedItem?.path ? (
                <div className="editor-path" title={selectedItem.path}>{selectedItem.path}</div>
              ) : null}
              {isAssetSection(activeSection) && selectedAsset ? (
                <div className="editor-meta-row">
                  <span className="editor-meta-pill">
                    {selectedAssetMediaCount} {selectedAssetMediaCount === 1 ? "variant" : "variants"}
                  </span>
                  {activeSection === "media" ? (
                    <span className="editor-meta-pill">
                      {selectedAssetOwner?.section === "media"
                        ? "Library file"
                        : `Source: ${SECTION_LABELS[selectedAssetOwner?.section || "media"]}`}
                    </span>
                  ) : null}
                  {/* Concept-group indicator. Grouping stays in the tile
                      context menu; this primary action only adds media
                      to the selected asset. */}
                  {activeSection === "media" && selectedAssetOwner?.section && selectedAssetOwner.section !== "media" ? (
                    <button
                      type="button"
                      className="ghost-btn compact"
                      onClick={() => jumpToAsset(selectedAssetOwner.section, selectedAsset.id)}
                      title={`Open this asset in ${SECTION_LABELS[selectedAssetOwner.section]}`}
                    >
                      Open {SECTION_LABELS[selectedAssetOwner.section]}
                    </button>
                  ) : null}
                  {activeSection !== "media" ? (
                    <button
                      type="button"
                      className="ghost-btn compact"
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        setAddVariantMenu({
                          x: rect.left,
                          y: rect.bottom + 4,
                        });
                      }}
                      title="Add media to this asset"
                    >
                      + Add media
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="editor-head-actions">
              {/* HammerMenu retired — item-tailored actions now render as
                  a full-width bar below this row (see <ItemActionBar/> at
                  the end of the editor-head). HammerIcon itself stays
                  available in ./components/icons for future repurpose. */}
              {SHOW_AGENT_SURFACE ? (() => {
                // Skip the focus-lock button on views where there's
                // nothing meaningful to lock AND no lock is currently set:
                //   · asset-context magic docs — read-only inventory
                //   · section format — single-file config the agent
                //     doesn't proactively write to
                //   · media library items — raw files the agent
                //     doesn't modify
                // When a lock IS set, ALWAYS render the button in release-
                // only mode so the user can discover + release it (H2 from
                // the 2026-04-21 focus-lock audit).
	                const isAssetMagicDoc = selectedMagicDoc
	                  && (selectedMagicDoc.kind === "bible" || selectedMagicDoc.kind === "atlas");
	                const isAssetView = isAssetSection(activeSection);
	                const hideByContext = isAssetMagicDoc || assetLibrarySelected || sectionFormatSelected || isAssetView;
                const lockIsSet = focusScope.kind !== "none";

                const focusTargetPath = projectContextSelected
	                  ? "ANVIL.md"
	                  : assetContextSelected
	                    ? assetContextGuide?.path || ".forge/asset-context/guide.md"
	                  : assetLibrarySelected || isAssetView
	                    ? null
	                  : selectedMagicDoc
                    ? selectedMagicDoc.path
                  : selectedItem?.path || null;

                // Hide only if the view is non-lockable AND no lock is
                // currently active. If a lock is active but the view has
                // no target (empty selection, magic doc, etc.), keep the
                // button visible so release is still one click away.
                if (hideByContext && !lockIsSet) return null;
                if (!focusTargetPath && !lockIsSet) return null;

                // M4 — single source for lock-state class. Uses scope-
                // membership (not target identity) so navigating inside a
                // locked scene reads as "active", not "foreign" (H1 fix).
                const lockVisual = evaluateLockVisual(focusScope, focusTargetPath);
                const lockStateClass = !lockIsSet
                  ? "lock-open-state"
                  : `lock-${lockVisual}`;
                const lockLabel = fullLockLabel(focusScope);
                const lockTooltip = lockIsSet
                  ? `Focus lock: ${lockLabel || "active"}`
                  : "Lock agent scope";

                // M1 — promote parent-scope lock options when editing
                // under the parent. A prompt can lock to its parent scene.
                const selectedAsPrompt = (activeSection === "prompts" && selectedItem)
                  ? selectedItem as PromptEntry
                  : null;
                const selectedScene = (activeSection === "script" && selectedItem && "kind" in selectedItem && (selectedItem as ScriptEntry).kind === "scene")
                  ? selectedItem as ScriptEntry
                  : null;
                const parentSceneForPrompt = selectedAsPrompt
                  ? findSceneForPrompt(selectedAsPrompt, sceneEntries)
                  : dialogueContext.sceneId
                    ? sceneEntries.find((s) => s.id === dialogueContext.sceneId) || null
                  : null;

                // Helpers so each menu item's click matches the same
                // empty-path feedback (L7) without repeating four copies.
                const tryLockScene = (scene: ScriptEntry, viaParent = false) => {
                  if (!scene.path) {
                    setNotice(viaParent
                      ? "Cannot lock parent scene: path not yet saved. Edit the scene to trigger a save, then try again."
                      : "Cannot lock: scene has no path yet. Save first (make any edit) and retry.");
                    closeLockMenu();
                    return;
                  }
                  setFocusScope({ kind: "scene", sceneId: scene.id, scenePath: scene.path });
                  closeLockMenu();
                  setNotice("Locked to scene.");
                };
                const isCurrentFile = focusScope.kind === "file" && focusTargetPath
                  && focusScope.path === focusTargetPath;
                const isCurrentScene = focusScope.kind === "scene"
                  && ((selectedScene && focusScope.sceneId === selectedScene.id)
                    || (parentSceneForPrompt && focusScope.sceneId === parentSceneForPrompt.id));
                const isCurrentReadonly = focusScope.kind === "readonly";

                return (
                  <div className="lock-btn-wrapper" ref={lockMenuRef}>
                    <button
                      className={[
                        "ghost-btn",
                        "compact",
                        "icon-btn",
                        "icon-hover-tooltip",
                        "tooltip-bottom",
                        lockStateClass,
                      ].filter(Boolean).join(" ")}
                      onClick={() => setLockMenuOpen((prev) => !prev)}
                      data-tooltip={lockTooltip}
                      aria-label={lockIsSet ? `Focus lock — ${lockLabel || "active"}` : "Lock agent to this file"}
                      aria-pressed={lockIsSet}
                      type="button"
                    >
                      {lockIsSet ? <LockClosedIcon /> : <LockOpenIcon />}
                    </button>
                    {lockMenuOpen ? (
                      <div
                        className="lock-scope-dropdown"
                        role="menu"
                        aria-label="Focus lock scope"
                        onKeyDown={handleMenuNavigation}
                      >
                        {lockIsSet ? (
                          <>
                            <button
                              autoFocus
                              className="lock-scope-item lock-release"
                              role="menuitem"
                              onClick={() => {
                                setFocusScope({ kind: "none" });
                                closeLockMenu();
                                setNotice("Focus lock released.");
                              }}
                            >
                              Release lock
                            </button>
                            <div className="hammer-divider" />
                          </>
                        ) : null}
                        {focusTargetPath ? (
                          <button
                            className={`lock-scope-item${isCurrentFile ? " is-current" : ""}`}
                            role="menuitem"
                            aria-current={isCurrentFile ? "true" : undefined}
                            autoFocus={!lockIsSet}
                            onClick={() => {
                              setFocusScope({ kind: "file", path: focusTargetPath });
                              closeLockMenu();
                              setNotice(`Locked to file: ${focusTargetPath}`);
                            }}
                          >
                            {isCurrentFile ? "✓ " : ""}This file only
                          </button>
                        ) : null}
                        {selectedScene ? (
                          <button
                            className={`lock-scope-item${isCurrentScene ? " is-current" : ""}`}
                            role="menuitem"
                            aria-current={isCurrentScene ? "true" : undefined}
                            onClick={() => tryLockScene(selectedScene)}
                          >
	                            {isCurrentScene ? "✓ " : ""}Scene + prompts
                          </button>
                        ) : parentSceneForPrompt ? (
                          <button
                            className={`lock-scope-item${isCurrentScene ? " is-current" : ""}`}
                            role="menuitem"
                            aria-current={isCurrentScene ? "true" : undefined}
                            onClick={() => tryLockScene(parentSceneForPrompt, true)}
                          >
	                            {isCurrentScene ? "✓ " : ""}Parent scene + prompts
                          </button>
                        ) : null}
                        <div className="hammer-divider" />
                        <button
                          className={`lock-scope-item${isCurrentReadonly ? " is-current" : ""}`}
                          role="menuitem"
                          aria-current={isCurrentReadonly ? "true" : undefined}
                          onClick={() => {
                            setFocusScope({ kind: "readonly" });
                            closeLockMenu();
                            setNotice("Read-only mode on.");
                          }}
                        >
                          {isCurrentReadonly ? "✓ " : ""}Read-only (no writes)
                        </button>
                      </div>
                    ) : null}
                  </div>
                );
              })() : null}
              {/* FormatMenu lives inline with Continue on the ItemActionBar
                  below, not floating in the header. See ItemActionBar's
                  `trailing` slot. */}
	              {/* Magic-doc toolbar (Update / Regenerate) is only
	                  meaningful for docs that render a synthesized body.
	                  Legacy asset magic docs render live inventory instead,
	                  so none of the synthesis buttons affect their view. */}
              {selectedMagicDoc && selectedMagicDoc.kind !== "bible" && selectedMagicDoc.kind !== "atlas" ? (
                <>
                  <button
                    className="ghost-btn compact has-art-icon icon-hover-tooltip tooltip-bottom"
                    onClick={() => void syncSelectedMagicDoc(false)}
                    data-tooltip="Rebuild summary"
                    type="button"
                  >
                    <SyncIcon />
                    {busy === "magic-sync" ? "Updating…" : "Update"}
                  </button>
                  <button
                    className="ghost-btn compact icon-hover-tooltip tooltip-bottom"
                    onClick={() => {
                      if (selectedMagicDoc?.handEdited) {
                        const ok = window.confirm(
                          `"${selectedMagicDoc.name}" has hand-edited content. Regenerating will overwrite your changes permanently.\n\nContinue?`,
                        );
                        if (!ok) return;
                      }
                      void syncSelectedMagicDoc(true);
                    }}
                    data-tooltip={selectedMagicDoc?.handEdited
                      ? "Rebuild from scratch (asks before overwriting edits)"
                      : "Rebuild from scratch"}
                    type="button"
                  >
                    {busy === "magic-sync" ? "Updating…" : "Regenerate"}
                  </button>
                </>
              ) : null}
              {isAssetSection(activeSection) && selectedItem ? (
                <button
                  className="ghost-btn compact icon-btn danger-btn icon-hover-tooltip tooltip-bottom"
                  onClick={() => requestAssetDelete(activeSection, selectedItem as AssetEntry)}
                  data-tooltip={
                    busy === "delete"
                      ? "Deleting…"
                      : activeSection === "media" && selectedAssetOwner?.section && selectedAssetOwner.section !== "media"
                        ? `Delete from ${SECTION_LABELS[selectedAssetOwner.section]}`
                        : "Delete this entry"
                  }
                  aria-label="Delete this asset"
                  type="button"
                  disabled={busy === "delete"}
                >
                  <TrashIcon />
                </button>
              ) : null}
              {sectionFormatSelected ? (
                <button
                  className="ghost-btn compact"
                  type="button"
                  onClick={async () => {
                    if (!handle?.projectDir || !sectionFormatSelected) return;
                    try {
                      const fresh = await window.forgeDesktop.resetSectionConvention(
                        handle.projectDir,
                        sectionFormatSelected,
                      );
                      setSectionFormatDraft((current) => ({ ...current, [sectionFormatSelected]: fresh || "" }));
                      setNotice(`Reset ${SECTION_FORMAT_LABELS[sectionFormatSelected].label} to defaults.`);
                    } catch (resetError) {
                      setError(resetError instanceof Error ? resetError.message : "Reset failed.");
                    }
                  }}
                  title="Reset to defaults"
                >
                  Reset
                </button>
              ) : null}
              {SHOW_PROJECT_TERMINAL_SURFACE && chatCollapsed ? (
                <button
                  className="ghost-btn compact icon-btn"
                  onClick={() => setChatCollapsed(false)}
                  title="Show terminal"
                  aria-label="Show terminal"
                  type="button"
                >
                  <ShowChatIcon />
                </button>
              ) : null}
            </div>
          </div>

          {/* Item-tailored action bar — replaces the old HammerMenu dropdown.
              Hidden when nothing's selected; otherwise renders up to three
              pills (primary first, check second) with overflow into a ⋯ menu. */}
          {SHOW_AGENT_SURFACE ? (
            <ItemActionBar
              activeSection={activeSection}
              activePrimary={activePrimary}
	              selectedItem={selectedItem}
	              projectContextSelected={projectContextSelected}
	              sectionFormatSelected={sectionFormatSelected}
	              selectedMagicDoc={Boolean(selectedMagicDoc) || assetContextSelected || assetLibrarySelected || agentNoteSelected}
              pinboardSelected={pinboardSelected}
              focusScope={focusScope}
              sending={sending}
              onSend={sendAgentMessage}
	              trailing={
	                (activeSection === "script" || activeSection === "prompts") && !assetContextSelected && !assetLibrarySelected && !agentNoteSelected && !selectedMagicDoc && !sectionFormatSelected
	                  ? (
	                    <FormatMenu
	                      onSelect={(kind) => {
	                        setSectionFormatSelected(kind);
	                        setPinboardSelected(false);
	                        setProjectContextSelected(false);
	                        setAssetContextSelected(false);
	                        setAssetLibrarySelected(false);
	                        setSelectedMagicDocId(null);
	                      }}
                    />
                  )
                  : null
              }
            />
          ) : null}

	          {pinboardSelected ? (() => {
	            const visibleEntries = pinboard
              .filter((e) => pinboardFilter === "all" || e.category === pinboardFilter)
              .sort((a, b) => {
                // Pending entries first (they need user action), then newest first.
                if (a.confirmed !== b.confirmed) return a.confirmed ? 1 : -1;
                return b.createdAt.localeCompare(a.createdAt);
              });
            const persist = (next: PinboardEntry[]) => {
              setPinboard(next);
              void window.forgeDesktop.updatePinboard(handle!.projectDir, next);
            };
            const confirmEntry = (id: string) => {
              persist(pinboard.map((e) =>
                e.id === id ? { ...e, confirmed: true, updatedAt: new Date().toISOString() } : e,
              ));
            };
            const removeEntry = (id: string) => {
              persist(pinboard.filter((e) => e.id !== id));
              if (focusedPinboardId === id) {
                // Move focus to the next entry in the visible list, if any.
                const idx = visibleEntries.findIndex((e) => e.id === id);
                const next = visibleEntries[idx + 1] || visibleEntries[idx - 1] || null;
                setFocusedPinboardId(next?.id || null);
              }
            };
            const startEditPin = (entry: PinboardEntry) => {
              setEditingPinId(entry.id);
              setEditingPinDraft(entry.text);
            };
            const cancelEditPin = () => {
              setEditingPinId(null);
              setEditingPinDraft("");
            };
            const commitEditPin = (id: string) => {
              const trimmed = editingPinDraft.trim();
              if (!trimmed) {
                cancelEditPin();
                return;
              }
              persist(pinboard.map((e) =>
                e.id === id
                  ? { ...e, text: trimmed, updatedAt: new Date().toISOString(), confirmed: true }
                  : e,
              ));
              cancelEditPin();
            };
            const openNewPin = () => {
              setNewPinDraft({ category: "preference", text: "" });
            };
            const cancelNewPin = () => {
              setNewPinDraft(null);
            };
            const saveNewPin = () => {
              const draft = newPinDraft;
              const trimmed = draft?.text.trim() || "";
              if (!draft || !trimmed) {
                cancelNewPin();
                return;
              }
              const now = new Date().toISOString();
              const entry: PinboardEntry = {
                id: crypto.randomUUID(),
                text: trimmed,
                category: draft.category,
                scope: "project",
                createdAt: now,
                updatedAt: now,
                confirmed: true,
                source: { kind: "manual" },
              };
              persist([...pinboard, entry]);
              cancelNewPin();
            };
            // Keyboard-driven triage: J/K or ArrowDown/Up to move, Enter to
            // confirm a pending entry, D to dismiss a pending entry, Delete
            // (or Backspace) to remove a confirmed entry.
            const onPanelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
              if (event.metaKey || event.ctrlKey || event.altKey) return;
              // If focus is inside an input/textarea/contentEditable nested
              // within the panel (e.g., a future inline-rename field), let
              // the field handle keys — don't swallow J/K/D/Del for nav.
              const target = event.target as HTMLElement | null;
              if (target && (
                target.tagName === "INPUT"
                || target.tagName === "TEXTAREA"
                || target.isContentEditable
              )) {
                return;
              }
              const key = event.key;
              if (visibleEntries.length === 0) return;
              const currentIdx = focusedPinboardId
                ? visibleEntries.findIndex((e) => e.id === focusedPinboardId)
                : -1;
              const activate = (idx: number) => {
                const clamped = Math.max(0, Math.min(visibleEntries.length - 1, idx));
                setFocusedPinboardId(visibleEntries[clamped].id);
                event.preventDefault();
              };
              if (key === "j" || key === "ArrowDown") {
                activate(currentIdx < 0 ? 0 : currentIdx + 1);
                return;
              }
              if (key === "k" || key === "ArrowUp") {
                activate(currentIdx < 0 ? 0 : currentIdx - 1);
                return;
              }
              if (currentIdx < 0) return;
              const focused = visibleEntries[currentIdx];
              if (!focused) return;
              if (key === "Enter" && !focused.confirmed) {
                confirmEntry(focused.id);
                event.preventDefault();
                return;
              }
              if ((key === "d" || key === "Delete" || key === "Backspace") && !focused.confirmed) {
                removeEntry(focused.id);
                event.preventDefault();
                return;
              }
              if ((key === "Delete" || key === "Backspace") && focused.confirmed) {
                removeEntry(focused.id);
                event.preventDefault();
              }
            };
            const pendingCount = pinboard.filter((e) => !e.confirmed).length;
            return (
              <div
                ref={pinboardPanelRef}
                className="pinboard-panel"
                tabIndex={0}
                onKeyDown={onPanelKeyDown}
                aria-label="Pinboard — J/K to navigate, Enter to confirm pending, D or Delete to remove"
              >
                <div className="context-doc-helper tone-custom">
                  <div className="context-doc-helper-head">
                    <div>
                      <div className="context-doc-helper-title">Pinboard</div>
                      <div className="context-doc-helper-purpose">
                        Confirmed notes.
                      </div>
                    </div>
                    <div className="context-doc-helper-actions">
                      {pendingCount > 0 ? (
                        <span className="pinboard-pending-count">{pendingCount} pending</span>
                      ) : null}
                      <span className="pinboard-budget">
                        {pinboard.filter((e) => e.confirmed).reduce((sum, e) => sum + e.text.length, 0)} / 2000
                      </span>
                      <button
                        className="pinboard-new-btn"
                        onClick={openNewPin}
                        type="button"
                        title="Add pin"
                        disabled={newPinDraft !== null}
                      >
                        + New pin
                      </button>
                    </div>
                  </div>
                </div>
                <div className="pinboard-nav-hint">
                  <kbd>J</kbd>/<kbd>K</kbd> move · <kbd>↵</kbd> confirm · <kbd>D</kbd> remove
                </div>
                <div className="pinboard-filters">
                  {(["all", "preference", "fact", "constraint", "decision", "naming", "workflow"] as const)
                    .map((cat) => ({
                      cat,
                      count: cat === "all" ? pinboard.length : pinboard.filter((e) => e.category === cat).length,
                    }))
                    .filter((entry) =>
                      entry.cat === "all" || entry.count > 0 || pinboardFilter === entry.cat,
                    )
                    .map(({ cat, count }) => (
                      <button
                        key={cat}
                        className={`pinboard-filter-chip${pinboardFilter === cat ? " active" : ""}`}
                        onClick={() => setPinboardFilter(cat)}
                        type="button"
                      >
                        {cat === "all" ? "All" : cat.charAt(0).toUpperCase() + cat.slice(1)}
                        <span className="pinboard-filter-count">{count}</span>
                      </button>
                    ))}
                </div>
                <div className="pinboard-list">
                  {newPinDraft ? (
                    <div className="pinboard-entry pinboard-new-draft">
                      <div className="pinboard-entry-head">
                        <select
                          className="pinboard-new-cat"
                          name="pinboard-category"
                          autoComplete="off"
                          aria-label="Memory category"
                          value={newPinDraft.category}
                          onChange={(e) =>
                            setNewPinDraft({ ...newPinDraft, category: e.target.value as PinboardEntry["category"] })
                          }
                          onClick={(e) => e.stopPropagation()}
                        >
                          <option value="preference">preference</option>
                          <option value="fact">fact</option>
                          <option value="constraint">constraint</option>
                          <option value="naming">naming</option>
                          <option value="decision">decision</option>
                          <option value="workflow">workflow</option>
                        </select>
                        <span className="pinboard-source-badge is-user" title="User-authored">User</span>
                      </div>
                      <textarea
                        autoFocus
                        className="pinboard-new-text"
                        name="pinboard-memory"
                        autoComplete="off"
                        aria-label="Memory note"
                        value={newPinDraft.text}
                        onChange={(e) => setNewPinDraft({ ...newPinDraft, text: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                            e.preventDefault();
                            saveNewPin();
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            cancelNewPin();
                          }
                        }}
                        placeholder="Memory note…"
                        rows={2}
                      />
                      <div className="pinboard-entry-actions-row">
                        <button
                          className="pinboard-accept-btn"
                          onClick={saveNewPin}
                          type="button"
                          disabled={!newPinDraft.text.trim()}
                        >
                          Save
                        </button>
                        <button className="pinboard-reject-btn" onClick={cancelNewPin} type="button">
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : null}
                  {visibleEntries.map((entry) => {
                    const isFocused = focusedPinboardId === entry.id;
                    const isEditing = editingPinId === entry.id;
                    const isManual = entry.source?.kind === "manual";
                    return (
                      <div
                        key={entry.id}
                        className={[
                          "pinboard-entry",
                          entry.confirmed ? "pinboard-confirmed" : "pinboard-pending",
                          isFocused ? "pinboard-entry-focused" : "",
                          isEditing ? "pinboard-entry-editing" : "",
                        ].filter(Boolean).join(" ")}
                        onClick={() => setFocusedPinboardId(entry.id)}
                      >
                        <div className="pinboard-entry-head">
                          <span
                            className={`pinboard-source-badge ${isManual ? "is-user" : "is-agent"}`}
                            title={isManual ? "User-authored" : "Agent-proposed"}
                            aria-label={isManual ? "User-authored" : "Agent-proposed"}
                          >
                            {isManual ? "User" : "Agent"}
                          </span>
                          <span className="pinboard-cat">{entry.category}</span>
                          <span className="pinboard-date">{entry.createdAt.slice(0, 10)}</span>
                          {entry.confirmed ? (
                            <button
                              className="pinboard-remove-btn"
                              onClick={(event) => {
                                event.stopPropagation();
                                removeEntry(entry.id);
                              }}
                              title="Remove this entry"
                              type="button"
                              aria-label="Remove entry"
                            >
                              ×
                            </button>
                          ) : null}
                        </div>
                        {isEditing ? (
                          <textarea
                            autoFocus
                            className="pinboard-entry-edit"
                            name={`pinboard-memory-${entry.id}`}
                            autoComplete="off"
                            aria-label="Edit memory note"
                            value={editingPinDraft}
                            onChange={(e) => setEditingPinDraft(e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                                e.preventDefault();
                                commitEditPin(entry.id);
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                cancelEditPin();
                              }
                            }}
                            onBlur={() => commitEditPin(entry.id)}
                            rows={Math.max(2, Math.min(6, Math.ceil(editingPinDraft.length / 60)))}
                          />
                        ) : (
                          <div
                            className="pinboard-entry-text pinboard-entry-text-editable"
                            title="Click to edit"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (entry.confirmed) startEditPin(entry);
                            }}
                          >
                            {entry.text}
                          </div>
                        )}
                        {!entry.confirmed && !isEditing ? (
                          <div className="pinboard-entry-actions-row">
                            <button
                              className="pinboard-accept-btn"
                              onClick={(event) => {
                                event.stopPropagation();
                                confirmEntry(entry.id);
                              }}
                              type="button"
                            >
                              Accept
                            </button>
                            <button
                              className="pinboard-reject-btn"
                              onClick={(event) => {
                                event.stopPropagation();
                                removeEntry(entry.id);
                              }}
                              type="button"
                            >
                              Reject
                            </button>
                            <button
                              className="pinboard-edit-btn"
                              onClick={(event) => {
                                event.stopPropagation();
                                startEditPin(entry);
                              }}
                              type="button"
                              title="Edit before accepting"
                            >
                              Edit
                            </button>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                  {pinboard.length === 0 && !newPinDraft ? (
                    <div className="item-list-empty">
                      No pins yet.
                    </div>
                  ) : null}
                </div>
	              </div>
	            );
	          })() : assetLibrarySelected ? (() => {
	            const groups = ASSET_LIBRARY_SECTIONS.map((section) => ({
	              section,
	              entries: project ? ((project[section] || []) as AssetEntry[]) : [],
	            })).filter((group) => group.entries.length > 0);
	            const totalEntries = groups.reduce((sum, group) => sum + group.entries.length, 0);
	            return (
	              <div className="magic-doc-atlas-scroll asset-context-workbench">
	                <section className="asset-context-inventory-pane">
	                  <div className="magic-doc-helper">
	                    <div className="magic-doc-helper-head">
	                      <div>
	                        <div className="magic-doc-helper-title">Asset library</div>
	                        <div className="magic-doc-helper-purpose">
	                          Live inventory of asset cards and attached media.
	                        </div>
	                      </div>
	                    </div>
	                  </div>
	                  {totalEntries === 0 ? (
	                    <div className="magic-doc-empty-state asset-context-inventory-empty">
	                      No assets yet. Add entries in the Assets section.
	                    </div>
	                  ) : (
	                    <>
	                      {groups.map(({ section, entries }) => (
	                        <div key={section} className="asset-inventory-section">
	                          <div className="asset-inventory-section-title">
	                            <span>{SECTION_LABELS[section]}</span>
	                            <span>{entries.length}</span>
	                          </div>
	                          <div className="asset-inventory-list">
	                            {entries.map((entry) => {
	                              const name = entry.title || entry.name || "(untitled)";
	                              const mediaCount = Array.isArray(entry.media) ? entry.media.length : 0;
	                              const thumb = Array.isArray(entry.media)
	                                ? entry.media.find((m) => m.kind === "image")
	                                : null;
	                              return (
	                                <button
	                                  key={entry.id}
	                                  type="button"
	                                  className="asset-inventory-row"
	                                  onClick={() => jumpToAsset(section, entry.id)}
	                                  title={`Open ${name}`}
	                                >
	                                  <div className="asset-inventory-thumb-wrap">
	                                    {thumb && handle?.projectDir ? (
	                                      <img
	                                        src={mediaSrc(thumb, mediaRefreshKey)}
	                                        alt={name}
	                                        className="asset-inventory-thumb"
	                                        loading="lazy"
	                                      />
	                                    ) : (
	                                      <div className="asset-inventory-thumb asset-inventory-thumb-empty">?</div>
	                                    )}
	                                  </div>
	                                  <div className="asset-inventory-body">
	                                    <div className="asset-inventory-head">
	                                      <span className="asset-inventory-name">{name}</span>
	                                      <span className="asset-inventory-meta">
	                                        {mediaCount} {mediaCount === 1 ? "file" : "files"}
	                                      </span>
	                                    </div>
	                                  </div>
	                                  <span className="asset-inventory-arrow" aria-hidden="true">→</span>
	                                </button>
	                              );
	                            })}
	                          </div>
	                        </div>
	                      ))}
	                    </>
	                  )}
	                </section>
	              </div>
	            );
	          })() : assetContextSelected ? (() => {
            const guideReferences = assetContextGuide?.references || [];
            const guideReferenceLabels = new Set(guideReferences.map((reference) => reference.label.toLowerCase()));
            return (
              <div className="magic-doc-atlas-scroll asset-context-simple">
                <div className="asset-context-toolbar">
                  <div className="asset-context-ref-count">
                    {guideReferences.length} {guideReferences.length === 1 ? "reference" : "references"}
                  </div>
                  <div className="asset-context-actions">
                    <button
                      className="ghost-btn compact"
                      type="button"
                      onClick={() => void uploadAssetContextGuideReferences()}
                    >
                      Upload files
                    </button>
                    <button
                      className={["ghost-btn", "compact", assetContextLibraryOpen ? "active" : ""].filter(Boolean).join(" ")}
                      type="button"
                      onClick={() => setAssetContextLibraryOpen((current) => !current)}
                    >
                      From library
                    </button>
                    {assetContextGuide?.path ? (
                      <button
                        className="ghost-btn compact"
                        type="button"
                        onClick={() => void revealAssetContextGuide()}
                      >
                        Reveal folder
                      </button>
                    ) : null}
                  </div>
                </div>
                {assetContextLibraryOpen ? (
                  <section className="asset-context-library-picker" aria-label="Asset library images">
                    <div className="asset-context-library-head">
                      <input
                        className="asset-context-library-search"
                        type="search"
                        name="asset-context-library-search"
                        autoComplete="off"
                        placeholder="Search asset library images…"
                        value={assetContextLibraryQuery}
                        onChange={(event) => setAssetContextLibraryQuery(event.target.value)}
                        aria-label="Search asset library images"
                      />
                      <span className="asset-context-library-count">
                        {assetContextLibraryRecords.length} image{assetContextLibraryRecords.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    {assetContextLibraryRecords.length ? (
                      <div className="asset-context-library-grid">
                        {assetContextLibraryRecords.map((record) => {
                          const basename = record.path.split("/").pop() || record.path;
                          const existingReference = guideReferenceLabels.has(basename.toLowerCase())
                            ? guideReferences.find((reference) => reference.label.toLowerCase() === basename.toLowerCase()) || null
                            : null;
                          return (
                            <button
                              key={record.id}
                              type="button"
                              className={`asset-context-library-card${existingReference ? " is-added" : ""}`}
                              onClick={() => {
                                if (existingReference) void revealAssetContextGuide(existingReference.path);
                                else void addAssetContextReferenceFromLibrary(record);
                              }}
                              title={existingReference ? `Reveal ${basename}` : `Add ${basename}`}
                            >
                              <img
                                className="asset-context-library-thumb"
                                src={indexMediaSrc(handle?.projectDir, record.path, mediaRefreshKey)}
                                alt={basename}
                                loading="lazy"
                              />
                              <span className="asset-context-library-badge">
                                {existingReference ? "Added" : "Add"}
                              </span>
                              <span className="asset-context-library-name">{basename}</span>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="asset-context-reference-empty">
                        {deferredAssetContextLibraryQuery.trim() ? "No matching library images." : "No image files in the asset library."}
                      </div>
                    )}
                  </section>
                ) : null}
                {guideReferences.length ? (
                  <div className="asset-context-reference-grid">
                    {guideReferences.map((reference) => (
                      <div
                        key={reference.path}
                        className="asset-context-reference-card"
                      >
                        <button
                          type="button"
                          className="asset-context-reference-open"
                          onClick={() => void revealAssetContextGuide(reference.path)}
                          title={`Reveal ${reference.label}`}
                        >
                          <img
                            src={reference.fileUrl}
                            alt={reference.label}
                            className="asset-context-reference-thumb"
                            loading="lazy"
                          />
                          <span className="asset-context-reference-label">{reference.label}</span>
                        </button>
                        <button
                          type="button"
                          className="asset-context-reference-remove"
                          aria-label={`Remove ${reference.label}`}
                          title="Remove reference image"
                          onClick={(event) => {
                            event.stopPropagation();
                            void deleteAssetContextGuideReference(reference.path);
                          }}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="asset-context-reference-empty">
                    No references. Upload files or add images from the asset library.
                  </div>
                )}
                {assetContextGuideLoading && !assetContextGuide ? (
                  <div className="asset-context-reference-empty">
                    Loading guide…
                  </div>
                ) : (
                  <LazyMarkdownEditor
                    className="main-editor project-context-editor cm-editor-host asset-context-guide-editor"
                    ariaLabel="Asset Context guide editor"
                    value={assetContextGuide?.content || ""}
                    onChange={(next) => {
                      setAssetContextGuide((current) => ({
                        content: next,
                        name: current?.name || "Asset Context",
                        path: current?.path || ".forge/asset-context/guide.md",
                        references: current?.references || [],
                      }));
                      if (assetContextGuideSaveTimer.current) {
                        window.clearTimeout(assetContextGuideSaveTimer.current);
                      }
                      assetContextGuideSaveTimer.current = window.setTimeout(() => {
                        if (handle?.projectDir) {
                          void window.forgeDesktop
                            .writeAssetContextGuide(handle.projectDir, next)
                            .catch((writeError) => {
                              setError(writeError instanceof Error ? writeError.message : "Failed to save Asset Context.");
                            });
                        }
                      }, 400);
                    }}
                    placeholder={`Asset rules and references…\n\n- Look targets\n- Do / don't\n- Materials\n- Camera / lighting\n- Notes for reference images`}
                    spellCheck={false}
                  />
                )}
              </div>
            );
          })() : projectContextSelected ? (
            <>
              <div className="context-doc-helper tone-world">
                <div className="context-doc-helper-head">
                  <div>
                    <div className="context-doc-helper-purpose">
                      Hidden workflow/protocol, priorities, hard constraints, directory rules, SOP.
                    </div>
                  </div>
                  <div className="context-doc-helper-actions">
                    <ReadOnlyToggle
                      project={project}
                      relativePath="ANVIL.md"
                      onToggle={(next) => {
                        if (!project) return;
                        queueSave(withTogglePathReadOnly(project, "ANVIL.md", next));
                      }}
                    />
                  </div>
                </div>
              </div>
              <LazyMarkdownEditor
                className="main-editor project-context-editor cm-editor-host"
                ariaLabel="Agent protocol editor"
                value={projectContextDraft}
                readOnly={isPathReadOnly(project, "ANVIL.md")}
                onChange={(next) => {
                  setProjectContextDraft(next);
                  if (projectContextSaveTimer.current) {
                    window.clearTimeout(projectContextSaveTimer.current);
                  }
                  projectContextSaveTimer.current = window.setTimeout(() => {
                    if (handle?.projectDir) {
                      void window.forgeDesktop
                        .writeProjectContext(handle.projectDir, next)
                        .catch((writeError) => {
                          setError(writeError instanceof Error ? writeError.message : "Failed to save project context.");
                        });
                    }
                  }, 400);
                }}
                placeholder="Workflow preferences, priorities, hard constraints, directory rules, SOP…"
                spellCheck={false}
              />
            </>
          ) : agentNoteSelected ? (
            <>
              <div className="context-doc-helper tone-custom">
                <div className="context-doc-helper-head">
                  <div>
                    <div className="context-doc-helper-purpose">
                      {AGENT_NOTE_PURPOSE}
                    </div>
                  </div>
                  <div className="context-doc-helper-actions">
                    <ReadOnlyToggle
                      project={project}
                      relativePath={AGENT_NOTE_PATH}
                      onToggle={(next) => {
                        if (!project) return;
                        queueSave(withTogglePathReadOnly(project, AGENT_NOTE_PATH, next));
                      }}
                    />
                  </div>
                </div>
              </div>
              <LazyMarkdownEditor
                className="main-editor project-context-editor cm-editor-host"
                ariaLabel="Agent Note editor"
                value={agentNoteDraft}
                readOnly={isPathReadOnly(project, AGENT_NOTE_PATH)}
                onChange={(next) => {
                  setAgentNoteDraft(next);
                  if (agentNoteSaveTimer.current) {
                    window.clearTimeout(agentNoteSaveTimer.current);
                  }
                  agentNoteSaveTimer.current = window.setTimeout(() => {
                    if (handle?.projectDir) {
                      void window.forgeDesktop
                        .writeAgentNote(handle.projectDir, next)
                        .catch((writeError) => {
                          setError(writeError instanceof Error ? writeError.message : "Failed to save Agent Note.");
                        });
                    }
                  }, 400);
                }}
                placeholder="Short notes for the agent: what to preserve, what to change, next step, blockers…"
                spellCheck={false}
              />
            </>
          ) : sectionFormatSelected ? (
            <>
              <div className="context-doc-helper tone-custom">
                <div className="context-doc-helper-head">
                  <div>
                    <div className="context-doc-helper-purpose">
                      Section rules.
                    </div>
                  </div>
                </div>
              </div>
              <LazyMarkdownEditor
                className="main-editor project-context-editor cm-editor-host"
                ariaLabel={`${SECTION_FORMAT_LABELS[sectionFormatSelected].label} format rules editor`}
                value={sectionFormatDraft[sectionFormatSelected] || ""}
                onChange={(next) => {
                  setSectionFormatDraft((current) => ({ ...current, [sectionFormatSelected]: next }));
                  if (sectionFormatSaveTimer.current) {
                    window.clearTimeout(sectionFormatSaveTimer.current);
                  }
                  sectionFormatSaveTimer.current = window.setTimeout(() => {
                    if (handle?.projectDir) {
                      void window.forgeDesktop
                        .writeSectionConvention(handle.projectDir, sectionFormatSelected, next)
                        .catch((writeError) => {
                          setError(writeError instanceof Error ? writeError.message : "Failed to save format.");
                        });
                    }
                  }, 400);
                }}
                placeholder={`Format rules for ${SECTION_FORMAT_LABELS[sectionFormatSelected].label.toLowerCase()}…`}
                spellCheck={false}
              />
            </>
          ) : selectedMagicDoc ? (() => {
	            // Legacy Character Bible / Location Atlas magic docs still open
	            // if an old project or notice points at them. The default UI now
	            // uses one combined Asset library row above.
            const isAssetDoc =
              selectedMagicDoc.kind === "bible" || selectedMagicDoc.kind === "atlas";
            if (isAssetDoc) {
              const assetSection: "characters" | "locations" =
                selectedMagicDoc.kind === "bible" ? "characters" : "locations";
              const entries = project ? ((project[assetSection] || []) as AssetEntry[]) : [];
              return (
                <div className="magic-doc-atlas-scroll asset-context-workbench">
                  <section className="asset-context-inventory-pane">
                    <div className="magic-doc-helper">
                      <div className="magic-doc-helper-head">
                        <div>
                          <div className="magic-doc-helper-title">{selectedMagicDoc.name}</div>
                          <div className="magic-doc-helper-purpose">
                            Live {assetSection === "characters" ? "character" : "location"} inventory.
                          </div>
                        </div>
                      </div>
                    </div>
                    {entries.length === 0 ? (
                      <div className="magic-doc-empty-state asset-context-inventory-empty">
                        No {assetSection} yet. Add entries in the Assets section.
                      </div>
                    ) : (
                        <div className="asset-inventory-list">
                          {entries.map((entry) => {
                            const name = entry.title || entry.name || "(untitled)";
                            const mediaCount = Array.isArray(entry.media) ? entry.media.length : 0;
                            const thumb = Array.isArray(entry.media)
                              ? entry.media.find((m) => m.kind === "image")
                              : null;
                            return (
                              <button
                                key={entry.id}
                                type="button"
                                className="asset-inventory-row"
                                onClick={() => jumpToAsset(assetSection, entry.id)}
                                title={`Open ${name}`}
                              >
                                <div className="asset-inventory-thumb-wrap">
                                  {thumb && handle?.projectDir ? (
                                    <img
                                      src={mediaSrc(thumb, mediaRefreshKey)}
                                      alt={name}
                                      className="asset-inventory-thumb"
                                      loading="lazy"
                                    />
                                  ) : (
                                    <div className="asset-inventory-thumb asset-inventory-thumb-empty">?</div>
                                  )}
                                </div>
                                <div className="asset-inventory-body">
                                  <div className="asset-inventory-head">
                                    <span className="asset-inventory-name">{name}</span>
                                    <span className="asset-inventory-meta">
                                      {mediaCount} {mediaCount === 1 ? "image" : "images"}
                                    </span>
                                  </div>
                                </div>
                                <span className="asset-inventory-arrow" aria-hidden="true">→</span>
                              </button>
                            );
                          })}
                        </div>
                    )}
                  </section>
                </div>
              );
            }
            // Non-asset custom magic docs keep the synthesized-summary
            // flow. Their sources are real markdown files the user may
            // not want to open one-by-one.
            return (
              <>
                <div className="magic-doc-helper">
                  <div className="magic-doc-helper-head">
                    <div>
                      <div className="magic-doc-helper-title">{selectedMagicDoc.name}</div>
                      <div className="magic-doc-helper-purpose">{selectedMagicDoc.description}</div>
                    </div>
                    <div className="magic-doc-helper-badges">
                      {(() => {
                        const cta = magicDocNextAction(selectedMagicDoc.status);
                        if (!cta) return null;
                        const disabled = busy !== null;
                        return (
                          <button
                            className="magic-doc-cta-btn has-art-icon icon-hover-tooltip tooltip-bottom"
                            onClick={() => void syncSelectedMagicDoc(false)}
                            disabled={disabled}
                            type="button"
                            data-tooltip={disabled && busy !== "magic-sync" ? `Wait for ${busy} to finish` : cta.hint}
                          >
                            <SyncIcon />
                            {busy === "magic-sync" ? "Syncing…" : cta.label}
                          </button>
                        );
                      })()}
                    </div>
                  </div>
                  {selectedMagicDoc.scopeErrors.length ? (
                    <div className="context-doc-helper-note">
                      {selectedMagicDoc.scopeErrors.join(" ")}
                    </div>
                  ) : selectedMagicDoc.neverSynthesized ? (
                    <div className="magic-doc-empty-state">
                      Empty. Generate a source summary.
                    </div>
                  ) : null}
                </div>
                <textarea
                  ref={editorTextareaRef}
                  className="main-editor magic-doc-body-readonly"
                  name="source-summary"
                  autoComplete="off"
                  aria-label="Source summary"
                  value={
                    selectedMagicDoc.neverSynthesized && !selectedMagicDoc.content
                      ? ""
                      : selectedMagicDoc.content
                  }
                  readOnly
                  spellCheck={false}
                  placeholder="Generate summary…"
                />
              </>
            );
          })() : selectedItem && activeSection !== "videos" ? (
            isAssetSection(activeSection) ? (
              <div className="asset-editor" ref={assetEditorRef}>
                <div className="asset-hero-card">
                  {mediaPreview && !previewMissing ? (
                    mediaPreview.kind === "audio" ? (
                      <div className="asset-hero-media">
                        <audio controls src={mediaSrc(mediaPreview, mediaRefreshKey)} className="media-player asset-audio-player" />
                      </div>
                    ) : previewIsVideo ? (
                      <div className="asset-hero-media">
                        <video
                          ref={assetVideoPlayerRef}
                          controls
                          src={mediaSrc(mediaPreview, mediaRefreshKey)}
                          className="media-player asset-video-player"
                          onError={() =>
                            setBrokenMediaIds((current) => ({
                              ...current,
                              [mediaPreview.id]: true,
                            }))
                          }
                          onLoadedData={() =>
                            setBrokenMediaIds((current) => ({
                              ...current,
                              [mediaPreview.id]: false,
                            }))
                          }
                        />
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="asset-hero-media is-interactive"
                        onClick={() => setShowAssetPreviewLightbox(true)}
                        title="Click or press Space to preview larger"
                      >
                        <img
                          src={mediaSrc(mediaPreview, mediaRefreshKey)}
                          alt={mediaPreview.label}
                          className="asset-hero-image"
                          onError={() =>
                            setBrokenMediaIds((current) => ({
                              ...current,
                              [mediaPreview.id]: true,
                            }))
                          }
                          onLoad={() =>
                            setBrokenMediaIds((current) => ({
                              ...current,
                              [mediaPreview.id]: false,
                            }))
                          }
                        />
                      </button>
                    )
                  ) : (
                    <div className="asset-hero-empty">
                      <div className="empty-preview">
                        {mediaPreview
                          ? "Can't preview this file."
                          : activeSection === "audio"
                            ? "No audio yet."
                            : "No image yet."}
                      </div>
                      {mediaPreview?.path ? (
                        <div className="asset-missing-path" title={mediaPreview.path}>{mediaPreview.path}</div>
                      ) : null}
                      {mediaPreview?.fileUrl ? (
                        <button
                          className="ghost-btn compact"
                          onClick={() =>
                            setBrokenMediaIds((current) => {
                              if (!mediaPreview) return current;
                              if (!current[mediaPreview.id]) return current;
                              const next = { ...current };
                              delete next[mediaPreview.id];
                              return next;
                            })
                          }
                          type="button"
                        >
                          Retry preview
                        </button>
                      ) : null}
                      <button className="primary-btn" onClick={() => void uploadAssetMedia()} type="button">
                        {busy === "upload" ? "Uploading…" : uploadLabelForSection(activeSection, selectedAssetMediaCount)}
                      </button>
                    </div>
                  )}
                </div>
                {previewIsVideo && mediaPreview && !previewMissing && assetVideoTrimDraft ? (
                  <div className="asset-video-trim-panel">
                    <div className="asset-video-trim-head">
                      <div className="asset-variants-label">Quick trim</div>
                      <div className="asset-video-trim-meta">
                        {previewDurationSec ? `Source ${formatTrimPointInput(previewDurationSec)}s` : "Save current range as a new variant"}
                      </div>
                    </div>
                    <div className="asset-video-trim-controls">
                      <label className="asset-video-trim-field">
                        <span>Start</span>
                        <input
                          type="number"
                          min="0"
                          step="0.1"
                          inputMode="decimal"
                          value={assetVideoTrimDraft.start}
                          onChange={(event) => updateAssetVideoTrimDraft({ start: event.target.value })}
                        />
                      </label>
                      <button
                        type="button"
                        className="ghost-btn compact"
                        onClick={() => markAssetVideoTrim("start")}
                      >
                        Mark in
                      </button>
                      <label className="asset-video-trim-field">
                        <span>End</span>
                        <input
                          type="number"
                          min="0"
                          step="0.1"
                          inputMode="decimal"
                          value={assetVideoTrimDraft.end}
                          onChange={(event) => updateAssetVideoTrimDraft({ end: event.target.value })}
                          placeholder={previewDurationSec ? formatTrimPointInput(previewDurationSec) : "end"}
                        />
                      </label>
                      <button
                        type="button"
                        className="ghost-btn compact"
                        onClick={() => markAssetVideoTrim("end")}
                      >
                        Mark out
                      </button>
                      <button
                        type="button"
                        className="primary-btn compact"
                        onClick={() => void saveTrimmedAssetVideo()}
                        disabled={busy === "trim"}
                      >
                        {busy === "trim" ? "Saving trim…" : "Save trim"}
                      </button>
                    </div>
                  </div>
                ) : null}
                {activeSection === "media" && selectedAsset?.media.length ? (
                  <div className="asset-variants-block">
                    <div className="asset-variants-head">
                      <div className="asset-variants-actions">
                        <button
                          className="asset-variants-attach-btn icon-hover-tooltip tooltip-bottom"
                          type="button"
                          onClick={() => setAttachPickerOpen((current) => !current)}
                          disabled={attachBusy}
                          data-tooltip="Attach this file to an asset"
                          aria-expanded={attachPickerOpen}
                        >
                          {attachBusy ? "Attaching…" : "Use this media…"}
                        </button>
                      </div>
                    </div>
                    {attachPickerOpen ? (() => {
                      const sectionList: Array<"characters" | "locations" | "props" | "keyframes" | "audio"> = [
                        "characters", "locations", "props", "keyframes", "audio",
                      ];
                      const entries = (project?.[attachPickerSection] || []) as AssetEntry[];
                      return (
                        <div className="asset-attach-picker" role="dialog" aria-label="Use media on an asset">
                          <div className="asset-attach-picker-head">
                            <div className="asset-attach-picker-hint">
                              Choose where this file belongs.
                            </div>
                            <button
                              type="button"
                              className="asset-attach-picker-close"
                              onClick={() => setAttachPickerOpen(false)}
                              aria-label="Close"
                            >
                              ×
                            </button>
                          </div>
                          <div
                            className="asset-attach-picker-tabs"
                            role="tablist"
                            aria-label="Asset type"
                            onKeyDown={(event) => {
                              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                              event.preventDefault();
                              const idx = sectionList.indexOf(attachPickerSection);
                              const next = event.key === "ArrowRight"
                                ? sectionList[(idx + 1) % sectionList.length]
                                : sectionList[(idx - 1 + sectionList.length) % sectionList.length];
                              setAttachPickerSection(next);
                            }}
                          >
                            {sectionList.map((sec) => (
                              <button
                                key={sec}
                                type="button"
                                role="tab"
                                aria-selected={attachPickerSection === sec}
                                tabIndex={attachPickerSection === sec ? 0 : -1}
                                className={`asset-attach-picker-tab${attachPickerSection === sec ? " active" : ""}`}
                                onClick={() => setAttachPickerSection(sec)}
                              >
                                {SECTION_LABELS[sec]}
                                <span className="asset-attach-picker-tab-count">
                                  {(project?.[sec] as AssetEntry[] | undefined)?.length || 0}
                                </span>
                              </button>
                            ))}
                          </div>
                          <div className="asset-attach-picker-list">
                            {entries.length ? (
                              entries
                                .filter((entry) => entry.id !== selectedAsset.id)
                                .map((entry) => (
                                  <button
                                    key={entry.id}
                                    type="button"
                                    className="asset-attach-picker-row"
                                    onClick={() => void attachSelectedAssetToEntity(attachPickerSection, entry.id)}
                                    disabled={attachBusy}
                                  >
                                    <span className="asset-attach-picker-row-name">
                                      {entry.name || entry.title || "Untitled"}
                                    </span>
                                    <span className="asset-attach-picker-row-refs">
                                      {(entry.media?.length || 0)} file{(entry.media?.length || 0) === 1 ? "" : "s"}
                                    </span>
                                  </button>
                                ))
                            ) : (
                              <div className="asset-attach-picker-empty">
                                No entries in {SECTION_LABELS[attachPickerSection]} yet.
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })() : null}
                  </div>
                ) : null}
                {selectedAsset?.media.length ? (
                  <div className="asset-variants-block">
                    <div className="asset-variants-head">
                      <div className="asset-variants-label">Variants</div>
                    </div>
                    <div className="asset-media-strip">
                      {selectedAsset.media.map((media) => (
                        <div
                          key={media.id}
                          className={[
                            "asset-media-chip-wrap",
                            mediaPreview?.id === media.id ? "active" : "",
                          ].filter(Boolean).join(" ")}
                        >
                          <button
                            className={mediaPreview?.id === media.id ? "asset-media-chip active" : "asset-media-chip"}
                            onClick={() => {
                              setBrokenMediaIds((current) => {
                                if (!current[media.id]) return current;
                                const next = { ...current };
                                delete next[media.id];
                                return next;
                              });
                              setSelectedMediaIds((current) => ({
                                ...current,
                                [selectedAsset.id]: media.id,
                              }));
                            }}
                            type="button"
                            title={`Preview "${media.label || media.path.split("/").pop() || "variant"}"`}
                            aria-label={`Preview ${media.label || media.path.split("/").pop() || "variant"}`}
                          >
                            {media.kind === "audio" ? (
                              <span className="asset-media-kind">MP3</span>
                            ) : media.kind === "video" && media.fileUrl && !brokenMediaIds[media.id] ? (
                              <video
                                src={mediaSrc(media, mediaRefreshKey)}
                                className="asset-media-thumb"
                                muted
                                playsInline
                                preload="metadata"
                                onError={() =>
                                  setBrokenMediaIds((current) => ({
                                    ...current,
                                    [media.id]: true,
                                  }))
                                }
                                onLoadedData={() =>
                                  setBrokenMediaIds((current) => ({
                                    ...current,
                                    [media.id]: false,
                                  }))
                                }
                              />
                            ) : media.fileUrl && !brokenMediaIds[media.id] ? (
                              <img
                                src={mediaSrc(media, mediaRefreshKey)}
                                alt={media.label}
                                className="asset-media-thumb"
                                onError={() =>
                                  setBrokenMediaIds((current) => ({
                                    ...current,
                                    [media.id]: true,
                                  }))
                                }
                                onLoad={() =>
                                  setBrokenMediaIds((current) => ({
                                    ...current,
                                    [media.id]: false,
                                  }))
                                }
                              />
                            ) : (
                              <span className="asset-media-kind">{media.kind === "video" ? "VID" : "IMG"}</span>
                            )}
                          </button>
                          <button
                            className="asset-media-delete"
                            onClick={(event) => {
                              event.stopPropagation();
                              deleteMediaVariant(selectedAsset.id, media.id);
                            }}
                            title={`Remove "${media.label || "variant"}" from this asset (file stays in library)`}
                            aria-label={`Remove variant ${media.label || ""}`}
                            type="button"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <>
                {selectedStoryDoc ? (
                  <div className={`context-doc-helper tone-${selectedStoryDoc.accent}`}>
                    <div className="context-doc-helper-head">
                      <div>
                        <div className="context-doc-helper-purpose">{selectedStoryDoc.purpose}</div>
                      </div>
                      <div className="context-doc-helper-actions">
                        {selectedItem?.path ? (
                          <ReadOnlyToggle
                            project={project}
                            relativePath={selectedItem.path}
                            onToggle={(next) => {
                              if (!project || !selectedItem?.path) return;
                              queueSave(withTogglePathReadOnly(project, selectedItem.path, next));
                            }}
                          />
                        ) : null}
                        {!selectedStoryDoc.builtIn && selectedItem ? (
                          <button
                            className="ghost-btn compact danger-btn"
                            onClick={() => deleteCustomStoryDoc(selectedItem.id)}
                            title={`Delete "${selectedStoryDoc.title}" from the project`}
                            type="button"
                          >
                            Delete
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ) : null}
                <LazyMarkdownEditor
                  className="main-editor cm-editor-host"
	                  ariaLabel={
	                    selectedStoryDoc
	                      ? `${selectedStoryDoc.title} context document editor`
	                      : `${getEntryLabel(activeSection, selectedItem)} editor`
	                  }
                  value={contentDraft}
                  onFocus={() => setEditingField("content")}
                  onBlur={() => setEditingField(null)}
                  onChange={(next) => {
                    setContentDraft(next);
                    patchSelected(next);
                  }}
	                  placeholder={
	                    selectedStoryDoc
	                      ? `Edit ${selectedStoryDoc.title}…`
	                      : `Edit ${getEntryLabel(activeSection, selectedItem)}…`
	                  }
                  promptHighlight={
                    activeSection === "script" ||
                    activeSection === "dialogue" ||
                    activeSection === "prompts"
                      ? promptHighlightEntities
                      : undefined
                  }
                  highlightTier={
                    // Master Script and scenes are narrative prose — only entity
                    // tints. Prompts are production form — also tint camera,
                    // style, and constraint patterns.
                    activeSection === "prompts"
                      ? "production"
                      : "narrative"
                  }
                  onEntityClick={(category, entityName) => {
                    // Cmd/Ctrl+click on a tinted entity name → jump to its
                    // asset page. The detector's EntityCategory uses singular
                    // nouns ("character", "location") but sections for the
                    // first four are plural ("characters", "locations").
                    // "audio" + "library" are already their own section id.
                    const section = (
                      category === "audio" || category === "library"
                        ? category
                        : `${category}s`
                    ) as SectionId;
                    // Cast through unknown — the detector only ever emits
                    // asset-section-shaped ids (library / characters /
                    // locations / props / keyframes / audio) but SectionId
                    // includes non-array slots like "media" that trip TS.
                    const items = (((project as unknown) as Record<
                      string,
                      Array<{ id: string; name?: string | null; title?: string | null }>
                    >)?.[section] || []);
                    const norm = entityName.trim().toLowerCase();
                    const hit = items.find(
                      (a) => (a.name || a.title || "").trim().toLowerCase() === norm,
                    );
                    if (hit) jumpToAsset(section, hit.id);
                  }}
                />
              </>
            )
	          ) : activeSection === "workshop" ? (
		            handle?.projectDir && project ? (
		              <WorkshopSurfaceErrorBoundary onError={(message) => setError(`Workshop failed: ${message}`)}>
		                <WorkshopNLE
		                  project={project}
		                  projectDir={handle.projectDir}
		                  onSaveProject={(next) => {
		                    // Route through queueSave so workshop edits get the same
		                    // benefits as every other section: undo stack, debounced
		                    // persist, watcher-ignore window, and the live "Saved Xs
		                    // ago" indicator update.
		                    queueSave(next);
		                  }}
		                  onNotice={(message, kind) => {
		                    if (kind === "error") {
		                      setError(message);
		                    } else {
		                      setNotice(message, kind || "info");
		                    }
		                  }}
		                  touchedPathSet={touchedPathSet}
		                  agentSelectedClipIds={agentEditingClipIds}
		                  agentWorking={Boolean(inFlightRequestId)}
		                  onRevealPath={(relativePath) => {
		                    if (window.forgeDesktop?.revealPath && handle?.projectDir) {
		                      void window.forgeDesktop.revealPath(handle.projectDir, relativePath);
		                    }
		                  }}
		                  onImportMedia={async (filePaths) => {
		                    if (!handle?.projectDir) return { videos: [], audio: [] };
		                    if (window.forgeDesktop?.importWorkshopMedia) {
		                      const imported = await window.forgeDesktop.importWorkshopMedia(
		                        handle.projectDir,
		                        filePaths,
		                      );
		                      if (imported.videos.length || imported.audio.length) {
		                        await refreshCurrentProject();
		                      }
		                      return imported;
		                    }
		                    if (!window.forgeDesktop?.importVideos) return { videos: [], audio: [] };
		                    const copied = await window.forgeDesktop.importVideos(
		                      handle.projectDir,
		                      "",
		                      filePaths,
		                    );
		                    if (copied?.length) {
		                      await refreshCurrentProject();
		                    }
		                    return { videos: copied || [], audio: [] };
		                  }}
		                />
		              </WorkshopSurfaceErrorBoundary>
		            ) : null
		          ) : activeSection === "videos" ? (
	            (() => {
	              const projectDir = handle.projectDir;
	              const activeVideo = selectedVideo;
	              const basename = activeVideo?.path.split("/").pop() || "";
	              const videoSrc = activeVideo ? indexMediaSrc(projectDir, activeVideo.path, mediaRefreshKey) : "";
	              const durationLabel =
	                activeVideo && typeof activeVideo.durationSec === "number" && Number.isFinite(activeVideo.durationSec) && activeVideo.durationSec > 0
	                  ? `${Math.round(activeVideo.durationSec)}s`
	                  : "";
	              const importedDate = activeVideo?.generatedAt ? new Date(activeVideo.generatedAt) : null;
	              const importedLabel =
	                importedDate && !Number.isNaN(importedDate.getTime()) ? importedDate.toLocaleString() : "";
	              const importButtonLabel = busy === "upload" ? "Importing..." : "Import local";
	              const importDisabled = busy === "upload";
	              const importVideosToBin = async (filePaths: string[] | null = null) => {
	                if (!projectDir || !window.forgeDesktop?.importVideos) return;
	                setBusy("upload");
	                setError(null);
	                try {
	                  const copied = await window.forgeDesktop.importVideos(projectDir, "", filePaths);
	                  if (copied && copied.length) {
	                    const refreshed = await refreshCurrentProject();
	                    if (refreshed) {
	                      const importedSet = new Set(copied);
	                      const newestImported = sortVideosForBin(refreshed.project.videos || [])
	                        .find((video) => importedSet.has(video.path));
	                      if (newestImported) {
	                        setSelectedIds((current) => ({ ...current, videos: newestImported.id }));
	                      }
	                    }
	                    setNotice(`Imported ${copied.length} video${copied.length === 1 ? "" : "s"}.`, "success", {
	                      category: "videos",
	                      action: { label: "Open video bin", target: { kind: "section", section: "videos" } },
	                      dedupeKey: `videos:import:${copied.length}`,
	                    });
	                  } else {
	                    setNotice("No supported video files selected.", "info");
	                  }
	                } catch (err) {
	                  setError(err instanceof Error ? err.message : "Video import failed.");
	                } finally {
	                  setBusy(null);
	                }
	              };
	              const droppedVideoPaths = (event: ReactDragEvent<HTMLElement>) => {
	                const paths: string[] = [];
	                const files = event.dataTransfer.files;
	                for (let i = 0; i < files.length; i += 1) {
	                  const filePath = (files[i] as unknown as { path?: string }).path;
	                  if (filePath) paths.push(filePath);
	                }
	                return paths;
	              };
	              const handleVideoDragOver = (event: ReactDragEvent<HTMLElement>) => {
	                event.preventDefault();
	                event.dataTransfer.dropEffect = "copy";
	                setVideosDragOver(true);
	              };
	              const handleVideoDragLeave = (event: ReactDragEvent<HTMLElement>) => {
	                if (event.currentTarget === event.target) {
	                  setVideosDragOver(false);
	                }
	              };
	              const handleVideoDrop = (event: ReactDragEvent<HTMLElement>) => {
	                event.preventDefault();
	                setVideosDragOver(false);
	                const paths = droppedVideoPaths(event);
	                if (!paths.length) {
	                  setError("Could not read dropped video file paths.");
	                  return;
	                }
	                void importVideosToBin(paths);
	              };

	              return (
	                <div
	                  className={`video-bin-editor${videosDragOver ? " drag-over" : ""}`}
	                  onDragOver={handleVideoDragOver}
	                  onDragLeave={handleVideoDragLeave}
	                  onDrop={handleVideoDrop}
	                >
	                  <div className="video-bin-editor-toolbar">
	                    <span className="video-bin-editor-count">
	                      {videoBinItems.length} video{videoBinItems.length === 1 ? "" : "s"}
	                    </span>
	                    <button
	                      type="button"
	                      className="ghost-btn compact icon-btn context-create-btn"
	                      onClick={() => void importVideosToBin()}
	                      disabled={importDisabled}
	                      title={importButtonLabel}
	                      aria-label="Import video to bin"
	                    >
	                      ＋
	                    </button>
	                  </div>

	                  {activeVideo && videoSrc ? (
	                    <>
	                      <div className="video-bin-preview-shell">
	                        <video
	                          key={activeVideo.id}
	                          ref={videoBinPreviewPlayerRef}
	                          className="video-preview-player"
	                          src={videoSrc}
	                          controls
	                          autoPlay={videoBinAutoplayVideoIdRef.current === activeVideo.id}
	                          preload="auto"
	                          onDoubleClick={() => setShowVideoPreviewLightbox(true)}
	                        />
	                      </div>
	                      <div className="video-bin-inspector">
	                        <div className="video-bin-inspector-main">
	                          <div className="video-bin-file-name" title={activeVideo.path}>
	                            {String(activeVideo.note || "").trim() || basename || "Video"}
	                          </div>
	                          <div className="video-bin-file-meta" title={activeVideo.path}>
	                            {[basename, durationLabel, importedLabel].filter(Boolean).join(" · ")}
	                          </div>
	                        </div>
	                        <label className="videos-take-note-field video-bin-note-field">
	                          <span className="videos-take-note-label">Note</span>
	                          <input
	                            className="videos-take-note-input"
	                            type="text"
	                            name="video-note"
	                            autoComplete="off"
	                            value={videoNoteDraft}
	                            onChange={(event) => setVideoNoteDraft(event.target.value)}
	                            onBlur={saveSelectedVideoNote}
	                            onKeyDown={(event) => {
	                              if (event.key === "Enter") {
	                                event.preventDefault();
	                                saveSelectedVideoNote();
	                                (event.currentTarget as HTMLInputElement).blur();
	                              } else if (event.key === "Escape") {
	                                event.preventDefault();
	                                setVideoNoteDraft(activeVideo.note || "");
	                                (event.currentTarget as HTMLInputElement).blur();
	                              }
	                            }}
	                            placeholder="Note"
	                          />
	                        </label>
	                        <button
	                          type="button"
	                          className="ghost-btn compact danger-btn"
	                          onClick={() => void performVideoDelete(activeVideo)}
	                          title="Delete this video"
	                        >
	                          Delete
	                        </button>
	                      </div>
	                    </>
	                  ) : (
	                    <div className="video-bin-empty-preview">
	                      <button
	                        type="button"
	                        className="primary-btn compact"
	                        onClick={() => void importVideosToBin()}
	                        disabled={importDisabled}
	                      >
	                        {importButtonLabel}
	                      </button>
	                    </div>
	                  )}
	                </div>
	              );
	            })()
		          ) : activeSection === "timeline" ? (
            // Timeline workspace: a lightweight rough-cut editor. Source
            // management stays in Video Bin; this view only plays, trims,
            // reorders, cuts, removes, and exports the current sequence.
            (() => {
              const projectDir = handle?.projectDir;
              const clips = resolveTimelineAssembly(project);
              timelineResolvedClipsRef.current = clips;
              const visibleTimelineClips = clips.filter((clip) => clip.enabled !== false);
              const totalRuntime = roundTimelineSec(
                clips.reduce((sum, clip) => sum + timelineActiveDuration(clip), 0),
              );
              const playableClips = clips.filter((clip) => isTimelineClipEnabled(clip));
              const hasPersistedTimeline = Array.isArray(project?.timeline) && project.timeline.length > 0;

              const playableIndexes: number[] = [];
              clips.forEach((clip, index) => {
                if (isTimelineClipEnabled(clip)) playableIndexes.push(index);
              });

              const selectedClipId = selectedIds.timeline || "";
              const manualSelectedIndex = clips.findIndex(
                (c) => c.key === selectedClipId || c.promptId === selectedClipId,
              );
              const selectedTimelineClip =
                manualSelectedIndex >= 0 ? clips[manualSelectedIndex] : null;
              const activePlayIndex =
                timelinePlayIndex !== null && clips[timelinePlayIndex]?.video
                  ? timelinePlayIndex
                  : manualSelectedIndex >= 0
                    ? manualSelectedIndex
                    : playableIndexes[0] ?? -1;
              const previewClip = activePlayIndex >= 0 ? clips[activePlayIndex] : null;
              const selectedVideo = previewClip?.video || null;
              const selectedRuntime = previewClip ? timelinePlayableDuration(previewClip) : 0;
              const previewWindow = previewClip
                ? effectiveTimelineWindow(
                    Math.max(
                      0,
                      Number(previewClip.video?.durationSec) || Number(previewClip.durationSec) || 0,
                    ),
                    previewClip.trimInSec,
                    previewClip.trimOutSec,
                  )
                : null;

              const formatMmSs = (sec: number) => {
                if (!Number.isFinite(sec) || sec <= 0) return "0:00";
                const s = Math.round(sec);
                const m = Math.floor(s / 60);
                const r = s % 60;
                return `${m}:${String(r).padStart(2, "0")}`;
              };

              const selectTimelineClip = (clipKey: string) => {
                setTimelineIsPlaying(false);
                setTimelinePlayIndex(null);
                setTimelinePlayStopAfterIndex(null);
                setSelectedIds((current) => ({ ...current, timeline: clipKey }));
              };

              // Advance to the next playable clip during assembly playback,
              // or stop if we've hit the end of the timeline. Called from
              // the preview <video>'s onEnded callback.
              const advancePlayhead = () => {
                const current = timelinePlayIndex ?? activePlayIndex;
                if (
                  timelinePlayStopAfterIndex !== null &&
                  current >= timelinePlayStopAfterIndex
                ) {
                  setTimelineIsPlaying(false);
                  setTimelinePlayIndex(null);
                  setTimelinePlayStopAfterIndex(null);
                  return;
                }
                const nextCandidate = playableIndexes.find(
                  (index) =>
                    index > current &&
                    (timelinePlayStopAfterIndex === null || index <= timelinePlayStopAfterIndex),
                );
                if (nextCandidate === undefined) {
                  setTimelineIsPlaying(false);
                  setTimelinePlayIndex(null);
                  setTimelinePlayStopAfterIndex(null);
                } else {
                  setTimelinePlayIndex(nextCandidate);
                  setSelectedIds((currentIds) => ({
                    ...currentIds,
                    timeline: clips[nextCandidate]?.key || currentIds.timeline,
                  }));
                }
              };

              const startAssemblyPlayback = () => {
                const selectedPlayable =
                  activePlayIndex >= 0 && isTimelineClipEnabled(clips[activePlayIndex])
                    ? activePlayIndex
                    : null;
                const first = selectedPlayable ?? playableIndexes[0];
                if (first === undefined || first === null) return;
                if (clips[first]?.key === previewClip?.key && previewWindow && timelinePreviewVideoRef.current) {
                  const player = timelinePreviewVideoRef.current;
                  player.currentTime = previewWindow.inSec;
                  const playPromise = player.play();
                  if (playPromise && typeof playPromise.catch === "function") {
                    void playPromise.catch((err) => {
        // Surface Chromium media errors instead of silencing them — the
        // silent .catch pattern was the meta-bug behind Bug 3 / the
        // timeline audio death-spiral. Same shape, applied to App-level
        // <audio>/<video> previews.
        console.warn("[anvil] media play() rejected", { err: (err as { name?: string })?.name || String(err) });
      });
                  }
                }
                setTimelinePlayStopAfterIndex(null);
                setTimelinePlayIndex(first);
                setSelectedIds((current) => ({
                  ...current,
                  timeline: clips[first]?.key || current.timeline,
                }));
                setTimelineIsPlaying(true);
              };
              const stopAssemblyPlayback = () => {
                setTimelineIsPlaying(false);
                setTimelinePlayIndex(null);
                setTimelinePlayStopAfterIndex(null);
              };
              const openSelectedInVideos = () => {
                setProjectContextSelected(false);
                setPinboardSelected(false);
                setSectionFormatSelected(null);
                setSelectedMagicDocId(null);
                setTimelineIsPlaying(false);
                setTimelinePlayIndex(null);
                setTimelinePlayStopAfterIndex(null);
                setActiveSection("videos");
                setExpandedPrimary("workshop");
                setSelectedIds((current) => ({
                  ...current,
                  videos:
                    selectedTimelineClip?.video?.id ||
                    selectedTimelineClip?.promptId ||
                    previewClip?.video?.id ||
                    previewClip?.promptId ||
                    "master",
                }));
              };
              const resetTimelineOrder = () => {
                if (!project) return;
                setReorderId(null);
                setReorderHoverId(null);
                setTimelinePlayIndex(null);
                setTimelineIsPlaying(false);
                setTimelinePlayStopAfterIndex(null);
                setNotice("Timeline reset to script order.", "info", {
                  category: "timeline",
                  action: { label: "Open timeline", target: { kind: "section", section: "timeline" } },
                  dedupeKey: "timeline:reset-order",
                });
                queueSave({ ...project, timeline: [] });
              };

              const focusedTimelineClip = selectedTimelineClip || previewClip || null;
              const saveTimelineClips = (
                nextClips: TimelineAssemblyClip[],
                nextSelectedKey: string | null,
                message: string,
              ) => {
                if (!project) return;
                timelineResolvedClipsRef.current = nextClips;
                setTimelineIsPlaying(false);
                setTimelinePlayIndex(null);
                setTimelinePlayStopAfterIndex(null);
                if (nextSelectedKey !== null) {
                  setSelectedIds((current) => ({
                    ...current,
                    timeline: nextSelectedKey,
                  }));
                }
                queueSave({
                  ...project,
                  timeline: buildPersistedTimelineFromClips(nextClips),
                });
                setNotice(message, "info", {
                  category: "timeline",
                  visibility: "log",
                  importance: "low",
                });
              };
              const duplicateTimelineClip = (clipKey: string) => {
                const targetIndex = clips.findIndex((clip) => clip.key === clipKey);
                const targetClip = targetIndex >= 0 ? clips[targetIndex] : null;
                if (!targetClip?.video) return;
                const persistedId = crypto.randomUUID();
                const duplicateClip: TimelineAssemblyClip = {
                  ...targetClip,
                  key: persistedId,
                  persistedId,
                  enabled: true,
                };
                const nextClips = [...clips];
                nextClips.splice(targetIndex + 1, 0, duplicateClip);
                saveTimelineClips(nextClips, persistedId, "Duplicated clip.");
              };
              const removeTimelineClip = (clipKey: string) => {
                if (!project) return;
                const targetIndex = clips.findIndex((clip) => clip.key === clipKey);
                if (targetIndex < 0) return;
                const nextVisibleClip =
                  clips.slice(targetIndex + 1).find((clip) => clip.enabled !== false) ||
                  clips.slice(0, targetIndex).reverse().find((clip) => clip.enabled !== false) ||
                  null;
                const nextClips = clips.map((clip) => {
                  if (clip.key !== clipKey) return clip;
                  const persistedId = clip.persistedId || crypto.randomUUID();
                  return {
                    ...clip,
                    key: persistedId,
                    persistedId,
                    enabled: false,
                  };
                });
                saveTimelineClips(nextClips, nextVisibleClip?.key || "", "Removed clip from timeline.");
              };
              const splitTimelineClipAtPlayhead = (clipKey: string) => {
                if (!project) return;
                const targetClip = clips.find((clip) => clip.key === clipKey) || null;
                if (!targetClip?.video || targetClip.enabled === false) return;
                const fullDurationSec = Math.max(
                  0,
                  Number(targetClip.video.durationSec) || Number(targetClip.durationSec) || 0,
                );
                if (fullDurationSec <= 0.5) {
                  setNotice("This clip is too short to split.", "info", {
                    category: "timeline",
                    visibility: "log",
                    importance: "low",
                  });
                  return;
                }
                const currentWindow = effectiveTimelineWindow(
                  fullDurationSec,
                  targetClip.trimInSec,
                  targetClip.trimOutSec,
                );
                const minimumSideSec = 0.35;
                if (currentWindow.outSec - currentWindow.inSec <= minimumSideSec * 2) {
                  setNotice("Trimmed window is too short to split again.", "info", {
                    category: "timeline",
                    visibility: "log",
                    importance: "low",
                  });
                  return;
                }
                const previewPlayer = timelinePreviewVideoRef.current;
                const rawCutSec =
                  previewClip?.key === clipKey && previewPlayer
                    ? previewPlayer.currentTime
                    : currentWindow.inSec + (currentWindow.outSec - currentWindow.inSec) / 2;
                const cutSec = roundTimelineSec(
                  Math.max(
                    currentWindow.inSec + minimumSideSec,
                    Math.min(currentWindow.outSec - minimumSideSec, Number(rawCutSec) || 0),
                  ),
                );
                if (
                  cutSec <= currentWindow.inSec + 0.05 ||
                  cutSec >= currentWindow.outSec - 0.05
                ) {
                  setNotice("Move the playhead farther from the clip edge before cutting.", "info", {
                    category: "timeline",
                    visibility: "log",
                    importance: "low",
                  });
                  return;
                }

                setTimelineIsPlaying(false);
                setTimelinePlayIndex(null);
                setTimelinePlayStopAfterIndex(null);

                const firstId = targetClip.persistedId || crypto.randomUUID();
                const secondId = crypto.randomUUID();
                const nextClips = clips.flatMap((clip) => {
                  if (clip.key !== clipKey) return [clip];
                  return [
                    {
                      ...clip,
                      key: firstId,
                      persistedId: firstId,
                      trimInSec: normalizedTimelineTrimIn(currentWindow.inSec),
                      trimOutSec: normalizedTimelineTrimOut(cutSec, fullDurationSec),
                    },
                    {
                      ...clip,
                      key: secondId,
                      persistedId: secondId,
                      trimInSec: normalizedTimelineTrimIn(cutSec),
                      trimOutSec: normalizedTimelineTrimOut(currentWindow.outSec, fullDurationSec),
                    },
                  ];
                });
                timelineResolvedClipsRef.current = nextClips;
                setSelectedIds((current) => ({
                  ...current,
                  timeline: secondId,
                }));
                queueSave({
                  ...project,
                  timeline: buildPersistedTimelineFromClips(nextClips),
                });
                setNotice(`Cut clip at ${cutSec.toFixed(1)}s.`, "success", {
                  category: "timeline",
                  visibility: "log",
                  importance: "low",
                });
              };

              const timelinePreviewMessage =
                clips.length === 0
                  ? "No clips yet."
                  : previewClip && !previewClip.video
                    ? "This slot has no take."
                    : playableClips.length === 0
                      ? clips.some((clip) => clip.video)
                        ? "All clips are skipped."
                        : "No playable takes yet."
                      : "Select a clip.";

              const exportAssembly = async () => {
                if (!projectDir || !window.forgeDesktop?.exportTimeline) return;
                setError(null);
                const exportClips = clips
                  .filter((c) => c.enabled !== false && c.video && c.video.path)
                  .map((c) => ({
                    videoPath: c.video!.path,
                    inSec: c.trimInSec ?? null,
                    outSec: c.trimOutSec ?? null,
                  }));
                if (exportClips.length === 0) {
                  setNotice("No rendered clips to export yet.", "info");
                  return;
                }
                setNotice(`Exporting ${exportClips.length} clips… ffmpeg may take a minute.`);
                try {
                  const result = await window.forgeDesktop.exportTimeline(
                    projectDir,
                    exportClips,
                  );
                  setNotice(`Exported to ${result.path}`, "success", {
                    category: "timeline",
                    action: { label: "Reveal", target: { kind: "revealPath", relativePath: result.path } },
                    dedupeKey: `timeline:export:${result.path}`,
                  });
                  if (window.forgeDesktop?.revealPath) {
                    void window.forgeDesktop.revealPath(projectDir, result.path);
                  }
                } catch (err) {
                  setError(`Export failed: ${(err as Error).message}`);
                }
              };
              const focusedClipRuntime = focusedTimelineClip
                ? timelinePlayableDuration(focusedTimelineClip)
                : 0;
              const focusedClipWindow =
                focusedTimelineClip && focusedTimelineClip.video
                  ? effectiveTimelineWindow(
                      Math.max(
                        0,
                        Number(focusedTimelineClip.video.durationSec) || Number(focusedTimelineClip.durationSec) || 0,
                      ),
                      focusedTimelineClip.trimInSec,
                      focusedTimelineClip.trimOutSec,
                    )
                  : null;
              const canSplitFocusedClip = Boolean(
                focusedTimelineClip?.video &&
                focusedTimelineClip.enabled !== false &&
                !timelineIsPlaying &&
                focusedClipWindow &&
                focusedClipWindow.outSec - focusedClipWindow.inSec > 0.75,
              );
              return (
                <div className="timeline-workspace">
                  <div className="timeline-toolbar">
                    <div className="timeline-toolbar-meta">
                      <span className="timeline-toolbar-label">Timeline</span>
                      <span className="timeline-toolbar-stat is-primary">{formatMmSs(totalRuntime)}</span>
                      <span className="timeline-toolbar-stat">
                        {playableClips.length} clip{playableClips.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    <div className="timeline-toolbar-actions">
                      <button
                        type="button"
                        className="ghost-btn compact"
                        onClick={timelineIsPlaying ? stopAssemblyPlayback : startAssemblyPlayback}
                        disabled={playableIndexes.length === 0}
                        title={
                          playableIndexes.length === 0
                            ? "Render at least one take to play the assembly"
                            : timelineIsPlaying
                              ? "Stop assembly playback"
                              : "Play all clips in order"
                        }
                      >
                        {timelineIsPlaying ? "Stop" : "Play"}
                      </button>
                      <button
                        type="button"
                        className="ghost-btn compact"
                        onClick={openSelectedInVideos}
                        title={
                          selectedVideo
                            ? "Open this take in Videos"
                            : "Open Videos to import or choose takes"
                        }
                      >
                        Video Bin
                      </button>
                      {hasPersistedTimeline ? (
                        <button
                          type="button"
                          className="ghost-btn compact"
                          onClick={resetTimelineOrder}
                          title="Restore script-order timeline"
                        >
                          Reset
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="ghost-btn compact"
                        onClick={() => void exportAssembly()}
                        disabled={playableIndexes.length === 0 || !projectDir}
                        title={
                          playableIndexes.length === 0
                            ? "No clips to export yet"
                            : "Render the full timeline to assets/exports/ via ffmpeg"
                        }
                      >
                        Export
                      </button>
                    </div>
                  </div>

                  <div className="timeline-layout timeline-layout-simple">
                    <div className="timeline-main">
                      <div className="timeline-preview-zone">
                        {selectedVideo && projectDir ? (
                          <>
                            <video
                              ref={timelinePreviewVideoRef}
                              key={previewClip?.key || selectedVideo.id}
                              className="video-preview-player"
                              src={indexMediaSrc(projectDir, selectedVideo.path, mediaRefreshKey)}
                              controls
                              preload="metadata"
                              autoPlay={timelineIsPlaying}
	                              onLoadedMetadata={(event) => {
                                if (!previewWindow) return;
                                const player = event.currentTarget;
                                const outsideWindow =
                                  player.currentTime < previewWindow.inSec ||
                                  (previewWindow.outSec > previewWindow.inSec &&
                                    player.currentTime >= previewWindow.outSec - 0.05);
                                if (timelineIsPlaying || outsideWindow) {
                                  player.currentTime = previewWindow.inSec;
                                }
                              }}
                              onTimeUpdate={(event) => {
                                if (!timelineIsPlaying || !previewWindow) return;
                                if (previewWindow.outSec > 0 && event.currentTarget.currentTime >= previewWindow.outSec) {
                                  event.currentTarget.pause();
                                  advancePlayhead();
                                }
                              }}
                              onEnded={() => {
                                if (timelineIsPlaying) advancePlayhead();
                              }}
                            />
                            <div className="video-preview-meta timeline-preview-meta">
                              <div className="timeline-preview-meta-copy">
                                <span>{previewClip?.sceneTitle}</span>
                                <span className="videos-preview-sep">·</span>
                                <span>{previewClip?.shotTitle}</span>
                                {previewClip?.segmentCount && previewClip.segmentCount > 1 ? (
                                  <>
                                    <span className="videos-preview-sep">·</span>
                                    <span>
                                      Part {previewClip.segmentIndex}/{previewClip.segmentCount}
                                    </span>
                                  </>
                                ) : null}
                                {selectedRuntime > 0 ? (
                                  <>
                                    <span className="videos-preview-sep">·</span>
                                    <span>{formatMmSs(selectedRuntime)}</span>
                                  </>
                                ) : null}
                                {previewWindow && (previewWindow.inSec > 0 || previewWindow.outSec < (Number(previewClip?.video?.durationSec) || Number(previewClip?.durationSec) || 0)) ? (
                                  <>
                                    <span className="videos-preview-sep">·</span>
                                    <span>
                                      {previewWindow.inSec.toFixed(1)}-{previewWindow.outSec.toFixed(1)}s
                                    </span>
                                  </>
                                ) : null}
                              </div>
                            </div>
                          </>
                        ) : (
                          <div className="timeline-preview-empty">
                            {timelinePreviewMessage}
                          </div>
                        )}
                      </div>

                      <div className="timeline-assembly">
                        <div className="timeline-assembly-head">
                          <div className="timeline-assembly-title">Sequence</div>
                        </div>

                        <div className="timeline-track-row">
                          <div className="timeline-track-clips">
                        {visibleTimelineClips.length === 0 ? (
                          <div className="timeline-track-empty">
                            No sequence yet. Open Video Bin to import and choose takes.
                          </div>
                        ) : (
                          visibleTimelineClips.map((clip) => {
                            const isActive =
                              (selectedTimelineClip || previewClip)?.key === clip.key;
                            const clipRuntime = clip.video ? timelinePlayableDuration(clip) : 0;
                            const widthPct =
                              totalRuntime > 0
                                ? Math.max(4, Math.round((Math.max(clipRuntime, 0.5) / totalRuntime) * 100))
                                : Math.max(4, Math.round(100 / Math.max(1, visibleTimelineClips.length)));
                            const thumbSrc =
                              clip.video && projectDir
                                ? indexMediaSrc(projectDir, clip.video.path, mediaRefreshKey)
                                : "";
                            const isTrimming =
                              draggingTrim?.videoId === clip.video?.id &&
                              draggingTrim?.clipKey === clip.key;
                            const dragPreview = isTrimming ? draggingTrim : null;
                            const fullDur =
                              Number(clip.video?.durationSec) || clip.durationSec || 0;
                            const currentWindow = effectiveTimelineWindow(
                              fullDur,
                              clip.trimInSec,
                              clip.trimOutSec,
                            );
                            const displayInSec = dragPreview
                              ? dragPreview.previewInSec
                              : currentWindow.inSec;
                            const displayOutSec = dragPreview
                              ? dragPreview.previewOutSec
                              : currentWindow.outSec;
                            const trimmed =
                              fullDur > 0 &&
                              (displayInSec > 0.05 || displayOutSec < fullDur - 0.05);
                            const trimInPct =
                              fullDur > 0 ? Math.max(0, (displayInSec / fullDur) * 100) : 0;
                            const trimOutPct =
                              fullDur > 0
                                ? Math.min(100, (displayOutSec / fullDur) * 100)
                                : 100;
                            const startTrim = (edge: "in" | "out") =>
                              (event: React.MouseEvent<HTMLSpanElement>) => {
                                if (!clip.video || fullDur <= 0.25) return;
                                event.preventDefault();
                                event.stopPropagation();
                                const parent = event.currentTarget.parentElement as HTMLElement | null;
                                const rect = parent?.getBoundingClientRect();
                                const clipWidthPx = rect?.width || 1;
                                setDraggingTrim({
                                  clipKey: clip.key,
                                  videoId: clip.video.id,
                                  edge,
                                  startX: event.clientX,
                                  initialInSec: currentWindow.inSec,
                                  initialOutSec: currentWindow.outSec,
                                  fullDurationSec: fullDur,
                                  clipWidthPx,
                                  previewInSec: currentWindow.inSec,
                                  previewOutSec: currentWindow.outSec,
                                });
                              };
                            const onDropAt = (targetKey: string) => {
                              if (!reorderId || reorderId === targetKey || !project) return;
                              const fromIdx = clips.findIndex((item) => item.key === reorderId);
                              const toIdx = clips.findIndex((item) => item.key === targetKey);
                              if (fromIdx < 0 || toIdx < 0) return;
                              const next = [...clips];
                              const [moved] = next.splice(fromIdx, 1);
                              next.splice(toIdx, 0, moved);
                              setReorderId(null);
                              setReorderHoverId(null);
                              timelineResolvedClipsRef.current = next;
                              queueSave({
                                ...project,
                                timeline: buildPersistedTimelineFromClips(next),
                              });
                            };
                            return (
                              <button
                                key={clip.key}
                                type="button"
                                draggable={Boolean(clip.video)}
                                className={[
                                  "timeline-track-clip",
                                  clip.video ? "has-video" : "is-gap",
                                  clip.enabled === false ? "is-omitted" : "",
                                  isActive ? "active" : "",
                                  reorderId === clip.key ? "is-dragging" : "",
                                  reorderHoverId === clip.key && reorderId && reorderId !== clip.key
                                    ? "is-drop-target"
                                    : "",
                                ]
                                  .filter(Boolean)
                                  .join(" ")}
                                style={{ flexBasis: `${widthPct}%` }}
                                title={`${clip.sceneTitle} · ${clip.shotTitle}${clip.enabled === false ? " · skipped" : ""}${clipRuntime ? ` · ${formatMmSs(clipRuntime)}` : ""}${trimmed ? ` · trim ${displayInSec.toFixed(1)}-${displayOutSec.toFixed(1)}s` : ""}`}
                                onClick={() => selectTimelineClip(clip.key)}
                                onDragStart={(event) => {
                                  if (!clip.video) {
                                    event.preventDefault();
                                    return;
                                  }
                                  setReorderId(clip.key);
                                  event.dataTransfer.effectAllowed = "move";
                                  event.dataTransfer.setData("text/plain", clip.key);
                                }}
                                onDragOver={(event) => {
                                  if (!reorderId || reorderId === clip.key) return;
                                  event.preventDefault();
                                  event.dataTransfer.dropEffect = "move";
                                  setReorderHoverId(clip.key);
                                }}
                                onDragLeave={() => {
                                  setReorderHoverId((current) =>
                                    current === clip.key ? null : current,
                                  );
                                }}
                                onDrop={(event) => {
                                  event.preventDefault();
                                  onDropAt(clip.key);
                                }}
                                onDragEnd={() => {
                                  setReorderId(null);
                                  setReorderHoverId(null);
                                }}
                              >
                                {clip.video ? (
                                  <>
                                    <video
                                      className="timeline-track-clip-thumb"
                                      src={thumbSrc}
                                      preload="metadata"
                                      muted
                                      playsInline
                                    />
                                    {trimmed ? (
                                      <div
                                        className="timeline-track-clip-trim-band"
                                        style={{
                                          left: `${trimInPct}%`,
                                          right: `${100 - trimOutPct}%`,
                                        }}
                                        aria-hidden="true"
                                      />
                                    ) : null}
                                    {fullDur > 0.25 ? (
                                      <>
                                        <span
                                          className="timeline-track-trim-handle left"
                                          aria-hidden="true"
                                          onMouseDown={startTrim("in")}
                                          onClick={(event) => event.stopPropagation()}
                                        />
                                        <span
                                          className="timeline-track-trim-handle right"
                                          aria-hidden="true"
                                          onMouseDown={startTrim("out")}
                                          onClick={(event) => event.stopPropagation()}
                                        />
                                      </>
                                    ) : null}
                                  </>
                                ) : (
                                  <div className="timeline-track-clip-gap">
                                    <span>+</span>
                                  </div>
                                )}
                                <div className="timeline-track-clip-label">
                                  <span className="timeline-track-clip-shot">
                                    {clip.shotTitle}
                                  </span>
                                  <span className="timeline-track-clip-meta">
                                    {clip.enabled === false ? (
                                      <span className="timeline-track-clip-state">Skip</span>
                                    ) : null}
                                    {clipRuntime > 0 ? (
                                      <span className="timeline-track-clip-dur">
                                        {formatMmSs(clipRuntime)}
                                      </span>
                                    ) : null}
                                  </span>
                                </div>
                              </button>
                            );
                          })
                        )}
                          </div>
                        </div>
                      </div>

                      <div className="timeline-clip-manager">
                        {focusedTimelineClip ? (
                          <>
                            <div className="timeline-clip-manager-copy">
                              <div className="timeline-clip-manager-title">
                                {focusedTimelineClip.video ? "Selected clip" : "Missing take"}
                              </div>
                              <div className="timeline-clip-manager-meta">
                                <span>{focusedTimelineClip.sceneTitle}</span>
                                <span className="videos-preview-sep">·</span>
                                <span>{focusedTimelineClip.shotTitle}</span>
                                {focusedTimelineClip.segmentCount && focusedTimelineClip.segmentCount > 1 ? (
                                  <>
                                    <span className="videos-preview-sep">·</span>
                                    <span>
                                      Part {focusedTimelineClip.segmentIndex}/{focusedTimelineClip.segmentCount}
                                    </span>
                                  </>
                                ) : null}
                                {focusedClipRuntime > 0 ? (
                                  <>
                                    <span className="videos-preview-sep">·</span>
                                    <span>{formatMmSs(focusedClipRuntime)}</span>
                                  </>
                                ) : null}
                                {focusedClipWindow && focusedTimelineClip.video ? (
                                  <>
                                    <span className="videos-preview-sep">·</span>
                                    <span>
                                      {focusedClipWindow.inSec.toFixed(1)}-{focusedClipWindow.outSec.toFixed(1)}s
                                    </span>
                                  </>
                                ) : null}
                                {focusedTimelineClip.video && focusedTimelineClip.enabled === false ? (
                                  <>
                                    <span className="videos-preview-sep">·</span>
                                    <span>Skipped</span>
                                  </>
                                ) : null}
                              </div>
                            </div>
                            <div className="timeline-clip-manager-actions">
                              {focusedTimelineClip.video ? (
                                <>
                                  <button
                                    type="button"
                                    className="ghost-btn compact"
                                    onClick={() => splitTimelineClipAtPlayhead(focusedTimelineClip.key)}
                                    disabled={!canSplitFocusedClip}
                                    title={
                                      canSplitFocusedClip
                                        ? "Split the selected clip at the preview playhead"
                                        : timelineIsPlaying
                                          ? "Stop playback before cutting a clip"
                                          : "Clip is too short to split"
                                    }
                                  >
                                    Cut
                                  </button>
                                  <button
                                    type="button"
                                    className="ghost-btn compact"
                                    onClick={() => duplicateTimelineClip(focusedTimelineClip.key)}
                                  >
                                    Duplicate
                                  </button>
                                  <button
                                    type="button"
                                    className="ghost-btn compact"
                                    onClick={() => removeTimelineClip(focusedTimelineClip.key)}
                                  >
                                    Remove
                                  </button>
                                  <button
                                    type="button"
                                    className="ghost-btn compact"
                                    onClick={openSelectedInVideos}
                                  >
                                    Video Bin
                                  </button>
                                </>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    className="ghost-btn compact"
                                    onClick={openSelectedInVideos}
                                  >
                                    Add take
                                  </button>
                                  <button
                                    type="button"
                                    className="ghost-btn compact"
                                    onClick={() => jumpToAsset("prompts", focusedTimelineClip.promptId)}
                                  >
                                    Prompt
                                  </button>
                                </>
                              )}
                            </div>
                          </>
                        ) : (
                          <div className="timeline-clip-manager-empty">
                            Select a clip from the sequence.
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })()
          ) : activeSection === "dialogue" ? (
            <div className="empty-panel dialogue-empty-panel">
              <div className="dialogue-empty-title">No dialogue doc yet</div>
              <div className="dialogue-empty-copy">
                One film-level doc grouped by scene and shot.
              </div>
              <button
                className="primary-btn"
                type="button"
                onClick={() => openOrCreateDialogueDoc()}
              >
                Create dialogue doc
              </button>
            </div>
          ) : (
            <div className="empty-panel">Create or select an item to begin.</div>
          )}
          {!projectContextSelected && !pinboardSelected && !sectionFormatSelected && selectedItem && (activeSection === "script" || activeSection === "dialogue" || activeSection === "prompts") ? (
            // Master script = top-level overview → show compact asset
            // counts only (characters / locations / props / keyframes
            // / audio). Thumbnails are noise at this zoom level. For
            // scenes/dialogue/beats/shots/prompts, show the full linked-asset rail
            // since the entity identity matters there.
            (activeSection === "script" && "kind" in selectedItem && (selectedItem as ScriptEntry).kind === "master") ? (
              <MasterScriptAssetCounts project={project} onOpen={(section) => jumpToAsset(section, selectedIds[section] || "")} />
            ) : (
              <LinkedAssetRail
                entityRefs={(selectedItem as ScriptEntry | DialogueEntry | PromptEntry).entityRefs}
                suppressedRefs={(selectedItem as ScriptEntry | DialogueEntry | PromptEntry).suppressedRefs}
                project={project}
                refs={(selectedItem as ScriptEntry | DialogueEntry | PromptEntry).assetRefs}
                bodyText={selectedItem?.content || ""}
                ignoreMarkdownHeadings={activeSection === "dialogue"}
                brokenMediaIds={brokenMediaIds}
                mediaRefreshKey={mediaRefreshKey}
                onJumpTo={jumpToAsset}
                onAddRef={(section, assetId) => {
                  const refSection = section as EntityRef["section"];
                  const current = ((selectedItem as ScriptEntry | DialogueEntry | PromptEntry).entityRefs || []) as EntityRef[];
                  if (current.some((r) => r.section === refSection && r.entityId === assetId)) return;
                  const suppressed = ((selectedItem as ScriptEntry | DialogueEntry | PromptEntry).suppressedRefs || []) as SuppressedRef[];
                  const nextSuppressed = suppressed.filter((r) => !(r.section === refSection && r.entityId === assetId));
                  const nextRefs = [...current, { entityId: assetId, section: refSection, role: "featured" as EntityRefRole }];
                  if (nextSuppressed.length === suppressed.length) {
                    patchSelectedMeta({ entityRefs: nextRefs });
                  } else {
                    patchSelectedMeta({ entityRefs: nextRefs, suppressedRefs: nextSuppressed });
                  }
                }}
                onAddRefs={(refs) => {
                  const current = ((selectedItem as ScriptEntry | DialogueEntry | PromptEntry).entityRefs || []) as EntityRef[];
                  const existing = new Set(current.map((r) => `${r.section}:${r.entityId}`));
                  const newRefs = refs
                    .filter(({ section, assetId }) => !existing.has(`${section}:${assetId}`))
                    .map(({ section, assetId }) => ({
                      entityId: assetId,
                      section: section as EntityRef["section"],
                      role: "featured" as EntityRefRole,
                    }));
                  if (!newRefs.length) return;
                  const addedKeys = new Set(newRefs.map((ref) => `${ref.section}:${ref.entityId}`));
                  const suppressed = ((selectedItem as ScriptEntry | DialogueEntry | PromptEntry).suppressedRefs || []) as SuppressedRef[];
                  const nextSuppressed = suppressed.filter((ref) => !addedKeys.has(`${ref.section}:${ref.entityId}`));
                  if (nextSuppressed.length === suppressed.length) {
                    patchSelectedMeta({ entityRefs: [...current, ...newRefs] });
                  } else {
                    patchSelectedMeta({ entityRefs: [...current, ...newRefs], suppressedRefs: nextSuppressed });
                  }
                  setNotice(`Auto-linked ${newRefs.length} asset${newRefs.length === 1 ? "" : "s"} from body text.`);
                }}
                onRemoveRef={(section, assetId) => {
                  const current = ((selectedItem as ScriptEntry | DialogueEntry | PromptEntry).entityRefs || []) as EntityRef[];
                  const nextAssetRefs = removeLegacyAssetRef(
                    (selectedItem as ScriptEntry | DialogueEntry | PromptEntry).assetRefs,
                    section as EntityRef["section"],
                    assetId,
                  );
                  patchSelectedMeta({
                    entityRefs: current.filter((r) => !(r.section === section && r.entityId === assetId)),
                    assetRefs: nextAssetRefs,
                  });
                }}
                onSuppressRef={(section, assetId) => {
                  const current = ((selectedItem as ScriptEntry | DialogueEntry | PromptEntry).suppressedRefs || []) as SuppressedRef[];
                  if (current.some((r) => r.section === section && r.entityId === assetId)) return;
                  patchSelectedMeta({
                    suppressedRefs: [...current, { entityId: assetId, section }],
                  });
                }}
                onChipContextMenu={(section, assetId, x, y) => {
                  setLinkedChipContextMenu({ section, assetId, x, y });
                }}
              />
            )
          ) : null}
        </main>
        )}

        {/* Draggable divider between editor and project terminal (hidden when collapsed) */}
        {SHOW_PROJECT_TERMINAL_SURFACE && !chatCollapsed ? (
          <div
            className={`col-divider col-divider-chat${draggingDivider === "chat" ? " active" : ""}`}
            style={{ right: `${chatWidth - 3}px` }}
            onMouseDown={(e) => startDividerDrag("chat", e)}
            role="separator"
            aria-label="Resize terminal pane"
            aria-orientation="vertical"
            title="Drag to resize"
          >
            <span className="col-divider-grip" aria-hidden="true" />
          </div>
        ) : null}

        {SHOW_AGENT_SURFACE ? (
        <aside className={`chat-pane${inFlightRequestId ? " working" : ""}`}>
          <div className="chat-thread-head">
            <div className="chat-thread-head-copy">
              <div className="chat-thread-title-row">
                <div className="header-menu chat-avatar-menu" ref={avatarMenuRef}>
                  <button
                    className={`avatar-picker-trigger icon-hover-tooltip tooltip-bottom${showAvatarMenu ? " open" : ""}`}
                    type="button"
                    onClick={() => setShowAvatarMenu((current) => !current)}
                    data-tooltip="Agent avatar"
                    aria-label="Choose agent avatar"
                    aria-haspopup="menu"
                    aria-expanded={showAvatarMenu}
                  >
                    <span className="avatar-picker-trigger-art">
                      <AnvilMark size={36} variant="director" avatarId={agentAvatar} />
                    </span>
                  </button>
                  {showAvatarMenu ? (
                    <div
                      className="header-menu-popover avatar-menu-popover"
                      role="menu"
                      aria-label="Agent avatars"
                      onKeyDown={handleMenuNavigation}
                    >
                      {AGENT_AVATAR_OPTIONS.map((option) => (
                        <button
                          key={option.id}
                          className={`header-menu-item avatar-menu-item${agentAvatar === option.id ? " active" : ""}`}
                          type="button"
                          role="menuitemradio"
                          aria-checked={agentAvatar === option.id}
                          onClick={() => {
                            setAgentAvatar(option.id);
                            setShowAvatarMenu(false);
                          }}
                        >
                          <span className="avatar-menu-preview">
                            <AnvilMark size={34} variant="director" avatarId={option.id} />
                          </span>
                          <span className="avatar-menu-copy">
                            <span className="avatar-menu-label">{option.label}</span>
                          </span>
                          {agentAvatar === option.id ? <span className="avatar-menu-check">Selected</span> : null}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="chat-thread-title-block">
                  <div className="chat-thread-title">Agent</div>
                  <div className="chat-thread-sub">
                    {agentRuntimeLabel(project.settings, latestAgentMeta)}
                  </div>
                </div>
              </div>
              {focusScope.kind !== "none" ? (
                <button
                  className={`chat-lock-indicator lock-${evaluateLockVisual(focusScope, selectedItem?.path)}`}
                  onClick={() => setFocusScope({ kind: "none" })}
                  aria-label={`Release ${shortLockLabel(focusScope)} focus lock`}
                  title="Click to release lock"
                  type="button"
                >
                  <LockClosedIcon />
                  <span>{shortLockLabel(focusScope)}</span>
                </button>
              ) : null}
            </div>
            <div className="chat-thread-actions">
              <button
                className={`chat-scope-trigger${scopeIntakeOpen ? " active" : ""}`}
                type="button"
                onClick={() => setScopeIntakeOpen((current) => !current)}
                disabled={chatLoading}
              >
                Scope
              </button>
              {/* Chat-options menu unified with hide-chat button. The
                  HideChatIcon is the trigger; clicking opens a small
                  popover with Hide / Compact / Clear. When there's no
                  history, only Hide is available (as a direct click). */}
              {combinedChatHistory.length ? (
                <div className="header-menu chat-thread-menu" ref={chatMenuRef}>
                  <button
                    className="ghost-btn compact icon-btn header-menu-trigger chat-thread-menu-trigger icon-hover-tooltip tooltip-bottom"
                    type="button"
                    onClick={() => setShowChatMenu((current) => !current)}
                    data-tooltip="Chat options"
                    aria-label="Chat view options"
                    aria-haspopup="menu"
                    aria-expanded={showChatMenu}
                  >
                    <HideChatIcon />
                  </button>
                  {showChatMenu ? (
                    <div
                      className="header-menu-popover chat-thread-menu-popover"
                      role="menu"
                      aria-label="Chat view options"
                      onKeyDown={handleMenuNavigation}
                    >
                      <button
                        className="header-menu-item"
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setShowChatMenu(false);
                          setChatCollapsed(true);
                        }}
                      >
                        Hide chat
                      </button>
                      {combinedChatHistory.length > 4 ? (
                        <button
                          className="header-menu-item"
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setShowChatMenu(false);
                            setCompactChat((v) => !v);
                          }}
                        >
                          {compactChat ? `Show all (${combinedChatHistory.length})` : "Compact history"}
                        </button>
                      ) : null}
                      <button
                        className="header-menu-item"
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setShowChatMenu(false);
                          void clearChat();
                        }}
                      >
                        Clear chat
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : (
                <button
                  className="ghost-btn compact icon-btn icon-hover-tooltip tooltip-bottom"
                  type="button"
                  onClick={() => setChatCollapsed(true)}
                  data-tooltip="Hide chat"
                  aria-label="Hide chat"
                >
                  <HideChatIcon />
                </button>
              )}
            </div>
          </div>
          <AgentWorkflowProgress state={agentWorkflowState} queuedCount={queuedAgentCount} />
          {scopeIntakeOpen ? (
            <ScopeIntakePanel
              busy={agentBusy || chatLoading}
              draft={scopeIntakeDraft}
              onChange={updateScopeIntakeField}
              onReset={resetScopeIntake}
              onSubmit={submitScopeIntake}
            />
          ) : phaseCheckpoint ? (
            <PhaseCheckpointPanel
              checkpoint={phaseCheckpoint}
              disabled={agentBusy || chatLoading}
              onContinue={continuePhaseCheckpoint}
              onReview={reviewPhaseCheckpoint}
              onRevise={revisePhaseCheckpoint}
            />
          ) : null}
          {/* Chat minimap — colored markers along the right edge let users
              scan message density + jump directly to a turn. */}
          {combinedChatHistory.length > 8 ? (
            <div className="chat-minimap" aria-label="Chat minimap">
              {combinedChatHistory.map((m, idx) => {
                const isUser = m.role === "user";
                const isErr = m.state === "error" || (m.stats?.terminated === "aborted");
                const isPending = m.state === "pending" || m.state === "queued";
                return (
                  <button
                    key={m.id}
                    className={[
                      "chat-minimap-marker",
                      isUser ? "minimap-user" : "minimap-agent",
                      isErr ? "minimap-err" : "",
                      isPending ? "minimap-pending" : "",
                    ].filter(Boolean).join(" ")}
                    style={{ top: `${(idx / Math.max(1, combinedChatHistory.length - 1)) * 100}%` }}
                    onClick={() => {
                      const el = document.querySelector(`[data-message-id="${m.id}"]`);
                      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
                    }}
                    title={`Turn ${idx + 1} · ${isUser ? "you" : "agent"}${isPending ? " · pending" : isErr ? " · error" : ""}`}
                    type="button"
                    aria-label={`Jump to turn ${idx + 1}`}
                  />
                );
              })}
            </div>
          ) : null}
          <div
            className="chat-thread-list"
            ref={chatListRef}
            onScroll={handleChatScroll}
            role="log"
            aria-label="Agent conversation"
            aria-live={inFlightRequestId ? "polite" : "off"}
            aria-relevant="additions"
            aria-busy={chatLoading || Boolean(inFlightRequestId)}
          >
            {chatLoading ? (
              <article className="chat-message assistant">
                <div className="chat-message-head">
                  <div className="chat-role">Agent</div>
                  <div className="chat-meta">Loading session history…</div>
                </div>
              </article>
            ) : !combinedChatHistory.length ? (
              <div className="chat-empty">
                <div className="chat-empty-hint">
                  Ask about <b>{selectedItem ? getEntryLabel(activeSection, selectedItem) : SECTION_LABELS[activeSection]}</b>.
                </div>
                <button
                  className="chat-empty-action"
                  type="button"
                  onClick={() => setScopeIntakeOpen(true)}
                >
                  Add project notes
                </button>
              </div>
            ) : (compactChat && combinedChatHistory.length > 4 ? combinedChatHistory.slice(-4) : combinedChatHistory).map((message) => {
              const shouldCollapse =
                message.state !== "pending" && message.state !== "queued" && messageNeedsCollapse(message.text);
              const isExpanded = Boolean(expandedMessageIds[message.id]);
              const displayText =
                message.state === "pending"
                  ? "Working…"
                  : message.state === "queued"
                    ? message.text
                  : shouldCollapse && !isExpanded
                    ? compactMessagePreview(message.text)
                    : (message.text || "").replace(/\s+$/g, "");
              return (
                <article
                  key={message.id}
                  data-state={message.state || "ready"}
                  data-message-id={message.id}
                  className={`chat-message ${message.role === "user" ? "user" : "assistant"}${message.state === "pending" ? " pending" : ""}${message.state === "queued" ? " queued" : ""}`}
                >
                  <div className="chat-message-head">
                    <div className="chat-role">
                      {message.role === "user" ? (
                        "You"
                      ) : (
                        <>
                          <span className="chat-role-avatar">
                            <AnvilMark
                              size={44}
                              variant={message.state === "pending" ? "idle" : "director"}
                              avatarId={agentAvatar}
                            />
                          </span>
                          <span>Agent</span>
                        </>
                      )}
                    </div>
                    <div className="chat-meta">
                      <time dateTime={message.timestamp} title={formatFullChatTimestamp(message.timestamp)}>
                        {formatChatTimestamp(message.timestamp)}
                      </time>
                      {/* Per-turn implementation details (elapsed, turn count,
                          fallback provenance) moved entirely into the hover
                          title — the chat header already carries the focus-
                          lock indicator, so the per-message line stays quiet. */}
                      {message.role === "assistant" && message.state !== "queued" && message.stats ? (
                        <span
                          className="chat-meta-details"
                          title={[
                            message.stats?.terminated === "aborted"
                              ? "canceled"
                              : message.stats
                                ? `${(message.stats.elapsedMs / 1000).toFixed(1)}s · ${message.stats.turns} turn${message.stats.turns === 1 ? "" : "s"}${message.stats.terminated === "maxTurns" ? " · maxTurns hit" : ""}`
                                : "",
                          ].filter(Boolean).join(" · ")}
                          aria-hidden="true"
                        />
                      ) : null}
                    </div>
                  </div>
                  <div className="chat-message-body">
                    {message.role === "user" && message.hammerAction ? (
                      <div className="hammer-action-wrap">
                        <span className="hammer-action-pill" aria-label={`Agent action: ${message.hammerAction}`}>
                          <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" style={{ verticalAlign: "-1px", marginRight: "4px" }}>
                            <rect x="8" y="3.5" width="10" height="6" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
                            <path d="M12 9.5v11" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                          </svg>
                          {message.hammerAction}
                        </span>
                        {message.text ? (
                          <div className="hammer-action-text">{message.text}</div>
                        ) : null}
                      </div>
                    ) : message.role === "assistant" && message.state !== "pending" && typeof displayText === "string" ? (
                      renderChatTextWithPaths(displayText, jumpToPath)
                    ) : (
                      displayText
                    )}
                  </div>
                  {message.attachments?.length ? (
                    <div className="chat-attachment-strip">
                      {message.attachments.map((attachment) => (
                        <AttachmentChip key={attachment.id} attachment={attachment} />
                      ))}
                    </div>
                  ) : null}
                  {message.activity?.length ? (
                    <ActivityFeed items={message.activity} pending={message.state === "pending"} />
                  ) : null}
                  {message.state === "pending" && message.lastActivityAt
                    ? (() => {
                        const since = Math.max(
                          0,
                          Math.floor((heartbeatNow - message.lastActivityAt) / 1000),
                        );
                        if (since < 10) return null;
                        const stuck = since > 60;
                        return (
                          <div className={`chat-heartbeat${stuck ? " stuck" : ""}`}>
                            {stuck
                              ? `No activity for ${since}s — the model may be stuck. Click Stop if you want to cancel.`
                              : `Working · ${since}s since last activity`}
                          </div>
                        );
                      })()
                    : null}
                  {shouldCollapse ? (
                    <div className="chat-message-toggle">
                      <button
                        className="ghost-btn"
                        onClick={() => toggleMessageExpanded(message.id)}
                        aria-expanded={isExpanded}
                        type="button"
                      >
                        {isExpanded ? "Show less" : "Show more"}
                      </button>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
          <div className={`chat-composer${inFlightRequestId ? " working" : ""}`}>
            {composerAttachments.length ? (
              <div className="chat-attachment-strip composer">
                {composerAttachments.map((attachment) => (
                  <AttachmentChip
                    key={attachment.id}
                    attachment={attachment}
                    onRemove={removeComposerAttachment}
                  />
                ))}
              </div>
            ) : null}
            <div className="chat-composer-row">
              <button
                className="icon-btn chat-attach-btn icon-hover-tooltip tooltip-bottom"
                onClick={() => void uploadChatAttachments()}
                type="button"
                disabled={!handle || busy === "upload"}
                data-tooltip={busy === "upload" ? "Attaching…" : "Attach file"}
                aria-label="Attach file"
              >
                <PlusIcon />
              </button>
              <textarea
                ref={chatInputRef}
                className="chat-composer-input"
                value={chatDraft}
                onChange={(event) => {
                  setChatDraft(event.target.value);
                  const node = event.currentTarget;
                  node.style.height = "auto";
                  node.style.height = `${Math.min(node.scrollHeight, 160)}px`;
                }}
                onFocus={() => setAgentPrimarySelected(true)}
                onKeyDown={handleChatKeyDown}
                aria-label="Message agent"
                name="agent-message"
                autoComplete="off"
                placeholder={
                  agentBusy
                    ? `Queue message${queuedAgentCount ? ` · ${queuedAgentCount} waiting` : ""}…`
                    : "Message agent…"
                }
                rows={1}
                spellCheck={false}
              />
              {/* Queue button removed — press Enter while the agent is
                  running to queue the next message. queueComposerTask
                  is still invoked by handleChatKeyDown when inFlight or
                  queued tasks exist. */}
              <button
                className={[
                  "send-btn",
                  inFlightRequestId ? "is-working" : "",
                  cancelling ? "is-cancelling" : "",
                ].filter(Boolean).join(" ")}
                onClick={() => {
                  if (inFlightRequestId) {
                    // Flip the cancelling latch FIRST so the UI updates
                    // instantly — the main process's abort flow can take
                    // a turn or two to fully unwind a tool call.
                    setCancelling(true);
                    setAgentWorkflowState((current) => ({
                      ...current,
                      phaseMood: "done",
                      phaseVerb: "Stopping",
                      status: "running",
                      updatedAt: Date.now(),
                    }));
                    // Stop means "stop everything". Drain the queue so
                    // the dispatch useEffect doesn't auto-start the next
                    // task the instant the in-flight one aborts.
                    setAgentQueue([]);
                    agentQueueRef.current = [];
                    void window.forgeDesktop.cancelAgent(inFlightRequestId);
                    return;
                  }
                  void askOpenClaw();
                }}
                disabled={
                  (!inFlightRequestId && (sending || chatLoading || queuedAgentCount > 0)) ||
                  Boolean(inFlightRequestId && cancelling)
                }
                aria-label={
                  inFlightRequestId
                    ? "Stop agent run and clear queued tasks"
                    : queuedAgentCount > 0
                      ? `${queuedAgentCount} queued agent task${queuedAgentCount === 1 ? "" : "s"}`
                      : "Send message"
                }
                type="button"
              >
                <span className="send-btn-label">
                  {inFlightRequestId
                    ? (cancelling ? "Cancelling…" : "Stop")
                    : chatLoading ? "…"
                    : sending ? "…"
                    : "Send"}
                </span>
                {/* Phase verb badge dropped — cleaner Stop button while
                    running. Phase mood is still visible via the working
                    pulse on the header anvil mark. */}
              </button>
            </div>
          </div>
        </aside>
        ) : null}
        {SHOW_PROJECT_TERMINAL_SURFACE ? (
          <aside className="chat-pane project-terminal-shell">
            <Suspense fallback={<div className="project-terminal-loading">Loading terminal…</div>}>
              <ProjectTerminalPanel
                projectDir={handle.projectDir}
                projectName={project.project.name}
                onActivityPaths={markTouchedPaths}
                onCollapse={() => setChatCollapsed(true)}
                onError={setError}
                onOpenExternalTerminal={openProjectTerminal}
              />
            </Suspense>
          </aside>
        ) : null}
      </div>

      {showCreateProjectModal ? (
        <Modal
          title="Create local project"
          description="Name the project, then choose a folder."
          onCancel={() => setShowCreateProjectModal(false)}
          onSubmit={() => void submitCreateProject()}
          submitLabel={busy === "create" ? "Creating…" : busy === "create-pick" ? "Choose folder…" : "Continue"}
          submitDisabled={!projectNameDraft.trim() || busy === "create" || busy === "create-pick"}
          submitDisabledReason={!projectNameDraft.trim() ? "Enter a project name to continue." : undefined}
        >
          <Field label="Project name" value={projectNameDraft} onChange={setProjectNameDraft} />
        </Modal>
      ) : null}

      {newDocPrompt ? (
        <Modal
          title="New doc"
          description={`Creates a new markdown file inside ${newDocPrompt.folder}/. The title becomes the slugified filename.`}
          onCancel={() => (newDocPrompt.busy ? undefined : setNewDocPrompt(null))}
          onSubmit={() => void commitNewDoc()}
          submitLabel={newDocPrompt.busy ? "Creating…" : "Create"}
          submitDisabled={!newDocPrompt.draft.trim() || newDocPrompt.busy}
          submitDisabledReason={!newDocPrompt.draft.trim() ? "Title can't be empty." : undefined}
        >
          <Field
            label="Title"
            value={newDocPrompt.draft}
            onChange={(value) =>
              setNewDocPrompt((prev) => (prev ? { ...prev, draft: value } : prev))
            }
          />
        </Modal>
      ) : null}

      {showCreateStoryDocModal ? (() => {
        const customSectionSlug = slugifyContextGroup(storyDocCustomSectionDraft);
        const previewGroup: ContextDocGroup =
          storyDocSectionMode === "new" ? (customSectionSlug || "canon") : storyDocGroupDraft;
        const titleReady = Boolean(storyDocTitleDraft.trim());
        const reservedSection = Boolean(customSectionSlug && RESERVED_CONTEXT_SECTION_SLUGS.has(customSectionSlug));
        const sectionReady = storyDocSectionMode === "existing" || (Boolean(customSectionSlug) && !reservedSection);
        return (
          <Modal
            title="New context doc"
            description="Create a plain markdown doc under Project, Canon, or Asset context, or spin up a clearly named custom section."
            onCancel={() => setShowCreateStoryDocModal(false)}
            onSubmit={() => void submitCreateStoryDoc()}
            submitLabel="Create"
            submitDisabled={!titleReady || !sectionReady}
            submitDisabledReason={
              !titleReady
                ? "Name the document first."
                : reservedSection
                  ? "Project, Canon, and Asset are built-in sections."
                : "Name the new section first."
            }
          >
            <Field label="Document name" value={storyDocTitleDraft} onChange={setStoryDocTitleDraft} />
            <div className="context-doc-destination-group" role="radiogroup" aria-label="Context doc destination">
              {([
                {
                  group: "project" as const,
                  label: "Project",
                  hint: "Workflow rules, priorities, constraints, SOP.",
                },
                {
                  group: "canon" as const,
                  label: "Canon",
                  hint: "Story truth, lore, structure, decisions.",
                },
                {
                  group: "asset" as const,
                  label: "Asset",
                  hint: "Reference rules, look notes, library decisions.",
                },
              ]).map((option) => {
                const checked = storyDocSectionMode === "existing" && storyDocGroupDraft === option.group;
                return (
                  <label
                    key={option.group}
                    className={[
                      "context-doc-destination",
                      checked ? "active" : "",
                    ].filter(Boolean).join(" ")}
                  >
                    <input
                      checked={checked}
                      name="context-doc-destination"
                      onChange={() => {
                        setStoryDocSectionMode("existing");
                        setStoryDocGroupDraft(option.group);
                      }}
                      type="radio"
                    />
                    <span className="context-doc-destination-copy">
                      <strong>{option.label}</strong>
                      <span>{option.hint}</span>
                    </span>
                  </label>
                );
              })}
              <label
                className={[
                  "context-doc-destination",
                  "context-doc-destination-new",
                  storyDocSectionMode === "new" ? "active" : "",
                ].filter(Boolean).join(" ")}
              >
                <input
                  checked={storyDocSectionMode === "new"}
                  name="context-doc-destination"
                  onChange={() => setStoryDocSectionMode("new")}
                  type="radio"
                />
                <span className="context-doc-destination-copy">
                  <strong>New section</strong>
                  <span>Create a fresh sidebar group. Avoid built-in names like Project, Canon, or Asset.</span>
                  {storyDocSectionMode === "new" ? (
                    <input
                      autoFocus
                      className="context-doc-destination-input"
                      placeholder="Section name"
                      value={storyDocCustomSectionDraft}
                      onChange={(e) => setStoryDocCustomSectionDraft(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      type="text"
                    />
                  ) : null}
                </span>
              </label>
            </div>
            <div className="context-doc-path-preview">
              {titleReady && sectionReady
                ? contextDocPathForGroup(previewGroup, storyDocTitleDraft)
                : reservedSection
                  ? "Use the built-in Canon or Asset option, or choose a different custom section name."
                : storyDocSectionMode === "new" && !customSectionSlug
                  ? "Name the new section to preview its markdown path."
                  : "Name the doc to preview its markdown path."}
            </div>
          </Modal>
        );
      })() : null}

      {/* Asset-tile context menu — right-click on a character/location/prop/
          keyframe/audio tile. Scoped to same-section grouping only. */}
      {assetContextMenu ? (() => {
        // Unified right-click menu — Copy / Reveal actions on an asset.
        const assetSection = assetContextMenu.section;
        const asset = assetSection === "media"
          ? ((project?.library || []) as AssetEntry[]).find((a) => a.id === assetContextMenu.assetId) || null
          : ((project?.[assetSection] || []) as AssetEntry[]).find((a) => a.id === assetContextMenu.assetId) || null;
        const firstMedia = asset
          ? firstRenderableAssetMedia(asset.media || [], brokenMediaIds)
          : null;
        const hasImage = Boolean(firstMedia && firstMedia.kind === "image" && firstMedia.path);
        const primaryPath = firstMedia?.path || asset?.path || "";
        const label = asset ? asset.name || asset.title || "Asset" : "Asset";
        return (
          <PositionedContextMenu
            ariaLabel="Asset actions"
            onClose={() => setAssetContextMenu(null)}
            x={assetContextMenu.x}
            y={assetContextMenu.y}
            title={label}
          >
              {hasImage ? (
                <button
                  className="shot-context-menu-item"
                  role="menuitem"
                  type="button"
                  onClick={async () => {
                    setAssetContextMenu(null);
                    if (!handle || !firstMedia?.path) return;
                    try {
                      const result = await window.forgeDesktop.copyImageToClipboard(handle.projectDir, firstMedia.path);
                      if (result.ok) {
                        setNotice(`Copied ${label} to clipboard. ⌘V to paste.`);
                      } else if (result.reason === "too-large") {
                        setNotice(`${label} is too large to copy as an image. Use Copy path instead.`);
                      } else if (result.reason === "missing") {
                        setNotice(`${label}'s file is missing on disk.`);
                      } else {
                        setNotice(`Couldn't copy ${label}: ${result.reason}.`);
                      }
                    } catch (err) {
                      setError(err instanceof Error ? err.message : "Copy failed.");
                    }
                  }}
                >
                  Copy image
                  <span className="shot-context-menu-hint">Paste image</span>
                </button>
              ) : null}
              {primaryPath ? (
                <>
                  <button
                    className="shot-context-menu-item"
                    role="menuitem"
                    type="button"
                    onClick={async () => {
                      setAssetContextMenu(null);
                      await writeClipboardText(primaryPath);
                      setNotice(`Copied path: ${primaryPath}`);
                    }}
                  >
                    Copy path
                    <span className="shot-context-menu-hint">Project path</span>
                  </button>
                  <button
                    className="shot-context-menu-item"
                    role="menuitem"
                    type="button"
                    onClick={async () => {
                      setAssetContextMenu(null);
                      if (!handle) return;
                      try {
                        await window.forgeDesktop.revealPath(handle.projectDir, primaryPath);
                      } catch (err) {
                        setNotice(`Reveal failed: ${(err as Error).message}`);
                      }
                    }}
                  >
                    Reveal in Finder
                    <span className="shot-context-menu-hint">Show file</span>
                  </button>
                  {asset ? <div className="shot-context-menu-divider" /> : null}
                </>
              ) : null}
              {asset ? (
                <>
                  <div className="shot-context-menu-divider" />
                  <button
                    className="shot-context-menu-item danger"
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      requestAssetDelete(assetSection, asset);
                      setAssetContextMenu(null);
                    }}
                  >
                    Delete
                    <span className="shot-context-menu-hint">
                      {assetSection === "media"
                        ? "Remove media entry"
                        : `Remove from ${SECTION_LABELS[assetSection]}`}
                    </span>
                  </button>
                </>
              ) : null}
          </PositionedContextMenu>
        );
      })() : null}

      {linkedChipContextMenu && project ? (() => {
        const { section, assetId, x, y } = linkedChipContextMenu;
        // LinkedAssetRail only surfaces chips for these five sections —
        // "media" chips never reach this menu. Narrowing here keeps
        // project[section] a valid AssetEntry[] lookup.
        if (section === "media") return null;
        const asset = ((project[section] as AssetEntry[]) || []).find((a) => a.id === assetId);
        if (!asset) return null;
        const firstMedia = firstRenderableAssetMedia(asset.media || [], brokenMediaIds);
        const hasImage = Boolean(firstMedia && firstMedia.kind === "image" && firstMedia.path);
        const primaryPath = firstMedia?.path || asset.path || "";
        const label = asset.name || asset.title || "Asset";
        const close = () => setLinkedChipContextMenu(null);
        return (
          <PositionedContextMenu
            ariaLabel="Linked asset actions"
            onClose={close}
            x={x}
            y={y}
            title={label}
          >
            {hasImage ? (
              <button
                className="shot-context-menu-item"
                role="menuitem"
                type="button"
                onClick={async () => {
                  close();
                  if (!handle || !firstMedia?.path) return;
                  try {
                    const result = await window.forgeDesktop.copyImageToClipboard(handle.projectDir, firstMedia.path);
                    if (result.ok) {
                      setNotice(`Copied ${label} to clipboard. ⌘V to paste.`);
                    } else if (result.reason === "too-large") {
                      setNotice(`${label} is too large to copy as an image. Use Copy path instead.`);
                    } else if (result.reason === "missing") {
                      setNotice(`${label}'s file is missing on disk.`);
                    } else {
                      setNotice(`Couldn't copy ${label}: ${result.reason}.`);
                    }
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "Copy failed.");
                  }
                }}
              >
                Copy image
                <span className="shot-context-menu-hint">Paste image</span>
              </button>
            ) : null}
            {primaryPath ? (
              <>
                <button
                  className="shot-context-menu-item"
                  role="menuitem"
                  type="button"
                  onClick={async () => {
                    close();
                    await writeClipboardText(primaryPath);
                    setNotice(`Copied path: ${primaryPath}`);
                  }}
                >
                  Copy path
                  <span className="shot-context-menu-hint">Project-relative path</span>
                </button>
                <button
                  className="shot-context-menu-item"
                  role="menuitem"
                  type="button"
                  onClick={async () => {
                    close();
                    if (!handle) return;
                    try {
                      await window.forgeDesktop.revealPath(handle.projectDir, primaryPath);
                    } catch (err) {
                      setNotice(`Reveal failed: ${(err as Error).message}`);
                    }
                  }}
                >
                  Reveal in Finder
                </button>
              </>
            ) : null}
            <div className="shot-context-menu-divider" />
            <button
              className="shot-context-menu-item"
              role="menuitem"
              type="button"
              onClick={() => {
                close();
                if (!selectedItem) return;
                const current = ((selectedItem as ScriptEntry | DialogueEntry | PromptEntry).entityRefs || []) as EntityRef[];
                const nextAssetRefs = removeLegacyAssetRef(
                  (selectedItem as ScriptEntry | DialogueEntry | PromptEntry).assetRefs,
                  section as EntityRef["section"],
                  assetId,
                );
                patchSelectedMeta({
                  entityRefs: current.filter((r) => !(r.section === section && r.entityId === assetId)),
                  assetRefs: nextAssetRefs,
                });
              }}
            >
              Unlink
              <span className="shot-context-menu-hint">Remove link</span>
            </button>
            <button
              className="shot-context-menu-item"
              role="menuitem"
              type="button"
              onClick={() => {
                close();
                jumpToAsset(section, assetId);
              }}
            >
              Jump to asset
            </button>
          </PositionedContextMenu>
        );
      })() : null}

      {/* "+ Add media" popover — three sources for adding media to the
          currently-selected asset. */}
      {addVariantMenu && selectedAsset ? (
        <PositionedContextMenu
          ariaLabel="Add media"
          onClose={() => setAddVariantMenu(null)}
          x={addVariantMenu.x}
          y={addVariantMenu.y}
          title="Add media"
        >
            <button
              type="button"
              className="shot-context-menu-item"
              role="menuitem"
              onClick={() => {
                setAddVariantMenu(null);
                void uploadAssetMedia();
              }}
            >
              Upload file…
              <span className="shot-context-menu-hint">Pick local files</span>
            </button>
            <button
              type="button"
              className="shot-context-menu-item"
              role="menuitem"
              onClick={() => {
                setAddVariantMenu(null);
                setLibraryPanelOpen(true);
              }}
            >
              Browse library
              <span className="shot-context-menu-hint">Attach existing media</span>
            </button>
            <button
              type="button"
              className="shot-context-menu-item"
              role="menuitem"
              onClick={() => {
                setAddVariantMenu(null);
                const label = selectedAsset.name || selectedAsset.title || "asset";
                const kind = activeSection === "audio" ? "audio" : "image";
                const template = `Draft a ${kind} variant prompt for ${label} (${(SECTION_LABELS[activeSection] || "items").toLowerCase()}): `;
                setChatDraft(template);
                chatInputRef.current?.focus();
                const node = chatInputRef.current;
                if (node) {
                  node.setSelectionRange(template.length, template.length);
                }
              }}
            >
              Draft generation prompt…
              <span className="shot-context-menu-hint">Opens chat draft</span>
            </button>
        </PositionedContextMenu>
      ) : null}

      {showSettingsModal ? (
        <Suspense fallback={null}>
          <SettingsModal
            draft={settingsDraft}
            setDraft={setSettingsDraft}
            onCancel={() => setShowSettingsModal(false)}
            onSubmit={submitSettings}
            agentProviders={agentProviders}
            accountSignedIn={desktopAuthState === "signed-in"}
            accountEmail={DESKTOP_AUTH_PLACEHOLDER_EMAIL}
            accountEntitlement={accountEntitlement}
            onAccountLogin={() => completeDesktopAuth("login")}
            onAccountSignUp={() => completeDesktopAuth("signup")}
            onAccountSignOut={signOutDesktopPlaceholder}
            showAgentSettings={SHOW_AGENT_SURFACE}
          />
        </Suspense>
      ) : null}

      {showSkillLibraryModal && handle?.projectDir ? (
        <Suspense fallback={null}>
          <SkillLibraryModal
            enabledSkillAddons={Array.isArray(project.settings.enabledSkillAddons) ? project.settings.enabledSkillAddons : []}
            disabledSkills={Array.isArray(project.settings.disabledSkills) ? project.settings.disabledSkills : []}
            onCancel={() => setShowSkillLibraryModal(false)}
            onSaveSkillSettings={saveSkillLibrarySettings}
            projectDir={handle.projectDir}
          />
        </Suspense>
      ) : null}

      {showVideoPreviewLightbox && videosWorkspace.previewVideo ? (
        <div
          className="asset-preview-lightbox"
          onClick={() => setShowVideoPreviewLightbox(false)}
          role="dialog"
          aria-modal="true"
          aria-label={`Preview ${videosWorkspace.previewSlot?.promptTitle || `Take ${String(videosWorkspace.previewVideo.takeIndex).padStart(2, "0")}`}`}
          aria-describedby={videoLightboxDescId}
        >
          <div
            className="asset-preview-lightbox-card video-preview-lightbox-card"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="asset-preview-lightbox-head">
              <div className="asset-preview-lightbox-copy">
                <div className="asset-preview-lightbox-title">
                  {videosWorkspace.previewSlot
                    ? `${videosWorkspace.previewSlot.sceneTitle} · ${videosWorkspace.previewSlot.shotTitle}`
                    : "Preview take"}
                </div>
                <div className="asset-preview-lightbox-meta" id={videoLightboxDescId}>
                  {videosWorkspace.previewSlot ? (
                    <>
                      <span>{videosWorkspace.previewSlot.promptTitle}</span>
                      <span className="videos-preview-sep">·</span>
                    </>
                  ) : null}
                  <span>Take {String(videosWorkspace.previewVideo.takeIndex).padStart(2, "0")}</span>
                  {videosWorkspace.previewVideo.durationSec ? (
                    <>
                      <span className="videos-preview-sep">·</span>
                      <span>{videosWorkspace.previewVideo.durationSec}s</span>
                    </>
                  ) : null}
                  <span className="videos-preview-sep">·</span>
                  <span>Space pauses or resumes</span>
                  <span className="videos-preview-sep">·</span>
                  <span>Esc closes</span>
                </div>
              </div>
              <button
                className="ghost-btn compact"
                type="button"
                onClick={() => setShowVideoPreviewLightbox(false)}
              >
                Close
              </button>
            </div>
            <div className="asset-preview-lightbox-body video-preview-lightbox-body">
              <video
                key={videosWorkspace.previewVideo.id}
                ref={videoPreviewLightboxPlayerRef}
                controls
                autoPlay
                playsInline
                preload="auto"
                src={indexMediaSrc(handle.projectDir, videosWorkspace.previewVideo.path, mediaRefreshKey)}
                className="video-preview-lightbox-player"
              />
            </div>
          </div>
        </div>
      ) : null}

      {showAssetPreviewLightbox && mediaPreview && !previewMissing && mediaPreview.kind !== "audio" ? (
        <div
          className="asset-preview-lightbox"
          onClick={() => setShowAssetPreviewLightbox(false)}
          role="dialog"
          aria-modal="true"
          aria-label={`Preview ${mediaPreview.label}`}
          aria-describedby={lightboxDescId}
        >
          <div
            className="asset-preview-lightbox-card"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="asset-preview-lightbox-head">
              <div className="asset-preview-lightbox-copy">
                <div className="asset-preview-lightbox-title">{mediaPreview.label}</div>
                <div className="asset-preview-lightbox-meta" id={lightboxDescId}>
                  {previewIsVideo ? "Video preview" : "Image preview"} · Space / Esc to close
                </div>
              </div>
              <button
                className="ghost-btn compact"
                type="button"
                onClick={() => setShowAssetPreviewLightbox(false)}
              >
                Close
              </button>
            </div>
            <div className="asset-preview-lightbox-body">
              {previewIsVideo ? (
                <video
                  controls
                  autoPlay
                  src={mediaSrc(mediaPreview, mediaRefreshKey)}
                  className="asset-preview-lightbox-media is-video"
                />
              ) : (
                <img
                  src={mediaSrc(mediaPreview, mediaRefreshKey)}
                  alt={mediaPreview.label}
                  className="asset-preview-lightbox-media"
                />
              )}
            </div>
          </div>
        </div>
      ) : null}

      {launchScreen}
    </div>
  );
}
