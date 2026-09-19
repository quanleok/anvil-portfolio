const fs = require("node:fs/promises");
const fsConstants = require("node:fs").constants;
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const {
  readMediaIndex,
  writeMediaIndex,
  buildMediaIndex,
  reconcileMedia,
  computeReferences,
} = require("../../media.cjs");

module.exports = function registerMediaIndexTools(api) {
  const {
    registerTool,
    resolveInside,
    readProjectMetadata,
    writeProjectMetadata,
    refreshProjectIndex,
    normalizeRelativePath,
    assertWritablePath,
  } = api;

  async function fileExists(absolutePath) {
    try {
      await fs.access(absolutePath, fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  function toProjectRelativePath(projectDir, absolutePath) {
    return path.relative(projectDir, absolutePath).split(path.sep).join("/");
  }

  async function moveProjectMediaToTemporaryTrash(projectDir, relativePath) {
    const absolutePath = resolveInside(projectDir, relativePath);
    const trashDir = resolveInside(projectDir, "assets/inbox");
    await fs.mkdir(trashDir, { recursive: true });
    const ext = path.extname(relativePath);
    const base = path.basename(relativePath, ext) || "media";
    let destination = path.join(trashDir, `${base}${ext}`);
    let suffix = 2;
    while (await fileExists(destination)) {
      destination = path.join(trashDir, `${base}-${suffix}${ext}`);
      suffix += 1;
    }
    await fs.rename(absolutePath, destination);
    return toProjectRelativePath(projectDir, destination);
  }

  // ---------------------------------------------------------------------------
  // list_media
  // ---------------------------------------------------------------------------
  registerTool("list_media", {
    tier: "domain",
    description:
      "List all media files in the project's unified media index. Filter by kind, source, tags, unused (no entity references), or query substring.",
    args: {
      kind: "optional image | audio | video | document",
      source: "optional pool | library | asset",
      unused: "optional boolean — only files with no entity references",
      query: "optional substring match over path or filename",
    },
    async run({ kind, source, unused, query }, { projectDir, metadata }) {
      const index = await readMediaIndex(projectDir);
      const withRefs = computeReferences(metadata, index);

      const normalizedKind = typeof kind === "string" && kind.trim() ? kind.trim() : "";
      const normalizedSource = typeof source === "string" && source.trim() ? source.trim() : "";
      const normalizedQuery = String(query || "").trim().toLowerCase();

      const records = Object.values(withRefs).filter((record) => {
        if (normalizedKind && record.kind !== normalizedKind) return false;
        if (normalizedSource && record.source !== normalizedSource) return false;
        if (unused && Array.isArray(record.referencedBy) && record.referencedBy.length > 0) return false;
        if (normalizedQuery) {
          const label = path.basename(record.path || "").toLowerCase();
          const pathLower = (record.path || "").toLowerCase();
          if (!label.includes(normalizedQuery) && !pathLower.includes(normalizedQuery)) return false;
        }
        return true;
      });

      return { records, count: records.length };
    },
  });

  // ---------------------------------------------------------------------------
  // scan_media
  // ---------------------------------------------------------------------------
  registerTool("scan_media", {
    tier: "edit",
    description:
      "Scan the project's assets/ directory and reconcile the media index with what's on disk. Reports added, removed, and moved files.",
    args: {},
    async run(_args, { projectDir, metadata }) {
      // reconcileMedia now returns its freshIndex so we don't re-walk +
      // re-hash every file. Pre-fix this called buildMediaIndex twice per
      // scan_media — visible latency on 100+-image projects. Audit
      // asset-H5 (2026-04-20).
      const diff = await reconcileMedia(projectDir);
      const freshIndex = diff.freshIndex;
      await writeMediaIndex(projectDir, freshIndex);

      // Compute reference counts on the fresh index to find orphans
      const withRefs = computeReferences(metadata, freshIndex);
      const orphanIds = Object.values(withRefs)
        .filter((r) => !r.referencedBy || r.referencedBy.length === 0)
        .map((r) => r.id);

      return {
        added: diff.added.length,
        removed: diff.removed.length,
        moved: diff.moved.length,
        unchanged: diff.unchanged,
        total: diff.total,
        addedItems: diff.added.map((r) => ({ id: r.id, path: r.path, kind: r.kind })),
        removedItems: diff.removed.map((r) => ({ id: r.id, path: r.path, kind: r.kind })),
        movedItems: diff.moved.map((r) => ({ id: r.id, path: r.path, kind: r.kind })),
        orphanCount: orphanIds.length,
        orphanIds,
      };
    },
  });

  // ---------------------------------------------------------------------------
  // attach_media
  // ---------------------------------------------------------------------------
  registerTool("attach_media", {
    tier: "edit",
    description:
      "Attach a media file to an entity (character, location, prop, keyframe, audio) by adding it to the entity's media array. Use mode 'copy' to duplicate the file, or 'reference' (default) to link without copying.",
    args: {
      mediaId: "required media index ID",
      section: "required section: characters | locations | props | keyframes | audio",
      entityId: "required entity ID within the section",
      mode: "optional reference (default) | copy",
    },
    async run({ mediaId, section, entityId, mode }, { projectDir, metadata: _ctxMeta }) {
      const id = String(mediaId || "").trim();
      if (!id) throw new Error("attach_media: 'mediaId' is required.");
      const sectionName = String(section || "").trim();
      if (!sectionName) throw new Error("attach_media: 'section' is required.");
      const entId = String(entityId || "").trim();
      if (!entId) throw new Error("attach_media: 'entityId' is required.");

      const index = await readMediaIndex(projectDir);
      const record = index[id];
      if (!record) throw new Error(`attach_media: media '${id}' not found in index.`);
      // Verify the file still exists on disk between scan and attach. The
      // index might be stale (file deleted in Finder / by another tool /
      // by concurrent delete_media). Without this check we'd record a
      // phantom path on the entity. Audit asset-M7 (2026-04-20).
      const sourceAbsCheck = resolveInside(projectDir, record.path);
      try {
        const stat = await fs.stat(sourceAbsCheck);
        if (!stat.isFile()) {
          throw new Error(`attach_media: '${record.path}' exists but is not a file.`);
        }
      } catch (err) {
        if (err?.code === "ENOENT") {
          throw new Error(`attach_media: media file '${record.path}' no longer exists on disk — call scan_media to refresh the index.`);
        }
        throw err;
      }

      const metadata = await readProjectMetadata(projectDir);
      const entries = Array.isArray(metadata[sectionName]) ? metadata[sectionName] : [];
      const entityIdx = entries.findIndex((e) => e && e.id === entId);
      if (entityIdx === -1) {
        throw new Error(`attach_media: entity '${entId}' not found in section '${sectionName}'.`);
      }

      let mediaPath = normalizeRelativePath(record.path);
      const copyMode = mode === "copy";

      if (copyMode) {
        // Copy file into assets/<section>/. Guards added 2026-04-20 audit:
        // - L5: if the source IS already at the target path (e.g. user
        //   re-attaches a file already in assets/<section>/), no-op the
        //   copy to avoid copyFile-onto-self truncation.
        // - H2: pass COPYFILE_EXCL so we never silently overwrite an
        //   existing destination file. On EEXIST, append a counter
        //   (alex-2.png, alex-3.png…) so two files with the same basename
        //   coexist instead of clobbering each other.
        const sourceAbs = resolveInside(projectDir, record.path);
        const basename = path.basename(record.path);
        let destRelative = normalizeRelativePath(`assets/${sectionName}/${basename}`);
        let destAbs = resolveInside(projectDir, destRelative);
        if (sourceAbs === destAbs) {
          mediaPath = destRelative; // already in place; skip copy
        } else {
          await fs.mkdir(path.dirname(destAbs), { recursive: true });
          const ext = path.extname(basename);
          const stem = basename.slice(0, basename.length - ext.length);
          let counter = 1;
          while (true) {
            try {
              await fs.copyFile(sourceAbs, destAbs, fsConstants.COPYFILE_EXCL);
              break;
            } catch (error) {
              if (error?.code !== "EEXIST") throw error;
              counter += 1;
              const next = `${stem}-${counter}${ext}`;
              destRelative = normalizeRelativePath(`assets/${sectionName}/${next}`);
              destAbs = resolveInside(projectDir, destRelative);
              if (counter > 999) {
                throw new Error(`attach_media: could not find a free name after 999 tries for ${basename}`);
              }
            }
          }
          mediaPath = destRelative;
        }
      }

      // Idempotent: if the entity already has this path attached, return
      // without duplicating. A double-call used to produce two entries for
      // the same file, which tripped delete_asset_entry's refcount logic
      // (raw-occurrence counting thought the entity "shared" with itself
      // and orphaned the file on cleanup).
      const existingMedia = Array.isArray(entries[entityIdx].media) ? entries[entityIdx].media : [];
      const existing = existingMedia.find(
        (m) => m && typeof m.path === "string" && normalizeRelativePath(m.path) === mediaPath,
      );
      if (existing) {
        return {
          updated: false,
          alreadyAttached: true,
          entity: entries[entityIdx],
          mediaEntry: existing,
        };
      }

      const mediaEntry = {
        id: randomUUID(),
        path: mediaPath,
        kind: record.kind,
        label: path.basename(mediaPath),
      };

      const updatedEntry = {
        ...entries[entityIdx],
        media: [...existingMedia, mediaEntry],
      };

      const updatedEntries = [
        ...entries.slice(0, entityIdx),
        updatedEntry,
        ...entries.slice(entityIdx + 1),
      ];

      const nextMetadata = {
        ...metadata,
        [sectionName]: updatedEntries,
        project: {
          ...(metadata.project || {}),
          updatedAt: new Date().toISOString(),
        },
      };

      await writeProjectMetadata(projectDir, nextMetadata);
      await refreshProjectIndex(projectDir);

      return { updated: true, entity: updatedEntry };
    },
  });

  // ---------------------------------------------------------------------------
  // detach_media
  // ---------------------------------------------------------------------------
  registerTool("detach_media", {
    tier: "edit",
    description:
      "Remove a media reference from an entity without deleting the underlying file.",
    args: {
      mediaId: "required media index ID to detach",
      section: "required section: characters | locations | props | keyframes | audio",
      entityId: "required entity ID within the section",
    },
    async run({ mediaId, section, entityId }, { projectDir, metadata: _ctxMeta }) {
      const id = String(mediaId || "").trim();
      if (!id) throw new Error("detach_media: 'mediaId' is required.");
      const sectionName = String(section || "").trim();
      if (!sectionName) throw new Error("detach_media: 'section' is required.");
      const entId = String(entityId || "").trim();
      if (!entId) throw new Error("detach_media: 'entityId' is required.");

      const index = await readMediaIndex(projectDir);
      const record = index[id];
      if (!record) throw new Error(`detach_media: media '${id}' not found in index.`);

      const metadata = await readProjectMetadata(projectDir);
      const entries = Array.isArray(metadata[sectionName]) ? metadata[sectionName] : [];
      const entityIdx = entries.findIndex((e) => e && e.id === entId);
      if (entityIdx === -1) {
        throw new Error(`detach_media: entity '${entId}' not found in section '${sectionName}'.`);
      }

      const mediaList = Array.isArray(entries[entityIdx].media) ? entries[entityIdx].media : [];
      const normalizedPath = normalizeRelativePath(record.path);
      const updatedMedia = mediaList.filter(
        (m) => normalizeRelativePath(m?.path || "") !== normalizedPath,
      );
      // Previously this returned {updated: true} even when nothing matched —
      // an agent calling detach_media with the wrong (section, entityId)
      // combination got a misleading success response while the reference
      // stayed in place. Report the no-match case honestly instead.
      if (updatedMedia.length === mediaList.length) {
        return {
          updated: false,
          notAttached: true,
          entity: entries[entityIdx],
          mediaPath: normalizedPath,
        };
      }

      const updatedEntry = { ...entries[entityIdx], media: updatedMedia };
      const updatedEntries = [
        ...entries.slice(0, entityIdx),
        updatedEntry,
        ...entries.slice(entityIdx + 1),
      ];

      const nextMetadata = {
        ...metadata,
        [sectionName]: updatedEntries,
        project: {
          ...(metadata.project || {}),
          updatedAt: new Date().toISOString(),
        },
      };

      await writeProjectMetadata(projectDir, nextMetadata);
      await refreshProjectIndex(projectDir);

      return { updated: true, entity: updatedEntry };
    },
  });

  // ---------------------------------------------------------------------------
  // delete_media
  // ---------------------------------------------------------------------------
  registerTool("delete_media", {
    tier: "edit",
    description:
      "Move a media file to temporary trash (assets/inbox/) and remove it from the index. Refuses if the media is referenced by entities unless force is true.",
    args: {
      mediaId: "required media index ID",
      force: "optional boolean — delete even if referenced by entities",
    },
    async run({ mediaId, force }, { projectDir }) {
      const id = String(mediaId || "").trim();
      if (!id) throw new Error("delete_media: 'mediaId' is required.");

      const index = await readMediaIndex(projectDir);
      const record = index[id];
      if (!record) throw new Error(`delete_media: media '${id}' not found in index.`);

      // Always read fresh metadata — a stale ctx copy could miss recent
      // attach_media / detach_media edits and either block a valid delete
      // or miss entities that need ref-stripping on force=true.
      const metadataForRefs = await readProjectMetadata(projectDir);
      const withRefs = computeReferences(metadataForRefs, { ...index });
      const updatedRecord = withRefs[id];
      const referencedBy = Array.isArray(updatedRecord?.referencedBy) ? updatedRecord.referencedBy : [];

      if (referencedBy.length > 0 && !force) {
        return {
          ok: false,
          error: `Media '${id}' is referenced by ${referencedBy.length} entity(s). Pass force: true to delete anyway.`,
          referencedBy,
        };
      }

      // Read-only enforcement — refuse if the user has explicitly locked
      // the underlying media path. Distinct from the reference-count gate
      // above; that one protects against orphaning entity links, this one
      // protects against agents wiping a file the user marked off-limits.
      if (typeof assertWritablePath === "function" && record.path) {
        await assertWritablePath(projectDir, record.path, "deleting");
      }

      // Move to temporary trash instead of destroying user media.
      let trashedPath = null;
      try {
        trashedPath = await moveProjectMediaToTemporaryTrash(projectDir, record.path);
      } catch (err) {
        if (err?.code !== "ENOENT") throw err;
      }

      // force=true: strip dangling references from entity media[] arrays.
      // Without this pass, the file + index entry disappear but every
      // entity that referenced it still lists { path, kind, label } pointing
      // at a non-existent file. Agents calling delete_media(force:true) saw
      // {ok:true} and assumed cleanup was complete while project.json quietly
      // held broken links.
      let strippedRefs = 0;
      const strippedEntities = [];
      if (force && referencedBy.length > 0) {
        const targetPath = String(record.path || "").replace(/\\/g, "/");
        const sectionsToScan = ["characters", "locations", "props", "keyframes", "audio", "library"];
        const freshMetadata = await readProjectMetadata(projectDir);
        const nextMetadata = { ...freshMetadata };
        let metadataChanged = false;
        for (const sectionName of sectionsToScan) {
          const entries = Array.isArray(freshMetadata[sectionName]) ? freshMetadata[sectionName] : [];
          let sectionChanged = false;
          const nextEntries = entries.map((entry) => {
            if (!entry || !Array.isArray(entry.media) || entry.media.length === 0) return entry;
            const nextMedia = entry.media.filter(
              (m) => !m || typeof m.path !== "string" || m.path.replace(/\\/g, "/") !== targetPath,
            );
            if (nextMedia.length === entry.media.length) return entry;
            sectionChanged = true;
            metadataChanged = true;
            strippedRefs += entry.media.length - nextMedia.length;
            strippedEntities.push({ section: sectionName, id: entry.id, name: entry.name || entry.title || entry.id });
            return { ...entry, media: nextMedia };
          });
          if (sectionChanged) nextMetadata[sectionName] = nextEntries;
        }
        if (metadataChanged) {
          nextMetadata.project = {
            ...(freshMetadata.project || {}),
            updatedAt: new Date().toISOString(),
          };
          await writeProjectMetadata(projectDir, nextMetadata);
          await refreshProjectIndex(projectDir);
        }
      }

      // Remove from index and write
      const nextIndex = { ...index };
      delete nextIndex[id];
      await writeMediaIndex(projectDir, nextIndex);

      // Cleanup already done once at the `if (force && referencedBy.length)`
      // block above — scripts-lane (be7b293) and context-lane (99f0d6c) both
      // tackled asset-H1 independently; scripts' version landed first and its
      // reference-stripping runs BEFORE the index write, so we keep that flow
      // and its {strippedRefs, strippedEntities} response shape (tests rely
      // on these field names).
      return {
        ok: true,
        deleted: true,
        id,
        path: record.path,
        trashedPath,
        strippedRefs,
        strippedEntities,
      };
    },
  });

  // ---------------------------------------------------------------------------
  // find_duplicate_media
  // ---------------------------------------------------------------------------
  // Groups media files in the index by SHA-256 so the agent can spot the
  // same content uploaded under different paths (a character's portrait
  // re-uploaded as a keyframe, library copies of a stock background, etc.)
  // without re-hashing anything — `scan_media` already populates sha256.
  registerTool("find_duplicate_media", {
    tier: "domain",
    description:
      "Find media files in the project index that share the exact same content (matched by SHA-256 hash). Returns groups where two or more files have the same content. Pass kind to limit to image/audio/video/document. Each group includes the full file list with paths, sizes, and which entities reference each duplicate so the agent can decide which copy to keep.",
    args: {
      kind: "optional image | audio | video | document",
      minGroupSize: "optional integer, default 2 — only return groups with at least this many files",
    },
    async run({ kind, minGroupSize = 2 }, { projectDir, metadata }) {
      const index = await readMediaIndex(projectDir);
      const withRefs = computeReferences(metadata, index);
      const minSize = Math.max(2, Number(minGroupSize) || 2);
      const normalizedKind = typeof kind === "string" && kind.trim() ? kind.trim() : "";

      const buckets = new Map();
      for (const record of Object.values(withRefs)) {
        const sha = record?.sha256;
        if (!sha) continue;
        if (normalizedKind && record.kind !== normalizedKind) continue;
        if (!buckets.has(sha)) buckets.set(sha, []);
        buckets.get(sha).push({
          id: record.id,
          path: record.path,
          kind: record.kind,
          source: record.source,
          sizeBytes: record.sizeBytes ?? null,
          referencedBy: Array.isArray(record.referencedBy) ? record.referencedBy : [],
        });
      }

      const groups = [];
      for (const [sha256, items] of buckets) {
        if (items.length < minSize) continue;
        // Sort each group by reference count desc so the agent sees the
        // "primary" (most-referenced) copy first when picking which to keep.
        items.sort((a, b) => (b.referencedBy.length || 0) - (a.referencedBy.length || 0));
        groups.push({
          sha256,
          count: items.length,
          totalSizeBytes: items.reduce((sum, item) => sum + (item.sizeBytes || 0), 0),
          items,
        });
      }
      // Largest groups first — biggest cleanup wins surface at the top.
      groups.sort((a, b) => b.count - a.count);

      return {
        groupCount: groups.length,
        duplicateFileCount: groups.reduce((sum, g) => sum + g.count, 0),
        reclaimableBytes: groups.reduce(
          (sum, g) => sum + (g.totalSizeBytes - (g.items[0]?.sizeBytes || 0)),
          0,
        ),
        groups,
      };
    },
  });

  // ---------------------------------------------------------------------------
  // get_media_refs
  // ---------------------------------------------------------------------------
  registerTool("get_media_refs", {
    tier: "domain",
    description: "Get all entities that reference a specific media file.",
    args: {
      mediaId: "required media index ID",
    },
    async run({ mediaId }, { projectDir, metadata }) {
      const id = String(mediaId || "").trim();
      if (!id) throw new Error("get_media_refs: 'mediaId' is required.");

      const index = await readMediaIndex(projectDir);
      if (!index[id]) throw new Error(`get_media_refs: media '${id}' not found in index.`);

      const withRefs = computeReferences(metadata, { ...index });
      const record = withRefs[id];
      const referencedBy = Array.isArray(record?.referencedBy) ? record.referencedBy : [];

      // Build entity details for each referenced ID
      const entityDetails = [];
      const sections = ["characters", "locations", "props", "keyframes", "audio", "library"];
      for (const section of sections) {
        const entries = Array.isArray(metadata[section]) ? metadata[section] : [];
        for (const entry of entries) {
          if (entry && referencedBy.includes(entry.id)) {
            entityDetails.push({
              id: entry.id,
              name: entry.name || entry.id,
              section,
            });
          }
        }
      }

      return {
        mediaId: id,
        path: record.path,
        kind: record.kind,
        referencedBy: entityDetails,
        count: entityDetails.length,
      };
    },
  });
};
