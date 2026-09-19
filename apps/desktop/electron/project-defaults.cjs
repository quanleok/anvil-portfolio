// Loader for `.forge/project-defaults.json` — the project-tier values
// in the prompt-field cascade resolver (see resolve-prompt-fields.cjs).
//
// File shape:
// {
//   "scene":  { "durationTargetSec": 30, "mood": null },
//   "shot":   { "durationSec": 8, "shotType": null, "lensHint": null },
//   "prompt": { "model": "seedance-1.5", "durationSec": 8,
//               "aspectRatio": "16:9", "resolution": "1080p", "fps": 24,
//               "lens": null, "cameraMovement": null,
//               "motionIntensity": null, "mood": null,
//               "soundFlag": false, "seed": null, "modelParams": {} }
// }
//
// Every field is optional. Missing or null means "fall through to the
// next cascade tier" (model library default → agent decides).
//
// JSON over markdown-with-frontmatter because:
//   - Existing frontmatter parser is line-based and can't handle nested
//     keys (which this file needs at minimum two levels deep).
//   - Agents read + write JSON directly via existing tools.
//   - Atomic write is straightforward — no body/frontmatter merge.
//   - Adding a sibling `project-defaults.README.md` later is trivial if
//     human-friendly notes are wanted.

"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const PROJECT_DEFAULTS_FILE = path.join(".forge", "project-defaults.json");

// Cap reads so a corrupt or maliciously-large file can't OOM the main
// process. Real defaults files are <2KB; 32KB is generous headroom.
const MAX_BYTES = 32 * 1024;

const EMPTY_DEFAULTS = Object.freeze({
  scene: Object.freeze({}),
  shot: Object.freeze({}),
  prompt: Object.freeze({}),
});

function projectDefaultsPath(projectDir) {
  return path.join(projectDir, PROJECT_DEFAULTS_FILE);
}

// Validation: silently drop unknown top-level keys, keep only the
// scene/shot/prompt sections, ensure each is a plain object. Doesn't
// validate INSIDE the sections — the resolver tolerates unknown keys
// and ignores them at the cascade level. Forward-compat by design.
function normalize(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { scene: {}, shot: {}, prompt: {} };
  }
  const sec = (key) => {
    const v = raw[key];
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  };
  return {
    scene: sec("scene"),
    shot: sec("shot"),
    prompt: sec("prompt"),
  };
}

async function readProjectDefaults(projectDir) {
  if (!projectDir) return { ...EMPTY_DEFAULTS };
  const file = projectDefaultsPath(projectDir);
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { scene: {}, shot: {}, prompt: {} };
    throw error;
  }
  if (raw.length > MAX_BYTES) {
    // File is too large to be a valid defaults blob. Treat as missing
    // rather than throwing — the resolver still works, defaults just
    // won't apply. The agent or UI can fix the file.
    return { scene: {}, shot: {}, prompt: {} };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt JSON — same fallback. Don't crash the whole project load
    // because one optional file is broken.
    return { scene: {}, shot: {}, prompt: {} };
  }
  return normalize(parsed);
}

async function writeProjectDefaults(projectDir, defaults) {
  if (!projectDir) throw new Error("writeProjectDefaults: projectDir is required.");
  const normalized = normalize(defaults);
  const file = projectDefaultsPath(projectDir);
  const json = `${JSON.stringify(normalized, null, 2)}\n`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, json, "utf8");
  return { path: PROJECT_DEFAULTS_FILE, bytes: json.length };
}

// Surgical patcher used by `set_project_default` agent tool. Reads,
// applies the patch (delete on null/undefined to restore Auto), writes
// back. Returns the updated defaults so the caller can refresh state
// without a second read.
async function setProjectDefault(projectDir, scope, field, value) {
  if (!["scene", "shot", "prompt"].includes(scope)) {
    throw new Error(`setProjectDefault: scope must be scene/shot/prompt (got '${scope}').`);
  }
  if (!field || typeof field !== "string") {
    throw new Error("setProjectDefault: field name is required.");
  }
  const current = await readProjectDefaults(projectDir);
  const next = {
    ...current,
    [scope]: { ...(current[scope] || {}) },
  };
  if (value === null || value === undefined) {
    delete next[scope][field];
  } else {
    next[scope][field] = value;
  }
  await writeProjectDefaults(projectDir, next);
  return next;
}

module.exports = {
  PROJECT_DEFAULTS_FILE,
  EMPTY_DEFAULTS,
  projectDefaultsPath,
  readProjectDefaults,
  writeProjectDefaults,
  setProjectDefault,
};
