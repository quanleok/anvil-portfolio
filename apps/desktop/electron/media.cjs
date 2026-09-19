// Unified media index — walks assets/, hashes files, maintains
// .forge/media-index.json for dedup / move detection / reference tracking.

const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { atomicWriteFile } = require("./atomic-write.cjs");

// ---------------------------------------------------------------------------
// Supported extensions
// ---------------------------------------------------------------------------

const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".tiff", ".avif", ".heic",
]);
const AUDIO_EXTENSIONS = new Set([
  ".mp3", ".wav", ".aac", ".ogg", ".flac", ".m4a", ".opus",
]);
const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".mov", ".webm", ".avi", ".mkv", ".m4v",
]);
const DOCUMENT_EXTENSIONS = new Set([
  ".pdf",
]);

const SUPPORTED_EXTENSIONS = new Set([
  ...IMAGE_EXTENSIONS,
  ...AUDIO_EXTENSIONS,
  ...VIDEO_EXTENSIONS,
  ...DOCUMENT_EXTENSIONS,
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * SHA-256 hex digest of file contents.
 */
async function hashFile(absolutePath) {
  const buf = await fs.readFile(absolutePath);
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Classify a file name by extension.
 * Returns "image" | "audio" | "video" | "document" | null.
 */
function classifyMediaFile(fileName) {
  const ext = path.extname(String(fileName || "")).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (DOCUMENT_EXTENSIONS.has(ext)) return "document";
  return null;
}

/**
 * Deterministic short ID from a relative path.
 */
function pathId(relativePath) {
  return createHash("sha256").update(relativePath).digest("hex").slice(0, 12);
}

/**
 * Determine the source bucket from a relative path inside assets/.
 * `assets/_pool/` paths are now classified as "library" — the pool
 * concept was retired and existing files in that folder are surfaced
 * through the unified media index alongside library files.
 */
function sourceForPath(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized.startsWith("assets/_pool/")) return "library";
  if (normalized.startsWith("assets/library/")) return "library";
  return "asset";
}

// ---------------------------------------------------------------------------
// Recursive walk
// ---------------------------------------------------------------------------

/**
 * Walk a directory recursively, yielding { relativePath, absolutePath }
 * for every supported media file. Skips hidden files/dirs. Guards
 * against symlink cycles via a Set of visited realpaths (audit
 * asset-L6, 2026-04-20).
 */
async function walkMedia(baseDir, currentDir, results, visited) {
  if (!visited) visited = new Set();
  let realDir;
  try {
    realDir = await fs.realpath(currentDir);
  } catch {
    return;
  }
  if (visited.has(realDir)) return;
  visited.add(realDir);
  let entries;
  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await walkMedia(baseDir, fullPath, results, visited);
    } else if (entry.isFile()) {
      const kind = classifyMediaFile(entry.name);
      if (kind) {
        const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, "/");
        results.push({ relativePath, absolutePath: fullPath, kind });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Index build / read / write
// ---------------------------------------------------------------------------

/**
 * Build a media index by walking assets/ recursively. Files are hashed
 * + stat'd in bounded parallel batches (concurrency 8) so large
 * projects don't pay the serial-loop tax. Audit asset-M3 (2026-04-20).
 */
const HASH_CONCURRENCY = 8;

async function buildMediaIndex(projectDir) {
  const assetsDir = path.join(projectDir, "assets");
  const files = [];
  await walkMedia(projectDir, assetsDir, files);

  const index = {};
  // Process in fixed-size waves to bound peak open-fd / memory.
  for (let i = 0; i < files.length; i += HASH_CONCURRENCY) {
    const batch = files.slice(i, i + HASH_CONCURRENCY);
    const records = await Promise.all(
      batch.map(async ({ relativePath, absolutePath, kind }) => {
        const id = pathId(relativePath);
        const [sha256, stat] = await Promise.all([
          hashFile(absolutePath),
          fs.stat(absolutePath).catch(() => null),
        ]);
        return {
          id,
          path: relativePath,
          sha256,
          sizeBytes: stat ? stat.size : 0,
          kind,
          source: sourceForPath(relativePath),
          addedAt: new Date().toISOString(),
        };
      }),
    );
    for (const record of records) {
      index[record.id] = record;
    }
  }
  return index;
}

const INDEX_FILENAME = path.join(".forge", "media-index.json");

/**
 * Read the stored media index from .forge/media-index.json.
 */
async function readMediaIndex(projectDir) {
  const filePath = path.join(projectDir, INDEX_FILENAME);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Write the media index atomically (unique-tmp + rename). Uses
 * atomicWriteFile so concurrent scan_media / delete_media calls don't
 * collide on the .tmp filename — pre-fix this had the same shape that
 * bit pinboard.json (audit asset-H3, 2026-04-20).
 */
async function writeMediaIndex(projectDir, index) {
  const filePath = path.join(projectDir, INDEX_FILENAME);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteFile(filePath, JSON.stringify(index, null, 2));
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

/**
 * Build a fresh index from disk, diff against the stored index.
 * Returns { added, removed, moved, unchanged, total }.
 */
async function reconcileMedia(projectDir) {
  const freshIndex = await buildMediaIndex(projectDir);
  const storedIndex = await readMediaIndex(projectDir);

  const freshById = new Map(Object.entries(freshIndex));
  const storedById = new Map(Object.entries(storedIndex));

  // Build hash -> records maps for move detection
  const storedByHash = new Map();
  for (const record of storedById.values()) {
    if (record.sha256) {
      if (!storedByHash.has(record.sha256)) {
        storedByHash.set(record.sha256, []);
      }
      storedByHash.get(record.sha256).push(record);
    }
  }

  const added = [];
  const removed = [];
  const moved = [];
  let unchanged = 0;

  // Detect added + unchanged + moved
  const matchedStoredIds = new Set();
  for (const [id, freshRecord] of freshById) {
    const storedRecord = storedById.get(id);
    if (storedRecord) {
      // Same ID exists in stored — unchanged (path didn't change since ID is path-based)
      matchedStoredIds.add(id);
      unchanged += 1;
    } else {
      // New ID — check if same content existed at a different path (move)
      const candidates = storedByHash.get(freshRecord.sha256) || [];
      const movedFrom = candidates.find((c) => !freshById.has(c.id) && !matchedStoredIds.has(c.id));
      if (movedFrom) {
        matchedStoredIds.add(movedFrom.id);
        moved.push(freshRecord);
      } else {
        added.push(freshRecord);
      }
    }
  }

  // Detect removed — stored IDs not matched
  for (const [id, storedRecord] of storedById) {
    if (!matchedStoredIds.has(id) && !freshById.has(id)) {
      removed.push(storedRecord);
    }
  }

  return {
    added,
    removed,
    moved,
    unchanged,
    total: freshById.size,
    // Return the fresh index so callers don't re-walk + re-hash. Pre-fix
    // scan_media called buildMediaIndex twice per call (once via this
    // function, once standalone). Audit asset-H5 (2026-04-20).
    freshIndex,
  };
}

// ---------------------------------------------------------------------------
// Reference computation
// ---------------------------------------------------------------------------

/**
 * Scan metadata entity arrays for media[] paths, populate referencedBy[]
 * on matching index records. Returns the updated index (mutated in place).
 */
function computeReferences(metadata, mediaIndex) {
  // Always clear / initialize referencedBy even if metadata is empty
  for (const record of Object.values(mediaIndex)) {
    record.referencedBy = [];
  }

  if (!metadata || typeof metadata !== "object") return mediaIndex;

  // Build a path -> id lookup
  const pathToId = new Map();
  for (const record of Object.values(mediaIndex)) {
    if (record && record.path) {
      pathToId.set(record.path, record.id);
    }
  }

  const sections = ["characters", "locations", "props", "keyframes", "audio", "library"];
  for (const section of sections) {
    const entries = Array.isArray(metadata[section]) ? metadata[section] : [];
    for (const entry of entries) {
      if (!entry || !entry.id) continue;
      const mediaList = Array.isArray(entry.media) ? entry.media : [];
      for (const media of mediaList) {
        if (!media || !media.path) continue;
        const normalizedPath = media.path.replace(/\\/g, "/");
        const id = pathToId.get(normalizedPath);
        if (id && mediaIndex[id]) {
          mediaIndex[id].referencedBy.push(entry.id);
        }
      }
    }
  }

  // Videos are shaped differently from AssetEntry (no media[] subarray —
  // the file path is directly on the VideoEntry). Each VideoEntry
  // references exactly one file on disk, so we add one ref per entry.
  const videos = Array.isArray(metadata.videos) ? metadata.videos : [];
  for (const video of videos) {
    if (!video || !video.id || !video.path) continue;
    const normalizedPath = String(video.path).replace(/\\/g, "/");
    const id = pathToId.get(normalizedPath);
    if (id && mediaIndex[id]) {
      mediaIndex[id].referencedBy.push(video.id);
    }
  }

  return mediaIndex;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  hashFile,
  classifyMediaFile,
  buildMediaIndex,
  readMediaIndex,
  writeMediaIndex,
  reconcileMedia,
  computeReferences,
  SUPPORTED_EXTENSIONS,
};
