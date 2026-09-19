const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");

const IMAGE_EXTENSIONS = new Set([
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

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 100;
const SIPS_BIN = "/usr/bin/sips";

function isImagePath(relativePath) {
  return IMAGE_EXTENSIONS.has(path.posix.extname(String(relativePath || "").toLowerCase()));
}

function imageAssetSections() {
  return ["characters", "locations", "props", "keyframes"];
}

function imageDirectoryForSection(section) {
  switch (section) {
    case "characters":
    case "locations":
    case "props":
    case "keyframes":
      return `assets/${section}`;
    case "inbox":
      return "assets/inbox";
    case "library":
      return "assets/library/images";
    default:
      return null;
  }
}

async function walkImages(projectDir, resolveInside, relativeDir, out) {
  const absoluteDir = resolveInside(projectDir, relativeDir);
  let entries = [];
  try {
    entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const nextRelativePath = path.posix.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      await walkImages(projectDir, resolveInside, nextRelativePath, out);
      continue;
    }
    if (!entry.isFile() || !isImagePath(nextRelativePath)) {
      continue;
    }
    out.push(nextRelativePath);
  }
}

function inspectImageViaSips(absolutePath) {
  return new Promise((resolve, reject) => {
    execFile(
      SIPS_BIN,
      ["-g", "format", "-g", "pixelWidth", "-g", "pixelHeight", absolutePath],
      { maxBuffer: 256 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        const output = String(stdout || "");
        const format = output.match(/format:\s*(.+)$/m)?.[1]?.trim() || null;
        const width = Number(output.match(/pixelWidth:\s*(\d+)/m)?.[1] || 0) || null;
        const height = Number(output.match(/pixelHeight:\s*(\d+)/m)?.[1] || 0) || null;
        resolve({ format, width, height });
      },
    );
  });
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, () => worker());
  await Promise.all(workers);
  return results;
}

module.exports = function registerImageTools(api) {
  const {
    registerTool,
    readProjectMetadata,
    resolveInside,
    normalizeRelativePath,
    normalizeAssetSection,
  } = api;

  registerTool("inspect_images", {
    tier: "domain",
    description:
      "Efficiently inspect project images without reading binary blobs into the model. Use this for manual uploads, asset cleanup, renaming, or choosing reference images instead of read_file/search.",
    args: {
      paths: "optional array of project-relative image paths",
      section: "optional characters | locations | props | keyframes | inbox | library",
      query: "optional substring filter by path, filename, asset name, or label",
      limit: `optional integer 1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}`,
      includeOrphans: "optional boolean, default true; when true also scans asset folders for images not registered in Forge metadata",
    },
    async run({ paths, section, query = "", limit = DEFAULT_LIMIT, includeOrphans = true }, ctx) {
      const normalizedLimit = Math.max(1, Math.min(MAX_LIMIT, Number(limit) || DEFAULT_LIMIT));
      const normalizedQuery = String(query || "").trim().toLowerCase();
      const requestedSection = section === "inbox" || section === "library"
        ? section
        : normalizeAssetSection(section);

      let metadata = {};
      try {
        metadata = await readProjectMetadata(ctx.projectDir);
      } catch {}

      const candidates = new Map();
      const explicitPaths = Array.isArray(paths) ? paths : typeof paths === "string" && paths.trim() ? [paths] : [];

      const addCandidate = (relativePath, meta = {}) => {
        const normalizedPath = normalizeRelativePath(relativePath);
        if (!normalizedPath || !isImagePath(normalizedPath)) return;
        const record = candidates.get(normalizedPath) || {
          path: normalizedPath,
          source: meta.source || "filesystem",
        };
        candidates.set(normalizedPath, {
          ...record,
          ...meta,
          path: normalizedPath,
        });
      };

      if (explicitPaths.length > 0) {
        for (const relativePath of explicitPaths) {
          addCandidate(relativePath, { source: "explicit" });
        }
      } else {
        for (const assetSection of imageAssetSections()) {
          if (requestedSection && requestedSection !== assetSection) continue;
          const entries = Array.isArray(metadata?.[assetSection]) ? metadata[assetSection] : [];
          for (const entry of entries) {
            const mediaItems = Array.isArray(entry?.media) ? entry.media : [];
            for (const media of mediaItems) {
              addCandidate(media?.path, {
                source: "metadata",
                assetSection,
                assetId: entry?.id || null,
                assetName: entry?.name || entry?.title || "",
                label: media?.label || "",
                mediaId: media?.id || null,
              });
            }
          }
        }

        if (includeOrphans !== false) {
          const scanSections = requestedSection
            ? [requestedSection]
            : [...imageAssetSections(), "inbox", "library"];
          for (const scanSection of scanSections) {
            const relativeDir = imageDirectoryForSection(scanSection);
            if (!relativeDir) continue;
            const discovered = [];
            await walkImages(ctx.projectDir, resolveInside, relativeDir, discovered);
            for (const relativePath of discovered) {
              addCandidate(relativePath, { source: "filesystem" });
            }
          }
        }
      }

      let selected = Array.from(candidates.values());
      if (normalizedQuery) {
        selected = selected.filter((item) => {
          const haystack = [
            item.path,
            path.posix.basename(item.path),
            item.assetName,
            item.label,
            item.assetSection,
          ]
            .map((value) => String(value || "").toLowerCase())
            .join("\n");
          return haystack.includes(normalizedQuery);
        });
      }

      selected = selected
        .sort((left, right) => left.path.localeCompare(right.path))
        .slice(0, normalizedLimit);

      const images = await mapWithConcurrency(selected, 6, async (item) => {
        const absolutePath = resolveInside(ctx.projectDir, item.path);
        const stat = await fs.stat(absolutePath);
        let inspect = { format: null, width: null, height: null, readable: false };
        try {
          const sips = await inspectImageViaSips(absolutePath);
          inspect = {
            ...sips,
            readable: true,
          };
        } catch (error) {
          inspect.error = error instanceof Error ? error.message : String(error);
        }

        return {
          path: item.path,
          name: item.assetName || path.posix.basename(item.path),
          fileName: path.posix.basename(item.path),
          label: item.label || path.posix.basename(item.path),
          source: item.source || "filesystem",
          assetSection: item.assetSection || null,
          assetId: item.assetId || null,
          mediaId: item.mediaId || null,
          format: inspect.format,
          width: inspect.width,
          height: inspect.height,
          readable: inspect.readable,
          error: inspect.error || null,
          sizeBytes: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        };
      });

      return {
        count: images.length,
        query: normalizedQuery || null,
        section: requestedSection || null,
        images,
      };
    },
  });
};
