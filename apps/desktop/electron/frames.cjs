// Frame extraction for rendered video takes. Shells out to ffmpeg
// (already allowlisted in builtins.cjs SHELL_COMMAND_ALLOWLIST) to
// write a PNG of the first frame, last frame, or a specific timestamp
// within a take.
//
// Frames live under <projectDir>/.forge/frames/<videoId>/ — co-located
// with project metadata so they survive rename/reorder and are never
// mixed into user-authored assets/. The directory is a derived cache:
// safe to nuke and regenerate from any rendered take.
//
// Continuity workflow (the reason this exists):
//   1. User renders take T for prompt P1, drops file.
//   2. syncVideoDirectoryFiles imports T, auto-extracts first + last
//      frames of T into .forge/frames/<T.id>/{first,last}.png.
//   3. When P2 (which has continuity.prevId === P1) needs a render
//      bundle, build_render_bundle reads .forge/frames/<T.id>/last.png
//      as P2's startFrame keyframe — Seedance 2's start-frame anchor.

const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const { existsSync } = require("node:fs");
const path = require("node:path");

// ffmpeg discovery order:
//   1. ffmpeg-static npm package (if installed — bundles a binary)
//   2. common macOS install paths (homebrew, /usr/local, system)
//   3. $PATH (let execFile resolve)
// Cached on first successful resolution.
const FFMPEG_CANDIDATES = [
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  "/usr/bin/ffmpeg",
];

let cachedFfmpegPath = null;

function resolveFfmpeg() {
  if (cachedFfmpegPath) return cachedFfmpegPath;
  try {
    // eslint-disable-next-line global-require
    const ffStatic = require("ffmpeg-static");
    if (ffStatic && typeof ffStatic === "string" && existsSync(ffStatic)) {
      cachedFfmpegPath = ffStatic;
      return cachedFfmpegPath;
    }
  } catch {
    // ffmpeg-static not installed — fall through to system candidates.
  }
  for (const candidate of FFMPEG_CANDIDATES) {
    if (existsSync(candidate)) {
      cachedFfmpegPath = candidate;
      return cachedFfmpegPath;
    }
  }
  return "ffmpeg"; // last resort: rely on $PATH
}

function runFfmpeg(args, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const bin = resolveFfmpeg();
    execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          resolve({
            ok: false,
            error: err.message || String(err),
            stderr: String(stderr || ""),
          });
          return;
        }
        resolve({ ok: true, stdout: String(stdout || ""), stderr: String(stderr || "") });
      },
    );
  });
}

// Probe a video's duration by asking ffmpeg to read but produce no
// output. ffmpeg writes "Duration: HH:MM:SS.cc" to stderr even when
// the output is null — parse it out. Returns seconds (float) or null.
async function probeDuration(absVideoPath) {
  const res = await runFfmpeg(
    ["-hide_banner", "-i", absVideoPath, "-f", "null", "-"],
    { timeoutMs: 8000 },
  );
  const src = `${res.stderr || ""}\n${res.stdout || ""}`;
  const m = src.match(/Duration:\s*(\d+):(\d+):(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  const h = Number(m[1] || 0);
  const mm = Number(m[2] || 0);
  const s = Number(m[3] || 0);
  const cs = Number(`0.${m[4] || "0"}`);
  const total = h * 3600 + mm * 60 + s + cs;
  return Number.isFinite(total) && total > 0 ? total : null;
}

/**
 * Extract a frame from a video and write it as PNG under
 *   <projectDir>/.forge/frames/<videoId>/<position>.png
 *
 * @param {object} args
 * @param {string} args.projectDir   absolute project path
 * @param {string} args.videoPath    project-relative path to the source video
 * @param {string} args.videoId      stable VideoEntry id — used as folder name
 * @param {"first"|"last"|number} args.position  "first" | "last" | absolute seconds
 * @returns {Promise<{ok: boolean, framePath?: string, absFramePath?: string, position?: string, error?: string}>}
 */
async function extractFrame({ projectDir, videoPath, videoId, position }) {
  if (!projectDir || !videoPath || !videoId) {
    return {
      ok: false,
      error: "extractFrame: projectDir, videoPath, and videoId are required.",
    };
  }
  const absVideo = path.isAbsolute(videoPath)
    ? videoPath
    : path.join(projectDir, videoPath);
  if (!existsSync(absVideo)) {
    return { ok: false, error: `extractFrame: source video not found at ${absVideo}` };
  }

  // Resolve seek target + filename suffix.
  let seekSec;
  let labelSuffix;
  if (position === "first") {
    seekSec = 0;
    labelSuffix = "first";
  } else if (position === "last") {
    const dur = await probeDuration(absVideo);
    if (Number.isFinite(dur) && dur > 0) {
      // Step back 0.05s so we land on a safely-decoded frame, not the
      // potential edge-of-file artifact.
      seekSec = Math.max(0, dur - 0.05);
    } else {
      // Duration probe failed — use -sseof for "seek relative to end".
      seekSec = NaN;
    }
    labelSuffix = "last";
  } else if (typeof position === "number" && Number.isFinite(position) && position >= 0) {
    seekSec = position;
    labelSuffix = `t${Math.round(position * 100) / 100}s`.replace(".", "_");
  } else {
    return {
      ok: false,
      error: `extractFrame: unsupported position ${JSON.stringify(position)}`,
    };
  }

  const frameDir = path.join(projectDir, ".forge", "frames", videoId);
  await fs.mkdir(frameDir, { recursive: true });
  const fileName = `${labelSuffix}.png`;
  const absFramePath = path.join(frameDir, fileName);
  const relFramePath = path.posix.join(".forge", "frames", videoId, fileName);

  // ffmpeg args. Put -ss BEFORE -i for fast seek. For "last" when
  // duration is unknown, fall back to -sseof -0.1.
  const args = Number.isFinite(seekSec)
    ? [
        "-y",
        "-ss",
        String(seekSec),
        "-i",
        absVideo,
        "-frames:v",
        "1",
        "-q:v",
        "2",
        absFramePath,
      ]
    : [
        "-y",
        "-sseof",
        "-0.1",
        "-i",
        absVideo,
        "-frames:v",
        "1",
        "-q:v",
        "2",
        absFramePath,
      ];

  const result = await runFfmpeg(args, { timeoutMs: 15000 });
  if (!result.ok) {
    return {
      ok: false,
      error: `extractFrame: ffmpeg failed — ${result.error || ""}${
        result.stderr ? ` | ${result.stderr.slice(-400)}` : ""
      }`.trim(),
    };
  }
  if (!existsSync(absFramePath)) {
    return { ok: false, error: `extractFrame: ffmpeg succeeded but no file at ${absFramePath}` };
  }
  return {
    ok: true,
    position: typeof position === "number" ? labelSuffix : position,
    framePath: relFramePath,
    absFramePath,
  };
}

/**
 * Convenience wrapper: extract BOTH first + last frames for a take
 * in parallel. Non-fatal if one fails (still returns the other).
 */
async function extractFirstAndLastFrames({ projectDir, videoPath, videoId }) {
  const [first, last] = await Promise.all([
    extractFrame({ projectDir, videoPath, videoId, position: "first" }),
    extractFrame({ projectDir, videoPath, videoId, position: "last" }),
  ]);
  return { first, last };
}

module.exports = {
  extractFrame,
  extractFirstAndLastFrames,
  probeDuration,
  resolveFfmpeg,
};
