const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { pathToFileURL } = require("node:url");
// asset-groups.cjs deleted in the 2026-05-04 bloat-cuts pass.
// Each writeProjectMetadata below used to normalize assetGroups so
// dangling memberIds got pruned. With AssetGroup gone, that scrub
// is a no-op.
const { readMediaIndex, writeMediaIndex, buildMediaIndex, computeReferences } = require("../../media.cjs");
const {
  normalizeEntityRefs,
  serializeEntityRefsMeta,
  extractLegacyAssetRefs,
  ENTITY_REF_SECTIONS,
} = require("../../entity-refs.cjs");

// Doc sections whose entries can carry entityRefs back to asset
// entries (characters/locations/props/keyframes/audio). Keep this
// list aligned with read_asset_bundle's usageBuckets — if a new doc
// section starts holding entityRefs, both lists need to know.
const ENTITY_REF_DOC_SECTIONS = ["script", "shots", "prompts", "dialogue"];

// Strip entityRefs that point at the deleted asset ids from every doc
// entry in the project. Cleans both the runtime top-level array
// (entry.entityRefs) and the persisted serialized form (entry.meta.entityRefs
// + the per-section legacy keys meta.characters / meta.locations / ...).
// Returns true if any entry was mutated. Called from delete_asset_entry
// and delete_asset_entries before writeProjectMetadata so dangling refs
// never reach disk. Pre-fix (review H1, 2026-05-04): stale entity ids
// accumulated forever in doc meta; read_asset_bundle's usedBy[] feed and
// the renderer's entity-refs highlighter silently held them.
function stripEntityRefsFromMetadata(metadata, deletedIds) {
  if (!deletedIds) return false;
  const idSet = deletedIds instanceof Set ? deletedIds : new Set(deletedIds);
  if (idSet.size === 0) return false;
  let mutated = false;

  for (const docSection of ENTITY_REF_DOC_SECTIONS) {
    const entries = Array.isArray(metadata?.[docSection]) ? metadata[docSection] : [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;

      // Runtime top-level array form. Many read paths hydrate
      // entry.entityRefs from meta and write back, so the array
      // form is real on disk too.
      if (Array.isArray(entry.entityRefs)) {
        const before = entry.entityRefs.length;
        entry.entityRefs = entry.entityRefs.filter(
          (ref) => ref && !idSet.has(String(ref.entityId || "")),
        );
        if (entry.entityRefs.length !== before) mutated = true;
      }

      // Persisted serialized form under meta.
      if (entry.meta && typeof entry.meta === "object") {
        const explicit = normalizeEntityRefs(entry.meta.entityRefs);
        const legacy = extractLegacyAssetRefs(entry.meta);

        const filteredExplicit = explicit.filter((ref) => !idSet.has(ref.entityId));
        const filteredLegacy = {};
        let legacyChanged = false;
        for (const section of ENTITY_REF_SECTIONS) {
          const items = Array.isArray(legacy[section]) ? legacy[section] : [];
          const filtered = items.filter((token) => !idSet.has(token));
          if (filtered.length) filteredLegacy[section] = filtered;
          if (filtered.length !== items.length) legacyChanged = true;
        }

        const explicitChanged = filteredExplicit.length !== explicit.length;
        if (explicitChanged || legacyChanged) {
          mutated = true;
          // Rebuild meta: drop existing entityRefs + section legacy keys,
          // then merge back via the canonical serializer so the file shape
          // matches what create/update paths produce.
          const nextMeta = { ...entry.meta };
          delete nextMeta.entityRefs;
          for (const section of ENTITY_REF_SECTIONS) delete nextMeta[section];
          Object.assign(nextMeta, serializeEntityRefsMeta(filteredExplicit, filteredLegacy));
          entry.meta = nextMeta;
        }
      }
    }
  }
  return mutated;
}

module.exports = function registerAssetTools(api) {
  const {
    registerTool,
    readProjectMetadata,
    writeProjectMetadata,
    refreshProjectIndex,
    syncAssetDirectoryFiles,
    truncateText,
    normalizeAssetSection,
    assetSections,
    normalizeProjectMediaPath,
    absoluteProjectMediaPath,
    ensureUniqueRelativePathExcept,
    resolveInside,
    slugifyName,
    makeAssetEntry,
    mediaKindForSection,
    assertWritablePath,
  } = api;

  function deletableAssetSections() {
    return ["library", ...assetSections()];
  }

  function fileUrlFor(absolutePath) {
    return absolutePath ? pathToFileURL(absolutePath).href : "";
  }

  async function fileExists(absolutePath) {
    try {
      await fs.access(absolutePath);
      return true;
    } catch {
      return false;
    }
  }

  function toProjectRelativePath(projectDir, absolutePath) {
    return path.relative(projectDir, absolutePath).split(path.sep).join("/");
  }

  async function moveProjectMediaToTemporaryTrash(projectDir, relativePath) {
    const absolutePath = absoluteProjectMediaPath(projectDir, relativePath);
    if (!absolutePath) return null;
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

  async function rebuildMediaIndexForMetadata(projectDir, metadata) {
    const freshIndex = await buildMediaIndex(projectDir);
    await writeMediaIndex(projectDir, computeReferences(metadata, freshIndex));
  }

  // Heuristic — guess audioKind from a name or filename. Used at create
  // time so a freshly-imported "thunder_clap.wav" lands as sfx instead of
  // the default music. Token order matters: voice patterns are checked
  // before sfx because "voice_sfx" is more useful tagged voice.
  function guessAudioKind(text) {
    // Normalize separators so "thunder_clap_sfx" / "thunder-clap.sfx" /
    // "thunder/clap/sfx" all surface "sfx" as a free-standing token.
    const haystack = String(text || "").toLowerCase().replace(/[_\-./]/g, " ");
    if (!haystack.trim()) return "music";
    if (/\b(vo|voiceover|narration|narrator|dialog|dialogue)\b/.test(haystack)) {
      return "voiceover";
    }
    if (/\b(ambient|ambience|atmos|atmosphere|room ?tone|wind|rain|forest|crowd)\b/.test(haystack)) {
      return "ambient";
    }
    if (/\b(sfx|fx|effect|foley|impact|whoosh|swoosh|hit|punch|explosion|crash|thunder|click|beep|swoop|riser|stinger)\b/.test(haystack)) {
      return "sfx";
    }
    return "music";
  }

  function normalizeAssetEntryKind(section, value) {
    const normalizedSection = normalizeAssetSection(section);
    if (!["characters", "locations", "keyframes"].includes(normalizedSection)) {
      return null;
    }
    const raw = String(value || "").trim().toLowerCase();
    return raw === "sheet" ? "sheet" : "single";
  }

  registerTool("list_assets", {
    tier: "domain",
    description:
      "List asset entries from Forge metadata. Faster and more reliable than searching the filesystem when you need characters, locations, props, keyframes, or audio.",
    args: {
      section: "optional characters | locations | props | keyframes | audio",
      query: "optional substring filter by name/title/media path",
      includeMedia: "optional boolean, default true",
    },
    async run({ section, query = "", includeMedia = true }, ctx) {
      const metadata = await readProjectMetadata(ctx.projectDir);
      const sections = ["characters", "locations", "props", "keyframes", "audio"];
      const requestedSections = typeof section === "string" && sections.includes(section.trim())
        ? [section.trim()]
        : sections;
      const normalizedQuery = String(query || "").trim().toLowerCase();

      const result = {};
      for (const key of requestedSections) {
        const entries = Array.isArray(metadata?.[key]) ? metadata[key] : [];
        result[key] = entries
          .filter((entry) => {
            if (!normalizedQuery) return true;
            const media = Array.isArray(entry?.media) ? entry.media : [];
            const haystack = [
              entry?.name,
              entry?.title,
              entry?.path,
              ...media.flatMap((item) => [item?.label, item?.path]),
            ]
              .map((value) => String(value || "").toLowerCase())
              .join("\n");
            return haystack.includes(normalizedQuery);
          })
          .map((entry) => ({
            id: entry.id,
            name: entry.name || entry.title || "",
            path: entry.path || "",
            content: typeof entry.content === "string" ? truncateText(entry.content, 1000).content : "",
            kind: normalizeAssetEntryKind(key, entry.kind) || undefined,
            media: includeMedia
              ? (Array.isArray(entry.media) ? entry.media : []).map((media) => ({
                  id: media.id,
                  kind: media.kind,
                  label: media.label,
                  path: media.path,
                }))
              : undefined,
            ...(key === "audio" && entry.audioKind ? { audioKind: entry.audioKind } : {}),
          }));
      }

      return result;
    },
  });

  registerTool("read_asset_bundle", {
    tier: "domain",
    description:
      "Read one asset entry with its notes and media references in a single turn. Use this for character/location/prop/keyframe/audio work instead of reading project.json.",
    args: {
      section: "required characters | locations | props | keyframes | audio",
      assetId: "optional asset id",
      name: "optional asset name/title substring",
      includeContent: "optional boolean, default true",
    },
    async run({ section, assetId, name, includeContent = true }, ctx) {
      const normalizedSection = normalizeAssetSection(section);
      if (!normalizedSection) {
        throw new Error("read_asset_bundle: valid 'section' is required.");
      }

      const metadata = await readProjectMetadata(ctx.projectDir);
      const entries = Array.isArray(metadata?.[normalizedSection]) ? metadata[normalizedSection] : [];
      const normalizedName = String(name || "").trim().toLowerCase();

      // Disambiguation rules (audit asset-M1, 2026-04-20):
      //   1. assetId match wins outright.
      //   2. Otherwise, if `name` is given, prefer EXACT lowercase match
      //      to a name/title; if there's exactly one substring match
      //      take it; if there are multiple, refuse with a candidates
      //      list so the agent can re-call with the right id.
      let entry = assetId ? entries.find((item) => item?.id === assetId) : null;
      if (!entry && normalizedName) {
        const exact = entries.filter((item) => {
          const n = String(item?.name || item?.title || "").toLowerCase();
          return n === normalizedName;
        });
        if (exact.length === 1) {
          entry = exact[0];
        } else {
          const partial = entries.filter((item) => {
            const n = String(item?.name || item?.title || "").toLowerCase();
            return n.includes(normalizedName);
          });
          if (partial.length === 1) {
            entry = partial[0];
          } else if (partial.length > 1) {
            const candidates = partial.slice(0, 10).map((item) => ({
              id: item.id,
              name: item.name || item.title || "",
            }));
            throw new Error(
              `read_asset_bundle: name '${name}' matches ${partial.length} entries in ${normalizedSection}; pass assetId to disambiguate. Candidates: ${JSON.stringify(candidates)}`,
            );
          }
        }
      }

      if (!entry) {
        throw new Error(`read_asset_bundle: asset not found in ${normalizedSection}.`);
      }

      const media = await Promise.all((Array.isArray(entry?.media) ? entry.media : []).map(async (item) => {
        const relativePath = normalizeProjectMediaPath(ctx.projectDir, item?.path);
        const absolutePath = absoluteProjectMediaPath(ctx.projectDir, relativePath);
        let exists = false;
        if (absolutePath) {
          try {
            const stat = await fs.stat(absolutePath);
            exists = stat.isFile();
          } catch {
            exists = false;
          }
        }
        return {
          id: item?.id || null,
          kind: item?.kind || null,
          label: item?.label || "",
          path: relativePath,
          exists,
          fileUrl: exists ? fileUrlFor(absolutePath) : "",
        };
      }));

      // usedBy[] — every script/shot/prompt/dialogue entry that
      // entityRefs this asset, with its role. Closes the agent's biggest
      // blind spot: previously read_asset_bundle returned the asset alone
      // and the agent had to grep prompts to learn where it was actually
      // used. (Asset audit, 2026-04-27.)
      const usedBy = [];
      const usageBuckets = [
        { section: "script", entries: Array.isArray(metadata.script) ? metadata.script : [] },
        { section: "shots", entries: Array.isArray(metadata.shots) ? metadata.shots : [] },
        { section: "prompts", entries: Array.isArray(metadata.prompts) ? metadata.prompts : [] },
        { section: "dialogue", entries: Array.isArray(metadata.dialogue) ? metadata.dialogue : [] },
      ];
      const roleCounts = { featured: 0, mentioned: 0, background: 0 };
      for (const bucket of usageBuckets) {
        for (const docEntry of bucket.entries) {
          const refs = normalizeEntityRefs(docEntry?.entityRefs);
          for (const ref of refs) {
            if (ref?.entityId !== entry.id) continue;
            if (ref?.section && ref.section !== normalizedSection) continue;
            const role = ref.role && ["featured", "mentioned", "background"].includes(ref.role)
              ? ref.role
              : "featured";
            roleCounts[role] = (roleCounts[role] || 0) + 1;
            usedBy.push({
              section: bucket.section,
              id: docEntry.id || "",
              title: docEntry.title || docEntry.name || "",
              path: docEntry.path || "",
              role,
              sceneId: docEntry.sceneId || null,
              shotId: docEntry.shotId || null,
            });
            break; // One entityRef per doc per asset is enough.
          }
        }
      }

      // mediaRefs[] — for each bound media path, list other entities that
      // share the same file. Lets the agent decide whether replacing or
      // detaching media will affect other assets/videos. Skipped silently
      // if the media index hasn't been built yet (fresh project).
      let mediaRefs = [];
      try {
        const rawIndex = await readMediaIndex(ctx.projectDir);
        const indexed = computeReferences(metadata, rawIndex);
        const byPath = new Map();
        for (const record of Object.values(indexed)) {
          if (record?.path) byPath.set(record.path, record);
        }
        for (const m of media) {
          if (!m.path) continue;
          const record = byPath.get(m.path);
          if (!record) continue;
          const otherRefs = (Array.isArray(record.referencedBy) ? record.referencedBy : [])
            .filter((refId) => refId !== entry.id);
          if (otherRefs.length === 0) continue;
          // Resolve the other refs to {id, name, section} for friendliness.
          const sharedWith = [];
          for (const refId of otherRefs) {
            const sections = ["characters", "locations", "props", "keyframes", "audio", "library"];
            for (const sectionName of sections) {
              const list = Array.isArray(metadata[sectionName]) ? metadata[sectionName] : [];
              const hit = list.find((e) => e?.id === refId);
              if (hit) {
                sharedWith.push({
                  id: hit.id,
                  name: hit.name || hit.title || "",
                  section: sectionName,
                });
                break;
              }
            }
          }
          if (sharedWith.length) {
            mediaRefs.push({ path: m.path, mediaId: record.id, sharedWith });
          }
        }
      } catch {
        // Media index missing or unreadable — leave mediaRefs empty.
      }

      return {
        section: normalizedSection,
        asset: {
          id: entry.id,
          name: entry.name || entry.title || "",
          title: entry.title || entry.name || "",
          content: includeContent ? truncateText(entry.content || "", 12000).content : "",
          contentTruncated: includeContent ? truncateText(entry.content || "", 12000).truncated : false,
          path: entry.path || "",
          folder: entry.folder || null,
          kind: normalizeAssetEntryKind(normalizedSection, entry.kind) || null,
          audioKind: entry.audioKind || null,
          media,
        },
        usedBy,
        usageRoleCounts: roleCounts,
        mediaRefs,
      };
    },
  });

  registerTool("normalize_asset_media_names", {
    tier: "edit",
    description:
      "Rename asset media files to clean names derived from the asset entry names and keep Forge metadata in sync. Use this for bulk cleanup of manually dropped images/audio instead of rewriting .forge/project.json.",
    args: {
      section: "optional characters | locations | props | keyframes | audio",
      query: "optional substring filter by asset name/title",
      dryRun: "optional boolean, default false",
    },
    async run({ section, query = "", dryRun = false }, ctx) {
      const metadata = await readProjectMetadata(ctx.projectDir);
      const requestedSection = normalizeAssetSection(section);
      const targetSections = requestedSection ? [requestedSection] : assetSections();
      const normalizedQuery = String(query || "").trim().toLowerCase();
      const nextMetadata = { ...metadata };
      const renames = [];
      // Pending physical renames, applied AFTER metadata is on disk.
      // Pre-fix (review M1, 2026-05-04): fs.rename ran inside the per-entry
      // loop and writeProjectMetadata once at the end — a crash mid-batch
      // left files renamed on disk while project.json still pointed at the
      // old paths, silently breaking every reference. Now: compute intents
      // + mutate the metadata copy in pass 1, write atomically, then run
      // the actual renames in pass 2. A crash before the rename pass leaves
      // metadata pointing at the new path with the file still at the old
      // path (recoverable: re-run the tool, or the user can rename the
      // single file manually), but never leaves the rest of the project
      // referencing stale paths.
      const pendingRenames = [];

      // Pass 1 — compute intents, mutate the metadata copy. No FS writes.
      for (const key of targetSections) {
        const entries = Array.isArray(metadata?.[key]) ? metadata[key].map((entry) => ({
          ...entry,
          media: Array.isArray(entry?.media) ? entry.media.map((media) => ({ ...media })) : [],
        })) : [];

        for (const entry of entries) {
          const entryName = String(entry?.name || entry?.title || "").trim();
          if (normalizedQuery && !entryName.toLowerCase().includes(normalizedQuery)) {
            continue;
          }

          const mediaItems = Array.isArray(entry?.media) ? entry.media : [];
          for (const [index, media] of mediaItems.entries()) {
            const currentRelativePath = normalizeProjectMediaPath(ctx.projectDir, media?.path);
            if (!currentRelativePath) {
              continue;
            }

            const currentAbsolutePath = absoluteProjectMediaPath(ctx.projectDir, currentRelativePath);
            if (!currentAbsolutePath) {
              continue;
            }

            const extension = path.posix.extname(currentRelativePath);
            const desiredBaseName = index === 0
              ? slugifyName(entryName || `${key}-asset`)
              : `${slugifyName(entryName || `${key}-asset`)}-${index + 1}`;
            const desiredRelativePath = currentRelativePath.replace(
              /[^/]+$/,
              `${desiredBaseName}${extension}`,
            );
            const nextRelativePath = await ensureUniqueRelativePathExcept(
              ctx.projectDir,
              desiredRelativePath,
              currentRelativePath,
            );

            const currentLabel = String(media?.label || path.posix.basename(currentRelativePath));
            const nextLabel = path.posix.basename(nextRelativePath);
            const pathChanged = nextRelativePath !== currentRelativePath;
            const labelChanged = currentLabel !== nextLabel;
            if (!pathChanged && !labelChanged) {
              continue;
            }

            if (!dryRun && typeof assertWritablePath === "function") {
              await assertWritablePath(ctx.projectDir, currentRelativePath, "renaming");
            }

            // Defer the actual rename to pass 2 — metadata must land first.
            if (pathChanged) {
              pendingRenames.push({
                from: currentAbsolutePath,
                to: resolveInside(ctx.projectDir, nextRelativePath),
              });
            }

            media.path = nextRelativePath;
            media.label = nextLabel;
            renames.push({
              section: key,
              assetId: entry.id,
              assetName: entryName,
              mediaId: media.id,
              from: currentRelativePath,
              to: nextRelativePath,
            });
          }
        }

        nextMetadata[key] = entries;
      }

      if (!dryRun && renames.length > 0) {
        nextMetadata.project = {
          ...(nextMetadata.project || {}),
          updatedAt: new Date().toISOString(),
        };
        // Write FIRST. atomicWriteFile + the project lock guarantee this
        // either fully lands or never reaches disk; once on disk, the
        // metadata is the source of truth even if pass 2 partially fails.
        await writeProjectMetadata(ctx.projectDir, nextMetadata);
        // Pass 2 — apply the physical renames. Any per-rename failure is
        // surfaced via throw so the user sees which item drifted.
        for (const op of pendingRenames) {
          await fs.rename(op.from, op.to);
        }
        await refreshProjectIndex(ctx.projectDir);
        await rebuildMediaIndexForMetadata(ctx.projectDir, nextMetadata);
      }

      return {
        dryRun: Boolean(dryRun),
        count: renames.length,
        renames,
      };
    },
  });

  registerTool("sync_assets_from_disk", {
    tier: "edit",
    description:
      "Import manually dropped asset files from assets/characters, assets/locations, assets/props, assets/keyframes, or assets/audio into Forge metadata, then refresh the index.",
    args: {
      section: "optional characters | locations | props | keyframes | audio",
    },
    async run({ section }, ctx) {
      const normalizedSection = normalizeAssetSection(section);
      const metadata = await readProjectMetadata(ctx.projectDir);
      const synced = await syncAssetDirectoryFiles(
        ctx.projectDir,
        metadata,
        normalizedSection ? [normalizedSection] : assetSections(),
      );

      if (synced.changed) {
        await writeProjectMetadata(ctx.projectDir, synced.project);
      }
      const index = await refreshProjectIndex(ctx.projectDir);

      return {
        changed: synced.changed,
        count: synced.imported.length,
        imported: synced.imported,
        summary: {
          scenes: Array.isArray(index?.scenes) ? index.scenes.length : 0,
          shots: Array.isArray(index?.shots) ? index.shots.length : 0,
          prompts: Array.isArray(index?.prompts) ? index.prompts.length : 0,
          assets: {
            characters: Array.isArray(index?.assets?.characters) ? index.assets.characters.length : 0,
            locations: Array.isArray(index?.assets?.locations) ? index.assets.locations.length : 0,
            props: Array.isArray(index?.assets?.props) ? index.assets.props.length : 0,
            keyframes: Array.isArray(index?.assets?.keyframes) ? index.assets.keyframes.length : 0,
            audio: Array.isArray(index?.assets?.audio) ? index.assets.audio.length : 0,
          },
        },
      };
    },
  });

  registerTool("create_asset_entry", {
    tier: "edit",
    description:
      "Create a new asset card (character / location / prop / keyframe / audio). Cards may be placeholders with no media during script planning; optionally attach an existing media file from the project (relative path). Returns { section, id, name, media }.",
    args: {
      section: "one of: characters | locations | props | keyframes | audio",
      name: "required asset name",
      content: "optional internal note stored on the asset card; no markdown file is created",
      kind: "optional single | sheet for characters | locations | keyframes. Ignored on props | audio.",
      mediaPath: "optional relative path to an existing media file inside the project",
    },
    async run({ section, name, content, kind, mediaPath }, ctx) {
      const normalizedSection = normalizeAssetSection(section);
      if (!normalizedSection) {
        throw new Error(
          `create_asset_entry: 'section' must be one of ${assetSections().join(", ")}.`,
        );
      }
      const cleanName = String(name || "").trim();
      if (!cleanName) throw new Error("create_asset_entry: 'name' is required.");

      const entry = makeAssetEntry(normalizedSection, cleanName);
      entry.content = typeof content === "string" ? content.trim() : "";
      const normalizedKind = normalizeAssetEntryKind(normalizedSection, kind);
      if (normalizedKind) entry.kind = normalizedKind;

      if (normalizedSection === "audio" && !entry.audioKind) {
        entry.audioKind = guessAudioKind(`${cleanName} ${mediaPath || ""}`);
      }

      if (mediaPath) {
        const normalizedMediaPath = normalizeProjectMediaPath(ctx.projectDir, mediaPath);
        const absolute = absoluteProjectMediaPath(ctx.projectDir, normalizedMediaPath);
        if (!absolute) {
          throw new Error(`create_asset_entry: mediaPath '${mediaPath}' did not resolve inside the project.`);
        }
        try {
          const stat = await fs.stat(absolute);
          if (!stat.isFile()) {
            throw new Error(`create_asset_entry: mediaPath '${mediaPath}' is not a file.`);
          }
        } catch (error) {
          if (error?.code === "ENOENT") {
            throw new Error(`create_asset_entry: mediaPath '${mediaPath}' does not exist.`);
          }
          throw error;
        }
        entry.media = [
          {
            id: randomUUID(),
            label: path.posix.basename(normalizedMediaPath),
            kind: mediaKindForSection(normalizedSection),
            path: normalizedMediaPath,
          },
        ];
      }

      const metadata = await readProjectMetadata(ctx.projectDir);
      const currentEntries = Array.isArray(metadata[normalizedSection])
        ? metadata[normalizedSection]
        : [];
      // Soft duplicate-name detection (polish audit R3, 2026-04-20).
      // Doesn't block the create — the user might genuinely want two
      // entries that share a name (siblings, alternate-universe, etc.).
      // Surfaces existing matches so the agent can decide to link to an
      // existing entry, rename, or proceed silently.
      const nameLower = String(entry.name || "").toLowerCase();
      const duplicates = currentEntries
        .filter((existing) => String(existing?.name || existing?.title || "").toLowerCase() === nameLower)
        .map((existing) => ({ id: existing.id, name: existing.name || existing.title || "" }));
      const nextMetadata = {
        ...metadata,
        [normalizedSection]: [...currentEntries, entry],
        project: {
          ...(metadata.project || {}),
          updatedAt: new Date().toISOString(),
        },
      };
      await writeProjectMetadata(ctx.projectDir, nextMetadata);
      await refreshProjectIndex(ctx.projectDir);

      const result = {
        section: normalizedSection,
        id: entry.id,
        name: entry.name,
        path: entry.path,
        kind: normalizeAssetEntryKind(normalizedSection, entry.kind) || undefined,
        media: entry.media,
      };
      if (duplicates.length > 0) {
        result.warning = { code: "duplicate_name", existing: duplicates };
      }
      return result;
    },
  });

  registerTool("update_asset_entry", {
    tier: "edit",
    description:
      "Update fields on an existing asset entry without round-tripping through delete+create. Accepts any subset of { name, content, audioKind, folder } and rewrites only the keys you pass — omitted keys are left untouched. Asset id stays stable so inbound entityRefs in scenes/shots/prompts remain valid. Returns the updated { id, name, content, audioKind, folder } and the previous values that changed.",
    args: {
      section: "required characters | locations | props | keyframes | audio | library",
      assetId: "required asset id",
      name: "optional new name",
      content: "optional internal note stored on the asset card",
      kind: "optional single | sheet for characters | locations | keyframes",
      audioKind: "optional music | sfx | voiceover | ambient (audio section only)",
      folder: "optional folder label (or empty string to clear)",
    },
    async run({ section, assetId, name, content, kind, audioKind, folder }, ctx) {
      const normalizedSection = normalizeAssetSection(section) || (section === "library" ? "library" : null);
      if (!normalizedSection) {
        throw new Error(
          `update_asset_entry: 'section' must be one of ${deletableAssetSections().join(", ")}.`,
        );
      }
      const id = String(assetId || "").trim();
      if (!id) throw new Error("update_asset_entry: 'assetId' is required.");

      const metadata = await readProjectMetadata(ctx.projectDir);
      const entries = Array.isArray(metadata[normalizedSection]) ? metadata[normalizedSection] : [];
      const idx = entries.findIndex((entry) => entry?.id === id);
      if (idx < 0) {
        throw new Error(`update_asset_entry: asset not found in ${normalizedSection}.`);
      }

      const before = entries[idx];
      const patch = {};
      const previous = {};
      if (typeof name === "string") {
        const cleanName = name.trim();
        if (!cleanName) throw new Error("update_asset_entry: 'name' cannot be empty.");
        if (cleanName !== (before.name || before.title || "")) {
          patch.name = cleanName;
          patch.title = cleanName;
          previous.name = before.name || before.title || "";
        }
      }
      if (typeof content === "string" && content !== (before.content || "")) {
        patch.content = content;
        previous.content = before.content || "";
      }
      if (kind !== undefined) {
        const normalizedKind = normalizeAssetEntryKind(normalizedSection, kind);
        if (!normalizedKind) {
          throw new Error("update_asset_entry: 'kind' is only valid for characters, locations, and keyframes.");
        }
        const currentKind = normalizeAssetEntryKind(normalizedSection, before.kind) || "single";
        if (normalizedKind !== currentKind) {
          patch.kind = normalizedKind;
          previous.kind = currentKind;
        }
      }
      if (typeof audioKind === "string") {
        if (normalizedSection !== "audio") {
          throw new Error("update_asset_entry: 'audioKind' is only valid for the audio section.");
        }
        const cleanKind = audioKind.trim().toLowerCase();
        const allowed = ["music", "sfx", "voiceover", "ambient"];
        if (!allowed.includes(cleanKind)) {
          throw new Error(`update_asset_entry: 'audioKind' must be one of ${allowed.join(", ")}.`);
        }
        if (cleanKind !== (before.audioKind || "")) {
          patch.audioKind = cleanKind;
          previous.audioKind = before.audioKind || null;
        }
      }
      if (typeof folder === "string") {
        const cleanFolder = folder.trim();
        const nextFolder = cleanFolder || null;
        if (nextFolder !== (before.folder || null)) {
          patch.folder = nextFolder;
          previous.folder = before.folder || null;
        }
      }

      if (Object.keys(patch).length === 0) {
        return {
          section: normalizedSection,
          id,
          updated: false,
          reason: "no changes",
          asset: {
            id,
            name: before.name || before.title || "",
            content: before.content || "",
            kind: normalizeAssetEntryKind(normalizedSection, before.kind) || null,
            audioKind: before.audioKind || null,
            folder: before.folder || null,
          },
        };
      }

      const updated = { ...before, ...patch };
      const nextEntries = entries.slice();
      nextEntries[idx] = updated;
      const nextMetadata = {
        ...metadata,
        [normalizedSection]: nextEntries,
        project: {
          ...(metadata.project || {}),
          updatedAt: new Date().toISOString(),
        },
      };
      await writeProjectMetadata(ctx.projectDir, nextMetadata);
      await refreshProjectIndex(ctx.projectDir);
      return {
        section: normalizedSection,
        id,
        updated: true,
        previous,
        asset: {
          id,
          name: updated.name || updated.title || "",
          content: updated.content || "",
          kind: normalizeAssetEntryKind(normalizedSection, updated.kind) || null,
          audioKind: updated.audioKind || null,
          folder: updated.folder || null,
        },
      };
    },
  });

  registerTool("delete_asset_entry", {
    tier: "edit",
    description:
      "Delete one asset entry from Forge metadata. If its media files are not referenced anywhere else in the project, delete those files from disk too. Shared library-linked files are preserved when still referenced by other entries.",
    args: {
      section: "required one of: library | characters | locations | props | keyframes | audio",
      assetId: "optional asset id",
      name: "optional asset name/title substring",
    },
    async run({ section, assetId, name }, ctx) {
      const normalizedSection = typeof section === "string" ? section.trim() : "";
      if (!deletableAssetSections().includes(normalizedSection)) {
        throw new Error(
          `delete_asset_entry: 'section' must be one of ${deletableAssetSections().join(", ")}.`,
        );
      }

      const metadata = await readProjectMetadata(ctx.projectDir);
      const currentEntries = Array.isArray(metadata?.[normalizedSection]) ? metadata[normalizedSection] : [];
      const normalizedName = String(name || "").trim().toLowerCase();
      const targetEntry =
        currentEntries.find((entry) => assetId && entry?.id === assetId) ||
        currentEntries.find(
          (entry) =>
            normalizedName &&
            String(entry?.name || entry?.title || "").toLowerCase().includes(normalizedName),
        );

      if (!targetEntry) {
        throw new Error(`delete_asset_entry: asset not found in ${normalizedSection}.`);
      }

      // Read-only enforcement — refuse if the entry's primary path or any
      // of its bound media paths is locked. The agent shouldn't be able to
      // wipe an asset the user explicitly protected, even though
      // delete_asset_entry sits in the CONFIRM bucket.
      if (typeof assertWritablePath === "function") {
        for (const media of Array.isArray(targetEntry.media) ? targetEntry.media : []) {
          const rel = normalizeProjectMediaPath(ctx.projectDir, media?.path);
          if (rel) await assertWritablePath(ctx.projectDir, rel, "deleting");
        }
      }

      // Count DISTINCT owning entities per media path, not raw occurrences.
      // If a single entity has the same media attached multiple times (from
      // a historical attach_media double-call before that was made
      // idempotent), each occurrence used to increment the count — so the
      // tool thought "someone else still references this" and orphaned the
      // file when the sole owner was deleted. Using entity-id Sets fixes
      // the off-by-N.
      const referenceOwners = new Map();
      for (const key of deletableAssetSections()) {
        const entries = Array.isArray(metadata?.[key]) ? metadata[key] : [];
        for (const entry of entries) {
          if (!entry || !entry.id) continue;
          for (const media of Array.isArray(entry.media) ? entry.media : []) {
            const relativePath = normalizeProjectMediaPath(ctx.projectDir, media?.path);
            if (!relativePath) continue;
            let owners = referenceOwners.get(relativePath);
            if (!owners) {
              owners = new Set();
              referenceOwners.set(relativePath, owners);
            }
            owners.add(entry.id);
          }
        }
      }

      const deletedFiles = [];
      const trashedFiles = [];
      const detachedFiles = [];
      const missingFiles = [];
      const seenTargetPaths = new Set();
      for (const media of Array.isArray(targetEntry?.media) ? targetEntry.media : []) {
        const relativePath = normalizeProjectMediaPath(ctx.projectDir, media?.path);
        if (!relativePath) continue;
        // Don't double-process the same file if targetEntry had duplicate
        // media entries pointing at the same path.
        if (seenTargetPaths.has(relativePath)) continue;
        seenTargetPaths.add(relativePath);

        const owners = referenceOwners.get(relativePath);
        const otherOwners = owners ? owners.size - (owners.has(targetEntry.id) ? 1 : 0) : 0;
        if (otherOwners > 0) {
          detachedFiles.push(relativePath);
          continue;
        }

        const absolutePath = absoluteProjectMediaPath(ctx.projectDir, relativePath);
        if (!absolutePath) continue;
        try {
          const trashPath = await moveProjectMediaToTemporaryTrash(ctx.projectDir, relativePath);
          deletedFiles.push(relativePath);
          if (trashPath) trashedFiles.push({ from: relativePath, to: trashPath });
        } catch (error) {
          if (error?.code === "ENOENT") {
            missingFiles.push(relativePath);
            continue;
          }
          throw error;
        }
      }

      const nextEntries = currentEntries.filter((entry) => entry?.id !== targetEntry.id);
      const nextMetadataBase = {
        ...metadata,
        [normalizedSection]: nextEntries,
      };
      // Strip dangling entityRefs in script/shots/prompts/dialogue so
      // doc meta doesn't carry stale ids forward (review H1, 2026-05-04).
      stripEntityRefsFromMetadata(nextMetadataBase, [targetEntry.id]);
      const nextMetadata = {
        ...nextMetadataBase,
        project: {
          ...(metadata.project || {}),
          updatedAt: new Date().toISOString(),
        },
      };
      await writeProjectMetadata(ctx.projectDir, nextMetadata);
      await refreshProjectIndex(ctx.projectDir);

      return {
        deleted: true,
        section: normalizedSection,
        asset: {
          id: targetEntry.id,
          name: targetEntry.name || targetEntry.title || "",
          mediaCount: Array.isArray(targetEntry?.media) ? targetEntry.media.length : 0,
        },
        deletedFiles,
        trashedFiles,
        detachedFiles,
        missingFiles,
        remaining: Array.isArray(nextMetadata?.[normalizedSection]) ? nextMetadata[normalizedSection].length : 0,
      };
    },
  });

  registerTool("move_asset_entry", {
    tier: "edit",
    description:
      "Move an asset entry from one section to another while preserving its id, content, and media[]. Use this when an entry's role changes (a keyframe graduating into a location, a sound effect becoming an audio asset). Refuses if media kinds are incompatible with the destination section unless mediaMismatchPolicy:'detach' (drops mismatched media) is set.",
    args: {
      fromSection: "required — current section: characters | locations | props | keyframes | audio",
      toSection: "required — destination section",
      assetId: "required — id of the entry to move",
      mediaMismatchPolicy: "optional — 'refuse' (default) or 'detach' (drop media that doesn't match destination kind)",
    },
    async run({ fromSection, toSection, assetId, mediaMismatchPolicy = "refuse" }, ctx) {
      const from = normalizeAssetSection(fromSection);
      const to = normalizeAssetSection(toSection);
      // Videos has its own lifecycle (VideoEntry shape, takes tree under
      // assets/videos/<scene>/<shot>/<prompt>/) and isn't an AssetEntry —
      // direct the agent to the videos surface instead of a generic refusal.
      const looksLikeVideos = (s) => String(s || "").trim().toLowerCase() === "videos";
      if (looksLikeVideos(fromSection) || looksLikeVideos(toSection)) {
        throw new Error(
          `move_asset_entry: 'videos' is not an AssetEntry section — it has a separate VideoEntry shape and lifecycle (see videos-tools.cjs). Cross-section moves between AssetEntry sections (characters/locations/props/keyframes/audio) and videos aren't supported here.`,
        );
      }
      if (!from) throw new Error(`move_asset_entry: 'fromSection' must be one of ${assetSections().join(", ")}.`);
      if (!to) throw new Error(`move_asset_entry: 'toSection' must be one of ${assetSections().join(", ")}.`);
      const id = String(assetId || "").trim();
      if (!id) throw new Error("move_asset_entry: 'assetId' is required.");

      // Same-section move is a no-op success — defensive against agent
      // re-emitting a move it already did.
      if (from === to) {
        return { fromSection: from, toSection: to, assetId: id, name: "", mediaPreserved: 0, noop: true };
      }

      const metadata = await readProjectMetadata(ctx.projectDir);
      const fromEntries = Array.isArray(metadata[from]) ? metadata[from] : [];
      const toEntries = Array.isArray(metadata[to]) ? metadata[to] : [];
      const target = fromEntries.find((entry) => entry?.id === id);
      if (!target) {
        throw new Error(`move_asset_entry: id '${id}' not found in ${from}.`);
      }
      // Read-only enforcement — moving an entry rewrites its path
      // metadata, which is exactly the kind of change the user wanted
      // to prevent when they locked it. Refuse with the soft envelope.
      if (typeof assertWritablePath === "function" && target.path) {
        await assertWritablePath(ctx.projectDir, target.path, "moving");
      }

      // Filter media for kind compatibility with the destination section.
      // mediaKindForSection returns the canonical kind: "audio" for audio
      // section, otherwise "image". Mismatched media (e.g. an image
      // attached to an entry being moved to the audio section) are either
      // dropped (policy: detach) or block the move (policy: refuse).
      const expectedKind = mediaKindForSection(to);
      const mediaList = Array.isArray(target.media) ? target.media : [];
      const compatible = [];
      const mismatches = [];
      for (const item of mediaList) {
        if (!item) continue;
        if (!item.kind || item.kind === expectedKind) {
          compatible.push(item);
        } else {
          mismatches.push({ id: item.id, path: item.path, kind: item.kind });
        }
      }
      if (mismatches.length > 0 && mediaMismatchPolicy !== "detach") {
        throw new Error(
          `move_asset_entry: ${mismatches.length} media item(s) have kind incompatible with '${to}' (expected ${expectedKind}). Pass mediaMismatchPolicy:'detach' to drop them and proceed. Mismatches: ${JSON.stringify(mismatches)}`,
        );
      }

      // Re-derive `path` under the destination section's convention so
      // the markdown backing file (where long-form prose lives) follows
      // the entry to its new home. Pre-fix (review M3, 2026-05-04): path
      // was unconditionally blanked, silently detaching the entry from
      // its .md file. Now: compute `${to}/${slug}.md`, dedupe in dest,
      // and physically rename the file on disk if it exists.
      const slug = slugifyName(target.name || target.title || "asset");
      const ext = path.extname(target.path || "") || ".md";
      const desiredPath = `${to}/${slug}${ext}`;
      const newPath = await ensureUniqueRelativePathExcept(
        ctx.projectDir,
        desiredPath,
        target.path || "",
      );
      if (target.path && target.path !== newPath) {
        const sourceAbs = resolveInside(ctx.projectDir, target.path);
        const destAbs = resolveInside(ctx.projectDir, newPath);
        let sourceExists = false;
        try { await fs.access(sourceAbs); sourceExists = true; } catch {}
        if (sourceExists) {
          await fs.mkdir(path.dirname(destAbs), { recursive: true });
          await fs.rename(sourceAbs, destAbs);
        }
      }

      const moved = {
        ...target,
        media: compatible,
        path: newPath,
      };

      const nextMetadataBase = {
        ...metadata,
        [from]: fromEntries.filter((entry) => entry?.id !== id),
        [to]: [...toEntries, moved],
      };
      const nextMetadata = {
        ...nextMetadataBase,
        project: {
          ...(metadata.project || {}),
          updatedAt: new Date().toISOString(),
        },
      };
      await writeProjectMetadata(ctx.projectDir, nextMetadata);
      await refreshProjectIndex(ctx.projectDir);

      return {
        fromSection: from,
        toSection: to,
        assetId: id,
        name: moved.name || moved.title || "",
        mediaPreserved: compatible.length,
        mediaDetached: mismatches,
        path: moved.path,
      };
    },
  });

  registerTool("create_asset_entries", {
    tier: "edit",
    description:
      "Create multiple asset entries in one section in a single tool call. Use during script planning to create placeholder cards before media exists. Bulk variant of create_asset_entry. Single project.json read + single atomic write covers the whole batch — order-of-magnitude faster than emitting create_asset_entry N times. Per-entry results returned in input order, including any duplicate-name warnings.",
    args: {
      section: "required — one of: characters | locations | props | keyframes | audio",
      entries: "required array of { name, content?, kind?, mediaPath? } — same shape as create_asset_entry args",
    },
    async run({ section, entries }, ctx) {
      const normalizedSection = normalizeAssetSection(section);
      if (!normalizedSection) {
        throw new Error(`create_asset_entries: 'section' must be one of ${assetSections().join(", ")}.`);
      }
      if (!Array.isArray(entries) || entries.length === 0) {
        throw new Error("create_asset_entries: 'entries' must be a non-empty array.");
      }

      // Validate + build entries in parallel (per-entry fs.stat for
      // mediaPath is the only async work). Failures are captured per-entry
      // so a single bad input doesn't sink the batch.
      const built = await Promise.all(
        entries.map(async (input, index) => {
          try {
            const cleanName = String(input?.name || "").trim();
            if (!cleanName) throw new Error("'name' is required");
            const entry = makeAssetEntry(normalizedSection, cleanName);
            entry.content = typeof input?.content === "string" ? input.content.trim() : "";
            const normalizedKind = normalizeAssetEntryKind(normalizedSection, input?.kind);
            if (normalizedKind) entry.kind = normalizedKind;
            if (normalizedSection === "audio" && !entry.audioKind) {
              entry.audioKind = guessAudioKind(`${cleanName} ${input?.mediaPath || ""}`);
            }
            if (input?.mediaPath) {
              const normalizedMediaPath = normalizeProjectMediaPath(ctx.projectDir, input.mediaPath);
              const absolute = absoluteProjectMediaPath(ctx.projectDir, normalizedMediaPath);
              if (!absolute) throw new Error(`mediaPath '${input.mediaPath}' did not resolve inside the project`);
              const stat = await fs.stat(absolute).catch((err) => {
                if (err?.code === "ENOENT") throw new Error(`mediaPath '${input.mediaPath}' does not exist`);
                throw err;
              });
              if (!stat.isFile()) throw new Error(`mediaPath '${input.mediaPath}' is not a file`);
              entry.media = [{
                id: randomUUID(),
                label: path.posix.basename(normalizedMediaPath),
                kind: mediaKindForSection(normalizedSection),
                path: normalizedMediaPath,
              }];
            }
            return { index, ok: true, entry, requestedName: cleanName };
          } catch (error) {
            return { index, ok: false, error: error instanceof Error ? error.message : String(error), requestedName: input?.name || "" };
          }
        }),
      );

      const metadata = await readProjectMetadata(ctx.projectDir);
      const currentEntries = Array.isArray(metadata[normalizedSection]) ? metadata[normalizedSection] : [];
      // Compute existing names once for the duplicate-warning lookup
      // (R3 — audit polish, 2026-04-20).
      const existingByLowerName = new Map();
      for (const existing of currentEntries) {
        const key = String(existing?.name || existing?.title || "").toLowerCase();
        if (!key) continue;
        if (!existingByLowerName.has(key)) existingByLowerName.set(key, []);
        existingByLowerName.get(key).push({ id: existing.id, name: existing.name || existing.title || "" });
      }

      // Track names emitted earlier in THIS batch so two inputs with the
      // same name produce a "duplicate_name" warning that points at the
      // batch-mate, not just at pre-existing entries. Pre-fix, calling
      // create_asset_entries with [{name:"Alex"}, {name:"Alex"}] created
      // two Alex entries with no warning between them.
      const batchByLowerName = new Map();
      const newEntries = [];
      const results = built.map((step) => {
        if (!step.ok) {
          return { index: step.index, ok: false, name: step.requestedName, error: step.error };
        }
        newEntries.push(step.entry);
        const lowerName = step.requestedName.toLowerCase();
        const existingDupes = existingByLowerName.get(lowerName) || [];
        const batchDupes = batchByLowerName.get(lowerName) || [];
        const dupes = [...existingDupes, ...batchDupes];
        // Register this entry so later batch-mates with the same name see it.
        if (!batchByLowerName.has(lowerName)) batchByLowerName.set(lowerName, []);
        batchByLowerName.get(lowerName).push({ id: step.entry.id, name: step.entry.name });
        const result = {
          index: step.index,
          ok: true,
          id: step.entry.id,
          name: step.entry.name,
          path: step.entry.path,
          kind: normalizeAssetEntryKind(normalizedSection, step.entry.kind) || undefined,
          media: step.entry.media,
        };
        if (dupes.length > 0) {
          result.warning = { code: "duplicate_name", existing: dupes };
        }
        return result;
      });

      if (newEntries.length === 0) {
        // Every entry failed — don't even write metadata; return early.
        return { section: normalizedSection, count: 0, created: results };
      }

      const nextMetadata = {
        ...metadata,
        [normalizedSection]: [...currentEntries, ...newEntries],
        project: {
          ...(metadata.project || {}),
          updatedAt: new Date().toISOString(),
        },
      };
      await writeProjectMetadata(ctx.projectDir, nextMetadata);
      await refreshProjectIndex(ctx.projectDir);

      return {
        section: normalizedSection,
        count: newEntries.length,
        created: results,
      };
    },
  });

  registerTool("delete_asset_entries", {
    tier: "edit",
    description:
      "Delete multiple asset entries from one section in a single tool call. Bulk variant of delete_asset_entry. One project.json read + one atomic write covers the batch. Per-entry results returned in input order. Reference counting accounts for deletions inside the same batch — if two entries share a media path, the file is only deleted when the last referencing entry in the batch is processed.",
    args: {
      section: "required one of: library | characters | locations | props | keyframes | audio",
      ids: "required array of asset ids to delete",
    },
    async run({ section, ids }, ctx) {
      const normalizedSection = typeof section === "string" ? section.trim() : "";
      if (!deletableAssetSections().includes(normalizedSection)) {
        throw new Error(`delete_asset_entries: 'section' must be one of ${deletableAssetSections().join(", ")}.`);
      }
      if (!Array.isArray(ids) || ids.length === 0) {
        throw new Error("delete_asset_entries: 'ids' must be a non-empty array.");
      }

      const metadata = await readProjectMetadata(ctx.projectDir);
      const currentEntries = Array.isArray(metadata?.[normalizedSection]) ? metadata[normalizedSection] : [];

      // Compute initial reference counts across ALL deletable sections
      // (audit asset-M5 noted recompute waste — bulk amortizes). We
      // decrement as we process each delete in the batch so a media path
      // shared by two batch-deleted entries correctly hits 0 by the
      // second.
      const referenceOwners = new Map();
      for (const key of deletableAssetSections()) {
        const sectionEntries = Array.isArray(metadata?.[key]) ? metadata[key] : [];
        for (const entry of sectionEntries) {
          const seenEntryPaths = new Set();
          for (const m of Array.isArray(entry?.media) ? entry.media : []) {
            const rel = normalizeProjectMediaPath(ctx.projectDir, m?.path);
            if (!rel || seenEntryPaths.has(rel)) continue;
            seenEntryPaths.add(rel);
            if (!referenceOwners.has(rel)) {
              referenceOwners.set(rel, new Set());
            }
            referenceOwners.get(rel).add(entry?.id);
          }
        }
      }

      const deletedFiles = [];
      const trashedFiles = [];
      const detachedFiles = [];
      const missingFiles = [];
      const remainingEntries = [...currentEntries];
      const results = [];
      // Track ids already processed in this batch so a duplicate id in the
      // input doesn't report a confusing "not found" the second time
      // (the first delete already removed it from remainingEntries).
      const processedIds = new Set();

      for (let i = 0; i < ids.length; i++) {
        const targetId = ids[i];
        if (processedIds.has(targetId)) {
          results.push({ index: i, ok: false, id: targetId, error: "duplicate id in input batch" });
          continue;
        }
        processedIds.add(targetId);
        const idx = remainingEntries.findIndex((entry) => entry?.id === targetId);
        if (idx === -1) {
          results.push({ index: i, ok: false, id: targetId, error: "asset not found" });
          continue;
        }
        const target = remainingEntries[idx];
        // Read-only enforcement — same as delete_asset_entry. Per-id
        // failure rather than batch abort: a single locked entry
        // shouldn't sink the rest of the batch.
        if (typeof assertWritablePath === "function") {
          let lockedPath = null;
          try {
            if (target.path) {
              await assertWritablePath(ctx.projectDir, target.path, "deleting");
            }
            for (const m of Array.isArray(target.media) ? target.media : []) {
              const rel = normalizeProjectMediaPath(ctx.projectDir, m?.path);
              if (rel) await assertWritablePath(ctx.projectDir, rel, "deleting");
            }
          } catch (lockErr) {
            lockedPath = lockErr?.path || target.path || "(unknown)";
            results.push({
              index: i,
              ok: false,
              id: targetId,
              error: `Read-only — "${lockedPath}" is locked by the user.`,
              code: "READ_ONLY",
              path: lockedPath,
            });
            continue;
          }
        }
        const seenTargetPaths = new Set();
        for (const m of Array.isArray(target?.media) ? target.media : []) {
          const rel = normalizeProjectMediaPath(ctx.projectDir, m?.path);
          if (!rel || seenTargetPaths.has(rel)) continue;
          seenTargetPaths.add(rel);
          const owners = referenceOwners.get(rel);
          if (owners) {
            owners.delete(target.id);
          }
          if (owners && owners.size > 0) {
            detachedFiles.push(rel);
            continue;
          }
          const absolutePath = absoluteProjectMediaPath(ctx.projectDir, rel);
          if (!absolutePath) continue;
          try {
            const trashPath = await moveProjectMediaToTemporaryTrash(ctx.projectDir, rel);
            deletedFiles.push(rel);
            if (trashPath) trashedFiles.push({ from: rel, to: trashPath });
          } catch (error) {
            if (error?.code === "ENOENT") {
              missingFiles.push(rel);
              continue;
            }
            throw error;
          }
        }
        remainingEntries.splice(idx, 1);
        results.push({
          index: i,
          ok: true,
          id: targetId,
          name: target.name || target.title || "",
          mediaCount: Array.isArray(target?.media) ? target.media.length : 0,
        });
      }

      const nextMetadataBase = {
        ...metadata,
        [normalizedSection]: remainingEntries,
      };
      // Strip dangling entityRefs in script/shots/prompts/dialogue for
      // every successfully deleted id (review H1, 2026-05-04).
      const successfulIds = results.filter((r) => r.ok).map((r) => r.id);
      stripEntityRefsFromMetadata(nextMetadataBase, successfulIds);
      const nextMetadata = {
        ...nextMetadataBase,
        project: {
          ...(metadata.project || {}),
          updatedAt: new Date().toISOString(),
        },
      };
      await writeProjectMetadata(ctx.projectDir, nextMetadata);
      await refreshProjectIndex(ctx.projectDir);

      return {
        section: normalizedSection,
        count: results.filter((r) => r.ok).length,
        deleted: results,
        deletedFiles,
        trashedFiles,
        detachedFiles,
        missingFiles,
        remaining: remainingEntries.length,
      };
    },
  });

  registerTool("set_audio_kind", {
    tier: "edit",
    description:
      "Set the sub-kind of an audio AssetEntry — music | sfx | voiceover | ambient. Drives bin filtering in the Workshop NLE so the agent and user can find the right slot. Only valid on entries in the audio section.",
    args: {
      assetId: "required — id of an AssetEntry in project.audio[].",
      kind: "required — music | sfx | voiceover | ambient.",
    },
    async run({ assetId, kind }, ctx) {
      if (!assetId) throw new Error("set_audio_kind: assetId required.");
      const allowed = new Set(["music", "sfx", "voiceover", "ambient"]);
      if (!allowed.has(kind)) {
        throw new Error("set_audio_kind: kind must be music | sfx | voiceover | ambient.");
      }
      const metadata = await readProjectMetadata(ctx.projectDir);
      if (!metadata) throw new Error("set_audio_kind: project.json not readable.");
      const audio = Array.isArray(metadata.audio) ? metadata.audio.slice() : [];
      const idx = audio.findIndex((entry) => entry.id === assetId);
      if (idx < 0) {
        throw new Error(`set_audio_kind: no audio asset with id ${assetId}.`);
      }
      const previous = audio[idx].audioKind || "music";
      if (previous === kind) {
        return { ok: true, assetId, kind, changed: false };
      }
      audio[idx] = { ...audio[idx], audioKind: kind };
      await writeProjectMetadata(ctx.projectDir, {
        ...metadata,
        audio,
        project: {
          ...(metadata.project || {}),
          updatedAt: new Date().toISOString(),
        },
      });
      return { ok: true, assetId, kind, changed: true, previous };
    },
  });
};
