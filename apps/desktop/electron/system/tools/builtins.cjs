const fs = require("node:fs/promises");
const { existsSync } = require("node:fs");
const { execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const { atomicWriteFile, withWriteLock } = require("../../atomic-write.cjs");
const { readPromptPrevId } = require("../../continuity.cjs");
const {
  sortPromptEntriesByStoryOrder,
  sortSceneEntriesByScriptOrder,
} = require("../../scene-order.cjs");
const {
  readDurationSec,
  resolveSceneLink,
} = require("../../script-metadata.cjs");

// Retired 2026-04-18:
//   - electron/evolink.cjs (EvoLink API wrapper)
//   - electron/topview.cjs (Topview CLI wrapper)
//   - electron/jobs.cjs (background-job queue; only consumed the
//     two provider wrappers)
//   - system/tools/media.cjs (old background generation launchers)
//   - system/tools/jobs-tools.cjs (check_job / list_jobs / cancel_job
//     / resume_job plus the three start_*_generation background
//     launchers — the whole file existed to drive gen jobs)
// Current synchronous media tools live in evolink-gen.cjs and are gated
// by per-provider capability settings instead of the retired job queue.

const registerFilesystemTools = require("./filesystem.cjs");
const registerProjectTools = require("./project.cjs");
const registerAssetTools = require("./assets.cjs");
// asset-groups-tools.cjs deleted in the 2026-05-04 bloat-cuts pass —
// AssetGroup feature (concept-grouping of separate asset entries with
// primaryMemberId / memberIds) was built for a future asset-variant
// workflow that never landed in the launch wedge. The 7 group_* tools
// + UI state added complexity without a real user surface.
const registerUnderstandingTools = require("./understanding.cjs");
const registerProactiveTools = require("./proactive.cjs");
const registerMagicDocsTools = require("./magic-docs.cjs");
const registerSkillTools = require("./skills.cjs");
const registerImageTools = require("./images.cjs");
const registerMediaIndexTools = require("./media-index.cjs");
const registerShellTools = require("./shell.cjs");
const registerMetaTools = require("./meta.cjs");
const registerPrefetchTools = require("./prefetch.cjs");
const registerEvolinkGenTools = require("./evolink-gen.cjs");
const registerReferenceStagingTools = require("./reference-staging.cjs");
const registerVideoTools = require("./videos-tools.cjs");
const registerTimelineTools = require("./timeline-tools.cjs");

const MAX_TOOL_RESULT_CHARS = 20000;
const DEFAULT_TIER = "core";
const SHELL_COMMAND_ALLOWLIST = new Set([
  "npm", "pnpm", "yarn", "node", "npx",
  "git",
  "ls", "cat", "echo", "pwd", "which", "file", "stat", "date", "uname", "wc", "head", "tail", "find", "du",
  "tsc", "vitest", "jest",
  "rg", "grep",
  "ffprobe", "ffmpeg", "sips", "identify", "convert",
]);
const SHELL_COMMAND_TIMEOUT_MS = 60_000;
const SHELL_MAX_BUFFER = 4 * 1024 * 1024;
const SEARCHABLE_TEXT_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".txt",
  ".json",
  ".toml",
  ".yaml",
  ".yml",
  ".js",
  ".cjs",
  ".mjs",
  ".ts",
  ".tsx",
  ".css",
  ".html",
  ".csv",
]);
const IMAGE_ASSET_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".png",
  ".tif",
  ".tiff",
  ".webp",
]);
const AUDIO_ASSET_EXTENSIONS = new Set([
  ".aac",
  ".aiff",
  ".m4a",
  ".mp3",
  ".wav",
]);
const CORE_PROJECT_TEXT_ROOTS = ["story", "script", "custom", "scenes", "shots", "prompts", ".forge"];
const RG_BIN_CANDIDATES = [
  process.env.RG_BIN,
  "/opt/homebrew/bin/rg",
  "/usr/local/bin/rg",
  "/usr/bin/rg",
].filter(Boolean);

const registry = new Map();
let cachedToolCatalog = null;
let cachedRgBin;

function resolveRgBin() {
  if (cachedRgBin !== undefined) return cachedRgBin;
  for (const candidate of RG_BIN_CANDIDATES) {
    if (existsSync(candidate)) {
      cachedRgBin = candidate;
      return cachedRgBin;
    }
  }
  cachedRgBin = null;
  return cachedRgBin;
}

function capToolResult(result) {
  const json = JSON.stringify(result);
  if (json.length <= MAX_TOOL_RESULT_CHARS) return result;
  return {
    truncated: true,
    originalSize: json.length,
    preview: json.slice(0, MAX_TOOL_RESULT_CHARS),
    note: `Result exceeded ${MAX_TOOL_RESULT_CHARS} chars and was truncated. Narrow the query or request a specific subset.`,
  };
}

function parseFrontmatter(raw) {
  const text = typeof raw === "string" ? raw : "";
  if (!text.startsWith("---\n")) return { meta: {}, body: text };
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return { meta: {}, body: text };
  const metaBlock = text.slice(4, end);
  const body = text.slice(end + 5);
  const meta = {};
  for (const line of metaBlock.split("\n")) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (key) meta[key] = value;
  }
  return { meta, body };
}

function resolveInside(projectDir, relativePath) {
  const normalized = String(relativePath || "").replace(/\\/g, "/").trim();
  if (!normalized) {
    throw new Error("Relative path is required.");
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

function projectFilePath(projectDir) {
  return path.join(projectDir, ".forge", "project.json");
}

function projectIndexPath(projectDir) {
  return path.join(projectDir, ".forge", "index.json");
}

function normalizeRelativePath(relativePath) {
  return String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function normalizeProjectMediaPath(projectDir, mediaPath) {
  const rawPath = String(mediaPath || "").trim();
  if (!rawPath) return "";

  if (path.isAbsolute(rawPath)) {
    try {
      const root = path.resolve(projectDir);
      const absolute = path.resolve(rawPath);
      if (absolute === root) return "";
      if (!absolute.startsWith(`${root}${path.sep}`)) return "";
      return normalizeRelativePath(path.relative(root, absolute));
    } catch {
      return "";
    }
  }

  return normalizeRelativePath(rawPath);
}

function assetDirectory(projectDir, section) {
  return resolveInside(projectDir, `assets/${section}`);
}

function absoluteProjectMediaPath(projectDir, mediaPath) {
  const relativePath = normalizeProjectMediaPath(projectDir, mediaPath);
  if (!relativePath) return "";
  try {
    return resolveInside(projectDir, relativePath);
  } catch {
    return "";
  }
}

function truncateText(text, maxChars = 12000) {
  const value = typeof text === "string" ? text : String(text || "");
  if (value.length <= maxChars) {
    return { content: value, truncated: false };
  }
  const keepHead = Math.max(0, Math.floor(maxChars * 0.75));
  const keepTail = Math.max(0, maxChars - keepHead);
  return {
    content: `${value.slice(0, keepHead).trimEnd()}\n\n[truncated]\n\n${value.slice(-keepTail).trimStart()}`,
    truncated: true,
  };
}

// Cap slug length to keep generated filenames under the 255-byte APFS /
// ext4 limit. Scene/shot/prompt paths nest (e.g.
// `prompts/scene-NN-<slug>/prompt-NN-<slug>.md`), so 80 chars per slug
// leaves headroom even for the deepest three-segment paths. Pathological
// titles (e.g. a paragraph pasted as a scene title) otherwise crash
// fs.writeFile with ENAMETOOLONG.
const MAX_SLUG_LEN = 80;
function slugifyName(value) {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return "generated";
  if (slug.length <= MAX_SLUG_LEN) return slug;
  // Trim at a word boundary so we don't leave a trailing "-".
  return slug.slice(0, MAX_SLUG_LEN).replace(/-+$/g, "") || slug.slice(0, MAX_SLUG_LEN);
}

function titleCaseSlug(value) {
  return String(value || "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Generated";
}

function stemToTitle(stem) {
  return String(stem || "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim() || "Untitled";
}

function titleFromRelativePath(relativePath) {
  return stemToTitle(path.posix.basename(relativePath, path.posix.extname(relativePath)));
}

function titleFromMarkdownContent(raw, fallbackTitle) {
  const text = typeof raw === "string" ? raw : "";
  const headingMatch = text.match(/^\s*#\s+(.+?)\s*$/m);
  if (headingMatch?.[1]) {
    return headingMatch[1].trim();
  }
  return fallbackTitle;
}

function pickAssetName(assetName, fallback) {
  return String(assetName || "").trim() || titleCaseSlug(slugifyName(fallback));
}

function stripAssetDocumentPaths(metadata) {
  const next = { ...metadata };
  for (const section of assetSections()) {
    const entries = Array.isArray(metadata?.[section]) ? metadata[section] : [];
    next[section] = entries.map((entry) => ({
      ...entry,
      path: "",
    }));
  }
  return next;
}

async function readProjectMetadata(projectDir) {
  const raw = await fs.readFile(projectFilePath(projectDir), "utf8");
  const parsed = JSON.parse(raw);
  const metadata = parsed && typeof parsed === "object" ? parsed : {};
  return stripAssetDocumentPaths(metadata);
}

// User-toggled per-path read-only flag persisted in project.readOnlyPaths.
// Distinct from the in-memory FocusScope (which is a per-session focus
// mechanism, not stored in project.json). Mutating tools call
// `assertWritablePath` before writing so a single check protects every
// edit path. The default seed for new/upgraded projects is ["ANVIL.md"]
// — see normalizeProjectMetadata in main.cjs for the seed logic. Empty
// array means the user deliberately unlocked everything.
async function readReadOnlyPathsFromDisk(projectDir) {
  try {
    const metadata = await readProjectMetadata(projectDir);
    if (Array.isArray(metadata?.readOnlyPaths)) {
      const out = new Set();
      for (const value of metadata.readOnlyPaths) {
        if (typeof value === "string" && value.trim()) {
          out.add(value.trim().replace(/\\/g, "/").replace(/^\/+/, ""));
        }
      }
      return out;
    }
    // Missing field → seed default. Matches normalizeProjectMetadata.
    return new Set(["ANVIL.md"]);
  } catch {
    return new Set();
  }
}

async function assertWritablePath(projectDir, relativePath, action = "write") {
  const normalized = String(relativePath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  if (!normalized) return;
  const locked = await readReadOnlyPathsFromDisk(projectDir);
  if (locked.has(normalized)) {
    const error = new Error(
      `Read-only — "${normalized}" is locked by the user. Toggle Read-only off in the inspector header before ${action}.`,
    );
    error.code = "READ_ONLY";
    error.path = normalized;
    throw error;
  }
}

async function readProjectIndex(projectDir) {
  const raw = await fs.readFile(projectIndexPath(projectDir), "utf8");
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === "object" ? parsed : {};
}

// Asset CRUD tools (create_asset_entry, delete_asset_entry, attach_media,
// detach_media, link_library_assets, sync_assets_from_disk, etc.) all do
// read→modify→write on project.json via this helper. Pre-fix this was a
// direct fs.writeFile that bypassed both main.cjs's atomicWriteProjectJson
// (.tmp + rename + .bak rotation) and its writeProjectQueues per-project
// serialization, so parallel tool calls in one agent turn (Promise.all
// dispatch in agent-loop.cjs) raced and lost entries OR crashed with
// ENOENT — same shape as the pinboard C1 from earlier today, on the
// project's most valuable file. Audit asset-C1 (2026-04-20).
//
// The lock key `project:<projectDir>` matches the one main.cjs uses for
// renderer-IPC writes, so tool writes and renderer saves serialize
// against each other (no cross-channel clobber).
async function writeProjectMetadata(projectDir, metadata) {
  return withWriteLock(`project:${projectDir}`, async () => {
    const file = projectFilePath(projectDir);
    const payload = JSON.stringify(metadata, null, 2);
    // Validate before writing — guards against circular refs / bad
    // serializers leaking non-JSON values that would corrupt the file.
    try { JSON.parse(payload); }
    catch (error) {
      throw new Error(
        `writeProjectMetadata: refusing to write unparseable JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // Rotate current → .bak (best-effort; missing on first write is fine)
    // BEFORE writing the new content. Matches main.cjs:atomicWriteProjectJson
    // recovery contract that readProject relies on.
    const bakFile = `${file}.bak`;
    try { await fs.rename(file, bakFile); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    await atomicWriteFile(file, payload);
  });
}

function buildProjectIndexSummary(projectIndex) {
  return {
    counts: {
      story: Array.isArray(projectIndex?.story) ? projectIndex.story.length : 0,
      scenes: Array.isArray(projectIndex?.scenes) ? projectIndex.scenes.length : 0,
      beats: Array.isArray(projectIndex?.beats) ? projectIndex.beats.length : 0,
      shots: Array.isArray(projectIndex?.shots) ? projectIndex.shots.length : 0,
      prompts: Array.isArray(projectIndex?.prompts) ? projectIndex.prompts.length : 0,
      characters: Array.isArray(projectIndex?.assets?.characters) ? projectIndex.assets.characters.length : 0,
      locations: Array.isArray(projectIndex?.assets?.locations) ? projectIndex.assets.locations.length : 0,
      props: Array.isArray(projectIndex?.assets?.props) ? projectIndex.assets.props.length : 0,
      keyframes: Array.isArray(projectIndex?.assets?.keyframes) ? projectIndex.assets.keyframes.length : 0,
      audio: Array.isArray(projectIndex?.assets?.audio) ? projectIndex.assets.audio.length : 0,
      customSections: Array.isArray(projectIndex?.customSections) ? projectIndex.customSections.length : 0,
    },
    story: Array.isArray(projectIndex?.story) ? projectIndex.story : [],
    masterScript: projectIndex?.masterScript || null,
    scenes: Array.isArray(projectIndex?.scenes) ? projectIndex.scenes : [],
    beats: Array.isArray(projectIndex?.beats) ? projectIndex.beats : [],
    shots: Array.isArray(projectIndex?.shots) ? projectIndex.shots : [],
    prompts: Array.isArray(projectIndex?.prompts) ? projectIndex.prompts : [],
    assets: projectIndex?.assets || {
      characters: [],
      locations: [],
      props: [],
      keyframes: [],
      audio: [],
    },
    customSections: Array.isArray(projectIndex?.customSections) ? projectIndex.customSections : [],
  };
}

function parsePositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseNonNegativeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function indexedProjectTextPaths(projectIndex) {
  const paths = new Set([".forge/project.json", ".forge/index.json"]);
  for (const entry of Array.isArray(projectIndex?.story) ? projectIndex.story : []) {
    if (entry?.path) paths.add(normalizeRelativePath(entry.path));
  }
  if (projectIndex?.masterScript?.path) {
    paths.add(normalizeRelativePath(projectIndex.masterScript.path));
  }
  for (const key of ["scenes", "beats", "shots", "prompts"]) {
    for (const entry of Array.isArray(projectIndex?.[key]) ? projectIndex[key] : []) {
      if (entry?.path) paths.add(normalizeRelativePath(entry.path));
    }
  }
  for (const entry of Array.isArray(projectIndex?.customSections) ? projectIndex.customSections : []) {
    if (entry?.instructionsPath) paths.add(normalizeRelativePath(entry.instructionsPath));
  }
  return Array.from(paths);
}

function isSearchableTextPath(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const basename = path.posix.basename(normalized);
  if (basename.startsWith(".")) {
    return basename === "project.json" || basename === "index.json";
  }
  return SEARCHABLE_TEXT_EXTENSIONS.has(path.posix.extname(normalized).toLowerCase());
}

function searchProjectIndex(projectIndex, query, max) {
  const normalizedQuery = String(query || "").trim().toLowerCase();
  if (!normalizedQuery) return [];

  const matches = [];
  const pushMatch = (section, entry, fields) => {
    for (const [field, rawValue] of fields) {
      const value = String(rawValue || "");
      if (!value) continue;
      if (!value.toLowerCase().includes(normalizedQuery)) continue;
      matches.push({
        kind: "index",
        section,
        field,
        path: entry?.path || null,
        lineNumber: null,
        line: value.slice(0, 400),
      });
      break;
    }
  };

  for (const entry of Array.isArray(projectIndex?.story) ? projectIndex.story : []) {
    pushMatch("story", entry, [["title", entry?.title], ["path", entry?.path], ["id", entry?.id]]);
    if (matches.length >= max) return matches.slice(0, max);
  }
  if (projectIndex?.masterScript) {
    pushMatch("masterScript", projectIndex.masterScript, [
      ["title", projectIndex.masterScript?.title],
      ["path", projectIndex.masterScript?.path],
      ["id", projectIndex.masterScript?.id],
    ]);
    if (matches.length >= max) return matches.slice(0, max);
  }
  for (const [section, entries] of [["scenes", projectIndex?.scenes], ["shots", projectIndex?.shots], ["prompts", projectIndex?.prompts]]) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      pushMatch(section, entry, [
        ["title", entry?.title],
        ["path", entry?.path],
        ["id", entry?.id],
        ["sceneId", entry?.sceneId],
        ["shotId", entry?.shotId],
      ]);
      if (matches.length >= max) return matches.slice(0, max);
    }
  }
  for (const [section, entries] of Object.entries(projectIndex?.assets || {})) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      pushMatch(section, entry, [["name", entry?.name], ["id", entry?.id]]);
      if (matches.length >= max) return matches.slice(0, max);
    }
  }
  for (const entry of Array.isArray(projectIndex?.customSections) ? projectIndex.customSections : []) {
    pushMatch("customSections", entry, [
      ["name", entry?.name],
      ["folder", entry?.folder],
      ["instructionsPath", entry?.instructionsPath],
      ["primary", entry?.primary],
      ["kind", entry?.kind],
    ]);
    if (matches.length >= max) return matches.slice(0, max);
  }
  return matches.slice(0, max);
}

async function walkProject(projectDir, relativeDir) {
  const out = [];
  async function walk(currentRel) {
    const absolute = resolveInside(projectDir, currentRel || ".");
    let entries = [];
    try {
      entries = await fs.readdir(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const nextRel = currentRel ? `${currentRel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === ".forge" || entry.name === "node_modules" || entry.name === ".git") continue;
        await walk(nextRel);
      } else if (entry.isFile()) {
        out.push(nextRel);
      }
    }
  }
  await walk(relativeDir || "");
  return out;
}

function matchGlob(glob, relativePath) {
  if (!glob) return true;
  const re = new RegExp(
    "^" +
      glob
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, ".*")
        .replace(/\*/g, "[^/]*") +
      "$",
  );
  return re.test(relativePath);
}

async function candidateSearchFiles(projectDir, glob) {
  const normalizedGlob = typeof glob === "string" && glob.trim() ? glob.trim() : "";
  if (normalizedGlob) {
    const files = await walkProject(projectDir, "");
    return files.filter((relativePath) => matchGlob(normalizedGlob, relativePath) && isSearchableTextPath(relativePath));
  }

  const discovered = new Set();
  try {
    const projectIndex = await readProjectIndex(projectDir);
    for (const relativePath of indexedProjectTextPaths(projectIndex)) {
      discovered.add(relativePath);
    }
  } catch {}

  for (const root of CORE_PROJECT_TEXT_ROOTS) {
    const files = await walkProject(projectDir, root);
    for (const relativePath of files) {
      discovered.add(relativePath);
    }
  }

  return Array.from(discovered).filter(isSearchableTextPath);
}

function searchViaRipgrep(rgBin, projectDir, query, glob, limit) {
  return new Promise((resolve, reject) => {
    const args = [
      "--fixed-strings",
      "--line-number",
      "--with-filename",
      "--color=never",
      "--max-count",
      String(limit),
      "--max-filesize",
      "4M",
      "-g",
      "!.forge",
      "-g",
      "!node_modules",
      "-g",
      "!.git",
    ];
    if (glob) args.push("-g", glob);
    args.push("--", query, ".");

    execFile(rgBin, args, { cwd: projectDir, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error && error.code !== 1 && error.code !== 0) {
        reject(error);
        return;
      }
      const matches = [];
      const lines = String(stdout || "").split("\n");
      for (const line of lines) {
        if (!line || matches.length >= limit) break;
        const first = line.indexOf(":");
        const second = first === -1 ? -1 : line.indexOf(":", first + 1);
        if (second === -1) continue;
        const relativePath = line.slice(0, first).replace(/^\.\//, "");
        const lineNumber = Number(line.slice(first + 1, second));
        const text = line.slice(second + 1).slice(0, 400);
        if (!relativePath || !Number.isFinite(lineNumber)) continue;
        matches.push({ kind: "text", path: relativePath, lineNumber, line: text });
      }
      resolve(matches);
    });
  });
}

async function ensureUniqueRelativePath(projectDir, desiredRelativePath) {
  const normalized = normalizeRelativePath(desiredRelativePath);
  const parsed = path.posix.parse(normalized);
  let counter = 0;
  while (true) {
    const candidateBase = counter === 0 ? parsed.name : `${parsed.name}-${counter + 1}`;
    const candidate = normalizeRelativePath(path.posix.join(parsed.dir, `${candidateBase}${parsed.ext}`));
    try {
      await fs.access(resolveInside(projectDir, candidate));
      counter += 1;
    } catch {
      return candidate;
    }
  }
}

async function ensureUniqueRelativePathExcept(projectDir, desiredRelativePath, exceptRelativePath) {
  const normalized = normalizeRelativePath(desiredRelativePath);
  const exceptNormalized = normalizeRelativePath(exceptRelativePath || "");
  if (normalized === exceptNormalized) return normalized;

  const parsed = path.posix.parse(normalized);
  let counter = 0;
  while (true) {
    const candidateBase = counter === 0 ? parsed.name : `${parsed.name}-${counter + 1}`;
    const candidate = normalizeRelativePath(path.posix.join(parsed.dir, `${candidateBase}${parsed.ext}`));
    if (candidate === exceptNormalized) return candidate;
    try {
      await fs.access(resolveInside(projectDir, candidate));
      counter += 1;
    } catch {
      return candidate;
    }
  }
}

function normalizeProjectInputPaths(projectDir, values, label) {
  if (!values) return [];
  const entries = Array.isArray(values) ? values : [values];
  return entries
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .map((relativePath) => {
      try {
        return resolveInside(projectDir, relativePath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${label}: ${message}`);
      }
    });
}

function inferGeneratedImageSection(selection, requestedSection) {
  const normalizedRequested = typeof requestedSection === "string" ? requestedSection.trim() : "";
  if (["characters", "locations", "props", "keyframes"].includes(normalizedRequested)) {
    return normalizedRequested;
  }
  if (selection && ["characters", "locations", "props", "keyframes"].includes(selection.section)) {
    return selection.section;
  }
  return "keyframes";
}

function assetSections() {
  return ["characters", "locations", "props", "keyframes", "audio"];
}

function normalizeAssetSection(section) {
  const value = String(section || "").trim();
  return assetSections().includes(value) ? value : null;
}

function isSupportedAssetFile(section, entryName) {
  const ext = path.posix.extname(String(entryName || "").toLowerCase());
  if (!ext || String(entryName || "").startsWith(".")) {
    return false;
  }
  return section === "audio" ? AUDIO_ASSET_EXTENSIONS.has(ext) : IMAGE_ASSET_EXTENSIONS.has(ext);
}

function defaultAssetEntry(section, fileName) {
  const title = stemToTitle(path.posix.basename(fileName, path.posix.extname(fileName)));
  const id = randomUUID();
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

function makeAssetEntry(section, name) {
  const cleanName = String(name || "").trim() || titleCaseSlug(slugifyName(section));
  const id = randomUUID();
  return {
    id,
    title: cleanName,
    name: cleanName,
    content: "",
    path: "",
    folder: null,
    media: [],
  };
}

function mediaKindForSection(section) {
  return section === "audio" ? "audio" : "image";
}

async function attachMediaToProjectAsset(projectDir, { selection, section, assetName, relativePaths, kind }) {
  if (!Array.isArray(relativePaths) || !relativePaths.length) {
    return null;
  }

  const metadata = await readProjectMetadata(projectDir);
  const targetKind = mediaKindForSection(section);
  if (targetKind !== kind) {
    throw new Error(`Cannot attach ${kind} output to ${section}.`);
  }

  const currentEntries = Array.isArray(metadata[section]) ? metadata[section] : [];
  const currentSelectionEntry =
    selection && selection.section === section && selection.itemId
      ? currentEntries.find((entry) => entry && entry.id === selection.itemId)
      : null;

  let created = false;
  let targetEntry = currentSelectionEntry || null;
  if (!targetEntry) {
    targetEntry = makeAssetEntry(section, assetName || titleCaseSlug(slugifyName(relativePaths[0])));
    created = true;
  }

  const existingMedia = Array.isArray(targetEntry.media) ? targetEntry.media : [];
  const nextMedia = [...existingMedia];
  for (const relativePath of relativePaths) {
    if (nextMedia.some((media) => media.path === relativePath)) continue;
    nextMedia.push({
      id: randomUUID(),
      label: path.basename(relativePath),
      kind,
      path: normalizeRelativePath(relativePath),
    });
  }

  const nextEntry = { ...targetEntry, media: nextMedia };
  const nextEntries = created
    ? [...currentEntries, nextEntry]
    : currentEntries.map((entry) => (entry.id === nextEntry.id ? nextEntry : entry));

  const nextMetadata = {
    ...metadata,
    [section]: nextEntries,
    project: {
      ...(metadata.project || {}),
      updatedAt: new Date().toISOString(),
    },
  };
  await writeProjectMetadata(projectDir, nextMetadata);

  return {
    createdEntry: created,
    id: nextEntry.id,
    name: nextEntry.name || nextEntry.title,
    section,
  };
}

async function syncAssetDirectoryFiles(projectDir, metadata, sectionsFilter = null) {
  let changed = false;
  const imported = [];
  const nextProject = {
    ...metadata,
  };
  const requestedSections = Array.isArray(sectionsFilter) && sectionsFilter.length
    ? sectionsFilter
    : assetSections();

  for (const section of requestedSections) {
    const directory = assetDirectory(projectDir, section);
    let entries = Array.isArray(metadata?.[section])
      ? metadata[section].map((entry) => ({
          ...entry,
          media: Array.isArray(entry?.media) ? entry.media.map((media) => ({ ...media })) : [],
        }))
      : [];
    const knownPaths = new Set(
      entries.flatMap((entry) =>
        (Array.isArray(entry?.media) ? entry.media : [])
          .map((media) => normalizeProjectMediaPath(projectDir, media?.path))
          .filter(Boolean),
      ),
    );
    // Dedup: track known asset names (slugified) to avoid creating duplicate
    // entries when the same file is dropped/imported multiple times under
    // slightly different filenames.
    const knownNameSlugs = new Set(
      entries.map((entry) => slugifyName(entry?.name || entry?.title || "")).filter(Boolean),
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

      const fileStemSlug = slugifyName(path.posix.basename(file.name, path.posix.extname(file.name)));
      // Skip if an entry with the same name already exists and has media
      // (prevents creating duplicate entries from repeated imports)
      if (knownNameSlugs.has(fileStemSlug)) {
        // Attach media to the existing entry instead of creating a new one
        const existingEntry = entries.find((entry) => {
          const entrySlug = slugifyName(entry?.name || entry?.title || "");
          return entrySlug === fileStemSlug;
        });
        if (existingEntry && !existingEntry.media.some((m) => m.path === relativePath)) {
          existingEntry.media.push({
            id: randomUUID(),
            label: file.name,
            kind: mediaKindForSection(section),
            path: relativePath,
          });
          knownPaths.add(relativePath);
          changed = true;
          imported.push(relativePath);
        }
        continue;
      }

      const targetIndex = entries.findIndex((entry) => {
        const entrySlug = slugifyName(entry?.name || entry?.title || "");
        const entryMedia = Array.isArray(entry?.media) ? entry.media : [];
        return entrySlug === fileStemSlug && entryMedia.length === 0;
      });

      const mediaRecord = {
        id: randomUUID(),
        label: file.name,
        kind: mediaKindForSection(section),
        path: relativePath,
      };

      let assetId = null;
      let assetName = null;
      if (targetIndex !== -1) {
        const targetEntry = entries[targetIndex];
        assetId = targetEntry?.id || null;
        assetName = targetEntry?.name || targetEntry?.title || "";
        entries[targetIndex] = {
          ...targetEntry,
          media: [...(Array.isArray(targetEntry.media) ? targetEntry.media : []), mediaRecord],
        };
      } else {
        const nextEntry = defaultAssetEntry(section, file.name);
        nextEntry.media = [mediaRecord];
        assetId = nextEntry.id;
        assetName = nextEntry.name || nextEntry.title || "";
        entries = [...entries, nextEntry];
      }

      imported.push({
        section,
        path: relativePath,
        fileName: file.name,
        assetId,
        assetName,
      });
      knownPaths.add(relativePath);
      changed = true;
    }

    nextProject[section] = entries;
  }

  if (changed) {
    nextProject.project = {
      ...(nextProject.project || {}),
      updatedAt: new Date().toISOString(),
    };
  }

  return { changed, project: nextProject, imported };
}

async function listMarkdownFilesRecursive(projectDir, relativeDir, recursive = true) {
  const out = [];
  async function walk(currentRel) {
    const absolute = resolveInside(projectDir, currentRel || ".");
    let entries = [];
    try {
      entries = await fs.readdir(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const nextRel = currentRel ? `${currentRel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (recursive) {
          await walk(nextRel);
        }
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push(normalizeRelativePath(nextRel));
      }
    }
  }
  await walk(relativeDir);
  return out.sort();
}

async function readMarkdownIndexEntry(projectDir, relativePath, extra = {}) {
  const normalizedPath = normalizeRelativePath(relativePath);
  const absolute = resolveInside(projectDir, normalizedPath);
  const raw = await fs.readFile(absolute, "utf8");
  const fallbackTitle = titleFromRelativePath(normalizedPath);
  const { meta, body } = parseFrontmatter(raw);
  const title =
    typeof meta?.title === "string" && meta.title.trim()
      ? meta.title.trim()
      : titleFromMarkdownContent(body, fallbackTitle);
  return {
    id: typeof meta?.id === "string" && meta.id.trim() ? meta.id.trim() : "",
    title,
    path: normalizedPath,
    content: body,
    meta,
    ...extra,
  };
}

function buildProjectIndexFromContent({ story, masterScript, scenes, beats, shots, prompts, assets, customSections }) {
  return {
    story: story.map((entry) => ({
      contextGroup: entry.contextGroup || entry.meta?.contextGroup || entry.meta?.context_group || undefined,
      id: entry.id,
      path: entry.path,
      title: entry.title,
    })),
    masterScript: masterScript
      ? {
          id: masterScript.id,
          path: masterScript.path,
          title: masterScript.title,
        }
      : null,
    scenes: scenes.map((entry) => ({
      durationSec: parsePositiveNumber(entry.durationSec) ?? readDurationSec(entry.meta),
      id: entry.id,
      path: entry.path,
      sceneOrder: parsePositiveNumber(entry.sceneOrder ?? entry.meta?.sceneOrder),
      title: entry.title,
    })),
    beats: (Array.isArray(beats) ? beats : []).map((entry) => ({
      id: entry.id,
      path: entry.path,
      sceneId: entry.sceneId || "",
      scenePath: entry.scenePath || null,
      title: entry.title,
    })),
    shots: shots.map((entry) => ({
      id: entry.id,
      path: entry.path,
      beatId: entry.beatId || null,
      beatPath: entry.beatPath || null,
      sceneId: entry.sceneId || "",
      scenePath: entry.scenePath || null,
      title: entry.title,
    })),
    prompts: prompts.map((entry) => ({
      prevPromptId: entry.prevPromptId || readPromptPrevId(entry.meta) || null,
      durationSec: parsePositiveNumber(entry.durationSec) ?? readDurationSec(entry.meta),
      id: entry.id,
      path: entry.path,
      beatId: entry.beatId || null,
      beatPath: entry.beatPath || null,
      // Sub-prompt parent id — must round-trip through the index so
      // create_prompt's hoist-on-nested logic sees existing parents
      // on subsequent calls. Without this field surviving into
      // index.json, every readProjectIndex would lose the link and
      // the second sub-prompt under a parent would be created at
      // depth-2 instead of being hoisted back to depth-1.
      parentPromptId: entry.parentPromptId || null,
      sceneId: entry.sceneId || null,
      scenePath: entry.scenePath || null,
      segmentCount: parsePositiveNumber(entry.segmentCount ?? entry.meta?.segmentCount),
      segmentEndSec: parsePositiveNumber(entry.segmentEndSec ?? entry.meta?.segmentEndSec),
      segmentIndex: parsePositiveNumber(entry.segmentIndex ?? entry.meta?.segmentIndex),
      segmentStartSec: parseNonNegativeNumber(entry.segmentStartSec ?? entry.meta?.segmentStartSec),
      shotId: entry.shotId || null,
      shotPath: entry.shotPath || null,
      title: entry.title,
    })),
    assets: {
      characters: Array.isArray(assets?.characters) ? assets.characters.map((entry) => ({ id: entry.id, name: entry.name })) : [],
      locations: Array.isArray(assets?.locations) ? assets.locations.map((entry) => ({ id: entry.id, name: entry.name })) : [],
      props: Array.isArray(assets?.props) ? assets.props.map((entry) => ({ id: entry.id, name: entry.name })) : [],
      keyframes: Array.isArray(assets?.keyframes) ? assets.keyframes.map((entry) => ({ id: entry.id, name: entry.name })) : [],
      audio: Array.isArray(assets?.audio) ? assets.audio.map((entry) => ({ id: entry.id, name: entry.name })) : [],
    },
    customSections: Array.isArray(customSections)
      ? customSections.map((sub) => ({
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

async function refreshProjectIndex(projectDir) {
  const metadata = await readProjectMetadata(projectDir);
  const storyFiles = await listMarkdownFilesRecursive(projectDir, "story", false);
  const story = await Promise.all(storyFiles.map((relativePath) => readMarkdownIndexEntry(projectDir, relativePath)));

  let masterScript = null;
  try {
    masterScript = await readMarkdownIndexEntry(projectDir, "script/master-script.md");
  } catch {}

  const scenesFromDisk = await Promise.all(
    (await listMarkdownFilesRecursive(projectDir, "scenes", false)).map((relativePath) =>
      readMarkdownIndexEntry(projectDir, relativePath),
    ),
  );
  const scenes = sortSceneEntriesByScriptOrder(scenesFromDisk, masterScript ? [masterScript] : []);
  const sceneByFolder = new Map(
    scenes.map((entry) => [path.posix.basename(entry.path, path.posix.extname(entry.path)), entry]),
  );

  const beats = await Promise.all(
    (await listMarkdownFilesRecursive(projectDir, "beats", true)).map(async (relativePath) => {
      const beat = await readMarkdownIndexEntry(projectDir, relativePath);
      const parts = relativePath.split("/");
      const sceneFolder = parts.length > 2 ? parts[1] : "";
      const inferredScene = sceneByFolder.get(sceneFolder) || null;
      const sceneLink = resolveSceneLink(beat.meta, relativePath, scenes, inferredScene);
      return {
        ...beat,
        sceneId: sceneLink.sceneId || "",
        scenePath: sceneLink.scenePath,
      };
    }),
  );
  const beatByPath = new Map(beats.map((entry) => [entry.path, entry]));
  const beatById = new Map(beats.map((entry) => [entry.id, entry]));

  const shots = await Promise.all(
    (await listMarkdownFilesRecursive(projectDir, "shots", true)).map(async (relativePath) => {
      const shot = await readMarkdownIndexEntry(projectDir, relativePath);
      const parts = relativePath.split("/");
      const sceneFolder = parts.length > 2 ? parts[1] : "";
      const inferredScene = sceneByFolder.get(sceneFolder) || null;
      const linkedBeat =
        typeof shot.meta?.beatPath === "string" && shot.meta.beatPath.trim()
          ? beatByPath.get(normalizeRelativePath(shot.meta.beatPath)) || null
          : typeof shot.meta?.beatId === "string" && shot.meta.beatId.trim()
          ? beatById.get(shot.meta.beatId.trim()) || null
          : null;
      const sceneLink = resolveSceneLink(shot.meta, relativePath, scenes, linkedBeat || inferredScene);
      return {
        ...shot,
        beatId:
          typeof shot.meta?.beatId === "string" && shot.meta.beatId.trim()
            ? shot.meta.beatId.trim()
            : linkedBeat?.id || null,
        beatPath:
          typeof shot.meta?.beatPath === "string" && shot.meta.beatPath.trim()
            ? normalizeRelativePath(shot.meta.beatPath)
            : linkedBeat?.path || null,
        sceneId: sceneLink.sceneId || "",
        scenePath: sceneLink.scenePath,
      };
    }),
  );
  const shotByPath = new Map(shots.map((entry) => [entry.path, entry]));

  const promptsFromDisk = await Promise.all(
    (await listMarkdownFilesRecursive(projectDir, "prompts", true)).map(async (relativePath) => {
      const prompt = await readMarkdownIndexEntry(projectDir, relativePath);
      const parts = relativePath.split("/");
      const sceneFolder = parts.length > 2 ? parts[1] : "";
      const inferredScene = sceneByFolder.get(sceneFolder) || null;
      const linkedShot =
        typeof prompt.meta?.shotPath === "string" && prompt.meta.shotPath.trim()
          ? shotByPath.get(normalizeRelativePath(prompt.meta.shotPath)) || null
          : null;
      const linkedBeat =
        typeof prompt.meta?.beatPath === "string" && prompt.meta.beatPath.trim()
          ? beatByPath.get(normalizeRelativePath(prompt.meta.beatPath)) || null
          : typeof prompt.meta?.beatId === "string" && prompt.meta.beatId.trim()
            ? beatById.get(prompt.meta.beatId.trim()) || null
            : linkedShot?.beatPath
              ? beatByPath.get(normalizeRelativePath(linkedShot.beatPath)) || null
              : linkedShot?.beatId
                ? beatById.get(linkedShot.beatId) || null
                : null;
      const sceneLink = resolveSceneLink(prompt.meta, relativePath, scenes, linkedShot || linkedBeat || inferredScene);
      return {
        ...prompt,
        durationSec: readDurationSec(prompt.meta),
        beatId:
          typeof prompt.meta?.beatId === "string" && prompt.meta.beatId.trim()
            ? prompt.meta.beatId.trim()
            : linkedShot?.beatId || linkedBeat?.id || null,
        beatPath:
          typeof prompt.meta?.beatPath === "string" && prompt.meta.beatPath.trim()
            ? normalizeRelativePath(prompt.meta.beatPath)
            : linkedShot?.beatPath || linkedBeat?.path || null,
        sceneId: sceneLink.sceneId,
        scenePath: sceneLink.scenePath,
        shotId:
          typeof prompt.meta?.shotId === "string" && prompt.meta.shotId.trim()
            ? prompt.meta.shotId.trim()
            : linkedShot?.id || null,
        shotPath:
          typeof prompt.meta?.shotPath === "string" && prompt.meta.shotPath.trim()
            ? normalizeRelativePath(prompt.meta.shotPath)
            : linkedShot?.path || null,
        // Parent prompt id when this prompt is a sub-prompt of a longer
        // sequence (>15s beat split). Mirrored from main.cjs's parser
        // (see "Parent prompt id" comment there) — both index paths
        // must surface the field so create_prompt's hoist-on-nested
        // logic can see existing parents on the next call.
        prevPromptId: readPromptPrevId(prompt.meta),
        parentPromptId:
          typeof prompt.meta?.parentPromptId === "string" && prompt.meta.parentPromptId.trim()
            ? prompt.meta.parentPromptId.trim()
            : null,
      };
    }),
  );
  const prompts = sortPromptEntriesByStoryOrder(promptsFromDisk, { scenes });

  const index = buildProjectIndexFromContent({
    story,
    masterScript,
    scenes,
    beats,
    shots,
    prompts,
    assets: metadata,
    customSections: metadata?.customSubsections,
  });
  await fs.mkdir(path.dirname(projectIndexPath(projectDir)), { recursive: true });
  await fs.writeFile(projectIndexPath(projectDir), JSON.stringify(index, null, 2), "utf8");
  return index;
}

// `saveRemoteFiles` and `finalizeLocalGeneratedFiles` were deleted
// along with the generation tools that called them — the former
// downloaded EvoLink result URLs, the latter moved Topview's local
// outputs into place. Nothing in the surviving tool set creates
// remote media, so both helpers became unreachable.

function registerTool(name, definition) {
  registry.set(name, { tier: DEFAULT_TIER, ...definition });
  cachedToolCatalog = null;
}

function listTools(options = {}) {
  const { tiers } = options;
  if (!tiers && cachedToolCatalog) return cachedToolCatalog;
  const entries = Array.from(registry.entries()).map(([name, def]) => ({
    name,
    description: def.description,
    args: def.args,
    tier: def.tier || DEFAULT_TIER,
  }));
  if (!tiers) {
    cachedToolCatalog = entries;
    return cachedToolCatalog;
  }
  const allowed = new Set(Array.isArray(tiers) ? tiers : [tiers]);
  return entries.filter((tool) => allowed.has(tool.tier));
}

function listTierIndex() {
  const index = {};
  for (const [name, def] of registry.entries()) {
    const tier = def.tier || DEFAULT_TIER;
    if (!index[tier]) index[tier] = [];
    index[tier].push(name);
  }
  return index;
}

// Return the set of tool names that mutate project state. Focus-lock and
// read-only mode enforcement derive their write-tool list from this.
// A tool is mutating if its tier === "edit" OR it declares `mutation: true`.
// Adding a new mutating tool just requires setting the field — no separate
// list to keep in sync.
function listMutatingToolNames() {
  const names = new Set();
  for (const [name, def] of registry.entries()) {
    const tier = def.tier || DEFAULT_TIER;
    if (tier === "edit" || def.mutation === true) {
      names.add(name);
    }
  }
  return names;
}

async function runTool(name, args, ctx) {
  const tool = registry.get(name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }
  const result = await tool.run(args || {}, ctx);
  return capToolResult(result);
}

const moduleApi = {
  registerTool,
  listTools,
  listTierIndex,
  runTool,
  resolveInside,
  parseFrontmatter,
  normalizeRelativePath,
  normalizeProjectMediaPath,
  absoluteProjectMediaPath,
  assetDirectory,
  truncateText,
  slugifyName,
  titleCaseSlug,
  stemToTitle,
  titleFromRelativePath,
  pickAssetName,
  readProjectMetadata,
  readProjectIndex,
  writeProjectMetadata,
  assertWritablePath,
  buildProjectIndexSummary,
  refreshProjectIndex,
  syncAssetDirectoryFiles,
  listMarkdownFilesRecursive,
  readMarkdownIndexEntry,
  searchProjectIndex,
  candidateSearchFiles,
  ensureUniqueRelativePath,
  ensureUniqueRelativePathExcept,
  normalizeProjectInputPaths,
  inferGeneratedImageSection,
  assetSections,
  normalizeAssetSection,
  makeAssetEntry,
  mediaKindForSection,
  attachMediaToProjectAsset,
  resolveRgBin,
  searchViaRipgrep,
  IMAGE_ASSET_EXTENSIONS,
  AUDIO_ASSET_EXTENSIONS,
  SHELL_COMMAND_ALLOWLIST,
  SHELL_COMMAND_TIMEOUT_MS,
  SHELL_MAX_BUFFER,
};

[
  registerFilesystemTools,
  registerProjectTools,
  registerAssetTools,
  registerUnderstandingTools,
  registerProactiveTools,
  registerMagicDocsTools,
  registerSkillTools,
  registerImageTools,
  registerMediaIndexTools,
  registerShellTools,
  registerMetaTools,
  registerPrefetchTools,
  registerEvolinkGenTools,
  registerReferenceStagingTools,
  registerVideoTools,
  registerTimelineTools,
].forEach((registerModule) => registerModule(moduleApi));

module.exports = {
  registerTool,
  listTools,
  listTierIndex,
  listMutatingToolNames,
  runTool,
  resolveInside,
  // Exposed for the asset-write-race regression test (audit asset-C1).
  writeProjectMetadata,
};
