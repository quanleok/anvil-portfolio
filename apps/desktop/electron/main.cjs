const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, net, protocol, safeStorage, shell } = require("electron");
const { execFileSync, spawn } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const nodeFs = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { atomicWriteFile, withWriteLock } = require("./atomic-write.cjs");
const assetManifest = require("./asset-manifest.cjs");
const skillLibrary = require("./skill-library.cjs");
const { createAnvilAgentGateway } = require("./anvil-agent-gateway.cjs");
const {
  sortPromptEntriesByStoryOrder,
  sortSceneEntriesByScriptOrder,
} = require("./scene-order.cjs");
const {
  readDurationSec,
  resolveSceneLink,
} = require("./script-metadata.cjs");

const LOCAL_UI_LIMITS = {
  mediaBatchUpload: 50,
  customSubsectionDocs: 50,
};

function truthyEnv(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

// Dev-only: hot-restart Electron when main-process files change. Skipped
// in packaged builds. Watches everything reachable via require() from the
// main entry — main.cjs, preload.cjs, agent-loop.cjs, system/tools/*.cjs,
// etc. The renderer (src/) is handled by Vite HMR and does not trigger
// a restart here.
try {
  if (!app.isPackaged && process.env.ANVIL_DISABLE_HOT_RESTART !== "1") {
    require("electron-reloader")(module, {
      watchRenderer: false,
      ignore: [
        "release",
        "dist",
        "build",
        "bin",
        ".forge-cache",
        "node_modules",
        ".git",
      ],
    });
  }
} catch {
  // electron-reloader not installed in packaged builds; safe to ignore.
}

let nodePty = null;
let nodePtySpawnHelperChecked = false;

function loadEnvFileIntoProcess(envFile) {
  try {
    if (!nodeFs.existsSync(envFile)) return;
    const body = nodeFs.readFileSync(envFile, "utf8");
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key && !(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {}
}

// Load ~/.anvil/.env so packaged Anvil can access provider keys even when
// launched from Finder. In development, also load the repo's .env.local so
// `anvil` works from the built-in terminal without manual export commands.
loadEnvFileIntoProcess(path.join(os.homedir(), ".anvil", ".env"));
if (!app.isPackaged) {
  loadEnvFileIntoProcess(path.resolve(__dirname, "..", "..", "..", ".env.local"));
  loadEnvFileIntoProcess(path.resolve(__dirname, "..", ".env.local"));
}

const ANVIL_LOCAL_AGENT_TOKEN =
  process.env.ANVIL_LOCAL_AGENT_TOKEN ||
  process.env.ANVIL_AGENT_SERVER_TOKEN ||
  process.env.ANVIL_API_TOKEN ||
  randomUUID();
const ENABLE_LOCAL_ANVIL_AGENT_GATEWAY = truthyEnv(process.env.ANVIL_ENABLE_LOCAL_AGENT_GATEWAY);
let anvilAgentGateway = null;
let anvilAgentGatewayStartPromise = null;

async function ensureAnvilAgentGatewayStarted() {
  if (!ENABLE_LOCAL_ANVIL_AGENT_GATEWAY) return null;
  if (anvilAgentGateway?.getInfo?.()) return anvilAgentGateway.getInfo();
  if (!anvilAgentGateway) {
    anvilAgentGateway = createAnvilAgentGateway({
      token: ANVIL_LOCAL_AGENT_TOKEN,
      env: process.env,
    });
  }
  if (!anvilAgentGatewayStartPromise) {
    anvilAgentGatewayStartPromise = anvilAgentGateway.start().catch((error) => {
      anvilAgentGatewayStartPromise = null;
      throw error;
    });
  }
  return anvilAgentGatewayStartPromise;
}

function activeAnvilAgentGatewayInfo() {
  return anvilAgentGateway?.getInfo?.() || null;
}

const { readPromptPrevId, prevIdToMeta } = require("./continuity.cjs");
const {
  extractLegacyAssetRefs,
  extractEntityRefs,
  normalizeEntityRefs,
  normalizeSuppressedRefs,
  serializeEntityRefsMeta,
  serializeSuppressedRefsMeta,
  attachAssetUsages,
} = require("./entity-refs.cjs");
// asset-groups.cjs deleted in the 2026-05-04 bloat-cuts pass.
// project.assetGroups is no longer normalized; legacy entries are
// silently dropped on the next save (the field stops appearing in
// the persisted shape — existing data on disk is harmless).
const { mergeLegacyDialogueContent } = require("./dialogue-merge.cjs");
const {
  normalizePromptReadinessOverride,
  parsePromptReadinessOverrideMeta,
  serializePromptReadinessOverrideMeta,
} = require("./prompt-readiness-meta.cjs");

const ANVIL_PKG = (() => {
  try {
    return require("../package.json");
  } catch {
    return { version: "0.0.0" };
  }
})();

const APP_VARIANT = (() => {
  const raw = ANVIL_PKG?.forgeVariant;
  const base = (!raw || typeof raw !== "object")
    ? {
        id: "",
        label: "",
        displayName: "Anvil",
        storageName: "Anvil",
      }
    : {
        id: String(raw.id || "").trim(),
        label: String(raw.label || "").trim(),
        displayName: String(raw.displayName || "").trim() || "Anvil",
        storageName: "",
      };
  if (!base.storageName) {
    base.storageName =
      (raw && typeof raw === "object" && String(raw.storageName || "").trim())
      || base.displayName;
  }
  // Dev-mode auto-isolation: when running unpackaged (npm run dev), brand
  // the window as "Anvil Dev" and route userData to a separate folder so
  // the running stable /Applications/Anvil.app instance doesn't share
  // projects/settings/chats/secrets with the live-edit instance. Override
  // by setting ANVIL_DEV_VARIANT=0 if you want dev to share stable data.
  if (!app.isPackaged && process.env.ANVIL_DEV_VARIANT !== "0") {
    return {
      id: base.id || "dev",
      label: base.label || "Dev",
      displayName: `${base.displayName} Dev`,
      storageName: `${base.storageName}-Dev`,
    };
  }
  return base;
})();

const APP_DISPLAY_NAME = APP_VARIANT.displayName;
const APP_STORAGE_NAME = APP_VARIANT.storageName;

// Prefer the build-info stamped at package time; fall back to a runtime
// git lookup (dev mode); fall back to empty build tag (installed app w/o
// stamp + no git).
const ANVIL_VERSION = (() => {
  try {
    const stamped = require("./build-info.json");
    return {
      version: String(stamped.version || ANVIL_PKG.version || "0.0.0"),
      build: String(stamped.build || ""),
      commitCount: Number(stamped.commitCount) || 0,
      appName: APP_DISPLAY_NAME,
      variant: APP_VARIANT.label,
    };
  } catch {}
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: __dirname,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      timeout: 1500,
    }).trim();
    return {
      version: String(ANVIL_PKG.version || "0.0.0"),
      build: sha || "",
      commitCount: 0,
      appName: APP_DISPLAY_NAME,
      variant: APP_VARIANT.label,
    };
  } catch {
    return {
      version: String(ANVIL_PKG.version || "0.0.0"),
      build: "",
      commitCount: 0,
      appName: APP_DISPLAY_NAME,
      variant: APP_VARIANT.label,
    };
  }
})();

app.setName(APP_DISPLAY_NAME);
app.setPath("userData", path.join(app.getPath("appData"), APP_STORAGE_NAME));
app.setAboutPanelOptions?.({
  applicationName: APP_DISPLAY_NAME,
  applicationVersion: ANVIL_VERSION.build
    ? `${ANVIL_VERSION.version} (${ANVIL_VERSION.build})`
    : ANVIL_VERSION.version,
});

const ASSET_SCHEME = "anvil-asset";

protocol.registerSchemesAsPrivileged([
  {
    scheme: ASSET_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      bypassCSP: true,
    },
  },
]);

function assetUrlFor(absolutePath) {
  if (!absolutePath) return "";
  const normalized = String(absolutePath).replace(/\\/g, "/");
  const withSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `${ASSET_SCHEME}://local${withSlash.split("/").map(encodeURIComponent).join("/")}`;
}
const {
  DEFAULT_OPENCLAW_HOOK_URL,
  DEFAULT_OPENCLAW_SESSION_PREFIX,
  callModel,
} = require("./openclaw.cjs");
const magicDocs = require("./magic-docs.cjs");
const storySystem = require("./story-system.cjs");
const tools = require("./tools.cjs");
const { buildDynamicFrame, buildSystemPrompt, runForgeAgent } = require("./agent-loop.cjs");
const { isRemoteAgentConfigured } = require("./remote-agent.cjs");
const { callMethodDirectiveServer } = require("./method-server.cjs");
const {
  applyProtectedAnvilActions,
  callProtectedAnvilTurn,
} = require("./protected-anvil-client.cjs");
const {
  APP_EXTRACTION_REFUSAL,
  REDACTED_EXTRACTION_TURN,
  detectDistillationRequest,
} = require("./distillation-guard.cjs");
const { extractFirstAndLastFrames, probeDuration } = require("./frames.cjs");

const APP_FOLDER = ".forge";
const PROJECT_FILE = "project.json";
const CHAT_FOLDER = "chats";
const INDEX_FILE = "index.json";
const STORY_FOLDER = "story";
const PROJECT_SCOPE_PATH = `${STORY_FOLDER}/intake.md`;
const MASTER_SCRIPT_FOLDER = "script";
const MASTER_SCRIPT_FILE = "master-script.md";
const DIALOGUE_FOLDER = "dialogue";
const DIALOGUE_FILE = "dialogue.md";
const DIALOGUE_PATH = `${DIALOGUE_FOLDER}/${DIALOGUE_FILE}`;
const DIALOGUE_TITLE = "Dialogue";
const SCENES_FOLDER = "scenes";
const PROMPTS_FOLDER = "prompts";
const ASSET_SECTIONS = new Set(["characters", "locations", "props", "keyframes", "audio"]);
const API_PROVIDER_CAPABILITIES = new Set(["image", "video", "music", "voice", "code", "text", "custom"]);
const MEDIA_PROVIDER_CAPABILITIES = new Set(["image", "video", "music", "voice"]);
const STORY_DEFAULTS = storySystem.STORY_DOC_SPECS.map((entry) => ({
  path: entry.path,
  title: entry.title,
  // Built-in context docs stay intentionally small: World Bible only.
  // Project Scope is scaffolded by intake-doc.cjs so it can keep the intake
  // markers stable; hidden workflow/protocol lives in ANVIL.md.
  contextGroup: entry.contextGroup || "canon",
}));
const LEGACY_STORY_DOC_PATHS = storySystem.LEGACY_STORY_DOC_PATHS;
const STORY_CONTEXT_GROUPS = new Set(["project", "canon", "asset"]);
const LIBRARY_MEDIA_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif", ".heic", ".tiff",
  ".mp3", ".wav", ".m4a", ".aac", ".aiff", ".flac", ".ogg",
]);
const DEBUG_ELECTRON = process.env.FORGE_DEBUG_ELECTRON === "1";
const DEBUG_DUMP_RENDERER = process.env.FORGE_DEBUG_DUMP_RENDERER === "1";
const DEBUG_CAPTURE_PATH = process.env.FORGE_DEBUG_CAPTURE_PATH || "";
const DEBUG_SMOKE_OPENCLAW = process.env.FORGE_DEBUG_SMOKE_OPENCLAW === "1";
const DEBUG_HOOK_TOKEN = process.env.FORGE_DEBUG_HOOK_TOKEN || "";
const SECRETS_FILE = "project-secrets.json";
// App-level agent defaults let a new/older project inherit the last
// supported local runtime + media config the user configured
// elsewhere, instead of falling back to OpenClaw. Non-secret fields
// live in plaintext JSON; media keys piggy-back on the encrypted
// secret store under a reserved sentinel key.
const APP_DEFAULTS_FILE = "agent-defaults.json";
const APP_DEFAULTS_SECRET_KEY = "__app_defaults__";
const DESKTOP_ACCOUNT_SECRET_KEY = "__desktop_account__";
const WATCH_DEBOUNCE_MS = 150;
let mainWindow = null;

// Module-scope map of in-flight agent requests so both the app-ready
// IPC handlers AND the window-close / before-quit handlers can reach
// it. Previously this lived inside app.whenReady().then(...), which
// meant closing the window or quitting the app left orphaned
// AbortControllers — the fetch kept running in the main process and
// tokens kept burning with no listener for the result.
const activeAgentAborts = new Map();
const agentMagicDocSummaryCache = new Map();

function normalizeAgentProvider(providerInput) {
  return String(providerInput || "").trim().toLowerCase() === "hermes" ? "hermes" : "openclaw";
}

function abortAllActiveAgents(reason) {
  for (const [requestId, controller] of activeAgentAborts) {
    try {
      controller.abort(reason || new Error("Anvil shutting down or window closed."));
    } catch {}
    activeAgentAborts.delete(requestId);
  }
}

function invalidateAgentMagicDocSummary(projectDir) {
  const targetDir = normalizeProjectDir(projectDir);
  if (!targetDir) return;
  agentMagicDocSummaryCache.delete(targetDir);
}

async function getAgentMagicDocSummary(projectDir, ttlMs = 10_000) {
  const targetDir = normalizeProjectDir(projectDir);
  if (!targetDir) return [];
  const key = targetDir;
  const cached = agentMagicDocSummaryCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.docs;
  }
  const docs = await magicDocs.listMagicDocs(targetDir);
  agentMagicDocSummaryCache.set(key, {
    docs,
    expiresAt: Date.now() + ttlMs,
  });
  return docs;
}

async function readAssetContextGuideWithUrls(projectDir) {
  const guide = await magicDocs.readAssetContextGuide(projectDir);
  return {
    ...guide,
    references: Array.isArray(guide?.references)
      ? guide.references.map((entry) => ({
          ...entry,
          fileUrl: assetUrlFor(resolveProjectRelativePath(projectDir, entry.path)),
        }))
      : [],
  };
}

function launchProjectDir() {
  const cliArg = process.argv.find((arg) => arg.startsWith("--project-dir="));
  if (cliArg) {
    return cliArg.slice("--project-dir=".length).trim();
  }
  return (process.env.FORGE_PROJECT_DIR || "").trim();
}

function debugLog(...args) {
  if (DEBUG_ELECTRON) {
    console.log("[forge-electron]", ...args);
  }
}

function rendererDiagnosticsPath() {
  return path.join(app.getPath("userData"), "renderer-diagnostics.log");
}

function appendRendererDiagnostic(event, payload) {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event,
      payload,
    });
    nodeFs.appendFileSync(rendererDiagnosticsPath(), `${line}\n`, "utf8");
  } catch {}
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function rendererFallbackUrl(title, detail) {
  const logPath = rendererDiagnosticsPath();
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(APP_DISPLAY_NAME)} Renderer Recovery</title>
    <style>
      html, body { margin: 0; min-height: 100%; background: #0b0e12; color: #f4f7fb; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
      body { display: flex; align-items: center; padding: 36px; box-sizing: border-box; }
      main { max-width: 760px; }
      .kicker { color: #a78bfa; font-size: 12px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
      h1 { margin: 12px 0 0; font-size: 32px; line-height: 1.08; letter-spacing: 0; }
      p { color: #a8b3c1; line-height: 1.6; }
      code { color: #e8ddff; overflow-wrap: anywhere; }
    </style>
  </head>
  <body>
    <main>
      <div class="kicker">${escapeHtml(APP_DISPLAY_NAME)}</div>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(detail)}</p>
      <p>Diagnostic log: <code>${escapeHtml(logPath)}</code></p>
      <p>Quit and reopen the app after installing the next build.</p>
    </main>
  </body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

process.on("uncaughtExceptionMonitor", (error) => {
  appendRendererDiagnostic("main-uncaught-exception", {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : "",
  });
});

process.on("unhandledRejection", (reason) => {
  appendRendererDiagnostic("main-unhandled-rejection", {
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : "",
  });
});

function normalizeProjectFolderName(name) {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").trim() || `${APP_DISPLAY_NAME} Project`;
}

function slugifyName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "project";
}

function defaultSessionKey(project, fallbackName = `${APP_DISPLAY_NAME} Project`) {
  const stablePart = project?.project?.id || slugifyName(project?.project?.name || fallbackName);
  return `${DEFAULT_OPENCLAW_SESSION_PREFIX}:${stablePart}`;
}

function resolveProjectRelativePath(projectDir, relativePath) {
  const normalized = String(relativePath || "").replace(/\\/g, "/").trim();
  if (!normalized) {
    throw new Error("A relative file path is required.");
  }
  if (path.isAbsolute(normalized)) {
    throw new Error("Absolute paths are not allowed.");
  }

  const candidate = path.resolve(projectDir, normalized);
  const root = path.resolve(projectDir);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error("Path escapes the current project.");
  }
  return candidate;
}

function projectSecretKey(projectDir) {
  return createHash("sha256").update(path.resolve(projectDir)).digest("hex");
}

function secretsFilePath() {
  return path.join(app.getPath("userData"), SECRETS_FILE);
}

function agentDefaultsFilePath() {
  return path.join(app.getPath("userData"), APP_DEFAULTS_FILE);
}

// Module cache of the agent-defaults JSON so normalizeProjectMetadata
// (which is sync and called from many places) can fall back to the
// last-configured provider/model without an async read per project
// open. Refreshed at startup + after every Settings save.
let cachedAppAgentDefaults = {};
const MAX_RECENT_PROJECTS = 8;

function normalizeRecentProjectEntry(entry) {
  const projectDir =
    typeof entry?.projectDir === "string" && entry.projectDir.trim()
      ? path.resolve(entry.projectDir.trim())
      : "";
  if (!projectDir) {
    return null;
  }
  return {
    projectDir,
    projectName:
      typeof entry?.projectName === "string" && entry.projectName.trim()
        ? entry.projectName.trim()
        : path.basename(projectDir),
    openedAt:
      typeof entry?.openedAt === "string" && entry.openedAt.trim()
        ? entry.openedAt.trim()
        : new Date().toISOString(),
  };
}

function normalizeProjectDir(projectDir) {
  const raw = typeof projectDir === "string" ? projectDir.trim() : "";
  return raw ? path.resolve(raw) : "";
}

function requireProjectDir(projectDir, message = "Project path is required.") {
  const targetDir = normalizeProjectDir(projectDir);
  if (!targetDir) {
    throw new Error(message);
  }
  return targetDir;
}

// `shell` is the launch UI default. The other launchers stay available for
// legacy/programmatic agent starts, but the user-facing pane is just Terminal.
// `cli` runs the user-configured agentBinPath (OpenClaw / Hermes / etc.).
const PROJECT_TERMINAL_LAUNCHERS = new Set(["shell", "codex", "claude", "cli"]);

function normalizeProjectTerminalLauncher(value) {
  const launcher = String(value || "shell").trim().toLowerCase();
  return PROJECT_TERMINAL_LAUNCHERS.has(launcher) ? launcher : "shell";
}

function posixShellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function windowsCmdQuote(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function shellQuote(value, platform = process.platform) {
  return platform === "win32" ? windowsCmdQuote(value) : posixShellQuote(value);
}

const ANVIL_AGENT_TERMINAL_CONTRACT = [
  "You are working in an Anvil public workspace example. Private production methods are not included.",
  "Read AGENT.md/AGENTS.md or CLAUDE.md, ANVIL.md, story/intake.md, and .forge/agent-note.md when present.",
  "Preserve user edits and use existing story/, script/, scenes/, prompts/, and custom/ files.",
  "Use application tools for metadata and media. Read assets/INDEX.md and .forge/integrations.md as needed.",
  "Keep credentials outside project documents. Ask before destructive changes, paid operations, or publication.",
  "Save requested edits to project files, then report the changed paths.",
].join(" ");

const ANVIL_AGENT_READY_PROMPT =
  "For this startup turn, read the project guide files if available, then reply only with: Anvil agent ready.";

const ANVIL_CODEX_START_PROMPT = [
  "Session bootstrap:",
  ANVIL_AGENT_TERMINAL_CONTRACT,
  ANVIL_AGENT_READY_PROMPT,
].join(" ");

const ANVIL_CLAUDE_START_PROMPT = [
  "Session bootstrap:",
  ANVIL_AGENT_READY_PROMPT,
].join(" ");

function dangerousAgentBypassEnabled(options = {}) {
  if (process.env.ANVIL_DISABLE_AGENT_BYPASS === "1") return false;
  if (process.env.ANVIL_ENABLE_AGENT_BYPASS === "1") return true;
  return options?.agentBypassPermissions !== false;
}

function normalizeAgentApprovalMode(value) {
  return value === "ask" ? "ask" : "autonomous";
}

function agentBypassPermissionsFromSettings(settings) {
  return normalizeAgentApprovalMode(settings?.agentApprovalMode) === "autonomous";
}

function normalizeAgentMediaStaging(value) {
  return value === "inbox" ? "inbox" : "direct";
}

function normalizeAnvilCredits(value = {}, mediaModels = {}) {
  const pickModel = (capability, fallback) => {
    const direct = value?.[capability]?.model;
    if (typeof direct === "string" && direct.trim()) return direct.trim();
    const modelOverride = mediaModels?.[capability];
    if (typeof modelOverride === "string" && modelOverride.trim()) return modelOverride.trim();
    return fallback;
  };
  return {
    image: {
      enabled: value?.image?.enabled === true,
      model: pickModel("image", "nanobanana-pro"),
    },
    video: {
      enabled: value?.video?.enabled === true,
      model: pickModel("video", "seedance-2.0"),
    },
  };
}

function launcherUsesDangerousBypass(launcher, options = {}) {
  return (launcher === "codex" || launcher === "claude") && dangerousAgentBypassEnabled(options);
}

function launcherCliCommand(launcher, options = {}, platform = process.platform) {
  const bypass = launcherUsesDangerousBypass(launcher, options);
  if (launcher === "codex") {
    const command = bypass ? "codex --dangerously-bypass-approvals-and-sandbox" : "codex";
    return `${command} ${shellQuote(ANVIL_CODEX_START_PROMPT, platform)}`;
  }
  if (launcher === "claude") {
    const command = bypass ? "claude --dangerously-skip-permissions" : "claude";
    return `${command} --append-system-prompt ${shellQuote(ANVIL_AGENT_TERMINAL_CONTRACT, platform)} ${shellQuote(ANVIL_CLAUDE_START_PROMPT, platform)}`;
  }
  return "";
}

function launcherBypassWarningCommand(launcher, platform = process.platform, options = {}) {
  if (!launcherUsesDangerousBypass(launcher, options)) return "";
  const message = "WARNING: Anvil testing bypass is ON for this local agent session.";
  if (platform === "win32") return `echo ${message}`;
  return `printf ${posixShellQuote(`\\033[33m${message}\\033[0m\\n`)}`;
}

function projectTerminalLabel(launcher) {
  if (launcher === "codex") return "Codex CLI";
  if (launcher === "claude") return "Claude Code";
  if (launcher === "cli") return "Custom CLI";
  return "terminal";
}

function anvilCliBinDirs() {
  const candidates = [
    path.join(__dirname, "bin"),
    path.resolve(__dirname, "..", "..", "..", "bin"),
  ];
  if (process.resourcesPath) {
    candidates.unshift(path.join(process.resourcesPath, "app.asar.unpacked", "electron", "bin"));
  }
  return candidates.filter((candidate, index, list) =>
    candidate &&
    list.indexOf(candidate) === index &&
    nodeFs.existsSync(candidate)
  );
}

function prependPathEntries(currentPath, entries, delimiter = path.delimiter) {
  const existing = String(currentPath || "").split(delimiter).filter(Boolean);
  const next = [...entries.filter(Boolean)];
  for (const entry of existing) {
    if (!next.includes(entry)) next.push(entry);
  }
  return next.join(delimiter);
}

function posixAnvilCliPathCommand() {
  const dirs = anvilCliBinDirs();
  if (!dirs.length) return "";
  return `export PATH=${posixShellQuote(dirs.join(":"))}:$PATH`;
}

function windowsAnvilCliPathCommand() {
  const dirs = anvilCliBinDirs();
  if (!dirs.length) return "";
  return `set "PATH=${dirs.join(";")};%PATH%"`;
}

function anvilCliInjectedEnv() {
  const gatewayInfo = activeAnvilAgentGatewayInfo();
  const configuredServerUrl =
    process.env.ANVIL_AGENT_SERVER_URL ||
    process.env.ANVIL_SERVER_URL ||
    "";
  const serverUrl =
    configuredServerUrl ||
    gatewayInfo?.url ||
    "";
  const usingLocalGateway = Boolean(gatewayInfo?.url && serverUrl === gatewayInfo.url);
  const apiToken =
    (usingLocalGateway ? gatewayInfo.token : "") ||
    process.env.ANVIL_API_TOKEN ||
    process.env.ANVIL_AGENT_SERVER_TOKEN ||
    "";
  return {
    ...(serverUrl ? { ANVIL_AGENT_SERVER_URL: serverUrl } : {}),
    ...(apiToken ? { ANVIL_API_TOKEN: apiToken } : {}),
  };
}

function posixAnvilCliSetupCommand() {
  const parts = [posixAnvilCliPathCommand()].filter(Boolean);
  const env = anvilCliInjectedEnv();
  for (const [key, value] of Object.entries(env)) {
    parts.push(`export ${key}=${posixShellQuote(value)}`);
  }
  return parts.join("; ");
}

function windowsAnvilCliSetupCommand() {
  const parts = [windowsAnvilCliPathCommand()].filter(Boolean);
  const env = anvilCliInjectedEnv();
  for (const [key, value] of Object.entries(env)) {
    parts.push(`set "${key}=${String(value).replace(/"/g, "")}"`);
  }
  return parts.join(" && ");
}

function posixProjectTerminalCommand(projectDir, launcher, keepOpen = false, options = {}) {
  const cli = launcherCliCommand(launcher, options, "posix");
  const warning = launcherBypassWarningCommand(launcher, "posix", options);
  const setupCommand = posixAnvilCliSetupCommand();
  const parts = [setupCommand, `cd ${posixShellQuote(projectDir)}`].filter(Boolean);
  if (warning) parts.push(warning);
  if (cli) parts.push(cli);
  const command = parts.join("; ");
  if (!keepOpen) return command;
  const shellPath = process.env.SHELL || "/bin/bash";
  return `${command}; exec ${posixShellQuote(shellPath)} -l`;
}

function windowsProjectTerminalCommand(projectDir, launcher, options = {}) {
  const cli = launcherCliCommand(launcher, options, "win32");
  const warning = launcherBypassWarningCommand(launcher, "win32", options);
  const setupCommand = windowsAnvilCliSetupCommand();
  const parts = [setupCommand, `cd /d ${windowsCmdQuote(projectDir)}`].filter(Boolean);
  if (warning) parts.push(warning);
  if (cli) parts.push(cli);
  return parts.join(" && ");
}

// For legacy/programmatic Claude or Codex starts, pre-mark this folder as
// trusted in the corresponding CLI's own config so first-launch trust prompts
// do not interrupt them. Best-effort: silent no-op if the CLI config file does
// not exist, or on I/O/parse error. Cross-process races with an active CLI
// session are tolerated; worst case the user sees the prompt one more time.
async function ensureCliTrust(projectDir, launcher) {
  if (launcher === "claude") {
    await ensureClaudeTrust(projectDir).catch((err) => {
      console.warn(`[trust] claude pre-trust failed: ${err?.message || err}`);
    });
  } else if (launcher === "codex") {
    await ensureCodexTrust(projectDir).catch((err) => {
      console.warn(`[trust] codex pre-trust failed: ${err?.message || err}`);
    });
  }
}

async function ensureClaudeTrust(projectDir) {
  const configPath = path.join(os.homedir(), ".claude.json");
  let raw;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    return;
  }
  if (!config || typeof config !== "object") return;
  if (!config.projects || typeof config.projects !== "object") config.projects = {};
  const existing = config.projects[projectDir];
  if (existing && existing.hasTrustDialogAccepted === true) return;
  config.projects[projectDir] = { ...(existing || {}), hasTrustDialogAccepted: true };
  await atomicWriteFile(configPath, JSON.stringify(config, null, 2));
}

async function ensureCodexTrust(projectDir) {
  const configPath = path.join(os.homedir(), ".codex", "config.toml");
  let raw;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  const escaped = projectDir.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const header = `[projects."${escaped}"]`;
  const idx = raw.indexOf(header);
  if (idx >= 0) {
    const slice = raw.slice(idx, idx + 400);
    if (/trust_level\s*=\s*"trusted"/.test(slice)) return;
  }
  const sep = raw.length === 0 || raw.endsWith("\n") ? "" : "\n";
  const block = `${sep}\n${header}\ntrust_level = "trusted"\n`;
  await atomicWriteFile(configPath, raw + block);
}

function getNodePty() {
  if (!nodePty) {
    try {
      ensureNodePtySpawnHelperExecutable();
      nodePty = require("node-pty");
    } catch (error) {
      throw new Error(
        error instanceof Error && error.message
          ? `Embedded terminal is unavailable: ${error.message}`
          : "Embedded terminal is unavailable.",
      );
    }
  }
  return nodePty;
}

function ensureNodePtySpawnHelperExecutable() {
  if (nodePtySpawnHelperChecked || process.platform === "win32") {
    return;
  }
  nodePtySpawnHelperChecked = true;
  let packageRoot = "";
  try {
    packageRoot = path.dirname(require.resolve("node-pty/package.json"));
  } catch {
    return;
  }

  const candidates = [
    path.join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
    path.join(packageRoot, "build", "Release", "spawn-helper"),
  ];
  for (const candidate of candidates) {
    try {
      const stat = nodeFs.statSync(candidate);
      if (!stat.isFile() || (stat.mode & 0o111)) {
        continue;
      }
      nodeFs.chmodSync(candidate, stat.mode | 0o755);
    } catch {}
  }
}

function normalizeTerminalDimension(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function embeddedTerminalEnv() {
  const env = { ...process.env };
  env.TERM = env.TERM || "xterm-256color";
  env.COLORTERM = env.COLORTERM || "truecolor";
  env.FORCE_COLOR = env.FORCE_COLOR || "1";
  env.PATH = prependPathEntries(env.PATH, anvilCliBinDirs());
  Object.assign(env, anvilCliInjectedEnv());

  if (process.platform !== "win32") {
    const commonPath = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
    const currentPath = String(env.PATH || "");
    const pathParts = currentPath.split(":").filter(Boolean);
    for (const part of commonPath) {
      if (!pathParts.includes(part)) {
        pathParts.push(part);
      }
    }
    env.PATH = pathParts.join(":");
  }

  return env;
}

function embeddedTerminalSpawnSpec(launcher, options = {}) {
  const safeLauncher = normalizeProjectTerminalLauncher(launcher);
  // The "cli" launcher uses whatever binary path the user supplied
  // (Settings → Agent → agentBinPath). Falls through to a plain shell
  // if nothing was provided so the chip never spawns into a void.
  const cli = safeLauncher === "cli"
    ? (typeof options.binPath === "string" && options.binPath.trim() ? options.binPath.trim() : "")
    : launcherCliCommand(safeLauncher, options, process.platform === "win32" ? "win32" : "posix");

  if (process.platform === "win32") {
    const command = process.env.ComSpec || "cmd.exe";
    const warning = launcherBypassWarningCommand(safeLauncher, "win32", options);
    const commandLine = [warning, cli].filter(Boolean).join(" && ");
    return {
      command,
      args: commandLine ? ["/d", "/s", "/k", commandLine] : [],
    };
  }

  const shellPath = process.env.SHELL || "/bin/zsh";
  if (!cli) {
    return { command: shellPath, args: ["-l"] };
  }
  const warning = launcherBypassWarningCommand(safeLauncher, "posix", options);
  const command = [warning, cli].filter(Boolean).join("; ");
  return {
    command: shellPath,
    args: ["-lc", `${command}; exec ${posixShellQuote(shellPath)} -l`],
  };
}

const projectTerminalSessions = new Map();
const TERMINAL_TRANSCRIPT_FOLDER = "terminal";
const TERMINAL_TRANSCRIPT_MAX_BYTES = 512 * 1024;
const TERMINAL_TRANSCRIPT_READ_BYTES = 160 * 1024;

function terminalTranscriptRelativePath(launcher) {
  const safeLauncher = normalizeProjectTerminalLauncher(launcher);
  return path.join(APP_FOLDER, TERMINAL_TRANSCRIPT_FOLDER, `${safeLauncher}.ansi`);
}

function terminalTranscriptPath(projectDir, launcher) {
  return path.join(projectDir, terminalTranscriptRelativePath(launcher));
}

async function trimProjectTerminalTranscript(filePath) {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return;
  }
  if (stat.size <= TERMINAL_TRANSCRIPT_MAX_BYTES) {
    return;
  }
  const keepBytes = Math.floor(TERMINAL_TRANSCRIPT_MAX_BYTES * 0.75);
  const buffer = Buffer.alloc(keepBytes);
  const handle = await fs.open(filePath, "r");
  try {
    await handle.read(buffer, 0, keepBytes, Math.max(0, stat.size - keepBytes));
  } finally {
    await handle.close();
  }
  const marker = `\n\u001b[2m--- Anvil trimmed older terminal transcript output at ${new Date().toISOString()} ---\u001b[0m\n`;
  await atomicWriteFile(filePath, `${marker}${buffer.toString("utf8")}`);
}

function scheduleProjectTerminalTranscriptFlush(state, delayMs = 250) {
  if (state.transcriptFlushTimer) {
    return;
  }
  state.transcriptFlushTimer = setTimeout(() => {
    state.transcriptFlushTimer = null;
    void flushProjectTerminalTranscript(state);
  }, delayMs);
}

async function flushProjectTerminalTranscript(state) {
  if (!state || state.transcriptFlushing) {
    if (state) state.transcriptFlushAgain = true;
    return;
  }
  const chunk = state.transcriptBuffer || "";
  if (!chunk) {
    return;
  }
  state.transcriptBuffer = "";
  state.transcriptFlushAgain = false;
  state.transcriptFlushing = true;
  try {
    const filePath = terminalTranscriptPath(state.projectDir, state.launcher);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, chunk, "utf8");
    await trimProjectTerminalTranscript(filePath);
  } catch (error) {
    debugLog("project-terminal: transcript write failed", error);
  } finally {
    state.transcriptFlushing = false;
    if (state.transcriptBuffer || state.transcriptFlushAgain) {
      scheduleProjectTerminalTranscriptFlush(state, 25);
    }
  }
}

function appendProjectTerminalTranscript(state, data, flushSoon = false) {
  if (!state || !data) {
    return;
  }
  state.transcriptBuffer += String(data);
  if (state.transcriptBuffer.length > 32 * 1024 || flushSoon) {
    void flushProjectTerminalTranscript(state);
    return;
  }
  scheduleProjectTerminalTranscriptFlush(state);
}

async function readProjectTerminalTranscript(projectDir, launcher = "shell") {
  const targetDir = requireProjectDir(projectDir, "Terminal transcript: project path is required.");
  await fs.access(projectFilePath(targetDir));
  const safeLauncher = normalizeProjectTerminalLauncher(launcher);
  const filePath = terminalTranscriptPath(targetDir, safeLauncher);
  const relativePath = terminalTranscriptRelativePath(safeLauncher).replace(/\\/g, "/");
  try {
    const stat = await fs.stat(filePath);
    const readBytes = Math.min(stat.size, TERMINAL_TRANSCRIPT_READ_BYTES);
    const handle = await fs.open(filePath, "r");
    const buffer = Buffer.alloc(readBytes);
    try {
      await handle.read(buffer, 0, readBytes, Math.max(0, stat.size - readBytes));
    } finally {
      await handle.close();
    }
    return {
      ok: true,
      launcher: safeLauncher,
      path: relativePath,
      text: buffer.toString("utf8"),
      bytes: stat.size,
      truncated: stat.size > readBytes,
    };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    return {
      ok: true,
      launcher: safeLauncher,
      path: relativePath,
      text: "",
      bytes: 0,
      truncated: false,
    };
  }
}

async function clearProjectTerminalTranscript(projectDir, launcher = "shell") {
  const targetDir = requireProjectDir(projectDir, "Clear terminal transcript: project path is required.");
  await fs.access(projectFilePath(targetDir));
  const safeLauncher = normalizeProjectTerminalLauncher(launcher);
  const filePath = terminalTranscriptPath(targetDir, safeLauncher);
  await fs.rm(filePath, { force: true });
  return {
    ok: true,
    launcher: safeLauncher,
    path: terminalTranscriptRelativePath(safeLauncher).replace(/\\/g, "/"),
  };
}

function disposeProjectTerminalSession(sessionId, kill = true) {
  const state = projectTerminalSessions.get(sessionId);
  if (!state) return;
  projectTerminalSessions.delete(sessionId);
  if (state.transcriptFlushTimer) {
    clearTimeout(state.transcriptFlushTimer);
    state.transcriptFlushTimer = null;
  }
  if (!state.exited) {
    appendProjectTerminalTranscript(
      state,
      `\n\u001b[2m--- Anvil terminal detached at ${new Date().toISOString()} ---\u001b[0m\n`,
      true,
    );
  } else {
    void flushProjectTerminalTranscript(state);
  }
  for (const disposable of state.disposables || []) {
    try {
      disposable?.dispose?.();
    } catch {}
  }
  if (kill) {
    try {
      state.pty.kill();
    } catch {}
  }
}

function disposeProjectTerminalsForWebContents(webContentsId) {
  for (const [sessionId, state] of projectTerminalSessions.entries()) {
    if (state.webContentsId === webContentsId) {
      disposeProjectTerminalSession(sessionId);
    }
  }
}

function disposeAllProjectTerminals() {
  for (const sessionId of Array.from(projectTerminalSessions.keys())) {
    disposeProjectTerminalSession(sessionId);
  }
}

async function startEmbeddedProjectTerminal(webContents, payload = {}) {
  const targetDir = requireProjectDir(payload?.projectDir, "Terminal: project path is required.");
  await fs.access(projectFilePath(targetDir));
  await ensureAnvilAgentGatewayStarted();
  const launcher = normalizeProjectTerminalLauncher(payload?.launcher);
  const launchSettings = await readProjectTerminalLaunchSettings(targetDir);
  await ensureCliTrust(targetDir, launcher);
  const agentView = await buildAgentSecretsView(targetDir);
  await writeIntegrationsManifest(targetDir, agentView);
  const cols = normalizeTerminalDimension(payload?.cols, 96, 20, 320);
  const rows = normalizeTerminalDimension(payload?.rows, 28, 8, 160);
  const spec = embeddedTerminalSpawnSpec(launcher, {
    ...launchSettings,
    binPath: typeof payload?.binPath === "string" ? payload.binPath : "",
  });
  const pty = getNodePty().spawn(spec.command, spec.args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd: targetDir,
    env: { ...embeddedTerminalEnv(), ...agentView.env },
  });
  const sessionId = randomUUID();
  const state = {
    pty,
    projectDir: targetDir,
    launcher,
    webContentsId: webContents.id,
    disposables: [],
    transcriptBuffer: "",
    transcriptFlushAgain: false,
    transcriptFlushing: false,
    transcriptFlushTimer: null,
  };
  appendProjectTerminalTranscript(
    state,
    `\n\u001b[2m--- Anvil ${projectTerminalLabel(launcher)} session started at ${new Date().toISOString()} ---\u001b[0m\n`,
  );

  state.disposables.push(pty.onData((data) => {
    appendProjectTerminalTranscript(state, data);
    if (!webContents.isDestroyed()) {
      webContents.send("forge:project-terminal-data", { sessionId, data });
    }
  }));
  state.disposables.push(pty.onExit(({ exitCode, signal }) => {
    state.exited = true;
    appendProjectTerminalTranscript(
      state,
      `\n\u001b[2m--- ${projectTerminalLabel(launcher)} exited (${exitCode ?? 0}) at ${new Date().toISOString()} ---\u001b[0m\n`,
      true,
    );
    disposeProjectTerminalSession(sessionId, false);
    if (!webContents.isDestroyed()) {
      webContents.send("forge:project-terminal-exit", { sessionId, exitCode, signal });
    }
  }));

  projectTerminalSessions.set(sessionId, state);
  return {
    ok: true,
    sessionId,
    launcher,
    label: projectTerminalLabel(launcher),
    pid: pty.pid,
  };
}

async function readProjectTerminalLaunchSettings(projectDir) {
  try {
    const raw = await fs.readFile(projectFilePath(projectDir), "utf8");
    const parsed = JSON.parse(raw);
    return {
      agentBypassPermissions: agentBypassPermissionsFromSettings(parsed?.settings || {}),
    };
  } catch {
    return { agentBypassPermissions: true };
  }
}

const DEFAULT_DESKTOP_ANVIL_ENDPOINT = "https://www.myriadanvil.com/api/anvil-agent/turn";

function normalizeAccountPlan(value) {
  const plan = String(value || "").trim().toLowerCase();
  return plan === "pro" || plan === "studio" ? plan : "free";
}

function normalizeAccountStatus(value, plan, allowed = false) {
  const status = String(value || "").trim().toLowerCase();
  if (["active", "trialing", "past_due", "canceled", "unknown"].includes(status)) {
    return status;
  }
  if (plan === "pro" || plan === "studio" || allowed) return "active";
  return "unknown";
}

function normalizeDesktopAccountEndpoint(value) {
  const endpoint = String(value || "").trim() || DEFAULT_DESKTOP_ANVIL_ENDPOINT;
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    return DEFAULT_DESKTOP_ANVIL_ENDPOINT;
  }
  return parsed.protocol === "https:" ? parsed.toString() : DEFAULT_DESKTOP_ANVIL_ENDPOINT;
}

function decryptDesktopAccountEntry(rawEntry) {
  if (!rawEntry || typeof rawEntry !== "object") {
    return { token: "", endpoint: DEFAULT_DESKTOP_ANVIL_ENDPOINT, verifiedAt: "" };
  }
  return {
    token: decryptSecret(rawEntry.token || ""),
    endpoint: normalizeDesktopAccountEndpoint(rawEntry.endpoint || DEFAULT_DESKTOP_ANVIL_ENDPOINT),
    verifiedAt: typeof rawEntry.verifiedAt === "string" ? rawEntry.verifiedAt : "",
  };
}

async function loadDesktopAccountEntry() {
  const store = await readSecretStore();
  return decryptDesktopAccountEntry(store[DESKTOP_ACCOUNT_SECRET_KEY]);
}

async function saveDesktopAccountEntry({ token, endpoint, verifiedAt }) {
  const cleanToken = String(token || "").trim();
  if (!cleanToken) throw new Error("Desktop token is required.");
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Secret storage is unavailable on this machine. Anvil cannot save the desktop account token.");
  }
  const store = await readSecretStore();
  store[DESKTOP_ACCOUNT_SECRET_KEY] = {
    token: encryptSecret(cleanToken),
    endpoint: normalizeDesktopAccountEndpoint(endpoint),
    verifiedAt: typeof verifiedAt === "string" ? verifiedAt : new Date().toISOString(),
  };
  await writeSecretStore(store);
}

async function clearDesktopAccountEntry() {
  const store = await readSecretStore();
  delete store[DESKTOP_ACCOUNT_SECRET_KEY];
  await writeSecretStore(store);
}

async function verifyDesktopAccountToken({ token, endpoint }) {
  const cleanToken = String(token || "").trim();
  const targetEndpoint = normalizeDesktopAccountEndpoint(endpoint);
  if (!cleanToken) {
    return {
      ok: false,
      endpoint: targetEndpoint,
      message: "Desktop token is required.",
      entitlement: { plan: "free", status: "unknown" },
    };
  }

  const response = await fetch(targetEndpoint, {
    method: "GET",
    headers: {
      authorization: `Bearer ${cleanToken}`,
    },
  });
  const raw = await response.text();
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {}

  if (!response.ok) {
    return {
      ok: false,
      endpoint: targetEndpoint,
      message: parsed?.message || parsed?.error || raw || `Account status failed (${response.status}).`,
      entitlement: { plan: "free", status: "unknown" },
    };
  }

  const plan = normalizeAccountPlan(parsed?.entitlement?.plan);
  const allowed = parsed?.entitlement?.allowed === true;
  return {
    ok: true,
    endpoint: targetEndpoint,
    auth: typeof parsed?.auth === "string" ? parsed.auth : undefined,
    metering: typeof parsed?.metering === "string" ? parsed.metering : undefined,
    entitlement: {
      plan,
      status: normalizeAccountStatus(parsed?.entitlement?.status, plan, allowed),
    },
  };
}

async function getDesktopAccountSession() {
  const account = await loadDesktopAccountEntry();
  if (!account.token) {
    return {
      ok: false,
      endpoint: account.endpoint || DEFAULT_DESKTOP_ANVIL_ENDPOINT,
      message: "Sign in to Anvil and paste a desktop token to unlock the app.",
      entitlement: { plan: "free", status: "unknown" },
    };
  }
  return verifyDesktopAccountToken({ token: account.token, endpoint: account.endpoint });
}

async function connectDesktopAccountSession({ token, endpoint } = {}) {
  const result = await verifyDesktopAccountToken({ token, endpoint });
  if (!result.ok) return result;
  await saveDesktopAccountEntry({
    token,
    endpoint: result.endpoint || endpoint,
    verifiedAt: new Date().toISOString(),
  });
  return result;
}

async function getDesktopAccountStatus(projectDir) {
  const targetDir = requireProjectDir(projectDir, "Account status: project path is required.");
  await fs.access(projectFilePath(targetDir));

  let metadata = null;
  try {
    metadata = JSON.parse(await fs.readFile(projectFilePath(targetDir), "utf8"));
  } catch {
    metadata = null;
  }

  const settings = metadata?.settings && typeof metadata.settings === "object" ? metadata.settings : {};
  const secrets = await loadProjectSecrets(targetDir);
  const appAccount = await loadDesktopAccountEntry();
  const token = String(secrets.remoteAgentToken || appAccount.token || "").trim();
  const endpoint = String(settings.remoteAgentUrl || appAccount.endpoint || "").trim() || DEFAULT_DESKTOP_ANVIL_ENDPOINT;

  if (!token) {
    return {
      ok: false,
      endpoint,
      message: "No Anvil desktop token saved.",
      entitlement: { plan: "free", status: "unknown" },
    };
  }

  return verifyDesktopAccountToken({ token, endpoint });
}

function spawnDetached(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      ...options,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve({ ok: true });
    });
  });
}

async function openProjectTerminal(projectDir, launcher = "shell") {
  const targetDir = requireProjectDir(projectDir, "Open terminal: project path is required.");
  await fs.access(projectFilePath(targetDir));
  await ensureAnvilAgentGatewayStarted();
  const safeLauncher = normalizeProjectTerminalLauncher(launcher);
  const launchSettings = await readProjectTerminalLaunchSettings(targetDir);
  await ensureCliTrust(targetDir, safeLauncher);
  const agentView = await buildAgentSecretsView(targetDir);
  await writeIntegrationsManifest(targetDir, agentView);

  if (process.platform === "darwin") {
    const command = posixProjectTerminalCommand(targetDir, safeLauncher, false, launchSettings);
    await spawnDetached("osascript", [
      "-e",
      'tell application "Terminal"',
      "-e",
      "activate",
      "-e",
      `do script ${JSON.stringify(command)}`,
      "-e",
      "end tell",
    ]);
    return { ok: true, launcher: safeLauncher, label: projectTerminalLabel(safeLauncher) };
  }

  if (process.platform === "win32") {
    await spawnDetached("cmd.exe", [
      "/d",
      "/s",
      "/c",
      "start",
      "",
      "cmd.exe",
      "/k",
      windowsProjectTerminalCommand(targetDir, safeLauncher, launchSettings),
    ]);
    return { ok: true, launcher: safeLauncher, label: projectTerminalLabel(safeLauncher) };
  }

  const shellPath = process.env.SHELL || "/bin/bash";
  const command = posixProjectTerminalCommand(targetDir, safeLauncher, true, launchSettings);
  const terminalCandidates = [
    process.env.TERMINAL ? { command: process.env.TERMINAL, args: ["-e", shellPath, "-lc", command] } : null,
    { command: "x-terminal-emulator", args: ["-e", shellPath, "-lc", command] },
    { command: "gnome-terminal", args: ["--working-directory", targetDir, "--", shellPath, "-lc", command] },
    { command: "konsole", args: ["--workdir", targetDir, "-e", shellPath, "-lc", command] },
    { command: "xterm", args: ["-e", shellPath, "-lc", command] },
  ].filter(Boolean);

  let lastError = null;
  for (const candidate of terminalCandidates) {
    try {
      await spawnDetached(candidate.command, candidate.args);
      return { ok: true, launcher: safeLauncher, label: projectTerminalLabel(safeLauncher) };
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    lastError?.message
      ? `Open terminal failed: ${lastError.message}`
      : "Open terminal failed: no supported terminal app was found.",
  );
}

function recentProjectKey(projectDir) {
  const resolved = normalizeProjectDir(projectDir);
  return process.platform === "darwin" || process.platform === "win32"
    ? resolved.toLowerCase()
    : resolved;
}

function sanitizeRecentProjects(items) {
  if (!Array.isArray(items)) {
    return [];
  }
  const seen = new Set();
  const sanitized = [];
  for (const raw of items) {
    const entry = normalizeRecentProjectEntry(raw);
    if (!entry) {
      continue;
    }
    const key = recentProjectKey(entry.projectDir);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    sanitized.push(entry);
    if (sanitized.length >= MAX_RECENT_PROJECTS) {
      break;
    }
  }
  return sanitized;
}

async function loadAppAgentDefaults() {
  try {
    const raw = await fs.readFile(agentDefaultsFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? {
          ...parsed,
          recentProjects: sanitizeRecentProjects(parsed.recentProjects),
        }
      : {};
  } catch {
    return {};
  }
}

async function saveAppAgentDefaults(defaults) {
  const sanitized = {
    agentProvider: normalizeAgentProvider(defaults?.agentProvider),
    agentModel: "",
    customAgentEndpoint: "",
    agentBinPath:
      typeof defaults?.agentBinPath === "string" ? defaults.agentBinPath : "",
    agentApprovalMode: normalizeAgentApprovalMode(defaults?.agentApprovalMode),
    agentBypassPermissions: normalizeAgentApprovalMode(defaults?.agentApprovalMode) === "autonomous",
    agentMediaStaging: normalizeAgentMediaStaging(defaults?.agentMediaStaging),
    mediaMode: defaults?.mediaMode === "per" ? "per" : "one",
    mediaModels:
      defaults?.mediaModels && typeof defaults.mediaModels === "object"
        ? defaults.mediaModels
        : {},
    recentProjects: sanitizeRecentProjects(defaults?.recentProjects || cachedAppAgentDefaults.recentProjects),
  };
  // Atomic write + dedicated lock so two project-open events back-to-back
  // (or a Settings save overlapping a project-open) can't interleave and
  // corrupt agent-defaults.json. Pre-fix (review C1, 2026-05-04): raw
  // fs.writeFile with no lock — concurrent callers raced at byte level.
  await withWriteLock("app-defaults", async () => {
    await fs.mkdir(path.dirname(agentDefaultsFilePath()), { recursive: true });
    await atomicWriteFile(agentDefaultsFilePath(), JSON.stringify(sanitized, null, 2));
  });
  cachedAppAgentDefaults = sanitized;
}

async function refreshAppAgentDefaultsCache() {
  cachedAppAgentDefaults = await loadAppAgentDefaults();
}

async function listRecentProjects() {
  const current = sanitizeRecentProjects(cachedAppAgentDefaults.recentProjects);
  const existing = [];
  let changed = current.length !== (Array.isArray(cachedAppAgentDefaults.recentProjects) ? cachedAppAgentDefaults.recentProjects.length : 0);
  for (const entry of current) {
    try {
      await fs.access(projectFilePath(entry.projectDir));
      existing.push(entry);
    } catch {
      changed = true;
    }
  }
  if (changed) {
    await saveAppAgentDefaults({
      ...cachedAppAgentDefaults,
      recentProjects: existing,
    });
  }
  return existing;
}

async function rememberRecentProject(projectDir, projectName) {
  const entry = normalizeRecentProjectEntry({
    projectDir,
    projectName,
    openedAt: new Date().toISOString(),
  });
  if (!entry) {
    return;
  }
  const existing = sanitizeRecentProjects(cachedAppAgentDefaults.recentProjects);
  const key = recentProjectKey(entry.projectDir);
  const next = [
    entry,
    ...existing.filter((item) => recentProjectKey(item.projectDir) !== key),
  ].slice(0, MAX_RECENT_PROJECTS);
  await saveAppAgentDefaults({
    ...cachedAppAgentDefaults,
    recentProjects: next,
  });
}

async function readSecretStore() {
  try {
    const raw = await fs.readFile(secretsFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeSecretStore(store) {
  // Atomic write + dedicated lock so a crash mid-write can't truncate
  // the encrypted-API-keys file, and concurrent saves don't byte-interleave.
  // Pre-fix (review H3, 2026-05-04): raw fs.writeFile with no lock and no
  // .bak rotation — silent key loss on crash, race on overlap.
  await withWriteLock("app-secrets", async () => {
    await fs.mkdir(path.dirname(secretsFilePath()), { recursive: true });
    await atomicWriteFile(secretsFilePath(), JSON.stringify(store, null, 2));
  });
}

function encryptSecret(value) {
  if (!value) return "";
  if (!safeStorage.isEncryptionAvailable()) {
    return "";
  }
  return safeStorage.encryptString(value).toString("base64");
}

function decryptSecret(value) {
  if (!value || !safeStorage.isEncryptionAvailable()) {
    return "";
  }
  try {
    return safeStorage.decryptString(Buffer.from(value, "base64"));
  } catch {
    return "";
  }
}

function emptyProjectSecrets() {
  return {
    hookToken: "",
    remoteAgentToken: "",
    methodServerToken: "",
    protectedAnvilToken: "",
    apiKey: "",
    evolinkApiKey: "",
    apiKeys: {},
    mediaKeys: {},
    /** Provider registry keys, encrypted as a single blob keyed by
     *  provider id. Same single-blob pattern as mediaKeys. */
    providerKeys: {},
  };
}

// The apiKeys map is serialized as a SINGLE encrypted JSON blob so we
// only touch safeStorage once per save/load. The earlier per-entry
// encryption hit the macOS Keychain N times per operation (one per
// stored provider), which turned into a cascade of password prompts
// on unsigned dev builds. One blob = one prompt, matching how the
// single `apiKey` field has always worked.
//
// Backward-tolerant decoder — if storage still has the legacy
// { [providerId]: encryptedString } shape from the brief window where
// per-entry encryption shipped, decrypt each entry individually. On
// next save the storage re-materialises as a single blob.
function decryptApiKeysField(raw) {
  if (!raw) return {};
  if (typeof raw === "string") {
    const plainJson = decryptSecret(raw);
    if (!plainJson) return {};
    try {
      const parsed = JSON.parse(plainJson);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  if (typeof raw === "object") {
    const out = {};
    for (const [providerId, encrypted] of Object.entries(raw)) {
      if (typeof encrypted !== "string" || !encrypted) continue;
      const plain = decryptSecret(encrypted);
      if (plain) out[providerId] = plain;
    }
    return out;
  }
  return {};
}

// Encrypt the whole non-empty map as one JSON-encoded blob.
function encryptApiKeysField(map) {
  if (!map || typeof map !== "object") return "";
  const sanitized = {};
  for (const [providerId, plain] of Object.entries(map)) {
    const trimmed = typeof plain === "string" ? plain.trim() : "";
    if (trimmed) sanitized[providerId] = trimmed;
  }
  if (Object.keys(sanitized).length === 0) return "";
  return encryptSecret(JSON.stringify(sanitized));
}

function decryptSecretStoreEntry(rawEntry) {
  if (typeof rawEntry === "string") {
    return {
      ...emptyProjectSecrets(),
      hookToken: decryptSecret(rawEntry),
    };
  }
  if (!rawEntry || typeof rawEntry !== "object") {
    return emptyProjectSecrets();
  }
  return {
    hookToken: decryptSecret(rawEntry.hookToken || ""),
    remoteAgentToken: decryptSecret(rawEntry.remoteAgentToken || ""),
    methodServerToken: decryptSecret(rawEntry.methodServerToken || ""),
    protectedAnvilToken: decryptSecret(rawEntry.protectedAnvilToken || ""),
    apiKey: decryptSecret(rawEntry.apiKey || ""),
    evolinkApiKey: decryptSecret(rawEntry.evolinkApiKey || ""),
    apiKeys: decryptApiKeysField(rawEntry.apiKeys),
    // mediaKeys uses the same single-blob encryption pattern —
    // one safeStorage touch per load regardless of how many fields
    // (image/video/music/voice) the user has populated.
    mediaKeys: decryptApiKeysField(rawEntry.mediaKeys || rawEntry.mediaApiKeys),
    providerKeys: decryptApiKeysField(rawEntry.providerKeys),
  };
}

async function loadProjectSecrets(projectDir) {
  const store = await readSecretStore();
  const perProject = decryptSecretStoreEntry(store[projectSecretKey(projectDir)]);
  const appDefaults = decryptSecretStoreEntry(store[APP_DEFAULTS_SECRET_KEY]);
  const desktopAccount = decryptDesktopAccountEntry(store[DESKTOP_ACCOUNT_SECRET_KEY]);
  // Media keys inherit from the app defaults slot so generation stays
  // convenient across projects. The desktop account token is global because
  // sign-in gates the whole app, not one project at a time.
  return {
    hookToken: perProject.hookToken || appDefaults.hookToken || "",
    remoteAgentToken: perProject.remoteAgentToken || desktopAccount.token || "",
    methodServerToken: perProject.methodServerToken || "",
    protectedAnvilToken: perProject.protectedAnvilToken || desktopAccount.token || "",
    apiKey: "",
    evolinkApiKey: perProject.evolinkApiKey || appDefaults.evolinkApiKey || "",
    apiKeys: {},
    mediaKeys: { ...appDefaults.mediaKeys, ...perProject.mediaKeys },
    providerKeys: { ...appDefaults.providerKeys, ...perProject.providerKeys },
  };
}

async function saveProjectSecrets(projectDir, secrets) {
  const store = await readSecretStore();
  const key = projectSecretKey(projectDir);
  const priorSecrets = decryptSecretStoreEntry(store[key]);
  const nextSecrets = emptyProjectSecrets();
  nextSecrets.hookToken =
    typeof secrets?.hookToken === "string" ? secrets.hookToken.trim() : "";
  nextSecrets.remoteAgentToken =
    typeof secrets?.remoteAgentToken === "string" && secrets.remoteAgentToken.trim()
      ? secrets.remoteAgentToken.trim()
      : secrets?.remoteAgentTokenSaved === true
        ? priorSecrets.remoteAgentToken || ""
        : "";
  nextSecrets.methodServerToken =
    typeof secrets?.methodServerToken === "string" ? secrets.methodServerToken.trim() : "";
  nextSecrets.protectedAnvilToken =
    typeof secrets?.protectedAnvilToken === "string" ? secrets.protectedAnvilToken.trim() : "";
  nextSecrets.apiKey = "";
  nextSecrets.evolinkApiKey =
    typeof secrets?.evolinkApiKey === "string" ? secrets.evolinkApiKey.trim() : "";
  nextSecrets.apiKeys = {};
  nextSecrets.mediaKeys =
    secrets?.mediaKeys && typeof secrets.mediaKeys === "object"
      ? Object.fromEntries(
          Object.entries(secrets.mediaKeys)
            .map(([k, v]) => [k, typeof v === "string" ? v.trim() : ""])
            .filter(([, v]) => v),
        )
      : {};
  nextSecrets.providerKeys =
    secrets?.providerKeys && typeof secrets.providerKeys === "object"
      ? Object.fromEntries(
          Object.entries(secrets.providerKeys)
            .map(([k, v]) => [k, typeof v === "string" ? v.trim() : ""])
            .filter(([, v]) => v),
        )
      : {};

  const hasAnySecret = Boolean(
    nextSecrets.hookToken ||
      nextSecrets.remoteAgentToken ||
      nextSecrets.methodServerToken ||
      nextSecrets.protectedAnvilToken ||
      nextSecrets.apiKey ||
      nextSecrets.evolinkApiKey ||
      Object.keys(nextSecrets.apiKeys).length > 0 ||
      Object.keys(nextSecrets.mediaKeys).length > 0 ||
      Object.keys(nextSecrets.providerKeys).length > 0,
  );

  // Fail LOUDLY when encryption is unavailable and the user is trying to
  // save real secrets — the old code silently deleted the store entry,
  // so users thought they'd saved an API key when nothing persisted.
  if (!safeStorage.isEncryptionAvailable()) {
    if (hasAnySecret) {
      throw new Error(
        "Secret storage is unavailable on this machine (macOS Keychain / libsecret / DPAPI). API keys can't be saved. Restart Anvil, or the packaged Anvil.app if you're running an unsigned dev build.",
      );
    }
    delete store[key];
  } else if (!hasAnySecret) {
    delete store[key];
  } else {
    store[key] = {
      hookToken: nextSecrets.hookToken ? encryptSecret(nextSecrets.hookToken) : "",
      remoteAgentToken: nextSecrets.remoteAgentToken
        ? encryptSecret(nextSecrets.remoteAgentToken)
        : "",
      methodServerToken: nextSecrets.methodServerToken
        ? encryptSecret(nextSecrets.methodServerToken)
        : "",
      protectedAnvilToken: nextSecrets.protectedAnvilToken
        ? encryptSecret(nextSecrets.protectedAnvilToken)
        : "",
      apiKey: nextSecrets.apiKey ? encryptSecret(nextSecrets.apiKey) : "",
      evolinkApiKey: nextSecrets.evolinkApiKey
        ? encryptSecret(nextSecrets.evolinkApiKey)
        : "",
      apiKeys: encryptApiKeysField(nextSecrets.apiKeys),
      mediaKeys: encryptApiKeysField(nextSecrets.mediaKeys),
      providerKeys: encryptApiKeysField(nextSecrets.providerKeys),
    };
  }

  // Mirror media secrets to the app-defaults slot so a fresh project
  // inherits generation config. hookToken remains project-specific,
  // and deprecated hosted-agent API secrets are cleared.
  if (safeStorage.isEncryptionAvailable()) {
    const priorAppEntry = decryptSecretStoreEntry(store[APP_DEFAULTS_SECRET_KEY]);
    const mergedMediaKeys = { ...priorAppEntry.mediaKeys, ...nextSecrets.mediaKeys };
    const mergedProviderKeys = { ...priorAppEntry.providerKeys, ...nextSecrets.providerKeys };
    const mergedEvolinkApiKey =
      nextSecrets.evolinkApiKey || priorAppEntry.evolinkApiKey || "";
    const mergedHasAny =
      mergedEvolinkApiKey ||
      Object.keys(mergedMediaKeys).length > 0 ||
      Object.keys(mergedProviderKeys).length > 0;
    if (mergedHasAny) {
      store[APP_DEFAULTS_SECRET_KEY] = {
        hookToken: "",
        remoteAgentToken: "",
        methodServerToken: "",
        protectedAnvilToken: "",
        apiKey: "",
        evolinkApiKey: mergedEvolinkApiKey ? encryptSecret(mergedEvolinkApiKey) : "",
        apiKeys: "",
        mediaKeys: encryptApiKeysField(mergedMediaKeys),
        providerKeys: encryptApiKeysField(mergedProviderKeys),
      };
    } else {
      delete store[APP_DEFAULTS_SECRET_KEY];
    }
  }

  await writeSecretStore(store);
}

function projectFilePath(projectDir) {
  return path.join(projectDir, APP_FOLDER, PROJECT_FILE);
}

function deriveProviderEnvVar(label, fallbackId) {
  const source = String(label || fallbackId || "").trim();
  if (!source) return "";
  const slug = source.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!slug) return "";
  return slug.endsWith("API_KEY") || slug.endsWith("KEY") || slug.endsWith("TOKEN")
    ? slug
    : `${slug}_API_KEY`;
}

function normalizeProviderCapabilities(entry) {
  const raw = Array.isArray(entry?.capabilities) && entry.capabilities.length
    ? entry.capabilities
    : typeof entry?.capability === "string"
      ? [entry.capability]
      : [];
  const out = [];
  for (const cap of raw) {
    const clean = String(cap || "").trim().toLowerCase();
    if (!API_PROVIDER_CAPABILITIES.has(clean) || out.includes(clean)) continue;
    out.push(clean);
  }
  return out;
}

function primaryProviderCapability(capabilities) {
  const caps = Array.isArray(capabilities) ? capabilities : [];
  return caps.find((cap) => MEDIA_PROVIDER_CAPABILITIES.has(cap)) || caps[0] || "custom";
}

function normalizeApiProviderEntries(entries, { includeApiKey = true, now = new Date().toISOString() } = {}) {
  if (!Array.isArray(entries)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const rawId = typeof entry.id === "string" && entry.id.trim()
      ? entry.id.trim()
      : slugifyName(entry.label || `provider-${out.length + 1}`);
    const id = rawId || crypto.randomUUID();
    if (seen.has(id)) continue;
    seen.add(id);
    const capabilities = normalizeProviderCapabilities(entry);
    const normalized = {
      id,
      label: typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : id,
      capability: primaryProviderCapability(capabilities),
      capabilities,
      endpoint: typeof entry.endpoint === "string" ? entry.endpoint : "",
      envVar: typeof entry.envVar === "string" ? entry.envVar.trim() : "",
      defaultModel: typeof entry.defaultModel === "string" ? entry.defaultModel.trim() : "",
      docs: typeof entry.docs === "string" ? entry.docs : "",
      notes: typeof entry.notes === "string" ? entry.notes : "",
      createdAt: typeof entry.createdAt === "string" && entry.createdAt ? entry.createdAt : now,
      updatedAt: typeof entry.updatedAt === "string" && entry.updatedAt ? entry.updatedAt : now,
    };
    if (includeApiKey && typeof entry.apiKey === "string") {
      normalized.apiKey = entry.apiKey;
    }
    out.push(normalized);
  }
  return out;
}

// Read project.json shallow + decrypted secrets, return { env, providers }
// where env maps env-var-name → key-value and providers describes what was
// resolved (for the integrations manifest). Best-effort: any read failure
// yields an empty result instead of throwing.
async function buildAgentSecretsView(projectDir) {
  const env = {};
  const providers = [];
  const claimed = new Set();
  let secrets;
  try {
    secrets = await loadProjectSecrets(projectDir);
  } catch {
    return { env, providers };
  }
  let metadata = null;
  try {
    const raw = await fs.readFile(projectFilePath(projectDir), "utf8");
    metadata = JSON.parse(raw);
  } catch {
    metadata = null;
  }
  const settings = metadata?.settings && typeof metadata.settings === "object" ? metadata.settings : {};
  const remoteAgentUrl =
    typeof settings.remoteAgentUrl === "string" && settings.remoteAgentUrl.trim()
      ? settings.remoteAgentUrl.trim()
      : "";
  if (settings.remoteAgentEnabled === true && remoteAgentUrl) {
    env.ANVIL_AGENT_SERVER_URL = remoteAgentUrl;
    if (secrets?.remoteAgentToken) {
      env.ANVIL_API_TOKEN = secrets.remoteAgentToken;
    }
  }
  const hasExplicitProviderRegistry = Array.isArray(metadata?.settings?.apiProviders);
  const apiProviders = hasExplicitProviderRegistry
    ? metadata.settings.apiProviders
    : [];
  for (const entry of apiProviders) {
    if (!entry || typeof entry !== "object") continue;
    const id = String(entry.id || "").trim();
    if (!id) continue;
    const key = secrets?.providerKeys?.[id] || "";
    const explicitEnv = typeof entry.envVar === "string" ? entry.envVar.trim() : "";
    const desiredEnv = explicitEnv || deriveProviderEnvVar(entry.label, id);
    // Collision: if this name is already claimed (another provider, or a
    // legacy slot), suffix _2/_3/... so each provider gets its own env
    // var. Track the original name for the manifest so the user knows
    // why their provider isn't sitting on the obvious var.
    let envVar = desiredEnv;
    let renamedFrom = "";
    if (envVar && claimed.has(envVar)) {
      renamedFrom = envVar;
      let suffix = 2;
      while (claimed.has(`${desiredEnv}_${suffix}`)) suffix += 1;
      envVar = `${desiredEnv}_${suffix}`;
    }
    if (envVar) claimed.add(envVar);
    const capabilities = normalizeProviderCapabilities(entry);
    providers.push({
      id,
      label: typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : id,
      capability: primaryProviderCapability(capabilities),
      capabilities,
      envVar,
      renamedFrom,
      configured: Boolean(key),
      docs: typeof entry.docs === "string" ? entry.docs.trim() : "",
    });
    if (key && envVar) env[envVar] = key;
  }
  // Legacy EvoLink + per-capability media keys land under stable names so
  // existing agents that already know `EVOLINK_API_KEY` keep working.
  // Provider entries that already claimed these names take precedence.
  if (!hasExplicitProviderRegistry) {
    if (secrets?.evolinkApiKey && !claimed.has("EVOLINK_API_KEY")) {
      env.EVOLINK_API_KEY = secrets.evolinkApiKey;
      claimed.add("EVOLINK_API_KEY");
    }
    if (secrets?.mediaKeys && typeof secrets.mediaKeys === "object") {
      for (const cap of ["image", "video", "music", "voice"]) {
        const value = secrets.mediaKeys[cap];
        const name = `ANVIL_MEDIA_${cap.toUpperCase()}_KEY`;
        if (value && !claimed.has(name)) {
          env[name] = value;
          claimed.add(name);
        }
      }
    }
  }
  return { env, providers };
}

// Plain-text manifest at .forge/integrations.md describing what providers are
// configured and which env var holds each key. Values are NEVER written — only
// names — so the file is safe to commit. Terminal agents read this to discover
// what's wired up; actual keys live in the PTY env injected at launch.
async function writeIntegrationsManifest(projectDir, view) {
  if (!view) return;
  let mediaStaging = "direct";
  try {
    const raw = await fs.readFile(projectFilePath(projectDir), "utf8");
    const parsed = JSON.parse(raw);
    mediaStaging = normalizeAgentMediaStaging(parsed?.settings?.agentMediaStaging);
  } catch {
    mediaStaging = "direct";
  }
  const lines = [];
  lines.push("# Project integrations");
  lines.push("");
  lines.push("Anvil keeps BYOK API keys encrypted on disk. When the project terminal");
  lines.push("starts, each configured key is injected into the terminal environment");
  lines.push("under the env-var name listed below. The key VALUE never appears in");
  lines.push("this file. Run `echo $VAR_NAME` in the terminal to verify.");
  lines.push("");
  lines.push("## Routing rules");
  lines.push("");
  lines.push("- Current release mode is local desktop first with account/server surfaces active: login/account and Free + Membership plans exist, browser workspace stays hidden, Free has no backend access, and the user terminal/BYOK path remains primary.");
  lines.push("- Anvil-owned methods, private recipes, hosted Anvil agent calls, and hosted provider keys must use protected server endpoints when configured.");
  lines.push("- If a configured provider lists `image`, `video`, `music`, or `voice`, agents should use that BYOK provider/API for that capability before falling back to their own native CLI tools.");
  if (mediaStaging === "direct") {
    lines.push("- Untargeted generated media should save to All media under `assets/library/`.");
    lines.push("- Save/bind directly to a target asset only when the user names a specific character, location, prop, keyframe, audio asset, or library destination.");
    lines.push("- Use `assets/inbox/` as temporary trash/review only when the user explicitly asks for a holding lane.");
  } else {
    lines.push("- Generated media should land in `assets/inbox/` for review because this project setting explicitly requests that holding lane.");
  }
  lines.push("");
  if (!view.providers.length && !Object.keys(view.env || {}).length) {
    lines.push("_No API providers configured yet. Open Settings → API Keys to add one._");
    lines.push("");
  } else {
    if (view.providers.length) {
      lines.push("## Providers");
      lines.push("");
      lines.push("| Provider | Env var | Capabilities | Status | Notes |");
      lines.push("|----------|---------|--------------|--------|-------|");
      for (const p of view.providers) {
        const envCell = p.envVar ? `\`${p.envVar}\`` : "—";
        const capsCell = Array.isArray(p.capabilities) && p.capabilities.length
          ? p.capabilities.join(", ")
          : "native/default";
        const status = p.configured ? "configured" : "no key set";
        const notes = [];
        if (!p.envVar) notes.push("no env var — set one in Settings");
        if (p.renamedFrom) notes.push(`renamed (was \`${p.renamedFrom}\` — already claimed)`);
        lines.push(`| ${p.label} | ${envCell} | ${capsCell} | ${status} | ${notes.join("; ") || ""} |`);
      }
      lines.push("");
    }
    const extraEnvNames = Object.keys(view.env || {}).filter((name) => {
      return !view.providers.some((p) => p.envVar === name);
    });
    if (extraEnvNames.length) {
      lines.push("## Legacy / capability env vars");
      lines.push("");
      for (const name of extraEnvNames) {
        lines.push(`- \`${name}\``);
      }
      lines.push("");
    }
  }
  const filePath = path.join(projectDir, APP_FOLDER, "integrations.md");
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await atomicWriteFile(filePath, lines.join("\n"));
  } catch (err) {
    console.warn(`[integrations] write failed: ${err?.message || err}`);
  }
}

function normalizeSessionFileName(sessionKey) {
  return String(sessionKey || "default")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "") || "default";
}

function chatHistoryPath(projectDir, sessionKey) {
  return path.join(projectDir, APP_FOLDER, CHAT_FOLDER, `${normalizeSessionFileName(sessionKey)}.json`);
}

function assetDirectory(projectDir, section) {
  return path.join(projectDir, "assets", section);
}

function attachmentInboxDirectory(projectDir) {
  return path.join(projectDir, "assets", "inbox");
}

function attachmentInboxPendingDirectory(projectDir) {
  return path.join(attachmentInboxDirectory(projectDir), ".pending");
}

function isSafeInboxFileName(name) {
  if (typeof name !== "string") return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith(".")) return false;
  if (trimmed.includes("/") || trimmed.includes("\\")) return false;
  if (trimmed.includes("..")) return false;
  return true;
}

const INBOX_PENDING_SUFFIX = ".anvil-pending.json";
const MAX_INBOX_PENDING_BYTES = 32 * 1024;

function normalizeInboxPendingCapability(value) {
  const clean = String(value || "").trim().toLowerCase();
  if (clean === "image" || clean === "video" || clean === "music" || clean === "audio") return clean;
  return "asset";
}

function normalizeInboxPendingStartedAt(value, fallbackMs) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallbackMs;
}

async function readInboxPendingMarker(absPath, fallbackId) {
  let stats;
  try {
    stats = await fs.stat(absPath);
  } catch {
    return null;
  }
  if (!stats.isFile() || stats.size > MAX_INBOX_PENDING_BYTES) return null;
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(absPath, "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const id = String(parsed.id || fallbackId || "").trim();
  if (!id) return null;
  return {
    id,
    capability: normalizeInboxPendingCapability(parsed.capability),
    prompt: String(parsed.prompt || "").slice(0, 240),
    model: typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : undefined,
    section: typeof parsed.section === "string" && parsed.section.trim() ? parsed.section.trim() : undefined,
    startedAt: normalizeInboxPendingStartedAt(parsed.startedAt, stats.mtimeMs),
  };
}

async function listInboxPendingJobs(projectDir) {
  const targetDir = requireProjectDir(projectDir, "Inbox: project path is required.");
  const inboxDir = attachmentInboxDirectory(targetDir);
  const pendingDir = attachmentInboxPendingDirectory(targetDir);
  const out = [];

  const readMarker = async (absPath, fallbackId) => {
    const marker = await readInboxPendingMarker(absPath, fallbackId);
    if (marker) out.push(marker);
  };

  try {
    const entries = await fs.readdir(pendingDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".json") continue;
      await readMarker(path.join(pendingDir, entry.name), path.basename(entry.name, ".json"));
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  // Also tolerate flat marker files for agents that cannot create hidden
  // folders easily. These are filtered out of the visible inbox file list.
  try {
    const entries = await fs.readdir(inboxDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(INBOX_PENDING_SUFFIX)) continue;
      await readMarker(
        path.join(inboxDir, entry.name),
        entry.name.slice(0, -INBOX_PENDING_SUFFIX.length),
      );
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  out.sort((a, b) => b.startedAt - a.startedAt);
  return out;
}

async function listInboxFiles(projectDir) {
  const targetDir = requireProjectDir(projectDir, "Inbox: project path is required.");
  const inboxDir = attachmentInboxDirectory(targetDir);
  let entries;
  try {
    entries = await fs.readdir(inboxDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.startsWith(".")) continue;
    if (entry.name.endsWith(INBOX_PENDING_SUFFIX)) continue;
    const absPath = path.join(inboxDir, entry.name);
    let stats;
    try {
      stats = await fs.stat(absPath);
    } catch {
      continue;
    }
    out.push({
      name: entry.name,
      relPath: toProjectRelativePath(targetDir, absPath),
      kind: classifyAttachmentKind(absPath),
      size: stats.size,
      mtime: stats.mtimeMs,
      fileUrl: assetUrlFor(absPath),
    });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

async function moveInboxFileToLibrary(projectDir, name) {
  if (!isSafeInboxFileName(name)) {
    throw new Error("Inbox: invalid file name.");
  }
  const targetDir = requireProjectDir(projectDir, "Inbox: project path is required.");
  const sourcePath = path.join(attachmentInboxDirectory(targetDir), name);
  if (!(await fileExists(sourcePath))) {
    throw new Error("Inbox: file no longer exists.");
  }
  const libraryDir = path.join(targetDir, "assets", "library");
  await fs.mkdir(libraryDir, { recursive: true });
  let destName = name;
  let suffix = 2;
  while (await fileExists(path.join(libraryDir, destName))) {
    const ext = path.extname(name);
    const base = path.basename(name, ext);
    destName = `${base}-${suffix}${ext}`;
    suffix += 1;
  }
  await fs.rename(sourcePath, path.join(libraryDir, destName));
  return { ok: true, name: destName };
}

async function deleteInboxFile(projectDir, name) {
  if (!isSafeInboxFileName(name)) {
    throw new Error("Inbox: invalid file name.");
  }
  const targetDir = requireProjectDir(projectDir, "Inbox: project path is required.");
  const filePath = path.join(attachmentInboxDirectory(targetDir), name);
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  return { ok: true };
}

function normalizeRelativePath(relativePath) {
  return String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function normalizeStoryContextGroup(value) {
  const clean = String(value || "").trim().toLowerCase();
  if (STORY_CONTEXT_GROUPS.has(clean)) return clean;
  const slug = clean.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return slug || "canon";
}

function storyContextGroupForPath(relativePath, value, fallback = "canon") {
  if (normalizeRelativePath(relativePath) === PROJECT_SCOPE_PATH) return "project";
  return normalizeStoryContextGroup(value || fallback);
}

function storyTitleForPath(relativePath, title) {
  const cleanTitle = String(title || "").trim();
  if (normalizeRelativePath(relativePath) === PROJECT_SCOPE_PATH) {
    if (!cleanTitle || /^project\s+intake$/i.test(cleanTitle) || /^intake$/i.test(cleanTitle)) {
      return "Project Scope";
    }
  }
  return cleanTitle || titleFromRelativePath(relativePath);
}

function toProjectRelativePath(projectDir, absolutePath) {
  return normalizeRelativePath(path.relative(projectDir, absolutePath));
}

function classifyAttachmentKind(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif"].includes(ext)) {
    return "image";
  }
  if ([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"].includes(ext)) {
    return "audio";
  }
  if ([".mp4", ".mov", ".webm", ".m4v"].includes(ext)) {
    return "video";
  }
  if ([".pdf", ".txt", ".md", ".json", ".csv"].includes(ext)) {
    return "document";
  }
  return "other";
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function detectBinaryExtension(filePath, fallbackExtension = "") {
  const fallback = String(fallbackExtension || "").toLowerCase();
  let handle;

  try {
    handle = await fs.open(filePath, "r");
    const buffer = Buffer.alloc(64);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const slice = buffer.subarray(0, bytesRead);

    if (slice.length >= 3 && slice[0] === 0xff && slice[1] === 0xd8 && slice[2] === 0xff) {
      return ".jpg";
    }
    if (
      slice.length >= 8 &&
      slice[0] === 0x89 &&
      slice[1] === 0x50 &&
      slice[2] === 0x4e &&
      slice[3] === 0x47 &&
      slice[4] === 0x0d &&
      slice[5] === 0x0a &&
      slice[6] === 0x1a &&
      slice[7] === 0x0a
    ) {
      return ".png";
    }
    if (slice.length >= 4 && slice.toString("ascii", 0, 4) === "GIF8") {
      return ".gif";
    }
    if (
      slice.length >= 12 &&
      slice.toString("ascii", 0, 4) === "RIFF" &&
      slice.toString("ascii", 8, 12) === "WEBP"
    ) {
      return ".webp";
    }
    if (slice.length >= 2 && slice.toString("ascii", 0, 2) === "BM") {
      return ".bmp";
    }
    if (slice.length >= 12 && slice.toString("ascii", 4, 12).startsWith("ftypavif")) {
      return ".avif";
    }
    if (slice.length >= 3 && slice.toString("ascii", 0, 3) === "ID3") {
      return ".mp3";
    }
    if (
      slice.length >= 2 &&
      slice[0] === 0xff &&
      (slice[1] & 0xe0) === 0xe0
    ) {
      return ".mp3";
    }
    if (slice.length >= 4 && slice.toString("ascii", 0, 4) === "RIFF") {
      return ".wav";
    }
  } catch {
    return fallback;
  } finally {
    await handle?.close().catch(() => {});
  }

  return fallback;
}

function looksOpaqueAssetFilename(baseName, itemId = "") {
  const opaqueId = String(itemId || "").toLowerCase();
  const lowerName = String(baseName || "").toLowerCase();
  return Boolean(
    lowerName &&
      (Boolean(opaqueId) && lowerName.startsWith(opaqueId)) ||
      /^[a-f0-9-]{24,}/.test(lowerName) ||
      /-\d{10,}/.test(lowerName),
  );
}

async function nextAvailableMediaPath(projectDir, section, baseSlug, extension, usedPaths = new Set()) {
  const normalizedExtension = extension || ".bin";
  let index = 0;

  while (true) {
    const candidateName = index === 0 ? `${baseSlug}${normalizedExtension}` : `${baseSlug}-${index + 1}${normalizedExtension}`;
    const candidateRelativePath = normalizeRelativePath(path.posix.join("assets", section, candidateName));
    const candidateAbsolutePath = resolveProjectRelativePath(projectDir, candidateRelativePath);

    if (!usedPaths.has(candidateRelativePath) && !(await fileExists(candidateAbsolutePath))) {
      usedPaths.add(candidateRelativePath);
      return {
        absolutePath: candidateAbsolutePath,
        relativePath: candidateRelativePath,
      };
    }

    index += 1;
  }
}

async function nextAvailableRelativePath(projectDir, relativeDir, baseSlug, extension) {
  const normalizedDir = normalizeRelativePath(relativeDir || "");
  const normalizedExtension = extension || ".bin";
  if (!normalizedDir) {
    throw new Error("nextAvailableRelativePath: relativeDir is required.");
  }
  const absoluteDir = resolveProjectRelativePath(projectDir, normalizedDir);
  await fs.mkdir(absoluteDir, { recursive: true });
  let index = 0;

  while (true) {
    const candidateName =
      index === 0 ? `${baseSlug}${normalizedExtension}` : `${baseSlug}-${index + 1}${normalizedExtension}`;
    const candidateRelativePath = normalizeRelativePath(path.posix.join(normalizedDir, candidateName));
    const candidateAbsolutePath = resolveProjectRelativePath(projectDir, candidateRelativePath);

    if (!(await fileExists(candidateAbsolutePath))) {
      return {
        absolutePath: candidateAbsolutePath,
        relativePath: candidateRelativePath,
      };
    }

    index += 1;
  }
}

async function nextAvailableAssetContextReferencePath(projectDir, baseSlug, extension, usedPaths = new Set()) {
  const normalizedExtension = extension || ".bin";
  const referenceDir = magicDocs.assetContextReferenceDir(projectDir);
  await fs.mkdir(referenceDir, { recursive: true });
  let index = 0;

  while (true) {
    const candidateName = index === 0 ? `${baseSlug}${normalizedExtension}` : `${baseSlug}-${index + 1}${normalizedExtension}`;
    const candidateRelativePath = normalizeRelativePath(
      magicDocs.assetContextReferenceRelative(candidateName),
    );
    const candidateAbsolutePath = resolveProjectRelativePath(projectDir, candidateRelativePath);

    if (!usedPaths.has(candidateRelativePath) && !(await fileExists(candidateAbsolutePath))) {
      usedPaths.add(candidateRelativePath);
      return {
        absolutePath: candidateAbsolutePath,
        relativePath: candidateRelativePath,
      };
    }

    index += 1;
  }
}

async function copyFilesIntoLibrary(projectDir, sourcePaths) {
  const targetDir = requireProjectDir(projectDir);
  const libraryAbs = path.join(targetDir, "assets", "library");
  await fs.mkdir(libraryAbs, { recursive: true });

  const uploaded = [];
  const usedNames = new Set();
  const limitedSourcePaths = (Array.isArray(sourcePaths) ? sourcePaths : []).slice(0, LOCAL_UI_LIMITS.mediaBatchUpload);
  for (const rawPath of limitedSourcePaths) {
    const sourcePath = String(rawPath || "").trim();
    if (!sourcePath) continue;
    let stat;
    try {
      stat = await fs.stat(sourcePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const detectedExtension = await detectBinaryExtension(sourcePath, path.extname(sourcePath));
    const baseSlug = slugifyName(path.basename(sourcePath, path.extname(sourcePath)) || "library-asset");
    let targetName = `${baseSlug}${detectedExtension}`;
    let targetPath = path.join(libraryAbs, targetName);
    let attempt = 1;
    while (usedNames.has(targetName) || nodeFs.existsSync(targetPath)) {
      targetName = `${baseSlug}-${attempt}${detectedExtension}`;
      targetPath = path.join(libraryAbs, targetName);
      attempt += 1;
    }
    await fs.copyFile(sourcePath, targetPath);
    usedNames.add(targetName);
    const targetStats = await fs.stat(targetPath);
    uploaded.push({
      label: targetName,
      path: `assets/library/${targetName}`,
      fileUrl: assetUrlFor(targetPath),
      size: targetStats.size,
    });
  }
  if (uploaded.length > 0) {
    invalidateAgentMagicDocSummary(targetDir);
  }
  return uploaded;
}

async function collectSupportedLibraryFiles(sourceRoot) {
  const collected = [];
  async function walk(dir) {
    if (collected.length >= LOCAL_UI_LIMITS.mediaBatchUpload) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        if (collected.length >= LOCAL_UI_LIMITS.mediaBatchUpload) return;
      } else if (entry.isFile() && LIBRARY_MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        collected.push(absolutePath);
        if (collected.length >= LOCAL_UI_LIMITS.mediaBatchUpload) return;
      }
    }
  }
  await walk(sourceRoot);
  return collected;
}

async function rebuildMediaIndex(projectDir, debugLabel) {
  const targetDir = requireProjectDir(projectDir);
  try {
    const { runTool } = require("./tools.cjs");
    await runTool("scan_media", {}, { projectDir: targetDir });
  } catch (error) {
    debugLog(debugLabel, error);
  }
}

async function attachMediaEntries(projectDir, entries) {
  const projectRoot = requireProjectDir(projectDir, "attachMediaEntries requires a projectDir.");
  const builtins = require("./system/tools/builtins.cjs");
  const results = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    try {
      const result = await builtins.runTool(
        "attach_media",
        {
          mediaId: entry.mediaId,
          section: entry.section,
          entityId: entry.entityId,
          mode: entry.mode || "reference",
        },
        { projectDir: projectRoot },
      );
      results.push({
        mediaId: entry.mediaId,
        section: entry.section,
        entityId: entry.entityId,
        mode: entry.mode || "reference",
        ok: true,
        result,
      });
    } catch (error) {
      results.push({
        mediaId: entry.mediaId,
        section: entry.section,
        entityId: entry.entityId,
        mode: entry.mode || "reference",
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  invalidateAgentMagicDocSummary(projectRoot);
  return {
    results,
    project: await readProject(projectRoot),
  };
}

async function repairAssetMediaFiles(projectDir, metadata) {
  const usedPaths = new Set();
  for (const section of ASSET_SECTIONS) {
    const entries = Array.isArray(metadata?.[section]) ? metadata[section] : [];
    for (const entry of entries) {
      for (const media of Array.isArray(entry?.media) ? entry.media : []) {
        const normalizedPath = normalizeProjectMediaPath(projectDir, media.path);
        if (normalizedPath) {
          usedPaths.add(normalizedPath);
        }
      }
    }
  }

  let changed = false;
  const nextProject = {
    ...metadata,
  };

  for (const section of ASSET_SECTIONS) {
    nextProject[section] = await Promise.all(
      (Array.isArray(metadata?.[section]) ? metadata[section] : []).map(async (entry) => {
        const baseSlug = slugifyName(entry?.name || entry?.title || section);
        const repairedMedia = [];

        for (const [index, media] of (Array.isArray(entry?.media) ? entry.media : []).entries()) {
          const originalNormalizedPath = normalizeProjectMediaPath(projectDir, media.path);
          const absolutePath = absoluteProjectMediaPath(projectDir, media.path);
          if (!absolutePath || !(await fileExists(absolutePath))) {
            repairedMedia.push({
              ...media,
              path: originalNormalizedPath,
            });
            continue;
          }

          const actualExtension = await detectBinaryExtension(absolutePath, path.extname(absolutePath));
          const currentRelativePath = toProjectRelativePath(projectDir, absolutePath);
          const currentBaseName = path.basename(currentRelativePath, path.extname(currentRelativePath));
          const expectedBaseSlug = index === 0 ? baseSlug : `${baseSlug}-${index + 1}`;
          const needsRename =
            !currentRelativePath.startsWith(`assets/${section}/`) ||
            path.extname(currentRelativePath).toLowerCase() !== actualExtension ||
            looksOpaqueAssetFilename(currentBaseName, entry?.id);

          if (!needsRename) {
            repairedMedia.push({
              ...media,
              path: currentRelativePath,
              label:
                typeof media?.label === "string" && media.label.trim()
                  ? media.label
                  : path.basename(currentRelativePath),
            });
            continue;
          }

          if (originalNormalizedPath) {
            usedPaths.delete(originalNormalizedPath);
          }
          const target = await nextAvailableMediaPath(projectDir, section, expectedBaseSlug, actualExtension, usedPaths);
          if (target.absolutePath !== absolutePath) {
            await fs.mkdir(path.dirname(target.absolutePath), { recursive: true });
            await fs.rename(absolutePath, target.absolutePath);
          }

          repairedMedia.push({
            ...media,
            label: path.basename(target.relativePath),
            path: target.relativePath,
          });
          changed = true;
        }

        return {
          ...entry,
          media: repairedMedia,
        };
      }),
    );
  }

  if (changed) {
    nextProject.project = {
      ...nextProject.project,
      updatedAt: new Date().toISOString(),
    };
  }

  return { changed, project: nextProject };
}

const IMAGE_ASSET_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif"]);
const AUDIO_ASSET_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".aiff", ".aif", ".flac", ".ogg"]);
const VIDEO_ASSET_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"]);
const MAX_EXISTING_AUDIO_DURATION_BACKFILLS = 8;
const MAX_EXISTING_VIDEO_DURATION_BACKFILLS = 8;

function mediaKindForAssetSection(section) {
  return section === "audio" ? "audio" : "image";
}

function isSupportedAssetFile(section, entryName) {
  const ext = path.extname(String(entryName || "")).toLowerCase();
  if (!ext || String(entryName || "").startsWith(".")) {
    return false;
  }
  return section === "audio" ? AUDIO_ASSET_EXTENSIONS.has(ext) : IMAGE_ASSET_EXTENSIONS.has(ext);
}

function defaultAssetEntry(section, fileName) {
  const title = stemToTitle(path.basename(fileName, path.extname(fileName)));
  const id = crypto.randomUUID();
  return {
    id,
    title,
    name: title,
    content: "",
    path: "",
    folder: null,
    media: [],
  };
}

async function syncAssetDirectoryFiles(projectDir, metadata) {
  let changed = false;
  let existingAudioDurationBackfills = 0;
  const nextProject = {
    ...metadata,
  };

  for (const section of ASSET_SECTIONS) {
    const directory = assetDirectory(projectDir, section);
    let entries = Array.isArray(metadata?.[section]) ? metadata[section].map((entry) => ({ ...entry })) : [];

    if (section === "audio") {
      for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
        const entry = entries[entryIndex];
        const mediaList = Array.isArray(entry?.media) ? entry.media.slice() : [];
        let entryChanged = false;
        for (let mediaIndex = 0; mediaIndex < mediaList.length; mediaIndex += 1) {
          if (existingAudioDurationBackfills >= MAX_EXISTING_AUDIO_DURATION_BACKFILLS) break;
          const media = mediaList[mediaIndex];
          if (!media || media.kind !== "audio") continue;
          if (Number.isFinite(Number(media.durationSec)) && Number(media.durationSec) > 0) continue;
          const mediaPath = normalizeProjectMediaPath(projectDir, media.path);
          if (!mediaPath) continue;
          const abs = resolveProjectRelativePath(projectDir, mediaPath);
          if (!(await fileExists(abs))) continue;
          existingAudioDurationBackfills += 1;
          let durationSec = null;
          try {
            durationSec = await probeDuration(abs);
          } catch {
            durationSec = null;
          }
          if (!durationSec) continue;
          mediaList[mediaIndex] = { ...media, durationSec };
          entryChanged = true;
          changed = true;
        }
        if (entryChanged) {
          entries[entryIndex] = { ...entry, media: mediaList };
        }
      }
    }

    const knownPaths = new Set(
      entries.flatMap((entry) =>
        (Array.isArray(entry?.media) ? entry.media : [])
          .map((media) => normalizeProjectMediaPath(projectDir, media?.path))
          .filter(Boolean),
      ),
    );

    let files = [];
    try {
      files = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      nextProject[section] = entries;
      continue;
    }

    for (const file of files) {
      if (!file.isFile() || !isSupportedAssetFile(section, file.name)) {
        continue;
      }

      const relativePath = normalizeRelativePath(path.posix.join("assets", section, file.name));
      if (knownPaths.has(relativePath)) {
        continue;
      }

      const fileStemSlug = slugifyName(path.basename(file.name, path.extname(file.name)));
      const targetIndex = entries.findIndex((entry) => {
        const entrySlug = slugifyName(entry?.name || entry?.title || "");
        const entryMedia = Array.isArray(entry?.media) ? entry.media : [];
        return entrySlug === fileStemSlug && entryMedia.length === 0;
      });

      let durationSec = null;
      if (section === "audio") {
        try {
          durationSec = await probeDuration(resolveProjectRelativePath(projectDir, relativePath));
        } catch {
          durationSec = null;
        }
      }

      const mediaRecord = {
        id: crypto.randomUUID(),
        label: file.name,
        kind: mediaKindForAssetSection(section),
        path: relativePath,
        ...(durationSec ? { durationSec } : {}),
      };

      if (targetIndex !== -1) {
        const targetEntry = entries[targetIndex];
        entries[targetIndex] = {
          ...targetEntry,
          media: [...(Array.isArray(targetEntry.media) ? targetEntry.media : []), mediaRecord],
        };
      } else {
        const nextEntry = defaultAssetEntry(section, file.name);
        nextEntry.media = [mediaRecord];
        entries = [...entries, nextEntry];
      }

      knownPaths.add(relativePath);
      changed = true;
    }

    nextProject[section] = entries;
  }

  if (changed) {
    nextProject.project = {
      ...nextProject.project,
      updatedAt: new Date().toISOString(),
    };
  }

  return { changed, project: nextProject };
}

async function syncLibraryDirectoryFiles(projectDir, metadata) {
  let changed = false;
  const nextProject = {
    ...metadata,
    library: Array.isArray(metadata?.library) ? metadata.library.map((entry) => ({ ...entry })) : [],
  };

  const libraryDir = path.join(projectDir, "assets", "library");
  const knownPaths = new Set(
    nextProject.library.flatMap((entry) =>
      (Array.isArray(entry?.media) ? entry.media : [])
        .map((media) => normalizeProjectMediaPath(projectDir, media?.path))
        .filter(Boolean),
    ),
  );

  let files = [];
  try {
    files = await fs.readdir(libraryDir, { withFileTypes: true });
  } catch {
    return { changed: false, project: nextProject };
  }

  for (const file of files) {
    if (!file.isFile()) continue;
    const ext = path.extname(file.name).toLowerCase();
    if (!IMAGE_ASSET_EXTENSIONS.has(ext) && !AUDIO_ASSET_EXTENSIONS.has(ext)) {
      continue;
    }

    const relativePath = normalizeRelativePath(path.posix.join("assets", "library", file.name));
    if (!relativePath || knownPaths.has(relativePath)) {
      continue;
    }

    const title = stemToTitle(path.basename(file.name, ext));
    nextProject.library.push({
      id: crypto.randomUUID(),
      title,
      name: title,
      content: "",
      path: `library/${slugifyName(title) || "library-item"}.md`,
      folder: null,
      media: [
        {
          id: crypto.randomUUID(),
          label: file.name,
          kind: AUDIO_ASSET_EXTENSIONS.has(ext) ? "audio" : "image",
          path: relativePath,
        },
      ],
    });
    knownPaths.add(relativePath);
    changed = true;
  }

  if (changed) {
    nextProject.project = {
      ...nextProject.project,
      updatedAt: new Date().toISOString(),
    };
  }

  return { changed, project: nextProject };
}

// Recursively walk assets/videos/ to pick up files that exist on disk but
// aren't yet registered as VideoEntry records. Expected layout:
//   assets/videos/<scene-slug>/<shot-slug>/<prompt-slug>/take-NN.mp4
// Folder slugs map back to project entities by path basename. Anything
// that can't be resolved becomes an orphan (sceneId/shotId/promptId =
// null) and surfaces in the UI's Unlinked drawer for manual re-assignment.
// Also drops VideoEntry records whose underlying file disappeared.
async function syncVideoDirectoryFiles(projectDir, metadata) {
  const nextProject = {
    ...metadata,
    videos: Array.isArray(metadata?.videos) ? metadata.videos.map((v) => ({ ...v })) : [],
  };

  const videosRoot = path.join(projectDir, "assets", "videos");
  const knownPaths = new Set(nextProject.videos.map((v) => normalizeRelativePath(v.path)).filter(Boolean));

  const basenameOf = (p) => path.basename(String(p || ""), path.extname(String(p || ""))).toLowerCase();
  const sceneBySlug = new Map();
  for (const scene of Array.isArray(metadata?.script) ? metadata.script : []) {
    if (scene?.kind === "scene" && scene.path) {
      sceneBySlug.set(basenameOf(scene.path), scene);
    }
  }
  const shotBySlug = new Map();
  for (const shot of Array.isArray(metadata?.shots) ? metadata.shots : []) {
    if (shot?.path) shotBySlug.set(basenameOf(shot.path), shot);
  }
  const promptBySlug = new Map();
  for (const promptEntry of Array.isArray(metadata?.prompts) ? metadata.prompts : []) {
    if (promptEntry?.path) promptBySlug.set(basenameOf(promptEntry.path), promptEntry);
  }

  let changed = false;
  let existingDurationBackfills = 0;

  async function walk(absDir, rel) {
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childAbs = path.join(absDir, entry.name);
      const childRel = rel ? path.posix.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        await walk(childAbs, childRel);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!VIDEO_ASSET_EXTENSIONS.has(ext)) continue;
      const relativePath = normalizeRelativePath(path.posix.join("assets", "videos", childRel));
      if (!relativePath) continue;

      // Resolve scene/shot/prompt from folder slugs by path-basename match.
      // We don't rely on segment ORDER — a shallower layout (e.g. flat
      // under videos/) still resolves whatever slugs happen to match.
      const segments = childRel.split("/").filter(Boolean).slice(0, -1);
      let sceneId = null;
      let shotId = null;
      let promptId = null;
      for (const segment of segments) {
        const key = segment.toLowerCase();
        if (!sceneId && sceneBySlug.has(key)) sceneId = sceneBySlug.get(key).id;
        if (!shotId && shotBySlug.has(key)) shotId = shotBySlug.get(key).id;
        if (!promptId && promptBySlug.has(key)) promptId = promptBySlug.get(key).id;
      }

      const existingVideo = nextProject.videos.find(
        (v) => normalizeRelativePath(v.path) === relativePath,
      );
      if (existingVideo) {
        let entryChanged = false;
        const needsDuration =
          !Number.isFinite(Number(existingVideo.durationSec)) || Number(existingVideo.durationSec) <= 0;
        if (needsDuration && existingDurationBackfills < MAX_EXISTING_VIDEO_DURATION_BACKFILLS) {
          existingDurationBackfills += 1;
          try {
            const durationSec = await probeDuration(childAbs);
            if (durationSec) {
              existingVideo.durationSec = durationSec;
              entryChanged = true;
            }
          } catch {
            // Leave unknown durations null; the UI can still show the take.
          }
        }
        if (
          !existingVideo.sceneId &&
          !existingVideo.shotId &&
          !existingVideo.promptId &&
          (sceneId || shotId || promptId)
        ) {
          existingVideo.sceneId = sceneId;
          existingVideo.shotId = shotId;
          existingVideo.promptId = promptId;
          entryChanged = true;
        }
        if (entryChanged) changed = true;
        continue;
      }
      if (knownPaths.has(relativePath)) continue;

      // takeIndex: next available for the resolved owner. Prompt takes,
      // shot-level drops, scene-level drops, and Master Library imports
      // each get their own sequence so one bucket cannot silently inflate
      // another bucket's take numbers.
      const existing = nextProject.videos.filter((v) => {
        if (promptId) return v.promptId === promptId;
        if (shotId) return v.shotId === shotId && !v.promptId;
        if (sceneId) return v.sceneId === sceneId && !v.shotId && !v.promptId;
        return !v.sceneId && !v.shotId && !v.promptId;
      });
      const nextTake = existing.reduce((m, v) => Math.max(m, v.takeIndex || 0), 0) + 1;

      let durationSec = null;
      try {
        durationSec = await probeDuration(childAbs);
      } catch {
        durationSec = null;
      }

      const newVideo = {
        id: crypto.randomUUID(),
        path: relativePath,
        sceneId,
        shotId,
        promptId,
        takeIndex: nextTake,
        durationSec,
        generator: "upload",
        generatedAt: new Date().toISOString(),
        note: "",
      };
      nextProject.videos.push(newVideo);
      if (promptId) {
        const promptEntry = (Array.isArray(nextProject.prompts) ? nextProject.prompts : [])
          .find((entry) => entry.id === promptId);
        if (promptEntry) {
          const renders = Array.isArray(promptEntry.renders) ? promptEntry.renders : [];
          if (!renders.includes(newVideo.id)) {
            promptEntry.renders = [...renders, newVideo.id];
            await appendPromptRenderReference(projectDir, promptEntry, newVideo.id);
          }
        }
      }
      knownPaths.add(relativePath);
      changed = true;

      // Fire-and-forget frame extraction: pulls first + last frame PNGs
      // into .forge/frames/<videoId>/ so the continuity keyframe is ready
      // by the time the user (or agent) calls build_render_bundle on the
      // next prompt in the chain. Errors are swallowed so the scan never
      // fails on a file ffmpeg can't read — the frames directory is a
      // cache, not a source of truth.
      extractFirstAndLastFrames({
        projectDir,
        videoPath: relativePath,
        videoId: newVideo.id,
      }).catch(() => {
        // ffmpeg missing / unreadable video / timeout — non-fatal.
      });
    }
  }

  try {
    await fs.access(videosRoot);
  } catch {
    // No videos folder yet — nothing to scan, but still return any deletes below.
  }
  await walk(videosRoot, "");

  // Drop VideoEntry records whose files no longer exist. Their ids may
  // linger in PromptEntry.renders — the normalizer scrubs dangling ids
  // lazily on read, so no extra bookkeeping needed here.
  const filtered = [];
  for (const video of nextProject.videos) {
    const abs = path.join(projectDir, video.path);
    try {
      await fs.access(abs);
      filtered.push(video);
    } catch {
      changed = true;
    }
  }
  nextProject.videos = filtered;

  if (changed) {
    nextProject.project = {
      ...nextProject.project,
      updatedAt: new Date().toISOString(),
    };
  }

  return { changed, project: nextProject };
}

async function appendPromptRenderReference(projectDir, promptEntry, videoId) {
  if (!promptEntry?.path || !videoId) return;
  const promptAbs = resolveProjectRelativePath(projectDir, promptEntry.path);
  let raw = "";
  try {
    raw = await fs.readFile(promptAbs, "utf8");
  } catch {
    return;
  }

  let existingRenders = [];
  const match = raw.match(/^renders:\s*(.+)$/m);
  if (match) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (Array.isArray(parsed)) {
        existingRenders = parsed.filter((id) => typeof id === "string" && id.trim());
      }
    } catch {
      existingRenders = [];
    }
  }
  if (existingRenders.includes(videoId)) return;
  const patched = rewriteMarkdownFrontmatter(raw, {
    renders: JSON.stringify([...existingRenders, videoId]),
  });
  await fs.writeFile(promptAbs, patched, "utf8");
}

function normalizeProjectMediaPath(projectDir, mediaPath) {
  const rawPath = String(mediaPath || "").trim();
  if (!rawPath) {
    return "";
  }

  if (path.isAbsolute(rawPath)) {
    try {
      return toProjectRelativePath(projectDir, rawPath);
    } catch {
      return "";
    }
  }

  return normalizeRelativePath(rawPath);
}

function absoluteProjectMediaPath(projectDir, mediaPath) {
  const relativePath = normalizeProjectMediaPath(projectDir, mediaPath);
  if (!relativePath) {
    return "";
  }

  try {
    return resolveProjectRelativePath(projectDir, relativePath);
  } catch {
    return "";
  }
}

function stemToTitle(stem) {
  return String(stem || "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim() || "Untitled";
}

function titleFromRelativePath(relativePath) {
  return stemToTitle(path.basename(relativePath, path.extname(relativePath)));
}

function stableEntryId(relativePath) {
  return `forge-${createHash("sha1").update(normalizeRelativePath(relativePath)).digest("hex").slice(0, 16)}`;
}

function parseMarkdownDocument(raw, fallbackTitle) {
  const text = typeof raw === "string" ? raw : "";
  if (!text.startsWith("---\n")) {
    return {
      content: text.trim(),
      meta: {},
      title: fallbackTitle,
    };
  }

  const endIndex = text.indexOf("\n---\n", 4);
  if (endIndex === -1) {
    return {
      content: text.trim(),
      meta: {},
      title: fallbackTitle,
    };
  }

  const metaBlock = text.slice(4, endIndex);
  const content = text.slice(endIndex + 5).trim();
  const meta = {};

  for (const line of metaBlock.split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) {
      meta[key] = value;
    }
  }

  return {
    content,
    meta,
    title: typeof meta.title === "string" && meta.title.trim() ? meta.title.trim() : fallbackTitle,
  };
}

function serializeMarkdownDocument({ content, meta = {}, title }) {
  const frontmatter = {
    ...meta,
    title,
  };

  const lines = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === null || value === undefined || value === "") {
      continue;
    }
    lines.push(`${key}: ${String(value).replace(/\n+/g, " ").trim()}`);
  }
  lines.push("---", "", String(content || "").trim());
  return lines.join("\n").replace(/\n+$/, "\n");
}

function rewriteMarkdownFrontmatter(raw, patch) {
  const text = typeof raw === "string" ? raw : "";
  const hasFrontmatter = text.startsWith("---\n");
  let body = text;
  const meta = {};
  if (hasFrontmatter) {
    const end = text.indexOf("\n---\n", 4);
    if (end !== -1) {
      const metaBlock = text.slice(4, end);
      body = text.slice(end + 5);
      for (const line of metaBlock.split("\n")) {
        const sep = line.indexOf(":");
        if (sep === -1) continue;
        const key = line.slice(0, sep).trim();
        const value = line.slice(sep + 1).trim();
        if (key) meta[key] = value;
      }
    }
  }
  const next = { ...meta, ...patch };
  const lines = ["---"];
  for (const [key, value] of Object.entries(next)) {
    if (value === null || value === undefined || value === "") continue;
    lines.push(`${key}: ${String(value).replace(/\n+/g, " ").trim()}`);
  }
  lines.push("---", "", String(body || "").trim());
  return lines.join("\n").replace(/\n+$/, "\n");
}

const PROJECT_METHOD_PHASES = {
  scope_intake: "intake",
  context_build: "context",
  master_script: "script",
  scene_prompt_plan: "script_prompts",
  reference_images: "references",
  storyboard_sheets: "storyboards",
  video_sequence: "video",
  continuity_audit: "critique",
  timeline_assembly: "timeline",
};

const PROJECT_METHOD_CHECKPOINTS = {
  scope_intake: "review_scope",
  context_build: "review_context",
  master_script: "review_master_script",
  scene_prompt_plan: "review_script_prompts",
  reference_images: "review_bound_references",
  storyboard_sheets: "review_storyboards",
  video_sequence: "review_video_batch",
  continuity_audit: "review_repairs",
  timeline_assembly: "review_timeline",
};

function normalizeProjectMethodId(value) {
  const text = String(value || "").trim();
  return Object.prototype.hasOwnProperty.call(PROJECT_METHOD_PHASES, text) ? text : "scope_intake";
}

function normalizeProjectMethodState(raw, now) {
  const methodId = normalizeProjectMethodId(raw?.methodId);
  const checkpoint =
    typeof raw?.checkpoint === "string" && raw.checkpoint.trim()
      ? raw.checkpoint.trim().slice(0, 120)
      : PROJECT_METHOD_CHECKPOINTS[methodId];
  const phase =
    typeof raw?.phase === "string" && raw.phase.trim()
      ? raw.phase.trim().slice(0, 80)
      : PROJECT_METHOD_PHASES[methodId];
  const updatedAt =
    typeof raw?.updatedAt === "string" && raw.updatedAt.trim() ? raw.updatedAt.trim() : now;
  const out = { methodId, phase, checkpoint, updatedAt };
  if (raw?.access === "granted" || raw?.access === "basic") out.access = raw.access;
  if (raw?.tier === "creator" || raw?.tier === "free") out.tier = raw.tier;
  if (typeof raw?.directiveVersion === "string" && raw.directiveVersion.trim()) {
    out.directiveVersion = raw.directiveVersion.trim().slice(0, 80);
  }
  if (typeof raw?.source === "string" && raw.source.trim()) {
    out.source = raw.source.trim().slice(0, 80);
  }
  return out;
}

function createEmptyProject(name) {
  const now = new Date().toISOString();
  const projectId = crypto.randomUUID();
  return {
    version: 2,
    project: {
      id: projectId,
      name,
      createdAt: now,
      updatedAt: now,
    },
    methodState: normalizeProjectMethodState(null, now),
    settings: {
      hookToken: "",
      hookUrl: "",
      remoteAgentUrl: "",
      remoteAgentToken: "",
      remoteAgentEnabled: false,
      methodServerUrl: "",
      methodServerToken: "",
      methodServerEnabled: false,
      protectedAnvilUrl: "",
      protectedAnvilToken: "",
      protectedAnvilEnabled: false,
      sessionKey: `${DEFAULT_OPENCLAW_SESSION_PREFIX}:${projectId}`,
      agentProvider: "openclaw",
      agentBinPath: "",
      agentApprovalMode: "autonomous",
      agentBypassPermissions: true,
      agentMediaStaging: "direct",
      enabledSkillAddons: skillLibrary.normalizeEnabledSkillAddons([]),
      disabledSkills: [],
      agentModel: "",
      apiKey: "",
      apiKeys: {},
      mediaModels: {
        image: "nanobanana-pro",
        video: "seedance-2.0",
      },
      anvilCredits: normalizeAnvilCredits(),
      evolinkApiKey: "",
    },
    folders: [],
    library: [],
    characters: [],
    locations: [],
    props: [],
    keyframes: [],
    audio: [],
    dialogue: [],
    beats: [],
    shots: [],
    prompts: [],
  };
}

function normalizeProjectMetadata(project, fallbackName = `${APP_DISPLAY_NAME} Project`, projectDir = "") {
  const now = new Date().toISOString();
  const normalizeMediaKind = (mediaPath, explicitKind) => {
    if (explicitKind === "audio") return "audio";
    if (explicitKind === "video") return "video";
    const ext = path.extname(String(mediaPath || "")).toLowerCase();
    if (VIDEO_ASSET_EXTENSIONS.has(ext)) return "video";
    return AUDIO_ASSET_EXTENSIONS.has(ext) ? "audio" : "image";
  };
  // Validators for optional asset-entry sub-kind fields. The literal
  // shape sanitizer below was rebuilding entries with only id/title/
  // name/content/path/folder/media on every save, which silently
  // stripped any other field set by the renderer or by IPC tools
  // (kind for Single|Sheet routing on characters/locations/keyframes;
  // audioKind for music/sfx/voiceover/ambient routing on audio).
  // Preserving them is conditional + whitelisted so corrupt strings
  // can't sneak through.
  const ALLOWED_ASSET_KINDS = new Set(["single", "sheet"]);
  const ALLOWED_AUDIO_KINDS = new Set(["music", "sfx", "voiceover", "ambient"]);
  const normalizeAssets = (items, label, folderName = `${label.toLowerCase()}s`) =>
    Array.isArray(items)
      ? items.map((item, index) => ({
          id: item?.id || crypto.randomUUID(),
          title:
            typeof item?.title === "string" && item.title.trim()
              ? item.title
              : typeof item?.name === "string" && item.name.trim()
                ? item.name
                : `${label} ${index + 1}`,
          name:
            typeof item?.name === "string" && item.name.trim()
              ? item.name
              : typeof item?.title === "string" && item.title.trim()
                ? item.title
                : `${label} ${index + 1}`,
          content: typeof item?.content === "string" ? item.content : "",
          path: ASSET_SECTIONS.has(folderName)
            ? ""
            : typeof item?.path === "string" && item.path
              ? normalizeRelativePath(item.path)
              : `${folderName}/${slugifyName(item?.title || item?.name || `${label} ${index + 1}`)}.md`,
          folder: typeof item?.folder === "string" && item.folder.trim() ? item.folder : null,
          ...(ALLOWED_ASSET_KINDS.has(item?.kind) ? { kind: item.kind } : {}),
          ...(ALLOWED_AUDIO_KINDS.has(item?.audioKind) ? { audioKind: item.audioKind } : {}),
          media: Array.isArray(item?.media)
            ? item.media
                .map((media) => {
                  const mediaPath =
                    typeof media?.path === "string" && media.path
                      ? projectDir
                        ? normalizeProjectMediaPath(projectDir, media.path)
                        : normalizeRelativePath(media.path)
                      : "";

                  if (!mediaPath) {
                    return null;
                  }

                  return {
                    id: media?.id || crypto.randomUUID(),
                    label:
                      typeof media?.label === "string" && media.label.trim()
                        ? media.label
                        : path.basename(mediaPath),
                    kind: normalizeMediaKind(mediaPath, media?.kind),
                    path: mediaPath,
                    ...(Number.isFinite(Number(media?.durationSec)) && Number(media.durationSec) > 0
                      ? { durationSec: Number(media.durationSec) }
                      : {}),
                  };
                })
                .filter(Boolean)
            : [],
        }))
      : [];
  const mergeLegacyAssetRefs = (items) => {
    const out = {};
    for (const item of items) {
      if (!item || typeof item !== "object" || !item.assetRefs || typeof item.assetRefs !== "object") continue;
      for (const section of ["characters", "locations", "props", "keyframes", "audio"]) {
        const values = Array.isArray(item.assetRefs?.[section]) ? item.assetRefs[section] : [];
        if (!values.length) continue;
        const next = new Set(Array.isArray(out[section]) ? out[section] : []);
        for (const value of values) {
          if (typeof value === "string" && value.trim()) {
            next.add(value.trim());
          }
        }
        if (next.size) {
          out[section] = Array.from(next);
        }
      }
    }
    return Object.keys(out).length ? out : undefined;
  };
  const mergeEntityRefsList = (items) => {
    const seen = new Set();
    const out = [];
    for (const item of items) {
      const refs = normalizeEntityRefs(item?.entityRefs);
      for (const ref of refs) {
        const key = `${ref.section}:${ref.entityId}:${ref.role}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(ref);
      }
    }
    return out;
  };
  const mergeSuppressedRefsList = (items) => {
    const seen = new Set();
    const out = [];
    for (const item of items) {
      const refs = Array.isArray(item?.suppressedRefs) ? item.suppressedRefs : [];
      for (const ref of refs) {
        if (!ref || typeof ref !== "object") continue;
        const entityId = typeof ref.entityId === "string" ? ref.entityId.trim() : "";
        const section = typeof ref.section === "string" ? ref.section.trim() : "";
        if (!entityId || !section) continue;
        const key = `${section}:${entityId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ entityId, section });
      }
    }
    return out;
  };
  const normalizeDialogue = (items) => {
    if (!Array.isArray(items) || !items.length) return [];
    const normalizedItems = items
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        id: item?.id || crypto.randomUUID(),
        title:
          typeof item?.title === "string" && item.title.trim()
            ? item.title.trim()
            : DIALOGUE_TITLE,
        content: typeof item?.content === "string" ? item.content : "",
        path:
          typeof item?.path === "string" && item.path.trim()
            ? normalizeRelativePath(item.path)
            : DIALOGUE_PATH,
        sceneId:
          typeof item?.sceneId === "string" && item.sceneId.trim()
            ? item.sceneId
            : null,
        scenePath:
          typeof item?.scenePath === "string" && item.scenePath.trim()
            ? normalizeRelativePath(item.scenePath)
            : null,
        shotId:
          typeof item?.shotId === "string" && item.shotId.trim()
            ? item.shotId
            : null,
        shotPath:
          typeof item?.shotPath === "string" && item.shotPath.trim()
            ? normalizeRelativePath(item.shotPath)
            : null,
        assetRefs:
          item?.assetRefs && typeof item.assetRefs === "object"
            ? item.assetRefs
            : undefined,
        entityRefs: Array.isArray(item?.entityRefs) ? item.entityRefs : [],
        suppressedRefs: Array.isArray(item?.suppressedRefs) ? item.suppressedRefs : [],
      }));
    const canonical =
      normalizedItems.find((item) => item.path === DIALOGUE_PATH) ||
      normalizedItems[0];
    const mergedContent = normalizedItems
      .map((item) => item.content.trim())
      .filter(Boolean)
      .join("\n\n");
    return [{
      id: canonical.id || crypto.randomUUID(),
      title: DIALOGUE_TITLE,
      content: mergedContent,
      path: DIALOGUE_PATH,
      sceneId: null,
      scenePath: null,
      shotId: null,
      shotPath: null,
      assetRefs: mergeLegacyAssetRefs(normalizedItems),
      entityRefs: mergeEntityRefsList(normalizedItems),
      suppressedRefs: mergeSuppressedRefsList(normalizedItems),
    }];
  };

  const normalizedLibrary = normalizeAssets(project?.library, "Library", "library");
  const normalizedCharacters = normalizeAssets(project?.characters, "Character", "characters");
  const normalizedLocations = normalizeAssets(project?.locations, "Location", "locations");
  const normalizedProps = normalizeAssets(project?.props, "Prop", "props");
  const normalizedKeyframes = normalizeAssets(project?.keyframes, "Keyframe", "keyframes");
  const normalizedAudio = normalizeAssets(project?.audio, "Audio", "audio");
  // User-defined subsections that live on a primary's icon sub-rail
  // (e.g. a custom "Lore" tab under Canon, a custom "References" tab
  // under Assets). Each entry carries enough metadata for the renderer
  // to render a button + load its INSTRUCTIONS.md / file list.
  // Pre-fix this field wasn't normalized — every save dropped it on the
  // floor, so user custom subsections vanished on the next reload even
  // though the underlying folder + INSTRUCTIONS.md stayed on disk.
  const VALID_CUSTOM_SUBSECTION_PRIMARIES = new Set([
    "story",
    "script",
    "assets",
    "workshop",
  ]);
  const VALID_CUSTOM_SUBSECTION_KINDS = new Set([
    "docs",
    "gallery",
    "audio",
    "freeform",
  ]);
  // Migration: kind="script" custom subsections from the previous
  // (interim) implementation are dropped here. Their on-disk file at
  // script/<slug>.md is now loaded directly by readScriptEntries as a
  // kind="master" ScriptEntry, so the customSubsection record is
  // redundant. Filtering them out before normalization prevents them
  // from re-appearing in the renderer's subrail.
  const customSubsections = Array.isArray(project?.customSubsections)
    ? project.customSubsections
        .map((sub) => {
          if (!sub || typeof sub !== "object") return null;
          const id = typeof sub.id === "string" && sub.id.startsWith("custom:") ? sub.id : null;
          const primary = VALID_CUSTOM_SUBSECTION_PRIMARIES.has(sub.primary)
            ? sub.primary
            : null;
          const kind = VALID_CUSTOM_SUBSECTION_KINDS.has(sub.kind) ? sub.kind : null;
          const name = typeof sub.name === "string" && sub.name.trim() ? sub.name.trim() : null;
          const folder = typeof sub.folder === "string" && sub.folder.trim()
            ? normalizeRelativePath(sub.folder.trim())
            : null;
          const instructionsPath = typeof sub.instructionsPath === "string" && sub.instructionsPath.trim()
            ? normalizeRelativePath(sub.instructionsPath.trim())
            : null;
          if (!id || !primary || !kind || !name || !folder || !instructionsPath) {
            return null;
          }
          const fileExtensions = Array.isArray(sub.fileExtensions)
            ? sub.fileExtensions
                .filter((ext) => typeof ext === "string" && ext.startsWith("."))
                .map((ext) => ext.toLowerCase())
            : undefined;
          return {
            id,
            primary,
            name,
            kind,
            folder,
            instructionsPath,
            ...(fileExtensions && fileExtensions.length ? { fileExtensions } : {}),
            ...(typeof sub.icon === "string" && sub.icon.trim() ? { icon: sub.icon.trim() } : {}),
            ...(typeof sub.note === "string" && sub.note.trim() ? { note: sub.note.trim() } : {}),
            createdAt: typeof sub.createdAt === "string" && sub.createdAt ? sub.createdAt : now,
            updatedAt: typeof sub.updatedAt === "string" && sub.updatedAt ? sub.updatedAt : now,
          };
        })
        .filter(Boolean)
    : [];

  // Strip seeded Canon subsections from previous experiments. Canon
  // sections are now explicitly user-created, not auto-restored.
  const LEGACY_CANON_IDS = new Set([
    "custom:canon-characters",
    "custom:canon-locations",
    "custom:canon-lore",
    "custom:canon-notes",
  ]);
  for (let i = customSubsections.length - 1; i >= 0; i -= 1) {
    if (LEGACY_CANON_IDS.has(customSubsections[i].id)) {
      customSubsections.splice(i, 1);
    }
  }
  const readOnlyPaths = (() => {
    const seen = new Set();
    if (Array.isArray(project?.readOnlyPaths)) {
      for (const value of project.readOnlyPaths) {
        if (typeof value === "string" && value.trim()) {
          seen.add(normalizeRelativePath(value.trim()));
        }
      }
    }
    // No defaults — every project doc, including ANVIL.md, starts editable.
    // The toggle in the context-doc helper bar lets users lock specific paths
    // so agents cannot edit them.
    return [...seen];
  })();

  return {
    version: typeof project?.version === "number" ? project.version : 2,
    project: {
      id: project?.project?.id || crypto.randomUUID(),
      name:
        typeof project?.project?.name === "string" && project.project.name.trim()
          ? project.project.name
          : fallbackName,
      createdAt: project?.project?.createdAt || now,
      updatedAt: project?.project?.updatedAt || now,
      // Preserve renderer-side seed flags so one-shot effects don't
      // re-fire every save. Strip-on-save here was the cause of an
      // infinite save loop (effect sets seeded=true → save strips →
      // effect re-fires) that flickered the save indicator constantly.
      ...(project?.project?.scriptSubsectionsSeeded === true
        ? { scriptSubsectionsSeeded: true }
        : {}),
    },
    settings: {
      hookToken: "",
      hookUrl:
        typeof project?.settings?.hookUrl === "string" && project.settings.hookUrl.trim()
          ? project.settings.hookUrl
          : typeof project?.settings?.openClawUrl === "string" && project.settings.openClawUrl.trim()
            ? project.settings.openClawUrl
          : "",
      remoteAgentUrl:
        typeof project?.settings?.remoteAgentUrl === "string" && project.settings.remoteAgentUrl.trim()
          ? project.settings.remoteAgentUrl.trim()
          : "",
      remoteAgentToken: "",
      remoteAgentTokenSaved: project?.settings?.remoteAgentTokenSaved === true,
      remoteAgentEnabled: project?.settings?.remoteAgentEnabled === true,
      methodServerUrl:
        typeof project?.settings?.methodServerUrl === "string" &&
        project.settings.methodServerUrl.trim()
          ? project.settings.methodServerUrl.trim()
          : "",
      methodServerToken: "",
      methodServerEnabled: project?.settings?.methodServerEnabled === true,
      protectedAnvilUrl:
        typeof project?.settings?.protectedAnvilUrl === "string" &&
        project.settings.protectedAnvilUrl.trim()
          ? project.settings.protectedAnvilUrl.trim()
          : "",
      protectedAnvilToken: "",
      protectedAnvilEnabled: project?.settings?.protectedAnvilEnabled === true,
      sessionKey:
        typeof project?.settings?.sessionKey === "string" && project.settings.sessionKey.trim()
          ? project.settings.sessionKey
          : defaultSessionKey(project, fallbackName),
      // Only the supported local runtimes survive normalization.
      agentProvider: normalizeAgentProvider(
        typeof project?.settings?.agentProvider === "string" &&
          project.settings.agentProvider.trim()
          ? project.settings.agentProvider
          : cachedAppAgentDefaults.agentProvider,
      ),
      agentBinPath:
        typeof project?.settings?.agentBinPath === "string" &&
        project.settings.agentBinPath.trim()
          ? project.settings.agentBinPath
          : typeof cachedAppAgentDefaults.agentBinPath === "string"
            ? cachedAppAgentDefaults.agentBinPath
            : "",
      agentApprovalMode: normalizeAgentApprovalMode(
        project?.settings?.agentApprovalMode ?? cachedAppAgentDefaults.agentApprovalMode,
      ),
      agentBypassPermissions: agentBypassPermissionsFromSettings({
        agentApprovalMode: project?.settings?.agentApprovalMode ?? cachedAppAgentDefaults.agentApprovalMode,
      }),
      agentMediaStaging: normalizeAgentMediaStaging(
        project?.settings?.agentMediaStaging ?? cachedAppAgentDefaults.agentMediaStaging,
      ),
      enabledSkillAddons: skillLibrary.normalizeEnabledSkillAddons(project?.settings?.enabledSkillAddons),
      disabledSkills: skillLibrary.normalizeDisabledSkills(project?.settings?.disabledSkills),
      agentModel: "",
      customAgentEndpoint: "",
      mediaMode:
        project?.settings?.mediaMode === "per" ||
        project?.settings?.mediaMode === "one"
          ? project.settings.mediaMode
          : cachedAppAgentDefaults.mediaMode === "per" ? "per" : "one",
      mediaModels: ((perProject, defaults) => {
        const pick = (key) => {
          if (perProject && typeof perProject[key] === "string" && perProject[key].trim()) {
            return perProject[key];
          }
          if (defaults && typeof defaults[key] === "string") {
            return defaults[key];
          }
          return "";
        };
        const src = perProject && typeof perProject === "object" ? perProject : null;
        const def = defaults && typeof defaults === "object" ? defaults : null;
        if (!src && !def) return {};
        return {
          image: pick("image"),
          video: pick("video"),
          music: pick("music"),
          voice: pick("voice"),
        };
      })(project?.settings?.mediaModels, cachedAppAgentDefaults.mediaModels),
      anvilCredits: normalizeAnvilCredits(
        project?.settings?.anvilCredits,
        project?.settings?.mediaModels || cachedAppAgentDefaults.mediaModels,
      ),
      apiProviders: normalizeApiProviderEntries(project?.settings?.apiProviders, { now }),
      apiKey: "", // never persisted in project.json; lives in project-secrets
      evolinkApiKey: "", // never persisted in project.json; lives in project-secrets
    },
    folders: Array.isArray(project?.folders)
      ? project.folders.map((folder, index) => ({
          id: folder?.id || crypto.randomUUID(),
          name:
            typeof folder?.name === "string" && folder.name.trim()
              ? folder.name
              : `Folder ${index + 1}`,
          parentId: typeof folder?.parentId === "string" ? folder.parentId : null,
        }))
      : [],
    readOnlyPaths,
    methodState: normalizeProjectMethodState(project?.methodState, now),
    customSubsections,
    library: normalizedLibrary,
    characters: normalizedCharacters,
    locations: normalizedLocations,
    props: normalizedProps,
    keyframes: normalizedKeyframes,
    audio: normalizedAudio,
    dialogue: normalizeDialogue(project?.dialogue),
    videos: normalizeVideos(project?.videos),
    timeline: normalizeTimeline(project?.timeline),
  };
}

// Timeline clips are user-curated: preserve what the UI hands us as long
// as the essential fields are well-formed. orderIndex is rewritten from
// array position so gaps or duplicates from manual edits can't desync
// playback order.
function normalizeTimeline(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  let idx = 0;
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const id = typeof raw.id === "string" && raw.id.trim() ? raw.id : crypto.randomUUID();
    const promptId = typeof raw.promptId === "string" && raw.promptId.trim() ? raw.promptId : null;
    const videoId = typeof raw.videoId === "string" && raw.videoId.trim() ? raw.videoId : null;
    const mediaPath =
      typeof raw.mediaPath === "string" && raw.mediaPath.trim()
        ? normalizeRelativePath(raw.mediaPath)
        : null;
    const inSec = Number.isFinite(Number(raw.inSec)) && Number(raw.inSec) >= 0 ? Number(raw.inSec) : null;
    const outSec = Number.isFinite(Number(raw.outSec)) && Number(raw.outSec) > 0 ? Number(raw.outSec) : null;
    const enabled = raw?.enabled !== false;
    const rawTrack = typeof raw.track === "string" ? raw.track.trim() : "";
    const track = ["V1", "V2", "A1", "A2"].includes(rawTrack) ? rawTrack : undefined;
    const startSec =
      Number.isFinite(Number(raw.startSec)) && Number(raw.startSec) >= 0
        ? Number(raw.startSec)
        : null;
    const volume =
      Number.isFinite(Number(raw.volume)) && Number(raw.volume) >= 0
        ? Math.min(2, Number(raw.volume))
        : null;
    const fadeInSec =
      Number.isFinite(Number(raw.fadeInSec)) && Number(raw.fadeInSec) >= 0
        ? Number(raw.fadeInSec)
        : null;
    const fadeOutSec =
      Number.isFinite(Number(raw.fadeOutSec)) && Number(raw.fadeOutSec) >= 0
        ? Number(raw.fadeOutSec)
        : null;
    const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : null;
    out.push({
      id,
      promptId,
      videoId,
      mediaPath,
      inSec,
      outSec,
      enabled,
      orderIndex: idx,
      ...(track ? { track } : {}),
      ...(startSec !== null ? { startSec } : {}),
      ...(volume !== null ? { volume } : {}),
      ...(fadeInSec !== null ? { fadeInSec } : {}),
      ...(fadeOutSec !== null ? { fadeOutSec } : {}),
      ...(label ? { label } : {}),
    });
    idx += 1;
  }
  return out;
}

// VideoEntry is structurally distinct from AssetEntry (no media[] subarray,
// no folder, no name/title/content) so it gets its own normalizer. Missing
// fields are filled with type-valid defaults so old project.json files
// load clean. Anything unrecognizable is dropped (not resurrected).
const VIDEO_GENERATORS = new Set(["evolink", "topview", "upload"]);
function normalizeVideos(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const id = typeof raw.id === "string" && raw.id.trim() ? raw.id : crypto.randomUUID();
    const relPath = typeof raw.path === "string" ? normalizeRelativePath(raw.path) : "";
    if (!relPath) continue; // a video with no path is meaningless
    const takeIndex = Number.isFinite(Number(raw.takeIndex)) && Number(raw.takeIndex) > 0
      ? Math.round(Number(raw.takeIndex))
      : 1;
    const durationSec = Number.isFinite(Number(raw.durationSec)) && Number(raw.durationSec) > 0
      ? Number(raw.durationSec)
      : null;
    const generator = VIDEO_GENERATORS.has(raw.generator) ? raw.generator : null;
    const trimInSec =
      Number.isFinite(Number(raw.trimInSec)) && Number(raw.trimInSec) >= 0
        ? Number(raw.trimInSec)
        : null;
    const trimOutSec =
      Number.isFinite(Number(raw.trimOutSec)) && Number(raw.trimOutSec) > 0
        ? Number(raw.trimOutSec)
        : null;
    out.push({
      id,
      path: relPath,
      sceneId: typeof raw.sceneId === "string" && raw.sceneId.trim() ? raw.sceneId : null,
      shotId: typeof raw.shotId === "string" && raw.shotId.trim() ? raw.shotId : null,
      promptId: typeof raw.promptId === "string" && raw.promptId.trim() ? raw.promptId : null,
      takeIndex,
      durationSec,
      generator,
      generatedAt: typeof raw.generatedAt === "string" && raw.generatedAt
        ? raw.generatedAt
        : new Date().toISOString(),
      note: typeof raw.note === "string" ? raw.note : "",
      trimInSec,
      trimOutSec,
      isKeeper: Boolean(raw.isKeeper),
    });
  }
  return out;
}

function withFileUrls(projectDir, project) {
  const normalized = normalizeProjectMetadata(project, project?.project?.name, projectDir);
  const mapMedia = (items) =>
    items.map((item) => ({
      ...item,
      media: item.media.map((media) => ({
        ...media,
        fileUrl: absoluteProjectMediaPath(projectDir, media.path)
          ? assetUrlFor(absoluteProjectMediaPath(projectDir, media.path))
          : "",
      })),
    }));

  return {
    ...normalized,
    library: mapMedia(normalized.library),
    characters: mapMedia(normalized.characters),
    locations: mapMedia(normalized.locations),
    props: mapMedia(normalized.props),
    keyframes: mapMedia(normalized.keyframes),
    audio: mapMedia(normalized.audio),
  };
}

function prepareProjectForDisk(projectDir, project) {
  const normalized = normalizeProjectMetadata(project, project?.project?.name, projectDir);
  const stripFileUrls = (items) =>
    items.map((item) => ({
      ...item,
      media: item.media.map((media) => ({
        id: media.id,
        label: media.label,
        kind: media.kind,
        path: media.path,
        ...(Number.isFinite(Number(media.durationSec)) && Number(media.durationSec) > 0
          ? { durationSec: Number(media.durationSec) }
          : {}),
      })),
    }));

  // apiProviders: strip apiKey from each entry before writing project.json.
  // The decrypted key lives in the encrypted secrets blob only.
  const hasExplicitProviderRegistry = project?.settings?.__apiProvidersExplicit === false
    ? false
    : Array.isArray(project?.settings?.apiProviders);
  const sanitizedProviders = hasExplicitProviderRegistry
    ? normalizeApiProviderEntries(normalized.settings.apiProviders, { includeApiKey: false })
    : undefined;
  const sanitizedSettings = hasExplicitProviderRegistry
    ? { ...normalized.settings, apiProviders: sanitizedProviders }
    : { ...normalized.settings };
  if (!hasExplicitProviderRegistry) {
    delete sanitizedSettings.apiProviders;
  }
  sanitizedSettings.remoteAgentToken = "";
  sanitizedSettings.remoteAgentTokenSaved = Boolean(
    normalized.settings.remoteAgentToken ||
      normalized.settings.remoteAgentTokenSaved,
  );
  sanitizedSettings.methodServerToken = "";
  sanitizedSettings.protectedAnvilToken = "";

  return {
    ...normalized,
    library: stripFileUrls(normalized.library),
    characters: stripFileUrls(normalized.characters),
    locations: stripFileUrls(normalized.locations),
    props: stripFileUrls(normalized.props),
    keyframes: stripFileUrls(normalized.keyframes),
    audio: stripFileUrls(normalized.audio),
    settings: sanitizedSettings,
  };
}

async function ensureProjectDirectories(projectDir) {
  await fs.mkdir(path.join(projectDir, APP_FOLDER, CHAT_FOLDER), { recursive: true });
  await fs.mkdir(path.join(projectDir, APP_FOLDER, "skills"), { recursive: true });
  await fs.mkdir(path.join(projectDir, STORY_FOLDER), { recursive: true });
  await fs.mkdir(path.join(projectDir, MASTER_SCRIPT_FOLDER), { recursive: true });
  await fs.mkdir(path.join(projectDir, DIALOGUE_FOLDER), { recursive: true });
  await fs.mkdir(path.join(projectDir, SCENES_FOLDER), { recursive: true });
  await fs.mkdir(path.join(projectDir, PROMPTS_FOLDER), { recursive: true });
  await fs.mkdir(path.join(projectDir, "assets"), { recursive: true });
  await fs.mkdir(attachmentInboxDirectory(projectDir), { recursive: true });
  await Promise.all(
    ["characters", "locations", "props", "keyframes", "audio"].map((section) =>
      fs.mkdir(assetDirectory(projectDir, section), { recursive: true }),
    ),
  );
  await fs.mkdir(path.join(projectDir, "assets", "library"), { recursive: true });
  // Rendered-video takes land under assets/videos/<scene>/<shot>/<prompt>/.
  // We create the top folder eagerly so the scaffolded project looks
  // complete; per-scene subfolders are created on first generation.
  await fs.mkdir(path.join(projectDir, "assets", "videos"), { recursive: true });
  // assets/_pool/ no longer auto-created. Existing pool files remain on
  // disk and get discovered by the unified media index's recursive scan.
}

async function ensureDocument(projectDir, relativePath, title) {
  const absolutePath = resolveProjectRelativePath(projectDir, relativePath);
  try {
    await fs.access(absolutePath);
  } catch {
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(
      absolutePath,
      serializeMarkdownDocument({
        title,
        content: "",
        meta: {
          id: crypto.randomUUID(),
        },
      }),
      "utf8",
    );
  }
}

async function seedDefaultDocs(projectDir, dirName, defaultsSubDir) {
  const targetDir = path.join(projectDir, APP_FOLDER, dirName);
  const defaultsDir = path.join(__dirname, "defaults", defaultsSubDir);
  try {
    const defaults = await fs.readdir(defaultsDir);
    for (const file of defaults) {
      if (!file.endsWith(".md")) continue;
      if (defaultsSubDir === "skills" && skillLibrary.isSkillSystemProtocol(path.basename(file, ".md"))) continue;
      const target = path.join(targetDir, file);
      try {
        await fs.access(target);
      } catch {
        await fs.copyFile(path.join(defaultsDir, file), target);
      }
    }
  } catch {}
}

async function ensureProjectScaffold(projectDir) {
  await ensureProjectDirectories(projectDir);
  // Seed default skill files if they don't exist yet
  await seedDefaultDocs(projectDir, "skills", "skills");
  try {
    await require("./premium-automation.cjs").ensurePremiumAutomationScaffold(projectDir);
  } catch {}
  await storySystem.ensureStoryScaffold(projectDir);
  await storySystem.ensureStorySystem(projectDir);
  await require("./intake-doc.cjs").ensureIntakeDoc(projectDir);
  await ensureDocument(projectDir, `${MASTER_SCRIPT_FOLDER}/${MASTER_SCRIPT_FILE}`, "Master Script");
  await magicDocs.ensureDefaultMagicDocs(projectDir);
  // Do not create .forge/asset-context/guide.md on every project open.
  // That legacy guide remains readable/migratable through its explicit IPC
  // route, but the visible Context model is now plain markdown:
  // story/intake.md (Project Scope), story/world-bible.md, and user-created
  // Canon/custom docs. ANVIL.md is hidden agent protocol.
  // Seed per-section format conventions, project-wide conventions, and
  // ANVIL.md so a brand-new project has them populated on first open —
  // not only after the user talks to the agent. Each helper is idempotent
  // and no-ops when the file already exists, so this is also safe to run
  // against existing projects (e.g. to backfill files missed by an older
  // version of this scaffold).
  try {
    await require("./section-conventions.cjs").ensureAll(projectDir);
  } catch {}
  try {
    await require("./conventions.cjs").ensureConventions(projectDir);
  } catch {}
  try {
    const projectName = path.basename(projectDir) || "Untitled project";
    await require("./project-context.cjs").ensureProjectContext(projectDir, projectName);
  } catch {}
  try {
    await require("./agent-entrypoints.cjs").ensureAgentEntrypoints(projectDir);
  } catch {}
}

async function listMarkdownFiles(projectDir, relativeDir, recursive = false) {
  const absoluteDir = resolveProjectRelativePath(projectDir, relativeDir);
  const results = [];

  async function walk(currentDir) {
    let entries = [];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (recursive) {
          await walk(absolutePath);
        }
        continue;
      }
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".md") {
        continue;
      }
      results.push(toProjectRelativePath(projectDir, absolutePath));
    }
  }

  await walk(absoluteDir);
  return results.sort((left, right) => left.localeCompare(right));
}

async function readMarkdownEntry(projectDir, relativePath, extra = {}) {
  const absolutePath = resolveProjectRelativePath(projectDir, relativePath);
  const raw = await fs.readFile(absolutePath, "utf8");
  const fallbackTitle = titleFromRelativePath(relativePath);
  const parsed = parseMarkdownDocument(raw, fallbackTitle);
  return {
    content: parsed.content,
    id: typeof parsed.meta.id === "string" && parsed.meta.id.trim() ? parsed.meta.id : stableEntryId(relativePath),
    path: normalizeRelativePath(relativePath),
    title: parsed.title,
    ...extra,
    meta: parsed.meta,
  };
}

async function readStoryEntries(projectDir) {
  const known = new Set(STORY_DEFAULTS.map((entry) => entry.path));
  const defaults = [];
  for (const entry of STORY_DEFAULTS) {
    try {
      const document = await readMarkdownEntry(projectDir, entry.path, { kind: "story" });
      // For built-in defaults, the contextGroup baked into the spec wins
      // over a missing frontmatter so a freshly-scaffolded doc lands in
      // the right Context section without needing the user to edit YAML.
      const fromFrontmatter = document.meta?.contextGroup || document.meta?.context_group;
      const resolvedGroup = storyContextGroupForPath(document.path, fromFrontmatter || entry.contextGroup || "canon");
      defaults.push({
        contextGroup: resolvedGroup,
        id: document.id,
        kind: "story",
        path: document.path,
        title: storyTitleForPath(document.path, document.title),
        content: document.content,
      });
    } catch {}
  }

  const extraFiles = (await listMarkdownFiles(projectDir, STORY_FOLDER, false)).filter(
    (relativePath) => !known.has(relativePath) && !LEGACY_STORY_DOC_PATHS.has(normalizeRelativePath(relativePath)),
  );
  const extras = [];
  for (const relativePath of extraFiles) {
    const document = await readMarkdownEntry(projectDir, relativePath, { kind: "story" });
    extras.push({
      contextGroup: storyContextGroupForPath(document.path, document.meta?.contextGroup || document.meta?.context_group),
      id: document.id,
      kind: "story",
      path: document.path,
      title: storyTitleForPath(document.path, document.title),
      content: document.content,
    });
  }

  return [...defaults, ...extras];
}

async function readScriptEntries(projectDir, projectMetadata) {
  const entries = [];

  // Load EVERY .md file under script/ as a kind="master" entry.
  // master-script.md is the implicit/primary script; sibling files
  // (script/trailer.md, script/episode-2.md) are secondary scripts —
  // peers with the same data shape. Multi-script support replaces the
  // older customSubsection.kind="script" approach so all scripts share
  // one rendering path in the renderer.
  const masterPath = `${MASTER_SCRIPT_FOLDER}/${MASTER_SCRIPT_FILE}`;
  const scriptFiles = await listMarkdownFiles(projectDir, MASTER_SCRIPT_FOLDER, false);
  const seenScriptPaths = new Set();
  for (const relativePath of scriptFiles) {
    const normalized = normalizeRelativePath(relativePath);
    if (seenScriptPaths.has(normalized)) continue;
    seenScriptPaths.add(normalized);
    const entry = await readMarkdownEntry(projectDir, relativePath, { kind: "master" });
    entries.push({
      id: entry.id,
      kind: "master",
      path: entry.path,
      title: entry.title,
      content: entry.content,
      durationSec:
        typeof entry.meta?.durationSec === "string" && Number.isFinite(Number(entry.meta.durationSec))
          ? Number(entry.meta.durationSec)
          : typeof entry.meta?.durationSec === "number" && Number.isFinite(entry.meta.durationSec)
            ? entry.meta.durationSec
            : null,
    });
  }
  // Ensure master-script.md exists in the entries even if it was missing
  // on disk (the scaffold normally creates it, but readiness varies).
  if (!seenScriptPaths.has(normalizeRelativePath(masterPath))) {
    try {
      const master = await readMarkdownEntry(projectDir, masterPath, { kind: "master" });
      entries.unshift({
        id: master.id,
        kind: "master",
        path: master.path,
        title: master.title || "Master Script",
        content: master.content,
        durationSec: null,
      });
    } catch {
      // No master-script.md on disk yet — let the writer create it on
      // next save.
    }
  }
  // Sort: master-script.md first (so its tree position stays stable),
  // then other scripts alphabetically by path.
  entries.sort((a, b) => {
    if (a.path === masterPath) return -1;
    if (b.path === masterPath) return 1;
    return String(a.path).localeCompare(String(b.path));
  });

  const sceneFiles = await listMarkdownFiles(projectDir, SCENES_FOLDER, false);
  const sceneEntries = [];
  for (const relativePath of sceneFiles) {
    const scene = await readMarkdownEntry(projectDir, relativePath, { kind: "scene" });
    sceneEntries.push({
      durationSec: readDurationSec(scene.meta),
      id: scene.id,
      kind: "scene",
      path: scene.path,
      sceneOrder:
        typeof scene.meta.sceneOrder === "string" && Number.isFinite(Number(scene.meta.sceneOrder))
          ? Number(scene.meta.sceneOrder)
          : null,
      title: scene.title,
      content: scene.content,
      // Frontmatter-persisted link to the script this scene belongs to.
      // Missing means "Master Script" (legacy single-film projects).
      parentScriptPath:
        typeof scene.meta?.parentScriptPath === "string" && scene.meta.parentScriptPath.trim()
          ? normalizeRelativePath(scene.meta.parentScriptPath.trim())
          : undefined,
      assetRefs: extractLegacyAssetRefs(scene.meta),
      entityRefs: extractEntityRefs(scene.meta, projectMetadata),
      suppressedRefs: normalizeSuppressedRefs(scene.meta?.suppressedRefs),
    });
  }
  entries.push(...sortSceneEntriesByScriptOrder(sceneEntries, entries.filter((entry) => entry.kind === "master")));

  return entries;
}

async function readDialogueEntries(projectDir, sceneEntries = [], shotEntries = [], projectMetadata) {
  const sceneByFolder = new Map(
    sceneEntries
      .filter((entry) => entry.kind === "scene" && entry.path)
      .map((entry) => [path.basename(entry.path, path.extname(entry.path)), entry]),
  );
  const sceneByPath = new Map(
    sceneEntries
      .filter((entry) => entry.kind === "scene" && entry.path)
      .map((entry) => [normalizeRelativePath(entry.path), entry]),
  );
  const shotByPath = new Map(
    shotEntries
      .filter((entry) => entry.path)
      .map((entry) => [normalizeRelativePath(entry.path), entry]),
  );
  const shotByFolder = new Map(
    shotEntries
      .filter((entry) => entry.path)
      .map((entry) => [path.basename(entry.path, path.extname(entry.path)), entry]),
  );
  const dialogueFiles = await listMarkdownFiles(projectDir, DIALOGUE_FOLDER, true);
  const sceneOrder = new Map(
    sceneEntries
      .filter((entry) => entry.kind === "scene")
      .map((entry, index) => [entry.id, index]),
  );
  const shotOrder = new Map(shotEntries.map((entry, index) => [entry.id, index]));
  const mergeAssetRefs = (items) => {
    const out = {};
    for (const item of items) {
      if (!item?.assetRefs || typeof item.assetRefs !== "object") continue;
      for (const section of ["characters", "locations", "props", "keyframes", "audio"]) {
        const values = Array.isArray(item.assetRefs?.[section]) ? item.assetRefs[section] : [];
        if (!values.length) continue;
        const next = new Set(Array.isArray(out[section]) ? out[section] : []);
        for (const value of values) {
          if (typeof value === "string" && value.trim()) {
            next.add(value.trim());
          }
        }
        if (next.size) {
          out[section] = Array.from(next);
        }
      }
    }
    return Object.keys(out).length ? out : undefined;
  };
  const mergeEntityRefs = (items) => {
    const seen = new Set();
    const out = [];
    for (const item of items) {
      const refs = Array.isArray(item?.entityRefs) ? item.entityRefs : [];
      for (const ref of refs) {
        if (!ref || typeof ref !== "object") continue;
        const entityId = typeof ref.entityId === "string" ? ref.entityId.trim() : "";
        const section = typeof ref.section === "string" ? ref.section.trim() : "";
        const role = typeof ref.role === "string" ? ref.role.trim() : "";
        if (!entityId || !section || !role) continue;
        const key = `${section}:${entityId}:${role}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ entityId, section, role });
      }
    }
    return out;
  };
  const mergeSuppressedRefs = (items) => {
    const seen = new Set();
    const out = [];
    for (const item of items) {
      const refs = Array.isArray(item?.suppressedRefs) ? item.suppressedRefs : [];
      for (const ref of refs) {
        if (!ref || typeof ref !== "object") continue;
        const entityId = typeof ref.entityId === "string" ? ref.entityId.trim() : "";
        const section = typeof ref.section === "string" ? ref.section.trim() : "";
        if (!entityId || !section) continue;
        const key = `${section}:${entityId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ entityId, section });
      }
    }
    return out;
  };
  const dialogue = [];
  for (const relativePath of dialogueFiles) {
    const entry = await readMarkdownEntry(projectDir, relativePath);
    const pathParts = normalizeRelativePath(relativePath).split("/");
    const sceneFolder = pathParts.length > 2 ? pathParts[1] : "";
    const inferredScene = sceneByFolder.get(sceneFolder) || null;
    const inferredShot = (() => {
      const basename = path.basename(relativePath, path.extname(relativePath)).replace(/-dialogue$/i, "");
      return shotByFolder.get(basename) || null;
    })();
    const linkedShot =
      typeof entry.meta.shotPath === "string" && entry.meta.shotPath.trim()
        ? shotByPath.get(normalizeRelativePath(entry.meta.shotPath)) || null
        : inferredShot;
    const sceneLink = resolveSceneLink(entry.meta, relativePath, sceneEntries, linkedShot || inferredScene);
    dialogue.push({
      assetRefs: extractLegacyAssetRefs(entry.meta),
      entityRefs: extractEntityRefs(entry.meta, projectMetadata),
      id: entry.id,
      title: entry.title,
      content: entry.content,
      path: entry.path,
      sceneId: sceneLink.sceneId,
      scenePath: sceneLink.scenePath,
      shotId:
        typeof entry.meta.shotId === "string" && entry.meta.shotId.trim()
          ? entry.meta.shotId
          : linkedShot?.id || null,
      shotPath:
        typeof entry.meta.shotPath === "string" && entry.meta.shotPath.trim()
          ? normalizeRelativePath(entry.meta.shotPath)
          : linkedShot?.path || null,
      suppressedRefs: normalizeSuppressedRefs(entry.meta?.suppressedRefs),
    });
  }
  if (!dialogue.length) {
    return [];
  }

  const canonical =
    dialogue.find((entry) => normalizeRelativePath(entry.path) === DIALOGUE_PATH) ||
    dialogue[0];
  const legacyEntries = dialogue
    .filter((entry) => entry.id !== canonical.id)
    .sort((a, b) => {
      const sceneA = typeof sceneOrder.get(a.sceneId || "") === "number" ? sceneOrder.get(a.sceneId || "") : Number.MAX_SAFE_INTEGER;
      const sceneB = typeof sceneOrder.get(b.sceneId || "") === "number" ? sceneOrder.get(b.sceneId || "") : Number.MAX_SAFE_INTEGER;
      if (sceneA !== sceneB) return sceneA - sceneB;
      const shotA = typeof shotOrder.get(a.shotId || "") === "number" ? shotOrder.get(a.shotId || "") : Number.MAX_SAFE_INTEGER;
      const shotB = typeof shotOrder.get(b.shotId || "") === "number" ? shotOrder.get(b.shotId || "") : Number.MAX_SAFE_INTEGER;
      if (shotA !== shotB) return shotA - shotB;
      return a.path.localeCompare(b.path);
    });
  const sceneTitleForDialogue = (entry) => {
    const linkedScene =
      (entry.sceneId ? sceneEntries.find((scene) => scene.id === entry.sceneId) || null : null) ||
      (entry.scenePath ? sceneByPath.get(normalizeRelativePath(entry.scenePath)) || null : null);
    return linkedScene?.title || entry.scenePath || (entry.sceneId ? "Scene" : null);
  };

  const mergedContent = mergeLegacyDialogueContent(
    canonical?.content,
    legacyEntries.map((entry) => ({
      sceneTitle: sceneTitleForDialogue(entry),
      shotTitle: entry.shotId
        ? shotEntries.find((shot) => shot.id === entry.shotId)?.title || entry.shotPath || "Shot"
        : null,
      content: entry.content,
    })),
  );

  return [{
    id: canonical.id || crypto.randomUUID(),
    title: DIALOGUE_TITLE,
    content: mergedContent,
    path: DIALOGUE_PATH,
    sceneId: null,
    scenePath: null,
    shotId: null,
    shotPath: null,
    assetRefs: mergeAssetRefs(dialogue),
    entityRefs: mergeEntityRefs(dialogue),
    suppressedRefs: mergeSuppressedRefs(dialogue),
  }];
}

async function readPromptEntries(projectDir, sceneEntries = [], beatEntries = [], shotEntries = [], projectMetadata) {
  const sceneByFolder = new Map(
    sceneEntries
      .filter((entry) => entry.kind === "scene" && entry.path)
      .map((entry) => [path.basename(entry.path, path.extname(entry.path)), entry]),
  );
  const beatById = new Map(
    beatEntries
      .filter((entry) => entry.id)
      .map((entry) => [entry.id, entry]),
  );
  const beatByPath = new Map(
    beatEntries
      .filter((entry) => entry.path)
      .map((entry) => [normalizeRelativePath(entry.path), entry]),
  );
  const shotByPath = new Map(
    shotEntries
      .filter((entry) => entry.path)
      .map((entry) => [normalizeRelativePath(entry.path), entry]),
  );
  const promptFiles = await listMarkdownFiles(projectDir, PROMPTS_FOLDER, true);
  const prompts = [];
  for (const relativePath of promptFiles) {
    const prompt = await readMarkdownEntry(projectDir, relativePath);
    const pathParts = normalizeRelativePath(relativePath).split("/");
    const sceneFolder = pathParts.length > 2 ? pathParts[1] : "";
    const inferredScene = sceneByFolder.get(sceneFolder) || null;
    const linkedShot =
      typeof prompt.meta.shotPath === "string" && prompt.meta.shotPath.trim()
        ? shotByPath.get(normalizeRelativePath(prompt.meta.shotPath)) || null
        : null;
    const linkedBeat =
      typeof prompt.meta.beatPath === "string" && prompt.meta.beatPath.trim()
        ? beatByPath.get(normalizeRelativePath(prompt.meta.beatPath)) || null
        : typeof prompt.meta.beatId === "string" && prompt.meta.beatId.trim()
          ? beatById.get(prompt.meta.beatId.trim()) || null
          : linkedShot?.beatId
            ? beatById.get(linkedShot.beatId) || null
            : null;
    const sceneLink = resolveSceneLink(prompt.meta, relativePath, sceneEntries, linkedBeat || linkedShot || inferredScene);
    prompts.push({
      prevPromptId: readPromptPrevId(prompt.meta),
      durationSec: readDurationSec(prompt.meta),
      id: prompt.id,
      title: prompt.title,
      content: prompt.content,
      path: prompt.path,
      beatId:
        typeof prompt.meta.beatId === "string" && prompt.meta.beatId.trim()
          ? prompt.meta.beatId.trim()
          : linkedBeat?.id || linkedShot?.beatId || null,
      beatPath:
        typeof prompt.meta.beatPath === "string" && prompt.meta.beatPath.trim()
          ? normalizeRelativePath(prompt.meta.beatPath)
          : linkedBeat?.path || linkedShot?.beatPath || null,
      sceneId: sceneLink.sceneId,
      scenePath: sceneLink.scenePath,
      shotId:
        typeof prompt.meta.shotId === "string" && prompt.meta.shotId.trim()
          ? prompt.meta.shotId
          : linkedShot?.id || null,
      shotPath:
        typeof prompt.meta.shotPath === "string" && prompt.meta.shotPath.trim()
          ? normalizeRelativePath(prompt.meta.shotPath)
          : linkedShot?.path || null,
      segmentCount:
        typeof prompt.meta.segmentCount === "string" && Number.isFinite(Number(prompt.meta.segmentCount))
          ? Number(prompt.meta.segmentCount)
          : null,
      segmentEndSec:
        typeof prompt.meta.segmentEndSec === "string" && Number.isFinite(Number(prompt.meta.segmentEndSec))
          ? Number(prompt.meta.segmentEndSec)
          : null,
      segmentIndex:
        typeof prompt.meta.segmentIndex === "string" && Number.isFinite(Number(prompt.meta.segmentIndex))
          ? Number(prompt.meta.segmentIndex)
          : null,
      segmentStartSec:
        typeof prompt.meta.segmentStartSec === "string" && Number.isFinite(Number(prompt.meta.segmentStartSec))
          ? Number(prompt.meta.segmentStartSec)
          : null,
      // Parent prompt id when this prompt is a sub-prompt — used when
      // a beat needs more than the 15s ceiling and is split into
      // multiple chunks. Null/missing for top-level prompts (the
      // common case). The renderer + agent both read this to group
      // sub-prompts under their parent.
      parentPromptId:
        typeof prompt.meta.parentPromptId === "string" && prompt.meta.parentPromptId.trim()
          ? prompt.meta.parentPromptId.trim()
          : null,
      assetRefs: extractLegacyAssetRefs(prompt.meta),
      entityRefs: extractEntityRefs(prompt.meta, projectMetadata),
      suppressedRefs: normalizeSuppressedRefs(prompt.meta?.suppressedRefs),
      // Video take ids rendered from this prompt, in generation order.
      // Stored in the markdown frontmatter as `renders: [id, id, ...]`.
      // Dangling ids (VideoEntry deleted) are tolerated — the renderer
      // ignores unknown ids rather than the normalizer stripping them,
      // so a temporarily-missing file doesn't lose its render slot.
      renders: Array.isArray(prompt.meta?.renders)
        ? prompt.meta.renders
            .filter((id) => typeof id === "string" && id.trim().length > 0)
            .map((id) => id.trim())
        : [],
      readinessOverride: parsePromptReadinessOverrideMeta(prompt.meta),
    });
  }
  return sortPromptEntriesByStoryOrder(prompts, { scenes: sceneEntries });
}

function buildProjectIndex(project) {
  const rawScenes = Array.isArray(project?.script)
    ? project.script.filter((entry) => entry.kind === "scene")
    : [];
  const masterScript = Array.isArray(project?.script)
    ? project.script.find((entry) => entry.kind === "master") || null
    : null;
  const scenes = sortSceneEntriesByScriptOrder(
    rawScenes,
    masterScript ? [masterScript] : [],
  );
  const prompts = sortPromptEntriesByStoryOrder(
    Array.isArray(project?.prompts) ? project.prompts : [],
    { scenes },
  );

  return {
    story: Array.isArray(project?.story)
      ? project.story.map((entry) => ({
          contextGroup: normalizeStoryContextGroup(entry.contextGroup),
          id: entry.id,
          path: entry.path,
          title: entry.title,
        }))
      : [],
    masterScript: masterScript
      ? {
          id: masterScript.id,
          path: masterScript.path,
          title: masterScript.title,
        }
      : null,
    scenes: scenes.map((entry) => ({
      durationSec:
        typeof entry.durationSec === "number" && Number.isFinite(entry.durationSec)
          ? entry.durationSec
          : null,
      id: entry.id,
      path: entry.path,
      title: entry.title,
    })),
    beats: [],
    shots: [],
    dialogue: Array.isArray(project?.dialogue)
      ? project.dialogue.map((entry) => ({
          id: entry.id,
          path: entry.path,
          sceneId: entry.sceneId,
          scenePath: entry.scenePath || null,
          shotId: entry.shotId,
          shotPath: entry.shotPath || null,
          title: entry.title,
        }))
      : [],
    prompts: prompts.map((entry) => ({
      prevPromptId: entry.prevPromptId || null,
      durationSec: entry.durationSec,
      id: entry.id,
      path: entry.path,
      beatId: entry.beatId || null,
      beatPath: entry.beatPath || null,
      sceneId: entry.sceneId,
      scenePath: entry.scenePath || null,
      segmentCount: entry.segmentCount,
      segmentEndSec: entry.segmentEndSec,
      segmentIndex: entry.segmentIndex,
      segmentStartSec: entry.segmentStartSec,
      shotId: entry.shotId,
      shotPath: entry.shotPath || null,
      title: entry.title,
    })),
    assets: {
      library: Array.isArray(project?.library)
        ? project.library.map((entry) => ({ id: entry.id, name: entry.name }))
        : [],
      characters: Array.isArray(project?.characters)
        ? project.characters.map((entry) => ({ id: entry.id, name: entry.name }))
        : [],
      locations: Array.isArray(project?.locations)
        ? project.locations.map((entry) => ({ id: entry.id, name: entry.name }))
        : [],
      props: Array.isArray(project?.props)
        ? project.props.map((entry) => ({ id: entry.id, name: entry.name }))
        : [],
      keyframes: Array.isArray(project?.keyframes)
        ? project.keyframes.map((entry) => ({ id: entry.id, name: entry.name }))
        : [],
      audio: Array.isArray(project?.audio)
        ? project.audio.map((entry) => ({ id: entry.id, name: entry.name }))
        : [],
    },
    customSections: Array.isArray(project?.customSubsections)
      ? project.customSubsections.map((sub) => ({
          id: sub.id,
          primary: sub.primary,
          name: sub.name,
          kind: sub.kind,
          folder: sub.folder,
          instructionsPath: sub.instructionsPath,
          path: sub.instructionsPath || sub.folder,
          fileExtensions: Array.isArray(sub.fileExtensions) ? sub.fileExtensions : [],
        }))
      : [],
  };
}

async function writeIndex(projectDir, project) {
  await ensureProjectDirectories(projectDir);
  await fs.writeFile(
    path.join(projectDir, APP_FOLDER, INDEX_FILE),
    JSON.stringify(buildProjectIndex(project), null, 2),
    "utf8",
  );
}

function mergeProjectContent(metadata, content, secrets = emptyProjectSecrets()) {
  const hasExplicitProviderRegistry = metadata?.settings?.__apiProvidersExplicit === true;
  const legacyEvolinkApiKey = hasExplicitProviderRegistry ? "" : secrets.evolinkApiKey || "";
  const mediaKeysMap = (() => {
    if (hasExplicitProviderRegistry) return {};
    const map = { ...(secrets.mediaKeys || {}) };
    const legacy = legacyEvolinkApiKey;
    if (legacy) {
      for (const cap of ["image", "video", "music"]) {
        if (!map[cap]) map[cap] = legacy;
      }
    }
    return map;
  })();
  const apiProviders = mergeApiProviders({
    diskProviders: Array.isArray(metadata?.settings?.apiProviders) ? metadata.settings.apiProviders : [],
    hasExplicitProviderRegistry,
    providerKeys: secrets.providerKeys || {},
    legacyEvolinkApiKey,
    legacyMediaKeys: mediaKeysMap,
    legacyMediaModels: metadata?.settings?.mediaModels || {},
  });
  const merged = {
    ...metadata,
    jobs: content.jobs || [],
    magicDocs: content.magicDocs || [],
    story: content.story,
    script: content.script,
    beats: content.beats || [],
    shots: content.shots,
    dialogue: content.dialogue || [],
    prompts: content.prompts,
    settings: {
      ...metadata.settings,
      hookToken: secrets.hookToken || "",
      remoteAgentToken: "",
      remoteAgentTokenSaved: Boolean(secrets.remoteAgentToken),
      methodServerToken: secrets.methodServerToken || "",
      protectedAnvilToken: secrets.protectedAnvilToken || "",
      apiKey: "",
      evolinkApiKey: hasExplicitProviderRegistry ? "" : secrets.evolinkApiKey || "",
      apiKeys: {},
      mediaKeys: mediaKeysMap,
      apiProviders,
    },
  };
  return merged;
}

// Build the in-memory apiProviders array from disk metadata + decrypted
// keys + legacy fields. The seeded "evolink" entry guarantees existing
// EvoLink users see at least one provider in the registry without
// requiring an explicit migration step.
function mergeApiProviders({
  diskProviders,
  hasExplicitProviderRegistry = false,
  providerKeys,
  legacyEvolinkApiKey,
  legacyMediaKeys,
  legacyMediaModels,
}) {
  const out = [];
  const seen = new Set();
  for (const entry of diskProviders) {
    if (!entry || typeof entry !== "object") continue;
    const id = String(entry.id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const apiKey = providerKeys && typeof providerKeys[id] === "string" ? providerKeys[id] : "";
    const capabilities = normalizeProviderCapabilities(entry);
    out.push({
      id,
      label: typeof entry.label === "string" ? entry.label : id,
      capability: primaryProviderCapability(capabilities),
      capabilities,
      endpoint: typeof entry.endpoint === "string" ? entry.endpoint : undefined,
      apiKey,
      envVar: typeof entry.envVar === "string" ? entry.envVar : undefined,
      defaultModel: typeof entry.defaultModel === "string" ? entry.defaultModel : undefined,
      docs: typeof entry.docs === "string" ? entry.docs : undefined,
      notes: typeof entry.notes === "string" ? entry.notes : undefined,
      createdAt: typeof entry.createdAt === "string" ? entry.createdAt : new Date().toISOString(),
      updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : new Date().toISOString(),
    });
  }
  // Auto-seed the legacy EvoLink entry on first migration. Only adds it
  // if (a) we have a legacy key to map and (b) no entry with id "evolink"
  // exists already.
  if (!hasExplicitProviderRegistry && !seen.has("evolink") && (legacyEvolinkApiKey || Object.values(legacyMediaKeys || {}).some(Boolean))) {
    const now = new Date().toISOString();
    const seededKey = legacyEvolinkApiKey || legacyMediaKeys?.image || legacyMediaKeys?.video || "";
    out.unshift({
      id: "evolink",
      label: "EvoLink",
      capability: "image",
      capabilities: ["image", "video", "music"],
      endpoint: "https://api.evolink.ai",
      apiKey: seededKey,
      envVar: "EVOLINK_API_KEY",
      defaultModel: legacyMediaModels?.image || "gemini-3-pro-image-preview",
      docs:
        "EvoLink — generate_image, generate_video. Capability tags: image, video, music. The seedance-prompting and model-quirks skills cover prompt structure and per-model gotchas.",
      notes: "Auto-migrated from legacy mediaKeys + evolinkApiKey on 2026-04-26.",
      createdAt: now,
      updatedAt: now,
    });
  }
  return out;
}

function hasLegacyTextArrays(project) {
  return (
    Array.isArray(project?.script) ||
    Array.isArray(project?.shots) ||
    Array.isArray(project?.prompts)
  );
}

function legacySceneEntries(project) {
  return Array.isArray(project?.script)
    ? project.script.map((item, index) => ({
        durationSec:
          typeof item?.durationSec === "number" && Number.isFinite(item.durationSec)
            ? item.durationSec
            : null,
        id: item?.id || crypto.randomUUID(),
        kind: "scene",
        title:
          typeof item?.title === "string" && item.title.trim()
            ? item.title
            : `Scene ${index + 1}`,
        content: typeof item?.content === "string" ? item.content : "",
        path: "",
      }))
    : [];
}

function legacyPromptEntries(project) {
  return Array.isArray(project?.prompts)
    ? project.prompts.map((item, index) => ({
        prevPromptId: readPromptPrevId(item),
        durationSec:
          typeof item?.durationSec === "number" && Number.isFinite(item.durationSec)
            ? item.durationSec
            : null,
        id: item?.id || crypto.randomUUID(),
        title:
          typeof item?.title === "string" && item.title.trim()
            ? item.title
            : `Prompt ${index + 1}`,
        content: typeof item?.content === "string" ? item.content : "",
        path: "",
        beatId: typeof item?.beatId === "string" ? item.beatId : null,
        beatPath: typeof item?.beatPath === "string" ? normalizeRelativePath(item.beatPath) : null,
        sceneId: null,
        scenePath: null,
        segmentCount:
          typeof item?.segmentCount === "number" && Number.isFinite(item.segmentCount)
            ? item.segmentCount
            : null,
        segmentEndSec:
          typeof item?.segmentEndSec === "number" && Number.isFinite(item.segmentEndSec)
            ? item.segmentEndSec
            : null,
        segmentIndex:
          typeof item?.segmentIndex === "number" && Number.isFinite(item.segmentIndex)
            ? item.segmentIndex
            : null,
        segmentStartSec:
          typeof item?.segmentStartSec === "number" && Number.isFinite(item.segmentStartSec)
            ? item.segmentStartSec
            : null,
        shotId: null,
        shotPath: null,
        readinessOverride: normalizePromptReadinessOverride(item?.readinessOverride),
      }))
    : [];
}

function ensureUniqueRelativePath(candidate, usedPaths, entryId) {
  const normalized = normalizeRelativePath(candidate);
  if (!usedPaths.has(normalized)) {
    usedPaths.add(normalized);
    return normalized;
  }

  const extension = path.extname(normalized) || ".md";
  const baseWithoutExt = normalized.slice(0, -extension.length);
  const fallback = `${baseWithoutExt}-${String(entryId || "").slice(0, 6) || crypto.randomUUID().slice(0, 6)}${extension}`;
  usedPaths.add(fallback);
  return fallback;
}

async function writeMarkdownEntry(projectDir, relativePath, entry, extraMeta = {}) {
  const absolutePath = resolveProjectRelativePath(projectDir, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(
    absolutePath,
    serializeMarkdownDocument({
      title: entry.title,
      content: entry.content,
      meta: {
        id: entry.id,
        ...serializeEntityRefsMeta(entry.entityRefs, entry.assetRefs),
        ...serializeSuppressedRefsMeta(entry.suppressedRefs),
        ...extraMeta,
      },
    }),
    "utf8",
  );
  return normalizeRelativePath(relativePath);
}

async function writeCoreContent(projectDir, project) {
  await ensureProjectScaffold(projectDir);
  const usedPaths = new Set();

  const story = [];
  const incomingStoryEntries = Array.isArray(project?.story)
    ? project.story.filter((entry) => !LEGACY_STORY_DOC_PATHS.has(normalizeRelativePath(entry?.path)))
    : [];
  const storyEntries = incomingStoryEntries.length
    ? incomingStoryEntries
    : STORY_DEFAULTS.map((entry) => ({
        contextGroup: entry.contextGroup || "canon",
        id: crypto.randomUUID(),
        kind: "story",
        path: entry.path,
        title: entry.title,
        content: "",
      }));
  for (const [index, entry] of storyEntries.entries()) {
    const relativePath =
      normalizeRelativePath(entry.path) ||
      STORY_DEFAULTS[index]?.path ||
      `${STORY_FOLDER}/${slugifyName(entry.title || `story-${index + 1}`)}.md`;
    const savedPath = ensureUniqueRelativePath(relativePath, usedPaths, entry.id);
    const contextGroup = storyContextGroupForPath(savedPath, entry.contextGroup);
    const title = storyTitleForPath(savedPath, entry.title);
    await writeMarkdownEntry(projectDir, savedPath, { ...entry, title }, { contextGroup });
    story.push({
      contextGroup,
      id: entry.id,
      kind: "story",
      path: savedPath,
      title,
      content: entry.content,
    });
  }

  const scriptInput = Array.isArray(project?.script) ? project.script : [];
  const masterPath = `${MASTER_SCRIPT_FOLDER}/${MASTER_SCRIPT_FILE}`;
  // Multi-script: persist EVERY kind="master" entry (Master Script +
  // any secondary scripts the user has created — trailer, episode 2,
  // etc.). Each lives at its own path; missing files get scaffolded
  // here. Master Script is guaranteed to exist for legacy single-film
  // projects so existing flows don't break.
  const masterEntries = scriptInput.filter((entry) => entry.kind === "master");
  if (!masterEntries.some((entry) => normalizeRelativePath(entry.path) === masterPath)) {
    masterEntries.unshift({
      id: crypto.randomUUID(),
      kind: "master",
      path: masterPath,
      title: "Master Script",
      content: "",
    });
  }
  for (const masterEntry of masterEntries) {
    const entryPath = normalizeRelativePath(masterEntry.path) || masterPath;
    if (usedPaths.has(entryPath)) continue;
    usedPaths.add(entryPath);
    await writeMarkdownEntry(projectDir, entryPath, masterEntry, {
      durationSec:
        typeof masterEntry.durationSec === "number" && Number.isFinite(masterEntry.durationSec)
          ? masterEntry.durationSec
          : "",
    });
  }
  const scenes = [];
  const sceneEntries = scriptInput.filter((entry) => entry.kind === "scene");
  for (const [index, entry] of sceneEntries.entries()) {
    const candidatePath =
      normalizeRelativePath(entry.path) ||
      `${SCENES_FOLDER}/scene-${String(index + 1).padStart(2, "0")}-${slugifyName(entry.title)}.md`;
    const savedPath = ensureUniqueRelativePath(candidatePath, usedPaths, entry.id);
    await writeMarkdownEntry(projectDir, savedPath, entry, {
      // Persist the link to the parent script (a kind="master" entry's
      // path). Missing parent stays missing on disk → re-loaded scene
      // is treated as belonging to Master Script (legacy single-film
      // semantics).
      ...(typeof entry.parentScriptPath === "string" && entry.parentScriptPath.trim()
        ? { parentScriptPath: normalizeRelativePath(entry.parentScriptPath.trim()) }
        : {}),
      durationSec:
        typeof entry.durationSec === "number" && Number.isFinite(entry.durationSec)
          ? entry.durationSec
          : "",
      sceneOrder:
        typeof entry.sceneOrder === "number" && Number.isFinite(entry.sceneOrder)
          ? entry.sceneOrder
          : "",
    });
    scenes.push({
      durationSec:
        typeof entry.durationSec === "number" && Number.isFinite(entry.durationSec)
          ? entry.durationSec
          : null,
      id: entry.id,
      kind: "scene",
      path: savedPath,
      sceneOrder:
        typeof entry.sceneOrder === "number" && Number.isFinite(entry.sceneOrder)
          ? entry.sceneOrder
          : null,
      title: entry.title,
      content: entry.content,
      ...(typeof entry.parentScriptPath === "string" && entry.parentScriptPath.trim()
        ? { parentScriptPath: normalizeRelativePath(entry.parentScriptPath.trim()) }
        : {}),
    });
  }
  const script = [
    // All kind="master" entries (Master Script + secondaries) followed
    // by the scenes. masterEntries was already deduped + ordered above.
    ...masterEntries.map((entry) => ({
      id: entry.id,
      kind: "master",
      path: normalizeRelativePath(entry.path) || masterPath,
      title: entry.title,
      content: entry.content,
      ...(typeof entry.durationSec === "number" && Number.isFinite(entry.durationSec)
        ? { durationSec: entry.durationSec }
        : {}),
    })),
    ...scenes,
  ];

  const sceneMap = new Map(scenes.map((scene) => [scene.id, scene]));
  const sceneByPath = new Map(scenes.map((scene) => [normalizeRelativePath(scene.path), scene]));
  const sceneByFolder = new Map(
    scenes.map((scene) => [
      path.basename(normalizeRelativePath(scene.path), path.extname(normalizeRelativePath(scene.path))),
      scene,
    ]),
  );
  // Beats and shots tiers were retired in cut #1 (phase 2). writeCoreContent
  // no longer materializes either array; project.beats / project.shots
  // arriving in the in-memory project are silently dropped (they're empty
  // for new projects since the tools that would have populated them are
  // gone, and orphan-cleanup further down sweeps stale files on disk).
  const beats = [];
  const shots = [];

  const dialogue = [];
  const dialogueEntries = Array.isArray(project?.dialogue) ? project.dialogue : [];
  for (const entry of dialogueEntries.slice(0, 1)) {
    const savedPath = ensureUniqueRelativePath(
      normalizeRelativePath(entry.path) || DIALOGUE_PATH,
      usedPaths,
      entry.id,
    );
    await writeMarkdownEntry(projectDir, savedPath, entry, {
      sceneId: "",
      scenePath: "",
      shotId: "",
      shotPath: "",
    });
    dialogue.push({
      id: entry.id,
      title: entry.title || DIALOGUE_TITLE,
      content: entry.content,
      path: savedPath,
      sceneId: null,
      scenePath: null,
      shotId: null,
      shotPath: null,
    });
  }
  const prompts = [];
  const promptCounts = new Map();
  const promptEntries = Array.isArray(project?.prompts) ? project.prompts : [];
  for (const entry of promptEntries) {
    const normalizedPromptPath = normalizeRelativePath(entry.path);
    const promptPathParts = normalizedPromptPath.split("/");
    const promptSceneFolder =
      promptPathParts[0] === PROMPTS_FOLDER && promptPathParts.length > 2
        ? promptPathParts[1]
        : "";
    const normalizedEntryScenePath = normalizeRelativePath(entry.scenePath);
    const linkedScene =
      (entry.sceneId ? sceneMap.get(entry.sceneId) || null : null) ||
      (normalizedEntryScenePath ? sceneByPath.get(normalizedEntryScenePath) || null : null) ||
      (promptSceneFolder ? sceneByFolder.get(promptSceneFolder) || null : null) ||
      scenes[0] ||
      null;
    const sceneId = linkedScene?.id || entry.sceneId || null;
    const scenePath = linkedScene?.path || entry.scenePath || null;
    // Beat/shot fields are vestigial after cut #1 phase 1 (the agent
    // tools that wrote them are gone). We preserve any legacy values
    // already on the entry for tolerant round-trip on existing projects,
    // but new prompts created by create_prompt don't carry them.
    const beatId = entry.beatId || null;
    const beatPath = entry.beatPath || null;
    const shotId = entry.shotId || null;
    const shotPath = entry.shotPath || null;
    const sceneFolder =
      linkedScene?.path
        ? path.basename(linkedScene.path, path.extname(linkedScene.path))
        : "unassigned";
    const order = (promptCounts.get(sceneFolder) || 0) + 1;
    promptCounts.set(sceneFolder, order);
    const candidatePath =
      normalizedPromptPath ||
      `${PROMPTS_FOLDER}/${sceneFolder}/prompt-${String(order).padStart(2, "0")}-${slugifyName(entry.title)}.md`;
    const savedPath = ensureUniqueRelativePath(candidatePath, usedPaths, entry.id);
    await writeMarkdownEntry(projectDir, savedPath, entry, {
      ...prevIdToMeta(readPromptPrevId(entry)),
      ...serializePromptReadinessOverrideMeta(entry.readinessOverride),
      durationSec:
        typeof entry.durationSec === "number" && Number.isFinite(entry.durationSec)
          ? entry.durationSec
          : "",
      beatId: beatId || "",
      beatPath: beatPath || "",
      sceneId: sceneId || "",
      scenePath: scenePath || "",
      segmentCount:
        typeof entry.segmentCount === "number" && Number.isFinite(entry.segmentCount)
          ? entry.segmentCount
          : "",
      segmentEndSec:
        typeof entry.segmentEndSec === "number" && Number.isFinite(entry.segmentEndSec)
          ? entry.segmentEndSec
          : "",
      segmentIndex:
        typeof entry.segmentIndex === "number" && Number.isFinite(entry.segmentIndex)
          ? entry.segmentIndex
          : "",
      segmentStartSec:
        typeof entry.segmentStartSec === "number" && Number.isFinite(entry.segmentStartSec)
          ? entry.segmentStartSec
          : "",
      shotId: shotId || "",
      shotPath: shotPath || "",
      renders: Array.isArray(entry.renders)
        ? JSON.stringify(entry.renders.filter((id) => typeof id === "string" && id.trim()))
        : "",
    });
    prompts.push({
      prevPromptId: readPromptPrevId(entry),
      durationSec:
        typeof entry.durationSec === "number" && Number.isFinite(entry.durationSec)
          ? entry.durationSec
          : null,
      id: entry.id,
      path: savedPath,
      title: entry.title,
      content: entry.content,
      beatId,
      beatPath,
      sceneId,
      scenePath,
      segmentCount:
        typeof entry.segmentCount === "number" && Number.isFinite(entry.segmentCount)
          ? entry.segmentCount
          : null,
      segmentEndSec:
        typeof entry.segmentEndSec === "number" && Number.isFinite(entry.segmentEndSec)
          ? entry.segmentEndSec
          : null,
      segmentIndex:
        typeof entry.segmentIndex === "number" && Number.isFinite(entry.segmentIndex)
          ? entry.segmentIndex
          : null,
      segmentStartSec:
        typeof entry.segmentStartSec === "number" && Number.isFinite(entry.segmentStartSec)
          ? entry.segmentStartSec
          : null,
      shotId,
      shotPath,
      renders: Array.isArray(entry.renders)
        ? entry.renders.filter((id) => typeof id === "string" && id.trim())
        : [],
      readinessOverride: normalizePromptReadinessOverride(entry.readinessOverride),
    });
  }

  // ────────────────────────────────────────────────────────────────
  // Orphan cleanup — THE delete-doesn't-stick bug root cause.
  //
  // writeCoreContent writes markdown files for every entry in the
  // in-memory project. But readProject reconstitutes prompts/shots/
  // scenes/story by SCANNING the filesystem (listMarkdownFiles → map
  // them into entries). If we remove an entry from the in-memory
  // array but leave its .md file on disk, the next readProject (which
  // happens at the end of writeProject, the save roundtrip) will pick
  // up the orphan and re-add it — the deleted item "pops back."
  //
  // Similarly, when we rename an entry (e.g. splitting a prompt
  // changes its title + path), the OLD file at the original path is
  // left orphaned with the same id → two disk entries with identical
  // ids. Symptom: split creates "3 parts" where 2 were expected.
  //
  // Fix: after writing everything, scan each content folder and
  // delete .md files that aren't in the usedPaths set. Scoped to the
  // content folders only (story/, script/, scenes/, prompts/) — never
  // touches .forge/, assets/, or anything else.
  //
  // beats/ and shots/ are intentionally excluded from the sweep: cut #1
  // (phase 2) retired those tiers, but legacy projects may still have
  // files in those folders the user hasn't cleaned up. Skipping them
  // here keeps "open old project, save with no script changes" from
  // silently nuking their legacy planning files.
  // ────────────────────────────────────────────────────────────────
  const CONTENT_ROOTS = [STORY_FOLDER, MASTER_SCRIPT_FOLDER, DIALOGUE_FOLDER, SCENES_FOLDER, PROMPTS_FOLDER];
  // Secondary scripts (customSubsections with kind="script") live at
  // script/<slug>.md — peers to master-script.md. They aren't tracked in
  // project.script[], so without this they'd get unlinked by the orphan
  // sweep below on every save.
  if (Array.isArray(project?.customSubsections)) {
    for (const sub of project.customSubsections) {
      if (sub?.kind !== "script") continue;
      const rel = normalizeRelativePath(sub.instructionsPath || "");
      if (rel) usedPaths.add(rel);
    }
  }
  async function collectMarkdownPathsUnder(root) {
    const results = [];
    async function walk(relativeDir) {
      const abs = path.join(projectDir, relativeDir);
      let entries;
      try {
        entries = await fs.readdir(abs, { withFileTypes: true });
      } catch (error) {
        if (error?.code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        const childRel = normalizeRelativePath(path.join(relativeDir, entry.name));
        if (entry.isDirectory()) {
          await walk(childRel);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
          results.push(childRel);
        }
      }
    }
    await walk(root);
    return results;
  }
  // Cleanup is unconditional. An earlier draft skipped recently-modified
  // orphans as a "concurrent agent write" safety, but that reintroduced
  // the pop-back bug for just-created segments (delete a segment right
  // after splitting → its file mtime is recent → cleanup skipped → next
  // readProject re-hydrates it → delete undone). If a concurrent agent
  // write ever becomes a real problem, route its tool calls through a
  // save-suppression latch rather than mtime heuristics.
  for (const root of CONTENT_ROOTS) {
    const onDisk = await collectMarkdownPathsUnder(root);
    for (const diskPath of onDisk) {
      if (usedPaths.has(diskPath)) continue;
      try {
        await fs.unlink(path.join(projectDir, diskPath));
      } catch (error) {
        if (error?.code !== "ENOENT") {
          debugLog("writeCoreContent: failed to unlink orphan", { path: diskPath, error: error?.message });
        }
      }
    }
  }

  return {
    story,
    script,
    beats,
    shots,
    dialogue,
    prompts,
  };
}

async function migrateLegacyProjectIfNeeded(projectDir, project) {
  const metadata = normalizeProjectMetadata(project, project?.project?.name, projectDir);
  if (!hasLegacyTextArrays(project)) {
    return metadata;
  }

  await ensureProjectScaffold(projectDir);
  const legacyProject = {
    ...metadata,
    story: STORY_DEFAULTS.map((entry) => ({
      contextGroup: entry.contextGroup || "canon",
      id: crypto.randomUUID(),
      kind: "story",
      path: entry.path,
      title: entry.title,
      content: "",
    })),
    script: [
      {
        id: crypto.randomUUID(),
        kind: "master",
        path: `${MASTER_SCRIPT_FOLDER}/${MASTER_SCRIPT_FILE}`,
        title: "Master Script",
        content: "",
      },
      ...legacySceneEntries(project),
    ],
    beats: [],
    shots: [],
    prompts: legacyPromptEntries(project),
  };

  const content = await writeCoreContent(projectDir, legacyProject);
  const diskMetadata = {
    ...prepareProjectForDisk(projectDir, metadata),
    project: {
      ...metadata.project,
      updatedAt: new Date().toISOString(),
    },
  };
  await fs.writeFile(projectFilePath(projectDir), JSON.stringify(diskMetadata, null, 2), "utf8");
  await writeIndex(
    projectDir,
    mergeProjectContent(withFileUrls(projectDir, diskMetadata), content, emptyProjectSecrets()),
  );
  return metadata;
}

// Atomic-safe write for project.json: serialize, validate parseability, copy
// current → .bak, then temp → current. Keep the live file in place until the
// final atomic rename; otherwise concurrent reads can briefly see ENOENT and
// surface a false "No Forge project exists" error.
async function atomicWriteProjectJson(projectDir, metadata) {
  const file = projectFilePath(projectDir);
  const payload = JSON.stringify(metadata, null, 2);
  // Validate we can parse what we just serialized (guards against circular
  // refs / bad serializers leaking non-JSON values).
  try {
    JSON.parse(payload);
  } catch (error) {
    throw new Error(
      `atomicWriteProjectJson: refusing to write unparseable JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const bakFile = `${file}.bak`;
  // Snapshot current → .bak (best-effort; missing on first write is fine).
  try {
    await fs.copyFile(file, bakFile);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  // Use shared atomicWriteFile (unique-tmp + rename) so concurrent writers
  // don't ENOENT each other's rename. The withWriteLock in writeProject()
  // serializes per-project on the renderer-IPC path; tools coordinate with
  // it via the same key (see system/tools/builtins.cjs writeProjectMetadata
  // — both share lock key `project:${projectDir}`).
  await atomicWriteFile(file, payload);
}

async function readProject(projectDir, options = {}) {
  // Wrap the read-modify-write transaction in the same project lock the
  // renderer/tool write paths use, so a concurrent scan_media tool write
  // can't race the syncAssetDirectoryFiles / syncLibraryDirectoryFiles
  // / syncVideoDirectoryFiles pass and lose changes. Pre-fix (review H2,
  // 2026-05-04): readProject called atomicWriteProjectJson directly with
  // no lock; concurrent with writeProjectMetadata (which DOES lock) could
  // clobber tool writes.
  //
  // The one re-entrant caller — writeProjectInner at the bottom of its own
  // critical section — passes { skipLock: true } so we don't deadlock on
  // the same key we already hold.
  if (options.skipLock) {
    return readProjectInner(projectDir);
  }
  return withWriteLock(`project:${projectDir}`, () => readProjectInner(projectDir));
}

async function readProjectInner(projectDir) {
  await ensureProjectScaffold(projectDir);
  const file = projectFilePath(projectDir);
  const raw = await fs.readFile(file, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // project.json is corrupt. Try to recover from .bak before giving up.
    const bakPath = `${file}.bak`;
    try {
      const bakRaw = await fs.readFile(bakPath, "utf8");
      parsed = JSON.parse(bakRaw);
      // Restore the bak as the live file so subsequent writes are clean.
      await fs.writeFile(file, bakRaw, "utf8");
      debugLog("readProject: recovered project.json from .bak", { projectDir });
    } catch {
      const snippet = String(raw || "").slice(0, 400).replace(/\s+/g, " ");
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Cannot open project — .forge/project.json is corrupt (${msg}). No backup available. Open the file and fix the JSON manually. First 400 chars: ${snippet}`,
      );
    }
  }
  const migratedMetadata = await migrateLegacyProjectIfNeeded(projectDir, parsed);
  if (migratedMetadata?.settings) {
    Object.defineProperty(migratedMetadata.settings, "__apiProvidersExplicit", {
      value: Array.isArray(parsed?.settings?.apiProviders),
      enumerable: false,
      configurable: true,
    });
  }
  const repairedMetadata = await repairAssetMediaFiles(projectDir, migratedMetadata);
  const syncedMetadata = await syncAssetDirectoryFiles(projectDir, repairedMetadata.project);
  const syncedLibraryMetadata = await syncLibraryDirectoryFiles(projectDir, syncedMetadata.project);
  if (repairedMetadata.changed || syncedMetadata.changed || syncedLibraryMetadata.changed) {
    await atomicWriteProjectJson(
      projectDir,
      prepareProjectForDisk(projectDir, syncedLibraryMetadata.project),
    );
  }
  const metadata = withFileUrls(projectDir, syncedLibraryMetadata.project);
  if (metadata?.settings) {
    Object.defineProperty(metadata.settings, "__apiProvidersExplicit", {
      value: Array.isArray(parsed?.settings?.apiProviders),
      enumerable: false,
      configurable: true,
    });
  }
  const secrets = await loadProjectSecrets(projectDir);
  const content = {
    magicDocs: await magicDocs.listMagicDocs(projectDir),
    story: await readStoryEntries(projectDir),
    script: await readScriptEntries(projectDir, metadata),
  };
  // Beats and shots tiers were retired in cut #1. We pass empty arrays
  // so the legacy `(projectDir, sceneEntries, beatEntries, shotEntries)`
  // signatures of readDialogueEntries / readPromptEntries keep working
  // without touching their internals.
  content.beats = [];
  content.shots = [];
  content.dialogue = await readDialogueEntries(projectDir, content.script, content.shots, metadata);
  content.prompts = await readPromptEntries(projectDir, content.script, content.beats, content.shots, metadata);
  const metadataWithUsage = attachAssetUsages(metadata, [
    ...content.script.filter((entry) => entry.kind === "scene").map((entry) => ({ ...entry, entrySection: "script" })),
    ...content.dialogue.map((entry) => ({ ...entry, entrySection: "dialogue" })),
    ...content.prompts.map((entry) => ({ ...entry, entrySection: "prompts" })),
  ]);
  const merged = mergeProjectContent(metadataWithUsage, content, secrets);
  // Pick up orphan video files dropped into assets/videos/ and drop
  // VideoEntry records whose files vanished. Runs after the merge so
  // script/beats/shots/prompts are fresh and slug→id resolution works.
  const syncedVideos = await syncVideoDirectoryFiles(projectDir, merged);
  if (syncedVideos.changed) {
    await atomicWriteProjectJson(
      projectDir,
      prepareProjectForDisk(projectDir, syncedVideos.project),
    );
  }
  const projectWithVideos = syncedVideos.changed ? syncedVideos.project : merged;
  // Pull project-tier defaults (cascade resolver tier 4). Optional file —
  // missing/corrupt is treated as empty defaults; the resolver tolerates
  // any subset.
  let projectDefaults;
  try {
    projectDefaults = await require("./project-defaults.cjs").readProjectDefaults(projectDir);
  } catch (error) {
    debugLog("project-defaults: read failed", { error: error?.message });
    projectDefaults = { scene: {}, shot: {}, prompt: {} };
  }
  const finalProject = { ...projectWithVideos, defaults: projectDefaults };
  await writeIndex(projectDir, finalProject);
  try {
    await assetManifest.writeAssetManifest(projectDir, finalProject);
  } catch (error) {
    debugLog("asset-manifest: write failed", error);
  }
  return finalProject;
}

// Per-project write serialization. Two rapid saveProject calls (renderer
// debounce firing twice back-to-back, or IPC handler concurrent with an
// agent tool write) used to race at the read-modify-write boundary —
// both reading project.json at roughly the same time, then each
// overwriting with a partial merge of the other's state. The atomic
// tmp→rename made each individual write safe, but the round-trip could
// still clobber.
//
// Uses the shared withWriteLock keyed on `project:${projectDir}` so this
// renderer-IPC path coordinates with tool writes that go through
// system/tools/builtins.cjs:writeProjectMetadata (uses the same lock key).
// Without that coordination, a renderer save racing with an agent
// create_asset_entry would both run unserialized; pre-fix this was the
// project.json analogue of the pinboard C1 race.
async function writeProject(projectDir, project, options = {}) {
  return withWriteLock(`project:${projectDir}`, () =>
    writeProjectInner(projectDir, project, options),
  );
}

async function writeProjectInner(projectDir, project, options = {}) {
  await ensureProjectScaffold(projectDir);
  if (options.persistSecrets) {
    // Pull provider apiKey values out of settings.apiProviders[] into the
    // encrypted secrets blob, keyed by provider id. project.json itself
    // never carries the cleartext key (prepareProjectForDisk strips it).
    const providerKeys = {};
    if (Array.isArray(project?.settings?.apiProviders)) {
      for (const entry of project.settings.apiProviders) {
        if (!entry || typeof entry !== "object") continue;
        const id = String(entry.id || "").trim();
        if (!id) continue;
        const key = typeof entry.apiKey === "string" ? entry.apiKey.trim() : "";
        if (key) providerKeys[id] = key;
      }
    }
    await saveProjectSecrets(projectDir, {
      hookToken: typeof project?.settings?.hookToken === "string" ? project.settings.hookToken : "",
      remoteAgentToken:
        typeof project?.settings?.remoteAgentToken === "string"
          ? project.settings.remoteAgentToken
          : "",
      remoteAgentTokenSaved: project?.settings?.remoteAgentTokenSaved === true,
      methodServerToken:
        typeof project?.settings?.methodServerToken === "string"
          ? project.settings.methodServerToken
          : "",
      protectedAnvilToken:
        typeof project?.settings?.protectedAnvilToken === "string"
          ? project.settings.protectedAnvilToken
          : "",
      evolinkApiKey: typeof project?.settings?.evolinkApiKey === "string" ? project.settings.evolinkApiKey : "",
      mediaKeys:
        project?.settings?.mediaKeys && typeof project.settings.mediaKeys === "object"
          ? project.settings.mediaKeys
          : {},
      providerKeys,
    });
    // Mirror non-secret agent settings so a new/older project inherits
    // the same provider/model/endpoint without the user re-configuring
    // per-project. Only writes when a real value is set — blank
    // inputs don't clobber prior defaults.
    const s = project?.settings || {};
    const nextDefaults = {
      ...cachedAppAgentDefaults,
    };
    nextDefaults.agentProvider = normalizeAgentProvider(s.agentProvider);
    nextDefaults.agentModel = "";
    nextDefaults.customAgentEndpoint = "";
    nextDefaults.agentApprovalMode = normalizeAgentApprovalMode(s.agentApprovalMode);
    nextDefaults.agentBypassPermissions = nextDefaults.agentApprovalMode === "autonomous";
    nextDefaults.agentMediaStaging = normalizeAgentMediaStaging(s.agentMediaStaging);
    if (typeof s.agentBinPath === "string" && s.agentBinPath.trim()) {
      nextDefaults.agentBinPath = s.agentBinPath;
    }
    if (s.mediaMode === "per" || s.mediaMode === "one") {
      nextDefaults.mediaMode = s.mediaMode;
    }
    if (s.mediaModels && typeof s.mediaModels === "object") {
      const merged = { ...(cachedAppAgentDefaults.mediaModels || {}) };
      for (const key of ["image", "video", "music", "voice"]) {
        if (typeof s.mediaModels[key] === "string" && s.mediaModels[key].trim()) {
          merged[key] = s.mediaModels[key];
        }
      }
      nextDefaults.mediaModels = merged;
    }
    await saveAppAgentDefaults(nextDefaults);
  }
  const diskProject = prepareProjectForDisk(projectDir, project);
  const nextMetadata = {
    ...diskProject,
    project: {
      ...diskProject.project,
      updatedAt: new Date().toISOString(),
    },
  };
  await writeCoreContent(projectDir, project);
  await atomicWriteProjectJson(projectDir, nextMetadata);
  // Re-read from disk to guarantee the returned state + index matches
  // what's actually on disk. This prevents the desync where the renderer
  // sends partial data (e.g. missing script entries) and the index gets
  // built from that partial state instead of the real files.
  // skipLock — we are already inside withWriteLock(`project:${projectDir}`)
  // via the writeProject wrapper at the top of this critical section; the
  // re-entrant readProject call must not try to acquire the same lock
  // again or it'll deadlock against itself (review H2, 2026-05-04).
  const refreshed = await readProject(projectDir, { skipLock: true });
  return refreshed;
}

async function readChatHistory(projectDir, sessionKey) {
  const file = chatHistoryPath(projectDir, sessionKey);
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const INTERNAL_CHAT_LINE_PATTERNS = [
  /\b(system|developer)[\s_-]+prompt\b/i,
  /\b(system|developer)[\s_-]+message\b/i,
  /\binternal (agent )?(instruction|detail|context|prompt)s?\b/i,
  /\bhidden (agent )?(instruction|detail|context|prompt)s?\b/i,
  /\bresponse protocol\b/i,
  /\btool[\s_-]?calls?\b/i,
  /\btool[\s_-]?results?\b/i,
  /\bfunction calls?\b/i,
  /\bavailable[\s_-]?tools?\b/i,
  /\btools?:\s*$/i,
  /\bstable preamble\b/i,
  /\bdynamic project state\b/i,
  /\bcurrent selection:\b/i,
  /\bfocus lock\b/i,
  /\byou are (forge|anvil)['’]?s local project agent\b/i,
  /\bjson envelope\b/i,
  /\bagent loop\b/i,
  /\bprompt caching\b/i,
  /\b(prompt|model)[\s_-]?distillation\b/i,
  /\b(reverse[-\s]?engineer|clone|recreate|replicate|rebuild)\b.*\b(forge|anvil|this app|desktop app)\b/i,
  /\b(forge|anvil|this app|desktop app)\b.*\b(source code|implementation detail|internal architecture|tool schema)\b/i,
  /"tool_calls"\s*:/i,
  /"system_prompt"\s*:/i,
  /"developer"\s*:/i,
];

function sanitizeVisibleChatText(text) {
  const raw = String(text || "").replace(/\s+$/g, "");
  if (!raw) return raw;

  const kept = [];
  let redacted = false;
  let redactingFence = false;
  let redactNextFence = false;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    const fenceStart = /^```/.test(trimmed);
    const looksInternal = INTERNAL_CHAT_LINE_PATTERNS.some((pattern) => pattern.test(trimmed));

    if (redactingFence) {
      redacted = true;
      if (fenceStart) redactingFence = false;
      continue;
    }

    if (redactNextFence && fenceStart) {
      redacted = true;
      redactingFence = true;
      redactNextFence = false;
      continue;
    }

    if (looksInternal) {
      redacted = true;
      if (fenceStart) redactingFence = true;
      redactNextFence = true;
      continue;
    }

    if (trimmed) redactNextFence = false;
    kept.push(line);
  }

  const visible = kept.join("\n").trim();
  if (visible) return visible;
  return redacted ? "Done." : raw;
}

function commandChatTextForTarget(hammerAction, target) {
  const targetLabel = target && typeof target.label === "string" ? target.label.trim() : "";
  if (targetLabel) return targetLabel;
  return String(hammerAction || "Agent action").trim() || "Agent action";
}

let cachedPublicMutatingToolNames = null;
function publicMutatingToolNames() {
  if (cachedPublicMutatingToolNames) return cachedPublicMutatingToolNames;
  try {
    cachedPublicMutatingToolNames = require("./system/tools/builtins.cjs").listMutatingToolNames();
  } catch {
    cachedPublicMutatingToolNames = new Set();
  }
  return cachedPublicMutatingToolNames;
}

function publicToolArgs(name, args) {
  void name;
  void args;
  return {};
}

function publicToolName(name) {
  const raw = String(name || "");
  if (raw.startsWith("generate_")) return "generate_media";
  if (raw.includes("magic_doc")) return "update_context";
  if (raw.includes("pinboard") || raw.includes("memory")) return "update_memory";
  if (raw.includes("asset") || raw.includes("media") || raw.includes("library")) return "update_assets";
  if (raw.includes("scene") || raw.includes("shot") || raw.includes("prompt") || raw.includes("dialogue")) {
    return "update_script";
  }
  if (raw.includes("read") || raw.includes("list") || raw.includes("search") || raw.includes("inspect")) {
    return "read_project";
  }
  if (raw.includes("write") || raw.includes("edit") || raw.includes("rename") || raw.includes("delete")) {
    return "apply_edits";
  }
  return "work_step";
}

function publicToolResultSummary(name, result) {
  if (!result || typeof result !== "object") return {};
  const r = result;
  if (name === "read_file") return { summary: `${Number(r.size) || 0} chars` };
  if (name === "read_many_files") return { summary: `${Array.isArray(r.files) ? r.files.length : 0} files` };
  if (name === "write_file") return { summary: `${Number(r.bytesWritten) || 0} bytes` };
  if (name === "edit_file") return { summary: `${Number(r.replacements) || 0} replaced` };
  if (name === "list_dir") return { summary: `${Array.isArray(r.entries) ? r.entries.length : 0} entries` };
  if (name === "get_project_index") {
    const counts = r.counts && typeof r.counts === "object" ? r.counts : {};
    return { summary: `${Number(counts.scenes) || 0} scenes` };
  }
  if (name === "list_assets") {
    const total = Object.values(r)
      .filter((value) => Array.isArray(value))
      .reduce((sum, value) => sum + value.length, 0);
    return { summary: `${total} assets` };
  }
  if (name === "normalize_asset_media_names") return { summary: `${Number(r.count) || 0} renamed` };
  if (name === "search") return { summary: `${Array.isArray(r.matches) ? r.matches.length : 0} matches` };
  return {};
}

function sanitizeAgentToolCallForRenderer(call) {
  if (!call || typeof call !== "object") {
    return { id: randomUUID(), name: "work_step", args: {}, mutating: false };
  }
  const name = typeof call.name === "string" && call.name.trim() ? call.name.trim() : "unknown";
  return {
    id: typeof call.id === "string" && call.id ? call.id : randomUUID(),
    name: publicToolName(name),
    args: publicToolArgs(name, call.args),
    mutating: publicMutatingToolNames().has(name),
  };
}

function sanitizeAgentToolResultForRenderer(result, name) {
  const ok = Boolean(result?.ok);
  return {
    id: typeof result?.id === "string" && result.id ? result.id : randomUUID(),
    name: typeof result?.name === "string" && result.name ? result.name : name,
    ok,
    ...(ok ? {} : { error: "failed" }),
    result: ok ? publicToolResultSummary(name, result?.result) : {},
  };
}

function sanitizeAgentEventForRenderer(agentEvent) {
  if (!agentEvent || typeof agentEvent !== "object") return null;
  if (agentEvent.type === "tool:call") {
    return {
      type: "tool:call",
      turn: Number(agentEvent.turn) || 0,
      call: sanitizeAgentToolCallForRenderer(agentEvent.call),
    };
  }
  if (agentEvent.type === "tool:result") {
    const call = sanitizeAgentToolCallForRenderer(agentEvent.call);
    const originalName =
      agentEvent.call && typeof agentEvent.call.name === "string" && agentEvent.call.name.trim()
        ? agentEvent.call.name.trim()
        : call.name;
    return {
      type: "tool:result",
      turn: Number(agentEvent.turn) || 0,
      call,
      result: sanitizeAgentToolResultForRenderer(agentEvent.result, originalName),
    };
  }
  if (agentEvent.type === "reply:preview") {
    return {
      type: "reply:preview",
      turn: Number(agentEvent.turn) || 0,
      reply: sanitizeVisibleChatText(agentEvent.reply),
    };
  }
  if (agentEvent.type === "phase") {
    return { type: "phase", phase: agentEvent.phase };
  }
  return null;
}

function sanitizeAgentMetaForRenderer(meta) {
  if (!meta || typeof meta !== "object") return null;
  return {
    transport: meta.transport === "hook" || meta.transport === "cli" ? meta.transport : "cli",
    provider: typeof meta.provider === "string" ? meta.provider : undefined,
    model: typeof meta.model === "string" ? meta.model : undefined,
    routeTransport: typeof meta.routeTransport === "string" ? meta.routeTransport : undefined,
    capability: typeof meta.capability === "string" ? meta.capability : undefined,
    attempts: Number.isFinite(Number(meta.attempts)) ? Number(meta.attempts) : undefined,
    fallbackFrom: meta.fallbackFrom === "hook" ? "hook" : undefined,
  };
}

function sanitizeAgentRunResultForRenderer(result) {
  const turns = Array.isArray(result?.turns) ? result.turns : [];
  return {
    reply: sanitizeVisibleChatText(result?.reply || ""),
    actions: [],
    turnCount: turns.length,
    terminated: typeof result?.terminated === "string" ? result.terminated : "done",
    meta: sanitizeAgentMetaForRenderer(result?.meta),
  };
}

const METHOD_PHASES = {
  scope_intake: "intake",
  context_build: "context",
  master_script: "script",
  scene_prompt_plan: "script_prompts",
  reference_images: "references",
  storyboard_sheets: "storyboards",
  video_sequence: "video",
  continuity_audit: "critique",
  timeline_assembly: "timeline",
};

function normalizeMethodIdForPhase(value) {
  const text = String(value || "").trim();
  return Object.prototype.hasOwnProperty.call(METHOD_PHASES, text) ? text : "";
}

function inferMethodIdFromAgentTurn(payload, _projectShape) {
  const explicitMethodId = normalizeMethodIdForPhase(payload?.methodId || payload?.context?.methodId);
  if (explicitMethodId) {
    return explicitMethodId;
  }
  const text = String(payload?.message || "").toLowerCase();
  if (/\b(timeline|assemble|arrange|sequence the clips|put .* timeline)\b/.test(text)) {
    return "timeline_assembly";
  }
  if (/\b(audit|critique|repair|fix continuity|continuity check|quality check|review takes)\b/.test(text)) {
    return "continuity_audit";
  }
  if (/\b(video|generate clips?|render|ordered renders?|sequence render|take 0?1|seedance)\b/.test(text)) {
    return "video_sequence";
  }
  if (/\b(storyboard|story board|sheet|first frame|keyframe)\b/.test(text)) {
    return "storyboard_sheets";
  }
  if (/\b(reference|character image|location image|prop image|product image|bind|identity)\b/.test(text)) {
    return "reference_images";
  }
  if (/\b(prompt|prompts|shot plan|shots|scene plan|scenes)\b/.test(text)) {
    return "scene_prompt_plan";
  }
  if (/\b(master script|write script|rewrite script|screenplay|script)\b/.test(text)) {
    return "master_script";
  }
  if (/\b(context|world bible|canon|anvil\.md|project rules)\b/.test(text)) {
    return "context_build";
  }
  if (/\b(new project|start|intake|scope|premise|runtime|format|aspect ratio|tone)\b/.test(text)) {
    return "scope_intake";
  }

  // File counts do not select a production step in the public sample.
  return "scope_intake";
}

function collectMethodSelectionPaths(payload) {
  const paths = [];
  const add = (value) => {
    if (typeof value !== "string") return;
    const clean = value.trim();
    if (!clean || clean.includes("\0")) return;
    if (path.isAbsolute(clean)) return;
    if (clean.startsWith("../") || clean === "..") return;
    if (!paths.includes(clean)) paths.push(clean);
  };

  add(payload?.context?.selection?.path);
  const focusLock = payload?.context?.focusLock;
  if (focusLock && typeof focusLock === "object") {
    add(focusLock.path);
    add(focusLock.scenePath);
    add(focusLock.shotPath);
  } else {
    add(focusLock);
  }
  for (const attachment of Array.isArray(payload?.context?.attachments) ? payload.context.attachments : []) {
    add(attachment?.path);
  }
  return paths.slice(0, 12);
}

function buildMethodDirectiveRequest({ payload, projectDir, projectShape }) {
  const methodId = inferMethodIdFromAgentTurn(payload, projectShape);
  const context = payload?.context && typeof payload.context === "object" ? payload.context : {};
  const project = context.project && typeof context.project === "object" ? context.project : {};
  const intent = context.intent && typeof context.intent === "object" ? context.intent : {};
  return {
    methodId,
    projectId: String(project.id || path.basename(projectDir) || "local-project").slice(0, 160),
    appVersion: ANVIL_VERSION.build
      ? `${ANVIL_VERSION.version}+${ANVIL_VERSION.build}`
      : ANVIL_VERSION.version,
    phase: METHOD_PHASES[methodId] || methodId,
    selection: {
      paths: collectMethodSelectionPaths(payload),
      intent: typeof intent.id === "string" ? intent.id : undefined,
      activeSceneId: context.selection?.sceneId || context.selection?.itemId || undefined,
    },
    contextSummary: {
      projectName: String(project.name || "").slice(0, 160),
      scenes: Number(projectShape?.scenes || 0),
      shots: Number(projectShape?.shots || 0),
      prompts: Number(projectShape?.prompts || 0),
      assets: Number(projectShape?.assets || 0),
      targetRuntimeSec: Number(projectShape?.masterTargetSec || 0) || undefined,
      scenesActualSec: Number(projectShape?.scenesActualSec || 0) || undefined,
      promptsOverCap: Number(projectShape?.promptsOverCap || 0) || undefined,
    },
  };
}

// Normalize persisted chat history into the {role, content} shape the
// agent loop expects. The renderer saves entries as {role, text,
// timestamp, ...} so we accept either `content` or `text`, drop
// anything that isn't a user/assistant turn with real content, and
// strip the most-recent user entry if it is the current optimistic
// send. Hammer actions are intentionally displayed as compact labels
// in chat, so they cannot string-match the full command prompt.
async function loadAgentPriorTurns(projectDir, sessionKey, currentMessage) {
  const raw = await readChatHistory(projectDir, sessionKey);
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const normalized = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const role = entry.role === "user" || entry.role === "assistant" ? entry.role : null;
    if (!role) continue;
    const target = entry.target && typeof entry.target === "object" ? entry.target : null;
    const hammerAction = typeof entry.hammerAction === "string" && entry.hammerAction.trim()
      ? entry.hammerAction.trim()
      : "";
    const contentRaw =
      typeof entry.content === "string" && entry.content.trim()
        ? entry.content
        : typeof entry.text === "string" && entry.text.trim()
          ? entry.text
          : "";
    if (!contentRaw) continue;
    const content = role === "assistant"
      ? sanitizeVisibleChatText(contentRaw)
      : hammerAction
        ? commandChatTextForTarget(hammerAction, target)
        : contentRaw;
    if (!content) continue;
    const guardedContent =
      role === "user" && detectDistillationRequest(content).blocked
        ? REDACTED_EXTRACTION_TURN
        : content;
    normalized.push({ role, content: guardedContent, hammerAction });
  }
  const currentTrimmed = typeof currentMessage === "string" ? currentMessage.trim() : "";
  if (
    currentTrimmed &&
    normalized.length > 0 &&
    normalized[normalized.length - 1].role === "user" &&
    (
      normalized[normalized.length - 1].content.trim() === currentTrimmed ||
      normalized[normalized.length - 1].hammerAction
    )
  ) {
    normalized.pop();
  }
  return normalized.map((entry) => ({ role: entry.role, content: entry.content }));
}

// Sweep any orphaned in-progress placeholders left over from a previous
// session where the renderer died mid-request (window close, hard
// reload, crash). The renderer appends {state: "pending"} /
// {state: "queued"} assistant bubbles BEFORE calling ask-agent and
// autosaves every 250ms. If it never got the chance to transition
// them to ready/error, they stick on disk and render with a
// working-state spinner forever on reopen. Called on every
// forge:load-chat-history IPC — a fresh renderer instance has no
// in-flight agent calls for this session yet, so it's always safe
// to flip stale entries here.
async function reconcileChatHistoryOnLoad(projectDir, sessionKey) {
  const entries = await readChatHistory(projectDir, sessionKey);
  if (!Array.isArray(entries) || entries.length === 0) return entries || [];
  let changed = false;
  const reconciled = entries.map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    if (entry.role !== "assistant") return entry;
    if (entry.state !== "pending" && entry.state !== "queued") return entry;
    changed = true;
    return {
      ...entry,
      state: "error",
      text:
        typeof entry.text === "string" && entry.text.trim()
          ? entry.text
          : "Interrupted — the previous session ended before this reply finished. Please retry.",
      meta: {
        ...(entry.meta && typeof entry.meta === "object" ? entry.meta : {}),
        interrupted: true,
      },
    };
  });
  if (changed) {
    try {
      await writeChatHistory(projectDir, sessionKey, reconciled);
    } catch {
      // Non-fatal: if the write fails we still return the reconciled
      // view to the renderer so it doesn't show a spinner.
    }
  }
  return reconciled;
}

function sanitizeChatHistoryEntryForDisk(entry) {
  if (!entry || typeof entry !== "object") return null;
  const role = entry.role === "assistant" ? "assistant" : entry.role === "user" ? "user" : "";
  if (!role) return null;
  const target = entry.target && typeof entry.target === "object" ? entry.target : null;
  const hammerAction = typeof entry.hammerAction === "string" && entry.hammerAction.trim()
    ? entry.hammerAction.trim()
    : "";
  const rawText = String(entry.text || "").trimEnd();
  const text = role === "user" && hammerAction
    ? commandChatTextForTarget(hammerAction, target)
    : role === "assistant"
      ? sanitizeVisibleChatText(rawText)
      : rawText;
  const out = {
    id: typeof entry.id === "string" && entry.id ? entry.id : randomUUID(),
    role,
    text,
    timestamp:
      typeof entry.timestamp === "string" && entry.timestamp
        ? entry.timestamp
        : new Date().toISOString(),
    target,
    state:
      entry.state === "pending" || entry.state === "queued" || entry.state === "error"
        ? entry.state
        : "ready",
  };
  if (hammerAction) out.hammerAction = hammerAction;
  if (Array.isArray(entry.attachments) && entry.attachments.length > 0) {
    out.attachments = entry.attachments;
  }
  return out;
}

async function writeChatHistory(projectDir, sessionKey, history) {
  await ensureProjectDirectories(projectDir);
  const file = chatHistoryPath(projectDir, sessionKey);
  const safeHistory = Array.isArray(history)
    ? history.map(sanitizeChatHistoryEntryForDisk).filter(Boolean)
    : [];
  await fs.writeFile(file, JSON.stringify(safeHistory, null, 2), "utf8");
}

async function createProjectAtDirectory(projectDir, name) {
  await fs.mkdir(projectDir, { recursive: true });
  await ensureProjectScaffold(projectDir);
  try {
    await require("./project-context.cjs").ensureProjectContext(projectDir, name);
  } catch {}
  const data = createEmptyProject(name);
  const saved = await writeProject(projectDir, {
    ...data,
    story: STORY_DEFAULTS.map((entry) => ({
      contextGroup: entry.contextGroup || "canon",
      id: crypto.randomUUID(),
      kind: "story",
      path: entry.path,
      title: entry.title,
      content: "",
    })),
    script: [
      {
        id: crypto.randomUUID(),
        kind: "master",
        path: `${MASTER_SCRIPT_FOLDER}/${MASTER_SCRIPT_FILE}`,
        title: "Master Script",
        content: "",
      },
    ],
    dialogue: [],
    beats: [],
    shots: [],
    prompts: [],
  });
  await rememberRecentProject(projectDir, saved.project.name);
  return { projectDir, project: saved };
}

async function openProjectAtDirectory(projectDir) {
  const file = projectFilePath(projectDir);
  try {
    await fs.access(projectDir);
  } catch {
    throw new Error("Project folder no longer exists.");
  }
  try {
    await fs.access(file);
  } catch {
    throw new Error("No Forge project exists in this folder.");
  }
  // Job reconciliation on startup was removed alongside the jobs
  // queue — nothing left to reconcile.
  return { projectDir, project: await readProject(projectDir) };
}

function clampSeedanceClipDuration(value) {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration <= 0) return 15;
  return Math.max(5, Math.min(15, Math.round(duration)));
}

async function buildPromptRenderBundle(projectDir, promptId) {
  let bundle = await tools.runTool("build_render_bundle", { promptId }, { projectDir });
  if (bundle?.ok === false && bundle.reason === "keyframe-not-extracted" && bundle.prevTakeId) {
    await tools.runTool("extract_frame", { videoId: bundle.prevTakeId, position: "last" }, { projectDir });
    bundle = await tools.runTool("build_render_bundle", { promptId }, { projectDir });
  }
  if (!bundle || bundle.ok === false) {
    throw new Error(bundle?.error || "Generate prompt: could not build render bundle.");
  }
  return bundle;
}

async function generateVideoForPrompt(projectDir, promptId) {
  const targetDir = requireProjectDir(projectDir, "Generate prompt: project path is required.");
  const targetPromptId = String(promptId || "").trim();
  if (!targetPromptId) {
    throw new Error("Generate prompt: prompt id is required.");
  }

  const project = await readProject(targetDir);
  const prompt = Array.isArray(project?.prompts)
    ? project.prompts.find((entry) => entry.id === targetPromptId) || null
    : null;
  if (!prompt) {
    throw new Error("Generate prompt: prompt not found.");
  }
  const promptText = String(prompt.content || "").trim();
  if (!promptText) {
    throw new Error("Generate prompt: write the prompt first.");
  }

  const bundle = await buildPromptRenderBundle(targetDir, targetPromptId);
  const durationSec = clampSeedanceClipDuration(bundle.duration || prompt.durationSec);
  const toolResult = await tools.runTool(
    "generate_video",
    {
      prompt: bundle.text || promptText,
      promptId: targetPromptId,
      durationSec,
      aspectRatio: prompt.aspectRatio || project?.defaults?.prompt?.aspectRatio || "16:9",
      note: bundle.startFrame
        ? `Continuity start frame cached locally at ${bundle.startFrame}.`
        : "",
    },
    {
      projectDir: targetDir,
      settings: project.settings || {},
      emitInboxEvent: makeInboxEventEmitter(targetDir),
      emitTimelineEvent: makeTimelineEventEmitter(targetDir),
    },
  );
  await tools.runTool("refresh_project_index", {}, { projectDir: targetDir });
  invalidateAgentMagicDocSummary(targetDir);
  return {
    ok: true,
    bundle: {
      startFrame: bundle.startFrame || null,
      startFrameSource: bundle.startFrameSource || null,
      referenceCount: Array.isArray(bundle.references) ? bundle.references.length : 0,
      durationSec,
    },
    result: toolResult,
    project: await openProjectAtDirectory(targetDir),
  };
}

async function bindGeneratedLibraryMedia(projectDir, entityId, savedPaths) {
  const cleanId = String(entityId || "").trim();
  if (!cleanId || !Array.isArray(savedPaths) || !savedPaths.length) {
    return { bound: false, mediaCount: 0 };
  }

  const project = await readProject(projectDir);
  const entries = Array.isArray(project?.library) ? project.library : [];
  const index = entries.findIndex((entry) => entry?.id === cleanId);
  if (index < 0) {
    return { bound: false, mediaCount: 0 };
  }

  const existingMedia = Array.isArray(entries[index].media) ? entries[index].media : [];
  const existingPaths = new Set(
    existingMedia.map((media) => normalizeRelativePath(media?.path || "")).filter(Boolean),
  );
  const additions = savedPaths
    .map((entry) => normalizeRelativePath(entry?.path || ""))
    .filter((relativePath) => relativePath && !existingPaths.has(relativePath))
    .map((relativePath) => ({
      id: randomUUID(),
      kind: "image",
      label: path.posix.basename(relativePath),
      path: relativePath,
    }));

  if (!additions.length) {
    return { bound: false, mediaCount: 0 };
  }

  const nextProject = {
    ...project,
    library: [
      ...entries.slice(0, index),
      {
        ...entries[index],
        media: [...existingMedia, ...additions],
      },
      ...entries.slice(index + 1),
    ],
    project: {
      ...(project.project || {}),
      updatedAt: new Date().toISOString(),
    },
  };
  await writeProject(projectDir, nextProject);
  return { bound: true, mediaCount: additions.length };
}

async function generateAssetImage(projectDir, payload = {}) {
  const targetDir = requireProjectDir(projectDir, "Generate image: project path is required.");
  const prompt = String(payload?.prompt || "").trim();
  if (!prompt) {
    throw new Error("Generate image: write an image prompt first.");
  }

  const assetSection = String(payload?.assetSection || "library").trim();
  if (!["library", "characters", "locations", "props", "keyframes"].includes(assetSection)) {
    throw new Error("Generate image: choose characters, locations, props, keyframes, or library.");
  }

  const entityId = String(payload?.entityId || "").trim();
  if (assetSection !== "library" && !entityId) {
    throw new Error("Generate image: target asset id is required.");
  }

  const project = await readProject(targetDir);
  let toolResult = await tools.runTool(
    "generate_image",
    {
      prompt,
      assetSection,
      entityId: entityId || undefined,
      delivery: "direct",
      assetName: String(payload?.assetName || "").trim() || undefined,
      size: String(payload?.size || "").trim() || "auto",
      quality: String(payload?.quality || "").trim() || "2K",
    },
    {
      projectDir: targetDir,
      settings: project.settings || {},
      emitInboxEvent: makeInboxEventEmitter(targetDir),
    },
  );

  if (assetSection === "library" && entityId) {
    const saved = Array.isArray(toolResult?.saved) ? toolResult.saved : [];
    const binding = await bindGeneratedLibraryMedia(targetDir, entityId, saved);
    if (binding.bound) {
      toolResult = {
        ...toolResult,
        binding,
        message: `Saved and added ${binding.mediaCount} image${binding.mediaCount === 1 ? "" : "s"} to this media card.`,
      };
    }
  }

  await tools.runTool("refresh_project_index", {}, { projectDir: targetDir });
  invalidateAgentMagicDocSummary(targetDir);
  return {
    ok: true,
    result: toolResult,
    project: await openProjectAtDirectory(targetDir),
  };
}

const windowProjectWatchers = new Map();

function stopWatchingProject(webContentsId) {
  const state = windowProjectWatchers.get(webContentsId);
  if (!state) {
    return;
  }
  if (state.timer) {
    clearTimeout(state.timer);
  }
  state.watcher.close();
  windowProjectWatchers.delete(webContentsId);
}

function revealWindow(win) {
  if (!win || win.isDestroyed()) {
    return null;
  }
  if (win.isMinimized()) {
    win.restore();
  }
  if (!win.isVisible()) {
    win.show();
  }
  win.focus();
  return win;
}

function getExistingMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow;
  }
  const existing = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed()) || null;
  mainWindow = existing;
  return existing;
}

function startWatchingProject(webContents, projectDir) {
  const rootDir = path.resolve(projectDir);
  const existing = windowProjectWatchers.get(webContents.id);
  if (existing?.projectDir === rootDir) {
    return;
  }

  stopWatchingProject(webContents.id);

  const watcher = nodeFs.watch(
    rootDir,
    { recursive: true },
    (_eventType, filename) => {
      const relativePath = normalizeRelativePath(filename || "");
      if (!relativePath) return;
      // Ignore most .forge/ derived state. project.json remains the source
      // of truth, while magic/ and jobs/ are intentionally surfaced back to
      // the renderer as standing project state.
      if (relativePath.startsWith(`${APP_FOLDER}/`)) {
        if (
          relativePath !== `${APP_FOLDER}/${PROJECT_FILE}` &&
          !relativePath.startsWith(`${APP_FOLDER}/jobs/`) &&
          !relativePath.startsWith(`${APP_FOLDER}/magic/`)
        ) {
          return;
        }
      }

      const state = windowProjectWatchers.get(webContents.id);
      if (!state) {
        return;
      }

      // Inbox-only fast path: surfacing assets/inbox/ changes through the
      // generic project-changed channel works but waits a debounce + a
      // full project reload. Push a targeted inbox-event so the inbox
      // view refreshes its list immediately when an agent or chat upload
      // drops a file.
      if (relativePath.startsWith("assets/inbox/")) {
        broadcastInboxEvent(rootDir, { kind: "files-changed" });
      }

      if (state.timer) {
        clearTimeout(state.timer);
      }

      state.timer = setTimeout(() => {
        invalidateAgentMagicDocSummary(rootDir);
        if (!webContents.isDestroyed()) {
          webContents.send("forge:project-changed");
        }
      }, WATCH_DEBOUNCE_MS);
    },
  );

  windowProjectWatchers.set(webContents.id, {
    projectDir: rootDir,
    timer: null,
    watcher,
    webContents,
  });
}

// Broadcast a single timeline event to every open window that's watching
// the given projectDir. Used by mutating timeline tools to push granular
// updates to the renderer the moment they commit — the renderer reduces
// the event into local NLE state in one frame instead of waiting for the
// full project.json reload (which fires later via the disk watcher and
// remains the safety net for desync). Cheap: just an IPC send per
// matching webContents.
function broadcastTimelineEvent(projectDir, event) {
  if (!projectDir || !event || typeof event !== "object" || !event.kind) return;
  const stamped = { ...event, projectDir, ts: event.ts || new Date().toISOString() };
  for (const state of windowProjectWatchers.values()) {
    if (!state || state.projectDir !== projectDir) continue;
    const wc = state.webContents;
    if (wc && !wc.isDestroyed()) {
      wc.send("forge:timeline-event", stamped);
    }
  }
}

function makeTimelineEventEmitter(projectDir) {
  return (event) => {
    try {
      broadcastTimelineEvent(projectDir, event);
    } catch (error) {
      debugLog("emitTimelineEvent failed", { error: error?.message });
    }
  };
}

// Inbox event channel — used for two distinct things:
//   1. Filesystem changes inside assets/inbox/ (renderer refreshes its
//      inbox file list without polling).
//   2. Built-in generation tool lifecycle (job-started / job-completed /
//      job-failed) so the inbox view can render an in-flight tile.
function broadcastInboxEvent(projectDir, event) {
  if (!projectDir || !event || typeof event !== "object" || !event.kind) return;
  const stamped = { ...event, ts: event.ts || new Date().toISOString() };
  for (const state of windowProjectWatchers.values()) {
    if (!state || state.projectDir !== projectDir) continue;
    const wc = state.webContents;
    if (wc && !wc.isDestroyed()) {
      wc.send("forge:inbox-event", stamped);
    }
  }
}

function makeInboxEventEmitter(projectDir) {
  return (event) => {
    try {
      broadcastInboxEvent(projectDir, event);
    } catch (error) {
      debugLog("emitInboxEvent failed", { error: error?.message });
    }
  };
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1540,
    height: 980,
    minWidth: 1200,
    minHeight: 760,
    backgroundColor: "#0b0e12",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      contextIsolation: true,
      devTools: !app.isPackaged,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
      // Chromium's default autoplay policy ("document-user-activation-
      // required") lets <video> frames advance without a gesture but
      // silently mutes the audio output. Anvil's timeline preview calls
      // el.play() from a useEffect AFTER the click handler returns +
      // after el.load() resets the element's user-activation token, so
      // by the time play() actually runs the gesture is gone — frames
      // play, audio is dead. Setting this to no-gesture-required is
      // appropriate for a desktop creative app: the user opened the
      // window themselves, every action is intentional. Without this
      // the timeline plays generated takes silently with no UI to fix.
      autoplayPolicy: "no-user-gesture-required",
    }
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173";
  const packagedUrl = pathToFileURL(path.join(__dirname, "..", "dist", "index.html")).toString();
  const startupProjectDir = launchProjectDir();
  const targetUrl = (() => {
    const baseUrl = app.isPackaged
      ? pathToFileURL(path.join(__dirname, "..", "dist", "index.html")).toString()
      : devUrl;

    if (!startupProjectDir) {
      return baseUrl;
    }

    const url = new URL(baseUrl);
    url.searchParams.set("projectDir", startupProjectDir);
    return url.toString();
  })();
  let showingRendererFallback = false;
  const showRendererFallback = (title, detail) => {
    if (showingRendererFallback || win.isDestroyed()) return;
    showingRendererFallback = true;
    setTimeout(() => {
      if (win.isDestroyed()) return;
      win.loadURL(rendererFallbackUrl(title, detail)).catch((error) => {
        appendRendererDiagnostic("fallback-load-failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }, 50);
  };

  if (!app.isPackaged) {
    debugLog("loading dev url", targetUrl);
    win.loadURL(targetUrl);
  } else {
    debugLog("loading packaged file", path.join(__dirname, "..", "dist", "index.html"));
    win.loadURL(targetUrl);
  }

  win.webContents.on("did-start-loading", () => {
    debugLog("did-start-loading");
  });
  win.webContents.on("did-stop-loading", () => {
    debugLog("did-stop-loading", win.webContents.getURL());
  });
  win.webContents.on("did-finish-load", () => {
    debugLog("did-finish-load", win.webContents.getURL());
  });
  win.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      appendRendererDiagnostic("did-fail-load", {
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame,
      });
      debugLog("did-fail-load", {
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame
      });
      if (isMainFrame && !String(validatedURL || "").startsWith("data:text/html")) {
        showRendererFallback(
          "The renderer failed to load",
          `${errorDescription || "Unknown load error"} (${errorCode}).`,
        );
      }
    },
  );
  win.webContents.on("preload-error", (_event, preloadPath, error) => {
    const message = error instanceof Error ? error.message : String(error);
    appendRendererDiagnostic("preload-error", { preloadPath, message });
    showRendererFallback("The desktop bridge failed to load", message);
  });
  win.webContents.on("console-message", (event) => {
    // Electron 40+ uses a single event object; positional (_event, level, message, line, sourceId) is deprecated.
    if (event?.level === "error" || event?.level === 3) {
      appendRendererDiagnostic("console-error", {
        level: event?.level,
        message: event?.message,
        line: event?.lineNumber,
        sourceId: event?.sourceId,
      });
    }
    debugLog("console-message", {
      level: event?.level,
      message: event?.message,
      line: event?.lineNumber,
      sourceId: event?.sourceId,
    });
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    appendRendererDiagnostic("render-process-gone", details);
    debugLog("render-process-gone", details);
    showRendererFallback(
      "The renderer process crashed",
      `Reason: ${details?.reason || "unknown"}. Exit code: ${details?.exitCode ?? "unknown"}.`,
    );
  });

  if (DEBUG_DUMP_RENDERER || DEBUG_CAPTURE_PATH || DEBUG_SMOKE_OPENCLAW) {
    win.webContents.on("did-finish-load", () => {
      setTimeout(async () => {
        try {
          if (DEBUG_DUMP_RENDERER) {
            const snapshot = await win.webContents.executeJavaScript(
              `({
                url: window.location.href,
                title: document.title,
                bodyText: document.body.innerText,
                rootHtmlLength: document.getElementById("root")?.innerHTML.length ?? 0
              })`,
              true,
            );
            debugLog("renderer-snapshot", snapshot);
          }

          if (DEBUG_CAPTURE_PATH) {
            const image = await win.webContents.capturePage();
            await fs.writeFile(DEBUG_CAPTURE_PATH, image.toPNG());
            debugLog("captured-window", DEBUG_CAPTURE_PATH);
          }

          if (DEBUG_SMOKE_OPENCLAW) {
            const smokeResult = await win.webContents.executeJavaScript(
              `window.forgeDesktop.askAgent(
                "debug-smoke-${Date.now()}",
                {
                  hookUrl: ${JSON.stringify(DEFAULT_OPENCLAW_HOOK_URL)},
                  hookToken: ${JSON.stringify(DEBUG_HOOK_TOKEN)},
                  sessionKey: "hook:shotforge:debug-smoke"
                },
                {
                  message: "Reply with exactly FORGE_SMOKE_OK and no extra text.",
                  context: {
                    project: { id: "debug-project", name: "Forge Smoke", dir: "" },
                  }
                }
              )`,
              true,
            );
            debugLog("openclaw-smoke-result", smokeResult);
          }
        } catch (error) {
          debugLog("renderer-debug-failed", error instanceof Error ? error.message : String(error));
        }
      }, 600);
    });
  }

  const webContentsId = win.webContents.id;
  mainWindow = win;
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (showingRendererFallback && url.startsWith("data:text/html")) {
      return;
    }
    const allowedPrefix = app.isPackaged ? packagedUrl : devUrl;
    if (!url.startsWith(allowedPrefix)) {
      event.preventDefault();
    }
  });
  win.on("closed", () => {
    stopWatchingProject(webContentsId);
    disposeProjectTerminalsForWebContents(webContentsId);
    if (mainWindow === win) {
      mainWindow = null;
    }
    // Cancel any agent calls this window launched. Without this,
    // closing the window on macOS (where the app stays alive) or
    // hard-reloading the renderer left the main-process fetch
    // running until the API responded — quietly consuming tokens
    // with no receiver for the result.
    abortAllActiveAgents(new Error("Main window closed."));
  });
  return win;
}

// Final safety net — before the app quits, make sure every in-flight
// agent fetch gets cancelled so tokens don't burn past the last frame
// of UI. Paired with the window-close hook above; the window-close
// path catches macOS (where Cmd-Q doesn't always fire before-quit
// cleanly) and this catches everything else.
app.on("before-quit", () => {
  disposeAllProjectTerminals();
  if (anvilAgentGateway) {
    anvilAgentGateway.stop().catch(() => {});
  }
  abortAllActiveAgents(new Error("Anvil quitting."));
});

app.whenReady().then(async () => {
  // Warm the app-level agent defaults cache so normalizeProjectMetadata
  // (sync) can use it on the very first project open this session.
  await refreshAppAgentDefaultsCache();
  if (ENABLE_LOCAL_ANVIL_AGENT_GATEWAY) {
    await ensureAnvilAgentGatewayStarted().catch((error) => {
      console.warn(`[anvil-agent] local gateway failed to start: ${error?.message || error}`);
    });
  }

  if (process.platform === "darwin" && app.dock && typeof app.dock.setIcon === "function") {
    const iconCandidates = [
      path.join(__dirname, "..", "build", "icon.png"),
      path.join(__dirname, "..", "build", "icon-512.png"),
      path.join(__dirname, "..", "build", "icon.iconset", "icon_512x512@2x.png"),
    ];
    for (const candidate of iconCandidates) {
      try {
        app.dock.setIcon(candidate);
        break;
      } catch {}
    }
  }

  protocol.handle(ASSET_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      const decoded = url.pathname
        .split("/")
        .map((part) => {
          try {
            return decodeURIComponent(part);
          } catch {
            return part;
          }
        })
        .join("/");
      let filePath = decoded.startsWith("/") ? decoded : `/${decoded}`;
      if (process.platform === "win32" && /^\/[A-Za-z]:[\\/]/.test(filePath)) {
        filePath = filePath.slice(1);
      }
      // Forward the renderer's request headers (Range, If-Modified-Since,
      // etc.) to the underlying file fetch. Without this, the protocol
      // returns the whole file body with `200 OK` and no Range support,
      // breaking <video> streaming + seek the moment Chromium issues
      // `Range: bytes=N-M`. Symptom: bin tiles render fine (preload=
      // "metadata" only needs the moov box + first I-frame, satisfied
      // by a full-body 200) but the timeline/bin preview pane stays
      // black with silent audio because the media decoder stalls
      // waiting for partial content. Confirmed for H.264 High + AAC LC
      // takes; the pattern is general — any media file relying on
      // streaming + range seeks fails without this propagation.
      const upstream = await net.fetch(pathToFileURL(filePath).toString(), {
        headers: request.headers,
      });
      // Force-advertise Accept-Ranges: bytes on the response. Even when
      // net.fetch returns 200 OK with the full file, Chromium needs
      // this header to KNOW it can re-request specific byte ranges
      // later for seek operations. Without it, after the initial fetch
      // completes the element believes the server is not seek-capable
      // and can wedge at readyState=1 networkState=1 (idle) the moment
      // a re-seek lands on un-decoded bytes — confirmed via diagnostic
      // listeners: 738 `waiting` events stuck at the same currentTime.
      const headers = new Headers(upstream.headers);
      if (!headers.has("accept-ranges")) {
        headers.set("accept-ranges", "bytes");
      }
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    } catch {
      return new Response("", { status: 404 });
    }
  });

  ipcMain.handle("forge:create-project", async (_event, name) => {
    const displayName = String(name || "").trim() || `${APP_DISPLAY_NAME} Project`;
    const folderName = normalizeProjectFolderName(displayName);
    const result = await dialog.showOpenDialog({
      title: "Choose the parent folder for the new Forge project",
      properties: ["openDirectory", "createDirectory"]
    });
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }
    const selectedDirectory = result.filePaths[0];
    const useSelectedDirectory =
      path.basename(selectedDirectory).toLowerCase() === folderName.toLowerCase();
    const projectDir = useSelectedDirectory
      ? selectedDirectory
      : path.join(selectedDirectory, folderName);
    return createProjectAtDirectory(projectDir, displayName);
  });

  ipcMain.handle("forge:open-project", async () => {
    const result = await dialog.showOpenDialog({
      title: "Open Forge project folder",
      properties: ["openDirectory"]
    });
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }
    const projectDir = result.filePaths[0];
    const file = projectFilePath(projectDir);
    try {
      await fs.access(file);
    } catch {
      const answer = await dialog.showMessageBox({
        type: "question",
        buttons: ["Create Forge project", "Cancel"],
        defaultId: 0,
        cancelId: 1,
        message: "No Forge project exists in this folder. Create one here?"
      });
      if (answer.response !== 0) {
        return null;
      }
      return createProjectAtDirectory(projectDir, path.basename(projectDir));
    }
    const opened = await openProjectAtDirectory(projectDir);
    await rememberRecentProject(projectDir, opened.project.project.name);
    return opened;
  });

  ipcMain.handle("forge:create-project-at-path", async (_event, projectDir, name) => {
    const targetDir = requireProjectDir(projectDir);
    const displayName = String(name || "").trim() || path.basename(targetDir) || `${APP_DISPLAY_NAME} Project`;
    return createProjectAtDirectory(targetDir, displayName);
  });

  ipcMain.handle("forge:open-project-at-path", async (_event, projectDir) => {
    const targetDir = requireProjectDir(projectDir);
    return openProjectAtDirectory(targetDir);
  });

  ipcMain.handle("forge:open-recent-project", async (_event, projectDir) => {
    const targetDir = requireProjectDir(projectDir);
    const recents = sanitizeRecentProjects(cachedAppAgentDefaults.recentProjects);
    try {
      const opened = await openProjectAtDirectory(targetDir);
      await rememberRecentProject(targetDir, opened.project.project.name);
      return opened;
    } catch (error) {
      const key = recentProjectKey(targetDir);
      const nextRecents = recents.filter((entry) => recentProjectKey(entry.projectDir) !== key);
      if (nextRecents.length !== recents.length) {
        await saveAppAgentDefaults({
          ...cachedAppAgentDefaults,
          recentProjects: nextRecents,
        });
      }
      throw error;
    }
  });

  ipcMain.handle("forge:get-recent-projects", async () => {
    return listRecentProjects();
  });

  ipcMain.handle("forge:save-project", async (_event, projectDir, project) => {
    const saved = await writeProject(projectDir, project);
    invalidateAgentMagicDocSummary(projectDir);
    return saved;
  });

  ipcMain.handle("forge:list-inbox-files", async (_event, projectDir) => {
    return listInboxFiles(projectDir);
  });

  ipcMain.handle("forge:list-inbox-pending", async (_event, projectDir) => {
    return listInboxPendingJobs(projectDir);
  });

  ipcMain.handle("forge:move-inbox-to-library", async (_event, projectDir, name) => {
    return moveInboxFileToLibrary(projectDir, name);
  });

  ipcMain.handle("forge:delete-inbox-file", async (_event, projectDir, name) => {
    return deleteInboxFile(projectDir, name);
  });

  ipcMain.handle("forge:save-project-settings", async (_event, projectDir, project) => {
    const saved = await writeProject(projectDir, project, { persistSecrets: true });
    invalidateAgentMagicDocSummary(projectDir);
    try {
      const view = await buildAgentSecretsView(projectDir);
      await writeIntegrationsManifest(projectDir, view);
    } catch (err) {
      console.warn(`[integrations] post-save refresh failed: ${err?.message || err}`);
    }
    return saved;
  });

  ipcMain.handle("forge:load-chat-history", async (_event, projectDir, sessionKey) => {
    // Flip any stale pending/queued assistant entries left over from a
    // previous session that died mid-request — otherwise they render
    // with a spinner forever.
    return reconcileChatHistoryOnLoad(projectDir, sessionKey);
  });

  ipcMain.handle("forge:save-chat-history", async (_event, projectDir, sessionKey, history) => {
    await writeChatHistory(projectDir, sessionKey, history);
  });

  ipcMain.handle("forge:watch-project", async (event, projectDir) => {
    const targetDir = requireProjectDir(projectDir);
    startWatchingProject(event.sender, targetDir);
  });

  ipcMain.handle("forge:unwatch-project", async (event) => {
    stopWatchingProject(event.sender.id);
  });

  // Detach a media variant from an asset entry. The file lives at
  // assets/<section>/<file> on disk; if we just nuke the entry's
  // media[] reference, syncAssetDirectoryFiles re-attaches it on the
  // next read because the file's slug still matches the entry. Move
  // the file into assets/library/ instead — that takes it out of the
  // section's auto-bind range and lets the library sync surface it
  // in the Media panel as the tooltip promises.
  ipcMain.handle("forge:detach-asset-variant", async (_event, projectDir, section, assetId, mediaId) => {
    const targetDir = requireProjectDir(projectDir);
    if (!ASSET_SECTIONS.has(section)) {
      throw new Error(`Unsupported asset section: ${section}`);
    }
    const current = await readProject(targetDir);
    const sectionEntries = Array.isArray(current[section]) ? current[section] : [];
    const entry = sectionEntries.find((item) => item && item.id === assetId);
    if (!entry) throw new Error("Asset entry not found.");
    const media = Array.isArray(entry.media) ? entry.media.find((m) => m && m.id === mediaId) : null;
    if (!media) throw new Error("Variant not found on this asset.");

    const sourceRel = normalizeRelativePath(media.path || "");
    const sourceAbs = sourceRel ? resolveProjectRelativePath(targetDir, sourceRel) : null;
    if (sourceAbs && (await fileExists(sourceAbs))) {
      const libraryAbs = path.join(targetDir, "assets", "library");
      await fs.mkdir(libraryAbs, { recursive: true });
      const ext = path.extname(media.label || sourceAbs);
      const baseName = path.basename(media.label || sourceAbs, ext);
      const baseSlug = slugifyName(baseName || section);
      const usedNames = new Set();
      let targetName = `${baseSlug}${ext}`;
      let targetAbs = path.join(libraryAbs, targetName);
      let attempt = 1;
      while (usedNames.has(targetName) || (await fileExists(targetAbs))) {
        targetName = `${baseSlug}-${attempt}${ext}`;
        targetAbs = path.join(libraryAbs, targetName);
        attempt += 1;
      }
      try {
        await fs.rename(sourceAbs, targetAbs);
      } catch (renameErr) {
        if (renameErr && renameErr.code === "EXDEV") {
          await fs.copyFile(sourceAbs, targetAbs);
          await fs.rm(sourceAbs, { force: true });
        } else {
          throw renameErr;
        }
      }
    }

    const nextSectionEntries = sectionEntries.map((item) =>
      item && item.id === assetId
        ? { ...item, media: (Array.isArray(item.media) ? item.media : []).filter((m) => m && m.id !== mediaId) }
        : item,
    );
    const nextProject = { ...current, [section]: nextSectionEntries };
    const saved = await writeProject(targetDir, nextProject);
    invalidateAgentMagicDocSummary(targetDir);
    return saved;
  });

  ipcMain.handle("forge:upload-assets", async (_event, projectDir, section, entityId, entityName) => {
    const targetDir = requireProjectDir(projectDir);
    if (!ASSET_SECTIONS.has(section)) {
      throw new Error(`Unsupported asset section: ${section}`);
    }

    const filters = section === "audio"
      ? [{ name: "MP3 Audio", extensions: ["mp3"] }]
      : [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }];
    const result = await dialog.showOpenDialog({
      title: "Select asset files",
      properties: ["openFile", "multiSelections"],
      filters
    });
    if (result.canceled) {
      return [];
    }

    const destinationDir = assetDirectory(targetDir, section);
    await fs.mkdir(destinationDir, { recursive: true });

    const uploaded = [];
    const baseSlug = slugifyName(entityName || entityId || section || "asset");
    const usedPaths = new Set();
    for (const sourcePath of result.filePaths.slice(0, LOCAL_UI_LIMITS.mediaBatchUpload)) {
      const detectedExtension = await detectBinaryExtension(sourcePath, path.extname(sourcePath));
      const target = await nextAvailableMediaPath(targetDir, section, baseSlug, detectedExtension, usedPaths);
      await fs.copyFile(sourcePath, target.absolutePath);
      let durationSec = null;
      if (section === "audio") {
        try {
          durationSec = await probeDuration(target.absolutePath);
        } catch {
          durationSec = null;
        }
      }
      uploaded.push({
        id: crypto.randomUUID(),
        label: path.basename(target.relativePath),
        kind: section === "audio" ? "audio" : "image",
        path: target.relativePath,
        fileUrl: assetUrlFor(target.absolutePath),
        ...(durationSec ? { durationSec } : {}),
      });
    }

    return uploaded;
  });

  // Bulk-import variant of forge:upload-assets — picks any number of files
  // (or whole folders on macOS), walks them, and copies each one into the
  // section's asset folder. Returns one descriptor per file so the renderer
  // can spawn an AssetEntry per file with its media bound. Mirrors the
  // Import-media flow but lands files in assets/<section>/ instead of
  // assets/library/.
  ipcMain.handle("forge:create-asset-entries-from-files", async (_event, projectDir, section) => {
    const targetDir = requireProjectDir(projectDir);
    if (!ASSET_SECTIONS.has(section)) {
      throw new Error(`Unsupported asset section: ${section}`);
    }
    const isAudio = section === "audio";
    const audioExts = [".mp3", ".wav", ".m4a", ".aac", ".aiff", ".flac", ".ogg"];
    const imageExts = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif", ".heic", ".tiff"];
    const supported = new Set(isAudio ? audioExts : imageExts);
    const filters = isAudio
      ? [{ name: "Audio", extensions: audioExts.map((ext) => ext.slice(1)) }]
      : [{ name: "Images", extensions: imageExts.map((ext) => ext.slice(1)) }];

    const properties = process.platform === "darwin"
      ? ["openFile", "openDirectory", "multiSelections"]
      : ["openFile", "multiSelections"];

    const result = await dialog.showOpenDialog({
      title: `Add files to ${section}`,
      properties,
      filters,
    });
    if (result.canceled || !Array.isArray(result.filePaths) || !result.filePaths.length) {
      return { uploaded: [] };
    }

    async function walkDir(dir) {
      const out = [];
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return out;
      }
      for (const entry of entries) {
        if (out.length >= LOCAL_UI_LIMITS.mediaBatchUpload) break;
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          out.push(...(await walkDir(abs)));
        } else if (entry.isFile() && supported.has(path.extname(entry.name).toLowerCase())) {
          out.push(abs);
        }
      }
      return out;
    }

    const allFiles = [];
    for (const candidate of result.filePaths) {
      if (allFiles.length >= LOCAL_UI_LIMITS.mediaBatchUpload) break;
      let stat;
      try {
        stat = await fs.stat(candidate);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        allFiles.push(...(await walkDir(candidate)));
      } else if (stat.isFile()) {
        allFiles.push(candidate);
      }
      if (allFiles.length > LOCAL_UI_LIMITS.mediaBatchUpload) {
        allFiles.length = LOCAL_UI_LIMITS.mediaBatchUpload;
      }
    }
    if (!allFiles.length) {
      return { uploaded: [] };
    }

    const destinationDir = assetDirectory(targetDir, section);
    await fs.mkdir(destinationDir, { recursive: true });

    const uploaded = [];
    const usedPaths = new Set();
    for (const sourcePath of allFiles) {
      const sourceBase = path.basename(sourcePath, path.extname(sourcePath));
      const detectedExtension = await detectBinaryExtension(sourcePath, path.extname(sourcePath));
      const baseSlug = slugifyName(sourceBase || section);
      const target = await nextAvailableMediaPath(targetDir, section, baseSlug, detectedExtension, usedPaths);
      await fs.copyFile(sourcePath, target.absolutePath);
      let durationSec = null;
      if (section === "audio") {
        try {
          durationSec = await probeDuration(target.absolutePath);
        } catch {
          durationSec = null;
        }
      }
      uploaded.push({
        title: sourceBase || baseSlug,
        media: {
          id: crypto.randomUUID(),
          label: path.basename(target.relativePath),
          kind: section === "audio" ? "audio" : "image",
          path: target.relativePath,
          fileUrl: assetUrlFor(target.absolutePath),
          ...(durationSec ? { durationSec } : {}),
        },
      });
    }

    return { uploaded };
  });

  ipcMain.handle("forge:upload-library-assets", async (_event, projectDir) => {
    const targetDir = requireProjectDir(projectDir);
    const result = await dialog.showOpenDialog({
      title: "Add files to library",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Media", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "heic", "tiff", "mp3", "wav", "m4a", "aac", "aiff", "flac", "ogg"] },
        { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "heic", "tiff"] },
        { name: "Audio", extensions: ["mp3", "wav", "m4a", "aac", "aiff", "flac", "ogg"] },
      ],
    });
    if (result.canceled) return [];

    const uploaded = await copyFilesIntoLibrary(targetDir, result.filePaths);
    await rebuildMediaIndex(targetDir, "scan_media after library upload failed");
    return uploaded;
  });

  // Pool IPC handlers retired — the staging-pool + promote flow was merged
  // into the unified media system. Files now go directly into the Media
  // panel (see forge:get-media-index + scan_media + attach_media tools).
  // The preload's uploadPoolAssets / dropPoolFiles / promotePoolAsset
  // bindings were removed alongside the PoolDropZone UI component.

  // Library folder upload — user picks a directory, we recursively walk it
  // and copy every supported media file into assets/library/. Mirrors the
  // per-file uploadLibraryAssets flow but handles whole-folder imports.
  ipcMain.handle("forge:upload-library-folder", async (_event, projectDir) => {
    const targetDir = requireProjectDir(projectDir);
    const result = await dialog.showOpenDialog({
      title: "Import folder into library",
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths?.length) return [];
    const sourceRoot = result.filePaths[0];
    const collected = await collectSupportedLibraryFiles(sourceRoot);
    if (collected.length === 0) return [];
    const uploaded = await copyFilesIntoLibrary(targetDir, collected);
    await rebuildMediaIndex(targetDir, "scan_media after folder upload failed");
    return uploaded;
  });

  // Drop-files IPC — renderer can pass an arbitrary list of absolute paths
  // (e.g., from a drag-drop onto the header upload button) and we copy them
  // all into assets/library/ just like the file-picker flow.
  ipcMain.handle("forge:drop-library-files", async (_event, projectDir, filePaths) => {
    const targetDir = requireProjectDir(projectDir);
    if (!Array.isArray(filePaths) || !filePaths.length) return [];
    const uploaded = await copyFilesIntoLibrary(targetDir, filePaths);
    await rebuildMediaIndex(targetDir, "scan_media after drop failed");
    return uploaded;
  });

  // Workshop NLE import — one picker/drop path for picture + sound.
  // Videos land in assets/videos/ and audio lands in assets/audio/ as
  // normal Audio asset entries, then readProject() scans both stores so
  // the bin updates through the same project model as the rest of Anvil.
  ipcMain.handle("forge:import-workshop-media", async (_event, projectDir, filePaths = null) => {
    const targetProjectDir = requireProjectDir(
      projectDir,
      "Import workshop media: project path is required.",
    );
    try {
      await fs.access(projectFilePath(targetProjectDir));
    } catch {
      throw new Error("Import workshop media: open a Forge project first.");
    }

    const mediaExtensions = [
      ...Array.from(VIDEO_ASSET_EXTENSIONS),
      ...Array.from(AUDIO_ASSET_EXTENSIONS),
    ].map((ext) => ext.replace(/^\./, ""));
    let sources = Array.isArray(filePaths) ? filePaths.filter(Boolean) : null;
    if (!sources || sources.length === 0) {
      const pick = await dialog.showOpenDialog({
        title: "Import workshop media",
        properties: ["openFile", "multiSelections"],
        filters: [
          { name: "Media", extensions: mediaExtensions },
          {
            name: "Video",
            extensions: Array.from(VIDEO_ASSET_EXTENSIONS, (ext) => ext.replace(/^\./, "")),
          },
          {
            name: "Audio",
            extensions: Array.from(AUDIO_ASSET_EXTENSIONS, (ext) => ext.replace(/^\./, "")),
          },
        ],
      });
      if (pick.canceled) return { videos: [], audio: [] };
      sources = pick.filePaths || [];
    }

    const videosRoot = path.join(targetProjectDir, "assets", "videos");
    const audioUsedPaths = new Set();
    const copiedVideos = [];
    const copiedAudio = [];
    for (const rawSource of sources.slice(0, LOCAL_UI_LIMITS.mediaBatchUpload)) {
      const sourcePath = String(rawSource || "").trim();
      if (!sourcePath) continue;
      let stat;
      try {
        stat = await fs.stat(sourcePath);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;

      const sourceExt = path.extname(sourcePath).toLowerCase();
      const detectedExtension = await detectBinaryExtension(sourcePath, sourceExt);
      const ext = VIDEO_ASSET_EXTENSIONS.has(sourceExt)
        ? sourceExt
        : String(detectedExtension || sourceExt || "").toLowerCase();
      if (VIDEO_ASSET_EXTENSIONS.has(ext)) {
        await fs.mkdir(videosRoot, { recursive: true });
        let existing;
        try {
          existing = await fs.readdir(videosRoot);
        } catch {
          existing = [];
        }
        const takeNumbers = existing
          .map((name) => {
            const match = String(name || "").match(/^take-(\d+)/i);
            return match ? Number(match[1]) : 0;
          })
          .filter((value) => Number.isFinite(value) && value > 0);
        const next = (takeNumbers.length ? Math.max(...takeNumbers) : 0) + 1;
        const targetName = `take-${String(next).padStart(2, "0")}${ext}`;
        const targetAbs = path.join(videosRoot, targetName);
        await fs.copyFile(sourcePath, targetAbs);
        copiedVideos.push(path.posix.join("assets", "videos", targetName));
        continue;
      }

      if (AUDIO_ASSET_EXTENSIONS.has(ext)) {
        const baseSlug = slugifyName(path.basename(sourcePath, path.extname(sourcePath)) || "audio");
        const target = await nextAvailableMediaPath(
          targetProjectDir,
          "audio",
          baseSlug,
          ext,
          audioUsedPaths,
        );
        await fs.copyFile(sourcePath, target.absolutePath);
        copiedAudio.push(target.relativePath);
      }
    }

    if (copiedVideos.length || copiedAudio.length) {
      await readProject(targetProjectDir);
    }

    return { videos: copiedVideos, audio: copiedAudio };
  });

  // Import video takes into the project. Accepts an optional destSubPath
  // (e.g. "scene-01-crow-and-wasteland/shot-01-crow-perch/prompt-01-static-crow-perch")
  // so files drop into the shot's folder and the scanner resolves them
  // by slug match. If destSubPath is empty, files land directly under
  // assets/videos/ and surface in the Unlinked drawer until the user
  // moves them. Returns the list of copied relative paths.
  ipcMain.handle(
    "forge:import-videos",
    async (_event, projectDir, destSubPath = "", filePaths = null) => {
      const targetProjectDir = requireProjectDir(
        projectDir,
        "Import video takes: project path is required.",
      );
      try {
        await fs.access(projectFilePath(targetProjectDir));
      } catch {
        throw new Error("Import video takes: open a Forge project first.");
      }
      const videosRoot = path.join(targetProjectDir, "assets", "videos");
      const cleanDestSubPath = (value) =>
        String(value || "")
          .replace(/\\/g, "/")
          .replace(/^\/+|\/+$/g, "");
      const resolveDest = (value) => {
        const cleanSubPath = cleanDestSubPath(value);
        const destDir = cleanSubPath
          ? path.resolve(videosRoot, cleanSubPath)
          : videosRoot;
        if (destDir !== videosRoot && !destDir.startsWith(`${videosRoot}${path.sep}`)) {
          throw new Error("Import video takes: destination escapes assets/videos.");
        }
        return { cleanSubPath, destDir };
      };
      const destPlan = Array.isArray(destSubPath)
        ? destSubPath.map(resolveDest)
        : [resolveDest(destSubPath)];
      if (!destPlan.length) destPlan.push(resolveDest(""));

      // If the renderer didn't pre-collect paths (drag-drop case), open
      // a native file picker.
      let sources = Array.isArray(filePaths) ? filePaths.filter(Boolean) : null;
      if (!sources || sources.length === 0) {
        const pick = await dialog.showOpenDialog({
          title: "Import video takes",
          properties: ["openFile", "multiSelections"],
          filters: [
            {
              name: "Video",
              extensions: Array.from(VIDEO_ASSET_EXTENSIONS, (ext) => ext.replace(/^\./, "")),
            },
          ],
        });
        if (pick.canceled) return [];
        sources = pick.filePaths || [];
      }

      const copied = [];
      for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
        const src = sources[sourceIndex];
        try {
          const stat = await fs.stat(src);
          if (!stat.isFile()) continue;
        } catch {
          continue;
        }
        const srcExt = path.extname(src).toLowerCase();
        if (!VIDEO_ASSET_EXTENSIONS.has(srcExt)) continue;
        const planIndex = Math.min(copied.length, destPlan.length - 1);
        const { cleanSubPath, destDir } = destPlan[planIndex] || destPlan[0];
        await fs.mkdir(destDir, { recursive: true });

        // Pick a non-colliding take-NN.mp4 inside destDir. The scanner
        // re-derives takeIndex from existing VideoEntry records, but the
        // on-disk name should be stable + predictable.
        let existing;
        try {
          existing = await fs.readdir(destDir);
        } catch {
          existing = [];
        }
        const takeNumbers = existing
          .map((n) => {
            const m = String(n || "").match(/^take-(\d+)/i);
            return m ? Number(m[1]) : 0;
          })
          .filter((n) => Number.isFinite(n) && n > 0);
        const next = (takeNumbers.length ? Math.max(...takeNumbers) : 0) + 1;
        const targetName = `take-${String(next).padStart(2, "0")}${srcExt}`;
        const targetAbs = path.join(destDir, targetName);
        await fs.copyFile(src, targetAbs);
        copied.push(path.posix.join(
          "assets",
          "videos",
          ...(cleanSubPath ? cleanSubPath.split(/[\\/]/).filter(Boolean) : []),
          targetName,
        ));
      }

      if (copied.length > 0) {
        await readProject(targetProjectDir);
      }

      return copied;
    },
  );

  ipcMain.handle("forge:generate-prompt-video", async (_event, projectDir, promptId) =>
    generateVideoForPrompt(projectDir, promptId),
  );

  ipcMain.handle("forge:generate-asset-image", async (_event, projectDir, payload) =>
    generateAssetImage(projectDir, payload),
  );

  ipcMain.handle("forge:trim-asset-media", async (_event, projectDir, section, assetId, mediaId, payload = {}) => {
    const targetDir = requireProjectDir(projectDir, "Trim asset media: project path is required.");
    const normalizedSection = String(section || "").trim() === "media" ? "library" : String(section || "").trim();
    if (!["library", ...Array.from(ASSET_SECTIONS)].includes(normalizedSection)) {
      throw new Error(`Trim asset media: unsupported section "${section}".`);
    }
    const targetAssetId = String(assetId || "").trim();
    const targetMediaId = String(mediaId || "").trim();
    if (!targetAssetId || !targetMediaId) {
      throw new Error("Trim asset media: asset id and media id are required.");
    }

    const startRaw = Number(payload?.startSec);
    const endRaw = Number(payload?.endSec);
    const startSec = Number.isFinite(startRaw) && startRaw >= 0 ? startRaw : 0;
    const endSec = Number.isFinite(endRaw) && endRaw > 0 ? endRaw : null;
    if (endSec !== null && endSec <= startSec) {
      throw new Error("Trim asset media: end must be after start.");
    }

    const project = await readProject(targetDir);
    const entries = Array.isArray(project?.[normalizedSection]) ? project[normalizedSection] : [];
    const entryIndex = entries.findIndex((entry) => entry && entry.id === targetAssetId);
    if (entryIndex < 0) {
      throw new Error("Trim asset media: asset not found.");
    }
    const entry = entries[entryIndex];
    const mediaList = Array.isArray(entry?.media) ? entry.media : [];
    const sourceMedia = mediaList.find((media) => media && media.id === targetMediaId) || null;
    if (!sourceMedia) {
      throw new Error("Trim asset media: media variant not found.");
    }
    const sourcePath = normalizeProjectMediaPath(targetDir, sourceMedia.path);
    if (!sourcePath) {
      throw new Error("Trim asset media: media path is invalid.");
    }
    const sourceAbs = resolveProjectRelativePath(targetDir, sourcePath);
    if (!(await fileExists(sourceAbs))) {
      throw new Error("Trim asset media: source video file is missing.");
    }
    const sourceExt = path.extname(sourceAbs).toLowerCase();
    if (!VIDEO_ASSET_EXTENSIONS.has(sourceExt)) {
      throw new Error("Trim asset media: only video variants can be trimmed.");
    }

    let sourceDurationSec = null;
    try {
      sourceDurationSec = await probeDuration(sourceAbs);
    } catch {
      sourceDurationSec = null;
    }
    const normalizedEndSec =
      sourceDurationSec && endSec !== null ? Math.min(endSec, sourceDurationSec) : endSec;
    if (sourceDurationSec && startSec >= sourceDurationSec) {
      throw new Error("Trim asset media: start point is past the end of the video.");
    }
    if (normalizedEndSec !== null && normalizedEndSec <= startSec) {
      throw new Error("Trim asset media: trim window is empty.");
    }

    const outputRelativeDir =
      normalizedSection === "library"
        ? "assets/library"
        : `assets/${normalizedSection}`;
    const entryBaseName = String(entry?.title || entry?.name || "").trim()
      || path.basename(sourcePath, sourceExt)
      || "trim";
    const target = await nextAvailableRelativePath(
      targetDir,
      outputRelativeDir,
      `${slugifyName(entryBaseName) || "trim"}-trim`,
      sourceExt || ".mp4",
    );

    const { resolveFfmpeg } = require("./frames.cjs");
    const { execFile } = require("node:child_process");
    const ffmpegBin = resolveFfmpeg();
    const ffmpegArgs = ["-y", "-i", sourceAbs];
    if (startSec > 0) ffmpegArgs.push("-ss", String(startSec));
    if (normalizedEndSec !== null) ffmpegArgs.push("-to", String(normalizedEndSec));
    ffmpegArgs.push(
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "18",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      target.absolutePath,
    );

    const result = await new Promise((resolve) => {
      execFile(
        ffmpegBin,
        ffmpegArgs,
        { timeout: 5 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 },
        (err, _stdout, stderr) => {
          if (err) {
            resolve({
              ok: false,
              error: err.message || String(err),
              stderr: String(stderr || "").slice(-2000),
            });
            return;
          }
          resolve({ ok: true });
        },
      );
    });
    if (!result.ok) {
      throw new Error(`Trim asset media: ffmpeg failed — ${result.error}\n${result.stderr || ""}`);
    }

    let durationSec = null;
    try {
      durationSec = await probeDuration(target.absolutePath);
    } catch {
      durationSec = null;
    }

    const nextMedia = {
      id: randomUUID(),
      label: path.basename(target.relativePath),
      kind: "video",
      path: target.relativePath,
      fileUrl: assetUrlFor(target.absolutePath),
      ...(durationSec ? { durationSec } : {}),
    };
    const nextProject = {
      ...project,
      [normalizedSection]: [
        ...entries.slice(0, entryIndex),
        {
          ...entry,
          media: [...mediaList, nextMedia],
        },
        ...entries.slice(entryIndex + 1),
      ],
      project: {
        ...(project.project || {}),
        updatedAt: new Date().toISOString(),
      },
    };

    await writeProject(targetDir, nextProject);
    invalidateAgentMagicDocSummary(targetDir);
    await rebuildMediaIndex(targetDir, "scan_media after trim asset media failed");
    return {
      project: await openProjectAtDirectory(targetDir),
      mediaId: nextMedia.id,
      path: nextMedia.path,
      durationSec,
    };
  });

  ipcMain.handle("forge:delete-video-entry", async (_event, projectDir, videoId) => {
    const targetDir = requireProjectDir(projectDir, "Delete video: project path is required.");
    const targetVideoId = String(videoId || "").trim();
    if (!targetVideoId) {
      throw new Error("Delete video: video id is required.");
    }

    const project = await readProject(targetDir);
    const videos = Array.isArray(project?.videos) ? project.videos : [];
    const targetVideo = videos.find((video) => video.id === targetVideoId) || null;
    if (!targetVideo) {
      throw new Error("Delete video: take not found in this project.");
    }

    const absoluteVideoPath = absoluteProjectMediaPath(targetDir, targetVideo.path);
    if (absoluteVideoPath) {
      try {
        await fs.unlink(absoluteVideoPath);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
    }
    await fs.rm(path.join(targetDir, ".forge", "frames", targetVideoId), {
      recursive: true,
      force: true,
    });

    const nextProject = {
      ...project,
      videos: videos.filter((video) => video.id !== targetVideoId),
      prompts: Array.isArray(project?.prompts)
        ? project.prompts.map((prompt) =>
            Array.isArray(prompt?.renders) && prompt.renders.includes(targetVideoId)
              ? {
                  ...prompt,
                  renders: prompt.renders.filter((id) => id !== targetVideoId),
                }
              : prompt,
          )
        : [],
      timeline: Array.isArray(project?.timeline)
        ? project.timeline.filter((clip) => clip?.videoId !== targetVideoId)
        : [],
    };

    await writeProject(targetDir, nextProject);
    invalidateAgentMagicDocSummary(targetDir);
    return openProjectAtDirectory(targetDir);
  });

  async function renderTimelineExport(projectDir, clips, outPath, errorPrefix = "export-timeline") {
    const targetProjectDir = requireProjectDir(projectDir, `${errorPrefix}: projectDir required.`);
    try {
      await fs.access(projectFilePath(targetProjectDir));
    } catch {
      throw new Error(`${errorPrefix}: open a Forge project first.`);
    }
    if (!Array.isArray(clips) || clips.length === 0) {
      throw new Error(`${errorPrefix}: no clips to render.`);
    }
    const { resolveFfmpeg } = require("./frames.cjs");
    const { execFile } = require("node:child_process");
    const ffmpegBin = resolveFfmpeg();
    await fs.mkdir(path.dirname(outPath), { recursive: true });

    const inputs = [];
    const filterParts = [];
    const labels = [];
    for (let i = 0; i < clips.length; i += 1) {
      const clip = clips[i] || {};
      if (!clip.videoPath) {
        throw new Error(`${errorPrefix}: clip ${i} missing videoPath.`);
      }
      const abs = absoluteProjectMediaPath(targetProjectDir, clip.videoPath);
      if (!abs) {
        throw new Error(`${errorPrefix}: clip ${i} path escapes the project.`);
      }
      if (!(await fileExists(abs))) {
        throw new Error(`${errorPrefix}: clip ${i} file is missing.`);
      }
      inputs.push("-i", abs);
      const start = Number.isFinite(Number(clip.inSec)) && Number(clip.inSec) > 0
        ? Number(clip.inSec)
        : null;
      const end = Number.isFinite(Number(clip.outSec)) && Number(clip.outSec) > 0
        ? Number(clip.outSec)
        : null;
      let trimFilter = `[${i}:v]`;
      const trims = [];
      if (start !== null) trims.push(`start=${start}`);
      if (end !== null) trims.push(`end=${end}`);
      if (trims.length) trimFilter += `trim=${trims.join(":")},`;
      trimFilter += `setpts=PTS-STARTPTS[v${i}]`;
      filterParts.push(trimFilter);
      labels.push(`[v${i}]`);
    }
    const concat = `${labels.join("")}concat=n=${clips.length}:v=1:a=0[out]`;
    const filterComplex = [...filterParts, concat].join(";");
    const args = [
      "-y",
      ...inputs,
      "-filter_complex",
      filterComplex,
      "-map",
      "[out]",
      "-pix_fmt",
      "yuv420p",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "18",
      outPath,
    ];

    const result = await new Promise((resolve) => {
      execFile(
        ffmpegBin,
        args,
        { timeout: 5 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            resolve({
              ok: false,
              error: err.message || String(err),
              stderr: String(stderr || "").slice(-2000),
            });
            return;
          }
          resolve({ ok: true, stderr: String(stderr || "").slice(-500) });
        },
      );
    });
    if (!result.ok) {
      throw new Error(`${errorPrefix}: ffmpeg failed — ${result.error}\n${result.stderr || ""}`);
    }
    return { ok: true, absolutePath: outPath };
  }

  // Export the Timeline assembly to a single .mp4 via ffmpeg concat +
  // trim filters. Clips arrive with { videoPath, inSec, outSec }; each
  // clip is re-encoded via the concat filter so trim points land on
  // decoded frames (no copy-mode seek drift). Output lands at
  // assets/exports/timeline-<ISO>.mp4 and the path is returned so the
  // renderer can reveal it in Finder.
  ipcMain.handle("forge:export-timeline", async (_event, projectDir, clips) => {
    const targetProjectDir = requireProjectDir(projectDir, "export-timeline: projectDir required.");
    if (!Array.isArray(clips) || clips.length === 0) {
      throw new Error("export-timeline: no clips to render.");
    }
    const outDir = path.join(targetProjectDir, "assets", "exports");
    await fs.mkdir(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outPath = path.join(outDir, `timeline-${stamp}.mp4`);
    await renderTimelineExport(targetProjectDir, clips, outPath, "export-timeline");
    return {
      ok: true,
      path: path.posix.join("assets", "exports", path.basename(outPath)),
      absolutePath: outPath,
    };
  });

  ipcMain.handle("forge:export-timeline-sequences", async (_event, projectDir, sequences) => {
    const targetProjectDir = requireProjectDir(
      projectDir,
      "export-timeline-sequences: projectDir required.",
    );
    if (!Array.isArray(sequences) || sequences.length === 0) {
      throw new Error("export-timeline-sequences: no sequences to export.");
    }
    const outDir = path.join(targetProjectDir, "assets", "exports");
    await fs.mkdir(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const folderName = `timeline-sequences-${stamp}`;
    const absoluteFolderPath = path.join(outDir, folderName);
    await fs.mkdir(absoluteFolderPath, { recursive: true });

    const files = [];
    for (let index = 0; index < sequences.length; index += 1) {
      const sequence = sequences[index] || {};
      const label = String(sequence.label || "").trim() || `Sequence ${index + 1}`;
      const clips = Array.isArray(sequence.clips)
        ? sequence.clips.filter((clip) => clip && clip.videoPath)
        : [];
      if (!clips.length) continue;
      const fileName = `${String(files.length + 1).padStart(2, "0")}-${slugifyName(label)}.mp4`;
      const outPath = path.join(absoluteFolderPath, fileName);
      await renderTimelineExport(targetProjectDir, clips, outPath, "export-timeline-sequences");
      files.push({
        label,
        path: path.posix.join("assets", "exports", folderName, fileName),
        absolutePath: outPath,
        clipCount: clips.length,
      });
    }

    if (files.length === 0) {
      throw new Error("export-timeline-sequences: no rendered sequence clips to export.");
    }

    return {
      ok: true,
      folder: path.posix.join("assets", "exports", folderName),
      absoluteFolderPath,
      files,
    };
  });

  // Workshop NLE multi-track export. Composites V1 sequence + V2 overlay +
  // A1/A2 audio mix into a single .mp4. Each clip carries (mediaPath,
  // startSec, inSec, outSec, volume, fadeInSec, fadeOutSec).
  //
  // Filter graph:
  //   1. black canvas of duration = totalSec
  //   2. for each V1 clip: trim + setpts + overlay onto canvas with
  //      enable='between(t,start,end)' window
  //   3. for each V2 clip: same, but scaled to 25% bottom-right
  //   4. for each explicit audio clip (A1/A2): atrim +
  //      asetpts + adelay=startMs + volume + afade in/out → amix all
  ipcMain.handle("forge:export-workshop-nle", async (_event, projectDir, payload) => {
    const targetProjectDir = requireProjectDir(
      projectDir,
      "export-workshop-nle: projectDir required.",
    );
    const v1Clips = Array.isArray(payload?.v1Clips) ? payload.v1Clips : [];
    const v2Clips = Array.isArray(payload?.v2Clips) ? payload.v2Clips : [];
    const audioClips = Array.isArray(payload?.audioClips) ? payload.audioClips : [];
    const includeV1Audio = payload?.includeV1Audio === true;
    const totalSec = Number(payload?.totalDurationSec);
    const width = Number(payload?.width) || 1920;
    const height = Number(payload?.height) || 1080;
    if (v1Clips.length === 0 && v2Clips.length === 0 && audioClips.length === 0) {
      throw new Error("export-workshop-nle: no clips to render.");
    }
    if (!Number.isFinite(totalSec) || totalSec <= 0.05) {
      throw new Error("export-workshop-nle: totalDurationSec required.");
    }

    const { resolveFfmpeg } = require("./frames.cjs");
    const ffmpegBin = resolveFfmpeg();

    const outDir = path.join(targetProjectDir, "assets", "exports");
    await fs.mkdir(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outPath = path.join(outDir, `workshop-${stamp}.mp4`);

    // Resolve every clip's absolute path + assign an ffmpeg input index.
    const inputs = [];
    const allClips = [
      ...v1Clips.map((c) => ({ ...c, _kind: "v1" })),
      ...v2Clips.map((c) => ({ ...c, _kind: "v2" })),
      ...audioClips.map((c) => ({ ...c, _kind: "audio" })),
    ];
    for (let i = 0; i < allClips.length; i += 1) {
      const clip = allClips[i];
      const abs = absoluteProjectMediaPath(targetProjectDir, clip.mediaPath);
      if (!abs) {
        throw new Error(`export-workshop-nle: clip ${i} path escapes project.`);
      }
      if (!(await fileExists(abs))) {
        throw new Error(`export-workshop-nle: clip ${i} file missing: ${abs}`);
      }
      clip._inputIndex = i;
      inputs.push("-i", abs);
    }

    // Video filter chain.
    const vFilters = [];
    vFilters.push(`color=black:size=${width}x${height}:duration=${totalSec.toFixed(2)}:rate=24,format=yuv420p[bg]`);

    let lastVideoLabel = "bg";
    let videoLayerIdx = 0;
    const buildVideoOverlay = (clip, scaleSpec, position) => {
      const i = clip._inputIndex;
      const start = Number(clip.startSec) || 0;
      const trimIn = Number(clip.inSec) > 0 ? Number(clip.inSec) : 0;
      const trimOut = Number(clip.outSec) > 0 ? Number(clip.outSec) : null;
      const dur = trimOut !== null ? Math.max(0.05, trimOut - trimIn) : null;
      const end = dur !== null ? start + dur : start + 600;
      const trimParts = [];
      if (trimIn > 0) trimParts.push(`start=${trimIn}`);
      if (trimOut !== null) trimParts.push(`end=${trimOut}`);
      const trimChain = trimParts.length ? `trim=${trimParts.join(":")},` : "";
      const inputLabel = `vp${videoLayerIdx}`;
      vFilters.push(
        `[${i}:v]${trimChain}setpts=PTS-STARTPTS+${start}/TB,${scaleSpec}[${inputLabel}]`,
      );
      const nextLabel = `vmix${videoLayerIdx}`;
      vFilters.push(
        `[${lastVideoLabel}][${inputLabel}]overlay=${position}:enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'[${nextLabel}]`,
      );
      lastVideoLabel = nextLabel;
      videoLayerIdx += 1;
    };
    for (const clip of allClips.filter((c) => c._kind === "v1")) {
      buildVideoOverlay(clip, `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`, "0:0");
    }
    for (const clip of allClips.filter((c) => c._kind === "v2")) {
      buildVideoOverlay(
        clip,
        `scale=${Math.round(width / 4)}:${Math.round(height / 4)}:force_original_aspect_ratio=decrease`,
        `W-w-24:24`,
      );
    }
    const finalVideoLabel = lastVideoLabel;

    // Audio filter chain.
    const aFilters = [];
    const audioLeafLabels = [];

    const buildAudioLeaf = (clip, kindHint) => {
      const i = clip._inputIndex;
      const start = Math.max(0, Number(clip.startSec) || 0);
      const trimIn = Number(clip.inSec) > 0 ? Number(clip.inSec) : 0;
      const trimOut = Number(clip.outSec) > 0 ? Number(clip.outSec) : null;
      const dur = trimOut !== null ? Math.max(0.05, trimOut - trimIn) : null;
      const volume = Number.isFinite(Number(clip.volume)) ? Number(clip.volume) : 1;
      const fadeIn = Math.max(0, Number(clip.fadeInSec) || 0);
      const fadeOut = Math.max(0, Number(clip.fadeOutSec) || 0);
      const trimParts = [];
      if (trimIn > 0) trimParts.push(`start=${trimIn}`);
      if (trimOut !== null) trimParts.push(`end=${trimOut}`);
      const trimChain = trimParts.length ? `atrim=${trimParts.join(":")},` : "";
      const delayMs = Math.round(start * 1000);
      const ladder = [];
      ladder.push(`[${i}:a]${trimChain}asetpts=PTS-STARTPTS`);
      if (delayMs > 0) ladder.push(`adelay=${delayMs}|${delayMs}`);
      if (volume !== 1) ladder.push(`volume=${volume.toFixed(3)}`);
      if (fadeIn > 0) ladder.push(`afade=t=in:st=${start.toFixed(3)}:d=${fadeIn.toFixed(3)}`);
      if (fadeOut > 0 && dur !== null) {
        const fadeOutStart = (start + dur - fadeOut).toFixed(3);
        ladder.push(`afade=t=out:st=${fadeOutStart}:d=${fadeOut.toFixed(3)}`);
      }
      const label = `a_${kindHint}_${audioLeafLabels.length}`;
      aFilters.push(`${ladder.join(",")}[${label}]`);
      audioLeafLabels.push(label);
    };
    for (const clip of allClips.filter((c) => c._kind === "audio")) {
      buildAudioLeaf(clip, "ax");
    }
    if (includeV1Audio) {
      for (const clip of allClips.filter((c) => c._kind === "v1")) {
        buildAudioLeaf(clip, "v1");
      }
    }

    const filterParts = [...vFilters];
    let mapAudioLabel = null;
    if (audioLeafLabels.length === 1) {
      mapAudioLabel = audioLeafLabels[0];
      filterParts.push(...aFilters);
    } else if (audioLeafLabels.length > 1) {
      filterParts.push(...aFilters);
      filterParts.push(
        `${audioLeafLabels.map((l) => `[${l}]`).join("")}amix=inputs=${audioLeafLabels.length}:duration=longest:dropout_transition=0[amix]`,
      );
      mapAudioLabel = "amix";
    } else {
      // No audio at all — synthesize silence so the file has a well-formed
      // audio track (some players choke on video-only outputs).
      filterParts.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${totalSec.toFixed(2)}[asilent]`);
      mapAudioLabel = "asilent";
    }

    const args = ["-y", ...inputs, "-filter_complex", filterParts.join(";")];
    args.push("-map", `[${finalVideoLabel}]`);
    if (mapAudioLabel) args.push("-map", `[${mapAudioLabel}]`);
    args.push(
      "-pix_fmt",
      "yuv420p",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-t",
      totalSec.toFixed(2),
      outPath,
    );

    const { execFile } = require("node:child_process");
    const result = await new Promise((resolve) => {
      execFile(
        ffmpegBin,
        args,
        { timeout: 10 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 },
        (err, _stdout, stderr) => {
          if (err) {
            resolve({
              ok: false,
              error: err.message || String(err),
              stderr: String(stderr || "").slice(-2500),
            });
            return;
          }
          resolve({ ok: true });
        },
      );
    });
    if (!result.ok) {
      throw new Error(`export-workshop-nle: ffmpeg failed — ${result.error}\n${result.stderr || ""}`);
    }
    return {
      ok: true,
      path: path.posix.join("assets", "exports", path.basename(outPath)),
      absolutePath: outPath,
      v1Count: v1Clips.length,
      v2Count: v2Clips.length,
      audioCount: audioClips.length,
    };
  });

  // Reveal a project-relative path in Finder. Used by the Videos section's
  // "Reveal in Finder" button so the user can grab rendered takes / move
  // files manually. Accepts relative paths inside the project only —
  // anything escaping the root is rejected.
  ipcMain.handle("forge:reveal-path", async (_event, projectDir, relativePath) => {
    const root = requireProjectDir(projectDir, "reveal-path: projectDir required.");
    const normalized = String(relativePath || "")
      .replace(/\\/g, "/")
      .replace(/^\/+/, "");
    const abs = path.resolve(root, normalized || ".");
    if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) {
      throw new Error("reveal-path: path escapes the project root.");
    }
    // Ensure the folder exists so Finder has something to open.
    if (!nodeFs.existsSync(abs)) {
      await fs.mkdir(abs, { recursive: true });
    }
    shell.showItemInFolder(abs);
    return { ok: true, path: abs };
  });

  // Copy a project-relative image file to the system clipboard as an image
  // (for paste into Discord / Slack / browser / another app). Electron's
  // clipboard.writeImage expects a NativeImage built from the absolute path.
  // Caps at 25MB — very large images can OOM the clipboard; at that size
  // the UI falls back to copy-path-instead with a notice.
  const CLIPBOARD_IMAGE_MAX_BYTES = 25 * 1024 * 1024;
  ipcMain.handle("forge:copy-image-to-clipboard", async (_event, projectDir, relativePath) => {
    const root = requireProjectDir(projectDir, "copy-image-to-clipboard: projectDir required.");
    const normalized = String(relativePath || "")
      .replace(/\\/g, "/")
      .replace(/^\/+/, "");
    if (!normalized) throw new Error("copy-image-to-clipboard: relativePath required.");
    const abs = path.resolve(root, normalized);
    if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) {
      throw new Error("copy-image-to-clipboard: path escapes the project root.");
    }
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { ok: false, reason: "missing", path: normalized };
      }
      throw error;
    }
    if (!stat.isFile()) {
      return { ok: false, reason: "not-a-file", path: normalized };
    }
    if (stat.size > CLIPBOARD_IMAGE_MAX_BYTES) {
      return { ok: false, reason: "too-large", path: normalized, sizeBytes: stat.size };
    }
    const image = nativeImage.createFromPath(abs);
    if (image.isEmpty()) {
      return { ok: false, reason: "unsupported", path: normalized };
    }
    clipboard.writeImage(image);
    return { ok: true, path: normalized, sizeBytes: stat.size };
  });

  ipcMain.handle("forge:delete-asset-entry", async (_event, projectDir, section, assetId) => {
    const targetDir = requireProjectDir(projectDir);
    // The renderer uses "media" as its section id, but the backend tool
    // stores media-library entries under project.library. Normalize here.
    const normalizedSection = String(section || "").trim() === "media" ? "library" : String(section || "").trim();
    const { runTool } = require("./tools.cjs");
    await runTool("delete_asset_entry", { section: normalizedSection, assetId }, { projectDir: targetDir });
    return openProjectAtDirectory(targetDir);
  });

  ipcMain.handle("forge:upload-chat-attachments", async (_event, projectDir) => {
    const targetDir = requireProjectDir(projectDir);
    const result = await dialog.showOpenDialog({
      title: "Attach local files",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Supported files", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "mp3", "wav", "m4a", "aac", "flac", "ogg", "mp4", "mov", "webm", "m4v", "pdf", "txt", "md", "json", "csv"] },
        { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"] },
        { name: "Audio", extensions: ["mp3", "wav", "m4a", "aac", "flac", "ogg"] },
        { name: "Video", extensions: ["mp4", "mov", "webm", "m4v"] },
        { name: "Documents", extensions: ["pdf", "txt", "md", "json", "csv"] },
      ],
    });
    if (result.canceled) {
      return [];
    }

    const destinationDir = attachmentInboxDirectory(targetDir);
    await fs.mkdir(destinationDir, { recursive: true });

    const uploaded = [];
    for (const sourcePath of result.filePaths) {
      const ext = path.extname(sourcePath);
      const baseSlug = slugifyName(path.basename(sourcePath, ext) || "attachment");
      const targetName = `${baseSlug}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
      const targetPath = path.join(destinationDir, targetName);
      const stats = await fs.stat(sourcePath);
      await fs.copyFile(sourcePath, targetPath);
      uploaded.push({
        id: crypto.randomUUID(),
        label: path.basename(sourcePath),
        kind: classifyAttachmentKind(sourcePath),
        path: toProjectRelativePath(targetDir, targetPath),
        fileUrl: assetUrlFor(targetPath),
        size: stats.size,
      });
    }

    return uploaded;
  });

  ipcMain.handle("forge:get-app-version", async () => ANVIL_VERSION);
  ipcMain.handle("forge:open-external", async (_event, url) => {
    const value = String(url || "").trim();
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error("Invalid external URL.");
    }
    if (parsed.protocol !== "https:") {
      throw new Error("Only HTTPS account links can be opened.");
    }
    await shell.openExternal(parsed.toString());
    return { ok: true };
  });

  ipcMain.handle("forge:get-method-directive", async (_event, settings = {}, payload = {}) =>
    require("./method-server.cjs").callMethodDirectiveServer({ settings, payload }),
  );

  ipcMain.handle("forge:protected-anvil-turn", async (_event, projectDir, payload = {}) => {
    const targetDir = requireProjectDir(projectDir, "protected-anvil-turn: projectDir required.");
    const project = await readProject(targetDir);
    const account = await loadDesktopAccountEntry();
    const protectedSettings = {
      ...(project.settings || {}),
      protectedAnvilEnabled:
        project.settings?.protectedAnvilEnabled === true ||
        project.settings?.remoteAgentEnabled === true ||
        Boolean(account.token),
      protectedAnvilUrl:
        project.settings?.protectedAnvilUrl ||
        project.settings?.remoteAgentUrl ||
        account.endpoint ||
        DEFAULT_DESKTOP_ANVIL_ENDPOINT,
      protectedAnvilToken:
        project.settings?.protectedAnvilToken ||
        project.settings?.remoteAgentToken ||
        account.token ||
        "",
    };
    const response = await callProtectedAnvilTurn({
      settings: protectedSettings,
      projectDir: targetDir,
      project,
      payload,
    });
    const applied =
      payload && payload.applyActions === false
        ? { ...response, appliedActions: [] }
        : await applyProtectedAnvilActions(targetDir, response);
    const refreshed =
      applied.appliedActions && applied.appliedActions.length
        ? await openProjectAtDirectory(targetDir)
        : null;
    return { ...applied, project: refreshed };
  });

  ipcMain.handle("forge:get-desktop-account-status", async (_event, projectDir) =>
    getDesktopAccountStatus(projectDir),
  );
  ipcMain.handle("forge:get-desktop-account-session", async () =>
    getDesktopAccountSession(),
  );
  ipcMain.handle("forge:connect-desktop-account-session", async (_event, payload = {}) =>
    connectDesktopAccountSession(payload),
  );
  ipcMain.handle("forge:clear-desktop-account-session", async () => {
    await clearDesktopAccountEntry();
    return { ok: true };
  });

  ipcMain.handle("forge:open-project-terminal", async (_event, projectDir, launcher = "shell") =>
    openProjectTerminal(projectDir, launcher),
  );

  ipcMain.handle("forge:start-project-terminal", async (event, payload = {}) =>
    startEmbeddedProjectTerminal(event.sender, payload),
  );
  ipcMain.handle("forge:read-project-terminal-transcript", async (_event, projectDir, launcher = "shell") =>
    readProjectTerminalTranscript(projectDir, launcher),
  );
  ipcMain.handle("forge:clear-project-terminal-transcript", async (_event, projectDir, launcher = "shell") =>
    clearProjectTerminalTranscript(projectDir, launcher),
  );
  ipcMain.on("forge:write-project-terminal", (event, sessionId, data) => {
    const state = projectTerminalSessions.get(String(sessionId || ""));
    if (!state || state.webContentsId !== event.sender.id) return;
    state.pty.write(String(data || ""));
  });
  ipcMain.on("forge:resize-project-terminal", (event, sessionId, cols, rows) => {
    const state = projectTerminalSessions.get(String(sessionId || ""));
    if (!state || state.webContentsId !== event.sender.id) return;
    state.pty.resize(
      normalizeTerminalDimension(cols, 96, 20, 320),
      normalizeTerminalDimension(rows, 28, 8, 160),
    );
  });
  ipcMain.on("forge:kill-project-terminal", (event, sessionId) => {
    const state = projectTerminalSessions.get(String(sessionId || ""));
    if (!state || state.webContentsId !== event.sender.id) return;
    disposeProjectTerminalSession(String(sessionId));
  });

  ipcMain.handle("forge:list-agent-providers", async () => {
    const { listProviders } = require("./agent-runtime.cjs");
    return listProviders();
  });
  ipcMain.handle("forge:test-agent-connection", async (_event, payload) => {
    const { testAgentConnection } = require("./agent-runtime.cjs");
    return testAgentConnection({
      provider: String(payload?.provider || "openclaw"),
      binPath: String(payload?.binPath || ""),
      apiKey: String(payload?.apiKey || ""),
      endpoint: String(payload?.endpoint || ""),
    });
  });

  ipcMain.handle("forge:detect-entity-placeholders", async (_event, payload) => {
    const { detectEntityPlaceholders } = require("./entity-ai-detector.cjs");
    return detectEntityPlaceholders({
      project: payload?.project || null,
      settings: payload?.settings || {},
    });
  });

  ipcMain.handle("forge:read-conventions", async (_event, projectDir) => {
    const targetDir = requireProjectDir(projectDir);
    const conv = require("./conventions.cjs");
    return conv.ensureConventions(targetDir);
  });
  ipcMain.handle("forge:write-conventions", async (_event, projectDir, text) => {
    const targetDir = requireProjectDir(projectDir);
    const conv = require("./conventions.cjs");
    return conv.writeConventions(targetDir, text);
  });
  ipcMain.handle("forge:reset-conventions", async (_event, projectDir) => {
    const targetDir = requireProjectDir(projectDir);
    const conv = require("./conventions.cjs");
    return conv.resetConventions(targetDir);
  });
  ipcMain.handle("forge:list-skill-library", async (_event, projectDir) => {
    const targetDir = requireProjectDir(projectDir);
    await ensureProjectScaffold(targetDir);
    return skillLibrary.listSkillLibrary(targetDir);
  });
  ipcMain.handle("forge:read-skill-markdown", async (_event, projectDir, name) => {
    const targetDir = requireProjectDir(projectDir);
    return skillLibrary.readSkillMarkdown(targetDir, name);
  });
  ipcMain.handle("forge:write-skill-markdown", async (_event, projectDir, name, text) => {
    const targetDir = requireProjectDir(projectDir);
    return skillLibrary.writeSkillMarkdown(targetDir, name, text);
  });
  ipcMain.handle("forge:reset-skill-markdown", async (_event, projectDir, name) => {
    const targetDir = requireProjectDir(projectDir);
    return skillLibrary.resetSkillMarkdown(targetDir, name);
  });
  ipcMain.handle("forge:create-custom-skill", async (_event, projectDir, name) => {
    const targetDir = requireProjectDir(projectDir);
    await ensureProjectScaffold(targetDir);
    return skillLibrary.createCustomSkill(targetDir, name);
  });
  ipcMain.handle("forge:import-skill-markdown", async (_event, projectDir) => {
    const targetDir = requireProjectDir(projectDir);
    await ensureProjectScaffold(targetDir);
    const result = await dialog.showOpenDialog({
      title: "Import skill markdown",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Markdown", extensions: ["md", "markdown"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true, imported: [] };
    const imported = [];
    for (const sourcePath of result.filePaths) {
      imported.push(await skillLibrary.importSkillMarkdown(targetDir, sourcePath));
    }
    return { canceled: false, imported };
  });
  ipcMain.handle("forge:export-skill-markdown", async (_event, projectDir, name) => {
    const targetDir = requireProjectDir(projectDir);
    const markdown = await skillLibrary.readSkillMarkdown(targetDir, name);
    const result = await dialog.showSaveDialog({
      title: "Export skill markdown",
      defaultPath: path.basename(markdown.path),
      filters: [
        { name: "Markdown", extensions: ["md"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await fs.writeFile(result.filePath, markdown.content, "utf8");
    return {
      canceled: false,
      path: result.filePath,
      bytes: Buffer.byteLength(markdown.content, "utf8"),
    };
  });

  // Secondary-script CRUD. Secondary scripts (trailer, episode 2, etc.)
  // are peers to the Master Script — same frontmatter shape, same on-disk
  // location (`script/<slug>.md`), but tracked separately on
  // `project.scripts[]`. Master Script itself (`script/master-script.md`)
  // is the implicit primary and is NOT covered by these handlers — it
  // continues to flow through the existing master-script pipeline so
  // single-film projects carry zero behavioral change.
  function assertSecondaryScriptPath(relPath) {
    const safe = String(relPath || "").replace(/\\/g, "/").replace(/^\.?\//, "");
    if (!safe || safe.includes("..")) {
      throw new Error("Invalid script path.");
    }
    if (!safe.startsWith(`${MASTER_SCRIPT_FOLDER}/`)) {
      throw new Error(`Script path must live under ${MASTER_SCRIPT_FOLDER}/.`);
    }
    if (safe === `${MASTER_SCRIPT_FOLDER}/${MASTER_SCRIPT_FILE}`) {
      throw new Error("Master Script is not a secondary script — use the master-script pipeline.");
    }
    return safe;
  }

  ipcMain.handle("forge:create-script", async (_event, payload = {}) => {
    const projectDir = requireProjectDir(payload?.projectDir);
    const name = String(payload?.name || "").trim().slice(0, 80);
    if (!name) throw new Error("create-script: name required.");

    const baseSlug = slugifyName(name) || "script";
    let slug = baseSlug;
    let counter = 2;
    while (
      slug === path.basename(MASTER_SCRIPT_FILE, ".md") ||
      nodeFs.existsSync(path.join(projectDir, MASTER_SCRIPT_FOLDER, `${slug}.md`))
    ) {
      slug = `${baseSlug}-${counter}`;
      counter += 1;
    }

    const relPath = path.posix.join(MASTER_SCRIPT_FOLDER, `${slug}.md`);
    const absPath = path.join(projectDir, MASTER_SCRIPT_FOLDER, `${slug}.md`);
    await fs.mkdir(path.dirname(absPath), { recursive: true });

    const id = crypto.randomUUID();
    const body = serializeMarkdownDocument({
      title: name,
      content: "",
      meta: { id },
    });
    await fs.writeFile(absPath, body, "utf8");

    const now = new Date().toISOString();
    return { id, name, path: relPath, createdAt: now, updatedAt: now };
  });

  ipcMain.handle("forge:read-script", async (_event, projectDir, scriptPath) => {
    const targetDir = requireProjectDir(projectDir);
    const safe = assertSecondaryScriptPath(scriptPath);
    const entry = await readMarkdownEntry(targetDir, safe, { kind: "secondary" });
    return {
      content: entry.content,
      title: entry.title,
      meta: entry.meta,
    };
  });

  ipcMain.handle("forge:write-script", async (_event, projectDir, scriptPath, payload = {}) => {
    const targetDir = requireProjectDir(projectDir);
    const safe = assertSecondaryScriptPath(scriptPath);
    const absPath = path.join(targetDir, safe);
    // Read-then-write so we preserve the existing frontmatter id; only
    // the body and title change. If the file is missing or unparseable,
    // mint a fresh id so callers don't have to.
    let existingMeta = {};
    let existingTitle = String(payload?.title || "").trim() || "Untitled";
    try {
      const raw = await fs.readFile(absPath, "utf8");
      const parsed = parseMarkdownDocument(raw, existingTitle);
      existingMeta = parsed.meta || {};
      if (!payload?.title && parsed.title) existingTitle = parsed.title;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const meta = { ...existingMeta };
    if (!meta.id) meta.id = crypto.randomUUID();
    delete meta.title; // serializeMarkdownDocument re-injects from `title` arg
    const body = serializeMarkdownDocument({
      title: existingTitle,
      content: String(payload?.content || ""),
      meta,
    });
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, body, "utf8");
    return { ok: true };
  });

  ipcMain.handle("forge:rename-script", async (_event, projectDir, scriptPath, newName) => {
    const targetDir = requireProjectDir(projectDir);
    const safe = assertSecondaryScriptPath(scriptPath);
    const trimmed = String(newName || "").trim().slice(0, 80);
    if (!trimmed) throw new Error("rename-script: name required.");

    const baseSlug = slugifyName(trimmed) || "script";
    let slug = baseSlug;
    let counter = 2;
    const sourceAbs = path.join(targetDir, safe);
    const sourceSlug = path.basename(safe, ".md");
    while (
      slug !== sourceSlug &&
      (slug === path.basename(MASTER_SCRIPT_FILE, ".md") ||
        nodeFs.existsSync(path.join(targetDir, MASTER_SCRIPT_FOLDER, `${slug}.md`)))
    ) {
      slug = `${baseSlug}-${counter}`;
      counter += 1;
    }
    const newRel = path.posix.join(MASTER_SCRIPT_FOLDER, `${slug}.md`);
    const newAbs = path.join(targetDir, MASTER_SCRIPT_FOLDER, `${slug}.md`);
    if (sourceAbs !== newAbs) {
      await fs.rename(sourceAbs, newAbs);
    }
    // Update the frontmatter title to match the new display name.
    try {
      const raw = await fs.readFile(newAbs, "utf8");
      const parsed = parseMarkdownDocument(raw, trimmed);
      const meta = { ...(parsed.meta || {}) };
      delete meta.title;
      if (!meta.id) meta.id = crypto.randomUUID();
      const body = serializeMarkdownDocument({
        title: trimmed,
        content: parsed.content,
        meta,
      });
      await fs.writeFile(newAbs, body, "utf8");
    } catch {
      // best-effort title sync; rename itself succeeded.
    }
    return { path: newRel, name: trimmed };
  });

  ipcMain.handle("forge:delete-script", async (_event, projectDir, scriptPath) => {
    const targetDir = requireProjectDir(projectDir);
    const safe = assertSecondaryScriptPath(scriptPath);
    const abs = path.join(targetDir, safe);
    try {
      await fs.unlink(abs);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return { ok: true };
  });


  // Custom subsection bootstrap. Slugifies the name → custom/<slug>/,
  // creates the folder + a hidden INSTRUCTIONS.md for non-Canon custom
  // panes, and returns the project-relative paths for the renderer to
  // persist on the CustomSubsection record.
  ipcMain.handle("forge:create-custom-subsection", async (_event, payload = {}) => {
    const projectDir = requireProjectDir(payload?.projectDir);
    const name = String(payload?.name || "").trim().slice(0, 80);
    if (!name) throw new Error("create-custom-subsection: name required.");
    const kind = ["docs", "gallery", "audio", "freeform", "script"].includes(payload?.kind)
      ? payload.kind
      : "freeform";
    const primary = ["story", "script", "assets", "workshop"].includes(payload?.primary)
      ? payload.primary
      : "story";
    const instructionsBody = String(payload?.instructions || "").trim();

    // Secondary-script branch — writes a single Master-Script-shaped file
    // (frontmatter id+title, then body) at `script/<slug>.md`, sibling to
    // the Master Script. No folder, no INSTRUCTIONS.md indirection: the
    // script file IS the subsection's instructionsPath. The renderer
    // dispatches read/write through `readScript` / `writeScript` IPCs so
    // the editor sees clean body and the on-disk frontmatter is preserved.
    if (kind === "script" && primary === "script") {
      const baseSlugScript = slugifyName(name) || "script";
      let slugScript = baseSlugScript;
      let counterScript = 2;
      const masterStem = path.basename(MASTER_SCRIPT_FILE, ".md");
      while (
        slugScript === masterStem ||
        nodeFs.existsSync(path.join(projectDir, MASTER_SCRIPT_FOLDER, `${slugScript}.md`))
      ) {
        slugScript = `${baseSlugScript}-${counterScript}`;
        counterScript += 1;
      }
      const scriptRel = path.posix.join(MASTER_SCRIPT_FOLDER, `${slugScript}.md`);
      const scriptAbs = path.join(projectDir, MASTER_SCRIPT_FOLDER, `${slugScript}.md`);
      await fs.mkdir(path.dirname(scriptAbs), { recursive: true });
      const body = serializeMarkdownDocument({
        title: name,
        content: "",
        meta: { id: crypto.randomUUID() },
      });
      await fs.writeFile(scriptAbs, body, "utf8");
      // folder = "script" so the renderer's listCustomSubsectionFiles
      // call returns sibling scripts (informational); instructionsPath
      // points at the actual script file the editor opens.
      return {
        folder: MASTER_SCRIPT_FOLDER,
        instructionsPath: scriptRel,
      };
    }

    const baseSlug = slugifyName(name) || "subsection";
    let slug = baseSlug;
    let counter = 2;
    while (nodeFs.existsSync(path.join(projectDir, "custom", slug))) {
      slug = `${baseSlug}-${counter}`;
      counter += 1;
    }

    const folderRel = path.posix.join("custom", slug);
    const folderAbs = path.join(projectDir, "custom", slug);
    await fs.mkdir(folderAbs, { recursive: true });

    const instructionsRel = path.posix.join(folderRel, "INSTRUCTIONS.md");
    const instructionsAbs = path.join(folderAbs, "INSTRUCTIONS.md");
    const seedTemplate = (() => {
      if (instructionsBody) return instructionsBody;
      if (primary === "script" && kind === "docs") {
        return `# ${name}\n\n`;
      }
      const kindBlurb = {
        docs: "Markdown documents. Treat each `.md` file as a free-form note. Use `read_file` to read individual docs and `write_file` to create or edit them.",
        gallery: "Image / video reference tiles. Place new files as `.png`, `.jpg`, `.webp`, or `.mp4`. The agent should treat these as visual reference, not script source.",
        audio: "Audio files (`.mp3`, `.wav`, `.m4a`, `.ogg`). Treat as a sound library — categorise by name, summarise via `summarize_audio` when needed.",
        freeform: "Any file type the user drops in. Read before assuming purpose; ask the user if unsure.",
      }[kind];
      return [
        `# ${name}`,
        "",
        `Custom subsection on the **${primary}** primary rail. Kind: \`${kind}\`.`,
        "",
        "## What lives here",
        "",
        kindBlurb,
        "",
        "## How the agent should handle this",
        "",
        "- Default to read before write.",
        "- When editing or generating files inside this folder, follow the conventions described in this doc.",
        "- If a request is ambiguous, ask the user before creating new files.",
        "",
        "## Notes for the user",
        "",
        "Edit this file freely. Anything you write here is what the agent will read on its next interaction with this subsection.",
        "",
      ].join("\n");
    })();
    await fs.writeFile(instructionsAbs, seedTemplate, "utf8");

    return {
      folder: folderRel,
      instructionsPath: instructionsRel,
    };
  });
  // Read a custom subsection's INSTRUCTIONS.md content (utf8 string).
  // Renderer uses this to preview the doc inside the placeholder pane.
  ipcMain.handle("forge:read-custom-subsection-instructions", async (_event, projectDir, instructionsPath) => {
    const targetDir = requireProjectDir(projectDir);
    const safeRel = String(instructionsPath || "").replace(/\\/g, "/").replace(/^\.?\//, "");
    if (!safeRel || safeRel.includes("..")) {
      throw new Error("read-custom-subsection-instructions: invalid path.");
    }
    const abs = path.join(targetDir, safeRel);
    try {
      return await fs.readFile(abs, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return "";
      throw error;
    }
  });
  ipcMain.handle(
    "forge:write-custom-subsection-instructions",
    async (_event, projectDir, instructionsPath, text) => {
      const targetDir = requireProjectDir(projectDir);
      const safeRel = String(instructionsPath || "").replace(/\\/g, "/").replace(/^\.?\//, "");
      if (!safeRel || safeRel.includes("..")) {
        throw new Error("write-custom-subsection-instructions: invalid path.");
      }
      const abs = path.join(targetDir, safeRel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, String(text || ""), "utf8");
      return { ok: true };
    },
  );
  ipcMain.handle(
    "forge:list-custom-subsection-files",
    async (_event, projectDir, folder, fileExtensions) => {
      const targetDir = requireProjectDir(projectDir);
      const safeRel = String(folder || "").replace(/\\/g, "/").replace(/^\.?\//, "");
      if (!safeRel || safeRel.includes("..")) {
        throw new Error("list-custom-subsection-files: invalid folder.");
      }
      const abs = path.join(targetDir, safeRel);
      let entries;
      try {
        entries = await fs.readdir(abs, { withFileTypes: true });
      } catch (error) {
        if (error?.code === "ENOENT") return { folder: safeRel, files: [] };
        throw error;
      }
      const allowed = Array.isArray(fileExtensions) && fileExtensions.length
        ? new Set(fileExtensions.map((ext) => String(ext).toLowerCase()))
        : null;
      const out = [];
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (entry.name.startsWith(".")) continue;
        if (entry.name === "INSTRUCTIONS.md") continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (allowed && !allowed.has(ext)) continue;
        const childAbs = path.join(abs, entry.name);
        let stat;
        try {
          stat = await fs.stat(childAbs);
        } catch {
          continue;
        }
        out.push({
          name: entry.name,
          path: path.posix.join(safeRel, entry.name),
          sizeBytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          createdAt: stat.birthtime.toISOString(),
          ext,
        });
      }
      // Sort by creation time ascending so the order reflects how docs
      // were added, not alphabetical filename order. Matters for the
      // Drafts seed (Draft → Character → Dialogue → Beat sheet) and for
      // any user-added doc which lands at the end of the list.
      // Falls back to filename when birthtimes tie at sub-ms granularity.
      out.sort((a, b) => {
        const dt = a.createdAt.localeCompare(b.createdAt);
        return dt !== 0 ? dt : a.name.localeCompare(b.name);
      });
      return { folder: safeRel, files: out };
    },
  );
  ipcMain.handle("forge:delete-custom-subsection", async (_event, projectDir, folder) => {
    const targetDir = requireProjectDir(projectDir);
    const safeRel = String(folder || "").replace(/\\/g, "/").replace(/^\.?\//, "");
    if (!safeRel || safeRel.includes("..") || !safeRel.startsWith("custom/")) {
      throw new Error("delete-custom-subsection: refusing to delete outside custom/.");
    }
    const abs = path.join(targetDir, safeRel);
    try {
      await fs.rm(abs, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return { ok: true };
  });
  // Read a single doc file inside a custom subsection. Path must stay
  // inside custom/ to keep the IPC from being a generic file reader.
  ipcMain.handle("forge:read-custom-subsection-doc", async (_event, projectDir, filePath) => {
    const targetDir = requireProjectDir(projectDir);
    const safeRel = String(filePath || "").replace(/\\/g, "/").replace(/^\.?\//, "");
    if (!safeRel || safeRel.includes("..") || !safeRel.startsWith("custom/")) {
      throw new Error("read-custom-subsection-doc: refusing to read outside custom/.");
    }
    const abs = path.join(targetDir, safeRel);
    try {
      return await fs.readFile(abs, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return "";
      throw error;
    }
  });
  ipcMain.handle(
    "forge:write-custom-subsection-doc",
    async (_event, projectDir, filePath, text) => {
      const targetDir = requireProjectDir(projectDir);
      const safeRel = String(filePath || "").replace(/\\/g, "/").replace(/^\.?\//, "");
      if (!safeRel || safeRel.includes("..") || !safeRel.startsWith("custom/")) {
        throw new Error("write-custom-subsection-doc: refusing to write outside custom/.");
      }
      const abs = path.join(targetDir, safeRel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, String(text || ""), "utf8");
      return { ok: true };
    },
  );
  // Create a new doc file inside the subsection's folder. Slugifies
  // the title, ensures uniqueness with a numeric suffix, returns the
  // project-relative path so the renderer can immediately select it.
  ipcMain.handle(
    "forge:create-custom-subsection-doc",
    async (_event, projectDir, folder, rawTitle) => {
      const targetDir = requireProjectDir(projectDir);
      const safeFolder = String(folder || "").replace(/\\/g, "/").replace(/^\.?\//, "");
      if (!safeFolder || safeFolder.includes("..") || !safeFolder.startsWith("custom/")) {
        throw new Error("create-custom-subsection-doc: refusing to write outside custom/.");
      }
      const title = String(rawTitle || "Untitled").trim().slice(0, 80) || "Untitled";
      const baseSlug = slugifyName(title) || "doc";
      const folderAbs = path.join(targetDir, safeFolder);
      await fs.mkdir(folderAbs, { recursive: true });
      const existingDocs = await fs.readdir(folderAbs).catch(() => []);
      const existingDocCount = existingDocs.filter((name) => /\.md$/i.test(name)).length;
      if (existingDocCount >= LOCAL_UI_LIMITS.customSubsectionDocs) {
        throw new Error(`This subsection is limited to ${LOCAL_UI_LIMITS.customSubsectionDocs} markdown docs. Merge or delete an older doc first.`);
      }
      let slug = baseSlug;
      let counter = 2;
      while (nodeFs.existsSync(path.join(folderAbs, `${slug}.md`))) {
        slug = `${baseSlug}-${counter}`;
        counter += 1;
      }
      const fileName = `${slug}.md`;
      const fileAbs = path.join(folderAbs, fileName);
      const stub = `# ${title}\n\n`;
      await fs.writeFile(fileAbs, stub, "utf8");
      return {
        path: path.posix.join(safeFolder, fileName),
        title,
        text: stub,
      };
    },
  );
  ipcMain.handle(
    "forge:rename-custom-subsection-doc",
    async (_event, projectDir, filePath, rawTitle) => {
      const targetDir = requireProjectDir(projectDir);
      const safeRel = String(filePath || "").replace(/\\/g, "/").replace(/^\.?\//, "");
      if (!safeRel || safeRel.includes("..") || !safeRel.startsWith("custom/") || path.extname(safeRel).toLowerCase() !== ".md") {
        throw new Error("rename-custom-subsection-doc: refusing to rename outside custom markdown docs.");
      }
      const title = String(rawTitle || "Untitled").trim().slice(0, 80) || "Untitled";
      const currentAbs = path.join(targetDir, safeRel);
      const folderRel = path.posix.dirname(safeRel);
      const folderAbs = path.dirname(currentAbs);
      const baseSlug = slugifyName(title) || "doc";
      let slug = baseSlug;
      let counter = 2;
      let nextAbs = path.join(folderAbs, `${slug}.md`);
      while (nodeFs.existsSync(nextAbs) && path.resolve(nextAbs) !== path.resolve(currentAbs)) {
        slug = `${baseSlug}-${counter}`;
        nextAbs = path.join(folderAbs, `${slug}.md`);
        counter += 1;
      }
      await fs.mkdir(folderAbs, { recursive: true });
      if (path.resolve(nextAbs) !== path.resolve(currentAbs)) {
        await fs.rename(currentAbs, nextAbs);
      }
      return {
        path: path.posix.join(folderRel, path.basename(nextAbs)),
        title: path.basename(nextAbs).replace(/\.md$/i, ""),
      };
    },
  );
  ipcMain.handle("forge:read-project-context", async (_event, projectDir, projectName) => {
    const targetDir = requireProjectDir(projectDir);
    const ctx = require("./project-context.cjs");
    return ctx.ensureProjectContext(targetDir, projectName);
  });
  ipcMain.handle("forge:write-project-context", async (_event, projectDir, text) => {
    const targetDir = requireProjectDir(projectDir);
    const ctx = require("./project-context.cjs");
    return ctx.writeProjectContext(targetDir, text);
  });
  ipcMain.handle("forge:read-agent-entrypoints", async (_event, projectDir) => {
    const targetDir = requireProjectDir(projectDir);
    const entrypoints = require("./agent-entrypoints.cjs");
    return entrypoints.ensureAgentEntrypoints(targetDir);
  });
  ipcMain.handle("forge:write-agent-entrypoint", async (_event, projectDir, fileName, text) => {
    const targetDir = requireProjectDir(projectDir);
    const entrypoints = require("./agent-entrypoints.cjs");
    return entrypoints.writeAgentEntrypoint(targetDir, fileName, text);
  });
  ipcMain.handle("forge:read-agent-note", async (_event, projectDir) => {
    const targetDir = requireProjectDir(projectDir);
    const entrypoints = require("./agent-entrypoints.cjs");
    return entrypoints.ensureAgentNote(targetDir);
  });
  ipcMain.handle("forge:write-agent-note", async (_event, projectDir, text) => {
    const targetDir = requireProjectDir(projectDir);
    const entrypoints = require("./agent-entrypoints.cjs");
    return entrypoints.writeAgentNote(targetDir, text);
  });
  ipcMain.handle("forge:list-review-files", async (_event, projectDir) => {
    const reviewDesk = require("./review-desk.cjs");
    return reviewDesk.listReviewFiles(normalizeProjectDir(projectDir));
  });
  ipcMain.handle("forge:read-review-file", async (_event, projectDir, target) => {
    const reviewDesk = require("./review-desk.cjs");
    return reviewDesk.readReviewFile(normalizeProjectDir(projectDir), target);
  });
  ipcMain.handle("forge:write-review-file", async (_event, projectDir, target, text) => {
    const reviewDesk = require("./review-desk.cjs");
    return reviewDesk.writeReviewFile(normalizeProjectDir(projectDir), target, text);
  });
  ipcMain.handle("forge:append-review-note", async (_event, projectDir, note) => {
    const targetDir = requireProjectDir(projectDir);
    const reviewDesk = require("./review-desk.cjs");
    return reviewDesk.appendReviewNote(targetDir, note);
  });
  ipcMain.handle("forge:read-section-convention", async (_event, projectDir, kind) => {
    const targetDir = requireProjectDir(projectDir);
    const sc = require("./section-conventions.cjs");
    return sc.ensureSectionConvention(targetDir, kind);
  });
  ipcMain.handle("forge:write-section-convention", async (_event, projectDir, kind, text) => {
    const targetDir = requireProjectDir(projectDir);
    const sc = require("./section-conventions.cjs");
    return sc.writeSectionConvention(targetDir, kind, text);
  });
  ipcMain.handle("forge:reset-section-convention", async (_event, projectDir, kind) => {
    const targetDir = requireProjectDir(projectDir);
    const sc = require("./section-conventions.cjs");
    return sc.resetSectionConvention(targetDir, kind);
  });
  ipcMain.handle("forge:read-asset-context-guide", async (_event, projectDir) => {
    const targetDir = requireProjectDir(projectDir);
    return readAssetContextGuideWithUrls(targetDir);
  });
  ipcMain.handle("forge:write-asset-context-guide", async (_event, projectDir, text) => {
    const targetDir = requireProjectDir(projectDir);
    const result = await magicDocs.writeAssetContextGuide(targetDir, text);
    invalidateAgentMagicDocSummary(targetDir);
    return result;
  });
  ipcMain.handle("forge:upload-asset-context-guide-references", async (_event, projectDir) => {
    const targetDir = requireProjectDir(projectDir);

    const result = await dialog.showOpenDialog({
      title: "Add Asset Context reference images",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "heic", "tiff"] },
      ],
    });
    if (result.canceled || !result.filePaths?.length) {
      return readAssetContextGuideWithUrls(targetDir);
    }

    const usedPaths = new Set();
    for (const sourcePath of result.filePaths) {
      let stat;
      try {
        stat = await fs.stat(sourcePath);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      const extension = await detectBinaryExtension(sourcePath, path.extname(sourcePath));
      if (!magicDocs.ASSET_CONTEXT_REFERENCE_EXTENSIONS.has(String(extension || "").toLowerCase())) {
        continue;
      }
      const baseSlug = slugifyName(path.basename(sourcePath, path.extname(sourcePath)) || "reference");
      const target = await nextAvailableAssetContextReferencePath(targetDir, baseSlug, extension, usedPaths);
      await fs.copyFile(sourcePath, target.absolutePath);
    }

    invalidateAgentMagicDocSummary(targetDir);
    return readAssetContextGuideWithUrls(targetDir);
  });
  ipcMain.handle("forge:add-asset-context-guide-reference-paths", async (_event, projectDir, relativePaths) => {
    const targetDir = requireProjectDir(projectDir);
    const paths = Array.isArray(relativePaths) ? relativePaths : [];
    const usedPaths = new Set();

    for (const rawPath of paths) {
      const relativePath = normalizeRelativePath(rawPath);
      if (!relativePath || relativePath.startsWith(".forge/asset-context/")) continue;
      const sourcePath = resolveProjectRelativePath(targetDir, relativePath);
      let stat;
      try {
        stat = await fs.stat(sourcePath);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      const extension = await detectBinaryExtension(sourcePath, path.extname(sourcePath));
      if (!magicDocs.ASSET_CONTEXT_REFERENCE_EXTENSIONS.has(String(extension || "").toLowerCase())) {
        continue;
      }
      const baseSlug = slugifyName(path.basename(sourcePath, path.extname(sourcePath)) || "reference");
      const target = await nextAvailableAssetContextReferencePath(targetDir, baseSlug, extension, usedPaths);
      await fs.copyFile(sourcePath, target.absolutePath);
    }

    invalidateAgentMagicDocSummary(targetDir);
    return readAssetContextGuideWithUrls(targetDir);
  });
  ipcMain.handle("forge:delete-asset-context-guide-reference", async (_event, projectDir, relativePath) => {
    const targetDir = requireProjectDir(projectDir);
    const targetPath = normalizeRelativePath(relativePath);
    if (!targetPath) throw new Error("Reference path is required.");
    if (!targetPath.startsWith(".forge/asset-context/references/")) {
      throw new Error("Only Asset Context reference files can be removed here.");
    }
    const absolute = resolveProjectRelativePath(targetDir, targetPath);
    try {
      await fs.unlink(absolute);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    invalidateAgentMagicDocSummary(targetDir);
    return readAssetContextGuideWithUrls(targetDir);
  });
  ipcMain.handle("forge:sync-magic-doc", async (_event, projectDir, name, force) => {
    const targetDir = requireProjectDir(projectDir);
    const magicName = String(name || "").trim();
    if (!magicName) throw new Error("Magic doc name is required.");
    const current = await readProject(targetDir);
    const result = await magicDocs.updateMagicDoc(targetDir, magicName, {
      callModel,
      force: Boolean(force),
      sessionKey: `${current.settings?.sessionKey || DEFAULT_OPENCLAW_SESSION_PREFIX}:magic:${magicDocs.slugify(magicName)}`,
      settings: current.settings,
    });
    invalidateAgentMagicDocSummary(targetDir);
    return {
      projectDir: targetDir,
      project: await readProject(targetDir),
      skipped: Boolean(result?.skipped),
      reason: String(result?.reason || ""),
      scopeErrors: Array.isArray(result?.scopeErrors) ? result.scopeErrors : [],
      scopeResolvedCount: Number(result?.scopeResolvedCount || 0),
    };
  });

  ipcMain.handle("forge:get-media-index", async (_event, projectDir) => {
    const media = require("./media.cjs");
    const targetDir = requireProjectDir(projectDir, "get-media-index: projectDir required.");
    const metadata = await readProject(targetDir);
    const index = await media.buildMediaIndex(targetDir);
    const withRefs = media.computeReferences(metadata, index);
    await media.writeMediaIndex(targetDir, withRefs);
    return withRefs;
  });

  // Attach an indexed media file to a character / location / prop /
  // keyframe / audio entry by adding it to the entity's `media` array.
  // Renderer-level wrapper around the `attach_media` tool so the Media
  // panel UI can offer a direct "Attach to entity" action without
  // asking the agent. Mode defaults to 'reference' (no copy); 'copy'
  // duplicates the file into assets/<section>/ first.
  ipcMain.handle("forge:attach-media", async (_event, projectDir, mediaId, section, entityId, mode) => {
    const attached = await attachMediaEntries(projectDir, [
      { mediaId, section, entityId, mode: mode || "reference" },
    ]);
    const first = attached.results[0];
    if (!first?.ok) {
      throw new Error(first?.error || "attach_media failed.");
    }
    return {
      result: first.result,
      project: attached.project,
    };
  });

  ipcMain.handle("forge:attach-media-batch", async (_event, projectDir, items) => {
    return attachMediaEntries(projectDir, items);
  });

  ipcMain.handle("forge:get-pinboard", async (_event, projectDir) => {
    const targetDir = requireProjectDir(projectDir);
    const memory = require("./memory.cjs");
    return memory.readPinboard(targetDir);
  });

  ipcMain.handle("forge:update-pinboard", async (_event, projectDir, entries) => {
    const targetDir = requireProjectDir(projectDir);
    // Validate before writing — bad shape from the renderer would silently
    // corrupt pinboard.json otherwise. Hard requirements (id / text /
    // confirmed / createdAt) fail loudly; missing-but-recoverable fields
    // (updatedAt / category / scope) get filled with sensible defaults so
    // manually-edited pinboard.json files don't brick project open.
    if (!Array.isArray(entries)) {
      throw new Error("update-pinboard: entries must be an array.");
    }
    const seenIds = new Set();
    const normalized = entries.map((entry) => {
      if (!entry || typeof entry !== "object") {
        throw new Error("update-pinboard: each entry must be an object.");
      }
      if (typeof entry.id !== "string" || !entry.id.trim()) {
        throw new Error("update-pinboard: entry.id is required.");
      }
      if (seenIds.has(entry.id)) {
        throw new Error(`update-pinboard: duplicate entry.id ${entry.id}.`);
      }
      seenIds.add(entry.id);
      if (typeof entry.text !== "string" || !entry.text.trim()) {
        throw new Error(`update-pinboard: entry.text is required (id=${entry.id}).`);
      }
      if (typeof entry.confirmed !== "boolean") {
        throw new Error(`update-pinboard: entry.confirmed must be a boolean (id=${entry.id}).`);
      }
      if (typeof entry.createdAt !== "string" || !entry.createdAt) {
        throw new Error(`update-pinboard: entry.createdAt is required (id=${entry.id}).`);
      }
      return {
        ...entry,
        category: typeof entry.category === "string" && entry.category ? entry.category : "fact",
        scope: typeof entry.scope === "string" && entry.scope ? entry.scope : "project",
        updatedAt:
          typeof entry.updatedAt === "string" && entry.updatedAt
            ? entry.updatedAt
            : entry.createdAt,
      };
    });
    const memory = require("./memory.cjs");
    await memory.writePinboard(targetDir, normalized);
    await memory.syncPinboardToIndex(targetDir, normalized);
  });

  ipcMain.handle("forge:repair-project", async (_event, projectDir) => {
    const dir = requireProjectDir(projectDir, "Project path required.");
    const repairs = [];

    // 1. Deduplicate assets by name within each section
    const raw = await fs.readFile(projectFilePath(dir), "utf8");
    const metadata = JSON.parse(raw);
    const ASSET_KEYS = ["characters", "locations", "props", "keyframes", "audio"];
    for (const key of ASSET_KEYS) {
      const items = Array.isArray(metadata[key]) ? metadata[key] : [];
      const seen = new Map();
      const deduped = [];
      for (const item of items) {
        const slug = slugifyName(item?.name || item?.title || "");
        if (!slug) { deduped.push(item); continue; }
        if (seen.has(slug)) {
          // Merge media into the first occurrence
          const first = seen.get(slug);
          const existingPaths = new Set((first.media || []).map((m) => m.path));
          for (const m of item.media || []) {
            if (!existingPaths.has(m.path)) first.media.push(m);
          }
          repairs.push(`${key}: merged duplicate "${item.name || item.title}"`);
        } else {
          seen.set(slug, item);
          deduped.push(item);
        }
      }
      metadata[key] = deduped;
    }

    // 2. Remove orphan prompt→shot references
    // (prompts live in files, not project.json — skip for now)

    // 3. Write repaired metadata + rebuild index
    if (repairs.length > 0) {
      metadata.project = { ...(metadata.project || {}), updatedAt: new Date().toISOString() };
      await atomicWriteProjectJson(dir, metadata);
    }

    // 4. Full re-read from disk (catches stale content)
    invalidateAgentMagicDocSummary(dir);
    const refreshed = await readProject(dir);
    return { repairs, repairCount: repairs.length, project: refreshed };
  });

  ipcMain.handle("forge:cancel-agent", (event, requestId) => {
    const controller = activeAgentAborts.get(requestId);
    if (controller) {
      controller.abort();
      activeAgentAborts.delete(requestId);
    }
  });

  ipcMain.handle("forge:ask-agent", async (event, requestId, settings, payload) => {
    const projectDir = requireProjectDir(
      payload?.context?.project?.dir,
      "forge:ask-agent requires a project directory.",
    );

    if (detectDistillationRequest(payload?.message || "").blocked) {
      return {
        reply: APP_EXTRACTION_REFUSAL,
        actions: [],
        turnCount: 0,
        terminated: "blocked",
        meta: null,
      };
    }

    const controller = new AbortController();
    activeAgentAborts.set(requestId, controller);

    const emit = (agentEvent) => {
      if (event.sender.isDestroyed()) return;
      const safeEvent = sanitizeAgentEventForRenderer(agentEvent);
      if (!safeEvent) return;
      event.sender.send("forge:agent-event", { requestId, event: safeEvent });
    };

    const projectShape = payload?.context?.projectShape || {
      scenes: 0,
      beats: 0,
      shots: 0,
      prompts: 0,
      assets: 0,
    };

    const toolCatalog = tools.listTools();
    // Each context source below loads independently. A failure in one
    // (corrupt file, partial write, permission glitch) shouldn't block
    // the whole agent run — the run can proceed with empty context for
    // that source. But silent catches were hiding these failures so
    // degraded agent runs looked normal. Log non-ENOENT errors so we
    // can spot real corruption in production. ENOENT stays silent
    // because most of these sources are lazily created by the agent
    // itself on first write.
    const warnContextLoad = (label, err) => {
      if (!err || err.code === "ENOENT") return;
      const message = err.message || String(err);
      console.warn(`[agent-prompt] ${label} load failed: ${message}`);
    };
    let memoryText = "";
    try {
      memoryText = await require("./memory.cjs").readIndex(projectDir);
    } catch (err) { warnContextLoad("memory", err); }
    let conventionsText = "";
    try {
      conventionsText = await require("./conventions.cjs").ensureConventions(projectDir);
    } catch (err) { warnContextLoad("conventions", err); }
    let projectContextText = "";
    try {
      projectContextText = await require("./project-context.cjs").ensureProjectContext(
        projectDir,
        payload?.context?.project?.name || path.basename(projectDir),
      );
    } catch (err) { warnContextLoad("project-context", err); }
    let agentNoteText = "";
    try {
      agentNoteText = (await require("./agent-entrypoints.cjs").ensureAgentNote(projectDir))?.content || "";
    } catch (err) { warnContextLoad("agent-note", err); }
    let storySystemText = "";
    try {
      storySystemText = await require("./story-system.cjs").ensureStorySystem(projectDir);
    } catch (err) { warnContextLoad("story-system", err); }
    let magicDocEntries = [];
    try {
      magicDocEntries = await getAgentMagicDocSummary(projectDir);
    } catch (err) { warnContextLoad("magic-docs", err); }
    let assetContextGuide = null;
    try {
      // Load the shared Asset Context only when the user has actually created
      // or edited it. This keeps fresh projects clean while making the doc
      // real agent context once it exists.
      await fs.access(magicDocs.assetContextGuideFile(projectDir));
      const guide = await readAssetContextGuideWithUrls(projectDir);
      const guideText = String(guide?.content || "").trim();
      const guideReferences = Array.isArray(guide?.references) ? guide.references : [];
      if (guideText || guideReferences.length > 0) {
        assetContextGuide = guide;
      }
    } catch (err) {
      if (err?.code !== "ENOENT") warnContextLoad("asset-context", err);
    }
    let sectionConventions = {};
    try {
      sectionConventions = await require("./section-conventions.cjs").ensureAll(projectDir);
    } catch (err) { warnContextLoad("section-conventions", err); }

    const agentCtxModule = require("./agent-context.cjs");
    const agent = await agentCtxModule.buildAgentContext(projectDir);

    const rawFocusLock = payload?.context?.focusLock;
    const focusLock = rawFocusLock && typeof rawFocusLock === "object" && rawFocusLock.kind && rawFocusLock.kind !== "none"
      ? rawFocusLock
      : typeof rawFocusLock === "string" && rawFocusLock.trim()
        ? { kind: "file", path: rawFocusLock.trim() }
        : null;
    const classifierHint =
      payload?.context?.intent && typeof payload.context.intent === "object"
        ? payload.context.intent
        : null;
    let methodDirective = null;
    try {
      methodDirective = await callMethodDirectiveServer({
        settings,
        payload: buildMethodDirectiveRequest({ payload, projectDir, projectShape }),
        signal: controller.signal,
      });
    } catch (err) {
      warnContextLoad("method-directive", err);
    }
    const agentPromptState = {
      projectName: payload?.context?.project?.name,
      projectDir,
      projectShape,
      selectionPath: payload?.context?.selection?.path,
      attachments: Array.isArray(payload?.context?.attachments) ? payload.context.attachments : [],
      memory: memoryText,
      conventions: conventionsText,
      projectContext: projectContextText,
      agentNote: agentNoteText,
      storySystem: storySystemText,
      sectionConventions,
      magicDocs: magicDocEntries,
      assetContextGuide,
      projectOutline: agent.snapshot.outline,
      focusLock,
      intent: classifierHint?.id || null,
      intentReason: classifierHint?.reason || null,
      primaryEntityId: classifierHint?.entityId || null,
      apiProviders: Array.isArray(settings?.apiProviders) ? settings.apiProviders : [],
      anvilCredits: settings?.anvilCredits || {},
      mediaModels: settings?.mediaModels || {},
      agentMediaStaging: settings?.agentMediaStaging,
      methodDirective,
    };
    const systemPrompt = isRemoteAgentConfigured(settings)
      ? buildDynamicFrame(agentPromptState)
      : buildSystemPrompt(toolCatalog, agentPromptState);

    const agentSessionKey = (() => {
      const base =
        typeof settings?.sessionKey === "string" && settings.sessionKey.trim()
          ? settings.sessionKey.trim()
          : "hook:shotforge:forge";
      return base.endsWith(":agent") ? base : `${base}:agent`;
    })();

    // Load prior session turns so the agent sees a real conversation
    // instead of a stateless one-shot. The current local runtimes
    // still flatten this into the legacy prompt path, but keeping the
    // structured history here preserves continuity and future-proofs
    // the transport boundary.
    let priorTurns = [];
    try {
      priorTurns = await loadAgentPriorTurns(
        projectDir,
        agentSessionKey,
        payload?.message || "",
      );
    } catch {
      // History read failure shouldn't abort the turn — agent just
      // runs stateless like before.
    }

    try {
      const result = await runForgeAgent({
        projectDir,
        userMessage: payload?.message || "",
        systemPrompt,
        toolCatalog,
        sessionKey: agentSessionKey,
        settings,
        priorTurns,
        callModel,
        runTool: async (name, args, toolContext) => {
          // Focus-mode lock: scope-aware enforcement via path prefixes (NOT
          // frozen path lists). The renderer sends payload.context.focusLock
          // as a FocusScope object. Read tools stay unrestricted; write tools
          // are checked against a predicate derived from the scope — so a
          // child path that didn't exist when the lock was set (e.g. a new
          // shot being created under a scene lock) stays within scope.
          if (focusLock && focusLock.kind !== "none") {
            const { buildScopePredicate, describeScope, normalizePath, suggestExtension } = require("./focus-lock.cjs");
            const { listMutatingToolNames } = require("./system/tools/builtins.cjs");
            const WRITE_TOOL_NAMES = listMutatingToolNames();

            if (focusLock.kind === "readonly") {
              if (WRITE_TOOL_NAMES.has(name)) {
                throw new Error(`read-only mode: ${name} refused — release the read-only lock to allow writes.`);
              }
            } else if (WRITE_TOOL_NAMES.has(name)) {
              const paths = [];
              if (typeof args?.path === "string") paths.push(normalizePath(args.path));
              if (Array.isArray(args?.paths)) {
                for (const p of args.paths) if (typeof p === "string") paths.push(normalizePath(p));
              }
              if (Array.isArray(args?.items)) {
                for (const item of args.items) {
                  if (item?.from) paths.push(normalizePath(item.from));
                  if (item?.to) paths.push(normalizePath(item.to));
                }
              }

              const isInScope = buildScopePredicate(focusLock);
              const noPath = paths.length === 0;
              const allAllowed = paths.length > 0 && paths.every(isInScope);

              if (noPath || !allAllowed) {
                // M5 — suggest the next-wider scope based on what was
                // attempted. If the user was trying to write into a shot
                // while file-locked, suggesting they extend to the parent
                // scene is more useful than just "release."
                const suggestion = paths.length
                  ? suggestExtension(focusLock, paths[0])
                  : "release the lock";
                throw new Error(
                  `focus lock: agent is locked to ${describeScope(focusLock)} — ${name}${paths.length ? ` attempted ${paths.join(", ")}` : ""} refused. To proceed: ${suggestion}.`,
                );
              }
            }
          }
          // Permission critic — reject 'blocked' classifications; pass through
          // 'confirm' with a warning attached to the result envelope.
          const { classifyToolCall } = require("./permission-critic.cjs");
          const verdict = classifyToolCall(name, args);
          if (verdict.risk === "blocked") {
            throw new Error(`permission critic blocked ${name}: ${verdict.reason}`);
          }
          // Per-run memoization for non-mutating tools. NEVER_CACHE_TOOLS
          // (e.g. announce_intent) bypass the cache because they have UI
          // side effects that must fire on every invocation — even when
          // the agent calls them twice with identical args in one turn.
          if (!agentCtxModule.NEVER_CACHE_TOOLS.has(name)) {
            const cached = agent.cache.get(name, args);
            if (cached !== undefined) {
              return { ...cached, cached: true };
            }
          }
          const toolResult = await tools.runTool(name, args, {
            ...toolContext,
            selection: payload?.context?.selection || null,
            settings,
            sessionKey: agentSessionKey,
            signal: controller.signal,
            agent,
            // Push granular Workshop NLE updates to the renderer so
            // multi-step agent edits become visible as they happen,
            // instead of only after the disk-watcher fires the full
            // project reload (which is still the safety net).
            emitTimelineEvent: toolContext?.projectDir
              ? makeTimelineEventEmitter(toolContext.projectDir)
              : undefined,
            emitInboxEvent: toolContext?.projectDir
              ? makeInboxEventEmitter(toolContext.projectDir)
              : undefined,
          });
          if (verdict.risk === "confirm" && toolResult && typeof toolResult === "object" && !Array.isArray(toolResult)) {
            toolResult._confirmRisk = { reason: verdict.reason };
          }
          const skipCacheStore =
            agentCtxModule.MUTATING_TOOLS.has(name)
            || agentCtxModule.NEVER_CACHE_TOOLS.has(name);
          if (!skipCacheStore && toolResult && !toolResult.ok && toolResult.ok !== false) {
            agent.cache.set(name, args, toolResult);
          } else if (!skipCacheStore && toolResult && toolResult.ok !== false) {
            agent.cache.set(name, args, toolResult);
          }
          agentCtxModule.applyPostToolInvalidation(agent, name, args, toolResult);
          // After mutating tools, rebuild the index so subsequent reads
          // in the same turn see consistent state.
          if (agentCtxModule.MUTATING_TOOLS.has(name)) {
            try {
              await require("./system/tools/builtins.cjs").runTool("refresh_project_index", {}, { projectDir });
            } catch {}
          }
          return toolResult;
        },
        onEvent: emit,
        signal: controller.signal,
      });
      return sanitizeAgentRunResultForRenderer(result);
    } finally {
      activeAgentAborts.delete(requestId);
    }
  });

  if (process.platform === "darwin") {
    const template = [
      {
        label: APP_DISPLAY_NAME,
        submenu: [
          { role: "about" },
          { type: "separator" },
          { role: "hide", label: `Hide ${APP_DISPLAY_NAME}` },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit", label: `Quit ${APP_DISPLAY_NAME}` },
        ],
      },
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "forceReload" },
          ...(!app.isPackaged ? [{ role: "toggleDevTools" }] : []),
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      { role: "windowMenu" },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  createWindow();

  app.on("activate", () => {
    const existing = getExistingMainWindow();
    if (existing) {
      revealWindow(existing);
    } else {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
