"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { WorkspaceUser } from "@/lib/workspace-auth";

import {
  ASSET_CATEGORIES,
  CONTEXT_GROUP_ORDER,
  DIALOGUE_DOC_PATH,
  MASTER_SCRIPT_PATH,
  contextGroupLabel,
  fileUrl,
  readScriptChildFromUrl,
} from "../constants";
import type { ChatMessage, StoredAgentMessage } from "../chat/types";
import {
  compareRevisionText,
  type FileRevision,
} from "../right-pane/editor/types";
import { compareProjectFiles } from "./sortNumberedFiles";
import type {
  AssetCard,
  AssetCardSection,
  CloudFile,
  CloudProject,
  FileTreeGroup,
  MediaAsset,
  ScriptChild,
} from "../types";
import { isAssetCardSection } from "../types";
import { uploadWithProgress } from "./uploadWithProgress";
import type { WorkspaceContextValue } from "../WorkspaceProvider";

// Workspace data hook. Owns every piece of state + every async
// handler that used to live inside BrowserProjectWorkspace.tsx,
// so the monolith can drop to a thin shell. Mirrors the
// pre-extraction behavior exactly — no semantic changes in this
// commit. Returns the full WorkspaceContextValue shape.
//
// Per spec acceptance: BrowserProjectWorkspace.tsx ends up under
// 200 LOC and "only does shell + state-provider wiring."

const BUILTIN_CONTEXT_GROUP: Record<string, "project" | "canon" | "asset"> = {
  "story/project-scope.md": "project",
  "story/world-bible.md": "canon",
  "story/asset-context.md": "asset",
};

const IMAGE_EXTENSIONS = new Set(["avif", "bmp", "gif", "heic", "heif", "jpeg", "jpg", "png", "tif", "tiff", "webp"]);
const VIDEO_EXTENSIONS = new Set(["avi", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "webm"]);
const AUDIO_EXTENSIONS = new Set(["aac", "aif", "aiff", "flac", "m4a", "mp3", "ogg", "opus", "wav", "weba"]);

function contextGroupFor(file: CloudFile): string | null {
  if (file.contextGroup) return file.contextGroup;
  if (BUILTIN_CONTEXT_GROUP[file.path]) return BUILTIN_CONTEXT_GROUP[file.path];
  if (file.path.startsWith("story/")) return "canon";
  return null;
}

function phaseForPath(path: string) {
  if (path.startsWith("story/project-scope")) return "intake";
  if (path.startsWith("story/")) return "reference";
  if (path.startsWith("script/")) return "script";
  if (path.startsWith("scenes/")) return "scene";
  if (path.startsWith("shots/")) return "scene";
  if (path.startsWith("prompts/")) return "prompt";
  return "general";
}

function phaseForWorkspace(activeSection: string, selectedPath: string) {
  if (activeSection === "workshop") return "video";
  if (activeSection === "assets") return "reference";
  return phaseForPath(selectedPath);
}

function cardSectionForAssetCategory(category: string): AssetCardSection | null {
  if (category === "character") return "characters";
  if (category === "location") return "locations";
  if (category === "prop") return "props";
  if (category === "keyframe") return "keyframes";
  if (category === "audio") return "audio";
  if (category === "video") return "videos";
  return null;
}

function assetSectionSingular(section: AssetCardSection) {
  if (section === "characters") return "character";
  if (section === "locations") return "location";
  if (section === "props") return "prop";
  if (section === "keyframes") return "keyframe";
  if (section === "videos") return "video";
  return "audio";
}

function expectedMediaKindsForAssetSection(section: AssetCardSection): MediaAsset["kind"][] {
  if (section === "audio") return ["audio"];
  if (section === "videos") return ["video"];
  if (section === "locations" || section === "keyframes") return ["image", "video"];
  return ["image"];
}

function mediaKindListLabel(kinds: MediaAsset["kind"][]) {
  return kinds.join(" or ");
}

function mediaAssetSortTime(asset: MediaAsset) {
  const updated = Date.parse(asset.updatedAt || "");
  if (Number.isFinite(updated)) return updated;
  const created = Date.parse(asset.createdAt || "");
  return Number.isFinite(created) ? created : 0;
}

function mergeMediaAssets(...groups: Array<MediaAsset[]>) {
  const byId = new Map<string, MediaAsset>();
  for (const group of groups) {
    for (const asset of group) {
      if (!asset?.id || asset.status === "deleted") continue;
      const existing = byId.get(asset.id);
      if (!existing || mediaAssetSortTime(asset) >= mediaAssetSortTime(existing)) {
        byId.set(asset.id, asset);
      }
    }
  }
  return Array.from(byId.values()).sort((left, right) => {
    const timeDiff = mediaAssetSortTime(right) - mediaAssetSortTime(left);
    return timeDiff || right.id.localeCompare(left.id);
  });
}

function sameTimestamp(left: string, right: string) {
  if (left === right) return true;
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime === rightTime;
}

function useStableCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const callbackRef = useRef(callback);
  useLayoutEffect(() => {
    callbackRef.current = callback;
  });
  return useMemo(() => (...args: Args) => callbackRef.current(...args), []);
}

export function useWorkspaceData(projectId: string, user: WorkspaceUser): WorkspaceContextValue {
  const [project, setProject] = useState<CloudProject | null>(null);
  const [selectedPath, setSelectedPath] = useState("story/project-scope.md");
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("Loading project...");
  const [agentInput, setAgentInput] = useState("");
  const [agentBusy, setAgentBusy] = useState(false);
  const agentBusyLockRef = useRef(false);
  const [activeSection, setActiveSection] = useState("story");
  const [activeScriptChild, setActiveScriptChild] = useState<ScriptChild>("master");
  const [activeAssetCategory, setActiveAssetCategory] = useState("all");
  const [mediaAssets, setMediaAssets] = useState<MediaAsset[]>([]);
  const [mediaStatus, setMediaStatus] = useState("No media yet.");
  const [mediaBusy, setMediaBusy] = useState(false);
  // Upload-progress fraction (0..1) while a PUT is in flight, or
  // null when no upload is active OR the upload is indeterminate
  // (chunked, no content-length). Improvement-plan 4.6: surfaces
  // in the composer "Attaching…" toast + the DocsRail +New busy
  // slot via WorkspaceProvider context.
  const [mediaProgress, setMediaProgress] = useState<number | null>(null);
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [revisions, setRevisions] = useState<FileRevision[]>([]);
  const [revisionStatus, setRevisionStatus] = useState("History not loaded.");
  const [previewRevisionId, setPreviewRevisionId] = useState<string | null>(null);
  const [conflictFile, setConflictFile] = useState<CloudFile | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Phase D, slice D4: asset cards on the browser side. Lazy-loaded
  // when the user enters the Assets section.
  const [projectAssets, setProjectAssets] = useState<AssetCard[]>([]);
  const [projectAssetsStatus, setProjectAssetsStatus] = useState("Idle");
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  // Live ref to projectAssets so async handlers (uploadMediaForCard
  // in particular) can read the latest array without depending on
  // closure capture. Avoids the stale-projectAssets race that
  // would otherwise overwrite a concurrent loadProjectAssets'
  // metadata refresh.
  const projectAssetsRef = useRef<AssetCard[]>([]);
  useEffect(() => {
    projectAssetsRef.current = projectAssets;
  }, [projectAssets]);

  // Touched-path pulse + post-turn "editing" badge. Paths added on
  // agent file-write linger 14s (parity with desktop's
  // markTouchedPaths) — long enough that the user can see the
  // per-section IconRail badge ("editing intake.md, scope.md…")
  // after the turn finishes, not just during the 1.5s row pulse.
  // The .is-touched row animation still runs once (1.5s, defined
  // in CSS); the class itself stays applied until linger expires.
  const [touchedPaths, setTouchedPaths] = useState<Set<string>>(() => new Set());
  const touchedExpiriesRef = useRef<Map<string, number>>(new Map());
  const touchedPruneTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const syncTouchedPaths = () => {
    setTouchedPaths(new Set(touchedExpiriesRef.current.keys()));
  };
  const stopTouchedPrune = () => {
    if (!touchedPruneTimerRef.current) return;
    clearInterval(touchedPruneTimerRef.current);
    touchedPruneTimerRef.current = null;
  };
  const pruneTouchedPaths = () => {
    const now = Date.now();
    let changed = false;
    for (const [path, expiryMs] of touchedExpiriesRef.current) {
      if (expiryMs > now) continue;
      touchedExpiriesRef.current.delete(path);
      changed = true;
    }
    if (changed) syncTouchedPaths();
    if (touchedExpiriesRef.current.size === 0) stopTouchedPrune();
  };
  const startTouchedPrune = () => {
    if (touchedPruneTimerRef.current) return;
    touchedPruneTimerRef.current = setInterval(pruneTouchedPaths, 1_000);
  };
  const markTouched = (paths: string[]) => {
    if (!paths.length) return;
    const now = Date.now();
    const touchedSet = new Set(paths);
    // Re-add to bump insertion order — Map iteration follows
    // insertion order, so touchedFilesBySection's "most recent
    // first" walk works without a separate timestamp list.
    for (const path of touchedSet) touchedExpiriesRef.current.delete(path);
    for (const path of paths) {
      touchedExpiriesRef.current.set(path, now + 14_000);
    }
    syncTouchedPaths();
    startTouchedPrune();
  };

  useEffect(() => {
    const touchedExpiries = touchedExpiriesRef.current;
    return () => {
      stopTouchedPrune();
      touchedExpiries.clear();
    };
  }, []);

  // Bucket recent touched paths under each IconRail section so the
  // active-section button can show an "editing <files>" badge after
  // an agent turn finishes (parity with desktop's rail-touched-files
  // panel). Up to 3 basenames per section, most recent first. Set
  // iteration follows insertion order, so we reverse to put newest
  // first.
  const touchedFilesBySection = useMemo<Record<string, string[]>>(() => {
    const out: Record<string, string[]> = { story: [], script: [], assets: [], workshop: [] };
    const paths = Array.from(touchedPaths).reverse();
    for (const path of paths) {
      let section: string | null = null;
      if (path === "ANVIL.md" || path.startsWith("story/")) section = "story";
      else if (
        path.startsWith("script/") ||
        path.startsWith("scenes/") ||
        path.startsWith("prompts/") ||
        path.startsWith("shots/") ||
        path.startsWith("beats/") ||
        path.startsWith("dialogue/")
      ) {
        section = "script";
      } else if (path.startsWith("assets/")) section = "assets";
      if (!section) continue;
      const bucket = out[section];
      if (bucket.length >= 3) continue;
      const base = path.split("/").pop() || path;
      if (!bucket.includes(base)) bucket.push(base);
    }
    return out;
  }, [touchedPaths]);

  // Start with an empty thread so the chat column reads as a quiet
  // ready-to-type surface on refresh. The earlier "system-start" hint
  // ("Anvil Agent writes to cloud project files...") rendered as a
  // floating dashed-line notice in mid-air — visible UI artifact when
  // the thread was empty. The composer placeholder already says
  // "Ask Anvil…", which is enough scaffolding.
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const files = useMemo(() => {
    const source = project?.project.files || {};
    return Object.values(source).sort((a, b) => {
      const order = [
        "story/project-scope.md",
        "story/world-bible.md",
        "story/asset-context.md",
        "script/master-script.md",
      ];
      const ai = order.indexOf(a.path);
      const bi = order.indexOf(b.path);
      if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      return compareProjectFiles(a, b);
    });
  }, [project]);

  const fileTreeGroups = useMemo<FileTreeGroup[]>(() => {
    const groupFiles = (paths: string[]) =>
      paths.map((path) => project?.project.files[path]).filter((file): file is CloudFile => Boolean(file));
    const matchingFiles = (predicate: (file: CloudFile) => boolean) =>
      files.filter(predicate).sort(compareProjectFiles);
    const masterScriptPath = "script/master-script.md";

    if (activeSection === "script") {
      if (activeScriptChild === "dialogue") {
        return [
          {
            id: "dialogue",
            label: "Dialogue",
            files: matchingFiles((file) => file.path.startsWith("dialogue/")),
          },
        ].filter((group) => group.files.length);
      }
      if (activeScriptChild === "prompts") {
        return [
          {
            id: "prompts",
            label: "Prompts",
            files: matchingFiles((file) => file.path.startsWith("prompts/")),
          },
        ].filter((group) => group.files.length);
      }
      return [
        { id: "master", label: "Master Script", files: groupFiles([masterScriptPath]) },
        { id: "scenes", label: "Scenes", files: matchingFiles((file) => file.path.startsWith("scenes/")) },
        { id: "shots", label: "Shots", files: matchingFiles((file) => file.path.startsWith("shots/")) },
        { id: "prompts", label: "Prompts", files: matchingFiles((file) => file.path.startsWith("prompts/")) },
        { id: "drafts", label: "Drafts", files: matchingFiles((file) => file.path.startsWith("custom/drafts/")) },
        {
          id: "script-other",
          label: "Other",
          files: matchingFiles(
            (file) =>
              (file.path.startsWith("script/") && file.path !== masterScriptPath) ||
              (file.path.startsWith("custom/") && !file.path.startsWith("custom/drafts/")),
          ),
        },
      ].filter((group) => group.files.length);
    }

    const contextDocs = files.filter((file) => contextGroupFor(file) !== null);
    const buckets = new Map<string, CloudFile[]>();
    for (const file of contextDocs) {
      const group = contextGroupFor(file) || "canon";
      const list = buckets.get(group);
      if (list) list.push(file);
      else buckets.set(group, [file]);
    }
    const orderedGroups: FileTreeGroup[] = [];
    for (const builtIn of CONTEXT_GROUP_ORDER) {
      const list = buckets.get(builtIn);
      if (list) {
        orderedGroups.push({
          id: builtIn,
          label: contextGroupLabel(builtIn),
          files: list.sort(compareProjectFiles),
        });
        buckets.delete(builtIn);
      }
    }
    const customGroupIds = Array.from(buckets.keys()).sort();
    for (const groupId of customGroupIds) {
      orderedGroups.push({
        id: `custom-${groupId}`,
        label: contextGroupLabel(groupId),
        files: (buckets.get(groupId) || []).sort(compareProjectFiles),
      });
    }
    const ungrouped = matchingFiles(
      (file) => contextGroupFor(file) === null && file.path.startsWith("custom/"),
    );
    if (ungrouped.length) {
      orderedGroups.push({ id: "custom-other", label: "Custom Docs", files: ungrouped });
    }
    return orderedGroups.filter((group) => group.files.length);
  }, [activeSection, activeScriptChild, files, project]);

  const selectedFile = project?.project.files[selectedPath] || null;
  const previewRevision = useMemo(
    () => revisions.find((revision) => revision.id === previewRevisionId) || revisions[0] || null,
    [previewRevisionId, revisions],
  );
  const previewContent = previewRevision?.content || "";
  const previewExcerpt =
    previewContent.length > 1800 ? `${previewContent.slice(0, 1800)}\n\n[truncated]` : previewContent;
  const revisionCompare = useMemo(() => compareRevisionText(draft, previewContent), [draft, previewContent]);
  const activeCategory = ASSET_CATEGORIES.find((category) => category.id === activeAssetCategory) || ASSET_CATEGORIES[0];
  const filteredMediaAssets = useMemo(() => {
    if (activeSection === "workshop")
      return mediaAssets.filter((asset) => asset.kind === "video" || asset.kind === "audio");
    if (activeAssetCategory === "all") return mediaAssets;
    if (activeAssetCategory === "video") return mediaAssets.filter((asset) => asset.kind === "video");
    if (activeAssetCategory === "audio") return mediaAssets.filter((asset) => asset.kind === "audio");
    return mediaAssets.filter((asset) => {
      const category = typeof asset.metadata?.category === "string" ? asset.metadata.category : "";
      if (category === activeAssetCategory) return true;
      return activeCategory.kinds?.includes(asset.kind) && !category;
    });
  }, [activeAssetCategory, activeCategory.kinds, activeSection, mediaAssets]);
  const selectedMedia =
    filteredMediaAssets.find((asset) => asset.id === selectedMediaId) || filteredMediaAssets[0] || null;
  const mediaReady = selectedMedia?.status === "uploaded" || selectedMedia?.status === "ready";
  const mediaPreviewUrl =
    selectedMedia && mediaReady ? `/api/media/${encodeURIComponent(selectedMedia.id)}/download` : "";

  const projectRef = useRef<CloudProject | null>(null);
  const selectedPathRef = useRef(selectedPath);
  const selectedFileRef = useRef<CloudFile | null>(null);
  const draftRef = useRef(draft);
  const dirtyRef = useRef(dirty);
  const mediaAssetsRef = useRef<MediaAsset[]>([]);
  const historyOpenRef = useRef(historyOpen);
  const activeSectionRef = useRef(activeSection);
  const activeAssetCategoryRef = useRef(activeAssetCategory);
  const selectedMediaRef = useRef<MediaAsset | null>(null);
  const threadIdRef = useRef<string | null>(null);
  const projectIdRef = useRef(projectId);
  const projectAbortControllerRef = useRef<AbortController | null>(null);

  useLayoutEffect(() => {
    projectIdRef.current = projectId;
    projectRef.current = project;
    selectedPathRef.current = selectedPath;
    selectedFileRef.current = selectedFile;
    draftRef.current = draft;
    dirtyRef.current = dirty;
    mediaAssetsRef.current = mediaAssets;
    historyOpenRef.current = historyOpen;
    activeSectionRef.current = activeSection;
    activeAssetCategoryRef.current = activeAssetCategory;
    selectedMediaRef.current = selectedMedia;
    threadIdRef.current = threadId;
  }, [
    activeAssetCategory,
    activeSection,
    dirty,
    draft,
    historyOpen,
    mediaAssets,
    project,
    projectId,
    selectedFile,
    selectedMedia,
    selectedPath,
    threadId,
  ]);

  function isCurrentProject(requestProjectId: string, signal?: AbortSignal) {
    return projectIdRef.current === requestProjectId && !signal?.aborted;
  }

  function projectSignal() {
    return projectAbortControllerRef.current?.signal;
  }

  function normalizeMessages(storedMessages: StoredAgentMessage[]): ChatMessage[] {
    if (!storedMessages.length) return [];
    return storedMessages.map((message, index) => ({
      id: message.id || `msg-${index}`,
      role: message.role === "assistant" ? "agent" : message.role === "user" ? "user" : "system",
      content: message.content,
    }));
  }

  // Pull the server-emitted tokens block ({input, output, costUsd,
  // model, provider}) off the response, validate shape, and return a
  // ChatTokenMeta or null. Defensive parsing because the response is
  // network-shaped.
  function parseTokensMeta(raw: unknown): ChatMessage["tokens"] | null {
    if (!raw || typeof raw !== "object") return null;
    const t = raw as Record<string, unknown>;
    const input = Number(t.input);
    const output = Number(t.output);
    const costUsd = Number(t.costUsd);
    if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
    return {
      input,
      output,
      costUsd: Number.isFinite(costUsd) ? costUsd : 0,
      model: typeof t.model === "string" ? t.model : undefined,
      provider: typeof t.provider === "string" ? t.provider : undefined,
    };
  }

  // Walk a normalized message list from the end and attach tokens to
  // the most recent agent reply. Used so the per-turn footer shows
  // under the right message even when the assistant + a write-status
  // system message both land in the same response.
  function attachTokensToLastAgent(
    list: ChatMessage[],
    tokens: NonNullable<ChatMessage["tokens"]>,
  ): ChatMessage[] {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].role === "agent") {
        const next = list.slice();
        next[i] = { ...list[i], tokens };
        return next;
      }
    }
    return list;
  }

  async function loadAgentThread(signal = projectSignal()) {
    const requestProjectId = projectIdRef.current;
    try {
      const url = new URL(`/api/projects/${encodeURIComponent(requestProjectId)}/agent/thread`, window.location.origin);
      if (threadIdRef.current) url.searchParams.set("threadId", threadIdRef.current);
      const response = await fetch(url, { cache: "no-store", signal });
      const data = await response.json();
      if (!isCurrentProject(requestProjectId, signal)) return;
      if (!response.ok) {
        setMessages([
          { id: "thread-error", role: "system", content: data?.message || "Could not load Anvil Agent thread." },
        ]);
        return;
      }
      if (typeof data.thread?.id === "string") setThreadId(data.thread.id);
      setMessages(normalizeMessages(Array.isArray(data.messages) ? data.messages : []));
    } catch (error) {
      if (!isCurrentProject(requestProjectId, signal) || (error instanceof DOMException && error.name === "AbortError")) return;
      setMessages([
        { id: "thread-error", role: "system", content: "Could not reach Anvil Agent thread server." },
      ]);
    }
  }

  // Phase D, slice D4: list + create asset cards. Cards are server-
  // managed (DB-backed); we fetch them when the user enters the
  // Assets section, and refresh on create. Selection of a card is
  // separate from media selection — cards live in the docs rail,
  // media variants attach to them via /assets/[id]/media (D3).

  async function loadProjectAssets(signal = projectSignal()) {
    const requestProjectId = projectIdRef.current;
    setProjectAssetsStatus("Loading…");
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(requestProjectId)}/assets`,
        { cache: "no-store", signal },
      );
      const data = await response.json();
      if (!isCurrentProject(requestProjectId, signal)) return;
      if (!response.ok) {
        setProjectAssetsStatus(data?.message || "Could not load assets.");
        setProjectAssets([]);
        return;
      }
      const assets = (Array.isArray(data.assets) ? data.assets : []) as AssetCard[];
      setProjectAssets(assets);
      setProjectAssetsStatus(assets.length ? `${assets.length} cards` : "No cards yet.");
    } catch (error) {
      if (!isCurrentProject(requestProjectId, signal) || (error instanceof DOMException && error.name === "AbortError")) return;
      setProjectAssetsStatus("Could not reach assets server.");
    }
  }

  async function createProjectAsset(section: AssetCardSection, name?: string) {
    if (!isAssetCardSection(section)) return;
    const requestProjectId = projectIdRef.current;
    const signal = projectSignal();
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(requestProjectId)}/assets`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal,
          body: JSON.stringify({
            section,
            name: name || `Untitled ${assetSectionSingular(section)}`,
          }),
        },
      );
      const data = await response.json();
      if (!isCurrentProject(requestProjectId, signal)) return;
      if (!response.ok || !data.asset) {
        setProjectAssetsStatus(data?.message || "Could not create asset.");
        return;
      }
      const created = data.asset as AssetCard;
      setProjectAssets((current) => [...current, created]);
      setSelectedAssetId(created.assetId);
      setProjectAssetsStatus(`${assetSectionSingular(created.section)} created`);
      // Auto-expand the right pane so the new asset's preview card is
      // immediately visible (same mechanism as createFile uses).
      markTouched([`asset:${created.assetId}`]);
    } catch {
      if (!isCurrentProject(requestProjectId, signal)) return;
      setProjectAssetsStatus("Could not reach assets server.");
    }
  }

  async function deleteProjectAsset(assetId: string) {
    const requestProjectId = projectIdRef.current;
    const signal = projectSignal();
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(requestProjectId)}/assets/${encodeURIComponent(assetId)}`,
        { method: "DELETE", signal },
      );
      if (!isCurrentProject(requestProjectId, signal)) return;
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        if (!isCurrentProject(requestProjectId, signal)) return;
        setProjectAssetsStatus(data?.message || "Could not delete asset.");
        return;
      }
      setProjectAssets((current) => current.filter((asset) => asset.assetId !== assetId));
      setSelectedAssetId((current) => (current === assetId ? null : current));
      setProjectAssetsStatus("Deleted");
    } catch {
      if (!isCurrentProject(requestProjectId, signal)) return;
      setProjectAssetsStatus("Could not reach assets server.");
    }
  }

  async function loadMedia(signal = projectSignal()) {
    const requestProjectId = projectIdRef.current;
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(requestProjectId)}/media`, { cache: "no-store", signal });
      const data = await response.json();
      if (!isCurrentProject(requestProjectId, signal)) return;
      if (!response.ok) {
        setMediaStatus(data?.message || "Could not load media.");
        setMediaAssets([]);
        return;
      }
      const assets = Array.isArray(data.assets) ? data.assets : [];
      setMediaAssets(assets);
      setMediaStatus(assets.length ? `${assets.length} media files` : data.message || "No media yet.");
      setSelectedMediaId((current) => {
        if (current && assets.some((asset: MediaAsset) => asset.id === current)) return current;
        return assets[0]?.id || null;
      });
    } catch (error) {
      if (!isCurrentProject(requestProjectId, signal) || (error instanceof DOMException && error.name === "AbortError")) return;
      setMediaStatus("Could not reach media server.");
    }
  }

  async function loadRevisions(filePath = selectedPathRef.current, signal = projectSignal()) {
    const requestProjectId = projectIdRef.current;
    const section = activeSectionRef.current;
    if (!filePath || section === "assets" || section === "workshop") {
      setRevisions([]);
      setPreviewRevisionId(null);
      setRevisionStatus("History not available.");
      return;
    }
    setRevisionStatus("Loading history...");
    try {
      const url = new URL(
        `/api/projects/${encodeURIComponent(requestProjectId)}/file-revisions`,
        window.location.origin,
      );
      url.searchParams.set("path", filePath);
      url.searchParams.set("limit", "20");
      const response = await fetch(url, { cache: "no-store", signal });
      const data = await response.json();
      if (!isCurrentProject(requestProjectId, signal)) return;
      if (!response.ok) {
        setRevisions([]);
        setPreviewRevisionId(null);
        setRevisionStatus(data?.message || "Could not load history.");
        return;
      }
      const nextRevisions = Array.isArray(data.revisions) ? data.revisions : [];
      setRevisions(nextRevisions);
      setPreviewRevisionId((current) =>
        current && nextRevisions.some((revision: FileRevision) => revision.id === current)
          ? current
          : nextRevisions[0]?.id || null,
      );
      setRevisionStatus(nextRevisions.length ? `${nextRevisions.length} saves` : "No history yet.");
    } catch (error) {
      if (!isCurrentProject(requestProjectId, signal) || (error instanceof DOMException && error.name === "AbortError")) return;
      setRevisions([]);
      setPreviewRevisionId(null);
      setRevisionStatus("Could not reach history server.");
    }
  }

  async function loadProject(
    nextSelectedPath = selectedPathRef.current,
    options: { preserveDraft?: boolean; signal?: AbortSignal } = {},
  ) {
    const requestProjectId = projectIdRef.current;
    const signal = options.signal ?? projectSignal();
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(requestProjectId)}`, { cache: "no-store", signal });
      const data = await response.json();
      if (!isCurrentProject(requestProjectId, signal)) return;
      if (!response.ok || !data.project) {
        setStatus(data?.message || "Could not load project.");
        return;
      }
      setProject(data.project);
      const nextFile =
        data.project.project?.files?.[nextSelectedPath] ||
        data.project.project?.files?.["story/project-scope.md"] ||
        Object.values(data.project.project?.files || {})[0];
      if (nextFile && typeof nextFile === "object" && "path" in nextFile) {
        const path = String(nextFile.path);
        setSelectedPath(path);
        const nextCloudFile = nextFile as CloudFile;
        if (options.preserveDraft && path === selectedPathRef.current && dirtyRef.current) {
          const changedOnServer =
            selectedFileRef.current?.updatedAt &&
            nextCloudFile.updatedAt &&
            !sameTimestamp(selectedFileRef.current.updatedAt, nextCloudFile.updatedAt);
          if (changedOnServer) {
            setConflictFile(nextCloudFile);
            setStatus("Server changed");
          }
        } else {
          setDraft(String(nextCloudFile.content || ""));
          setDirty(false);
          setConflictFile(null);
        }
      }
      setStatus((currentStatus) =>
        options.preserveDraft && dirtyRef.current && currentStatus === "Server changed" ? currentStatus : "Saved",
      );
      if (historyOpenRef.current)
        await loadRevisions(
          String(nextFile && typeof nextFile === "object" && "path" in nextFile ? nextFile.path : nextSelectedPath),
          signal,
        );
    } catch (error) {
      if (!isCurrentProject(requestProjectId, signal) || (error instanceof DOMException && error.name === "AbortError")) return;
      setStatus("Could not reach project server.");
    }
  }

  async function saveFile({ force = false }: { force?: boolean } = {}) {
    const requestProjectId = projectIdRef.current;
    const pathAtSave = selectedPathRef.current;
    const draftAtSave = draftRef.current;
    const selectedFileAtSave = selectedFileRef.current;
    const historyOpenAtSave = historyOpenRef.current;
    if (!pathAtSave) return;
    setStatus("Saving...");
    const signal = projectSignal();
    try {
      const response = await fetch(fileUrl(requestProjectId, pathAtSave), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        signal,
        body: JSON.stringify({
          content: draftAtSave,
          expectedUpdatedAt: force ? undefined : selectedFileAtSave?.updatedAt,
          force,
        }),
      });
      const data = await response.json();
      if (!isCurrentProject(requestProjectId, signal)) return;
      if (response.status === 409 && data.file) {
        setConflictFile(data.file);
        setStatus("Server changed");
        setHistoryOpen(true);
        await loadRevisions(pathAtSave, signal);
        return;
      }
      if (!response.ok || !data.file) {
        setStatus(data?.message || "Save failed.");
        return;
      }
      setConflictFile(null);
      const savedPath = typeof data.file?.path === "string" && data.file.path ? data.file.path : pathAtSave;
      const savedFile = data.file as CloudFile;
      const applySavedFileToProject = () => {
        setProject((current) => {
          if (!current) return current;
          const nextFiles = { ...current.project.files };
          if (savedPath !== pathAtSave) delete nextFiles[pathAtSave];
          nextFiles[savedPath] = savedFile;
          return {
            ...current,
            project: {
              ...current.project,
              files: nextFiles,
            },
          };
        });
      };
      const draftChangedAfterSave =
        selectedPathRef.current === pathAtSave && draftRef.current !== draftAtSave;
      if (selectedPathRef.current !== pathAtSave) {
        applySavedFileToProject();
        if (historyOpenAtSave) await loadRevisions(selectedPathRef.current, signal);
        return;
      }
      if (savedPath !== pathAtSave) {
        applySavedFileToProject();
        setSelectedPath(savedPath);
      }
      if (draftChangedAfterSave) {
        selectedFileRef.current = savedFile;
        applySavedFileToProject();
        setDirty(true);
        setStatus("Unsaved");
        if (historyOpenAtSave) await loadRevisions(savedPath, signal);
        return;
      }
      await loadProject(savedPath, { signal });
      if (historyOpenAtSave) await loadRevisions(savedPath, signal);
    } catch {
      if (!isCurrentProject(requestProjectId, signal)) return;
      setStatus("Save failed.");
    }
  }

  function selectFile(path: string) {
    const next = project?.project.files[path];
    if (!next) return;
    if (dirtyRef.current) void saveFile({ force: Boolean(conflictFile) });
    setSelectedPath(path);
    setDraft(next.content || "");
    setDirty(false);
    setStatus("Saved");
    setConflictFile(null);
    setPreviewRevisionId(null);
    if (historyOpen) void loadRevisions(path);
  }

  function defaultScriptFile(child: ScriptChild): CloudFile | undefined {
    const source = project?.project.files || {};
    if (child === "dialogue") return source[DIALOGUE_DOC_PATH];
    if (child === "prompts") {
      return files.find((file) => file.path.startsWith("prompts/")) || source[MASTER_SCRIPT_PATH];
    }
    return (
      source[MASTER_SCRIPT_PATH] ||
      files.find(
        (file) =>
          file.path.startsWith("script/") ||
          file.path.startsWith("scenes/") ||
          file.path.startsWith("shots/") ||
          file.path.startsWith("prompts/") ||
          file.path.startsWith("custom/drafts/"),
      )
    );
  }

  function setScriptChild(child: ScriptChild) {
    setActiveScriptChild(child);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (child === "master") url.searchParams.delete("script");
      else url.searchParams.set("script", child);
      window.history.replaceState(null, "", url.toString());
    }
    const next = defaultScriptFile(child);
    if (next) selectFile(next.path);
  }

  function switchSection(section: string) {
    setActiveSection(section);
    const source = project?.project.files || {};
    if (section === "story") {
      const next =
        source["story/project-scope.md"] ||
        source["story/world-bible.md"] ||
        source["story/asset-context.md"] ||
        files.find((file) => file.path.startsWith("story/") || file.path.startsWith("custom/"));
      if (next) selectFile(next.path);
    }
    if (section === "script") {
      const next = defaultScriptFile(activeScriptChild);
      if (next) selectFile(next.path);
    }
  }

  async function createFile(root = "custom") {
    // Canonical fixed-path scaffolds — select if already present,
    // otherwise open an empty draft at the canonical path. Used by
    // the rail's placeholder rows ("+ Master script", "+ Project
    // Scope", etc.).
    type CanonicalDoc = { path: string; template: string };
    const canonical: Record<string, CanonicalDoc> = {
      "master-script": {
        path: MASTER_SCRIPT_PATH,
        template: "# Master Script\n\n",
      },
      "project-scope": {
        path: "story/project-scope.md",
        template: "# Project Scope\n\nVisible project scope, format, runtime, premise, references, and hard constraints.\n",
      },
      "world-bible": {
        path: "story/world-bible.md",
        template: "# World Bible\n\nDurable canon, taste, visual identity, and continuity rules.\n",
      },
      "asset-context": {
        path: "story/asset-context.md",
        template: "# Asset Context\n\nCharacters, locations, props, references, audio, and video generation targets.\n",
      },
    };
    // Optimistic insert into project.files so the rail tree shows the
    // new entry immediately under its parent group (Master Script,
    // Scenes, etc.) — matches how the desktop app surfaces new files.
    // Without this, +New felt like it "silently added on the right
    // pane" because the editor opened but the rail stayed unchanged
    // until first save.
    const insertOptimistic = (path: string, content: string, title: string) => {
      const now = new Date().toISOString();
      setProject((current) => {
        if (!current) return current;
        if (current.project.files[path]) return current;
        const file: CloudFile = {
          path,
          title,
          kind: "markdown",
          content,
          createdAt: now,
          updatedAt: now,
        };
        return {
          ...current,
          project: {
            ...current.project,
            files: { ...current.project.files, [path]: file },
          },
        };
      });
    };

    const titleFromPath = (path: string) => {
      const base = path.split("/").pop() || path;
      return base.replace(/\.md$/, "").replace(/-/g, " ");
    };

    const canonicalDoc = canonical[root];
    if (canonicalDoc) {
      const existing = project?.project.files[canonicalDoc.path];
      if (existing) {
        selectFile(existing.path);
        return;
      }
      const canonicalTitle =
        root === "master-script" ? "Master Script"
        : root === "project-scope" ? "Project Scope"
        : root === "world-bible" ? "World Bible"
        : "Asset Context";
      insertOptimistic(canonicalDoc.path, canonicalDoc.template, canonicalTitle);
      setSelectedPath(canonicalDoc.path);
      setDraft(canonicalDoc.template);
      setDirty(true);
      setStatus("New file");
      setRevisions([]);
      setPreviewRevisionId(null);
      setRevisionStatus("No history yet.");
      // Flag the new path as touched so useShellState's auto-expand
      // pops the right pane open. Without this, clicking "+" while the
      // preview pane is collapsed looked like nothing happened — the
      // editor opened in state but the user couldn't see it.
      markTouched([canonicalDoc.path]);
      return;
    }

    // Properly-numbered scaffolds so the rail sorts cleanly by
    // numberedCreativeOrder (leading-digit aware) instead of falling
    // back to alphabetical ("new-scene-2" / "new-scene-3" / …
    // "new-scene"). Filename now leads with NN- and the display title
    // reads "Scene NN" / "Prompt NN".
    let nextPath: string;
    let displayTitle: string;
    let draftHeading: string;
    const files = project?.project.files || {};
    if (root === "scenes") {
      let index = 1;
      let padded = String(index).padStart(2, "0");
      nextPath = `scenes/${padded}-scene.md`;
      while (files[nextPath]) {
        index += 1;
        padded = String(index).padStart(2, "0");
        nextPath = `scenes/${padded}-scene.md`;
      }
      displayTitle = `Scene ${padded}`;
      draftHeading = `# ${displayTitle}\n`;
    } else if (root === "prompts") {
      let index = 1;
      let padded = String(index).padStart(2, "0");
      nextPath = `prompts/${padded}-prompt.md`;
      while (files[nextPath]) {
        index += 1;
        padded = String(index).padStart(2, "0");
        nextPath = `prompts/${padded}-prompt.md`;
      }
      displayTitle = `Prompt ${padded}`;
      draftHeading = `# ${displayTitle}\n`;
    } else {
      const base = "new-doc";
      let index = 1;
      nextPath = `${root}/${base}.md`;
      while (files[nextPath]) {
        index += 1;
        nextPath = `${root}/${base}-${index}.md`;
      }
      displayTitle = titleFromPath(nextPath);
      draftHeading = `# ${displayTitle}\n`;
    }
    const draftContent = draftHeading;
    insertOptimistic(nextPath, draftContent, displayTitle);
    setSelectedPath(nextPath);
    setDraft(draftContent);
    setDirty(true);
    setStatus("New file");
    setRevisions([]);
    setPreviewRevisionId(null);
    setRevisionStatus("No history yet.");
    markTouched([nextPath]);
  }

  // Create a new prompt nested under a specific scene's folder, e.g.
  // scenes/02-storm.md → prompts/02-storm/01.md. Picks the lowest
  // unused two-digit slot (01..99). Mirrors desktop's prompt path
  // convention `prompts/<scene-stem>/<NN>.md`.
  async function createPromptForScene(sceneStem: string) {
    const folder = `prompts/${sceneStem}`;
    const files = project?.project.files || {};
    let index = 1;
    let nextPath = "";
    let padded = "01";
    while (index < 100) {
      padded = String(index).padStart(2, "0");
      nextPath = `${folder}/${padded}.md`;
      if (!files[nextPath]) break;
      index += 1;
    }
    if (!nextPath || files[nextPath]) {
      setStatus("Prompt slots full");
      return;
    }
    const draftContent = `# Prompt ${padded}\n\n_Scene: ${sceneStem}_\n\n`;
    // Optimistic insert so the prompt shows up nested under its scene
    // in the rail immediately (matches the desktop app behavior).
    const now = new Date().toISOString();
    setProject((current) => {
      if (!current || current.project.files[nextPath]) return current;
      const file: CloudFile = {
        path: nextPath,
        title: `Prompt ${padded}`,
        kind: "markdown",
        content: draftContent,
        createdAt: now,
        updatedAt: now,
      };
      return {
        ...current,
        project: {
          ...current.project,
          files: { ...current.project.files, [nextPath]: file },
        },
      };
    });
    setSelectedPath(nextPath);
    setDraft(draftContent);
    setDirty(true);
    setStatus("New file");
    setRevisions([]);
    setPreviewRevisionId(null);
    setRevisionStatus("No history yet.");
    markTouched([nextPath]);
  }

  function mediaKindForFile(file: File): MediaAsset["kind"] {
    if (file.type.startsWith("image/")) return "image";
    if (file.type.startsWith("video/")) return "video";
    if (file.type.startsWith("audio/")) return "audio";
    const extension = file.name.split(".").pop()?.toLowerCase() || "";
    if (IMAGE_EXTENSIONS.has(extension)) return "image";
    if (VIDEO_EXTENSIONS.has(extension)) return "video";
    if (AUDIO_EXTENSIONS.has(extension)) return "audio";
    return "other";
  }

  function categoryForAssetCardSection(section: AssetCardSection) {
    if (section === "characters") return "character";
    if (section === "locations") return "location";
    if (section === "props") return "prop";
    if (section === "keyframes") return "keyframe";
    if (section === "videos") return "video";
    return "audio";
  }

  async function uploadMedia(file: File): Promise<boolean> {
    const requestProjectId = projectIdRef.current;
    const preUploadAssets = mediaAssetsRef.current;
    const signal = projectSignal();
    setMediaBusy(true);
    setMediaStatus("Preparing upload...");
    const kind = mediaKindForFile(file);
    const category =
      activeSection === "workshop"
        ? kind
        : activeAssetCategory === "all"
          ? kind
          : activeAssetCategory;
    try {
      if (activeSection === "workshop" && kind !== "video" && kind !== "audio") {
        setMediaStatus("Workshop accepts video or audio files.");
        return false;
      }
      if (activeSection === "assets" && activeAssetCategory !== "all") {
        const allowedKinds = activeCategory.kinds || [];
        if (allowedKinds.length && !allowedKinds.includes(kind)) {
          setMediaStatus(`${activeCategory.label} accepts ${mediaKindListLabel(allowedKinds)} files.`);
          return false;
        }
      }
      const response = await fetch(`/api/projects/${encodeURIComponent(requestProjectId)}/media`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal,
        body: JSON.stringify({
          kind,
          fileName: file.name,
          contentType: file.type || "application/octet-stream",
          byteSize: file.size,
          source: "upload",
          metadata: { category },
        }),
      });
      const data = await response.json();
      if (!isCurrentProject(requestProjectId, signal)) return false;
      if (!response.ok || !data.upload?.url) {
        console.warn("[uploadMedia] sign-url step failed", {
          status: response.status,
          body: data,
          fileName: file.name,
          contentType: file.type,
          byteSize: file.size,
        });
        setMediaStatus(data?.message || `Upload not configured (${response.status}).`);
        return false;
      }
      setMediaStatus("Uploading...");
      setMediaProgress(0);
      const uploadResponse = await uploadWithProgress(data.upload.url, {
        method: data.upload.method || "PUT",
        headers: data.upload.headers || { "content-type": file.type || "application/octet-stream" },
        signal,
        body: file,
        onProgress: (fraction) => {
          if (!isCurrentProject(requestProjectId, signal)) return;
          setMediaProgress(fraction);
        },
      });
      const uploadData = (await uploadResponse.json().catch(() => ({}))) as Record<string, unknown>;
      if (!isCurrentProject(requestProjectId, signal)) return false;
      if (!uploadResponse.ok) {
        console.warn("[uploadMedia] storage PUT failed", {
          status: uploadResponse.status,
          providerBody: uploadData,
          signedUrl: data.upload.url,
          fileName: file.name,
        });
        setMediaStatus(`Upload failed (${uploadResponse.status}).`);
        return false;
      }
      // Optimistic insert: in dev (dev-user) the GET reload returns
      // empty because ownerHasDurableStore requires a UUID owner_id.
      // Without this push the file lands in Bunny but the rail bin
      // stays empty and the user perceives "upload doesn't work".
      const rawUploadedAsset = uploadData.asset || data.asset;
      const uploadedAsset = rawUploadedAsset
        ? ({ ...(rawUploadedAsset as MediaAsset), status: "uploaded" as const } satisfies MediaAsset)
        : undefined;
      if (!uploadedAsset?.id) {
        setMediaStatus("Uploaded, but media record was missing.");
        return false;
      }
      if (uploadedAsset?.id) {
        setMediaAssets((current) => mergeMediaAssets([uploadedAsset], current, preUploadAssets));
        setSelectedMediaId(uploadedAsset.id);
      }
      setMediaStatus("Uploaded.");
      await loadMedia(signal);
      // loadMedia is authoritative during normal navigation, but an
      // upload can overlap stale GETs or a partial server response. Merge
      // the uploaded row plus the pre-upload list back in so a new All
      // Media upload cannot visually replace the previous media card.
      if (uploadedAsset?.id) {
        setMediaAssets((current) => mergeMediaAssets(current, [uploadedAsset], preUploadAssets));
      }
      return true;
    } catch (error) {
      if (!isCurrentProject(requestProjectId, signal)) return false;
      console.warn("[uploadMedia] threw exception", error);
      setMediaStatus(`Upload failed (${error instanceof Error ? error.message : "unknown"}).`);
      return false;
    } finally {
      if (isCurrentProject(requestProjectId, signal)) {
        setMediaBusy(false);
        setMediaProgress(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    }
  }

  // Upload-and-bind helper for asset cards. Posts to the media
  // signing endpoint, PUTs the file to the signed URL, then PATCHes
  // the card's metadata with the resulting media id so the card
  // preview renders the uploaded file. Wired to the "Upload" button
  // on AssetCardPreview so the user no longer has to drag files
  // into the chat composer just to attach them.
  async function uploadMediaForCard(file: File, assetId: string): Promise<void> {
    const requestProjectId = projectIdRef.current;
    const preUploadAssets = mediaAssetsRef.current;
    const signal = projectSignal();
    setMediaBusy(true);
    setMediaStatus("Preparing upload...");
    try {
      const kind = mediaKindForFile(file);
      const targetCard = projectAssetsRef.current.find((card) => card.assetId === assetId);
      if (targetCard) {
        const expectedKinds = expectedMediaKindsForAssetSection(targetCard.section);
        if (!expectedKinds.includes(kind)) {
          setMediaStatus(`${assetSectionSingular(targetCard.section)} cards expect ${mediaKindListLabel(expectedKinds)} files.`);
          return;
        }
      }
      const category = targetCard ? categoryForAssetCardSection(targetCard.section) : kind;
      const response = await fetch(`/api/projects/${encodeURIComponent(requestProjectId)}/media`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal,
        body: JSON.stringify({
          kind,
          fileName: file.name,
          contentType: file.type || "application/octet-stream",
          byteSize: file.size,
          source: "upload",
          metadata: { category, cardAssetId: assetId },
        }),
      });
      const data = await response.json();
      if (!isCurrentProject(requestProjectId, signal)) return;
      if (!response.ok || !data.upload?.url) {
        console.warn("[uploadMediaForCard] sign-url step failed", {
          status: response.status,
          body: data,
          assetId,
          fileName: file.name,
          contentType: file.type,
          byteSize: file.size,
        });
        setMediaStatus(data?.message || `Upload not configured (${response.status}).`);
        return;
      }
      const mediaAssetId = typeof data.asset?.id === "string" ? data.asset.id.trim() : "";
      if (!mediaAssetId) {
        // Sign-url responded ok + had an upload URL, but no usable
        // asset id. Surface the failure instead of silently PATCHing
        // metadata with mediaAssetId: undefined (which JSON.stringify
        // drops, leaving the card unbound and the user staring at
        // the placeholder forever).
        console.warn("[uploadMediaForCard] sign-url returned upload but no asset.id", {
          assetId,
          body: data,
        });
        setMediaStatus("Upload not configured (missing asset id).");
        return;
      }
      setMediaStatus("Uploading...");
      setMediaProgress(0);
      const uploadResponse = await uploadWithProgress(data.upload.url, {
        method: data.upload.method || "PUT",
        headers: data.upload.headers || { "content-type": file.type || "application/octet-stream" },
        signal,
        body: file,
        onProgress: (fraction) => {
          if (!isCurrentProject(requestProjectId, signal)) return;
          setMediaProgress(fraction);
        },
      });
      const uploadData = (await uploadResponse.json().catch(() => ({}))) as Record<string, unknown>;
      if (!isCurrentProject(requestProjectId, signal)) return;
      if (!uploadResponse.ok) {
        console.warn("[uploadMediaForCard] storage PUT failed", {
          status: uploadResponse.status,
          providerBody: uploadData,
          signedUrl: data.upload.url,
          assetId,
          fileName: file.name,
        });
        setMediaStatus(`Upload failed (${uploadResponse.status}).`);
        return;
      }
      // Optimistic insert into the media list so the card-bound media
      // shows even when persistence isn't configured for the session.
      // Same logic as uploadMedia — server GET returns [] for dev-user.
      const rawUploadedAsset = uploadData.asset || data.asset;
      const uploadedAsset = rawUploadedAsset
        ? ({ ...(rawUploadedAsset as MediaAsset), status: "uploaded" as const, assetId } satisfies MediaAsset)
        : undefined;
      if (uploadedAsset?.id) {
        setMediaAssets((current) => mergeMediaAssets([uploadedAsset], current, preUploadAssets));
      }
      const attachResponse = await fetch(
        `/api/projects/${encodeURIComponent(requestProjectId)}/assets/${encodeURIComponent(assetId)}/media`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal,
          body: JSON.stringify({ mediaId: mediaAssetId }),
        },
      );
      const attachData = await attachResponse.json().catch(() => ({}));
      if (!isCurrentProject(requestProjectId, signal)) return;
      if (!attachResponse.ok) {
        console.warn("[uploadMediaForCard] media-card attach failed", {
          status: attachResponse.status,
          body: attachData,
          assetId,
          mediaAssetId,
        });
        setMediaStatus(attachData?.message || `Uploaded, but link failed (${attachResponse.status}).`);
        return;
      }
      const attachedMedia = attachData?.media as MediaAsset | undefined;
      if (attachedMedia?.id) {
        setMediaAssets((current) => mergeMediaAssets([attachedMedia], current, preUploadAssets));
      }
      // Bind the uploaded media to the card so the preview can render
      // it via /api/media/<id>/download. Merges into existing metadata
      // so we don't clobber other fields the agent may have set.
      // Read from the live ref instead of the captured closure value
      // so a concurrent loadProjectAssets() can't leave us merging
      // onto a stale card.
      const currentCard = projectAssetsRef.current.find((card) => card.assetId === assetId);
      const nextMetadata = {
        ...(currentCard?.metadata || {}),
        mediaAssetId,
        mediaKind: kind,
        mediaFileName: file.name,
        mediaCategory: category,
      };
      const patchResponse = await fetch(
        `/api/projects/${encodeURIComponent(requestProjectId)}/assets/${encodeURIComponent(assetId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          signal,
          body: JSON.stringify({ metadata: nextMetadata }),
        },
      );
      if (!isCurrentProject(requestProjectId, signal)) return;
      if (!patchResponse.ok) {
        let patchBody = "";
        try { patchBody = (await patchResponse.text()).slice(0, 400); } catch { /* ignore */ }
        console.warn("[uploadMediaForCard] card-metadata PATCH failed", {
          status: patchResponse.status,
          patchBody,
          assetId,
          mediaAssetId,
        });
        setMediaStatus(`Uploaded, but link failed (${patchResponse.status}).`);
        return;
      }
      setMediaStatus("Uploaded.");
      await Promise.all([loadMedia(signal), loadProjectAssets(signal)]);
      // Re-apply optimistic media after loadMedia in case GET returned
      // an empty or partial list. This prevents card-bound uploads from
      // making the All Media rail look like the newest item replaced
      // older uploads.
      if (uploadedAsset?.id) {
        setMediaAssets((current) => mergeMediaAssets(current, [attachedMedia?.id ? attachedMedia : uploadedAsset], preUploadAssets));
      }
    } catch (error) {
      if (!isCurrentProject(requestProjectId, signal)) return;
      console.warn("[uploadMediaForCard] threw exception", error);
      setMediaStatus(`Upload failed (${error instanceof Error ? error.message : "unknown"}).`);
    } finally {
      if (isCurrentProject(requestProjectId, signal)) {
        setMediaBusy(false);
        setMediaProgress(null);
      }
    }
  }

  async function sendAgentTurn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const userMessage = agentInput.trim();
    if (!userMessage || agentBusyLockRef.current) return;
    const requestProjectId = projectIdRef.current;
    agentBusyLockRef.current = true;
    const projectAtSubmit = projectRef.current;
    const selectedPathAtSubmit = selectedPathRef.current;
    const activeSectionAtSubmit = activeSectionRef.current;
    const activeAssetCategoryAtSubmit = activeAssetCategoryRef.current;
    const selectedMediaAtSubmit = selectedMediaRef.current;
    const threadIdAtSubmit = threadIdRef.current;
    const signal = projectSignal();
    setAgentInput("");
    setAgentBusy(true);
    setMessages((current) => [
      ...current,
      { id: `user-${Date.now()}`, role: "user", content: userMessage },
    ]);

    try {
      const agentPhase = phaseForWorkspace(activeSectionAtSubmit, selectedPathAtSubmit);
      const response = await fetch(`/api/projects/${encodeURIComponent(requestProjectId)}/agent/turn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal,
        body: JSON.stringify({
          threadId: threadIdAtSubmit,
          projectId: requestProjectId,
          projectName: projectAtSubmit?.name || "Anvil Project",
          phase: agentPhase,
          userMessage,
          applyActions: true,
          maxActions: 20,
          context: {
            projectId: requestProjectId,
            projectName: projectAtSubmit?.name,
            phase: agentPhase,
            selection: {
              activeSection: activeSectionAtSubmit,
              path: selectedPathAtSubmit,
              assetCategory: activeAssetCategoryAtSubmit,
              mediaAssetId: selectedMediaAtSubmit?.id || null,
              mediaKind: selectedMediaAtSubmit?.kind || null,
              mediaStatus: selectedMediaAtSubmit?.status || null,
              mediaFileName: selectedMediaAtSubmit?.fileName || null,
            },
          },
        }),
      });
      const data = await response.json();
      if (!isCurrentProject(requestProjectId, signal)) return;
      const agentSucceeded = response.ok && data?.ok !== false && !data?.error;
      const reply =
        typeof data?.reply === "string" ? data.reply : data?.message || "Anvil Agent could not complete that turn.";
      if (typeof data.thread?.id === "string") setThreadId(data.thread.id);
      const turnTokens = parseTokensMeta(data?.tokens);
      if (Array.isArray(data.messages)) {
        const baseMessages = normalizeMessages(data.messages);
        const nextMessages = turnTokens ? attachTokensToLastAgent(baseMessages, turnTokens) : baseMessages;
        const writeStatus =
          data.writeStatus && typeof data.writeStatus === "object"
            ? (data.writeStatus as Record<string, unknown>)
            : {};
        const cloudWrite =
          data.cloudWrite && typeof data.cloudWrite === "object"
            ? (data.cloudWrite as Record<string, unknown>)
            : {};
        const appliedCount =
          Number(writeStatus.appliedCount || 0) || Number(cloudWrite.appliedCount || 0);
        const paths = Array.isArray(writeStatus.paths)
          ? writeStatus.paths.filter((path): path is string => typeof path === "string" && Boolean(path)).slice(0, 4)
          : Array.isArray(cloudWrite.appliedPaths)
            ? cloudWrite.appliedPaths
                .filter((path): path is string => typeof path === "string" && Boolean(path))
                .slice(0, 4)
            : Array.isArray(data.actions)
              ? data.actions
                  .map((action: unknown) => {
                    if (!action || typeof action !== "object") return "";
                    const path = (action as Record<string, unknown>).path;
                    return typeof path === "string" ? path : "";
                  })
                  .filter(Boolean)
                  .slice(0, 4)
              : [];
        setMessages(
          appliedCount > 0 && writeStatus.persisted !== true
            ? [
                ...nextMessages,
                {
                  id: `tool-call-${Date.now()}`,
                  role: "system",
                  content: `Wrote ${appliedCount} file${appliedCount === 1 ? "" : "s"}`,
                  toolCall: { appliedCount, paths },
                },
              ]
            : nextMessages,
        );
        if (appliedCount > 0 && paths.length) markTouched(paths);
      } else {
        const inlineMessage: ChatMessage = {
          id: `agent-${Date.now()}`,
          role: agentSucceeded ? "agent" : "system",
          content: reply,
        };
        if (turnTokens && agentSucceeded) inlineMessage.tokens = turnTokens;
        setMessages((current) => [...current, inlineMessage]);
      }
      if (agentSucceeded) {
        if (dirtyRef.current) await loadProject(selectedPathRef.current, { preserveDraft: true, signal });
        else await loadProject(selectedPathRef.current, { signal });
        if (activeSectionRef.current === "assets" || activeSectionRef.current === "workshop") await loadMedia(signal);
      } else {
        // Server returned non-2xx (502 hosted-turn failure, 429 rate
        // limit, etc.). The user just spent a thought composing this
        // message — drop it back into the composer so they can edit +
        // retry without retyping. The failed reply already rendered as
        // a system bubble in the thread above.
        setAgentInput((current) => (current ? current : userMessage));
      }
    } catch {
      if (!isCurrentProject(requestProjectId, signal)) return;
      setMessages((current) => [
        ...current,
        { id: `agent-error-${Date.now()}`, role: "system", content: "Could not reach hosted Anvil Agent. Your message is restored in the composer." },
      ]);
      // Network/fetch error — restore the input so the user can retry.
      setAgentInput((current) => (current ? current : userMessage));
    } finally {
      if (isCurrentProject(requestProjectId, signal)) {
        agentBusyLockRef.current = false;
        setAgentBusy(false);
      }
    }
  }

  const stableSwitchSection = useStableCallback(switchSection);
  const stableSetScriptChild = useStableCallback(setScriptChild);
  const stableSelectFile = useStableCallback(selectFile);
  const stableSaveFile = useStableCallback(saveFile);
  const stableCreateFile = useStableCallback(createFile);
  const stableCreatePromptForScene = useStableCallback(createPromptForScene);
  const stableLoadRevisions = useStableCallback(loadRevisions);
  const stableUploadMedia = useStableCallback(uploadMedia);
  const stableSendAgentTurn = useStableCallback(sendAgentTurn);
  const stableUploadMediaForCard = useStableCallback(uploadMediaForCard);
  const stableLoadProjectAssets = useStableCallback(loadProjectAssets);
  const stableCreateProjectAsset = useStableCallback(createProjectAsset);
  const stableDeleteProjectAsset = useStableCallback(deleteProjectAsset);

  useEffect(() => {
    const initialPath = "story/project-scope.md";
    projectIdRef.current = projectId;
    projectRef.current = null;
    selectedPathRef.current = initialPath;
    selectedFileRef.current = null;
    draftRef.current = "";
    dirtyRef.current = false;
    selectedMediaRef.current = null;
    threadIdRef.current = null;
    agentBusyLockRef.current = false;
    setAgentBusy(false);
    setStatus("Loading project...");
    setProject(null);
    setSelectedPath(initialPath);
    setDraft("");
    setDirty(false);
    setMessages([]);
    setThreadId(null);
    setMediaAssets([]);
    setSelectedMediaId(null);
    setProjectAssets([]);
    setSelectedAssetId(null);
    setProjectAssetsStatus("Idle");
    touchedExpiriesRef.current.clear();
    setTouchedPaths(new Set());
    stopTouchedPrune();
    setRevisions([]);
    setPreviewRevisionId(null);
    setConflictFile(null);
    setMediaBusy(false);
    projectAbortControllerRef.current?.abort();
    const controller = new AbortController();
    projectAbortControllerRef.current = controller;
    void loadProject(initialPath, { signal: controller.signal });
    void loadAgentThread(controller.signal);
    return () => {
      controller.abort();
      if (projectAbortControllerRef.current === controller) {
        projectAbortControllerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    setSelectedAssetId((current) => {
      if (!current) return current;
      const selectedCard = projectAssets.find((card) => card.assetId === current);
      if (!selectedCard) return null;
      if (activeAssetCategory === "all") return current;
      const visibleSection = cardSectionForAssetCategory(activeAssetCategory);
      return visibleSection && selectedCard.section === visibleSection ? current : null;
    });
  }, [activeAssetCategory, projectAssets]);

  useEffect(() => {
    const sync = () => setActiveScriptChild(readScriptChildFromUrl());
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  useEffect(() => {
    if (activeSection !== "assets" && activeSection !== "workshop") return;
    const controller = new AbortController();
    void loadMedia(controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSection, projectId]);

  useEffect(() => {
    if (activeSection !== "assets") return;
    const controller = new AbortController();
    void loadProjectAssets(controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSection, projectId]);

  useEffect(() => {
    if (!historyOpen || activeSection === "assets" || activeSection === "workshop") return;
    const controller = new AbortController();
    void loadRevisions(selectedPath, controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyOpen, selectedPath, activeSection, projectId]);

  return useMemo<WorkspaceContextValue>(
    () => ({
      user,
      projectId,
      project,
      setProject,
      files,
      activeSection,
      switchSection: stableSwitchSection,
      activeScriptChild,
      setScriptChild: stableSetScriptChild,
      activeAssetCategory,
      setActiveAssetCategory,
      activeCategory,
      selectedPath,
      setSelectedPath,
      selectedFile,
      selectFile: stableSelectFile,
      fileTreeGroups,
      draft,
      setDraft,
      dirty,
      setDirty,
      status,
      setStatus,
      conflictFile,
      setConflictFile,
      saveFile: stableSaveFile,
      createFile: stableCreateFile,
      createPromptForScene: stableCreatePromptForScene,
      historyOpen,
      setHistoryOpen,
      revisions,
      revisionStatus,
      loadRevisions: stableLoadRevisions,
      previewRevision,
      previewExcerpt,
      previewRevisionId,
      setPreviewRevisionId,
      revisionCompare,
      mediaAssets,
      filteredMediaAssets,
      selectedMedia,
      setSelectedMediaId,
      mediaReady,
      mediaPreviewUrl,
      mediaStatus,
      mediaBusy,
      mediaProgress,
      fileInputRef,
      uploadMedia: stableUploadMedia,
      threadId,
      messages,
      agentInput,
      setAgentInput,
      agentBusy,
      sendAgentTurn: stableSendAgentTurn,
      touchedPaths,
      touchedFilesBySection,
      uploadMediaForCard: stableUploadMediaForCard,
      projectAssets,
      projectAssetsStatus,
      loadProjectAssets: stableLoadProjectAssets,
      createProjectAsset: stableCreateProjectAsset,
      deleteProjectAsset: stableDeleteProjectAsset,
      selectedAssetId,
      setSelectedAssetId,
    }),
    [
      activeAssetCategory,
      activeCategory,
      activeScriptChild,
      activeSection,
      agentBusy,
      agentInput,
      conflictFile,
      dirty,
      draft,
      fileTreeGroups,
      files,
      filteredMediaAssets,
      historyOpen,
      mediaAssets,
      mediaBusy,
      mediaPreviewUrl,
      mediaProgress,
      mediaReady,
      mediaStatus,
      messages,
      previewExcerpt,
      previewRevision,
      previewRevisionId,
      project,
      projectAssets,
      projectAssetsStatus,
      projectId,
      revisionCompare,
      revisionStatus,
      revisions,
      selectedAssetId,
      selectedFile,
      selectedMedia,
      selectedPath,
      stableCreateFile,
      stableCreateProjectAsset,
      stableCreatePromptForScene,
      stableDeleteProjectAsset,
      stableLoadProjectAssets,
      stableLoadRevisions,
      stableSaveFile,
      stableSelectFile,
      stableSendAgentTurn,
      stableSetScriptChild,
      stableSwitchSection,
      stableUploadMedia,
      stableUploadMediaForCard,
      status,
      threadId,
      touchedFilesBySection,
      touchedPaths,
      user,
    ],
  );
}
