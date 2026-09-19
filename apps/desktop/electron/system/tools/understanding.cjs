const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { callModel } = require("../../openclaw.cjs");

const IMAGE_EXTENSIONS = new Set([
  ".avif", ".bmp", ".gif", ".heic", ".heif", ".jpeg", ".jpg",
  ".png", ".tif", ".tiff", ".webp",
]);
const AUDIO_EXTENSIONS = new Set([
  ".aac", ".aiff", ".flac", ".m4a", ".mp3", ".ogg", ".wav",
]);

const FFPROBE_BIN = "/opt/homebrew/bin/ffprobe";
const FFPROBE_FALLBACK = "/usr/local/bin/ffprobe";

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : raw;
  try {
    return JSON.parse(candidate);
  } catch {}
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(candidate.slice(first, last + 1));
    } catch {}
  }
  return null;
}

function runFfprobe(absolutePath) {
  const binaries = [FFPROBE_BIN, FFPROBE_FALLBACK];
  return new Promise((resolve, reject) => {
    const tryNext = (index) => {
      if (index >= binaries.length) {
        reject(new Error("ffprobe not found (tried /opt/homebrew/bin/ffprobe, /usr/local/bin/ffprobe)."));
        return;
      }
      execFile(
        binaries[index],
        [
          "-v", "error",
          "-show_format",
          "-show_streams",
          "-of", "json",
          absolutePath,
        ],
        { maxBuffer: 2 * 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            if (error.code === "ENOENT") {
              tryNext(index + 1);
              return;
            }
            reject(error);
            return;
          }
          try {
            resolve(JSON.parse(String(stdout || "{}")));
          } catch (parseError) {
            reject(parseError);
          }
        },
      );
    };
    tryNext(0);
  });
}

module.exports = function registerUnderstandingTools(api) {
  const { registerTool, resolveInside, normalizeRelativePath } = api;

  async function resolveImagePath(projectDir, relativePath) {
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized) throw new Error("path is required.");
    const ext = path.posix.extname(normalized.toLowerCase());
    if (!IMAGE_EXTENSIONS.has(ext)) {
      throw new Error(`${normalized} is not a supported image type.`);
    }
    const absolute = resolveInside(projectDir, normalized);
    await fs.access(absolute);
    return { normalized, absolute };
  }

  async function resolveAudioPath(projectDir, relativePath) {
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized) throw new Error("path is required.");
    const ext = path.posix.extname(normalized.toLowerCase());
    if (!AUDIO_EXTENSIONS.has(ext)) {
      throw new Error(`${normalized} is not a supported audio type.`);
    }
    const absolute = resolveInside(projectDir, normalized);
    await fs.access(absolute);
    return { normalized, absolute };
  }

  async function askClaudeForJson({ prompt, sessionKey, settings, signal }) {
    const raw = await callModel({
      prompt,
      sessionKey: sessionKey || "hook:shotforge:understanding",
      settings,
      signal,
    });
    const parsed = extractJsonObject(raw);
    if (!parsed) {
      return { raw: String(raw || "").slice(0, 1200), error: "model did not return parseable JSON" };
    }
    return parsed;
  }

  registerTool("describe_images", {
    tier: "domain",
    description:
      "Describe one or more project images using Claude vision. Returns per-image { path, subjects[], style, mood, lighting, palette, notes, quality }. Use before reference picking, keyframe curation, or character bible writing.",
    args: {
      paths: "array of project-relative image paths (1-6 recommended)",
      focus: "optional — what the caller cares about (e.g. 'style', 'wardrobe', 'lighting')",
    },
    async run({ paths, focus }, ctx) {
      if (!Array.isArray(paths) || !paths.length) {
        throw new Error("describe_images: 'paths' must be a non-empty array.");
      }
      const resolved = await Promise.all(
        paths.slice(0, 6).map((p) => resolveImagePath(ctx.projectDir, p)),
      );
      const projectRoot = ctx.projectDir;
      const cleanFocus = String(focus || "").trim() || "general scene description";
      const prompt = [
        "You are a film reference analyst. Examine the listed images and return strict JSON only.",
        `Focus: ${cleanFocus}.`,
        "",
        "Image files (project-relative paths):",
        ...resolved.map((r) => `- ${r.normalized}`),
        "",
        `Project root (absolute): ${projectRoot}`,
        "",
        "Respond with JSON of shape:",
        '{ "images": [ { "path": string, "subjects": string[], "style": string, "mood": string, "lighting": string, "palette": string, "notes": string, "quality": "low"|"medium"|"high" } ] }',
        "Keep each string under 40 words. If you cannot see an image, set quality to 'low' and put the reason in notes.",
      ].join("\n");
      const parsed = await askClaudeForJson({
        prompt,
        sessionKey: ctx.sessionKey,
        settings: ctx.settings,
        signal: ctx.signal,
      });
      return parsed;
    },
  });

  registerTool("compare_images", {
    tier: "domain",
    description:
      "Compare two project images side by side via Claude vision. Returns { similarities[], differences[], verdict }. Useful for keyframe continuity, character consistency, reference selection.",
    args: {
      pathA: "first project-relative image path",
      pathB: "second project-relative image path",
      axis: "optional — axis to compare (e.g. 'style', 'character pose', 'color grade')",
    },
    async run({ pathA, pathB, axis }, ctx) {
      const a = await resolveImagePath(ctx.projectDir, pathA);
      const b = await resolveImagePath(ctx.projectDir, pathB);
      const cleanAxis = String(axis || "").trim() || "overall visual match";
      const prompt = [
        "You compare two film reference images and return strict JSON only.",
        `Axis: ${cleanAxis}.`,
        "",
        `Image A: ${a.normalized}`,
        `Image B: ${b.normalized}`,
        `Project root: ${ctx.projectDir}`,
        "",
        "Respond with:",
        '{ "similarities": string[], "differences": string[], "verdict": "match" | "close" | "divergent", "confidence": "low"|"medium"|"high", "notes": string }',
        "Each array item under 25 words. 'verdict' = match when they could cut back-to-back; close when a grade fixes it; divergent otherwise.",
      ].join("\n");
      return askClaudeForJson({
        prompt,
        sessionKey: ctx.sessionKey,
        settings: ctx.settings,
        signal: ctx.signal,
      });
    },
  });

  registerTool("pick_best_reference", {
    tier: "domain",
    description:
      "Given a goal and several candidate images, pick the best single reference. Returns { winner: {path, reason}, runnerUp?, rankings[] }. Uses Claude vision.",
    args: {
      paths: "array of project-relative image paths (2-8)",
      goal: "what the reference is for (e.g. 'character keyframe for Aki, cyberpunk alley')",
    },
    async run({ paths, goal }, ctx) {
      if (!Array.isArray(paths) || paths.length < 2) {
        throw new Error("pick_best_reference: 'paths' must contain at least 2 entries.");
      }
      const cleanGoal = String(goal || "").trim();
      if (!cleanGoal) throw new Error("pick_best_reference: 'goal' is required.");
      const resolved = await Promise.all(
        paths.slice(0, 8).map((p) => resolveImagePath(ctx.projectDir, p)),
      );
      const prompt = [
        "You are a film-reference curator. Pick the single best reference image for the given goal. Return strict JSON only.",
        `Goal: ${cleanGoal}.`,
        "",
        "Candidates (project-relative):",
        ...resolved.map((r) => `- ${r.normalized}`),
        "",
        `Project root: ${ctx.projectDir}`,
        "",
        "Respond with:",
        '{ "winner": { "path": string, "reason": string }, "runnerUp": { "path": string, "reason": string } | null, "rankings": [ { "path": string, "score": number, "notes": string } ] }',
        "score is 0-100. reason under 40 words.",
      ].join("\n");
      return askClaudeForJson({
        prompt,
        sessionKey: ctx.sessionKey,
        settings: ctx.settings,
        signal: ctx.signal,
      });
    },
  });

  registerTool("summarize_audio", {
    tier: "domain",
    description:
      "Summarize an audio file via ffprobe metadata (duration, bitrate, channels, sample rate, detected format, tags). Use before music/SFX reference curation. Does not transcribe speech.",
    args: { path: "project-relative audio path" },
    async run({ path: relativePath }, ctx) {
      const { normalized, absolute } = await resolveAudioPath(ctx.projectDir, relativePath);
      const probe = await runFfprobe(absolute);
      const format = probe?.format || {};
      const streams = Array.isArray(probe?.streams) ? probe.streams : [];
      const audioStream = streams.find((s) => s?.codec_type === "audio") || streams[0] || {};
      const tags = format.tags || audioStream.tags || {};
      const durationSec = Number(format.duration || audioStream.duration || 0) || null;
      return {
        path: normalized,
        durationSec,
        durationHuman: durationSec
          ? `${Math.floor(durationSec / 60)}:${String(Math.floor(durationSec % 60)).padStart(2, "0")}`
          : null,
        format: format.format_name || null,
        formatLong: format.format_long_name || null,
        bitrate: Number(format.bit_rate || audioStream.bit_rate || 0) || null,
        codec: audioStream.codec_name || null,
        sampleRate: Number(audioStream.sample_rate || 0) || null,
        channels: Number(audioStream.channels || 0) || null,
        channelLayout: audioStream.channel_layout || null,
        title: tags.title || null,
        artist: tags.artist || null,
        album: tags.album || null,
        genre: tags.genre || null,
      };
    },
  });
};
