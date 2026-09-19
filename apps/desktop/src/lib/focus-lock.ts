// Renderer-side focus-lock state helpers. Mirrors the shape of
// electron/focus-lock.cjs (which does enforcement) but this module only
// handles VISUAL state — which class to apply, is this target in-scope,
// what label to show. Main process owns the actual write-gate.

import type { FocusScope } from "../types";

function normalizePath(p: string | null | undefined): string {
  return String(p || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
}

function sceneStemFromPath(scenePath: string | null | undefined): string {
  const norm = normalizePath(scenePath);
  if (!norm) return "";
  const base = norm.split("/").pop() || "";
  return base.replace(/\.md$/i, "");
}

// True if the given path falls inside the active scope's write-permission.
// Readonly always returns false (agent can't write). No-lock always returns
// true (any path is writable). File/scene/shot compare against stored paths.
export function isPathInScope(focusScope: FocusScope, targetPath: string | null | undefined): boolean {
  if (!focusScope || focusScope.kind === "none") return true;
  if (focusScope.kind === "readonly") return false;
  const norm = normalizePath(targetPath);
  if (!norm) return false;
  if (focusScope.kind === "file") {
    return normalizePath(focusScope.path) === norm;
  }
  if (focusScope.kind === "scene") {
    const scenePath = normalizePath(focusScope.scenePath);
    const stem = sceneStemFromPath(focusScope.scenePath);
    if (!scenePath || !stem) return false;
    return norm === scenePath
      || norm.startsWith(`beats/${stem}/`)
      || norm.startsWith(`shots/${stem}/`)
      || norm.startsWith(`prompts/${stem}/`);
  }
  if (focusScope.kind === "shot") {
    const shotPath = normalizePath(focusScope.shotPath);
    const stem = sceneStemFromPath(focusScope.scenePath);
    if (!shotPath || !stem) return false;
    return norm === shotPath || norm.startsWith(`prompts/${stem}/`);
  }
  return false;
}

export type LockVisualState = "none" | "active" | "foreign" | "readonly";

// Single source of truth for lock visual state. Consumed by editor-head
// button, chat-thread indicator, and ItemActionBar pill so the three
// surfaces always agree.
export function evaluateLockVisual(
  focusScope: FocusScope,
  targetPath: string | null | undefined,
): LockVisualState {
  if (focusScope.kind === "none") return "none";
  if (focusScope.kind === "readonly") return "readonly";
  return isPathInScope(focusScope, targetPath) ? "active" : "foreign";
}

// Short human label for the current lock target (one line, for pills).
export function shortLockLabel(focusScope: FocusScope): string | null {
  if (focusScope.kind === "none") return null;
  if (focusScope.kind === "readonly") return "Read-only";
  if (focusScope.kind === "scene") return "Scene subtree";
  if (focusScope.kind === "shot") return "Shot + prompts";
  if (focusScope.kind === "file") {
    return normalizePath(focusScope.path).split("/").pop() || "File";
  }
  return "Locked";
}

// Full tooltip label (longer, for the editor-head button title).
export function fullLockLabel(focusScope: FocusScope): string | null {
  if (focusScope.kind === "none") return null;
  if (focusScope.kind === "readonly") return "Read-only mode";
  if (focusScope.kind === "scene") return "Locked to this scene and its prompts";
  if (focusScope.kind === "shot") return "Locked to this shot (and its prompts)";
  if (focusScope.kind === "file") return `Locked to ${normalizePath(focusScope.path)}`;
  return "Locked";
}
