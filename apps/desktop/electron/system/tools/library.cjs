// Link-by-reference library tools. Coexists with pool.cjs so the agent/UI
// can pick either semantic: pool = copy-on-promote (owns its own file after
// promotion); library = link-by-reference (one physical file, many linking
// entries). Ported from Codex's 170833c with shape unchanged.

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { pathToFileURL } = require("node:url");

const LIBRARY_FOLDER = "assets/library";

module.exports = function registerLibraryTools(api) {
  const {
    registerTool,
    readProjectMetadata,
    writeProjectMetadata,
    refreshProjectIndex,
    truncateText,
    normalizeAssetSection,
    assetSections,
    normalizeProjectMediaPath,
    absoluteProjectMediaPath,
    resolveInside,
    slugifyName,
    makeAssetEntry,
    IMAGE_ASSET_EXTENSIONS,
    AUDIO_ASSET_EXTENSIONS,
  } = api;

  function libraryKindForPath(filePath) {
    const ext = path.posix.extname(String(filePath || "").toLowerCase());
    return AUDIO_ASSET_EXTENSIONS.has(ext) ? "audio" : "image";
  }

  function isSupportedLibraryPath(filePath) {
    const ext = path.posix.extname(String(filePath || "").toLowerCase());
    return IMAGE_ASSET_EXTENSIONS.has(ext) || AUDIO_ASSET_EXTENSIONS.has(ext);
  }

  function titleCase(value) {
    return String(value || "")
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase())
      .trim() || "Untitled";
  }

  function libraryEntries(metadata) {
    return Array.isArray(metadata?.library) ? metadata.library : [];
  }

  async function mediaExists(projectDir, relativePath) {
    const absolutePath = absoluteProjectMediaPath(projectDir, relativePath);
    if (!absolutePath) return false;
    try {
      const stat = await fs.stat(absolutePath);
      return stat.isFile();
    } catch {
      return false;
    }
  }

  async function hydrateMedia(projectDir, mediaItems) {
    const items = Array.isArray(mediaItems) ? mediaItems : [];
    return Promise.all(items.map(async (item) => {
      const relativePath = normalizeProjectMediaPath(projectDir, item?.path);
      const absolutePath = absoluteProjectMediaPath(projectDir, relativePath);
      const exists = await mediaExists(projectDir, relativePath);
      return {
        id: item?.id || null,
        kind: item?.kind || libraryKindForPath(relativePath),
        label: item?.label || "",
        path: relativePath,
        exists,
        fileUrl: exists && absolutePath ? pathToFileURL(absolutePath).href : "",
      };
    }));
  }

  registerTool("list_library_assets", {
    tier: "domain",
    description:
      "List shared library media from assets/library. Use this before linking files into characters, locations, props, keyframes, or audio entries via link_library_assets. The library is a link-by-reference counterpart to the pool — same physical file, many linking entries.",
    args: {
      query: "optional substring filter by name/title/media path",
      kind: "optional image | audio",
      includeMedia: "optional boolean, default true",
    },
    async run({ query = "", kind, includeMedia = true }, ctx) {
      const metadata = await readProjectMetadata(ctx.projectDir);
      const normalizedQuery = String(query || "").trim().toLowerCase();
      const normalizedKind = kind === "audio" || kind === "image" ? kind : "";
      const filtered = libraryEntries(metadata)
        .filter((entry) => {
          const media = Array.isArray(entry?.media) ? entry.media : [];
          if (normalizedKind && !media.some((item) => (item?.kind || libraryKindForPath(item?.path)) === normalizedKind)) {
            return false;
          }
          if (!normalizedQuery) return true;
          const haystack = [
            entry?.name,
            entry?.title,
            entry?.path,
            ...media.flatMap((item) => [item?.label, item?.path]),
          ]
            .map((value) => String(value || "").toLowerCase())
            .join("\n");
          return haystack.includes(normalizedQuery);
        });
      const items = await Promise.all(filtered.map(async (entry) => ({
          id: entry.id,
          name: entry.name || entry.title || "",
          path: entry.path || "",
          content: typeof entry.content === "string" ? truncateText(entry.content, 1000).content : "",
          media: includeMedia ? await hydrateMedia(ctx.projectDir, entry.media) : undefined,
        })));
      return { library: items, count: items.length };
    },
  });

  registerTool("read_library_bundle", {
    tier: "domain",
    description:
      "Read one library entry with full content + media. Use this instead of read_file when you need one specific library asset's notes and media paths.",
    args: {
      assetId: "optional library asset id",
      name: "optional library asset name/title substring",
      includeContent: "optional boolean, default true",
    },
    async run({ assetId, name, includeContent = true }, ctx) {
      const metadata = await readProjectMetadata(ctx.projectDir);
      const normalizedName = String(name || "").trim().toLowerCase();
      const entry =
        libraryEntries(metadata).find((item) => assetId && item?.id === assetId) ||
        libraryEntries(metadata).find((item) => normalizedName && String(item?.name || item?.title || "").toLowerCase().includes(normalizedName));
      if (!entry) {
        throw new Error("read_library_bundle: library asset not found.");
      }
      return {
        section: "library",
        asset: {
          id: entry.id,
          name: entry.name || entry.title || "",
          title: entry.title || entry.name || "",
          content: includeContent ? truncateText(entry.content || "", 12000).content : "",
          contentTruncated: includeContent ? truncateText(entry.content || "", 12000).truncated : false,
          path: entry.path || "",
          folder: entry.folder || null,
          media: await hydrateMedia(ctx.projectDir, entry.media),
        },
      };
    },
  });

  registerTool("sync_library_from_disk", {
    tier: "edit",
    description:
      "Import manually dropped files from assets/library into Forge metadata (metadata.library[]) and refresh the project index. Library files stay in place; entities link by reference via link_library_assets.",
    args: {},
    async run(_args, ctx) {
      const metadata = await readProjectMetadata(ctx.projectDir);
      const knownPaths = new Set(
        libraryEntries(metadata)
          .flatMap((entry) => (Array.isArray(entry?.media) ? entry.media : []).map((media) => normalizeProjectMediaPath(ctx.projectDir, media?.path)))
          .filter(Boolean),
      );

      let files = [];
      try {
        files = await fs.readdir(resolveInside(ctx.projectDir, LIBRARY_FOLDER), { withFileTypes: true });
      } catch {
        files = [];
      }

      const imported = [];
      const nextLibrary = libraryEntries(metadata).map((entry) => ({
        ...entry,
        media: Array.isArray(entry?.media) ? entry.media.map((media) => ({ ...media })) : [],
      }));

      for (const file of files) {
        if (!file.isFile() || !isSupportedLibraryPath(file.name)) continue;
        const relativePath = normalizeProjectMediaPath(ctx.projectDir, `${LIBRARY_FOLDER}/${file.name}`);
        if (!relativePath || knownPaths.has(relativePath)) continue;

        const titleStem = path.posix.basename(file.name, path.posix.extname(file.name));
        nextLibrary.push({
          id: randomUUID(),
          title: titleCase(titleStem),
          name: titleCase(titleStem),
          content: "",
          path: `library/${slugifyName(titleStem)}.md`,
          folder: null,
          media: [
            {
              id: randomUUID(),
              label: file.name,
              kind: libraryKindForPath(file.name),
              path: relativePath,
            },
          ],
        });
        knownPaths.add(relativePath);
        imported.push(relativePath);
      }

      const changed = imported.length > 0;
      if (changed) {
        await writeProjectMetadata(ctx.projectDir, {
          ...metadata,
          library: nextLibrary,
          project: {
            ...(metadata.project || {}),
            updatedAt: new Date().toISOString(),
          },
        });
      }
      const index = await refreshProjectIndex(ctx.projectDir);
      return {
        changed,
        count: imported.length,
        imported,
        summary: {
          library: Array.isArray(index?.assets?.library) ? index.assets.library.length : nextLibrary.length,
        },
      };
    },
  });

  registerTool("link_library_assets", {
    tier: "edit",
    description:
      "Attach shared library media to a character, location, prop, keyframe, or audio entry WITHOUT copying files. The library entry stays the single source of truth; the target entity links by path. Use this when you want to reuse one raw file across many entities. For owned-copy semantics use attach_media with mode:'copy'.",
    args: {
      section: "required one of: characters | locations | props | keyframes | audio",
      assetId: "optional target asset id",
      assetName: "optional target asset name/title substring; creates a new entry when missing",
      libraryIds: "required array of library asset ids",
      mode: "optional append | replace; default append",
    },
    async run({ section, assetId, assetName, libraryIds, mode = "append" }, ctx) {
      const normalizedSection = normalizeAssetSection(section);
      if (!normalizedSection) {
        throw new Error(`link_library_assets: 'section' must be one of ${assetSections().join(", ")}.`);
      }
      if (!Array.isArray(libraryIds) || !libraryIds.length) {
        throw new Error("link_library_assets: 'libraryIds' must be a non-empty array.");
      }

      const metadata = await readProjectMetadata(ctx.projectDir);
      const library = libraryEntries(metadata);
      const selectedLibrary = library.filter((entry) => libraryIds.includes(entry.id));
      if (!selectedLibrary.length) {
        throw new Error("link_library_assets: no matching library assets found.");
      }

      const currentEntries = Array.isArray(metadata[normalizedSection]) ? metadata[normalizedSection] : [];
      const normalizedAssetName = String(assetName || "").trim().toLowerCase();
      let targetEntry =
        currentEntries.find((entry) => assetId && entry?.id === assetId) ||
        currentEntries.find((entry) => normalizedAssetName && String(entry?.name || entry?.title || "").toLowerCase().includes(normalizedAssetName)) ||
        null;

      let created = false;
      if (!targetEntry) {
        const cleanName = String(assetName || "").trim();
        if (!cleanName) {
          throw new Error("link_library_assets: target asset not found and 'assetName' was empty.");
        }
        targetEntry = makeAssetEntry(normalizedSection, cleanName);
        created = true;
      }

      const nextMedia = mode === "replace" ? [] : [...(Array.isArray(targetEntry.media) ? targetEntry.media : [])];
      const existingPaths = new Set(nextMedia.map((media) => normalizeProjectMediaPath(ctx.projectDir, media?.path)).filter(Boolean));
      const expectedKind = normalizedSection === "audio" ? "audio" : "image";
      let attachedCount = 0;

      for (const libraryEntry of selectedLibrary) {
        for (const media of Array.isArray(libraryEntry?.media) ? libraryEntry.media : []) {
          const relativePath = normalizeProjectMediaPath(ctx.projectDir, media?.path);
          if (!relativePath || existingPaths.has(relativePath)) continue;
          const mediaKind = media?.kind || libraryKindForPath(relativePath);
          if (mediaKind !== expectedKind) continue;
          nextMedia.push({
            id: randomUUID(),
            label: media?.label || path.posix.basename(relativePath),
            kind: mediaKind,
            path: relativePath,
          });
          existingPaths.add(relativePath);
          attachedCount += 1;
        }
      }

      if (attachedCount === 0) {
        throw new Error(
          `link_library_assets: selected library assets did not contain any ${expectedKind} media to attach to ${normalizedSection}.`,
        );
      }

      const nextEntry = { ...targetEntry, media: nextMedia };
      const nextEntries = created
        ? [...currentEntries, nextEntry]
        : currentEntries.map((entry) => (entry.id === nextEntry.id ? nextEntry : entry));

      await writeProjectMetadata(ctx.projectDir, {
        ...metadata,
        [normalizedSection]: nextEntries,
        project: {
          ...(metadata.project || {}),
          updatedAt: new Date().toISOString(),
        },
      });
      await refreshProjectIndex(ctx.projectDir);

      return {
        section: normalizedSection,
        assetId: nextEntry.id,
        assetName: nextEntry.name || nextEntry.title,
        linked: selectedLibrary.map((entry) => entry.id),
        created,
        mediaCount: nextEntry.media.length,
      };
    },
  });
};
