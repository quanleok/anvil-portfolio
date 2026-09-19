const fs = require("node:fs/promises");
const nodeFs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { atomicWriteFile } = require("./atomic-write.cjs");

const MAX_ACTIONS = 30;
const MAX_ACTION_CONTENT = 240_000;
const ALLOWED_WRITE_ROOTS = [
  "story/",
  "script/",
  "scenes/",
  "shots/",
  "prompts/",
];
const ALLOWED_EXACT_PATHS = new Set([
  "story/intake.md",
  "story/world-bible.md",
  "script/master-script.md",
]);

function truthyEnv(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function protectedClientEnabled(settings = {}) {
  return settings.protectedAnvilEnabled === true || truthyEnv(process.env.ANVIL_ENABLE_PROTECTED_ANVIL_CLIENT);
}

function protectedEndpoint(settings = {}) {
  return (
    String(settings.protectedAnvilUrl || "").trim() ||
    String(process.env.ANVIL_PROTECTED_ANVIL_URL || "").trim()
  );
}

function protectedToken(settings = {}) {
  return (
    String(settings.protectedAnvilToken || "").trim() ||
    String(process.env.ANVIL_PROTECTED_ANVIL_TOKEN || "").trim() ||
    String(process.env.ANVIL_SERVER_API_TOKEN || "").trim()
  );
}

async function readInstallId() {
  const dir = path.join(os.homedir(), ".anvil");
  const file = path.join(dir, "install-id");
  try {
    const existing = (await fs.readFile(file, "utf8")).trim();
    if (existing) return existing;
  } catch {}
  const id = crypto.randomUUID();
  await fs.mkdir(dir, { recursive: true });
  await atomicWriteFile(file, `${id}\n`);
  return id;
}

function sanitizeRelativePath(value) {
  const normalized = String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (!normalized) throw new Error("path is required");
  if (normalized.includes("\0")) throw new Error("path contains a null byte");
  if (/^[a-zA-Z]:/.test(normalized)) throw new Error("path cannot be absolute");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("path cannot contain . or ..");
  }
  return segments.join("/");
}

function allowedActionPath(relativePath) {
  if (ALLOWED_EXACT_PATHS.has(relativePath)) return true;
  return ALLOWED_WRITE_ROOTS.some((root) => relativePath.startsWith(root));
}

function assertAllowedActionPath(relativePath) {
  if (!allowedActionPath(relativePath)) {
    throw new Error(`protected action path is not allowed: ${relativePath}`);
  }
  if (relativePath === "ANVIL.md" || relativePath.startsWith(".forge/secrets")) {
    throw new Error(`protected action path is reserved: ${relativePath}`);
  }
  return relativePath;
}

function normalizeAction(action) {
  if (!action || typeof action !== "object") return null;
  const type = String(action.type || "");
  if (!["create_dir", "write_file", "append_file"].includes(type)) return null;
  const relativePath = assertAllowedActionPath(sanitizeRelativePath(action.path));
  if (type === "create_dir") {
    return { type, path: relativePath, reason: String(action.reason || "").slice(0, 500) };
  }
  return {
    type,
    path: relativePath,
    content: String(action.content || "").slice(0, MAX_ACTION_CONTENT),
    reason: String(action.reason || "").slice(0, 500),
  };
}

function normalizeServerResponse(response) {
  const body = response && typeof response === "object" ? response : {};
  const actions = Array.isArray(body.actions)
    ? body.actions.map(normalizeAction).filter(Boolean).slice(0, MAX_ACTIONS)
    : [];
  return {
    reply: String(body.reply || "Done.").slice(0, 4_000),
    checkpoint: typeof body.checkpoint === "string" ? body.checkpoint.slice(0, 500) : null,
    methodVersion: typeof body.methodVersion === "string" ? body.methodVersion.slice(0, 120) : "",
    warnings: Array.isArray(body.warnings)
      ? body.warnings.filter((item) => typeof item === "string").map((item) => item.slice(0, 500))
      : [],
    actions,
    meta: body.meta && typeof body.meta === "object" ? body.meta : {},
  };
}

function contextFilesFromPayload(payload = {}) {
  const context = payload.context || {};
  const out = [];
  const pushFile = (entry) => {
    if (!entry || typeof entry !== "object") return;
    const filePath = entry.path || entry.filePath || entry.relativePath;
    if (!filePath) return;
    try {
      out.push({
        path: sanitizeRelativePath(filePath),
        title: typeof entry.title === "string" ? entry.title : undefined,
        kind: typeof entry.kind === "string" ? entry.kind : undefined,
        content: typeof entry.content === "string" ? entry.content.slice(0, 60_000) : undefined,
        summary: typeof entry.summary === "string" ? entry.summary.slice(0, 4_000) : undefined,
      });
    } catch {}
  };
  for (const listName of ["files", "story", "script", "prompts", "magicDocs"]) {
    const list = context[listName];
    if (Array.isArray(list)) list.forEach(pushFile);
  }
  return out.slice(0, 24);
}

async function buildProtectedTurnRequest({ projectDir, project, payload = {} }) {
  const context = payload.context || {};
  const projectShape = context.project || project?.project || {};
  return {
    installId: await readInstallId(),
    projectId: String(projectShape.id || project?.project?.id || "").slice(0, 120),
    projectName: String(projectShape.name || project?.project?.name || path.basename(projectDir)).slice(0, 160),
    appVersion: String(payload.appVersion || "").slice(0, 80),
    userMessage: String(payload.message || payload.userMessage || "").trim(),
    phase: String(payload.phase || payload.methodPhase || "general"),
    methodId: String(payload.methodId || "local-short-film-workflow"),
    maxActions: Number(payload.maxActions) || 30,
    context: {
      projectId: String(projectShape.id || project?.project?.id || "").slice(0, 120),
      projectName: String(projectShape.name || project?.project?.name || path.basename(projectDir)).slice(0, 160),
      phase: String(payload.phase || payload.methodPhase || "general"),
      selection: context.selection || payload.selection || null,
      userPreferences: context.userPreferences || null,
      mediaSummary: context.mediaSummary || null,
      files: contextFilesFromPayload(payload),
    },
  };
}

async function callProtectedAnvilTurn({ settings = {}, projectDir, project, payload = {} }) {
  if (!protectedClientEnabled(settings)) {
    throw new Error("Protected Anvil server is disabled. Enable ANVIL_ENABLE_PROTECTED_ANVIL_CLIENT or the project setting.");
  }
  const endpoint = protectedEndpoint(settings);
  if (!endpoint) {
    throw new Error("Protected Anvil endpoint is not configured.");
  }
  const request = await buildProtectedTurnRequest({ projectDir, project, payload });
  if (!request.userMessage) {
    throw new Error("Protected Anvil turn requires a user message.");
  }

  const headers = { "content-type": "application/json" };
  const token = protectedToken(settings);
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(request),
  });
  const raw = await response.text();
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {}
  if (!response.ok) {
    const message = parsed?.message || parsed?.error || raw || `Protected Anvil request failed (${response.status})`;
    throw new Error(message);
  }
  return normalizeServerResponse(parsed);
}

async function applyProtectedAnvilActions(projectDir, response) {
  const root = path.resolve(projectDir);
  const normalized = normalizeServerResponse(response);
  const applied = [];
  for (const action of normalized.actions) {
    const targetPath = path.resolve(root, action.path);
    if (targetPath !== root && !targetPath.startsWith(`${root}${path.sep}`)) {
      throw new Error(`protected action escapes project: ${action.path}`);
    }
    if (action.type === "create_dir") {
      await fs.mkdir(targetPath, { recursive: true });
      applied.push({ type: action.type, path: action.path });
      continue;
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    if (action.type === "append_file" && nodeFs.existsSync(targetPath)) {
      const existing = await fs.readFile(targetPath, "utf8").catch(() => "");
      await atomicWriteFile(targetPath, `${existing}${action.content}`);
    } else {
      await atomicWriteFile(targetPath, action.content);
    }
    applied.push({ type: action.type, path: action.path });
  }
  return { ...normalized, appliedActions: applied };
}

module.exports = {
  applyProtectedAnvilActions,
  callProtectedAnvilTurn,
  protectedClientEnabled,
};
