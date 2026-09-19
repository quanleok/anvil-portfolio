// Video-take tooling: extract_frame + build_render_bundle.
//
// Both are read-only composition tools — they never mutate project
// frontmatter or markdown. extract_frame writes to .forge/frames/
// which is a derived cache (safe to rebuild from any rendered take).
//
// Designed around Seedance 2's render-bundle model: a prompt render
// may supply (text, startFrame, lastFrame, references, duration). The
// bundle composer walks the continuity chain to auto-populate the
// startFrame from the predecessor take's end-frame keyframe.

const path = require("node:path");
const fs = require("node:fs/promises");
const { existsSync } = require("node:fs");

const { extractFrame } = require("../../frames.cjs");
const { readPromptPrevId } = require("../../continuity.cjs");
const {
  normalizeRelativePath,
  sortPromptEntriesByStoryOrder,
  sortSceneEntriesByScriptOrder,
} = require("../../scene-order.cjs");

const MAX_SEQUENCE_PROMPTS = 200;

module.exports = function registerVideoTools(api) {
  const {
    parseFrontmatter,
    registerTool,
    resolveInside,
    runTool,
    readProjectMetadata,
    writeProjectMetadata,
  } = api;

  function selectPromptKeeperTake(takes) {
    const explicitKeeper = takes.find((take) => take && take.isKeeper);
    if (explicitKeeper) return explicitKeeper;
    return [...takes].sort(
      (a, b) =>
        (Number(b?.takeIndex) || 0) - (Number(a?.takeIndex) || 0) ||
        String(b?.generatedAt || "").localeCompare(String(a?.generatedAt || "")),
    )[0] || null;
  }

  async function loadProjectJson(projectDir) {
    const projectJsonPath = path.join(projectDir, ".forge", "project.json");
    try {
      const raw = await fs.readFile(projectJsonPath, "utf8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async function readPromptBody(projectDir, relativePath) {
    if (!relativePath) return "";
    const raw = await fs.readFile(resolveInside(projectDir, relativePath), "utf8");
    const { body } = parseFrontmatter(raw);
    return String(body || "").trim();
  }

  function projectRelativePathExists(projectDir, relativePath) {
    if (!relativePath) return false;
    try {
      return existsSync(resolveInside(projectDir, relativePath));
    } catch {
      return false;
    }
  }

  function stemFromRelativePath(value) {
    const normalized = normalizeRelativePath(value);
    return path.posix.basename(normalized, path.posix.extname(normalized));
  }

  function promptFolderSlug(prompt) {
    const parts = normalizeRelativePath(prompt?.path).split("/");
    return parts[0] === "prompts" && parts.length > 2 ? parts[1] || "" : "";
  }

  function promptBelongsToScene(prompt, scene) {
    if (prompt?.sceneId) return prompt.sceneId === scene?.id;
    const promptScenePath = normalizeRelativePath(prompt?.scenePath);
    const scenePath = normalizeRelativePath(scene?.path);
    if (promptScenePath && scenePath && promptScenePath === scenePath) return true;
    const folder = promptFolderSlug(prompt);
    return Boolean(folder && scenePath && folder === stemFromRelativePath(scenePath));
  }

  function buildStoryOrderLookups(project) {
    const script = Array.isArray(project?.script) ? project.script : [];
    const scenes = sortSceneEntriesByScriptOrder(
      script.filter((entry) => entry?.kind === "scene"),
      script.filter((entry) => entry?.kind === "master"),
    );
    const prompts = sortPromptEntriesByStoryOrder(
      Array.isArray(project?.prompts) ? project.prompts : [],
      { scenes },
    );
    return {
      promptById: new Map(prompts.filter((prompt) => prompt?.id).map((prompt) => [prompt.id, prompt])),
      promptOrderById: new Map(prompts.filter((prompt) => prompt?.id).map((prompt, index) => [prompt.id, index])),
      sceneById: new Map(scenes.filter((scene) => scene?.id).map((scene) => [scene.id, scene])),
    };
  }

  async function extractLastFrameForTake(videoId, ctx) {
    if (!videoId) {
      throw new Error("render_prompt_sequence: missing generated take id for frame extraction.");
    }
    const existing = path.posix.join(".forge", "frames", videoId, "last.png");
    if (projectRelativePathExists(ctx.projectDir, existing)) return existing;

    const extracted = await runTool(
      "extract_frame",
      { videoId, position: "last" },
      { projectDir: ctx.projectDir, settings: ctx.settings },
    );
    const framePath = extracted?.framePath || existing;
    if (!projectRelativePathExists(ctx.projectDir, framePath)) {
      throw new Error(
        `render_prompt_sequence: generated take ${videoId}, but no usable last frame could be extracted for the next prompt.`,
      );
    }
    return framePath;
  }

  registerTool("extract_frame", {
    tier: "meta",
    description:
      "Extract a PNG frame from a rendered video take and cache it under .forge/frames/<videoId>/<position>.png. Use this to capture first/last-frame continuity from a previous take before writing or rendering the next prompt. The take must already exist as a VideoEntry in project.json.",
    args: {
      videoId: "required — VideoEntry id of the take to sample",
      position:
        "required — 'first' | 'last' | a positive number (seconds from start). 'last' auto-probes duration and steps back a hair so it lands on a clean decoded frame.",
    },
    async run({ videoId, position }, ctx) {
      if (!videoId) throw new Error("extract_frame: videoId required.");
      if (position === undefined || position === null || position === "") {
        throw new Error("extract_frame: position required.");
      }

      const project = await loadProjectJson(ctx.projectDir);
      if (!project) {
        throw new Error(
          "extract_frame: project.json not readable — open the project first.",
        );
      }

      const videos = Array.isArray(project.videos) ? project.videos : [];
      const video = videos.find((v) => v.id === videoId);
      if (!video) {
        throw new Error(
          `extract_frame: no VideoEntry with id ${videoId} in project.videos. Has the take been imported yet?`,
        );
      }

      // Coerce numeric strings (agent tool args often arrive as strings).
      let positionArg = position;
      if (typeof position === "string" && position !== "first" && position !== "last") {
        const asNum = Number(position);
        if (Number.isFinite(asNum) && asNum >= 0) positionArg = asNum;
      }

      const result = await extractFrame({
        projectDir: ctx.projectDir,
        videoPath: video.path,
        videoId,
        position: positionArg,
      });

      if (!result.ok) {
        throw new Error(result.error || "extract_frame: ffmpeg returned no frame.");
      }

      return {
        ok: true,
        videoId,
        position: typeof positionArg === "number" ? positionArg : positionArg,
        framePath: result.framePath,
      };
    },
  });

  registerTool("build_render_bundle", {
    tier: "meta",
    description:
      "Compose a Seedance 2 render bundle for a prompt: { text, startFrame?, lastFrame?, references[], duration, prevPromptId, shotType }. Walks the prompt continuity chain via prevPromptId when available; if the predecessor has a rendered take and its last frame was extracted, the bundle returns .forge/frames/<prevTakeId>/last.png as the startFrame keyframe. Read-only composition; does not run ffmpeg or mutate state.",
    args: {
      promptId: "required — prompt id to build the render bundle for",
    },
    async run({ promptId }, ctx) {
      if (!promptId) throw new Error("build_render_bundle: promptId required.");

      const listResult = await runTool("list_prompts", {}, { projectDir: ctx.projectDir });
      const allPrompts = Array.isArray(listResult && listResult.prompts)
        ? listResult.prompts
        : [];
      const prompt = allPrompts.find((p) => p.id === promptId);
      if (!prompt) {
        throw new Error(`build_render_bundle: prompt ${promptId} not found.`);
      }
      const promptText = await readPromptBody(ctx.projectDir, prompt.path);

      const project = await loadProjectJson(ctx.projectDir);
      if (!project) {
        throw new Error(
          "build_render_bundle: project.json not readable — open the project first.",
        );
      }

      // Continuity resolution — read prevPromptId (with legacy
      // fallbacks) from the prompt entry. Any predecessor link means we
      // want a motion-style keyframe handoff from the prior take.
      const prevId = readPromptPrevId(prompt);
      const prevPrompt = prevId ? allPrompts.find((p) => p.id === prevId) : null;
      const wantsKeyframe = Boolean(prevPrompt);

      let startFrame = null;
      let startFrameSource = null;
      // Hard preconditions for keyframe-anchored bundles. Rather than
      // letting the agent ship a bundle with a missing keyframe and
      // discover it on render-fail, surface the unmet condition as a
      // first-class envelope. Soft `status` strings mixed inside an
      // ok=true bundle were getting ignored.
      if (wantsKeyframe) {
        const videos = Array.isArray(project.videos) ? project.videos : [];
        const prevTakes = videos.filter((v) => v.promptId === prevPrompt.id);
        const prevTake = selectPromptKeeperTake(prevTakes);
        if (!prevTake) {
          return {
            ok: false,
            reason: "predecessor-not-rendered",
            promptId: prompt.id,
            error: `Continuity from prompt ${prevPrompt.id} requires a rendered take to extract its last frame, but that predecessor has no rendered takes yet.`,
            suggestions: [
              `Render prompt ${prevPrompt.id} first, then re-run build_render_bundle.`,
              `If this prompt should not chain from ${prevPrompt.id}, clear its prevPromptId.`,
            ],
          };
        }
        const relLast = path.posix.join(
          ".forge",
          "frames",
          prevTake.id,
          "last.png",
        );
        const absLast = path.join(ctx.projectDir, relLast);
        if (existsSync(absLast)) {
          startFrame = relLast;
          startFrameSource = {
            videoId: prevTake.id,
            position: "last",
            promptId: prevPrompt.id,
            takeIndex: prevTake.takeIndex || null,
          };
        } else {
          return {
            ok: false,
            reason: "keyframe-not-extracted",
            promptId: prompt.id,
            error: `Continuity keyframe for predecessor take ${prevTake.id} has not been extracted yet.`,
            suggestions: [
              `Call extract_frame with videoId=${prevTake.id}, position=last to generate the keyframe.`,
              "Then re-run build_render_bundle to compose the full bundle.",
            ],
            prevTakeId: prevTake.id,
          };
        }
      }

      // Entity references — resolve asset name + first linked media path
      // so the external renderer can attach them without re-deriving.
      const entityRefs = Array.isArray(prompt.entityRefs) ? prompt.entityRefs : [];
      const references = [];
      for (const ref of entityRefs) {
        const refId = ref?.entityId || ref?.id;
        if (!ref || !ref.section || !refId) continue;
        const dataKey = ref.section === "media" ? "library" : ref.section;
        const items = Array.isArray(project[dataKey]) ? project[dataKey] : [];
        const asset = items.find((a) => a.id === refId);
        if (!asset) continue;
        const media = Array.isArray(asset.media) ? asset.media : [];
        const firstMedia = media.find((m) => m && m.path);
        references.push({
          section: ref.section,
          id: asset.id,
          name: asset.name || asset.title || "",
          role: ref.role || "",
          mediaPath: firstMedia ? firstMedia.path : null,
        });
      }

      // Duration: prompt.durationSec is the authoritative slot. Segment
      // fields (segmentStartSec / segmentEndSec) are for display only.
      const durationRaw = Number(prompt.durationSec);
      const duration =
        Number.isFinite(durationRaw) && durationRaw > 0 ? Math.round(durationRaw) : null;

      // Hard cap per Seedance 2 prompt ceiling — flag if the prompt
      // slot exceeds it. Doesn't block; the agent/user decides whether
      // to split via buildPromptSegments.
      const HARD_CLIP_CEILING_SEC = 15;
      const overClipCeiling =
        duration !== null && duration > HARD_CLIP_CEILING_SEC;

      return {
        ok: true,
        promptId: prompt.id,
        text: promptText,
        startFrame,
        startFrameSource,
        lastFrame: null, // reserved: future support for user-pinned end anchor
        references,
        duration,
        overClipCeiling,
        prevPromptId: prevId || null,
        // Forward-compatible: if a future schema version adds shotType /
        // routeSuggestion to PromptEntry, surface them here automatically.
        shotType: prompt.shotType || null,
        routeSuggestion: prompt.routeSuggestion || null,
      };
    },
  });

  registerTool("render_prompt_sequence", {
    tier: "media",
    description:
      "Generate a prompt sequence in order and feed each completed take's last frame into the next prompt. This is the safe automation loop for Seedance-style continuity: wait for prompt N to finish, use its extracted .forge/frames/<takeId>/last.png as the next prompt's image reference, then continue. Current in-app generation supports EvoLink directly; use stage_reference_media(mode:'upload') for Topview/manual local-upload handoff.",
    args: {
      promptIds:
        "required — ordered array of prompt ids to render. Keep this explicit; do not render a whole film unless the user clearly asked.",
      provider: "optional — evolink (default). Topview/manual upload mode is staged but not yet invoked by this tool.",
      firstReferencePath:
        "optional — project-relative image/frame path or public URL to use for the first prompt.",
      durationSec:
        "optional — override duration for every prompt. Otherwise each prompt's duration is used, defaulting to 15s and clamped to 5-15s.",
      aspectRatio: "optional — 16:9 | 9:16 | 1:1 (default 16:9).",
      model: "optional — provider model slug. Settings mediaModels.video still wins when configured.",
      makeKeeper: "optional — true by default; marks each successful generated take as keeper.",
      stopOnFailure: "optional — true by default; false continues after failures and reports them.",
    },
    async run(args, ctx) {
      const promptIds = Array.isArray(args?.promptIds)
        ? args.promptIds.map((id) => String(id || "").trim()).filter(Boolean)
        : [];
      if (!promptIds.length) {
        throw new Error("render_prompt_sequence: promptIds must be an ordered non-empty array.");
      }
      if (promptIds.length > MAX_SEQUENCE_PROMPTS) {
        throw new Error(`render_prompt_sequence: refusing ${promptIds.length} prompts; max is ${MAX_SEQUENCE_PROMPTS}.`);
      }
      const provider = String(args?.provider || "evolink").trim().toLowerCase();
      if (provider && !provider.includes("evolink")) {
        throw new Error(
          "render_prompt_sequence: only EvoLink is wired for in-app blocking video generation today. Use stage_reference_media with mode:'upload' for Topview/manual handoff until a Topview adapter is added.",
        );
      }
      const normalizeDuration = (value, fallback) => {
        const n = Number(value);
        const base = Number.isFinite(n) && n > 0 ? n : fallback;
        return Math.max(5, Math.min(15, Math.round(base || 15)));
      };

      const makeKeeper = args?.makeKeeper !== false;
      const stopOnFailure = args?.stopOnFailure !== false;
      const aspectRatio = String(args?.aspectRatio || "16:9").trim() || "16:9";
      const model = typeof args?.model === "string" ? args.model : undefined;
      const rendered = [];
      const failures = [];
      let nextReferencePath = args?.firstReferencePath ? String(args.firstReferencePath).trim() : "";

      for (const promptId of promptIds) {
        try {
          let bundle = await runTool(
            "build_render_bundle",
            { promptId },
            { projectDir: ctx.projectDir, settings: ctx.settings },
          );
          if (bundle?.reason === "keyframe-not-extracted" && bundle?.prevTakeId) {
            await extractLastFrameForTake(bundle.prevTakeId, ctx);
            bundle = await runTool(
              "build_render_bundle",
              { promptId },
              { projectDir: ctx.projectDir, settings: ctx.settings },
            );
          }
          if (!bundle?.ok) {
            throw new Error(bundle?.error || `Could not build render bundle for ${promptId}.`);
          }
          if (!String(bundle.text || "").trim()) {
            throw new Error(
              `render_prompt_sequence: prompt ${promptId} has no prompt text. Write the prompt body before rendering.`,
            );
          }
          const referencePath = bundle.startFrame || nextReferencePath || "";
          const duration = normalizeDuration(args?.durationSec, bundle.duration || 15);
          const result = await runTool(
            "generate_video",
            {
              prompt: bundle.text || "",
              promptId,
              model,
              durationSec: duration,
              aspectRatio,
              imagePath: referencePath || undefined,
              note: referencePath ? `Sequence render. Reference: ${referencePath}` : "Sequence render.",
            },
            { projectDir: ctx.projectDir, settings: ctx.settings },
          );
          const saved = Array.isArray(result?.saved) ? result.saved : [];
          const take = saved.find((entry) => entry && entry.videoId) || null;
          if (!take?.videoId) {
            throw new Error(`generate_video completed for ${promptId}, but did not return a linked take id.`);
          }
          if (makeKeeper) {
            await runTool("set_keeper", { videoId: take.videoId }, { projectDir: ctx.projectDir, settings: ctx.settings });
          }
          const lastFrame = projectRelativePathExists(ctx.projectDir, take.frames?.last)
            ? take.frames.last
            : await extractLastFrameForTake(take.videoId, ctx);
          nextReferencePath = lastFrame;
          rendered.push({
            promptId,
            videoId: take.videoId,
            takeIndex: take.takeIndex || null,
            path: take.path,
            durationSec: duration,
            referencePath: referencePath || null,
            nextReferencePath,
            keeper: makeKeeper,
          });
        } catch (error) {
          const failure = {
            promptId,
            error: error?.message || String(error),
          };
          failures.push(failure);
          if (stopOnFailure) {
            return {
              ok: false,
              renderedCount: rendered.length,
              failure,
              rendered,
              failures,
            };
          }
        }
      }

      return {
        ok: failures.length === 0,
        renderedCount: rendered.length,
        failureCount: failures.length,
        rendered,
        failures,
        finalReferencePath: nextReferencePath || null,
      };
    },
  });

  // -----------------------------------------------------------------------
  // Take selection — set/clear which VideoEntry is the "keeper" for a
  // prompt. The keeper drives default timeline assembly. Today this was
  // UI-only via a Pick keeper button; surfacing it as an agent tool lets
  // chat workflows like "use take 3 for shot 02-04" work without manual
  // clicks.
  // -----------------------------------------------------------------------

  registerTool("set_keeper", {
    tier: "edit",
    description:
      "Mark a VideoEntry as the keeper for its prompt. Clears isKeeper on all other takes of the same prompt. Use this to pick which take of a prompt drives the default Timeline assembly.",
    args: { videoId: "required — VideoEntry id of the take to mark as keeper." },
    async run({ videoId }, ctx) {
      if (!videoId) throw new Error("set_keeper: videoId required.");
      const project = await readProjectMetadata(ctx.projectDir);
      if (!project) throw new Error("set_keeper: project.json not readable.");
      const videos = Array.isArray(project.videos) ? project.videos : [];
      const target = videos.find((v) => v && v.id === videoId);
      if (!target) {
        throw new Error(`set_keeper: no VideoEntry with id ${videoId}.`);
      }
      if (!target.promptId) {
        throw new Error(
          `set_keeper: video ${videoId} is an orphan (no promptId). Use reassign_orphan_video first.`,
        );
      }
      const promptId = target.promptId;
      const nextVideos = videos.map((v) => {
        if (!v || v.promptId !== promptId) return v;
        return { ...v, isKeeper: v.id === videoId };
      });
      await writeProjectMetadata(ctx.projectDir, {
        ...project,
        videos: nextVideos,
        project: {
          ...(project.project || {}),
          updatedAt: new Date().toISOString(),
        },
      });
      ctx.emitTimelineEvent?.({ kind: "keeper-changed", promptId, videoId });
      const siblingCount = videos.filter((v) => v && v.promptId === promptId).length;
      return {
        ok: true,
        videoId,
        promptId,
        siblingCount,
        clearedFrom: siblingCount - 1,
      };
    },
  });

  registerTool("clear_keeper", {
    tier: "edit",
    description:
      "Clear the keeper marker on every take of a prompt. After this, the default Timeline assembly falls back to latest take (highest takeIndex / most recent generation).",
    args: { promptId: "required — prompt id to clear keepers from." },
    async run({ promptId }, ctx) {
      if (!promptId) throw new Error("clear_keeper: promptId required.");
      const project = await readProjectMetadata(ctx.projectDir);
      if (!project) throw new Error("clear_keeper: project.json not readable.");
      const videos = Array.isArray(project.videos) ? project.videos : [];
      let cleared = 0;
      const nextVideos = videos.map((v) => {
        if (!v || v.promptId !== promptId) return v;
        if (v.isKeeper) cleared += 1;
        return { ...v, isKeeper: false };
      });
      if (cleared === 0) {
        return { ok: true, promptId, cleared: 0, note: "No keepers were set." };
      }
      await writeProjectMetadata(ctx.projectDir, {
        ...project,
        videos: nextVideos,
        project: {
          ...(project.project || {}),
          updatedAt: new Date().toISOString(),
        },
      });
      ctx.emitTimelineEvent?.({ kind: "keeper-changed", promptId, videoId: null });
      return { ok: true, promptId, cleared };
    },
  });

  // -----------------------------------------------------------------------
  // Orphan reassign — VideoEntry exists on disk but its promptId is null
  // (prompt deleted post-render or external upload landed without a
  // matching prompt). Today the only fix is the UI "Unlinked" drawer.
  // -----------------------------------------------------------------------

  registerTool("reassign_orphan_video", {
    tier: "edit",
    description:
      "Re-parent an orphan VideoEntry (promptId=null or pointing at a deleted prompt) to a live prompt. Updates the entry's promptId/sceneId/shotId from the target prompt's frontmatter. Does NOT move the file on disk — paths under assets/videos/<scene>/<shot>/<prompt>/ stay where they are; only the in-project metadata is reparented.",
    args: {
      videoId: "required — VideoEntry id to reassign.",
      promptId: "required — destination prompt id.",
    },
    async run({ videoId, promptId }, ctx) {
      if (!videoId) throw new Error("reassign_orphan_video: videoId required.");
      if (!promptId) throw new Error("reassign_orphan_video: promptId required.");
      const project = await readProjectMetadata(ctx.projectDir);
      if (!project) throw new Error("reassign_orphan_video: project.json not readable.");
      const videos = Array.isArray(project.videos) ? project.videos : [];
      const target = videos.find((v) => v && v.id === videoId);
      if (!target) {
        throw new Error(`reassign_orphan_video: no VideoEntry with id ${videoId}.`);
      }
      const prompts = Array.isArray(project.prompts) ? project.prompts : [];
      const newPrompt = prompts.find((p) => p && p.id === promptId);
      if (!newPrompt) {
        throw new Error(
          `reassign_orphan_video: prompt ${promptId} not found. Use list_prompts to find a valid id.`,
        );
      }
      const previousPromptId = target.promptId || null;
      const nextVideos = videos.map((v) =>
        v && v.id === videoId
          ? {
              ...v,
              promptId,
              shotId: newPrompt.shotId || v.shotId || null,
              sceneId: newPrompt.sceneId || v.sceneId || null,
              // Re-parenting clears keeper state — the agent / user picks
              // a fresh keeper for the destination prompt's take pool.
              isKeeper: false,
            }
          : v,
      );
      await writeProjectMetadata(ctx.projectDir, {
        ...project,
        videos: nextVideos,
        project: {
          ...(project.project || {}),
          updatedAt: new Date().toISOString(),
        },
      });
      ctx.emitTimelineEvent?.({ kind: "video-reassigned", videoId, promptId });
      return {
        ok: true,
        videoId,
        previousPromptId,
        nextPromptId: promptId,
        sceneId: newPrompt.sceneId || null,
        shotId: newPrompt.shotId || null,
      };
    },
  });

  // -----------------------------------------------------------------------
  // Take query — agents reach for "list takes for prompt X" or "find
  // orphans" repeatedly. Surfacing as a first-class tool is much cheaper
  // than re-deriving from list_videos (which doesn't filter).
  // -----------------------------------------------------------------------

  registerTool("query_takes", {
    tier: "domain",
    description:
      "Filter the project's VideoEntry list by common predicates. All filters are optional; combine them as needed. Returns ordered takes with the metadata needed to set keepers, reassign orphans, or trim downstream.",
    args: {
      promptId: "optional — only takes of this prompt.",
      sceneId: "optional — only takes whose prompt is in this scene.",
      shotId: "optional — only takes whose prompt is in this shot.",
      isKeeper: "optional — true | false. Filters by keeper marker.",
      orphan: "optional — true to list orphans only (promptId null or pointing at a deleted prompt).",
      generator: "optional — string. Matches the take's generator field.",
    },
    async run(args, ctx) {
      const project = await readProjectMetadata(ctx.projectDir);
      if (!project) throw new Error("query_takes: project.json not readable.");
      const videos = Array.isArray(project.videos) ? project.videos : [];
      const prompts = Array.isArray(project.prompts) ? project.prompts : [];
      const promptIds = new Set(prompts.map((p) => p?.id).filter(Boolean));
      const { promptById, promptOrderById, sceneById } = buildStoryOrderLookups(project);
      const filtered = videos.filter((v) => {
        if (!v) return false;
        if (args?.promptId && v.promptId !== args.promptId) return false;
        if (args?.sceneId) {
          const targetScene = sceneById.get(args.sceneId);
          const prompt = v.promptId ? promptById.get(v.promptId) : null;
          if (v.sceneId !== args.sceneId && (!targetScene || !prompt || !promptBelongsToScene(prompt, targetScene))) {
            return false;
          }
        }
        if (args?.shotId && v.shotId !== args.shotId) return false;
        if (typeof args?.isKeeper === "boolean" && Boolean(v.isKeeper) !== args.isKeeper) {
          return false;
        }
        if (args?.orphan === true) {
          if (v.promptId && promptIds.has(v.promptId)) return false;
        }
        if (args?.generator && v.generator !== args.generator) return false;
        return true;
      });
      filtered.sort(
        (a, b) => {
          const promptA = a.promptId ? promptOrderById.get(a.promptId) : null;
          const promptB = b.promptId ? promptOrderById.get(b.promptId) : null;
          const knownA = Number.isFinite(promptA);
          const knownB = Number.isFinite(promptB);
          if (knownA && knownB && promptA !== promptB) return promptA - promptB;
          if (knownA !== knownB) return knownA ? -1 : 1;
          return (
            (Number(a.takeIndex) || 0) - (Number(b.takeIndex) || 0) ||
            String(a.generatedAt || "").localeCompare(String(b.generatedAt || "")) ||
            String(a.path || "").localeCompare(String(b.path || ""))
          );
        },
      );
      return {
        ok: true,
        count: filtered.length,
        takes: filtered.map((v) => ({
          id: v.id,
          promptId: v.promptId || null,
          sceneId: v.sceneId || null,
          shotId: v.shotId || null,
          path: v.path,
          takeIndex: v.takeIndex || null,
          durationSec: v.durationSec ?? null,
          generator: v.generator || null,
          generatedAt: v.generatedAt || null,
          isKeeper: Boolean(v.isKeeper),
          isOrphan: !v.promptId || !promptIds.has(v.promptId),
          trimInSec: v.trimInSec ?? null,
          trimOutSec: v.trimOutSec ?? null,
          note: v.note || null,
        })),
      };
    },
  });
};
