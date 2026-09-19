// Timeline agent tools — build, tighten, and export.
//
// Kept as read-or-mutate single shots: each tool either composes a
// derived answer (build_timeline, export_timeline) or mutates
// project.timeline via the existing save pipeline (tighten_scene). No
// new persistence mechanism.

const path = require("node:path");
const fs = require("node:fs/promises");
const { existsSync } = require("node:fs");
const { execFile } = require("node:child_process");
const {
  normalizeRelativePath,
  sortPromptEntriesByStoryOrder,
  sortSceneEntriesByScriptOrder,
} = require("../../scene-order.cjs");

// Resolve ffprobe by walking common Homebrew paths. Mirrors the lookup
// inside understanding.cjs but kept local so timeline-tools doesn't pull
// the larger module in. Lookup result is memoized per process.
let cachedFfprobe;
function resolveFfprobe() {
  if (cachedFfprobe !== undefined) return cachedFfprobe;
  const candidates = [
    process.env.FFPROBE_BIN,
    "/opt/homebrew/bin/ffprobe",
    "/usr/local/bin/ffprobe",
    "/usr/bin/ffprobe",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cachedFfprobe = candidate;
      return cachedFfprobe;
    }
  }
  cachedFfprobe = null;
  return cachedFfprobe;
}

// Probe a media file's duration in seconds. Returns null on probe
// failure rather than throwing — the caller decides whether to clamp,
// warn, or proceed without duration. Used by clip-add paths to keep
// `outSec` from exceeding the source duration (which ffmpeg would
// silently truncate at export time, often surprising users).
async function probeMediaDurationSec(absolutePath) {
  if (!absolutePath || !existsSync(absolutePath)) return null;
  const ffprobe = resolveFfprobe();
  if (!ffprobe) return null;
  return new Promise((resolve) => {
    execFile(
      ffprobe,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        absolutePath,
      ],
      { timeout: 10_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const num = Number(String(stdout || "").trim());
        resolve(Number.isFinite(num) && num > 0 ? num : null);
      },
    );
  });
}

module.exports = function registerTimelineTools(api) {
  const { registerTool, readProjectMetadata, writeProjectMetadata } = api;

  // Project-state I/O routes through the shared readProjectMetadata +
  // writeProjectMetadata helpers so tighten_scene serializes against other
  // writers via withWriteLock(`project:${projectDir}`) and gets atomic
  // write + .bak rotation. Pre-2026-04-21 this file had a local
  // writeProjectJson doing direct fs.writeFile, which reintroduced the
  // asset-C1 race (Promise.all dispatch in agent-loop.cjs would race
  // tighten_scene against any concurrent write tool).

  function roundTimelineSec(value) {
    return Math.round(Number(value || 0) * 100) / 100;
  }

  function normalizedTimelineTrimIn(value) {
    const next = Number(value);
    return Number.isFinite(next) && next > 0.01 ? roundTimelineSec(next) : null;
  }

  function normalizedTimelineTrimOut(value, fullDurationSec) {
    const next = Number(value);
    if (!Number.isFinite(next) || next <= 0) return null;
    const capped = fullDurationSec > 0 ? Math.min(next, fullDurationSec) : next;
    if (fullDurationSec > 0 && capped >= fullDurationSec - 0.05) return null;
    return roundTimelineSec(capped);
  }

  function stemFromRelativePath(value) {
    const normalized = normalizeRelativePath(value);
    return path.posix.basename(normalized, path.posix.extname(normalized));
  }

  function promptFolderSlug(prompt) {
    const parts = normalizeRelativePath(prompt?.path).split("/");
    return parts[0] === "prompts" && parts.length > 2 ? parts[1] || "" : "";
  }

  function promptBelongsToScene(prompt, scene, shotById) {
    if (prompt?.sceneId) return prompt.sceneId === scene?.id;
    const promptScenePath = normalizeRelativePath(prompt?.scenePath);
    const scenePath = normalizeRelativePath(scene?.path);
    if (promptScenePath && scenePath && promptScenePath === scenePath) return true;
    const folder = promptFolderSlug(prompt);
    if (folder && scenePath && folder === stemFromRelativePath(scenePath)) return true;
    const shot = prompt?.shotId ? shotById.get(prompt.shotId) : null;
    return Boolean(shot?.sceneId && shot.sceneId === scene?.id);
  }

  function buildPersistedTimelineFromClips(clips) {
    return clips.map((clip, orderIndex) => {
      const fullDurationSec = Math.max(
        0,
        Number(clip.video?.durationSec) || Number(clip.durationSec) || 0,
      );
      return {
        id: clip.persistedId || `tl-${clip.promptId}`,
        promptId: clip.promptId,
        videoId: clip.video?.id || null,
        inSec: clip.video ? normalizedTimelineTrimIn(clip.trimInSec) : null,
        outSec: clip.video ? normalizedTimelineTrimOut(clip.trimOutSec, fullDurationSec) : null,
        enabled: clip.enabled !== false,
        orderIndex,
      };
    });
  }

  // Pick the keeper take for a prompt. Resolution order:
  //   1. Take flagged isKeeper=true wins (user/agent explicit choice).
  //   2. Otherwise, walk the prompt's renders[] (generation order) and
  //      pick the LAST id that still resolves to a live take. This honors
  //      what the agent actually emitted last for this prompt.
  //   3. Fallback: the latest existing take by takeIndex DESC, then
  //      generatedAt DESC. (Was ascending — that meant "default = oldest"
  //      which is almost never what the user wants.)
  function pickKeeperTake(prompt, videos) {
    const takes = videos.filter((v) => v && v.promptId === prompt.id);
    if (takes.length === 0) return null;
    const explicit = takes.find((v) => v.isKeeper);
    if (explicit) return explicit;
    const renders = Array.isArray(prompt.renders) ? prompt.renders : [];
    if (renders.length) {
      const liveById = new Map(takes.map((v) => [v.id, v]));
      for (let i = renders.length - 1; i >= 0; i -= 1) {
        const take = liveById.get(renders[i]);
        if (take) return take;
      }
    }
    return takes
      .slice()
      .sort(
        (a, b) =>
          (b.takeIndex || 0) - (a.takeIndex || 0) ||
          String(b.generatedAt || "").localeCompare(String(a.generatedAt || "")),
      )[0] || null;
  }

  // Walk scene → prompt → keeper take in script order and return
  // the ordered clip list the Timeline UI consumes.
  function buildDefaultTimeline(project) {
    const videos = Array.isArray(project.videos) ? project.videos : [];
    const shots = Array.isArray(project.shots) ? project.shots : [];
    const prompts = Array.isArray(project.prompts) ? project.prompts : [];
    const masters = Array.isArray(project.script)
      ? project.script.filter((e) => e && e.kind === "master")
      : [];
    const scenes = sortSceneEntriesByScriptOrder(
      Array.isArray(project.script)
        ? project.script.filter((e) => e && e.kind === "scene")
        : [],
      masters,
    );
    const shotById = new Map(shots.filter((shot) => shot?.id).map((shot) => [shot.id, shot]));
    const clips = [];
    for (const scene of scenes) {
      const scenePrompts = sortPromptEntriesByStoryOrder(
        prompts.filter((prompt) => promptBelongsToScene(prompt, scene, shotById)),
        { scenes: [scene] },
      );
      for (const prompt of scenePrompts) {
        const keeper = pickKeeperTake(prompt, videos);
        const shot = prompt.shotId ? shotById.get(prompt.shotId) : null;
        clips.push({
          key: `auto:${prompt.id}`,
          persistedId: null,
          sceneId: scene.id,
          sceneTitle: scene.title || "Scene",
          shotId: prompt.shotId || null,
          shotTitle: shot?.title || "Scene prompt",
          promptId: prompt.id,
          promptTitle: prompt.title || "Prompt",
          video: keeper,
          durationSec:
            Number(keeper?.durationSec) || Number(prompt.durationSec) || 0,
          trimInSec:
            Number.isFinite(Number(keeper?.trimInSec)) && Number(keeper?.trimInSec) > 0
              ? Number(keeper.trimInSec)
              : null,
          trimOutSec:
            Number.isFinite(Number(keeper?.trimOutSec)) && Number(keeper?.trimOutSec) > 0
              ? Number(keeper.trimOutSec)
              : null,
          enabled: true,
        });
      }
    }
    return clips;
  }

  // Mirror the renderer's "current timeline" semantics:
  // - default = script order (scene → shot → prompt → keeper take)
  // - if project.timeline has persisted order, honor that ordering
  // - if a persisted clip points at a specific videoId, prefer it over the
  //   current keeper when it still belongs to the same prompt
  // - append new prompts not yet present in project.timeline so fresh work
  //   never disappears from tool output
  function resolveTimelineClips(project) {
    const autoClips = buildDefaultTimeline(project);
    const persistedOrder = (Array.isArray(project.timeline) ? project.timeline : [])
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => {
        const orderA = Number(a.entry?.orderIndex);
        const orderB = Number(b.entry?.orderIndex);
        const safeA = Number.isFinite(orderA) ? orderA : a.index;
        const safeB = Number.isFinite(orderB) ? orderB : b.index;
        return safeA - safeB || a.index - b.index;
      })
      .map(({ entry }) => entry);
    if (persistedOrder.length === 0) return autoClips;

    const videos = Array.isArray(project.videos) ? project.videos : [];
    const explicitVideoById = new Map(videos.map((v) => [v.id, v]));
    const autoByPrompt = new Map(autoClips.map((c) => [c.promptId, c]));
    const usedPromptIds = new Set();
    const ordered = [];

    for (let index = 0; index < persistedOrder.length; index += 1) {
      const entry = persistedOrder[index];
      if (!entry?.promptId) continue;
      const auto = autoByPrompt.get(entry.promptId);
      if (!auto) continue;
      const nextClip = { ...auto };
      const persistedId =
        typeof entry.id === "string" && entry.id.trim()
          ? entry.id.trim()
          : `tl-${entry.promptId}-${index + 1}`;
      nextClip.key = persistedId;
      nextClip.persistedId = persistedId;
      if (entry.videoId) {
        const explicitVideo = explicitVideoById.get(entry.videoId);
        if (explicitVideo && explicitVideo.promptId === auto.promptId) {
          nextClip.video = explicitVideo;
          nextClip.durationSec =
            Number(explicitVideo.durationSec) || Number(nextClip.durationSec) || 0;
        }
      }
      const trimInSource =
        entry.inSec ??
        (nextClip.video?.id === auto.video?.id ? auto.trimInSec : nextClip.video?.trimInSec);
      const trimOutSource =
        entry.outSec ??
        (nextClip.video?.id === auto.video?.id ? auto.trimOutSec : nextClip.video?.trimOutSec);
      nextClip.trimInSec =
        Number.isFinite(Number(trimInSource)) && Number(trimInSource) > 0
          ? Number(trimInSource)
          : null;
      nextClip.trimOutSec =
        Number.isFinite(Number(trimOutSource)) && Number(trimOutSource) > 0
          ? Number(trimOutSource)
          : null;
      nextClip.enabled = entry.enabled !== false;
      ordered.push(nextClip);
      usedPromptIds.add(entry.promptId);
    }

    for (const clip of autoClips) {
      if (!usedPromptIds.has(clip.promptId)) ordered.push(clip);
    }

    return ordered;
  }

  function playableDurationSec(clip) {
    if (clip.enabled === false || !clip.video) return 0;
    const fullDur = Math.max(
      0,
      Number(clip.video?.durationSec) || Number(clip.durationSec) || 0,
    );
    const rawIn = Number(clip.trimInSec);
    const rawOut = Number(clip.trimOutSec);
    const trimIn = Number.isFinite(rawIn) && rawIn > 0 ? rawIn : 0;
    const trimOut = Number.isFinite(rawOut) && rawOut > 0 ? rawOut : fullDur;
    const cappedOut = fullDur > 0 ? Math.min(trimOut, fullDur) : trimOut;
    const cappedIn = fullDur > 0 ? Math.min(trimIn, cappedOut) : trimIn;
    return Math.max(0, cappedOut - cappedIn);
  }

  registerTool("build_timeline", {
    tier: "meta",
    description:
      "Return the current Timeline assembly for the project. If the user has manually reordered the timeline, that persisted order wins; otherwise the assembly falls back to script order (scene → shot → prompt → keeper take). Read-only: does not mutate project.timeline.",
    args: {
      sceneId: "optional — scope to a single scene (defaults to whole project).",
    },
    async run({ sceneId }, ctx) {
      const project = await readProjectMetadata(ctx.projectDir);
      if (!project) throw new Error("build_timeline: project.json not readable.");
      let clips = resolveTimelineClips(project);
      if (sceneId) {
        clips = clips.filter((c) => c.sceneId === sceneId);
        if (clips.length === 0) {
          throw new Error(
            `build_timeline: no clips for sceneId=${sceneId}. Check list_scenes.`,
          );
        }
      }
      const totalSec = clips.reduce((t, c) => t + playableDurationSec(c), 0);
      const renderedCount = clips.filter((c) => c.video).length;
      return {
        ok: true,
        clipCount: clips.length,
        renderedCount,
        totalDurationSec: totalSec,
        clips: clips.map((c) => ({
          id: c.persistedId || c.key || c.promptId,
          sceneId: c.sceneId,
          sceneTitle: c.sceneTitle,
          shotId: c.shotId,
          shotTitle: c.shotTitle,
          promptId: c.promptId,
          promptTitle: c.promptTitle,
          enabled: c.enabled !== false,
          videoId: c.video?.id || null,
          videoPath: c.video?.path || null,
          takeIndex: c.video?.takeIndex || null,
          durationSec: c.durationSec,
          playableDurationSec: playableDurationSec(c),
          trimInSec: c.trimInSec ?? null,
          trimOutSec: c.trimOutSec ?? null,
        })),
      };
    },
  });

  registerTool("tighten_scene", {
    tier: "edit",
    description:
      "Fit a scene's rendered takes into a target runtime by setting proportional trimInSec / trimOutSec on each take. Preserves aspect of each clip's contribution — a scene currently at 45s tightened to 30s shrinks every clip to 2/3 of its current playable length. Writes trim state to project.json and returns the applied plan. Useful when the user says 'tighten scene 2 to 30 seconds'.",
    args: {
      sceneId: "required — the scene to tighten.",
      targetSec: "required — target total runtime in seconds (>= 1).",
    },
    async run({ sceneId, targetSec }, ctx) {
      if (!sceneId) throw new Error("tighten_scene: sceneId required.");
      const target = Number(targetSec);
      if (!Number.isFinite(target) || target < 1) {
        throw new Error("tighten_scene: targetSec must be >= 1.");
      }
      const project = await readProjectMetadata(ctx.projectDir);
      if (!project) throw new Error("tighten_scene: project.json not readable.");

      const resolvedClips = resolveTimelineClips(project);
      const clips = resolvedClips.filter(
        (c) => c.sceneId === sceneId && c.video && c.enabled !== false,
      );
      if (clips.length === 0) {
        throw new Error(
          `tighten_scene: sceneId=${sceneId} has no active rendered takes to tighten.`,
        );
      }

      // Current playable length per clip (honoring existing trim) + total.
      const currentLengths = clips.map((c) => playableDurationSec(c));
      const currentTotal = currentLengths.reduce((t, l) => t + l, 0);
      if (currentTotal <= 0) {
        throw new Error("tighten_scene: clips have zero total duration to tighten.");
      }

      const ratio = target / currentTotal;
      const plan = clips.map((c, idx) => {
        const v = c.video;
        const fullDur = Number(v.durationSec) || currentLengths[idx];
        const newLen = Math.max(0.5, currentLengths[idx] * ratio); // floor at 0.5s
        const currentIn =
          Number.isFinite(Number(c.trimInSec)) && Number(c.trimInSec) > 0
            ? Number(c.trimInSec)
            : 0;
        const currentOut =
          Number.isFinite(Number(c.trimOutSec)) && Number(c.trimOutSec) > 0
            ? Number(c.trimOutSec)
            : fullDur;
        // Center the trim: shrink from both ends equally so the "money
        // shot" in the middle of each clip is preserved more often than
        // not. Clamp to the existing trim window.
        const trimAmount = Math.max(0, (currentOut - currentIn) - newLen);
        const inSec = Math.min(
          fullDur - newLen,
          currentIn + trimAmount / 2,
        );
        const outSec = Math.max(inSec + newLen, currentOut - trimAmount / 2);
        return {
          clipId: c.persistedId || c.key || c.promptId,
          videoId: v.id,
          shotTitle: c.shotTitle,
          prevInSec: currentIn,
          prevOutSec: currentOut,
          nextInSec: roundTimelineSec(inSec),
          nextOutSec: roundTimelineSec(outSec),
        };
      });

      // Apply to project.timeline and persist. This keeps scene-tightening
      // compatible with split clips, omitted clips, and any custom per-clip
      // window that differs from the underlying source take.
      const planByClipId = new Map(plan.map((step) => [step.clipId, step]));
      const nextClips = resolvedClips.map((clip) => {
        const clipId = clip.persistedId || clip.key || clip.promptId;
        const step = planByClipId.get(clipId);
        if (!step) return clip;
        const fullDur = Math.max(
          0,
          Number(clip.video?.durationSec) || Number(clip.durationSec) || 0,
        );
        return {
          ...clip,
          trimInSec: normalizedTimelineTrimIn(step.nextInSec),
          trimOutSec: normalizedTimelineTrimOut(step.nextOutSec, fullDur),
        };
      });
      await writeProjectMetadata(ctx.projectDir, {
        ...project,
        project: { ...(project.project || {}), updatedAt: new Date().toISOString() },
        timeline: buildPersistedTimelineFromClips(nextClips),
      });
      // Each tighten step emits a clip-trimmed event so the NLE animates
      // the scene's clips reshaping into the target runtime.
      for (const step of plan) {
        ctx.emitTimelineEvent?.({
          kind: "clip-trimmed",
          clipId: step.clipId,
          inSec: step.nextInSec ?? null,
          outSec: step.nextOutSec ?? null,
        });
      }

      return {
        ok: true,
        sceneId,
        targetSec: target,
        previousTotalSec: Math.round(currentTotal * 100) / 100,
        appliedRatio: Math.round(ratio * 1000) / 1000,
        plan,
      };
    },
  });

  registerTool("export_timeline", {
    tier: "meta",
    description:
      "Render the current Timeline assembly to a single .mp4 via ffmpeg concat. Honors each clip's trimInSec / trimOutSec. Output lands at assets/exports/timeline-<ISO>.mp4 inside the project. Optional filters scope the export without forcing the user to toggle clips off — useful for partial cuts ('export scenes 1–3', 'export only takes ≥ 2').",
    args: {
      sceneIds:
        "optional — array of scene ids to include. Excludes clips whose sceneId is not in the list. Empty/absent = include all scenes.",
      takeMin:
        "optional — minimum takeIndex to include (e.g. 2 to skip first-take rough cuts). Clips without a takeIndex are excluded when this filter is set.",
      includeDisabled:
        "optional — boolean. When true, includes clips with enabled=false. Default false (matches the UI Export button).",
      filenameHint:
        "optional — short string suffix appended to the output filename for human grouping (e.g. 'scenes-1-3').",
    },
    async run(args, ctx) {
      const project = await readProjectMetadata(ctx.projectDir);
      if (!project) throw new Error("export_timeline: project.json not readable.");

      const sceneIdFilter = Array.isArray(args?.sceneIds) && args.sceneIds.length
        ? new Set(args.sceneIds)
        : null;
      const takeMinFilter = Number.isFinite(Number(args?.takeMin))
        ? Number(args.takeMin)
        : null;
      const includeDisabled = args?.includeDisabled === true;

      let clips = resolveTimelineClips(project).filter((c) => c.video && c.video.path);
      if (!includeDisabled) clips = clips.filter((c) => c.enabled !== false);
      if (sceneIdFilter) clips = clips.filter((c) => sceneIdFilter.has(c.sceneId));
      if (takeMinFilter !== null) {
        clips = clips.filter(
          (c) => Number.isFinite(c.video?.takeIndex) && (c.video.takeIndex || 0) >= takeMinFilter,
        );
      }
      if (clips.length === 0) {
        throw new Error(
          "export_timeline: no clips match the filters. " +
            (sceneIdFilter || takeMinFilter !== null
              ? "Loosen sceneIds / takeMin or render the missing takes."
              : "Render at least one take before exporting."),
        );
      }

      const { resolveFfmpeg } = require("../../frames.cjs");
      const ffmpegBin = resolveFfmpeg();

      const outDir = path.join(ctx.projectDir, "assets", "exports");
      await fs.mkdir(outDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const hintSlug = typeof args?.filenameHint === "string" && args.filenameHint.trim()
        ? `-${args.filenameHint.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32)}`
        : "";
      const outPath = path.join(outDir, `timeline-${stamp}${hintSlug}.mp4`);

      const inputs = [];
      const filterParts = [];
      const labels = [];
      for (let i = 0; i < clips.length; i += 1) {
        const v = clips[i].video;
        const abs = path.isAbsolute(v.path) ? v.path : path.join(ctx.projectDir, v.path);
        if (!existsSync(abs)) {
          throw new Error(`export_timeline: file not on disk: ${abs}`);
        }
        inputs.push("-i", abs);
        let trim = `[${i}:v]`;
        const parts = [];
        if (Number.isFinite(Number(clips[i].trimInSec)) && Number(clips[i].trimInSec) > 0) {
          parts.push(`start=${Number(clips[i].trimInSec)}`);
        }
        if (Number.isFinite(Number(clips[i].trimOutSec)) && Number(clips[i].trimOutSec) > 0) {
          parts.push(`end=${Number(clips[i].trimOutSec)}`);
        }
        if (parts.length) trim += `trim=${parts.join(":")},`;
        trim += `setpts=PTS-STARTPTS[v${i}]`;
        filterParts.push(trim);
        labels.push(`[v${i}]`);
      }
      const concat = `${labels.join("")}concat=n=${clips.length}:v=1:a=0[out]`;
      const filterComplex = [...filterParts, concat].join(";");

      const ffmpegArgs = [
        "-y",
        ...inputs,
        "-filter_complex",
        filterComplex,
        "-map",
        "[out]",
        "-pix_fmt",
        "yuv420p",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "18",
        outPath,
      ];
      const result = await new Promise((resolve) => {
        execFile(
          ffmpegBin,
          ffmpegArgs,
          { timeout: 5 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 },
          (err, _stdout, stderr) => {
            if (err) {
              resolve({
                ok: false,
                error: err.message || String(err),
                stderr: String(stderr || "").slice(-1500),
              });
              return;
            }
            resolve({ ok: true });
          },
        );
      });
      if (!result.ok) {
        throw new Error(`export_timeline: ffmpeg failed — ${result.error}\n${result.stderr || ""}`);
      }
      return {
        ok: true,
        path: path.posix.join("assets", "exports", path.basename(outPath)),
        absolutePath: outPath,
        clipCount: clips.length,
      };
    },
  });

  // ===========================================================================
  // Workshop NLE mutation tools — agent drives the multi-track timeline.
  // Backwards-compatible with single-track legacy clips (no `track` field).
  // ===========================================================================

  const ALLOWED_TRACKS = new Set(["V1", "V2", "A1", "A2"]);

  function newClipId() {
    return `clip-${Math.random().toString(36).slice(2, 10)}`;
  }

  function findVideoById(project, videoId) {
    if (!videoId) return null;
    const videos = Array.isArray(project.videos) ? project.videos : [];
    return videos.find((v) => v.id === videoId) || null;
  }

  function findAudioMediaByPath(project, mediaPath) {
    if (!mediaPath) return null;
    const audio = Array.isArray(project.audio) ? project.audio : [];
    for (const asset of audio) {
      for (const media of asset.media || []) {
        if (media && media.path === mediaPath) return { asset, media };
      }
    }
    return null;
  }

  function ensureTimelineArray(project) {
    return Array.isArray(project.timeline) ? project.timeline.slice() : [];
  }

  function persistClips(clips) {
    return clips
      .slice()
      .sort((a, b) => {
        const ta = a.track || "V1";
        const tb = b.track || "V1";
        if (ta !== tb) {
          const order = ["V1", "V2", "A1", "A2"];
          return order.indexOf(ta) - order.indexOf(tb);
        }
        const sa = Number(a.startSec);
        const sb = Number(b.startSec);
        if (Number.isFinite(sa) && Number.isFinite(sb) && sa !== sb) return sa - sb;
        return (a.orderIndex || 0) - (b.orderIndex || 0);
      })
      .map((clip, orderIndex) => ({ ...clip, orderIndex }));
  }

  registerTool("timeline_add_clip", {
    tier: "edit",
    description:
      "Append or insert a clip on a Workshop NLE track. Either videoId (for a rendered take) or mediaPath (for an audio asset) must be provided. The clip lands at startSec when given; otherwise it's appended after the last clip on the chosen track.",
    args: {
      track: "required — V1, V2, A1, or A2.",
      videoId: "optional — VideoEntry id when adding a rendered take.",
      mediaPath: "optional — project-relative audio file path (assets/audio/...).",
      startSec: "optional — explicit timeline position; defaults to end of track.",
      inSec: "optional — trim in-point in source seconds.",
      outSec: "optional — trim out-point in source seconds.",
      label: "optional — display label override.",
    },
    async run({ track, videoId, mediaPath, startSec, inSec, outSec, label }, ctx) {
      if (!ALLOWED_TRACKS.has(track)) {
        throw new Error("timeline_add_clip: track must be V1, V2, A1, or A2.");
      }
      if (!videoId && !mediaPath) {
        throw new Error("timeline_add_clip: provide videoId or mediaPath.");
      }
      const isVideoTrack = track === "V1" || track === "V2";
      const isAudioTrack = track === "A1" || track === "A2";
      if (videoId && !isVideoTrack) {
        throw new Error("timeline_add_clip: videoId only allowed on V1 / V2.");
      }
      if (mediaPath && !isAudioTrack) {
        throw new Error("timeline_add_clip: mediaPath only allowed on A1 / A2.");
      }
      const project = await readProjectMetadata(ctx.projectDir);
      if (!project) throw new Error("timeline_add_clip: project.json not readable.");
      const video = videoId ? findVideoById(project, videoId) : null;
      if (videoId && !video) {
        throw new Error(`timeline_add_clip: VideoEntry ${videoId} not found.`);
      }
      let probedDurationSec = null;
      if (mediaPath) {
        const hit = findAudioMediaByPath(project, mediaPath);
        if (!hit) {
          throw new Error(`timeline_add_clip: audio path ${mediaPath} not in project audio library.`);
        }
        // Probe the source duration so an out-of-range outSec gets clamped
        // before persistence. Without this, ffmpeg silently truncates at
        // export time and the user sees clips drop short with no warning.
        const absPath = path.isAbsolute(mediaPath)
          ? mediaPath
          : path.join(ctx.projectDir, mediaPath);
        probedDurationSec = await probeMediaDurationSec(absPath);
      }
      const existing = ensureTimelineArray(project);
      let resolvedStart = Number(startSec);
      if (!Number.isFinite(resolvedStart) || resolvedStart < 0) {
        let tail = 0;
        for (const c of existing) {
          if ((c.track || "V1") !== track) continue;
          const start = Number(c.startSec) || 0;
          const dur = Math.max(
            0.2,
            (Number(c.outSec) > 0 ? Number(c.outSec) : Number(video?.durationSec) || 4) -
              (Number(c.inSec) > 0 ? Number(c.inSec) : 0),
          );
          if (start + dur > tail) tail = start + dur;
        }
        resolvedStart = roundTimelineSec(tail);
      } else {
        resolvedStart = roundTimelineSec(resolvedStart);
      }
      // Resolve source duration once. For agent-added audio, default the
      // trim out-point to the full source so music/VO does not collapse to
      // the renderer's short placeholder duration.
      const sourceDurationSec = mediaPath
        ? probedDurationSec
        : Number(video?.durationSec) > 0
          ? Number(video.durationSec)
          : null;
      let resolvedOutSec =
        Number.isFinite(Number(outSec)) && Number(outSec) > 0
          ? roundTimelineSec(Number(outSec))
          : null;
      let outSecDefaulted = false;
      if (mediaPath && resolvedOutSec === null && sourceDurationSec) {
        resolvedOutSec = roundTimelineSec(sourceDurationSec);
        outSecDefaulted = true;
      }
      let outSecClamped = false;
      if (resolvedOutSec !== null && sourceDurationSec && resolvedOutSec > sourceDurationSec) {
        resolvedOutSec = roundTimelineSec(sourceDurationSec);
        outSecClamped = true;
        outSecDefaulted = false;
      }
      const clip = {
        id: newClipId(),
        promptId: video?.promptId || null,
        videoId: videoId || null,
        mediaPath: mediaPath || null,
        track,
        startSec: resolvedStart,
        inSec: Number.isFinite(Number(inSec)) && Number(inSec) > 0 ? roundTimelineSec(Number(inSec)) : null,
        outSec: resolvedOutSec,
        enabled: true,
        volume: null,
        fadeInSec: null,
        fadeOutSec: null,
        label: label || null,
        orderIndex: existing.length,
      };
      const next = persistClips([...existing, clip]);
      await writeProjectMetadata(ctx.projectDir, {
        ...project,
        project: { ...(project.project || {}), updatedAt: new Date().toISOString() },
        timeline: next,
      });
      ctx.emitTimelineEvent?.({
        kind: "clip-added",
        clipId: clip.id,
        track,
        startSec: resolvedStart,
        videoId: clip.videoId,
        mediaPath: clip.mediaPath,
      });
      return {
        ok: true,
        clipId: clip.id,
        track,
        startSec: resolvedStart,
        outSec: resolvedOutSec,
        sourceDurationSec: sourceDurationSec ?? null,
        outSecDefaulted,
        outSecClamped,
        ...(outSecClamped
          ? {
              warning: `outSec exceeded source duration; clamped to ${resolvedOutSec}s.`,
            }
          : {}),
      };
    },
  });

  registerTool("timeline_remove_clip", {
    tier: "edit",
    description:
      "Remove a clip from the Workshop NLE timeline by id. Use list_timeline (or build_timeline for the legacy assembly view) to discover clip ids.",
    args: { clipId: "required — clip id to remove." },
    async run({ clipId }, ctx) {
      if (!clipId) throw new Error("timeline_remove_clip: clipId required.");
      const project = await readProjectMetadata(ctx.projectDir);
      if (!project) throw new Error("timeline_remove_clip: project.json not readable.");
      const existing = ensureTimelineArray(project);
      const next = persistClips(existing.filter((c) => c.id !== clipId));
      if (next.length === existing.length) {
        throw new Error(`timeline_remove_clip: no clip with id ${clipId}.`);
      }
      await writeProjectMetadata(ctx.projectDir, {
        ...project,
        project: { ...(project.project || {}), updatedAt: new Date().toISOString() },
        timeline: next,
      });
      ctx.emitTimelineEvent?.({ kind: "clip-removed", clipId });
      return { ok: true, removed: clipId };
    },
  });

  registerTool("timeline_move_clip", {
    tier: "edit",
    description:
      "Move an existing clip to a different track and/or new startSec position.",
    args: {
      clipId: "required — clip id.",
      track: "optional — V1, V2, A1, or A2 (must match clip kind).",
      startSec: "optional — new timeline position in seconds.",
    },
    async run({ clipId, track, startSec }, ctx) {
      if (!clipId) throw new Error("timeline_move_clip: clipId required.");
      const project = await readProjectMetadata(ctx.projectDir);
      if (!project) throw new Error("timeline_move_clip: project.json not readable.");
      const existing = ensureTimelineArray(project);
      const idx = existing.findIndex((c) => c.id === clipId);
      if (idx < 0) throw new Error(`timeline_move_clip: no clip with id ${clipId}.`);
      const clip = existing[idx];
      const isAudioClip = !!clip.mediaPath && !clip.videoId;
      const nextTrack = track && ALLOWED_TRACKS.has(track) ? track : clip.track || "V1";
      const isAudioTrack = nextTrack === "A1" || nextTrack === "A2";
      if (isAudioClip && !isAudioTrack) {
        throw new Error("timeline_move_clip: audio clips must stay on A1 / A2.");
      }
      if (!isAudioClip && isAudioTrack) {
        throw new Error("timeline_move_clip: video clips must stay on V1 / V2.");
      }
      const nextStart = Number.isFinite(Number(startSec)) && Number(startSec) >= 0
        ? roundTimelineSec(Number(startSec))
        : Number(clip.startSec) || 0;
      existing[idx] = { ...clip, track: nextTrack, startSec: nextStart };
      await writeProjectMetadata(ctx.projectDir, {
        ...project,
        project: { ...(project.project || {}), updatedAt: new Date().toISOString() },
        timeline: persistClips(existing),
      });
      ctx.emitTimelineEvent?.({
        kind: "clip-moved",
        clipId,
        track: nextTrack,
        startSec: nextStart,
      });
      return { ok: true, clipId, track: nextTrack, startSec: nextStart };
    },
  });

  registerTool("timeline_split_clip", {
    tier: "edit",
    description:
      "Split a clip in two at the given timeline second. Both halves remain on the same track, share trim window math, and the right half gets a new id.",
    args: {
      clipId: "required — clip id to split.",
      atSec: "required — absolute timeline second where the cut lands.",
    },
    async run({ clipId, atSec }, ctx) {
      if (!clipId) throw new Error("timeline_split_clip: clipId required.");
      const cut = Number(atSec);
      if (!Number.isFinite(cut) || cut < 0) {
        throw new Error("timeline_split_clip: atSec must be >= 0.");
      }
      const project = await readProjectMetadata(ctx.projectDir);
      if (!project) throw new Error("timeline_split_clip: project.json not readable.");
      const existing = ensureTimelineArray(project);
      const idx = existing.findIndex((c) => c.id === clipId);
      if (idx < 0) throw new Error(`timeline_split_clip: no clip with id ${clipId}.`);
      const clip = existing[idx];
      const startSec = Number(clip.startSec) || 0;
      const trimIn = Number(clip.inSec) > 0 ? Number(clip.inSec) : 0;
      const trimOut = Number(clip.outSec) > 0 ? Number(clip.outSec) : null;
      const video = clip.videoId ? findVideoById(project, clip.videoId) : null;
      const fullDur = Number(video?.durationSec) || 0;
      const safeOut = trimOut !== null ? trimOut : fullDur || trimIn + 4;
      const dur = Math.max(0.2, safeOut - trimIn);
      const local = cut - startSec;
      // 50 ms minimum slice on each side — small enough that any visible
      // clip can be split somewhere, generous enough that we don't
      // produce zero-duration halves. Pre-fix this was 200 ms, which
      // combined with free-form trimming created clips that couldn't
      // be split at all.
      const SPLIT_MIN_SLICE_SEC = 0.05;
      if (local <= SPLIT_MIN_SLICE_SEC || local >= dur - SPLIT_MIN_SLICE_SEC) {
        throw new Error(
          `timeline_split_clip: cut at ${roundTimelineSec(cut)}s is too close to a clip edge ` +
            `(clip spans ${roundTimelineSec(startSec)}s..${roundTimelineSec(startSec + dur)}s; ` +
            `each half must be at least ${SPLIT_MIN_SLICE_SEC * 1000} ms).`,
        );
      }
      const splitSourceSec = roundTimelineSec(trimIn + local);
      const left = { ...clip, outSec: splitSourceSec };
      const right = {
        ...clip,
        id: newClipId(),
        startSec: roundTimelineSec(startSec + local),
        inSec: splitSourceSec,
        outSec: trimOut,
      };
      existing.splice(idx, 1, left, right);
      await writeProjectMetadata(ctx.projectDir, {
        ...project,
        project: { ...(project.project || {}), updatedAt: new Date().toISOString() },
        timeline: persistClips(existing),
      });
      ctx.emitTimelineEvent?.({
        kind: "clip-split",
        originalId: clipId,
        leftId: left.id,
        rightId: right.id,
        cutSec: roundTimelineSec(cut),
      });
      return {
        ok: true,
        leftId: left.id,
        rightId: right.id,
        cutSec: roundTimelineSec(cut),
      };
    },
  });

  registerTool("timeline_set_trim", {
    tier: "edit",
    description:
      "Set inSec / outSec for an existing clip. Either or both may be provided. Pass null to clear (use full source duration).",
    args: {
      clipId: "required — clip id.",
      inSec: "optional — trim in-point in source seconds (or null to clear).",
      outSec: "optional — trim out-point in source seconds (or null to clear).",
    },
    async run({ clipId, inSec, outSec }, ctx) {
      if (!clipId) throw new Error("timeline_set_trim: clipId required.");
      const project = await readProjectMetadata(ctx.projectDir);
      if (!project) throw new Error("timeline_set_trim: project.json not readable.");
      const existing = ensureTimelineArray(project);
      const idx = existing.findIndex((c) => c.id === clipId);
      if (idx < 0) throw new Error(`timeline_set_trim: no clip with id ${clipId}.`);
      const clip = existing[idx];
      const next = { ...clip };
      if (inSec === null) next.inSec = null;
      else if (Number.isFinite(Number(inSec)) && Number(inSec) >= 0) next.inSec = roundTimelineSec(Number(inSec));
      if (outSec === null) next.outSec = null;
      else if (Number.isFinite(Number(outSec)) && Number(outSec) > 0) next.outSec = roundTimelineSec(Number(outSec));
      existing[idx] = next;
      await writeProjectMetadata(ctx.projectDir, {
        ...project,
        project: { ...(project.project || {}), updatedAt: new Date().toISOString() },
        timeline: persistClips(existing),
      });
      ctx.emitTimelineEvent?.({
        kind: "clip-trimmed",
        clipId,
        inSec: next.inSec,
        outSec: next.outSec,
      });
      return { ok: true, clipId, inSec: next.inSec, outSec: next.outSec };
    },
  });

  registerTool("timeline_set_volume", {
    tier: "edit",
    description:
      "Set per-clip volume (0 = silent, 1 = unity, 2 = +6dB) for an audio clip on A1 / A2.",
    args: {
      clipId: "required — audio clip id.",
      volume: "required — 0 to 2 multiplier (1 = unchanged).",
    },
    async run({ clipId, volume }, ctx) {
      if (!clipId) throw new Error("timeline_set_volume: clipId required.");
      const v = Number(volume);
      if (!Number.isFinite(v) || v < 0 || v > 2) {
        throw new Error("timeline_set_volume: volume must be 0..2.");
      }
      const project = await readProjectMetadata(ctx.projectDir);
      if (!project) throw new Error("timeline_set_volume: project.json not readable.");
      const existing = ensureTimelineArray(project);
      const idx = existing.findIndex((c) => c.id === clipId);
      if (idx < 0) throw new Error(`timeline_set_volume: no clip with id ${clipId}.`);
      existing[idx] = { ...existing[idx], volume: roundTimelineSec(v) };
      await writeProjectMetadata(ctx.projectDir, {
        ...project,
        project: { ...(project.project || {}), updatedAt: new Date().toISOString() },
        timeline: persistClips(existing),
      });
      ctx.emitTimelineEvent?.({ kind: "clip-volume", clipId, volume: roundTimelineSec(v) });
      return { ok: true, clipId, volume: roundTimelineSec(v) };
    },
  });

  registerTool("timeline_set_fade", {
    tier: "edit",
    description:
      "Set per-clip fadeInSec / fadeOutSec ramps. Either or both may be provided. Useful for soft music drops or smooth audio entries.",
    args: {
      clipId: "required — clip id.",
      fadeInSec: "optional — fade-in length in seconds (>=0).",
      fadeOutSec: "optional — fade-out length in seconds (>=0).",
    },
    async run({ clipId, fadeInSec, fadeOutSec }, ctx) {
      if (!clipId) throw new Error("timeline_set_fade: clipId required.");
      const project = await readProjectMetadata(ctx.projectDir);
      if (!project) throw new Error("timeline_set_fade: project.json not readable.");
      const existing = ensureTimelineArray(project);
      const idx = existing.findIndex((c) => c.id === clipId);
      if (idx < 0) throw new Error(`timeline_set_fade: no clip with id ${clipId}.`);
      const next = { ...existing[idx] };
      if (Number.isFinite(Number(fadeInSec))) next.fadeInSec = Math.max(0, roundTimelineSec(Number(fadeInSec)));
      if (Number.isFinite(Number(fadeOutSec))) next.fadeOutSec = Math.max(0, roundTimelineSec(Number(fadeOutSec)));
      existing[idx] = next;
      await writeProjectMetadata(ctx.projectDir, {
        ...project,
        project: { ...(project.project || {}), updatedAt: new Date().toISOString() },
        timeline: persistClips(existing),
      });
      ctx.emitTimelineEvent?.({
        kind: "clip-fade",
        clipId,
        fadeInSec: next.fadeInSec || 0,
        fadeOutSec: next.fadeOutSec || 0,
      });
      return { ok: true, clipId, fadeInSec: next.fadeInSec, fadeOutSec: next.fadeOutSec };
    },
  });

  registerTool("timeline_set_enabled", {
    tier: "edit",
    description:
      "Toggle a clip on/off without deleting it. Disabled clips stay in project.timeline[] and on the Workshop NLE (dimmed) but are excluded from export and preview playback. Useful for A/B comparing alternate takes or muting a track temporarily.",
    args: {
      clipId: "required — clip id.",
      enabled: "required — true | false.",
    },
    async run({ clipId, enabled }, ctx) {
      if (!clipId) throw new Error("timeline_set_enabled: clipId required.");
      if (typeof enabled !== "boolean") {
        throw new Error("timeline_set_enabled: enabled must be true or false.");
      }
      const project = await readProjectMetadata(ctx.projectDir);
      if (!project) throw new Error("timeline_set_enabled: project.json not readable.");
      const existing = ensureTimelineArray(project);
      const idx = existing.findIndex((c) => c.id === clipId);
      if (idx < 0) throw new Error(`timeline_set_enabled: no clip with id ${clipId}.`);
      existing[idx] = { ...existing[idx], enabled };
      await writeProjectMetadata(ctx.projectDir, {
        ...project,
        project: { ...(project.project || {}), updatedAt: new Date().toISOString() },
        timeline: persistClips(existing),
      });
      ctx.emitTimelineEvent?.({ kind: "clip-enabled", clipId, enabled });
      return { ok: true, clipId, enabled };
    },
  });

  registerTool("timeline_set_label", {
    tier: "edit",
    description:
      "Set or clear the display label on a clip. Pass null to revert to the auto-derived label (take number / filename). Useful for tagging clips with intent like 'opening hook' or 'punchline'.",
    args: {
      clipId: "required — clip id.",
      label: "required — string label, or null to clear.",
    },
    async run({ clipId, label }, ctx) {
      if (!clipId) throw new Error("timeline_set_label: clipId required.");
      const next = label === null ? null : typeof label === "string" ? label.trim() : null;
      if (next !== null && next.length > 200) {
        throw new Error("timeline_set_label: label exceeds 200 chars.");
      }
      const project = await readProjectMetadata(ctx.projectDir);
      if (!project) throw new Error("timeline_set_label: project.json not readable.");
      const existing = ensureTimelineArray(project);
      const idx = existing.findIndex((c) => c.id === clipId);
      if (idx < 0) throw new Error(`timeline_set_label: no clip with id ${clipId}.`);
      existing[idx] = { ...existing[idx], label: next };
      await writeProjectMetadata(ctx.projectDir, {
        ...project,
        project: { ...(project.project || {}), updatedAt: new Date().toISOString() },
        timeline: persistClips(existing),
      });
      ctx.emitTimelineEvent?.({ kind: "clip-label", clipId, label: next });
      return { ok: true, clipId, label: next };
    },
  });

  // ===========================================================================
  // apply_timeline_batch — atomic multi-op mutator. Lets one agent intent
  // ("rebalance the chase scene") commit as a single project.json write
  // instead of N separate IPC + save cycles. Each op uses the same shape
  // as its corresponding single-shot tool.
  // ===========================================================================

  function applyOpToClips(project, clips, op, results, durationsByMediaPath) {
    if (!op || typeof op !== "object" || !op.kind) {
      throw new Error("apply_timeline_batch: each op needs a kind field.");
    }
    switch (op.kind) {
      case "add": {
        if (!ALLOWED_TRACKS.has(op.track)) {
          throw new Error(`apply_timeline_batch:add: track must be V1, V2, A1, or A2.`);
        }
        if (!op.videoId && !op.mediaPath) {
          throw new Error("apply_timeline_batch:add: provide videoId or mediaPath.");
        }
        const isVideoTrack = op.track === "V1" || op.track === "V2";
        const isAudioTrack = op.track === "A1" || op.track === "A2";
        if (op.videoId && !isVideoTrack) {
          throw new Error("apply_timeline_batch:add: videoId only allowed on V1 / V2.");
        }
        if (op.mediaPath && !isAudioTrack) {
          throw new Error("apply_timeline_batch:add: mediaPath only allowed on A1 / A2.");
        }
        const video = op.videoId ? findVideoById(project, op.videoId) : null;
        if (op.videoId && !video) {
          throw new Error(`apply_timeline_batch:add: VideoEntry ${op.videoId} not found.`);
        }
        if (op.mediaPath && !findAudioMediaByPath(project, op.mediaPath)) {
          throw new Error(
            `apply_timeline_batch:add: audio path ${op.mediaPath} not in project audio library.`,
          );
        }
        const sourceDurationSec = op.mediaPath
          ? durationsByMediaPath.get(op.mediaPath) ?? null
          : Number(video?.durationSec) > 0
            ? Number(video.durationSec)
            : null;
        let resolvedOutSec =
          Number.isFinite(Number(op.outSec)) && Number(op.outSec) > 0
            ? roundTimelineSec(Number(op.outSec))
            : null;
        let outSecDefaulted = false;
        if (op.mediaPath && resolvedOutSec === null && sourceDurationSec) {
          resolvedOutSec = roundTimelineSec(sourceDurationSec);
          outSecDefaulted = true;
        }
        let outSecClamped = false;
        if (resolvedOutSec !== null && sourceDurationSec && resolvedOutSec > sourceDurationSec) {
          resolvedOutSec = roundTimelineSec(sourceDurationSec);
          outSecClamped = true;
          outSecDefaulted = false;
        }
        let resolvedStart = Number(op.startSec);
        if (!Number.isFinite(resolvedStart) || resolvedStart < 0) {
          let tail = 0;
          for (const c of clips) {
            if ((c.track || "V1") !== op.track) continue;
            const start = Number(c.startSec) || 0;
            const dur = Math.max(
              0.05,
              (Number(c.outSec) > 0 ? Number(c.outSec) : Number(video?.durationSec) || 4) -
                (Number(c.inSec) > 0 ? Number(c.inSec) : 0),
            );
            if (start + dur > tail) tail = start + dur;
          }
          resolvedStart = roundTimelineSec(tail);
        } else {
          resolvedStart = roundTimelineSec(resolvedStart);
        }
        const clip = {
          id: newClipId(),
          promptId: video?.promptId || null,
          videoId: op.videoId || null,
          mediaPath: op.mediaPath || null,
          track: op.track,
          startSec: resolvedStart,
          inSec:
            Number.isFinite(Number(op.inSec)) && Number(op.inSec) > 0
              ? roundTimelineSec(Number(op.inSec))
              : null,
          outSec: resolvedOutSec,
          enabled: true,
          volume: null,
          fadeInSec: null,
          fadeOutSec: null,
          label: op.label || null,
          orderIndex: clips.length,
        };
        clips.push(clip);
        results.push({
          kind: "add",
          clipId: clip.id,
          track: op.track,
          startSec: resolvedStart,
          outSec: resolvedOutSec,
          sourceDurationSec,
          outSecDefaulted,
          ...(outSecClamped
            ? {
                outSecClamped: true,
                warning: `outSec exceeded source duration; clamped to ${resolvedOutSec}s.`,
              }
            : {}),
        });
        return clips;
      }
      case "remove": {
        if (!op.clipId) throw new Error("apply_timeline_batch:remove: clipId required.");
        const before = clips.length;
        const next = clips.filter((c) => c.id !== op.clipId);
        if (next.length === before) {
          throw new Error(`apply_timeline_batch:remove: no clip with id ${op.clipId}.`);
        }
        results.push({ kind: "remove", clipId: op.clipId });
        return next;
      }
      case "move": {
        if (!op.clipId) throw new Error("apply_timeline_batch:move: clipId required.");
        const idx = clips.findIndex((c) => c.id === op.clipId);
        if (idx < 0) {
          throw new Error(`apply_timeline_batch:move: no clip with id ${op.clipId}.`);
        }
        const clip = clips[idx];
        const isAudioClip = !!clip.mediaPath && !clip.videoId;
        const nextTrack =
          op.track && ALLOWED_TRACKS.has(op.track) ? op.track : clip.track || "V1";
        const isAudioTrack = nextTrack === "A1" || nextTrack === "A2";
        if (isAudioClip && !isAudioTrack) {
          throw new Error("apply_timeline_batch:move: audio clips must stay on A1 / A2.");
        }
        if (!isAudioClip && isAudioTrack) {
          throw new Error("apply_timeline_batch:move: video clips must stay on V1 / V2.");
        }
        const nextStart =
          Number.isFinite(Number(op.startSec)) && Number(op.startSec) >= 0
            ? roundTimelineSec(Number(op.startSec))
            : Number(clip.startSec) || 0;
        clips[idx] = { ...clip, track: nextTrack, startSec: nextStart };
        results.push({ kind: "move", clipId: op.clipId, track: nextTrack, startSec: nextStart });
        return clips;
      }
      case "trim": {
        if (!op.clipId) throw new Error("apply_timeline_batch:trim: clipId required.");
        const idx = clips.findIndex((c) => c.id === op.clipId);
        if (idx < 0) {
          throw new Error(`apply_timeline_batch:trim: no clip with id ${op.clipId}.`);
        }
        const next = { ...clips[idx] };
        if (op.inSec === null) next.inSec = null;
        else if (Number.isFinite(Number(op.inSec)) && Number(op.inSec) >= 0) {
          next.inSec = roundTimelineSec(Number(op.inSec));
        }
        if (op.outSec === null) next.outSec = null;
        else if (Number.isFinite(Number(op.outSec)) && Number(op.outSec) > 0) {
          next.outSec = roundTimelineSec(Number(op.outSec));
        }
        clips[idx] = next;
        results.push({ kind: "trim", clipId: op.clipId, inSec: next.inSec, outSec: next.outSec });
        return clips;
      }
      case "volume": {
        if (!op.clipId) throw new Error("apply_timeline_batch:volume: clipId required.");
        const v = Number(op.volume);
        if (!Number.isFinite(v) || v < 0 || v > 2) {
          throw new Error("apply_timeline_batch:volume: volume must be 0..2.");
        }
        const idx = clips.findIndex((c) => c.id === op.clipId);
        if (idx < 0) {
          throw new Error(`apply_timeline_batch:volume: no clip with id ${op.clipId}.`);
        }
        clips[idx] = { ...clips[idx], volume: roundTimelineSec(v) };
        results.push({ kind: "volume", clipId: op.clipId, volume: roundTimelineSec(v) });
        return clips;
      }
      case "fade": {
        if (!op.clipId) throw new Error("apply_timeline_batch:fade: clipId required.");
        const idx = clips.findIndex((c) => c.id === op.clipId);
        if (idx < 0) {
          throw new Error(`apply_timeline_batch:fade: no clip with id ${op.clipId}.`);
        }
        const next = { ...clips[idx] };
        if (Number.isFinite(Number(op.fadeInSec))) {
          next.fadeInSec = Math.max(0, roundTimelineSec(Number(op.fadeInSec)));
        }
        if (Number.isFinite(Number(op.fadeOutSec))) {
          next.fadeOutSec = Math.max(0, roundTimelineSec(Number(op.fadeOutSec)));
        }
        clips[idx] = next;
        results.push({
          kind: "fade",
          clipId: op.clipId,
          fadeInSec: next.fadeInSec,
          fadeOutSec: next.fadeOutSec,
        });
        return clips;
      }
      case "enable": {
        if (!op.clipId) throw new Error("apply_timeline_batch:enable: clipId required.");
        if (typeof op.enabled !== "boolean") {
          throw new Error("apply_timeline_batch:enable: enabled must be true or false.");
        }
        const idx = clips.findIndex((c) => c.id === op.clipId);
        if (idx < 0) {
          throw new Error(`apply_timeline_batch:enable: no clip with id ${op.clipId}.`);
        }
        clips[idx] = { ...clips[idx], enabled: op.enabled };
        results.push({ kind: "enable", clipId: op.clipId, enabled: op.enabled });
        return clips;
      }
      case "label": {
        if (!op.clipId) throw new Error("apply_timeline_batch:label: clipId required.");
        const labelNext =
          op.label === null
            ? null
            : typeof op.label === "string"
              ? op.label.trim()
              : null;
        if (labelNext !== null && labelNext.length > 200) {
          throw new Error("apply_timeline_batch:label: label exceeds 200 chars.");
        }
        const idx = clips.findIndex((c) => c.id === op.clipId);
        if (idx < 0) {
          throw new Error(`apply_timeline_batch:label: no clip with id ${op.clipId}.`);
        }
        clips[idx] = { ...clips[idx], label: labelNext };
        results.push({ kind: "label", clipId: op.clipId, label: labelNext });
        return clips;
      }
      case "split": {
        if (!op.clipId) throw new Error("apply_timeline_batch:split: clipId required.");
        const cut = Number(op.atSec);
        if (!Number.isFinite(cut) || cut < 0) {
          throw new Error("apply_timeline_batch:split: atSec must be >= 0.");
        }
        const idx = clips.findIndex((c) => c.id === op.clipId);
        if (idx < 0) {
          throw new Error(`apply_timeline_batch:split: no clip with id ${op.clipId}.`);
        }
        const clip = clips[idx];
        const startSec = Number(clip.startSec) || 0;
        const trimIn = Number(clip.inSec) > 0 ? Number(clip.inSec) : 0;
        const trimOut = Number(clip.outSec) > 0 ? Number(clip.outSec) : null;
        const video = clip.videoId ? findVideoById(project, clip.videoId) : null;
        const fullDur = Number(video?.durationSec) || 0;
        const safeOut = trimOut !== null ? trimOut : fullDur || trimIn + 4;
        const dur = Math.max(0.05, safeOut - trimIn);
        const local = cut - startSec;
        if (local <= 0.05 || local >= dur - 0.05) {
          throw new Error(
            `apply_timeline_batch:split: cut at ${roundTimelineSec(cut)}s is too close to a clip edge.`,
          );
        }
        const splitSourceSec = roundTimelineSec(trimIn + local);
        const left = { ...clip, outSec: splitSourceSec };
        const right = {
          ...clip,
          id: newClipId(),
          startSec: roundTimelineSec(startSec + local),
          inSec: splitSourceSec,
          outSec: trimOut,
        };
        clips.splice(idx, 1, left, right);
        results.push({
          kind: "split",
          originalId: op.clipId,
          leftId: left.id,
          rightId: right.id,
          cutSec: roundTimelineSec(cut),
        });
        return clips;
      }
      default:
        throw new Error(`apply_timeline_batch: unknown op kind "${op.kind}".`);
    }
  }

  registerTool("apply_timeline_batch", {
    tier: "edit",
    description:
      "Apply a batch of timeline operations atomically. One project.json write covers all ops, so a multi-step intent (e.g. 'add 3 clips, move 1, trim 2') doesn't fan out into N saves. If any op fails, no changes are persisted.",
    args: {
      ops: "required — array of { kind: 'add'|'remove'|'move'|'trim'|'volume'|'fade'|'enable'|'label'|'split', ...op-specific args }. Op shapes mirror the single-shot timeline_* tools.",
    },
    async run({ ops }, ctx) {
      if (!Array.isArray(ops) || ops.length === 0) {
        throw new Error("apply_timeline_batch: ops must be a non-empty array.");
      }
      const project = await readProjectMetadata(ctx.projectDir);
      if (!project) throw new Error("apply_timeline_batch: project.json not readable.");
      // Pre-probe every audio mediaPath the batch wants to add, so each
      // op's clamp logic stays sync. Probing is cheap (<100 ms per file)
      // but parallelizing keeps batches fast.
      const audioPaths = new Set();
      for (const op of ops) {
        if (op?.kind === "add" && op.mediaPath) audioPaths.add(op.mediaPath);
      }
      const durationsByMediaPath = new Map();
      await Promise.all(
        Array.from(audioPaths).map(async (mediaPath) => {
          const absPath = path.isAbsolute(mediaPath)
            ? mediaPath
            : path.join(ctx.projectDir, mediaPath);
          const dur = await probeMediaDurationSec(absPath);
          durationsByMediaPath.set(mediaPath, dur);
        }),
      );
      let clips = ensureTimelineArray(project);
      const results = [];
      for (let i = 0; i < ops.length; i += 1) {
        try {
          clips = applyOpToClips(project, clips, ops[i], results, durationsByMediaPath);
        } catch (error) {
          throw new Error(
            `apply_timeline_batch[${i}]: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      await writeProjectMetadata(ctx.projectDir, {
        ...project,
        project: { ...(project.project || {}), updatedAt: new Date().toISOString() },
        timeline: persistClips(clips),
      });
      // Replay every batched op as a granular timeline-event so the
      // renderer can animate each step. Order matches the reduce loop.
      for (const r of results) {
        switch (r.kind) {
          case "add":
            ctx.emitTimelineEvent?.({
              kind: "clip-added",
              clipId: r.clipId,
              track: r.track,
              startSec: r.startSec,
              videoId: clips.find((c) => c.id === r.clipId)?.videoId || null,
              mediaPath: clips.find((c) => c.id === r.clipId)?.mediaPath || null,
            });
            break;
          case "remove":
            ctx.emitTimelineEvent?.({ kind: "clip-removed", clipId: r.clipId });
            break;
          case "move":
            ctx.emitTimelineEvent?.({
              kind: "clip-moved",
              clipId: r.clipId,
              track: r.track,
              startSec: r.startSec,
            });
            break;
          case "trim":
            ctx.emitTimelineEvent?.({
              kind: "clip-trimmed",
              clipId: r.clipId,
              inSec: r.inSec ?? null,
              outSec: r.outSec ?? null,
            });
            break;
          case "volume":
            ctx.emitTimelineEvent?.({
              kind: "clip-volume",
              clipId: r.clipId,
              volume: r.volume,
            });
            break;
          case "fade":
            ctx.emitTimelineEvent?.({
              kind: "clip-fade",
              clipId: r.clipId,
              fadeInSec: r.fadeInSec || 0,
              fadeOutSec: r.fadeOutSec || 0,
            });
            break;
          case "enable":
            ctx.emitTimelineEvent?.({
              kind: "clip-enabled",
              clipId: r.clipId,
              enabled: r.enabled,
            });
            break;
          case "label":
            ctx.emitTimelineEvent?.({
              kind: "clip-label",
              clipId: r.clipId,
              label: r.label ?? null,
            });
            break;
          case "split":
            ctx.emitTimelineEvent?.({
              kind: "clip-split",
              originalId: r.originalId || r.leftId,
              leftId: r.leftId,
              rightId: r.rightId,
              cutSec: r.cutSec,
            });
            break;
        }
      }
      return { ok: true, opsApplied: results.length, results };
    },
  });

  // ===========================================================================
  // announce_intent — non-mutating tool that lets the agent narrate what
  // it's about to do, optionally pointing at the clips that will change.
  // The Workshop NLE reduces this into an "agent is editing" banner +
  // per-clip pulse so the user can see the intent BEFORE the work
  // commits. Cleared automatically when the agent's turn ends, or
  // explicitly via clearIntent=true.
  // ===========================================================================
  registerTool("announce_intent", {
    tier: "meta",
    description:
      "Tell the user (via the Workshop NLE banner) what you're about to do. Optional clipIds highlight the clips you'll touch — they pulse violet so the user sees the change land. Use BEFORE multi-step edits ('Tightening Scene 3 by 12s', 'Reassigning takes 5..7 to the new shot'). Pass clearIntent=true to dismiss the banner without a new message.",
    args: {
      message:
        "required (unless clearIntent=true) — short human-readable description of the upcoming edit. Keep under 120 chars.",
      clipIds: "optional — array of clip ids the upcoming edit will touch.",
      clearIntent:
        "optional — when true, clears the active intent banner instead of setting a new one.",
    },
    async run({ message, clipIds, clearIntent }, ctx) {
      if (clearIntent === true) {
        ctx.emitTimelineEvent?.({ kind: "intent-cleared" });
        return { ok: true, cleared: true };
      }
      const text = String(message || "").trim();
      if (!text) {
        throw new Error("announce_intent: message required (or pass clearIntent=true).");
      }
      if (text.length > 240) {
        throw new Error("announce_intent: message exceeds 240 chars; keep it tight.");
      }
      const ids = Array.isArray(clipIds) ? clipIds.filter((s) => typeof s === "string" && s) : [];
      ctx.emitTimelineEvent?.({
        kind: "intent",
        message: text,
        clipIds: ids,
      });
      return { ok: true, message: text, clipIds: ids };
    },
  });

  registerTool("list_timeline", {
    tier: "domain",
    description:
      "Return the raw project.timeline[] entries as the Workshop NLE sees them — track, startSec, inSec, outSec, mediaPath, volume, fadeInSec, fadeOutSec. Read-only.",
    args: {},
    async run(_args, ctx) {
      const project = await readProjectMetadata(ctx.projectDir);
      if (!project) throw new Error("list_timeline: project.json not readable.");
      const clips = ensureTimelineArray(project);
      return {
        ok: true,
        count: clips.length,
        clips: clips.map((c) => ({
          id: c.id,
          track: c.track || "V1",
          startSec: Number(c.startSec) || 0,
          inSec: c.inSec ?? null,
          outSec: c.outSec ?? null,
          videoId: c.videoId || null,
          mediaPath: c.mediaPath || null,
          enabled: c.enabled !== false,
          volume: c.volume ?? 1,
          fadeInSec: c.fadeInSec || 0,
          fadeOutSec: c.fadeOutSec || 0,
          label: c.label || null,
        })),
      };
    },
  });
};
