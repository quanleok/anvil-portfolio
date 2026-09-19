"use client";

import {
  createContext,
  useContext,
  useMemo,
  type Dispatch,
  type FormEvent,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";
import type { WorkspaceUser } from "@/lib/workspace-auth";

import type { ChatMessage } from "./chat/types";
import type { FileRevision, RevisionCompare } from "./right-pane/editor/types";
import type {
  AssetCard,
  AssetCardSection,
  AssetCategory,
  CloudFile,
  CloudProject,
  FileTreeGroup,
  MediaAsset,
  ScriptChild,
} from "./types";

// React context for shared workspace state, per spec §2.2. The
// monolith creates the value object from its useState calls and wraps
// the rendering tree; children consume via useWorkspace(). Local
// component state (editor draft cursor position, splitter drag state,
// composer focus) stays inside each component.

export type WorkspaceContextValue = {
  // identity + data
  user: WorkspaceUser;
  projectId: string;
  project: CloudProject | null;
  setProject: Dispatch<SetStateAction<CloudProject | null>>;
  files: CloudFile[];

  // section navigation
  activeSection: string;
  switchSection: (section: string) => void;
  activeScriptChild: ScriptChild;
  setScriptChild: (child: ScriptChild) => void;
  activeAssetCategory: string;
  setActiveAssetCategory: Dispatch<SetStateAction<string>>;
  activeCategory: AssetCategory;

  // editor / file
  selectedPath: string;
  setSelectedPath: Dispatch<SetStateAction<string>>;
  selectedFile: CloudFile | null;
  selectFile: (path: string) => void;
  fileTreeGroups: FileTreeGroup[];
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  dirty: boolean;
  setDirty: Dispatch<SetStateAction<boolean>>;
  status: string;
  setStatus: Dispatch<SetStateAction<string>>;
  conflictFile: CloudFile | null;
  setConflictFile: Dispatch<SetStateAction<CloudFile | null>>;
  saveFile: (options?: { force?: boolean }) => Promise<void>;
  createFile: (root?: string) => Promise<void>;
  /** Create a new prompt nested under a specific scene
   *  (prompts/<sceneStem>/NN.md). Auto-numbers to the lowest
   *  unused two-digit slot. */
  createPromptForScene: (sceneStem: string) => Promise<void>;

  // revisions
  historyOpen: boolean;
  setHistoryOpen: Dispatch<SetStateAction<boolean>>;
  revisions: FileRevision[];
  revisionStatus: string;
  loadRevisions: (path: string) => Promise<void>;
  previewRevision: FileRevision | null;
  previewExcerpt: string;
  previewRevisionId: string | null;
  setPreviewRevisionId: Dispatch<SetStateAction<string | null>>;
  revisionCompare: RevisionCompare;

  // media
  mediaAssets: MediaAsset[];
  filteredMediaAssets: MediaAsset[];
  selectedMedia: MediaAsset | null;
  setSelectedMediaId: Dispatch<SetStateAction<string | null>>;
  mediaReady: boolean;
  mediaPreviewUrl: string;
  mediaStatus: string;
  mediaBusy: boolean;
  /** Upload-progress fraction 0..1 while a PUT is in flight, or
   *  null when no upload is active OR the upload is indeterminate
   *  (chunked, no content-length). Drives the composer "Attaching…"
   *  toast and the DocsRail +New busy slot. Improvement-plan 4.6. */
  mediaProgress: number | null;
  fileInputRef: RefObject<HTMLInputElement | null>;
  uploadMedia: (file: File) => Promise<boolean>;

  // chat
  threadId: string | null;
  messages: ChatMessage[];
  agentInput: string;
  setAgentInput: Dispatch<SetStateAction<string>>;
  agentBusy: boolean;
  sendAgentTurn: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  /** Paths touched by the most recent agent file-write. Each entry
   *  auto-expires ~14s after it was added so the row pulse fades
   *  (1.5s anim) but the "editing" badge on the IconRail stays long
   *  enough to read. Spec §5 commit 5; linger bumped 2026-05-11. */
  touchedPaths: ReadonlySet<string>;
  /** Bucketed view of touchedPaths keyed by primary section
   *  (story/script/assets/workshop). Up to 3 basenames per section,
   *  most recent first. Drives the "editing intake.md, scope.md…"
   *  badge under each IconRail section icon. */
  touchedFilesBySection: Record<string, string[]>;
  /** Upload-and-bind for asset cards. Posts to the media signing
   *  endpoint, PUTs the file, then PATCHes the target card's
   *  metadata (mediaAssetId, mediaKind, mediaFileName) so the card
   *  preview can render the uploaded file via /api/media/<id>/
   *  download. */
  uploadMediaForCard: (file: File, assetId: string) => Promise<void>;

  /** Phase D, slice D4: asset cards loaded from
   *  /api/projects/[id]/assets. One card per entity (character,
   *  location, etc.); media variants attach to a card via D3. */
  projectAssets: AssetCard[];
  projectAssetsStatus: string;
  loadProjectAssets: () => Promise<void>;
  createProjectAsset: (section: AssetCardSection, name?: string) => Promise<void>;
  deleteProjectAsset: (assetId: string) => Promise<void>;
  selectedAssetId: string | null;
  setSelectedAssetId: Dispatch<SetStateAction<string | null>>;
};

export type EditorDraftContextValue = Pick<
  WorkspaceContextValue,
  "selectedPath" | "selectedFile" | "draft" | "setDraft" | "dirty" | "setDirty" | "conflictFile" | "saveFile"
>;

export type AgentComposerContextValue = Pick<
  WorkspaceContextValue,
  "agentInput" | "setAgentInput" | "agentBusy" | "sendAgentTurn"
>;

export type WorkspaceStableContextValue = Omit<
  WorkspaceContextValue,
  | "draft"
  | "setDraft"
  | "dirty"
  | "setDirty"
  | "conflictFile"
  | "setConflictFile"
  | "saveFile"
  | "historyOpen"
  | "setHistoryOpen"
  | "revisions"
  | "revisionStatus"
  | "loadRevisions"
  | "previewRevision"
  | "previewExcerpt"
  | "previewRevisionId"
  | "setPreviewRevisionId"
  | "revisionCompare"
  | "agentInput"
  | "setAgentInput"
  | "sendAgentTurn"
>;

const WorkspaceContext = createContext<WorkspaceStableContextValue | null>(null);
const EditorDraftContext = createContext<EditorDraftContextValue | null>(null);
const AgentComposerContext = createContext<AgentComposerContextValue | null>(null);

export function WorkspaceProvider({
  value,
  children,
}: {
  value: WorkspaceContextValue;
  children: ReactNode;
}) {
  const editorDraftValue = useMemo<EditorDraftContextValue>(
    () => ({
      selectedPath: value.selectedPath,
      selectedFile: value.selectedFile,
      draft: value.draft,
      setDraft: value.setDraft,
      dirty: value.dirty,
      setDirty: value.setDirty,
      conflictFile: value.conflictFile,
      saveFile: value.saveFile,
    }),
    [
      value.conflictFile,
      value.dirty,
      value.draft,
      value.saveFile,
      value.selectedFile,
      value.selectedPath,
      value.setDirty,
      value.setDraft,
    ],
  );

  const agentComposerValue = useMemo<AgentComposerContextValue>(
    () => ({
      agentInput: value.agentInput,
      setAgentInput: value.setAgentInput,
      agentBusy: value.agentBusy,
      sendAgentTurn: value.sendAgentTurn,
    }),
    [value.agentBusy, value.agentInput, value.sendAgentTurn, value.setAgentInput],
  );

  const stableWorkspaceValue = useMemo<WorkspaceStableContextValue>(
    () => ({
      user: value.user,
      projectId: value.projectId,
      project: value.project,
      setProject: value.setProject,
      files: value.files,
      activeSection: value.activeSection,
      switchSection: value.switchSection,
      activeScriptChild: value.activeScriptChild,
      setScriptChild: value.setScriptChild,
      activeAssetCategory: value.activeAssetCategory,
      setActiveAssetCategory: value.setActiveAssetCategory,
      activeCategory: value.activeCategory,
      selectedPath: value.selectedPath,
      setSelectedPath: value.setSelectedPath,
      selectedFile: value.selectedFile,
      selectFile: value.selectFile,
      fileTreeGroups: value.fileTreeGroups,
      status: value.status,
      setStatus: value.setStatus,
      createFile: value.createFile,
      createPromptForScene: value.createPromptForScene,
      mediaAssets: value.mediaAssets,
      filteredMediaAssets: value.filteredMediaAssets,
      selectedMedia: value.selectedMedia,
      setSelectedMediaId: value.setSelectedMediaId,
      mediaReady: value.mediaReady,
      mediaPreviewUrl: value.mediaPreviewUrl,
      mediaStatus: value.mediaStatus,
      mediaBusy: value.mediaBusy,
      mediaProgress: value.mediaProgress,
      fileInputRef: value.fileInputRef,
      uploadMedia: value.uploadMedia,
      threadId: value.threadId,
      messages: value.messages,
      agentBusy: value.agentBusy,
      touchedPaths: value.touchedPaths,
      touchedFilesBySection: value.touchedFilesBySection,
      uploadMediaForCard: value.uploadMediaForCard,
      projectAssets: value.projectAssets,
      projectAssetsStatus: value.projectAssetsStatus,
      loadProjectAssets: value.loadProjectAssets,
      createProjectAsset: value.createProjectAsset,
      deleteProjectAsset: value.deleteProjectAsset,
      selectedAssetId: value.selectedAssetId,
      setSelectedAssetId: value.setSelectedAssetId,
    }),
    [
      value.activeAssetCategory,
      value.activeCategory,
      value.activeScriptChild,
      value.activeSection,
      value.agentBusy,
      value.createFile,
      value.createProjectAsset,
      value.createPromptForScene,
      value.deleteProjectAsset,
      value.fileInputRef,
      value.fileTreeGroups,
      value.files,
      value.filteredMediaAssets,
      value.loadProjectAssets,
      value.mediaAssets,
      value.mediaBusy,
      value.mediaPreviewUrl,
      value.mediaProgress,
      value.mediaReady,
      value.mediaStatus,
      value.messages,
      value.project,
      value.projectAssets,
      value.projectAssetsStatus,
      value.projectId,
      value.selectFile,
      value.selectedAssetId,
      value.selectedFile,
      value.selectedMedia,
      value.selectedPath,
      value.setActiveAssetCategory,
      value.setProject,
      value.setSelectedAssetId,
      value.setSelectedMediaId,
      value.setSelectedPath,
      value.setScriptChild,
      value.setStatus,
      value.status,
      value.switchSection,
      value.threadId,
      value.touchedFilesBySection,
      value.touchedPaths,
      value.uploadMedia,
      value.uploadMediaForCard,
      value.user,
    ],
  );

  return (
    <WorkspaceContext.Provider value={stableWorkspaceValue}>
      <EditorDraftContext.Provider value={editorDraftValue}>
        <AgentComposerContext.Provider value={agentComposerValue}>
          {children}
        </AgentComposerContext.Provider>
      </EditorDraftContext.Provider>
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace(): WorkspaceStableContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) {
    throw new Error("useWorkspace must be used inside a WorkspaceProvider");
  }
  return ctx;
}

export function useEditorDraft(): EditorDraftContextValue {
  const ctx = useContext(EditorDraftContext);
  if (!ctx) {
    throw new Error("useEditorDraft must be used inside a WorkspaceProvider");
  }
  return ctx;
}

export function useAgentComposer(): AgentComposerContextValue {
  const ctx = useContext(AgentComposerContext);
  if (!ctx) {
    throw new Error("useAgentComposer must be used inside a WorkspaceProvider");
  }
  return ctx;
}
