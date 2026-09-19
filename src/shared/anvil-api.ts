export type AnvilTurnPhase =
  | "intake"
  | "script"
  | "scene"
  | "prompt"
  | "reference"
  | "video"
  | "audit"
  | "general";

export type AnvilContextFile = {
  path: string;
  title?: string;
  kind?: string;
  content?: string;
  summary?: string;
};

export type AnvilContextPacket = {
  projectId?: string;
  projectName?: string;
  projectPath?: string;
  phase?: AnvilTurnPhase | string;
  files?: AnvilContextFile[];
  selection?: Record<string, unknown> | null;
  userPreferences?: Record<string, unknown> | null;
  mediaSummary?: Record<string, unknown> | null;
  timelineSummary?: Record<string, unknown> | null;
};

export type AnvilFileAction =
  | {
      type: "create_dir";
      path: string;
      reason?: string;
    }
  | {
      type: "write_file";
      path: string;
      content: string;
      reason?: string;
    }
  | {
      type: "append_file";
      path: string;
      content: string;
      reason?: string;
    };

export type AnvilTurnRequest = {
  installId?: string;
  projectId?: string;
  projectName?: string;
  appVersion?: string;
  userMessage: string;
  phase?: AnvilTurnPhase | string;
  methodId?: string;
  context?: AnvilContextPacket;
  maxActions?: number;
};

export type AnvilTurnResponse = {
  ok?: boolean;
  state?: "allowed" | "queued" | "limited";
  reply: string;
  actions: AnvilFileAction[];
  checkpoint?: string | null;
  methodVersion?: string;
  warnings?: string[];
  entitlement?: {
    plan: "free" | "pro" | "studio" | string;
    allowed: boolean;
  };
  usage?: {
    requestId: string;
    ledger: "recorded" | "skipped" | "unavailable";
    method: string;
    limit?: Record<string, number>;
    summary?: Record<string, unknown>;
  };
  meta?: Record<string, unknown>;
};

const VALID_PHASES = new Set<AnvilTurnPhase>([
  "intake",
  "script",
  "scene",
  "prompt",
  "reference",
  "video",
  "audit",
  "general",
]);

const VALID_ACTIONS = new Set(["create_dir", "write_file", "append_file"]);
const MAX_CONTEXT_FILES = 24;
const MAX_CONTEXT_TEXT = 60_000;
const MAX_ACTION_CONTENT = 240_000;
const MAX_ACTIONS = 30;

export function normalizeAnvilPhase(value: unknown): AnvilTurnPhase {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return VALID_PHASES.has(raw as AnvilTurnPhase) ? (raw as AnvilTurnPhase) : "general";
}

export function sanitizeAnvilRelativePath(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("path must be a string");
  }
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (!normalized) {
    throw new Error("path is required");
  }
  if (normalized.includes("\0")) {
    throw new Error("path contains a null byte");
  }
  if (normalized.length > 220) {
    throw new Error("path is too long");
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("path cannot contain . or .. segments");
  }
  if (/^[a-zA-Z]:/.test(normalized)) {
    throw new Error("path cannot be absolute");
  }
  return segments.join("/");
}

export function normalizeAnvilContextFile(value: unknown): AnvilContextFile | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  let filePath = "";
  try {
    filePath = sanitizeAnvilRelativePath(source.path);
  } catch {
    return null;
  }
  const content =
    typeof source.content === "string"
      ? source.content.slice(0, MAX_CONTEXT_TEXT)
      : undefined;
  const summary =
    typeof source.summary === "string"
      ? source.summary.slice(0, 4_000)
      : undefined;
  return {
    path: filePath,
    title: typeof source.title === "string" ? source.title.slice(0, 160) : undefined,
    kind: typeof source.kind === "string" ? source.kind.slice(0, 80) : undefined,
    ...(content ? { content } : {}),
    ...(summary ? { summary } : {}),
  };
}

export function normalizeAnvilContextPacket(value: unknown): AnvilContextPacket {
  if (!value || typeof value !== "object") return {};
  const source = value as Record<string, unknown>;
  const files = Array.isArray(source.files)
    ? source.files.map(normalizeAnvilContextFile).filter((file): file is AnvilContextFile => Boolean(file)).slice(0, MAX_CONTEXT_FILES)
    : [];
  return {
    projectId: typeof source.projectId === "string" ? source.projectId.slice(0, 120) : undefined,
    projectName: typeof source.projectName === "string" ? source.projectName.slice(0, 160) : undefined,
    projectPath: typeof source.projectPath === "string" ? source.projectPath.slice(0, 240) : undefined,
    phase: typeof source.phase === "string" ? normalizeAnvilPhase(source.phase) : undefined,
    files,
    selection:
      source.selection && typeof source.selection === "object"
        ? (source.selection as Record<string, unknown>)
        : null,
    userPreferences:
      source.userPreferences && typeof source.userPreferences === "object"
        ? (source.userPreferences as Record<string, unknown>)
        : null,
    mediaSummary:
      source.mediaSummary && typeof source.mediaSummary === "object"
        ? (source.mediaSummary as Record<string, unknown>)
        : null,
    timelineSummary:
      source.timelineSummary && typeof source.timelineSummary === "object"
        ? (source.timelineSummary as Record<string, unknown>)
        : null,
  };
}

export function parseAnvilTurnRequest(value: unknown): AnvilTurnRequest {
  if (!value || typeof value !== "object") {
    throw new Error("request body must be an object");
  }
  const source = value as Record<string, unknown>;
  const userMessage = typeof source.userMessage === "string" ? source.userMessage.trim() : "";
  if (!userMessage) {
    throw new Error("userMessage is required");
  }
  const maxActions = Number(source.maxActions);
  return {
    installId: typeof source.installId === "string" ? source.installId.slice(0, 120) : undefined,
    projectId: typeof source.projectId === "string" ? source.projectId.slice(0, 120) : undefined,
    projectName: typeof source.projectName === "string" ? source.projectName.slice(0, 160) : undefined,
    appVersion: typeof source.appVersion === "string" ? source.appVersion.slice(0, 80) : undefined,
    userMessage: userMessage.slice(0, 12_000),
    phase: normalizeAnvilPhase(source.phase),
    methodId: typeof source.methodId === "string" ? source.methodId.slice(0, 120) : undefined,
    context: normalizeAnvilContextPacket(source.context),
    maxActions: Number.isFinite(maxActions)
      ? Math.max(1, Math.min(MAX_ACTIONS, Math.floor(maxActions)))
      : MAX_ACTIONS,
  };
}

export function validateAnvilFileAction(value: unknown): AnvilFileAction | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const type = typeof source.type === "string" ? source.type : "";
  if (!VALID_ACTIONS.has(type)) return null;
  let filePath = "";
  try {
    filePath = sanitizeAnvilRelativePath(source.path);
  } catch {
    return null;
  }
  const reason = typeof source.reason === "string" ? source.reason.slice(0, 500) : undefined;
  if (type === "create_dir") {
    return { type, path: filePath, ...(reason ? { reason } : {}) };
  }
  const content = typeof source.content === "string" ? source.content.slice(0, MAX_ACTION_CONTENT) : "";
  return {
    type: type as "write_file" | "append_file",
    path: filePath,
    content,
    ...(reason ? { reason } : {}),
  };
}

export function normalizeAnvilTurnResponse(value: unknown, maxActions = MAX_ACTIONS): AnvilTurnResponse {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const actions = Array.isArray(source.actions)
    ? source.actions
        .map(validateAnvilFileAction)
        .filter((action): action is AnvilFileAction => Boolean(action))
        .slice(0, Math.max(0, Math.min(MAX_ACTIONS, maxActions)))
    : [];
  const warnings = Array.isArray(source.warnings)
    ? source.warnings
        .filter((warning): warning is string => typeof warning === "string")
        .map((warning) => warning.slice(0, 500))
        .slice(0, 12)
    : [];
  return {
    reply:
      typeof source.reply === "string" && source.reply.trim()
        ? source.reply.trim().slice(0, 4_000)
        : "Done.",
    actions,
    checkpoint:
      typeof source.checkpoint === "string" && source.checkpoint.trim()
        ? source.checkpoint.trim().slice(0, 500)
        : null,
    methodVersion:
      typeof source.methodVersion === "string" ? source.methodVersion.slice(0, 120) : undefined,
    warnings,
    meta:
      source.meta && typeof source.meta === "object"
        ? (source.meta as Record<string, unknown>)
        : undefined,
  };
}
