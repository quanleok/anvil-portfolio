import { randomUUID } from "node:crypto";
import { createSupabaseAdminClient, hasSupabaseAdminConfig } from "@/lib/supabase/admin";
import { getMediaAssetForOwner, listMediaAssetsForOwner, setMediaAssetCardForOwner } from "@/server/media/db";
import {
  sanitizeAnvilRelativePath,
  type AnvilContextFile,
  type AnvilFileAction,
} from "@/shared/anvil-api";
import {
  parseBrowserProjectDocumentForWrite,
  parseBrowserProjectDocumentJsonb,
  VALID_FILE_ROOTS,
} from "./jsonb-schemas";

export type BrowserProjectPrivacy = "private" | "team" | "public-draft";

export type BrowserProjectFile = {
  path: string;
  title: string;
  kind: "markdown" | "media-note" | "system";
  content: string;
  /** Optional grouping for context docs — mirrors desktop's
   *  StoryEntry.contextGroup. Builtin groups: project · canon · asset.
   *  Custom groups: any slug. Null/undefined means the file is not a
   *  context doc (script, scenes, prompts, etc.). */
  contextGroup?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type BrowserProjectFileRevision = {
  id: string;
  ownerId: string;
  projectId: string;
  path: string;
  title: string;
  kind: BrowserProjectFile["kind"];
  operation: "create" | "update" | "append" | "delete" | "action" | "import" | "system";
  content: string;
  previousContent: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type BrowserProjectAssetCategory = {
  id: string;
  name: string;
  kind: "character" | "location" | "prop" | "keyframe" | "audio" | "video" | "other";
};

/** Phase D, slice D1: Asset Cards. Each asset is its own entity card —
 *  name + folder + notes — and media variants (`anvil_media_assets`)
 *  attach back via the new nullable `asset_id` column. Mirrors
 *  desktop's AssetEntry from apps/desktop/src/types.ts. */
export type BrowserProjectAssetSection =
  | "characters"
  | "locations"
  | "props"
  | "keyframes"
  | "audio"
  | "videos";

export type BrowserProjectAsset = {
  assetId: string;
  section: BrowserProjectAssetSection;
  name: string;
  folder: string | null;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type BrowserTimelineClip = {
  id: string;
  mediaAssetId: string;
  track: "V1" | "A1";
  startSec: number;
  durationSec: number;
  title: string;
  fileName: string;
  kind: "video" | "audio";
};

export type BrowserProjectTimeline = {
  version: 1;
  clips: BrowserTimelineClip[];
  updatedAt: string;
};

export type BrowserProjectDocument = {
  schemaVersion: 1;
  icon: string;
  files: Record<string, BrowserProjectFile>;
  assetCategories: BrowserProjectAssetCategory[];
  /** Phase D, slice D1: card-shaped assets attached to one of the
   *  typed asset sections. Empty array is the legacy default. The
   *  aggregator "media" view computes over this list at render time
   *  and is never persisted. */
  assets: BrowserProjectAsset[];
  timeline: BrowserProjectTimeline;
  createdAt: string;
  updatedAt: string;
};

export type BrowserProjectSummary = {
  id: string;
  name: string;
  privacy: BrowserProjectPrivacy;
  icon: string;
  fileCount: number;
  assetCategoryCount: number;
  persisted: boolean;
  createdAt: string;
  updatedAt: string;
};

export type BrowserProjectRecord = BrowserProjectSummary & {
  project: BrowserProjectDocument;
};

type ProjectRow = {
  id: string;
  owner_id: string | null;
  name: string;
  privacy: BrowserProjectPrivacy;
  project: unknown;
  created_at: string;
  updated_at: string;
};

type ProjectFileRow = {
  owner_id: string;
  project_id: string;
  path: string;
  title: string;
  kind: BrowserProjectFile["kind"];
  content: string;
  metadata: Record<string, unknown>;
  version: number;
  created_at: string;
  updated_at: string;
};

type ProjectFileRevisionRow = {
  id: string;
  owner_id: string;
  project_id: string;
  path: string;
  title: string;
  kind: BrowserProjectFile["kind"];
  operation: BrowserProjectFileRevision["operation"];
  content: string;
  previous_content: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

type ProjectAssetRow = {
  asset_id: string;
  owner_id: string;
  project_id: string;
  section: BrowserProjectAssetSection;
  name: string;
  folder: string | null;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

type ProjectDatabase = {
  public: {
    Tables: {
      anvil_projects: {
        Row: ProjectRow;
        Insert: {
          id: string;
          owner_id: string;
          name: string;
          privacy: BrowserProjectPrivacy;
          project: BrowserProjectDocument;
        };
        Update: {
          name?: string;
          privacy?: BrowserProjectPrivacy;
          project?: BrowserProjectDocument;
          updated_at?: string;
        };
        Relationships: [];
      };
      anvil_project_files: {
        Row: ProjectFileRow;
        Insert: Omit<ProjectFileRow, "version" | "created_at" | "updated_at"> & {
          version?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Omit<ProjectFileRow, "owner_id" | "project_id" | "path" | "created_at">>;
        Relationships: [];
      };
      anvil_project_file_revisions: {
        Row: ProjectFileRevisionRow;
        Insert: Omit<ProjectFileRevisionRow, "created_at"> & {
          created_at?: string;
        };
        Update: never;
        Relationships: [];
      };
      anvil_project_assets: {
        Row: ProjectAssetRow;
        Insert: Omit<ProjectAssetRow, "created_at" | "updated_at"> & {
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Omit<ProjectAssetRow, "asset_id" | "owner_id" | "project_id" | "created_at">>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      anvil_update_project_document_and_files: {
        Args: {
          p_owner_id: string;
          p_project_id: string;
          p_project: BrowserProjectDocument;
          p_updated_at: string;
        };
        Returns: ProjectRow;
      };
      anvil_delete_project_file: {
        Args: {
          p_owner_id: string;
          p_project_id: string;
          p_file_path: string;
          p_project: BrowserProjectDocument;
          p_updated_at: string;
        };
        Returns: ProjectRow;
      };
      anvil_rename_project_file: {
        Args: {
          p_owner_id: string;
          p_project_id: string;
          p_from_path: string;
          p_to_path: string;
          p_project: BrowserProjectDocument;
          p_updated_at: string;
        };
        Returns: ProjectRow;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

const VALID_PRIVACY = new Set<BrowserProjectPrivacy>(["private", "team", "public-draft"]);
const VALID_FILE_ROOT_SET = new Set<string>(VALID_FILE_ROOTS);
const MAX_PROJECT_NAME = 120;
const MAX_FILE_CONTENT = 240_000;
const MAX_CONTEXT_FILES = 24;
const MAX_PROJECT_FILE_ACTIONS = 80;
const MAX_MEMORY_PROJECTS_PER_OWNER = 50;

type WritableAnvilFileAction = Extract<AnvilFileAction, { type: "write_file" | "append_file" }>;

type RoutedWritableAction = {
  action: WritableAnvilFileAction;
  originalPath: string;
  routeReason: string | null;
};

type RecoveredWritableAction = WritableAnvilFileAction & {
  recoveredFrom?: string;
  recoveryReason?: string;
};

const memoryProjects = new Map<string, Map<string, BrowserProjectRecord>>();

function trimMemoryProjects(projects: Map<string, BrowserProjectRecord>) {
  while (projects.size > MAX_MEMORY_PROJECTS_PER_OWNER) {
    let oldestKey: string | null = null;
    let oldestTime = Number.POSITIVE_INFINITY;
    for (const [key, record] of projects) {
      const time = Date.parse(record.updatedAt || record.createdAt || "");
      const sortableTime = Number.isFinite(time) ? time : 0;
      if (sortableTime < oldestTime) {
        oldestTime = sortableTime;
        oldestKey = key;
      }
    }
    if (!oldestKey) break;
    projects.delete(oldestKey);
  }
}

export class ProjectStoreUnavailableError extends Error {
  status = 503;

  constructor(message = "Project storage requires Supabase service-role configuration.") {
    super(message);
    this.name = "ProjectStoreUnavailableError";
  }
}

export class ProjectNotFoundError extends Error {
  status = 404;

  constructor(message = "Project was not found for this account.") {
    super(message);
    this.name = "ProjectNotFoundError";
  }
}

export class ProjectFileConflictError extends Error {
  status = 409;
  file: BrowserProjectFile;

  constructor(file: BrowserProjectFile) {
    super("This file changed on the server. Reload it or save again to overwrite.");
    this.name = "ProjectFileConflictError";
    this.file = file;
  }
}

export class ProjectAssetNotFoundError extends Error {
  status = 404;
  constructor(message = "Asset card not found.") {
    super(message);
    this.name = "ProjectAssetNotFoundError";
  }
}

export class ProjectAssetMediaError extends Error {
  status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = "ProjectAssetMediaError";
    this.status = status;
  }
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function ownerHasDurableStore(ownerId: string) {
  return hasSupabaseAdminConfig() && isUuid(ownerId);
}

export function browserProjectStoreStatus(ownerId?: string) {
  return {
    supabaseAdminConfigured: hasSupabaseAdminConfig(),
    ownerHasDurableStore: ownerId ? ownerHasDurableStore(ownerId) : false,
  };
}

function assertProjectStore(ownerId: string) {
  if (ownerHasDurableStore(ownerId)) return;
  if (process.env.NODE_ENV !== "production") return;
  throw new ProjectStoreUnavailableError();
}

function cleanText(value: unknown, max = 4000) {
  return typeof value === "string" ? value.replace(/\0/g, "").trim().slice(0, max) : "";
}

function cleanFileContent(value: unknown, max = MAX_FILE_CONTENT) {
  return typeof value === "string" ? value.replace(/\0/g, "").slice(0, max) : "";
}

function sameTimestamp(left: string, right: string) {
  if (left === right) return true;
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime === rightTime;
}

function projectName(value: unknown) {
  const name = cleanText(value, MAX_PROJECT_NAME);
  return name || "Anvil Project";
}

function projectPrivacy(value: unknown): BrowserProjectPrivacy {
  const privacy = cleanText(value, 40);
  return VALID_PRIVACY.has(privacy as BrowserProjectPrivacy) ? (privacy as BrowserProjectPrivacy) : "private";
}

function projectIcon(value: unknown) {
  const icon = cleanText(value, 80);
  return icon || "canon-book";
}

export function sanitizeBrowserProjectFilePath(value: unknown) {
  const filePath = sanitizeAnvilRelativePath(value);
  const root = filePath.split("/")[0] || "";
  if (!VALID_FILE_ROOT_SET.has(root)) {
    throw new Error("file path must stay in story/, script/, scenes/, shots/, prompts/, assets/, custom/, or dialogue/");
  }
  if (!filePath.endsWith(".md")) {
    throw new Error("browser project files must be markdown documents");
  }
  if (filePath.includes("..")) {
    throw new Error("browser project file paths cannot contain consecutive dots");
  }
  if (!/^[A-Za-z0-9._/ -]+[.]md$/.test(filePath)) {
    throw new Error("browser project file paths may only use letters, numbers, spaces, dots, dashes, underscores, and folders");
  }
  return filePath;
}

function fileTitle(filePath: string) {
  const name = filePath.split("/").pop() || filePath;
  return name
    .replace(/\.md$/i, "")
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function boundedTimelineSeconds(value: unknown, fallback: number, max: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(max, Math.round(number * 100) / 100));
}

function coerceTimelineClip(value: unknown): BrowserTimelineClip | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const mediaAssetId = cleanText(source.mediaAssetId, 180);
  if (!mediaAssetId) return null;
  const kind = source.kind === "audio" ? "audio" : "video";
  const track = source.track === "A1" || kind === "audio" ? "A1" : "V1";
  return {
    id: cleanText(source.id, 180) || `clip_${randomUUID()}`,
    mediaAssetId,
    track,
    startSec: boundedTimelineSeconds(source.startSec, 0, 24 * 60 * 60),
    durationSec: Math.max(0.1, boundedTimelineSeconds(source.durationSec, kind === "audio" ? 30 : 15, 24 * 60 * 60)),
    title: cleanText(source.title, 180) || "Timeline clip",
    fileName: cleanText(source.fileName, 240) || "media",
    kind,
  };
}

function coerceProjectTimeline(value: unknown, now = new Date().toISOString()): BrowserProjectTimeline {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  const clips = Array.isArray(source.clips)
    ? source.clips.map(coerceTimelineClip).filter((clip): clip is BrowserTimelineClip => Boolean(clip)).slice(0, 240)
    : [];
  return {
    version: 1,
    clips: clips.sort((left, right) =>
      left.track === right.track
        ? left.startSec - right.startSec
        : left.track.localeCompare(right.track),
    ),
    updatedAt: cleanText(source.updatedAt, 80) || now,
  };
}

function routeToken(value: string) {
  return value
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function fileBaseToken(filePath: string) {
  return routeToken(filePath.split("/").pop() || filePath);
}

function slugForFile(value: string, fallback: string) {
  const slug = routeToken(value)
    .replace(/^(scene|shot|prompt)-\d{1,4}-?/, "")
    .slice(0, 72)
    .replace(/-+$/g, "");
  return slug || fallback;
}

function contentHasHeading(content: string, names: string[]) {
  const lower = content.slice(0, 16_000).toLowerCase();
  return names.some((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|\\n)\\s{0,3}#{1,3}\\s+${escaped}(\\s|$|[-:])`, "i").test(lower);
  });
}

function canonicalPathForAgentWrite(action: WritableAnvilFileAction): { path: string; reason: string | null } {
  const originalPath = sanitizeBrowserProjectFilePath(action.path);
  const root = originalPath.split("/")[0] || "";
  const base = fileBaseToken(originalPath);
  const content = cleanFileContent(action.content, 16_000);
  const customDraft = originalPath.startsWith("custom/drafts/") || originalPath.startsWith("custom/draft/");

  if (originalPath === "story/intake.md") {
    return { path: "story/project-scope.md", reason: "legacy_intake_path" };
  }

  if (
    ["project-scope", "scope", "intake", "brief", "creative-brief"].includes(base) ||
    (customDraft && contentHasHeading(content, ["project scope", "scope", "creative brief", "intake"]))
  ) {
    return { path: "story/project-scope.md", reason: "canonical_project_scope" };
  }

  if (
    ["world-bible", "bible", "world", "lore", "canon", "look-bible"].includes(base) ||
    (customDraft && contentHasHeading(content, ["world bible", "canon", "lore", "look bible"]))
  ) {
    return { path: "story/world-bible.md", reason: "canonical_world_bible" };
  }

  if (
    ["asset-context", "assets-context", "asset-library", "media-context", "reference-context", "reference-plan"].includes(base) ||
    (customDraft && contentHasHeading(content, ["asset context", "assets", "reference plan", "media context"]))
  ) {
    return { path: "story/asset-context.md", reason: "canonical_asset_context" };
  }

  if (
    ["master-script", "full-script"].includes(base) ||
    (base === "script" && (root === "custom" || customDraft)) ||
    (customDraft && contentHasHeading(content, ["master script", "script draft"]))
  ) {
    return { path: "script/master-script.md", reason: "canonical_master_script" };
  }

  return { path: originalPath, reason: null };
}

function routeWritableAgentAction(action: WritableAnvilFileAction): RoutedWritableAction {
  const originalPath = sanitizeBrowserProjectFilePath(action.path);
  const routed = canonicalPathForAgentWrite(action);
  return {
    action: routed.path === originalPath ? action : { ...action, path: routed.path },
    originalPath,
    routeReason: routed.reason,
  };
}

function countMatches(value: string, pattern: RegExp) {
  return value.match(pattern)?.length || 0;
}

function wholePackageDraftReason(action: WritableAnvilFileAction) {
  const filePath = sanitizeBrowserProjectFilePath(action.path);
  if (!filePath.startsWith("custom/")) return "";

  const content = cleanFileContent(action.content, 80_000);
  if (content.length < 2500) return "";

  const lower = content.toLowerCase();
  const markerCount = [
    /\bproject scope\b/,
    /\bworld bible\b/,
    /\basset context\b/,
    /\bmaster script\b/,
    /\bvisual intent\b/,
    /\bscene\s+\d{1,3}\b/,
    /\bshot\s+\d{1,3}\b/,
    /\bprompt\s+\d{1,3}\b/,
  ].filter((pattern) => pattern.test(lower)).length;
  const sceneHeadings = countMatches(lower, /(^|\n)\s{0,3}#{1,4}\s*scene\s+\d{1,3}\b/g);
  const shotHeadings = countMatches(lower, /(^|\n)\s{0,3}#{1,4}\s*shot\s+\d{1,3}\b/g);
  const promptMentions = countMatches(lower, /\bprompt\s+\d{1,3}\b/g);

  if (markerCount >= 4 || (sceneHeadings >= 2 && promptMentions >= 3) || (sceneHeadings >= 1 && shotHeadings >= 2)) {
    return "This document contains multiple recognized file sections. Use explicit headings so the workspace can route them to their matching files.";
  }

  return "";
}

function markdownSections(contentInput: string) {
  const content = cleanFileContent(contentInput, MAX_FILE_CONTENT);
  const headingPattern = /^(#{1,6})\s+(.+?)\s*$/gm;
  const headings: Array<{ index: number; level: number; title: string; line: string }> = [];
  let match: RegExpExecArray | null;

  while ((match = headingPattern.exec(content))) {
    headings.push({
      index: match.index,
      level: match[1].length,
      title: match[2].trim(),
      line: match[0],
    });
  }

  return headings.map((heading, index) => {
    const next = headings.find((candidate, candidateIndex) => candidateIndex > index && candidate.level <= heading.level);
    const end = next?.index ?? content.length;
    return {
      level: heading.level,
      title: heading.title,
      content: content.slice(heading.index, end).trim(),
    };
  });
}

function numberedSectionPath(kind: "scene" | "shot" | "prompt", title: string) {
  const match = title.match(new RegExp(`^${kind}\\s+0*(\\d{1,4})\\s*(?:[-:–—]\\s*)?(.*)$`, "i"));
  if (!match) return "";
  const index = Number(match[1]);
  if (!Number.isFinite(index) || index <= 0) return "";
  const padded = String(index).padStart(2, "0");
  const label = slugForFile(match[2] || title, `${kind}-${padded}`);
  const root = kind === "scene" ? "scenes" : kind === "shot" ? "shots" : "prompts";
  return `${root}/${padded}-${label}.md`;
}

function packageSectionPath(title: string) {
  const token = routeToken(title);
  if (["project-scope", "scope", "creative-brief", "intake"].includes(token)) return "story/project-scope.md";
  if (["world-bible", "bible", "world", "lore", "canon", "look-bible"].includes(token)) return "story/world-bible.md";
  if (["asset-context", "assets", "asset-library", "reference-plan", "media-context"].includes(token)) {
    return "story/asset-context.md";
  }
  if (["master-script", "script", "full-script"].includes(token)) return "script/master-script.md";
  return numberedSectionPath("scene", title) || numberedSectionPath("shot", title) || numberedSectionPath("prompt", title);
}

function stripNestedPackageSections(content: string, path: string) {
  const nestedKinds =
    path.startsWith("scenes/")
      ? /^(shot|prompt)\s+0*\d{1,4}\b/i
      : path.startsWith("shots/")
        ? /^prompt\s+0*\d{1,4}\b/i
        : null;
  if (!nestedKinds) return content;

  const headings: Array<{ index: number; level: number; title: string }> = [];
  const headingPattern = /^(#{1,6})\s+(.+?)\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(content))) {
    headings.push({
      index: match.index,
      level: match[1].length,
      title: match[2].trim(),
    });
  }

  const removals: Array<[number, number]> = [];
  headings.forEach((heading, index) => {
    if (!nestedKinds.test(heading.title)) return;
    const next = headings.find((candidate, candidateIndex) => candidateIndex > index && candidate.level <= heading.level);
    removals.push([heading.index, next?.index ?? content.length]);
  });
  if (!removals.length) return content;

  let output = "";
  let cursor = 0;
  for (const [start, end] of removals) {
    if (start < cursor) {
      cursor = Math.max(cursor, end);
      continue;
    }
    output += content.slice(cursor, start).trimEnd();
    cursor = end;
  }
  output += content.slice(cursor);
  return output.replace(/\n{3,}/g, "\n\n").trim();
}

function recoverPackageDraftActions(action: WritableAnvilFileAction): RecoveredWritableAction[] {
  const reason = wholePackageDraftReason(action);
  if (!reason) return [];

  const originalPath = sanitizeBrowserProjectFilePath(action.path);
  const sections = markdownSections(action.content);
  const recovered: RecoveredWritableAction[] = [];
  const usedPaths = new Set<string>();

  for (const section of sections) {
    const path = packageSectionPath(section.title);
    if (!path || usedPaths.has(path)) continue;
    usedPaths.add(path);
    recovered.push({
      type: action.type,
      path,
      content: stripNestedPackageSections(section.content, path),
      reason: action.reason || "Recovered from all-in-one draft package.",
      recoveredFrom: originalPath,
      recoveryReason: "package_section_split",
    });
  }

  return recovered.slice(0, MAX_PROJECT_FILE_ACTIONS);
}

// Builtin context-doc paths → their canonical group. Mirrors desktop's
// `BUILTIN_CONTEXT_DOCS` in apps/desktop/src/lib/context-docs.ts so the
// server seeds the same group values desktop would derive.
const BUILTIN_CONTEXT_GROUP: Record<string, "project" | "canon" | "asset"> = {
  "story/project-scope.md": "project",
  "story/world-bible.md": "canon",
  "story/asset-context.md": "asset",
};

function normalizeContextGroup(value: unknown, filePath: string): string | null {
  // 1. Explicit override wins.
  if (typeof value === "string") {
    const raw = value.trim().toLowerCase();
    if (raw === "project" || raw === "canon" || raw === "asset") return raw;
    const slug = raw.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
    if (slug) return slug;
  }
  // 2. Builtin paths have a canonical group.
  if (BUILTIN_CONTEXT_GROUP[filePath]) return BUILTIN_CONTEXT_GROUP[filePath];
  // 3. Other story/* docs default to canon (legacy fallback).
  if (filePath.startsWith("story/")) return "canon";
  // 4. Non-context paths (script, scenes, prompts, etc.) carry no group.
  return null;
}

function makeProjectFile(
  filePath: string,
  content: string,
  now: string,
  contextGroup?: string | null,
): BrowserProjectFile {
  const group = normalizeContextGroup(contextGroup, filePath);
  return {
    path: filePath,
    title: fileTitle(filePath),
    kind: "markdown",
    content: cleanFileContent(content),
    ...(group ? { contextGroup: group } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

function coerceProjectFileRow(row: ProjectFileRow): BrowserProjectFile {
  const metadataGroup = row.metadata && typeof row.metadata === "object"
    ? (row.metadata as Record<string, unknown>).contextGroup
    : null;
  const group = normalizeContextGroup(metadataGroup, row.path);
  return {
    path: row.path,
    title: cleanText(row.title, 160) || fileTitle(row.path),
    kind: row.kind === "media-note" || row.kind === "system" ? row.kind : "markdown",
    content: cleanFileContent(row.content),
    ...(group ? { contextGroup: group } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function coerceProjectFileRevisionRow(row: ProjectFileRevisionRow): BrowserProjectFileRevision {
  return {
    id: row.id,
    ownerId: row.owner_id,
    projectId: row.project_id,
    path: row.path,
    title: cleanText(row.title, 160) || fileTitle(row.path),
    kind: row.kind === "media-note" || row.kind === "system" ? row.kind : "markdown",
    operation: row.operation,
    content: cleanFileContent(row.content),
    previousContent: row.previous_content === null ? null : cleanFileContent(row.previous_content),
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    createdAt: row.created_at,
  };
}

const VALID_ASSET_SECTIONS = new Set<BrowserProjectAssetSection>([
  "characters",
  "locations",
  "props",
  "keyframes",
  "audio",
  "videos",
]);

export function isBrowserProjectAssetSection(value: unknown): value is BrowserProjectAssetSection {
  return typeof value === "string" && VALID_ASSET_SECTIONS.has(value as BrowserProjectAssetSection);
}

export function coerceProjectAssetRow(row: ProjectAssetRow): BrowserProjectAsset {
  const section: BrowserProjectAssetSection = VALID_ASSET_SECTIONS.has(row.section)
    ? row.section
    : "characters";
  return {
    assetId: row.asset_id,
    section,
    name: cleanText(row.name, 240) || "Untitled",
    folder: row.folder ? cleanText(row.folder, 240) || null : null,
    content: cleanFileContent(row.content),
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function defaultProjectDocument(name: string, icon: string): BrowserProjectDocument {
  const now = new Date().toISOString();
  const files = {
    "story/project-scope.md": makeProjectFile(
      "story/project-scope.md",
      ["# Project Scope", "", "Visible project scope, format, runtime, premise, references, and hard constraints."].join("\n"),
      now,
    ),
    "story/world-bible.md": makeProjectFile(
      "story/world-bible.md",
      ["# World Bible", "", "Durable canon, taste, visual identity, and continuity rules."].join("\n"),
      now,
    ),
    "story/asset-context.md": makeProjectFile(
      "story/asset-context.md",
      ["# Asset Context", "", "Characters, locations, props, references, audio, and video generation targets."].join("\n"),
      now,
    ),
    "script/master-script.md": makeProjectFile(
      "script/master-script.md",
      ["# Master Script", "", `Project: ${name}`, "", "Draft the master script here."].join("\n"),
      now,
    ),
  };

  return {
    schemaVersion: 1,
    icon,
    files,
    assetCategories: [
      { id: "character", name: "Character", kind: "character" },
      { id: "location", name: "Location", kind: "location" },
      { id: "prop", name: "Prop", kind: "prop" },
      { id: "keyframe", name: "Keyframe", kind: "keyframe" },
      { id: "audio", name: "Audio", kind: "audio" },
      { id: "video", name: "Video", kind: "video" },
    ],
    assets: [],
    timeline: {
      version: 1,
      clips: [],
      updatedAt: now,
    },
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeProjectDocument(value: unknown, fallbackName: string): BrowserProjectDocument {
  const now = new Date().toISOString();
  const source = parseBrowserProjectDocumentJsonb(value, "normalizeProjectDocument");
  if (!source) return defaultProjectDocument(fallbackName, "canon-book");
  const fallback = defaultProjectDocument(fallbackName, projectIcon(source.icon));
  const filesSource = source.files && typeof source.files === "object" && !Array.isArray(source.files)
    ? (source.files as Record<string, unknown>)
    : {};
  const files: Record<string, BrowserProjectFile> = { ...fallback.files };

  for (const [rawPath, rawFile] of Object.entries(filesSource)) {
    try {
      const filePath = sanitizeBrowserProjectFilePath(rawPath);
      const file = rawFile && typeof rawFile === "object" ? (rawFile as Record<string, unknown>) : {};
      const group = normalizeContextGroup(file.contextGroup, filePath);
      files[filePath] = {
        path: filePath,
        title: cleanText(file.title, 160) || fileTitle(filePath),
        kind: "markdown",
        content: cleanFileContent(file.content),
        ...(group ? { contextGroup: group } : {}),
        createdAt: cleanText(file.createdAt, 80) || now,
        updatedAt: cleanText(file.updatedAt, 80) || now,
      };
    } catch {
      // Ignore malformed historical file keys.
    }
  }

  // Phase D, slice D1: preserve cards if a snapshot already carries
  // them; otherwise fall back to the empty seed. Card persistence lives
  // primarily in `anvil_project_assets` (loaded separately when a row
  // list is available), so this branch handles in-memory snapshots and
  // legacy stored documents that may pre-date the table.
  const rawAssets = Array.isArray(source.assets) ? (source.assets as unknown[]) : [];
  const assets: BrowserProjectAsset[] = [];
  for (const raw of rawAssets) {
    if (!raw || typeof raw !== "object") continue;
    const value = raw as Record<string, unknown>;
    if (!isBrowserProjectAssetSection(value.section)) continue;
    const assetId = cleanText(value.assetId, 120);
    const name = cleanText(value.name, 240);
    if (!assetId || !name) continue;
    assets.push({
      assetId,
      section: value.section,
      name,
      folder: cleanText(value.folder, 240) || null,
      content: cleanFileContent(value.content),
      metadata: value.metadata && typeof value.metadata === "object" ? (value.metadata as Record<string, unknown>) : {},
      createdAt: cleanText(value.createdAt, 80) || now,
      updatedAt: cleanText(value.updatedAt, 80) || now,
    });
  }

  return {
    schemaVersion: 1,
    icon: projectIcon(source.icon),
    files,
    assetCategories: fallback.assetCategories,
    assets,
    timeline: coerceProjectTimeline(source.timeline, now),
    createdAt: cleanText(source.createdAt, 80) || fallback.createdAt,
    updatedAt: cleanText(source.updatedAt, 80) || fallback.updatedAt,
  };
}

function summarizeProject(record: BrowserProjectRecord): BrowserProjectSummary {
  return {
    id: record.id,
    name: record.name,
    privacy: record.privacy,
    icon: record.icon,
    fileCount: record.fileCount,
    assetCategoryCount: record.assetCategoryCount,
    persisted: record.persisted,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function coerceProjectRow(
  row: ProjectRow,
  persisted = true,
  projectFileRows?: ProjectFileRow[],
  projectAssetRows?: ProjectAssetRow[],
): BrowserProjectRecord {
  const project = normalizeProjectDocument(row.project, row.name);
  // MERGE (don't replace) dedicated-table file rows with the JSONB
  // snapshot. The dedicated table is supplementary — when present,
  // its rows win per-path (fresher copy from syncProjectFiles), but
  // any JSONB-only paths still appear. Prior behavior REPLACED, so
  // if syncProjectFiles silently dropped a row (missing-table swallow
  // on a partial table, race, anything) the JSONB version got
  // shadowed on read and the file vanished — even though
  // updateProjectDocument had successfully written it to the
  // `anvil_projects.project` JSONB column first. Concretely, this
  // is what made the user's scenes/prompts disappear while
  // master-script.md stayed visible.
  if (projectFileRows?.length) {
    const merged = { ...project.files };
    for (const file of projectFileRows.map(coerceProjectFileRow)) {
      merged[file.path] = file;
    }
    project.files = Object.fromEntries(
      Object.values(merged)
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((file) => [file.path, file]),
    );
  }
  // Phase D, slice D2: when the dedicated asset table loaded rows,
  // those win over any snapshot copy in `project.assets`. Snapshot
  // remains the legacy fallback for memory-only / pre-D1 projects.
  if (projectAssetRows) {
    project.assets = projectAssetRows.map(coerceProjectAssetRow);
  }
  return {
    id: row.id,
    name: row.name,
    privacy: projectPrivacy(row.privacy),
    icon: project.icon,
    fileCount: Object.keys(project.files).length,
    assetCategoryCount: project.assetCategories.length,
    persisted,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    project,
  };
}

function ownerMemory(ownerId: string) {
  let projects = memoryProjects.get(ownerId);
  if (!projects) {
    projects = new Map();
    memoryProjects.set(ownerId, projects);
  }
  return projects;
}

function adminClient() {
  return createSupabaseAdminClient<ProjectDatabase>();
}

function isMissingProjectFilesFeature(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String((error as { code?: unknown }).code || "") : "";
  const message = "message" in error ? String((error as { message?: unknown }).message || "") : "";
  return (
    code === "42P01" ||
    code === "PGRST205" ||
    /could not find the table ["']?(public[.])?anvil_project_files["']? in the schema cache/i.test(message) ||
    /could not find the table ["']?(public[.])?anvil_project_file_revisions["']? in the schema cache/i.test(message) ||
    /relation ["']?(public[.])?anvil_project_files["']? does not exist/i.test(message) ||
    /relation ["']?(public[.])?anvil_project_file_revisions["']? does not exist/i.test(message)
  );
}

function isMissingProjectDocumentSyncRpc(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String((error as { code?: unknown }).code || "") : "";
  const message = "message" in error ? String((error as { message?: unknown }).message || "") : "";
  return (
    code === "42883" ||
    code === "PGRST202" ||
    /function .*anvil_update_project_document_and_files/i.test(message)
  );
}

function isMissingProjectFileMutationRpc(error: unknown, functionName: string) {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String((error as { code?: unknown }).code || "") : "";
  const message = "message" in error ? String((error as { message?: unknown }).message || "") : "";
  return code === "42883" || code === "PGRST202" || message.includes(functionName);
}

async function listProjectFileRows(ownerId: string, projectId: string) {
  const { data, error } = await adminClient()
    .from("anvil_project_files")
    .select("*")
    .eq("owner_id", ownerId)
    .eq("project_id", projectId)
    .order("path", { ascending: true });
  if (error) {
    if (isMissingProjectFilesFeature(error)) return null;
    throw error;
  }
  return data || [];
}

function isMissingProjectAssetsFeature(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String((error as { code?: unknown }).code || "") : "";
  const message = "message" in error ? String((error as { message?: unknown }).message || "") : "";
  return (
    code === "42P01" ||
    code === "PGRST205" ||
    /could not find the table ["']?(public[.])?anvil_project_assets["']? in the schema cache/i.test(message) ||
    /relation ["']?(public[.])?anvil_project_assets["']? does not exist/i.test(message)
  );
}

async function listProjectAssetRows(ownerId: string, projectId: string) {
  const { data, error } = await adminClient()
    .from("anvil_project_assets")
    .select("*")
    .eq("owner_id", ownerId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: true })
    .order("name", { ascending: true });
  if (error) {
    if (isMissingProjectAssetsFeature(error)) return null;
    throw error;
  }
  return data || [];
}

async function detachMediaForDeletedProjectAsset(ownerId: string, projectId: string, assetId: string) {
  const mediaRows = await listMediaAssetsForOwner(ownerId, { projectId, limit: 100 }).catch(() => []);
  const linked = mediaRows.filter((media) => media.assetId === assetId);
  if (!linked.length) return;
  await Promise.all(
    linked.map((media) =>
      setMediaAssetCardForOwner(ownerId, media.id, null).catch(() => null),
    ),
  );
}

async function syncProjectFiles(ownerId: string, projectId: string, files: BrowserProjectFile[]) {
  if (!files.length) return;
  const rows = files.map((file) => ({
    owner_id: ownerId,
    project_id: projectId,
    path: sanitizeBrowserProjectFilePath(file.path),
    title: cleanText(file.title, 160) || fileTitle(file.path),
    kind: file.kind,
    content: cleanFileContent(file.content),
    metadata: file.contextGroup ? { contextGroup: file.contextGroup } : {},
    updated_at: file.updatedAt || new Date().toISOString(),
  }));
  const { error } = await adminClient()
    .from("anvil_project_files")
    .upsert(rows, { onConflict: "project_id,path" });
  if (error && !isMissingProjectFilesFeature(error)) throw error;
}

async function deleteProjectFileRow(ownerId: string, projectId: string, filePath: string) {
  const { error } = await adminClient()
    .from("anvil_project_files")
    .delete()
    .eq("owner_id", ownerId)
    .eq("project_id", projectId)
    .eq("path", filePath);
  if (error && !isMissingProjectFilesFeature(error)) throw error;
}

async function deleteStaleProjectFileRows(ownerId: string, projectId: string, files: BrowserProjectFile[]) {
  const rows = await listProjectFileRows(ownerId, projectId);
  if (!rows) return;
  const nextPaths = new Set(files.map((file) => sanitizeBrowserProjectFilePath(file.path)));
  const staleRows = rows.filter((row) => !nextPaths.has(row.path));
  for (const row of staleRows) {
    await deleteProjectFileRow(ownerId, projectId, row.path);
  }
}

async function deleteProjectFileRevisions(ownerId: string, projectId: string, filePath: string) {
  const { error } = await adminClient()
    .from("anvil_project_file_revisions")
    .delete()
    .eq("owner_id", ownerId)
    .eq("project_id", projectId)
    .eq("path", filePath);
  if (error && !isMissingProjectFilesFeature(error)) throw error;
}

async function insertProjectFileRevision({
  ownerId,
  projectId,
  file,
  operation,
  previousContent,
  metadata = {},
}: {
  ownerId: string;
  projectId: string;
  file: BrowserProjectFile;
  operation: BrowserProjectFileRevision["operation"];
  previousContent?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const { error } = await adminClient()
    .from("anvil_project_file_revisions")
    .insert({
      id: `revision_${randomUUID().replace(/-/g, "")}`,
      owner_id: ownerId,
      project_id: projectId,
      path: sanitizeBrowserProjectFilePath(file.path),
      title: cleanText(file.title, 160) || fileTitle(file.path),
      kind: file.kind,
      operation,
      content: cleanFileContent(file.content),
      previous_content: previousContent === undefined ? null : cleanFileContent(previousContent),
      metadata,
    });
  if (error && !isMissingProjectFilesFeature(error)) throw error;
}

async function insertProjectFileRevisions(
  ownerId: string,
  projectId: string,
  revisions: Array<{
    file: BrowserProjectFile;
    operation: BrowserProjectFileRevision["operation"];
    previousContent?: string | null;
    metadata?: Record<string, unknown>;
  }>,
) {
  if (!revisions.length) return;
  for (const revision of revisions) {
    await insertProjectFileRevision({ ownerId, projectId, ...revision });
  }
}

async function updateProjectDocument(ownerId: string, projectId: string, project: BrowserProjectDocument) {
  assertProjectStore(ownerId);
  const now = new Date().toISOString();
  const updatedProject = parseBrowserProjectDocumentForWrite(
    { ...project, updatedAt: now },
    "updateProjectDocument",
  );

  if (!ownerHasDurableStore(ownerId)) {
    const projects = ownerMemory(ownerId);
    const existing = projects.get(projectId);
    if (!existing) throw new ProjectNotFoundError();
    const updated = {
      ...existing,
      project: updatedProject,
      icon: updatedProject.icon,
      fileCount: Object.keys(updatedProject.files).length,
      assetCategoryCount: updatedProject.assetCategories.length,
      updatedAt: now,
    };
    projects.set(projectId, updated);
    trimMemoryProjects(projects);
    return updated;
  }

  const { data: rpcData, error: rpcError } = await adminClient().rpc(
    "anvil_update_project_document_and_files",
    {
      p_owner_id: ownerId,
      p_project_id: projectId,
      p_project: updatedProject,
      p_updated_at: now,
    },
  );
  if (!rpcError && rpcData) return coerceProjectRow(rpcData);
  if (rpcError && !isMissingProjectDocumentSyncRpc(rpcError)) throw rpcError;

  // Migration fallback: write the dedicated file rows first because
  // reads prefer them over the JSONB snapshot. If the later snapshot
  // write fails, the user's latest file contents still win on reload.
  const updatedFiles = Object.values(updatedProject.files);
  await deleteStaleProjectFileRows(ownerId, projectId, updatedFiles);
  await syncProjectFiles(ownerId, projectId, updatedFiles);
  const { data, error } = await adminClient()
    .from("anvil_projects")
    .update({ project: updatedProject, updated_at: now })
    .eq("id", projectId)
    .eq("owner_id", ownerId)
    .select("*")
    .single();
  if (error || !data) throw new ProjectNotFoundError();
  return coerceProjectRow(data);
}

async function deleteProjectFileDocumentAtomically(
  ownerId: string,
  projectId: string,
  filePath: string,
  project: BrowserProjectDocument,
) {
  const now = new Date().toISOString();
  const updatedProject = parseBrowserProjectDocumentForWrite(
    { ...project, updatedAt: now },
    "deleteProjectFileDocumentAtomically",
  );

  const { data, error } = await adminClient().rpc(
    "anvil_delete_project_file",
    {
      p_owner_id: ownerId,
      p_project_id: projectId,
      p_file_path: filePath,
      p_project: updatedProject,
      p_updated_at: now,
    },
  );
  if (!error && data) return coerceProjectRow(data);
  if (error && isMissingProjectFileMutationRpc(error, "anvil_delete_project_file")) return null;
  if (error) throw error;
  return null;
}

async function renameProjectFileDocumentAtomically(
  ownerId: string,
  projectId: string,
  fromPath: string,
  toPath: string,
  project: BrowserProjectDocument,
) {
  const now = new Date().toISOString();
  const updatedProject = parseBrowserProjectDocumentForWrite(
    { ...project, updatedAt: now },
    "renameProjectFileDocumentAtomically",
  );

  const { data, error } = await adminClient().rpc(
    "anvil_rename_project_file",
    {
      p_owner_id: ownerId,
      p_project_id: projectId,
      p_from_path: fromPath,
      p_to_path: toPath,
      p_project: updatedProject,
      p_updated_at: now,
    },
  );
  if (!error && data) return coerceProjectRow(data);
  if (error && isMissingProjectFileMutationRpc(error, "anvil_rename_project_file")) return null;
  if (error) throw error;
  return null;
}

export async function listBrowserProjectsForOwner(ownerId: string) {
  assertProjectStore(ownerId);

  if (!ownerHasDurableStore(ownerId)) {
    return Array.from(ownerMemory(ownerId).values())
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(summarizeProject);
  }

  const { data, error } = await adminClient()
    .from("anvil_projects")
    .select("*")
    .eq("owner_id", ownerId)
    .order("updated_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data || []).map((row) => summarizeProject(coerceProjectRow(row)));
}

export async function createBrowserProjectForOwner(
  ownerId: string,
  input: { name?: unknown; privacy?: unknown; icon?: unknown } = {},
) {
  assertProjectStore(ownerId);
  const now = new Date().toISOString();
  const name = projectName(input.name);
  const privacy = projectPrivacy(input.privacy);
  const project = parseBrowserProjectDocumentForWrite(
    defaultProjectDocument(name, projectIcon(input.icon)),
    "createBrowserProjectForOwner",
  );
  const id = `project_${randomUUID()}`;

  if (!ownerHasDurableStore(ownerId)) {
    const record: BrowserProjectRecord = {
      id,
      name,
      privacy,
      icon: project.icon,
      fileCount: Object.keys(project.files).length,
      assetCategoryCount: project.assetCategories.length,
      persisted: false,
      createdAt: now,
      updatedAt: now,
      project,
    };
    const projects = ownerMemory(ownerId);
    projects.set(id, record);
    trimMemoryProjects(projects);
    return record;
  }

  const { data, error } = await adminClient()
    .from("anvil_projects")
    .insert({ id, owner_id: ownerId, name, privacy, project })
    .select("*")
    .single();
  if (error) throw error;
  await syncProjectFiles(ownerId, id, Object.values(project.files));
  await insertProjectFileRevisions(
    ownerId,
    id,
    Object.values(project.files).map((file) => ({
      file,
      operation: "create",
      metadata: { source: "project_create" },
    })),
  );
  return coerceProjectRow(data);
}

export async function getBrowserProjectForOwner(ownerId: string, projectId: string) {
  assertProjectStore(ownerId);

  if (!ownerHasDurableStore(ownerId)) {
    const record = ownerMemory(ownerId).get(projectId);
    if (!record) throw new ProjectNotFoundError();
    return record;
  }

  const { data, error } = await adminClient()
    .from("anvil_projects")
    .select("*")
    .eq("id", projectId)
    .eq("owner_id", ownerId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ProjectNotFoundError();
  const projectFiles = await listProjectFileRows(ownerId, projectId);
  const projectAssets = await listProjectAssetRows(ownerId, projectId);
  return coerceProjectRow(data, true, projectFiles || undefined, projectAssets || undefined);
}

export async function updateBrowserProjectForOwner(
  ownerId: string,
  projectId: string,
  input: { name?: unknown; privacy?: unknown; icon?: unknown },
) {
  const existing = await getBrowserProjectForOwner(ownerId, projectId);
  const now = new Date().toISOString();
  const name = input.name === undefined ? existing.name : projectName(input.name);
  const privacy = input.privacy === undefined ? existing.privacy : projectPrivacy(input.privacy);
  const icon = input.icon === undefined ? existing.project.icon : projectIcon(input.icon);
  const project = parseBrowserProjectDocumentForWrite(
    { ...existing.project, icon, updatedAt: now },
    "updateBrowserProjectForOwner",
  );

  if (!ownerHasDurableStore(ownerId)) {
    const projects = ownerMemory(ownerId);
    const updated: BrowserProjectRecord = {
      ...existing,
      name,
      privacy,
      icon,
      project,
      updatedAt: now,
    };
    projects.set(projectId, updated);
    trimMemoryProjects(projects);
    return updated;
  }

  const { data, error } = await adminClient()
    .from("anvil_projects")
    .update({ name, privacy, project, updated_at: now })
    .eq("id", projectId)
    .eq("owner_id", ownerId)
    .select("*")
    .single();
  if (error || !data) throw new ProjectNotFoundError();
  await syncProjectFiles(ownerId, projectId, Object.values(project.files));
  return coerceProjectRow(data);
}

export async function deleteBrowserProjectForOwner(ownerId: string, projectId: string) {
  assertProjectStore(ownerId);

  if (!ownerHasDurableStore(ownerId)) {
    return ownerMemory(ownerId).delete(projectId);
  }

  const { error } = await adminClient()
    .from("anvil_projects")
    .delete()
    .eq("id", projectId)
    .eq("owner_id", ownerId);
  if (error) throw error;
  return true;
}

export async function putBrowserProjectFileForOwner(
  ownerId: string,
  projectId: string,
  filePathInput: unknown,
  contentInput: unknown,
  options: { expectedUpdatedAt?: unknown; force?: unknown; contextGroup?: unknown } = {},
) {
  const filePath = sanitizeBrowserProjectFilePath(filePathInput);
  const existing = await getBrowserProjectForOwner(ownerId, projectId);
  const now = new Date().toISOString();
  const current = existing.project.files[filePath];
  const expectedUpdatedAt = cleanText(options.expectedUpdatedAt, 120);
  const force = options.force === true;

  if (!force && expectedUpdatedAt && current?.updatedAt && !sameTimestamp(current.updatedAt, expectedUpdatedAt)) {
    throw new ProjectFileConflictError(current);
  }

  // Caller may set contextGroup on this save; otherwise preserve what the
  // file already had, falling back to the path-derived default for new
  // context docs.
  const contextGroupOverride =
    options.contextGroup === undefined ? current?.contextGroup : options.contextGroup;
  const group = normalizeContextGroup(contextGroupOverride, filePath);
  const file: BrowserProjectFile = {
    path: filePath,
    title: current?.title || fileTitle(filePath),
    kind: "markdown",
    content: cleanFileContent(contentInput),
    ...(group ? { contextGroup: group } : {}),
    createdAt: current?.createdAt || now,
    updatedAt: now,
  };
  const project = {
    ...existing.project,
    files: {
      ...existing.project.files,
      [filePath]: file,
    },
    updatedAt: now,
  };
  const updated = await updateProjectDocument(ownerId, projectId, project);
  if (ownerHasDurableStore(ownerId)) {
    await insertProjectFileRevision({
      ownerId,
      projectId,
      file,
      operation: current ? "update" : "create",
      previousContent: current?.content ?? null,
      metadata: { source: "editor_save" },
    });
  }
  return updated.project.files[filePath];
}

export async function getBrowserProjectTimelineForOwner(ownerId: string, projectId: string) {
  const project = await getBrowserProjectForOwner(ownerId, projectId);
  return project.project.timeline;
}

export async function putBrowserProjectTimelineForOwner(
  ownerId: string,
  projectId: string,
  timelineInput: unknown,
) {
  const existing = await getBrowserProjectForOwner(ownerId, projectId);
  const timeline = coerceProjectTimeline(timelineInput);
  const updated = await updateProjectDocument(ownerId, projectId, {
    ...existing.project,
    timeline: {
      ...timeline,
      updatedAt: new Date().toISOString(),
    },
  });
  return updated.project.timeline;
}

// ----- Phase D, slice D2: Asset CRUD -----
//
// Persists asset cards in `anvil_project_assets`. Memory-only (non-
// persisted) owners get a snapshot list in `project.assets`. The
// public functions throw ProjectNotFoundError when the project is
// missing and ProjectAssetNotFoundError when a specific assetId is
// missing.
//
// Fallback path for persisted owners whose Supabase doesn't yet
// have the dedicated `anvil_project_assets` table provisioned:
// `snapshotAssetsForOwner` writes the asset list into the existing
// `anvil_projects.project` JSONB column under `assets`. Without
// this, creates/updates appeared to succeed (the insert error was
// swallowed by isMissingProjectAssetsFeature) but vanished on the
// next read because nothing was persisted anywhere. The snapshot
// path is read by `getBrowserProjectForOwner` whenever
// listProjectAssetRows returns null (missing table).

function memoryAssets(ownerId: string, projectId: string) {
  const record = ownerMemory(ownerId).get(projectId);
  if (!record) return null;
  return record.project.assets;
}

async function snapshotAssetsForOwner(
  ownerId: string,
  projectId: string,
  mutate: (current: BrowserProjectAsset[]) => BrowserProjectAsset[],
): Promise<BrowserProjectAsset[] | null> {
  if (!ownerHasDurableStore(ownerId)) return null;
  const { data, error: readError } = await adminClient()
    .from("anvil_projects")
    .select("project, name")
    .eq("id", projectId)
    .eq("owner_id", ownerId)
    .maybeSingle();
  if (readError || !data) return null;
  // Round-trip through normalizeProjectDocument so the JSONB write
  // satisfies the full BrowserProjectDocument shape (schemaVersion,
  // icon, files, assetCategories, etc.) instead of a partial bag.
  const projectDoc = normalizeProjectDocument(data.project, data.name);
  const nextAssets = mutate(projectDoc.assets || []);
  projectDoc.assets = nextAssets;
  const nextProjectDoc = parseBrowserProjectDocumentForWrite(
    projectDoc,
    "snapshotAssetsForOwner",
  );
  const { error: writeError } = await adminClient()
    .from("anvil_projects")
    .update({ project: nextProjectDoc, updated_at: new Date().toISOString() })
    .eq("id", projectId)
    .eq("owner_id", ownerId);
  if (writeError) return null;
  return nextAssets;
}

function nextAssetId() {
  return `asset_${randomUUID().replace(/-/g, "")}`;
}

function sanitizeAssetName(value: unknown, fallback = "Untitled") {
  return cleanText(value, 240) || fallback;
}

function sanitizeAssetFolder(value: unknown) {
  if (value === undefined || value === null) return null;
  const text = cleanText(value, 240);
  return text || null;
}

function sanitizeAssetContent(value: unknown) {
  return typeof value === "string" ? cleanFileContent(value) : "";
}

function sanitizeAssetMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function listBrowserProjectAssetsForOwner(
  ownerId: string,
  projectId: string,
  options: { section?: unknown } = {},
) {
  const existing = await getBrowserProjectForOwner(ownerId, projectId);
  const sectionFilter = isBrowserProjectAssetSection(options.section) ? options.section : null;
  const all = existing.project.assets;
  return sectionFilter ? all.filter((asset) => asset.section === sectionFilter) : all;
}

export async function createBrowserProjectAssetForOwner(
  ownerId: string,
  projectId: string,
  input: { section?: unknown; name?: unknown; folder?: unknown; content?: unknown; metadata?: unknown } = {},
) {
  if (!isBrowserProjectAssetSection(input.section)) {
    throw new Error("section must be one of: characters, locations, props, keyframes, audio, videos");
  }
  const existing = await getBrowserProjectForOwner(ownerId, projectId);
  const now = new Date().toISOString();
  const asset: BrowserProjectAsset = {
    assetId: nextAssetId(),
    section: input.section,
    name: sanitizeAssetName(input.name),
    folder: sanitizeAssetFolder(input.folder),
    content: sanitizeAssetContent(input.content),
    metadata: sanitizeAssetMetadata(input.metadata),
    createdAt: now,
    updatedAt: now,
  };

  if (!ownerHasDurableStore(ownerId)) {
    existing.project.assets.push(asset);
    return asset;
  }

  const { error } = await adminClient()
    .from("anvil_project_assets")
    .insert({
      asset_id: asset.assetId,
      owner_id: ownerId,
      project_id: projectId,
      section: asset.section,
      name: asset.name,
      folder: asset.folder,
      content: asset.content,
      metadata: asset.metadata,
    });
  if (error && !isMissingProjectAssetsFeature(error)) throw error;
  if (error && isMissingProjectAssetsFeature(error)) {
    // Dedicated assets table not provisioned — snapshot into
    // anvil_projects.project.assets so the card survives reload.
    await snapshotAssetsForOwner(ownerId, projectId, (current) => [...current, asset]);
  }
  return asset;
}

export async function updateBrowserProjectAssetForOwner(
  ownerId: string,
  projectId: string,
  assetIdInput: unknown,
  input: { section?: unknown; name?: unknown; folder?: unknown; content?: unknown; metadata?: unknown } = {},
) {
  const assetId = cleanText(assetIdInput, 120);
  if (!assetId) throw new Error("assetId is required");
  await getBrowserProjectForOwner(ownerId, projectId);
  const now = new Date().toISOString();

  const patch: {
    section?: BrowserProjectAssetSection;
    name?: string;
    folder?: string | null;
    content?: string;
    metadata?: Record<string, unknown>;
    updated_at: string;
  } = { updated_at: now };
  if (input.section !== undefined) {
    if (!isBrowserProjectAssetSection(input.section)) {
      throw new Error("section must be one of: characters, locations, props, keyframes, audio, videos");
    }
    patch.section = input.section;
  }
  if (input.name !== undefined) patch.name = sanitizeAssetName(input.name);
  if (input.folder !== undefined) patch.folder = sanitizeAssetFolder(input.folder);
  if (input.content !== undefined) patch.content = sanitizeAssetContent(input.content);
  if (input.metadata !== undefined) patch.metadata = sanitizeAssetMetadata(input.metadata);

  if (!ownerHasDurableStore(ownerId)) {
    const memList = memoryAssets(ownerId, projectId);
    if (!memList) throw new ProjectNotFoundError();
    const idx = memList.findIndex((entry) => entry.assetId === assetId);
    if (idx === -1) throw new ProjectAssetNotFoundError();
    const merged: BrowserProjectAsset = {
      ...memList[idx],
      ...(patch.section ? { section: patch.section } : {}),
      ...(patch.name ? { name: patch.name } : {}),
      ...(patch.folder !== undefined ? { folder: patch.folder } : {}),
      ...(patch.content !== undefined ? { content: patch.content } : {}),
      ...(patch.metadata ? { metadata: patch.metadata } : {}),
      updatedAt: now,
    };
    memList[idx] = merged;
    return merged;
  }

  const { data, error } = await adminClient()
    .from("anvil_project_assets")
    .update(patch)
    .eq("asset_id", assetId)
    .eq("owner_id", ownerId)
    .eq("project_id", projectId)
    .select("*")
    .maybeSingle();
  if (error) {
    if (isMissingProjectAssetsFeature(error)) {
      // Dedicated assets table not provisioned — apply the patch to
      // the JSONB snapshot in anvil_projects.project.assets.
      let updated: BrowserProjectAsset | null = null;
      const next = await snapshotAssetsForOwner(ownerId, projectId, (current) => {
        const idx = current.findIndex((entry) => entry.assetId === assetId);
        if (idx === -1) return current;
        const merged: BrowserProjectAsset = {
          ...current[idx],
          ...(patch.section ? { section: patch.section } : {}),
          ...(patch.name ? { name: patch.name } : {}),
          ...(patch.folder !== undefined ? { folder: patch.folder } : {}),
          ...(patch.content !== undefined ? { content: patch.content } : {}),
          ...(patch.metadata ? { metadata: patch.metadata } : {}),
          updatedAt: now,
        };
        updated = merged;
        const out = current.slice();
        out[idx] = merged;
        return out;
      });
      if (!next || !updated) throw new ProjectAssetNotFoundError();
      return updated;
    }
    throw error;
  }
  if (!data) throw new ProjectAssetNotFoundError();
  return coerceProjectAssetRow(data);
}

export async function deleteBrowserProjectAssetForOwner(
  ownerId: string,
  projectId: string,
  assetIdInput: unknown,
) {
  const assetId = cleanText(assetIdInput, 120);
  if (!assetId) throw new Error("assetId is required");
  await getBrowserProjectForOwner(ownerId, projectId);

  if (!ownerHasDurableStore(ownerId)) {
    const memList = memoryAssets(ownerId, projectId);
    if (!memList) throw new ProjectNotFoundError();
    const idx = memList.findIndex((entry) => entry.assetId === assetId);
    if (idx === -1) return false;
    memList.splice(idx, 1);
    await detachMediaForDeletedProjectAsset(ownerId, projectId, assetId);
    return true;
  }

  const { error, count } = await adminClient()
    .from("anvil_project_assets")
    .delete({ count: "exact" })
    .eq("asset_id", assetId)
    .eq("owner_id", ownerId)
    .eq("project_id", projectId);
  if (error && !isMissingProjectAssetsFeature(error)) throw error;
  if (error && isMissingProjectAssetsFeature(error)) {
    let removed = false;
    await snapshotAssetsForOwner(ownerId, projectId, (current) => {
      const idx = current.findIndex((entry) => entry.assetId === assetId);
      if (idx === -1) return current;
      removed = true;
      const out = current.slice();
      out.splice(idx, 1);
      return out;
    });
    if (removed) await detachMediaForDeletedProjectAsset(ownerId, projectId, assetId);
    return removed;
  }
  const removed = Boolean(count && count > 0);
  if (removed) await detachMediaForDeletedProjectAsset(ownerId, projectId, assetId);
  return removed;
}

// ----- Phase D, slice D3: Media attach/detach -----

const SECTION_TO_MEDIA_KINDS: Record<BrowserProjectAssetSection, Array<"image" | "video" | "audio">> = {
  characters: ["image"],
  locations: ["image", "video"],
  props: ["image"],
  keyframes: ["image", "video"],
  audio: ["audio"],
  videos: ["video"],
};

function findAssetById(
  record: BrowserProjectRecord,
  assetId: string,
): BrowserProjectAsset | undefined {
  return record.project.assets.find((entry) => entry.assetId === assetId);
}

/** Phase D, slice D3: attach an existing media row to an asset card.
 *  Validates that:
 *   - the card belongs to the project + owner,
 *   - the media row belongs to the same project + owner,
 *   - the media `kind` matches the card's section (characters /
 *     locations / props / keyframes → image; audio → audio).
 *  Throws ProjectAssetNotFoundError when the card is missing,
 *  ProjectAssetMediaError (422) when the media is missing or the
 *  kind/section combination is invalid. Returns the updated media
 *  record. */
export async function attachMediaToProjectAssetForOwner(
  ownerId: string,
  projectId: string,
  assetIdInput: unknown,
  mediaIdInput: unknown,
) {
  const cardAssetId = cleanText(assetIdInput, 120);
  if (!cardAssetId) throw new Error("assetId is required");
  const mediaId = cleanText(mediaIdInput, 120);
  if (!mediaId) throw new Error("mediaId is required");

  const project = await getBrowserProjectForOwner(ownerId, projectId);
  const card = findAssetById(project, cardAssetId);
  if (!card) throw new ProjectAssetNotFoundError();

  const expectedKinds = SECTION_TO_MEDIA_KINDS[card.section];
  const media = await getMediaAssetForOwner(ownerId, mediaId);
  if (!media) throw new ProjectAssetMediaError("Media not found.", 404);
  if (media.projectId !== projectId) {
    throw new ProjectAssetMediaError("Media is not in this project.", 422);
  }
  if (!expectedKinds.includes(media.kind as "image" | "video" | "audio")) {
    throw new ProjectAssetMediaError(
      `${card.section} cards expect ${expectedKinds.join(" or ")} media but received ${media.kind}.`,
      422,
    );
  }

  const updated = await setMediaAssetCardForOwner(ownerId, mediaId, cardAssetId);
  return updated || { ...media, assetId: cardAssetId };
}

/** Phase D, slice D3: detach a media row from an asset card. Sets
 *  `asset_id = null`. The media stays in the bin so the user keeps
 *  the upload. Throws ProjectAssetMediaError if the media is missing
 *  or not in this project. */
export async function detachMediaFromProjectAssetForOwner(
  ownerId: string,
  projectId: string,
  mediaIdInput: unknown,
  expectedAssetIdInput?: unknown,
) {
  const mediaId = cleanText(mediaIdInput, 120);
  if (!mediaId) throw new Error("mediaId is required");
  const expectedAssetId = cleanText(expectedAssetIdInput, 120);
  await getBrowserProjectForOwner(ownerId, projectId);

  const media = await getMediaAssetForOwner(ownerId, mediaId);
  if (!media) throw new ProjectAssetMediaError("Media not found.", 404);
  if (media.projectId !== projectId) {
    throw new ProjectAssetMediaError("Media is not in this project.", 422);
  }
  if (expectedAssetId && media.assetId !== expectedAssetId) {
    throw new ProjectAssetMediaError("Media is not attached to this asset.", 422);
  }
  const updated = await setMediaAssetCardForOwner(ownerId, mediaId, null);
  return updated || { ...media, assetId: null };
}

function metadataWithoutBoundMedia(
  metadata: Record<string, unknown>,
  mediaId: string,
): Record<string, unknown> | null {
  const boundId = cleanText(metadata.mediaAssetId, 180);
  if (boundId !== mediaId) return null;
  const next = { ...metadata };
  delete next.mediaAssetId;
  delete next.mediaKind;
  delete next.mediaFileName;
  delete next.mediaCategory;
  return next;
}

export async function clearProjectAssetMediaReferenceForOwner(
  ownerId: string,
  projectIdInput: unknown,
  mediaIdInput: unknown,
  expectedAssetIdInput?: unknown,
) {
  const projectId = cleanText(projectIdInput, 160);
  const mediaId = cleanText(mediaIdInput, 180);
  const expectedAssetId = cleanText(expectedAssetIdInput, 120);
  if (!projectId || !mediaId) return 0;

  const project = await getBrowserProjectForOwner(ownerId, projectId);
  const cards = project.project.assets.filter((card) => {
    if (expectedAssetId && card.assetId !== expectedAssetId) return false;
    return Boolean(metadataWithoutBoundMedia(card.metadata || {}, mediaId));
  });
  let cleared = 0;
  for (const card of cards) {
    const metadata = metadataWithoutBoundMedia(card.metadata || {}, mediaId);
    if (!metadata) continue;
    await updateBrowserProjectAssetForOwner(ownerId, projectId, card.assetId, { metadata });
    cleared += 1;
  }
  return cleared;
}

export async function deleteBrowserProjectFileForOwner(ownerId: string, projectId: string, filePathInput: unknown) {
  const filePath = sanitizeBrowserProjectFilePath(filePathInput);
  const existing = await getBrowserProjectForOwner(ownerId, projectId);
  const current = existing.project.files[filePath];
  if (!current) return false;
  const files = { ...existing.project.files };
  delete files[filePath];

  if (ownerHasDurableStore(ownerId)) {
    const atomicallyDeleted = await deleteProjectFileDocumentAtomically(
      ownerId,
      projectId,
      filePath,
      { ...existing.project, files },
    );
    if (atomicallyDeleted) return true;

    await updateProjectDocument(ownerId, projectId, { ...existing.project, files });
    await deleteProjectFileRow(ownerId, projectId, filePath);
    await deleteProjectFileRevisions(ownerId, projectId, filePath);
    return true;
  }

  await updateProjectDocument(ownerId, projectId, { ...existing.project, files });
  return true;
}

export async function renameBrowserProjectFileForOwner(
  ownerId: string,
  projectId: string,
  fromPathInput: unknown,
  toPathInput: unknown,
) {
  const fromPath = sanitizeBrowserProjectFilePath(fromPathInput);
  const toPath = sanitizeBrowserProjectFilePath(toPathInput);
  const existing = await getBrowserProjectForOwner(ownerId, projectId);
  const current = existing.project.files[fromPath];
  if (!current) return null;
  if (fromPath === toPath) return current;
  if (existing.project.files[toPath]) {
    throw new Error("Destination file already exists.");
  }

  const now = new Date().toISOString();
  const files = { ...existing.project.files };
  delete files[fromPath];
  const renamed: BrowserProjectFile = {
    ...current,
    path: toPath,
    title: fileTitle(toPath),
    updatedAt: now,
  };
  files[toPath] = renamed;

  if (ownerHasDurableStore(ownerId)) {
    const atomicallyRenamed = await renameProjectFileDocumentAtomically(
      ownerId,
      projectId,
      fromPath,
      toPath,
      { ...existing.project, files },
    );
    if (atomicallyRenamed) return atomicallyRenamed.project.files[toPath] || renamed;
  }

  const updated = await updateProjectDocument(ownerId, projectId, { ...existing.project, files });
  return updated.project.files[toPath] || renamed;
}

export async function applyBrowserProjectActionsForOwner(
  ownerId: string,
  projectId: string,
  actions: AnvilFileAction[],
) {
  const existing = await getBrowserProjectForOwner(ownerId, projectId);
  const files = { ...existing.project.files };
  const now = new Date().toISOString();
  const applied: AnvilFileAction[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  let appliedBudget = MAX_PROJECT_FILE_ACTIONS;
  const revisions: Array<{
    file: BrowserProjectFile;
    operation: BrowserProjectFileRevision["operation"];
    previousContent?: string | null;
    metadata?: Record<string, unknown>;
  }> = [];

  for (const action of actions.slice(0, MAX_PROJECT_FILE_ACTIONS)) {
    if (appliedBudget <= 0) {
      skipped.push({
        path: typeof action.path === "string" ? action.path : "",
        reason: `Project file action limit reached (${MAX_PROJECT_FILE_ACTIONS}).`,
      });
      continue;
    }
    try {
      if (action.type === "create_dir") {
        skipped.push({ path: action.path, reason: "Cloud project files do not need explicit directory creation." });
        continue;
      }
      const recoveredPackageActions = recoverPackageDraftActions(action);
      if (wholePackageDraftReason(action) && !recoveredPackageActions.length) {
        skipped.push({
          path: action.path,
          reason:
            "This document contains multiple file sections, but their headings could not be routed safely.",
        });
        continue;
      }
      const writableActions: RecoveredWritableAction[] = recoveredPackageActions.length ? recoveredPackageActions : [action];

      for (const writableAction of writableActions) {
        if (appliedBudget <= 0) {
          skipped.push({
            path: typeof writableAction.path === "string" ? writableAction.path : "",
            reason: `Project file action limit reached (${MAX_PROJECT_FILE_ACTIONS}).`,
          });
          break;
        }
        const routed = routeWritableAgentAction(writableAction);
        const routedAction = routed.action;
        const filePath = sanitizeBrowserProjectFilePath(routedAction.path);
        const current = files[filePath];
        const nextContent =
          routedAction.type === "append_file"
            ? `${current?.content || ""}${current?.content ? "\n" : ""}${cleanFileContent(routedAction.content)}`
            : cleanFileContent(routedAction.content);
        files[filePath] = {
          path: filePath,
          title: current?.title || fileTitle(filePath),
          kind: "markdown",
          content: nextContent.slice(0, MAX_FILE_CONTENT),
          createdAt: current?.createdAt || now,
          updatedAt: now,
        };
        revisions.push({
          file: files[filePath],
          operation: routedAction.type === "append_file" ? "append" : current ? "action" : "create",
          previousContent: current?.content ?? null,
          metadata: {
            source: "agent_action",
            actionType: routedAction.type,
            reason: routedAction.reason || null,
            originalPath: routed.originalPath,
            routeReason: routed.routeReason,
            recoveredFrom: writableAction.recoveredFrom || null,
            recoveryReason: writableAction.recoveryReason || null,
          },
        });
        applied.push(routedAction);
        appliedBudget -= 1;
      }
    } catch (error) {
      skipped.push({
        path: typeof action.path === "string" ? action.path : "",
        reason: error instanceof Error ? error.message : "Invalid file action.",
      });
    }
  }

  const updated = await updateProjectDocument(ownerId, projectId, { ...existing.project, files });
  if (ownerHasDurableStore(ownerId)) await insertProjectFileRevisions(ownerId, projectId, revisions);
  return {
    project: updated,
    applied,
    skipped,
  };
}

export async function listBrowserProjectFileRevisionsForOwner(
  ownerId: string,
  projectId: string,
  filePathInput: unknown,
  limitInput: unknown = 30,
) {
  const filePath = sanitizeBrowserProjectFilePath(filePathInput);
  await getBrowserProjectForOwner(ownerId, projectId);

  if (!ownerHasDurableStore(ownerId)) return [];

  const parsedLimit = Number(limitInput);
  const limit = Number.isFinite(parsedLimit)
    ? Math.max(1, Math.min(100, Math.floor(parsedLimit)))
    : 30;
  const { data, error } = await adminClient()
    .from("anvil_project_file_revisions")
    .select("*")
    .eq("owner_id", ownerId)
    .eq("project_id", projectId)
    .eq("path", filePath)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    if (isMissingProjectFilesFeature(error)) return [];
    throw error;
  }
  return (data || []).map(coerceProjectFileRevisionRow);
}

function safeContextFilePath(value: unknown) {
  try {
    return sanitizeBrowserProjectFilePath(value);
  } catch {
    return "";
  }
}

export async function buildBrowserProjectContextFilesForOwner(
  ownerId: string,
  projectId: string,
  options: { selectedPath?: unknown; limit?: unknown } = {},
) {
  const project = await getBrowserProjectForOwner(ownerId, projectId);
  const selectedPath = safeContextFilePath(options.selectedPath);
  const parsedLimit = Number(options.limit);
  const limit = Number.isFinite(parsedLimit)
    ? Math.max(4, Math.min(MAX_CONTEXT_FILES, Math.floor(parsedLimit)))
    : MAX_CONTEXT_FILES;
  const priority = [
    "story/project-scope.md",
    "story/world-bible.md",
    "story/asset-context.md",
    "script/master-script.md",
    selectedPath,
  ].filter(Boolean);
  const seen = new Set<string>();
  const orderedFiles: BrowserProjectFile[] = [];
  const allFiles = Object.values(project.project.files).sort((a, b) => {
    const ai = priority.indexOf(a.path);
    const bi = priority.indexOf(b.path);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    return a.path.localeCompare(b.path);
  });

  const addFile = (file: BrowserProjectFile | undefined) => {
    if (!file || seen.has(file.path)) return;
    seen.add(file.path);
    orderedFiles.push(file);
  };

  for (const filePath of priority) addFile(project.project.files[filePath]);
  if (selectedPath) {
    const selectedRoot = selectedPath.split("/")[0] || "";
    const selectedPeers = allFiles.filter(
      (file) =>
        file.path !== selectedPath &&
        file.path.split("/")[0] === selectedRoot &&
        ["scenes", "shots", "prompts"].includes(selectedRoot),
    );
    for (const file of selectedPeers.slice(0, 4)) addFile(file);
  }
  for (const file of allFiles) addFile(file);

  return orderedFiles.slice(0, limit).map((file): AnvilContextFile => ({
    path: file.path,
    title: file.title,
    kind: file.kind,
    content: file.content.slice(0, 60_000),
  }));
}
