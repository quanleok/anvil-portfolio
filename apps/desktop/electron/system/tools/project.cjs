const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { readPromptPrevId, prevIdToMeta } = require("../../continuity.cjs");
const {
  parsePromptReadinessOverrideMeta,
} = require("../../prompt-readiness-meta.cjs");
const {
  normalizeEntityRefs,
  serializeEntityRefsMeta,
} = require("../../entity-refs.cjs");
const {
  LEGACY_STORY_DOC_PATHS,
} = require("../../story-system.cjs");
const {
  sortPromptEntriesByStoryOrder,
  sortSceneEntriesByScriptOrder,
} = require("../../scene-order.cjs");
const {
  readDurationSec,
  resolveSceneLink,
} = require("../../script-metadata.cjs");

const PROJECT_SCOPE_PATH = "story/intake.md";

module.exports = function registerProjectTools(api) {
  const {
    registerTool,
    runTool,
    readProjectIndex,
    readProjectMetadata,
    writeProjectMetadata,
    buildProjectIndexSummary,
    normalizeRelativePath,
    resolveInside,
    truncateText,
    parseFrontmatter,
    listMarkdownFilesRecursive,
    readMarkdownIndexEntry,
    refreshProjectIndex,
    slugifyName,
    ensureUniqueRelativePath,
    assertWritablePath,
  } = api;

  function serializeMarkdown({ id, title, content, extraMeta }) {
    const lines = ["---", `id: ${id}`, `title: ${title}`];
    if (extraMeta) {
      for (const [key, value] of Object.entries(extraMeta)) {
        if (value === undefined || value === null || value === "") continue;
        lines.push(`${key}: ${String(value).replace(/\n/g, " ")}`);
      }
    }
    lines.push("---", "", String(content || "").trim(), "");
    return lines.join("\n");
  }

  // Flatten agent-sourced titles to a single line before they reach the
  // frontmatter serializer. Without this, an embedded `\n` corrupts the
  // round-trip: serializeMarkdown would write `title: Line1\nLine2\n...`,
  // then parseFrontmatter (which splits on `\n` line-by-line) would pick
  // up `title: Line1` and silently drop `Line2`. UI inputs already filter
  // newlines, but agent tool calls can pass any string.
  function sanitizeTitle(raw) {
    return String(raw || "")
      .replace(/[\r\n\t\v\f]+/g, " ")
      .replace(/[\x00-\x1f\x7f]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Find the next available ordinal by scanning existing filenames for
  // the `<prefix>-NN` pattern and returning max+1. Counting files would
  // be wrong: after deleting scene-02 from [01, 02, 03], the count is 2
  // and count+1 collides with the existing scene-03. Max+1 (=4) is the
  // only safe choice — numbering must stay monotonic across deletes.
  async function nextOrdinal(projectDir, dir, prefix) {
    const files = await listMarkdownFilesRecursive(projectDir, dir);
    if (!prefix) return files.length + 1;
    const re = new RegExp(`^${prefix}-(\\d+)`);
    let maxOrdinal = 0;
    for (const file of files) {
      const match = path.posix.basename(file).match(re);
      if (!match) continue;
      const n = Number(match[1]);
      if (Number.isFinite(n) && n > maxOrdinal) maxOrdinal = n;
    }
    return maxOrdinal + 1;
  }

  function pad2(n) {
    const num = Number(n);
    if (!Number.isFinite(num) || num < 0) return "00";
    return String(num).padStart(2, "0");
  }

  // Strip an existing leading numeric prefix (any depth, "—" or "-" or ":")
  // so we can re-prefix cleanly without doubling.
  function stripNumericPrefix(title) {
    return String(title || "")
      .replace(/^\s*\d+(?:\.\d+)*\s*[—\-:·]\s*/u, "")
      .trim();
  }

  // Pull "01" from "scenes/scene-01-bone-pile.md" or "shots/scene-01-foo/shot-02-bar.md"
  function ordinalFromPathSegment(p, prefix) {
    if (!p) return 0;
    const re = new RegExp(`${prefix}-(\\d+)`);
    const match = String(p).match(re);
    return match ? Number(match[1]) : 0;
  }

  function sceneOrdinalFromPath(scenePath) {
    return ordinalFromPathSegment(scenePath, "scene");
  }

  function parseDurationSec(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Math.round(parsed);
  }

  function stemFromRelativePath(value) {
    const normalized = normalizeRelativePath(value);
    return path.posix.basename(normalized, path.posix.extname(normalized));
  }

  function groupedChildFolderSlug(entry, rootFolder) {
    const parts = normalizeRelativePath(entry?.path).split("/");
    return parts[0] === rootFolder && parts.length > 2 ? parts[1] || "" : "";
  }

  function childEntryBelongsToScene(entry, scene, rootFolder) {
    if (!entry || !scene) return false;
    if (entry.sceneId && scene.id) return entry.sceneId === scene.id;
    const entryScenePath = normalizeRelativePath(entry.scenePath);
    const scenePath = normalizeRelativePath(scene.path);
    if (entryScenePath && scenePath && entryScenePath === scenePath) return true;
    const folder = groupedChildFolderSlug(entry, rootFolder);
    return Boolean(folder && scenePath && folder === stemFromRelativePath(scenePath));
  }

  function buildPromptSegments(durationSec, maxSegmentSec = 15) {
    const totalDurationSec = parseDurationSec(durationSec);
    if (!totalDurationSec) {
      return [];
    }
    const segmentCount = Math.max(1, Math.ceil(totalDurationSec / maxSegmentSec));
    const segments = [];
    for (let i = 0; i < segmentCount; i += 1) {
      const segmentStartSec = i * maxSegmentSec;
      const remaining = totalDurationSec - segmentStartSec;
      const segmentDurationSec = Math.min(maxSegmentSec, remaining);
      segments.push({
        durationSec: segmentDurationSec,
        segmentCount,
        segmentEndSec: segmentStartSec + segmentDurationSec,
        segmentIndex: i + 1,
        segmentStartSec,
      });
    }
    return segments;
  }

  async function findSceneByIdOrPath(projectDir, idOrPath) {
    const target = String(idOrPath || "").trim();
    if (!target) return null;
    const files = await listMarkdownFilesRecursive(projectDir, "scenes");
    for (const relativePath of files) {
      if (relativePath === target) {
        const doc = await readMarkdownIndexEntry(projectDir, relativePath);
        return { ...doc, path: relativePath };
      }
    }
    for (const relativePath of files) {
      const doc = await readMarkdownIndexEntry(projectDir, relativePath);
      if (doc?.id === target) {
        return { ...doc, path: relativePath };
      }
    }
    return null;
  }

  async function findPromptByIdOrPath(projectDir, idOrPath) {
    const target = String(idOrPath || "").trim();
    if (!target) return null;
    const files = await listMarkdownFilesRecursive(projectDir, "prompts", true);
    for (const relativePath of files) {
      if (relativePath === target) {
        const doc = await readMarkdownIndexEntry(projectDir, relativePath);
        return { ...doc, path: relativePath };
      }
    }
    for (const relativePath of files) {
      const doc = await readMarkdownIndexEntry(projectDir, relativePath);
      if (doc?.id === target) {
        return { ...doc, path: relativePath };
      }
    }
    return null;
  }

  function serializeFrontmatterDocument(meta = {}, body = "") {
    const lines = ["---"];
    if (meta.id) lines.push(`id: ${meta.id}`);
    if (meta.title) lines.push(`title: ${meta.title}`);
    for (const [key, value] of Object.entries(meta)) {
      if (key === "id" || key === "title") continue;
      if (value === undefined || value === null || value === "") continue;
      lines.push(`${key}: ${String(value).replace(/\n/g, " ")}`);
    }
    lines.push("---");
    const normalizedBody = String(body || "").replace(/^\n+/, "");
    return `${lines.join("\n")}\n${normalizedBody ? `\n${normalizedBody}` : "\n"}`;
  }

  async function updateMarkdownMeta(projectDir, relativePath, updater) {
    const absolute = resolveInside(projectDir, relativePath);
    const raw = await fs.readFile(absolute, "utf8");
    const { meta, body } = parseFrontmatter(raw);
    const nextMeta = await updater({ ...meta }, body);
    if (!nextMeta || typeof nextMeta !== "object") {
      throw new Error("updateMarkdownMeta: updater must return a meta object.");
    }
    await fs.writeFile(absolute, serializeFrontmatterDocument(nextMeta, body), "utf8");
    return {
      body,
      meta: nextMeta,
      path: relativePath,
    };
  }

  registerTool("get_project_index", {
    tier: "core",
    description:
      "Get the fast project overview from .forge/index.json. Use this first to understand story/script/scenes/shots/prompts/assets and user-created Canon/custom sections without scanning the project. Legacy beats may appear in older projects.",
    args: {},
    async run(_args, ctx) {
      const projectIndex = await readProjectIndex(ctx.projectDir);
      return buildProjectIndexSummary(projectIndex);
    },
  });

  registerTool("read_many_files", {
    tier: "domain",
    description:
      "Read several text files in one turn. Use this instead of multiple read_file calls when you already know the paths.",
    args: {
      paths: "array of relative file paths",
      maxCharsPerFile: "optional truncation limit per file, default 12000",
    },
    async run({ paths, maxCharsPerFile = 12000 }, ctx) {
      if (!Array.isArray(paths) || !paths.length) {
        throw new Error("read_many_files: 'paths' must be a non-empty array.");
      }

      const limit = Math.max(1000, Number(maxCharsPerFile) || 12000);
      const files = await Promise.all(
        paths.map(async (rawPath) => {
          const relativePath = normalizeRelativePath(rawPath);
          try {
            const absolute = resolveInside(ctx.projectDir, relativePath);
            const stat = await fs.stat(absolute);
            if (stat.isDirectory()) {
              return { path: relativePath, error: "is a directory" };
            }
            const content = await fs.readFile(absolute, "utf8");
            const truncated = truncateText(content, limit);
            return {
              path: relativePath,
              content: truncated.content,
              size: content.length,
              truncated: truncated.truncated,
            };
          } catch (error) {
            return { path: relativePath, error: error instanceof Error ? error.message : String(error) };
          }
        }),
      );

      return { files };
    },
  });

  registerTool("list_scenes", {
    tier: "domain",
    description: "List all scenes in the project.",
    args: {},
    async run(_args, ctx) {
      const files = await listMarkdownFilesRecursive(ctx.projectDir, "scenes", false);
      const scenes = [];
      for (const file of files) {
        const content = await fs.readFile(resolveInside(ctx.projectDir, file), "utf8");
        const { meta } = parseFrontmatter(content);
        scenes.push({
          durationSec: readDurationSec(meta),
          id: meta.id || "",
          path: file,
          sceneOrder: parseDurationSec(meta.sceneOrder),
          title: meta.title || file,
        });
      }
      let masterScript = null;
      try {
        masterScript = await readMarkdownIndexEntry(ctx.projectDir, "script/master-script.md");
      } catch {}
      return { scenes: sortSceneEntriesByScriptOrder(scenes, masterScript ? [masterScript] : []) };
    },
  });

  registerTool("list_prompts", {
    tier: "domain",
    description: "List all prompts (stored as prompts/ markdown files) in the project. Optional sceneId narrows to one scene's prompts.",
    args: {
      sceneId: "optional",
    },
    async run({ sceneId } = {}, ctx) {
      const files = await listMarkdownFilesRecursive(ctx.projectDir, "prompts", true);
      const loaded = await Promise.all(
        files.map(async (file) => {
          const content = await fs.readFile(resolveInside(ctx.projectDir, file), "utf8");
          const { meta } = parseFrontmatter(content);
          return { file, meta };
        }),
      );
      const sceneListResult = await runTool("list_scenes", {}, ctx).catch(() => ({ scenes: [] }));
      const scenes = Array.isArray(sceneListResult?.scenes) ? sceneListResult.scenes : [];
      const prompts = [];
      for (const { file, meta } of loaded) {
        const sceneLink = resolveSceneLink(meta, file, scenes);
        if (sceneId && sceneLink.sceneId !== sceneId) continue;
        prompts.push({
          prevPromptId: readPromptPrevId(meta),
          durationSec: readDurationSec(meta),
          id: meta.id || "",
          parentPromptId:
            typeof meta.parentPromptId === "string" && meta.parentPromptId.trim()
              ? meta.parentPromptId.trim()
              : null,
          path: file,
          segmentCount: parseDurationSec(meta.segmentCount),
          segmentEndSec: parseDurationSec(meta.segmentEndSec),
          segmentIndex: parseDurationSec(meta.segmentIndex),
          segmentStartSec: parseDurationSec(meta.segmentStartSec),
          title: meta.title || file,
          entityRefs: normalizeEntityRefs(meta?.entityRefs),
          sceneId: sceneLink.sceneId,
          scenePath: sceneLink.scenePath,
        });
      }
      return {
        prompts: sortPromptEntriesByStoryOrder(prompts, {
          scenes,
        }),
      };
    },
  });

  registerTool("refresh_project_index", {
    tier: "core",
    description:
      "Rebuild .forge/index.json from the current project files and metadata. Use this after bulk file changes, imports, or renames.",
    args: {},
    async run(_args, ctx) {
      const index = await refreshProjectIndex(ctx.projectDir);
      return {
        refreshed: true,
        summary: buildProjectIndexSummary(index),
      };
    },
  });

  async function readDocEntry(projectDir, relativePath, limit) {
    const absolute = resolveInside(projectDir, relativePath);
    const raw = await fs.readFile(absolute, "utf8");
    const { meta, body } = parseFrontmatter(raw);
    const truncated = truncateText(body, limit);
    const normalizedPath = normalizeRelativePath(relativePath);
    const rawTitle = typeof meta?.title === "string" && meta.title.trim() ? meta.title.trim() : path.basename(relativePath);
    const title = normalizedPath === PROJECT_SCOPE_PATH && (/^(project\s+intake|intake\.md)$/i.test(rawTitle) || rawTitle === path.basename(relativePath))
      ? "Project Scope"
      : rawTitle;
    const normalizedMeta = normalizedPath === PROJECT_SCOPE_PATH
      ? { ...meta, title: "Project Scope", contextGroup: "project" }
      : meta;
    return {
      id: typeof meta?.id === "string" ? meta.id : "",
      title,
      path: normalizedPath,
      content: truncated.content,
      truncated: truncated.truncated,
      entityRefs: normalizeEntityRefs(meta?.entityRefs),
      meta: normalizedMeta,
    };
  }

  registerTool("read_story_bundle", {
    tier: "domain",
    description:
      "Read visible story context docs, including story/intake.md Project Scope, the master script header, and user-created Canon markdown sections in a single turn. Use read_project_context only for hidden ANVIL.md agent protocol/workflow rules.",
    args: { maxCharsPerFile: "optional per-file cap, default 8000" },
    async run({ maxCharsPerFile = 8000 }, ctx) {
      const limit = Math.max(1000, Number(maxCharsPerFile) || 8000);
      const storyFiles = (await listMarkdownFilesRecursive(ctx.projectDir, "story", false).catch(() => []))
        .filter((relativePath) => !LEGACY_STORY_DOC_PATHS.has(normalizeRelativePath(relativePath)));
      const story = await Promise.all(storyFiles.map((p) => readDocEntry(ctx.projectDir, p, limit)));
      const scriptFiles = await listMarkdownFilesRecursive(ctx.projectDir, "script", false).catch(() => []);
      const script = await Promise.all(scriptFiles.map((p) => readDocEntry(ctx.projectDir, p, limit)));
      const metadata = await readProjectMetadata(ctx.projectDir).catch(() => ({}));
      const canonSections = [];
      const customSections = Array.isArray(metadata?.customSubsections) ? metadata.customSubsections : [];
      for (const section of customSections) {
        if (section?.primary !== "script" || section?.kind !== "docs" || !section?.folder) continue;
        const docFiles = (await listMarkdownFilesRecursive(ctx.projectDir, section.folder, false).catch(() => []))
          .filter((relativePath) =>
            normalizeRelativePath(relativePath) !== normalizeRelativePath(section.instructionsPath || "") &&
            path.posix.extname(relativePath).toLowerCase() === ".md",
          );
        const docs = await Promise.all(docFiles.map((p) => readDocEntry(ctx.projectDir, p, limit)));
        canonSections.push({
          id: section.id,
          name: section.name,
          folder: section.folder,
          docs,
        });
      }
      return { story, script, canonSections };
    },
  });

  registerTool("read_prompt_bundle", {
    tier: "domain",
    description:
      "Read one prompt and its parent scene in a single turn. Use this when a prompt is the current selection and you want scene context before rewriting it.",
    args: {
      promptId: "optional prompt id",
      path: "optional prompt path",
      title: "optional prompt title substring",
      maxCharsPerFile: "optional per-file cap, default 12000",
    },
    async run({ promptId, path: promptPath, title, maxCharsPerFile = 12000 }, ctx) {
      const limit = Math.max(1000, Number(maxCharsPerFile) || 12000);
      const projectIndex = await readProjectIndex(ctx.projectDir);
      const prompts = Array.isArray(projectIndex?.prompts) ? projectIndex.prompts : [];
      const normalizedPath = typeof promptPath === "string" && promptPath.trim()
        ? normalizeRelativePath(promptPath)
        : "";
      const normalizedTitle = String(title || "").trim().toLowerCase();

      const prompt =
        prompts.find((entry) => promptId && entry?.id === promptId) ||
        prompts.find((entry) => normalizedPath && normalizeRelativePath(entry?.path) === normalizedPath) ||
        prompts.find((entry) => normalizedTitle && String(entry?.title || "").toLowerCase().includes(normalizedTitle));

      if (!prompt?.path) {
        throw new Error("read_prompt_bundle: prompt not found.");
      }

      const promptDoc = await readDocEntry(ctx.projectDir, prompt.path, limit);

      const scenes = Array.isArray(projectIndex?.scenes) ? projectIndex.scenes : [];
      const sceneIdRef = prompt.sceneId || "";
      const scenePathRef = prompt.scenePath || "";
      const scene =
        scenes.find((entry) => sceneIdRef && entry?.id === sceneIdRef) ||
        scenes.find((entry) => scenePathRef && entry?.path && normalizeRelativePath(entry.path) === normalizeRelativePath(scenePathRef)) ||
        scenes.find((entry) => childEntryBelongsToScene(prompt, entry, "prompts"));
      const sceneDoc = scene?.path ? await readDocEntry(ctx.projectDir, scene.path, limit) : null;

      return {
        prompt: {
          ...promptDoc,
          prevPromptId: readPromptPrevId(promptDoc.meta),
          durationSec: readDurationSec(promptDoc.meta),
          readinessOverride: parsePromptReadinessOverrideMeta(promptDoc.meta),
          segmentCount: parseDurationSec(promptDoc.meta?.segmentCount),
          segmentEndSec: parseDurationSec(promptDoc.meta?.segmentEndSec),
          segmentIndex: parseDurationSec(promptDoc.meta?.segmentIndex),
          segmentStartSec: parseDurationSec(promptDoc.meta?.segmentStartSec),
        },
        scene: sceneDoc
          ? {
              ...sceneDoc,
              durationSec: parseDurationSec(sceneDoc.meta?.durationSec),
            }
          : null,
      };
    },
  });

  registerTool("read_scene_bundle", {
    tier: "domain",
    description:
      "Read one scene together with its prompts and dialogue in a single turn. Use this instead of many read_file calls. Dialogue is included by default — pass includeDialogue=false only if you specifically need to skip it.",
    args: {
      sceneId: "optional scene id",
      path: "optional scene path",
      title: "optional scene title substring",
      maxCharsPerFile: "optional truncation limit per file, default 12000",
      includePrompts: "optional boolean, default true",
      includeDialogue: "optional boolean, default true",
    },
    async run(
      {
        sceneId,
        path: scenePath,
        title,
        maxCharsPerFile = 12000,
        includePrompts = true,
        includeDialogue = true,
      },
      ctx,
    ) {
      const limit = Math.max(1000, Number(maxCharsPerFile) || 12000);
      const projectIndex = await readProjectIndex(ctx.projectDir);
      const scenes = Array.isArray(projectIndex?.scenes) ? projectIndex.scenes : [];
      const normalizedPath = typeof scenePath === "string" && scenePath.trim()
        ? normalizeRelativePath(scenePath)
        : "";
      const normalizedTitle = String(title || "").trim().toLowerCase();

      const scene =
        scenes.find((entry) => sceneId && entry?.id === sceneId) ||
        scenes.find((entry) => normalizedPath && normalizeRelativePath(entry?.path) === normalizedPath) ||
        scenes.find((entry) => normalizedTitle && String(entry?.title || "").toLowerCase().includes(normalizedTitle));

      if (!scene?.path) {
        throw new Error("read_scene_bundle: scene not found.");
      }

      const readEntry = async (relativePath) => {
        const absolute = resolveInside(ctx.projectDir, relativePath);
        const raw = await fs.readFile(absolute, "utf8");
        const { meta, body } = parseFrontmatter(raw);
        const truncated = truncateText(body, limit);
        return {
          id: typeof meta?.id === "string" ? meta.id : "",
          title: typeof meta?.title === "string" && meta.title.trim() ? meta.title.trim() : path.basename(relativePath),
          path: normalizeRelativePath(relativePath),
          content: truncated.content,
          truncated: truncated.truncated,
          entityRefs: normalizeEntityRefs(meta?.entityRefs),
          meta,
        };
      };

      const sceneDocument = await readEntry(scene.path);
      const prompts = includePrompts
        ? await Promise.all(
            (Array.isArray(projectIndex?.prompts) ? projectIndex.prompts : [])
              .filter((entry) => childEntryBelongsToScene(entry, scene, "prompts"))
              .map((entry) => readEntry(entry.path)),
          )
        : [];
      // Dialogue is loaded into the project index by buildProjectIndex
      // (main.cjs) — entries carry sceneId pointers from frontmatter.
      const dialogue = includeDialogue
        ? await Promise.all(
            (Array.isArray(projectIndex?.dialogue) ? projectIndex.dialogue : [])
              .filter((entry) => childEntryBelongsToScene(entry, scene, "dialogue"))
              .map((entry) => readEntry(entry.path)),
          )
        : [];
      const promptsOut = prompts.map((entry) => ({
        ...entry,
        prevPromptId: readPromptPrevId(entry.meta),
        durationSec: readDurationSec(entry.meta),
        segmentCount: parseDurationSec(entry.meta?.segmentCount),
        segmentEndSec: parseDurationSec(entry.meta?.segmentEndSec),
        segmentIndex: parseDurationSec(entry.meta?.segmentIndex),
        segmentStartSec: parseDurationSec(entry.meta?.segmentStartSec),
      }));

      return {
        scene: {
          ...sceneDocument,
          durationSec: readDurationSec(sceneDocument.meta),
        },
        prompts: promptsOut,
        dialogue: dialogue.map((entry) => ({
          ...entry,
          sceneId: typeof entry.meta?.sceneId === "string" ? entry.meta.sceneId : null,
        })),
      };
    },
  });

  registerTool("set_prompt_continuity", {
    tier: "edit",
    description:
      "Set or clear the predecessor of a prompt for the Seedance 2 first-frame handoff. Pass `prev` (prompt id or path) to chain this prompt onto another, or omit/null to clear an existing link. Sequential prompts created via create_prompt are auto-linked, so this tool is mainly for repairs.",
    args: {
      prompt: "required prompt id or relative path",
      prev: "optional predecessor prompt id or relative path — omit/null to clear",
    },
    async run({ prompt, prev }, ctx) {
      const promptDoc = await findPromptByIdOrPath(ctx.projectDir, prompt);
      if (!promptDoc) {
        throw new Error("set_prompt_continuity: prompt not found.");
      }

      let prevId = null;
      if (prev) {
        const prevPrompt = await findPromptByIdOrPath(ctx.projectDir, prev);
        if (!prevPrompt) {
          throw new Error("set_prompt_continuity: predecessor prompt not found.");
        }
        if (prevPrompt.id === promptDoc.id) {
          throw new Error("set_prompt_continuity: a prompt cannot continue from itself.");
        }
        prevId = prevPrompt.id;
      }

      if (typeof assertWritablePath === "function") {
        await assertWritablePath(
          ctx.projectDir,
          promptDoc.path,
          prevId ? "setting prompt continuity" : "clearing prompt continuity",
        );
      }
      await updateMarkdownMeta(ctx.projectDir, promptDoc.path, (meta) => ({
        ...meta,
        ...prevIdToMeta(prevId),
      }));
      await refreshProjectIndex(ctx.projectDir);

      return {
        ok: true,
        prompt: {
          id: promptDoc.id,
          path: promptDoc.path,
          title: promptDoc.title,
        },
        prevPromptId: prevId,
      };
    },
  });

  registerTool("create_scene", {
    tier: "edit",
    description:
      "Create a new scene markdown file under scenes/ with the correct frontmatter (id, title). Returns { id, path, title }. Use this instead of write_file when adding a new scene — it generates a unique id, a kebab-cased path, and refreshes the project index.",
    args: {
      title: "required scene title",
      content: "optional scene body (markdown)",
      durationSec: "optional estimated runtime in seconds",
      entityRefs:
        "optional array of linked asset refs: [{ section: characters|locations|props|keyframes|audio, entityId, role: featured|mentioned|background }]. Create placeholder asset cards first, then pass their ids here.",
    },
    async run({ title, content, durationSec, entityRefs }, ctx) {
      const rawTitle = sanitizeTitle(title);
      if (!rawTitle) throw new Error("create_scene: 'title' is required.");
      const normalizedEntityRefs = normalizeEntityRefs(entityRefs);
      const namePart = stripNumericPrefix(rawTitle);
      const ordinal = await nextOrdinal(ctx.projectDir, "scenes", "scene");
      const slug = slugifyName(namePart || rawTitle);
      const desired = `scenes/scene-${pad2(ordinal)}-${slug}.md`;
      const relativePath = await ensureUniqueRelativePath(ctx.projectDir, desired);
      const numberedTitle = `${pad2(ordinal)} — ${namePart || rawTitle}`;
      const absolute = resolveInside(ctx.projectDir, relativePath);
      const id = randomUUID();
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(
        absolute,
        serializeMarkdown({
          id,
          title: numberedTitle,
          content,
          extraMeta: {
            durationSec: parseDurationSec(durationSec) || "",
            ...serializeEntityRefsMeta(normalizedEntityRefs),
          },
        }),
        "utf8",
      );
      await refreshProjectIndex(ctx.projectDir);
      return {
        id,
        path: relativePath,
        title: numberedTitle,
        durationSec: parseDurationSec(durationSec),
        entityRefs: normalizedEntityRefs,
      };
    },
  });

  registerTool("create_prompt", {
    tier: "edit",
    description:
      "Create a prompt markdown file under prompts/<scene-folder> with the supplied content and links. The stored duration defaults to 15 seconds and is capped at 15. Use scene or parentPromptId to select its location.",
    args: {
      scene: "optional scene id or relative path",
      title: "required prompt title",
      content: "optional user-supplied prompt body (markdown).",
      durationSec: "optional prompt duration in seconds. Defaults to 15 and is capped at 15.",
      parentPromptId:
        "optional — create a sub-prompt of this prompt ID. Nesting is single-level; a nested parent resolves to its root parent.",
      entityRefs:
        "optional array of existing asset refs: [{ section: characters|locations|props|keyframes|audio, entityId, role: featured|mentioned|background }].",
    },
    async run({ scene, title, content, durationSec = 15, parentPromptId, entityRefs }, ctx) {
      const rawTitle = sanitizeTitle(title);
      if (!rawTitle) throw new Error("create_prompt: 'title' is required.");
      if (!scene && !parentPromptId) {
        throw new Error("create_prompt: provide 'scene' or 'parentPromptId'.");
      }

      let sceneDoc = scene ? await findSceneByIdOrPath(ctx.projectDir, scene) : null;
      // Resolve the parent prompt up-front so we can validate it +
      // hoist nested-of-nested back to single-level (matches the
      // renderer's "single-level only" rule). When a parent is set
      // and no scene was passed, inherit the parent's scene so the
      // caller doesn't have to pass it twice.
      let resolvedParentPromptId = null;
      if (parentPromptId) {
        const projectIndex = await readProjectIndex(ctx.projectDir).catch(() => ({}));
        const allPrompts = Array.isArray(projectIndex?.prompts) ? projectIndex.prompts : [];
        const parentEntry = allPrompts.find((entry) => entry?.id === parentPromptId);
        if (!parentEntry) {
          throw new Error(`create_prompt: parentPromptId '${parentPromptId}' not found.`);
        }
        resolvedParentPromptId = parentEntry.parentPromptId || parentEntry.id;
        if (!sceneDoc && parentEntry.sceneId) {
          sceneDoc = await findSceneByIdOrPath(ctx.projectDir, parentEntry.sceneId);
        }
      }
      if (!sceneDoc) {
        throw new Error("create_prompt: could not resolve a scene — pass `scene`.");
      }
      const namePart = stripNumericPrefix(rawTitle);
      const normalizedEntityRefs = normalizeEntityRefs(entityRefs);
      const sceneFolder = path.posix.basename(sceneDoc.path, path.posix.extname(sceneDoc.path));
      const promptDir = `prompts/${sceneFolder}`;
      const sceneOrdinal = sceneOrdinalFromPath(sceneDoc.path);
      const clipDurationSec = Math.min(15, parseDurationSec(durationSec) || 15);
      const promptOrdinal = await nextOrdinal(ctx.projectDir, promptDir, "prompt");
      // Auto-link this prompt's prevPromptId to the last existing scene
      // prompt so the agent gets a free continuity hint.
      const projectIndex = await readProjectIndex(ctx.projectDir).catch(() => ({}));
      const existingScenePrompts = sortPromptEntriesByStoryOrder(
        (Array.isArray(projectIndex?.prompts) ? projectIndex.prompts : [])
          .filter((entry) => childEntryBelongsToScene(entry, sceneDoc, "prompts")),
        { scenes: [sceneDoc] },
      );
      const previousCreatedId = existingScenePrompts[existingScenePrompts.length - 1]?.id || null;

      const slug = slugifyName(namePart || rawTitle);
      const desired = `${promptDir}/prompt-${pad2(promptOrdinal)}-${slug}.md`;
      const relativePath = await ensureUniqueRelativePath(ctx.projectDir, desired);
      const numberedTitle = `${pad2(sceneOrdinal)}.${pad2(promptOrdinal)} — ${namePart || rawTitle}`;
      const absolute = resolveInside(ctx.projectDir, relativePath);
      const id = randomUUID();
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(
        absolute,
        serializeMarkdown({
          id,
          title: numberedTitle,
          content,
          extraMeta: {
            ...prevIdToMeta(previousCreatedId),
            durationSec: clipDurationSec,
            parentPromptId: resolvedParentPromptId || "",
            sceneId: sceneDoc.id || "",
            scenePath: sceneDoc.path || "",
            ...serializeEntityRefsMeta(normalizedEntityRefs),
          },
        }),
        "utf8",
      );
      await refreshProjectIndex(ctx.projectDir);
      return {
        count: 1,
        durationSec: clipDurationSec,
        entityRefs: normalizedEntityRefs,
        id,
        parentPromptId: resolvedParentPromptId || null,
        path: relativePath,
        prevPromptId: previousCreatedId,
        prompts: [{
          durationSec: clipDurationSec,
          id,
          parentPromptId: resolvedParentPromptId || null,
          path: relativePath,
          prevPromptId: previousCreatedId,
          entityRefs: normalizedEntityRefs,
          sceneId: sceneDoc.id || "",
          scenePath: sceneDoc.path,
          title: numberedTitle,
        }],
        sceneId: sceneDoc.id || "",
        scenePath: sceneDoc.path,
        split: false,
        title: numberedTitle,
      };
    },
  });

  // Helper used by the delete_* tools below. Walks the project index for
  // children that point at the entity being deleted and removes their
  // backing files. We default to cascade=true because dropping a scene
  // and leaving 12 orphaned shots is almost never what the user wants.
  async function removeFile(projectDir, relativePath) {
    try {
      await fs.unlink(resolveInside(projectDir, relativePath));
      return relativePath;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      return null;
    }
  }

  async function tryRemoveEmptyDir(projectDir, relativeDir) {
    if (!relativeDir) return;
    try {
      await fs.rmdir(resolveInside(projectDir, relativeDir));
    } catch {
      // Directory not empty or doesn't exist — fine, ignore.
    }
  }

  registerTool("delete_prompt", {
    tier: "edit",
    description:
      "Delete a prompt markdown file. Accepts an id or relative path. Returns { deletedPath } or null if not found. Use this instead of write_file to actually remove a prompt from the project; the frontend picks up the change via the file watcher.",
    args: {
      promptId: "optional prompt id",
      path: "optional relative path (e.g. 'prompts/scene-01-foo/shot-02-bar/prompt-01-baz.md')",
    },
    async run({ promptId, path: rawPath }, ctx) {
      const target = String(promptId || rawPath || "").trim();
      if (!target) throw new Error("delete_prompt: provide 'promptId' or 'path'.");
      const promptDoc = await findPromptByIdOrPath(ctx.projectDir, target);
      if (!promptDoc?.path) {
        return { deletedPath: null, reason: "prompt not found" };
      }
      const deleted = await removeFile(ctx.projectDir, promptDoc.path);
      await refreshProjectIndex(ctx.projectDir);
      return { deletedPath: deleted };
    },
  });

  registerTool("delete_scene", {
    tier: "edit",
    description:
      "Delete a scene markdown file. By default also deletes every beat, shot, prompt, and dialogue file that references this scene (cascade). Pass cascade=false to delete only the scene and leave its children behind as orphans (rarely useful).",
    args: {
      sceneId: "optional scene id",
      path: "optional relative path (e.g. 'scenes/scene-01-foo.md')",
      cascade: "optional boolean (default true) — also delete child beats, shots, prompts, and dialogue",
    },
    async run({ sceneId, path: rawPath, cascade = true }, ctx) {
      const target = String(sceneId || rawPath || "").trim();
      if (!target) throw new Error("delete_scene: provide 'sceneId' or 'path'.");
      const sceneDoc = await findSceneByIdOrPath(ctx.projectDir, target);
      if (!sceneDoc?.path) {
        return {
          deletedPath: null,
          deletedBeats: [],
          deletedShots: [],
          deletedPrompts: [],
          deletedDialogue: [],
          reason: "scene not found",
        };
      }
      const deletedBeats = [];
      const deletedShots = [];
      const deletedPrompts = [];
      const deletedDialogue = [];
      if (cascade !== false) {
        const projectIndex = await readProjectIndex(ctx.projectDir);
        const beats = Array.isArray(projectIndex?.beats) ? projectIndex.beats : [];
        const shots = Array.isArray(projectIndex?.shots) ? projectIndex.shots : [];
        const prompts = Array.isArray(projectIndex?.prompts) ? projectIndex.prompts : [];
        const dialogue = Array.isArray(projectIndex?.dialogue) ? projectIndex.dialogue : [];
        const matchesScene = (entry, rootFolder) =>
          entry?.sceneId === sceneDoc.id ||
          normalizeRelativePath(entry?.scenePath || "") === sceneDoc.path ||
          childEntryBelongsToScene(entry, sceneDoc, rootFolder);
        for (const entry of prompts) {
          if (!matchesScene(entry, "prompts")) continue;
          const removed = await removeFile(ctx.projectDir, entry.path);
          if (removed) deletedPrompts.push(removed);
        }
        for (const entry of dialogue) {
          if (!matchesScene(entry, "dialogue")) continue;
          const removed = await removeFile(ctx.projectDir, entry.path);
          if (removed) deletedDialogue.push(removed);
        }
        for (const entry of shots) {
          if (!matchesScene(entry, "shots")) continue;
          const removed = await removeFile(ctx.projectDir, entry.path);
          if (removed) {
            deletedShots.push(removed);
            await tryRemoveEmptyDir(ctx.projectDir, path.posix.dirname(entry.path));
          }
        }
        for (const entry of beats) {
          if (!matchesScene(entry, "beats")) continue;
          const removed = await removeFile(ctx.projectDir, entry.path);
          if (removed) {
            deletedBeats.push(removed);
            await tryRemoveEmptyDir(ctx.projectDir, path.posix.dirname(entry.path));
          }
        }
      }
      const deletedPath = await removeFile(ctx.projectDir, sceneDoc.path);
      await refreshProjectIndex(ctx.projectDir);
      return { deletedPath, deletedBeats, deletedShots, deletedPrompts, deletedDialogue };
    },
  });

  registerTool("set_title", {
    tier: "edit",
    description:
      "Rename a scene/shot/prompt/story markdown file's displayed title. Updates the YAML frontmatter 'title:' field in-place without touching body content. USE THIS when changing what's shown in the Anvil UI list — write_file alone won't update the title because the UI reads it from frontmatter.",
    args: {
      path: "relative path to a .md file (scenes/*, prompts/**/*, story/*)",
      title: "new title",
    },
    async run({ path: relativePath, title }, ctx) {
      const cleanTitle = sanitizeTitle(title);
      if (!cleanTitle) {
        throw new Error("set_title: 'title' is required.");
      }
      // Read-only enforcement — set_title rewrites the markdown file, so
      // a locked path should refuse the change with the same envelope as
      // write_file/edit_file.
      if (typeof assertWritablePath === "function") {
        await assertWritablePath(ctx.projectDir, relativePath, "renaming");
      }
      const absolute = resolveInside(ctx.projectDir, relativePath);
      const original = await fs.readFile(absolute, "utf8");
      const text = typeof original === "string" ? original : "";

      let next;
      let previousTitle = "";
      if (text.startsWith("---\n")) {
        const end = text.indexOf("\n---\n", 4);
        if (end === -1) {
          throw new Error(`set_title: frontmatter in ${relativePath} is malformed.`);
        }
        const metaBlock = text.slice(4, end);
        const body = text.slice(end + 5);
        const lines = metaBlock.split("\n");
        let replaced = false;
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i];
          const sep = line.indexOf(":");
          if (sep === -1) continue;
          const key = line.slice(0, sep).trim();
          if (key === "title") {
            previousTitle = line.slice(sep + 1).trim();
            lines[i] = `title: ${cleanTitle}`;
            replaced = true;
            break;
          }
        }
        if (!replaced) {
          lines.push(`title: ${cleanTitle}`);
        }
        next = `---\n${lines.join("\n")}\n---\n${body.replace(/^\n+/, "")}`;
      } else {
        next = `---\ntitle: ${cleanTitle}\n---\n\n${text.replace(/^\n+/, "")}`;
      }

      await fs.writeFile(absolute, next, "utf8");
      await refreshProjectIndex(ctx.projectDir);
      return {
        path: relativePath,
        previousTitle,
        title: cleanTitle,
      };
    },
  });
};
