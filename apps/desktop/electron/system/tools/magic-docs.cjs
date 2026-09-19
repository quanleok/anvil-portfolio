const fs = require("node:fs/promises");
const { callModel } = require("../../openclaw.cjs");
const magicDocs = require("../../magic-docs.cjs");

module.exports = function registerMagicDocsTools(api) {
  const { registerTool, assertWritablePath } = api;

  registerTool("read_asset_context_guide", {
    tier: "domain",
    description:
      "Read the legacy Asset Context guide (.forge/asset-context/guide.md) when it exists. Use this as compatibility-only plain markdown guidance for reusable asset/reference rules. New asset guidance belongs in visible contextGroup: asset docs or asset card notes. Do not treat Asset Context as a media bin.",
    args: {},
    async run(_args, ctx) {
      return magicDocs.readAssetContextGuide(ctx.projectDir);
    },
  });

  registerTool("write_asset_context_guide", {
    tier: "domain",
    mutation: true,
    description:
      "Write the legacy Asset Context guide (.forge/asset-context/guide.md) only when the user explicitly asks to edit that legacy guide. Normal intake should use story/intake.md Visual / Asset Seeds, visible contextGroup: asset docs, or asset card notes. Do not use this for story prose, hidden agent protocol, or media upload/storage.",
    args: { content: "required markdown content for the Asset Context guide" },
    async run({ content }, ctx) {
      const relativePath = magicDocs.assetContextGuideRelative();
      if (typeof assertWritablePath === "function") {
        await assertWritablePath(ctx.projectDir, relativePath, "writing");
      }
      return magicDocs.writeAssetContextGuide(ctx.projectDir, String(content || ""));
    },
  });

  registerTool("list_magic_docs", {
    tier: "meta",
    description:
      "List internal auto-index docs (.forge/magic/*.md). Use only for maintenance or narrow asset lookup; normal user-facing project context lives in story/intake.md, story/world-bible.md, and custom Canon markdown. ANVIL.md is hidden agent protocol.",
    args: {},
    async run(_args, ctx) {
      const docs = await magicDocs.listMagicDocs(ctx.projectDir);
      return { count: docs.length, docs };
    },
  });

  registerTool("create_magic_doc", {
    tier: "internal",
    mutation: true,
    description:
      "Internal repair/dev tool. Register a hidden .forge/magic/<slug>.md auto-index. Do not use for ordinary user context; create normal markdown under Canon/custom instead.",
    args: {
      name: "required — display name (e.g. 'Character Bible')",
      description: "required — one-liner",
      kind: "optional — bible | atlas | grammar | map | digest | custom",
      scope: "required — array of relative paths or dir globs (e.g. ['characters/**', 'ANVIL.md'])",
      instruction: "required — how the auto-updater should synthesize the sources",
    },
    async run({ name, description, kind, scope, instruction }, ctx) {
      const cleanName = String(name || "").trim();
      if (!cleanName) throw new Error("create_magic_doc: 'name' is required.");
      const cleanDescription = String(description || "").trim();
      if (!cleanDescription) throw new Error("create_magic_doc: 'description' is required.");
      const scopeList = Array.isArray(scope)
        ? scope
        : typeof scope === "string"
          ? magicDocs.parseList(scope)
          : [];
      if (!scopeList.length) throw new Error("create_magic_doc: 'scope' must have at least one entry.");
      const cleanInstruction = String(instruction || "").trim();
      if (!cleanInstruction) throw new Error("create_magic_doc: 'instruction' is required.");

      const existing = await magicDocs.readMagicDocFile(ctx.projectDir, cleanName);
      await magicDocs.writeMagicDocFile(ctx.projectDir, {
        name: cleanName,
        description: cleanDescription,
        kind: String(kind || existing?.kind || "custom"),
        scope: scopeList,
        instruction: cleanInstruction,
        updatedAt: existing?.updatedAt || "",
        sourcesHash: existing?.sourcesHash || "",
        synthesizedBodyHash: existing?.synthesizedBodyHash || "",
        allowEmptyScope: existing?.allowEmptyScope || false,
        body: existing?.body || "",
      });
      return {
        name: cleanName,
        path: magicDocs.magicRelative(cleanName),
      };
    },
  });

  registerTool("read_magic_doc", {
    tier: "meta",
    description:
      "Read one internal auto-index doc with body plus freshness, scope, and hand-edit status. Use sparingly for asset/library lookup; do not summarize magic-doc internals to the user.",
    args: {
      name: "required — magic doc name or slug",
      autoUpdate: "optional boolean, default false",
    },
    async run({ name, autoUpdate }, ctx) {
      if (typeof name !== "string" || !name.trim()) {
        throw new Error(
          "read_magic_doc: 'name' arg is required (the magic-doc slug, e.g. 'character-bible'). If you passed 'path', use 'name' instead — magic docs are addressed by slug, not filesystem path.",
        );
      }
      const doc = await magicDocs.describeMagicDoc(ctx.projectDir, name);
      if (!doc) throw new Error(`read_magic_doc: '${name}' not found.`);
      if (autoUpdate && (doc.isStale || doc.neverSynthesized) && !doc.handEdited && doc.scopeErrors.length === 0) {
        const updated = await magicDocs.updateMagicDoc(ctx.projectDir, name, {
          callModel,
          force: false,
          sessionKey: ctx.sessionKey || `hook:shotforge:magic:${magicDocs.slugify(name)}`,
          settings: ctx.settings,
          signal: ctx.signal,
        });
        return {
          ...updated,
          autoUpdated: true,
        };
      }
      return {
        ...doc,
        autoUpdated: false,
      };
    },
  });

  registerTool("update_magic_doc", {
    tier: "internal",
    mutation: true,
    description:
      "Internal repair/dev tool. Re-synthesize a hidden auto-index from declared scope files. Refuses to overwrite hand-edited docs unless force:true.",
    args: { name: "required — magic doc name or slug", force: "optional boolean, default false" },
    async run({ name, force }, ctx) {
      const relativePath = magicDocs.magicRelative(name);
      if (typeof assertWritablePath === "function" && relativePath) {
        await assertWritablePath(ctx.projectDir, relativePath, "updating");
      }
      return magicDocs.updateMagicDoc(ctx.projectDir, name, {
        callModel,
        force: Boolean(force),
        sessionKey: ctx.sessionKey || `hook:shotforge:magic:${magicDocs.slugify(name)}`,
        settings: ctx.settings,
        signal: ctx.signal,
      });
    },
  });

  registerTool("delete_magic_doc", {
    tier: "internal",
    mutation: true,
    description: "Internal repair/dev tool. Delete one hidden .forge/magic/ auto-index. No-op if it doesn't exist.",
    args: { name: "required — magic doc name or slug" },
    async run({ name }, ctx) {
      const relativePath = magicDocs.magicRelative(name);
      // Respect user read-only locks on .forge/magic/<name>.md.
      if (typeof assertWritablePath === "function" && relativePath) {
        await assertWritablePath(ctx.projectDir, relativePath, "deleting");
      }
      const file = magicDocs.magicFile(ctx.projectDir, name);
      try {
        await fs.rm(file);
        return { deleted: true, name, path: relativePath };
      } catch (error) {
        if (error?.code === "ENOENT") return { deleted: false, name };
        throw error;
      }
    },
  });
};
