const fs = require("node:fs/promises");
const path = require("node:path");
const magicDocs = require("../../magic-docs.cjs");

// Constrained proactive mode:
// - run_heartbeat() is read-only: surveys the project and reports problems.
// - run_safe_maintenance() applies ONLY the provably-safe fixes
//   (index refresh, orphan-file sync). No destructive ops.

const STALE_INDEX_MS = 10 * 60 * 1000; // 10 min

module.exports = function registerProactiveTools(api) {
  const {
    registerTool,
    readProjectMetadata,
    refreshProjectIndex,
    runTool,
  } = api;

  async function statMaybe(absolutePath) {
    try {
      return await fs.stat(absolutePath);
    } catch {
      return null;
    }
  }

  // Pool-unindexed check was retired with the Pool → unified media merge.
  // Files in assets/_pool/ are now discovered by the unified media
  // index's recursive scan and reported as regular library entries.

  async function indexStaleness(projectDir) {
    const indexStat = await statMaybe(path.join(projectDir, ".forge", "index.json"));
    if (!indexStat) return { exists: false, stale: true, ageMs: null };
    const ageMs = Date.now() - indexStat.mtimeMs;
    return { exists: true, stale: ageMs > STALE_INDEX_MS, ageMs };
  }

  async function findOrphanAssetFiles(projectDir, metadata) {
    // Files on disk in assets/<section>/ not referenced by any entry.media[].
    const sections = ["characters", "locations", "props", "keyframes", "audio"];
    const known = new Set();
    for (const section of sections) {
      const entries = Array.isArray(metadata?.[section]) ? metadata[section] : [];
      for (const entry of entries) {
        const mediaItems = Array.isArray(entry?.media) ? entry.media : [];
        for (const m of mediaItems) if (m?.path) known.add(m.path);
      }
    }
    const orphans = [];
    for (const section of sections) {
      try {
        const dirEntries = await fs.readdir(path.join(projectDir, "assets", section), {
          withFileTypes: true,
        });
        for (const entry of dirEntries) {
          if (!entry.isFile() || entry.name.startsWith(".")) continue;
          const rel = `assets/${section}/${entry.name}`;
          if (!known.has(rel)) orphans.push(rel);
        }
      } catch {}
    }
    return orphans;
  }

  registerTool("run_heartbeat", {
    tier: "meta",
    description:
      "Read-only proactive scan: index staleness, orphan asset files, missing project docs, stale magic docs. Returns a structured report with 'suggestions' you can act on (or ask the user). Does not mutate anything.",
    args: {},
    async run(_args, ctx) {
      const { projectDir } = ctx;
      const metadata = await readProjectMetadata(projectDir).catch(() => ({}));

      const indexInfo = await indexStaleness(projectDir);
      const orphanAssets = await findOrphanAssetFiles(projectDir, metadata);
      const magicDocEntries = await magicDocs.listMagicDocs(projectDir);

      const anvilMd = await statMaybe(path.join(projectDir, "ANVIL.md"));
      const memoryIndex = await statMaybe(path.join(projectDir, ".forge", "memory", "MEMORY.md"));
      const conventionsMd = await statMaybe(path.join(projectDir, ".forge", "conventions.md"));
      const staleMagicDocs = magicDocEntries.filter((doc) => doc.isStale);
      const brokenMagicDocs = magicDocEntries.filter((doc) => doc.status === "broken");
      const neverSynthesizedMagicDocs = magicDocEntries.filter(
        (doc) => doc.neverSynthesized && doc.scopeResolvedCount > 0,
      );
      const handEditedMagicDocs = magicDocEntries.filter((doc) => doc.handEdited);

      const suggestions = [];
      if (!indexInfo.exists || indexInfo.stale) {
        suggestions.push({
          kind: "stale_index",
          severity: "low",
          message: indexInfo.exists
            ? `.forge/index.json is ${Math.round((indexInfo.ageMs || 0) / 60000)} min old — consider refresh_project_index.`
            : ".forge/index.json is missing. Run refresh_project_index.",
        });
      }
      if (orphanAssets.length > 0) {
        suggestions.push({
          kind: "orphan_asset_files",
          severity: "low",
          message: `${orphanAssets.length} file(s) in assets/<section>/ aren't referenced by any entry. Run sync_assets_from_disk to import them as assets, or delete them manually.`,
          items: orphanAssets.slice(0, 20),
        });
      }
      if (!anvilMd) {
        suggestions.push({
          kind: "missing_anvil_md",
          severity: "medium",
          message: "ANVIL.md is missing — the project has no hidden agent protocol/workflow doc to read.",
        });
      }
      if (!memoryIndex) {
        suggestions.push({
          kind: "missing_memory_index",
          severity: "info",
          message: ".forge/memory/MEMORY.md not yet created. Use remember to add a short fact.",
        });
      }
      if (staleMagicDocs.length > 0) {
        suggestions.push({
          kind: "stale_magic_docs",
          severity: "low",
          message: `${staleMagicDocs.length} distilled doc(s) are stale. Sync them before relying on their summaries.`,
          items: staleMagicDocs.map((doc) => doc.name),
        });
      }
      if (brokenMagicDocs.length > 0) {
        suggestions.push({
          kind: "broken_magic_docs",
          severity: "medium",
          message: `${brokenMagicDocs.length} distilled doc(s) have invalid scope entries and need repair before sync.`,
          items: brokenMagicDocs.map((doc) => doc.name),
        });
      }
      if (neverSynthesizedMagicDocs.length > 0) {
        suggestions.push({
          kind: "unsynced_magic_docs",
          severity: "info",
          message: `${neverSynthesizedMagicDocs.length} distilled doc scaffold(s) have never been synthesized.`,
          items: neverSynthesizedMagicDocs.map((doc) => doc.name),
        });
      }
      if (handEditedMagicDocs.length > 0) {
        suggestions.push({
          kind: "hand_edited_magic_docs",
          severity: "info",
          message: `${handEditedMagicDocs.length} distilled doc(s) contain manual edits and will block non-forced regeneration.`,
          items: handEditedMagicDocs.map((doc) => doc.name),
        });
      }

      return {
        index: indexInfo,
        orphanAssets: { count: orphanAssets.length, items: orphanAssets.slice(0, 20) },
        docs: {
          anvilMd: Boolean(anvilMd),
          memoryIndex: Boolean(memoryIndex),
          conventions: Boolean(conventionsMd),
          magicDocs: {
            count: magicDocEntries.length,
            stale: staleMagicDocs.length,
            broken: brokenMagicDocs.length,
            neverSynthesized: neverSynthesizedMagicDocs.length,
            handEdited: handEditedMagicDocs.length,
            items: magicDocEntries.map((doc) => ({
              name: doc.name,
              path: doc.path,
              status: doc.status,
              isStale: doc.isStale,
              neverSynthesized: doc.neverSynthesized,
              handEdited: doc.handEdited,
              scopeResolvedCount: doc.scopeResolvedCount,
              scopeErrors: doc.scopeErrors,
              updatedAt: doc.updatedAt,
            })),
          },
        },
        suggestions,
      };
    },
  });

  registerTool("run_safe_maintenance", {
    tier: "meta",
    mutation: true,
    description:
      "Apply only provably-safe maintenance fixes: refresh_project_index, scan_media. Does NOT touch orphan files or any user-authored docs. Returns what was done. Use this when you want to keep the project tidy without asking the user for confirmation.",
    args: {},
    async run(_args, ctx) {
      const { projectDir } = ctx;
      const actions = [];

      try {
        const scanResult = await runTool("scan_media", {}, ctx);
        actions.push({ tool: "scan_media", ok: true, result: scanResult });
      } catch (error) {
        actions.push({
          tool: "scan_media",
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      try {
        const index = await refreshProjectIndex(projectDir);
        actions.push({
          tool: "refresh_project_index",
          ok: true,
          result: {
            scenes: Array.isArray(index?.scenes) ? index.scenes.length : 0,
            shots: Array.isArray(index?.shots) ? index.shots.length : 0,
            prompts: Array.isArray(index?.prompts) ? index.prompts.length : 0,
          },
        });
      } catch (error) {
        actions.push({
          tool: "refresh_project_index",
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      return { count: actions.length, actions };
    },
  });
};
