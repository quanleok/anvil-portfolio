const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { atomicWriteFile, withWriteLock } = require("./atomic-write.cjs");

const MAX_READ_BYTES = 750_000;
const MAX_WRITE_BYTES = 1_500_000;
const ALLOWED_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mdx",
  ".mjs",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);
const BLOCKED_SEGMENTS = new Set([
  ".git",
  "dist",
  "node_modules",
  "release",
  "test-results",
]);
const BLOCKED_EXACT_NAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  "secrets.json",
  "secrets.local.json",
]);
const BLOCKED_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".cert",
  ".crt",
  ".gif",
  ".heic",
  ".ico",
  ".icns",
  ".jpeg",
  ".jpg",
  ".key",
  ".mov",
  ".mp3",
  ".mp4",
  ".p12",
  ".pem",
  ".png",
  ".sqlite",
  ".tiff",
  ".webm",
  ".webp",
]);

const DESKTOP_CORE_FILES = [
  "apps/desktop/src/App.tsx",
  "apps/desktop/src/styles.css",
  "apps/desktop/src/types.ts",
  "apps/desktop/src/lib/context-docs.ts",
  "apps/desktop/src/lib/sections.ts",
  "apps/desktop/electron/main.cjs",
  "apps/desktop/electron/preload.cjs",
  "apps/desktop/electron/agent-loop.cjs",
  "apps/desktop/electron/agent-context.cjs",
  "apps/desktop/electron/project-context.cjs",
  "apps/desktop/electron/story-system.cjs",
  "apps/desktop/electron/magic-docs.cjs",
  "apps/desktop/electron/system/tools/magic-docs.cjs",
];

function reviewRoot() {
  return path.resolve(process.env.ANVIL_REVIEW_ROOT || path.join(__dirname, "..", "..", ".."));
}

function reviewDataRoot() {
  return path.resolve(process.env.ANVIL_REVIEW_DATA_ROOT || path.join(os.homedir(), ".anvil", "review"));
}

function projectReviewKey(projectDir) {
  const root = normalizeRoot(projectDir);
  if (!root) return "";
  return crypto.createHash("sha256").update(root).digest("hex").slice(0, 16);
}

function projectReviewNotesRelativePath(projectDir) {
  const key = projectReviewKey(projectDir);
  return key ? path.posix.join("projects", key, "review-notes.md") : "";
}

function normalizeRelativePath(value) {
  const raw = String(value || "").replaceAll("\\", "/").trim();
  if (!raw || raw.startsWith("/") || raw.includes("\0")) {
    throw new Error("Review Desk target path is invalid.");
  }
  const normalized = path.posix.normalize(raw);
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized === "..") {
    throw new Error("Review Desk target path is outside the allowed root.");
  }
  return normalized;
}

function normalizeRoot(root) {
  const raw = typeof root === "string" ? root.trim() : "";
  if (!raw) return "";
  return path.resolve(raw);
}

function resolveInside(root, relativePath) {
  const base = normalizeRoot(root);
  if (!base) {
    throw new Error("Review Desk root is required.");
  }
  const rel = normalizeRelativePath(relativePath);
  const target = path.resolve(base, rel);
  const baseWithSep = base.endsWith(path.sep) ? base : `${base}${path.sep}`;
  if (target !== base && !target.startsWith(baseWithSep)) {
    throw new Error("Review Desk target path is outside the allowed root.");
  }
  return { rel, target };
}

function isAllowedReviewPath(relativePath) {
  let rel;
  try {
    rel = normalizeRelativePath(relativePath);
  } catch {
    return false;
  }
  const segments = rel.split("/");
  const base = segments[segments.length - 1].toLowerCase();
  const ext = path.extname(base).toLowerCase();
  if (BLOCKED_EXACT_NAMES.has(base)) return false;
  if (base.startsWith(".env")) return false;
  if (base.includes("secret") || base.includes("token") || base.includes("credential")) return false;
  if (BLOCKED_EXTENSIONS.has(ext)) return false;
  if (!ALLOWED_EXTENSIONS.has(ext)) return false;
  return segments.every((segment) => !BLOCKED_SEGMENTS.has(segment));
}

async function statFile(absolutePath) {
  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_READ_BYTES) return null;
    return stat;
  } catch {
    return null;
  }
}

function fileLabel(relativePath) {
  const parts = relativePath.split("/");
  return parts.slice(Math.max(0, parts.length - 2)).join("/");
}

async function fileEntry(root, scope, group, relativePath) {
  if (!isAllowedReviewPath(relativePath)) return null;
  const { rel, target } = resolveInside(root, relativePath);
  const stat = await statFile(target);
  if (!stat) return null;
  return {
    scope,
    path: rel,
    label: fileLabel(rel),
    group,
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
}

async function collectExisting(root, scope, group, relativePaths) {
  const entries = [];
  const seen = new Set();
  for (const relativePath of relativePaths) {
    let rel;
    try {
      rel = normalizeRelativePath(relativePath);
    } catch {
      continue;
    }
    if (seen.has(rel)) continue;
    seen.add(rel);
    const entry = await fileEntry(root, scope, group, rel);
    if (entry) entries.push(entry);
  }
  return entries;
}

async function walkTextFiles(root, startRel, options = {}) {
  const maxFiles = Number.isFinite(options.maxFiles) ? options.maxFiles : 120;
  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : 4;
  const files = [];

  async function visit(relativeDir, depth) {
    if (files.length >= maxFiles || depth > maxDepth) return;
    let resolved;
    try {
      resolved = resolveInside(root, relativeDir);
    } catch {
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(resolved.target, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const rel = path.posix.join(resolved.rel, entry.name);
      if (entry.isDirectory()) {
        if (BLOCKED_SEGMENTS.has(entry.name) || entry.name === "archive") continue;
        await visit(rel, depth + 1);
      } else if (entry.isFile() && isAllowedReviewPath(rel)) {
        files.push(rel);
      }
    }
  }

  await visit(startRel, 0);
  return files;
}

function parseGitStatusLine(line) {
  const raw = String(line || "");
  if (raw.length < 4) return "";
  let file = raw.slice(3).trim();
  if (file.includes(" -> ")) {
    file = file.split(" -> ").pop().trim();
  }
  return file.replace(/^"|"$/g, "");
}

function gitChangedFiles(root) {
  try {
    const output = childProcess.execFileSync(
      "git",
      ["-C", root, "status", "--porcelain", "--untracked-files=normal"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return output
      .split(/\r?\n/)
      .map(parseGitStatusLine)
      .filter(Boolean)
      .filter((file) => isAllowedReviewPath(file));
  } catch {
    return [];
  }
}

async function buildGroup(id, label, files) {
  return {
    id,
    label,
    files,
  };
}

async function listReviewFiles(projectDir) {
  const root = reviewRoot();
  const dataRoot = reviewDataRoot();
  const projectRoot = normalizeRoot(projectDir);
  const productDocs = await walkTextFiles(root, "docs", { maxFiles: 160, maxDepth: 4 });
  const projectNotesPath = projectReviewNotesRelativePath(projectRoot);

  const groups = [
    await buildGroup(
      "working-tree",
      "Working Tree",
      await collectExisting(root, "repo", "working-tree", gitChangedFiles(root)),
    ),
    await buildGroup(
      "product-docs",
      "Product Docs",
      await collectExisting(root, "repo", "product-docs", productDocs),
    ),
    await buildGroup(
      "desktop-core",
      "Desktop Core",
      await collectExisting(root, "repo", "desktop-core", DESKTOP_CORE_FILES),
    ),
  ];

  if (projectRoot && projectNotesPath) {
    groups.push(
      await buildGroup(
        "project-review-notes",
        "Standalone Review Notes",
        await collectExisting(dataRoot, "review", "project-review-notes", [projectNotesPath]),
      ),
    );
  }

  return {
    root,
    reviewDataRoot: dataRoot,
    projectDir: projectRoot || "",
    groups: groups.map((group) => ({
      ...group,
      files: group.files.sort((a, b) => a.path.localeCompare(b.path)),
    })),
  };
}

function resolveReviewTarget(projectDir, target) {
  const scope =
    target?.scope === "project" ? "project"
      : target?.scope === "review" ? "review"
        : "repo";
  if (scope === "project" && process.env.ANVIL_REVIEW_INCLUDE_PROJECT_FILES !== "1") {
    throw new Error("Project-scoped Review Desk files are disabled; use the standalone review data root.");
  }
  const root =
    scope === "project" ? normalizeRoot(projectDir)
      : scope === "review" ? reviewDataRoot()
        : reviewRoot();
  if (!root) {
    throw new Error("Open a project before reading project-scoped files.");
  }
  const rawPath = target?.path;
  const resolved = resolveInside(root, rawPath);
  if (!isAllowedReviewPath(resolved.rel)) {
    throw new Error("Review Desk can only open allowed text files.");
  }
  return { scope, root, rel: resolved.rel, target: resolved.target };
}

async function readReviewFile(projectDir, target) {
  const resolved = resolveReviewTarget(projectDir, target);
  const stat = await statFile(resolved.target);
  if (!stat) {
    throw new Error("Review Desk file is missing, too large, or not a regular file.");
  }
  const content = await fs.readFile(resolved.target, "utf8");
  return {
    target: { scope: resolved.scope, path: resolved.rel },
    content,
    modifiedAt: stat.mtime.toISOString(),
    sizeBytes: stat.size,
  };
}

async function writeReviewFile(projectDir, target, text) {
  const resolved = resolveReviewTarget(projectDir, target);
  const content = String(text || "");
  if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
    throw new Error("Review Desk file is too large to write safely.");
  }
  const parent = path.dirname(resolved.target);
  if (resolved.scope === "project") {
    await fs.mkdir(parent, { recursive: true });
  }
  await withWriteLock(resolved.target, () => atomicWriteFile(resolved.target, content));
  const stat = await fs.stat(resolved.target);
  return {
    target: { scope: resolved.scope, path: resolved.rel },
    modifiedAt: stat.mtime.toISOString(),
    sizeBytes: stat.size,
  };
}

async function appendReviewNote(projectDir, note) {
  const projectRoot = normalizeRoot(projectDir);
  if (!projectRoot) {
    throw new Error("Open a project before adding review notes.");
  }
  const trimmed = String(note || "").trim();
  if (!trimmed) {
    throw new Error("Review note is empty.");
  }
  const relativePath = projectReviewNotesRelativePath(projectRoot);
  if (!relativePath) {
    throw new Error("Review note target is unavailable.");
  }
  const target = path.join(reviewDataRoot(), ...relativePath.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  let existing = "";
  try {
    existing = await fs.readFile(target, "utf8");
  } catch {}
  const timestamp = new Date().toISOString();
  const next = `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}## ${timestamp}\n\n${trimmed}\n`;
  await withWriteLock(target, () => atomicWriteFile(target, next));
  const stat = await fs.stat(target);
  return {
    target: { scope: "review", path: relativePath },
    modifiedAt: stat.mtime.toISOString(),
    sizeBytes: stat.size,
  };
}

module.exports = {
  isAllowedReviewPath,
  listReviewFiles,
  projectReviewNotesRelativePath,
  reviewDataRoot,
  readReviewFile,
  reviewRoot,
  writeReviewFile,
  appendReviewNote,
};
