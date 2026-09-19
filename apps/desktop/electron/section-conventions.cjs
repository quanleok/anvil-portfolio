const fs = require("node:fs/promises");
const path = require("node:path");

const MAX_CONV_CHARS = 12_000;

const DEFAULT_SCENE_FORMAT = `# Master Script format

Keep the user's script in script/master-script.md and scene notes in scenes/.
Use clear titles and preserve the project's existing structure.
Private production methods are not included in this public example.
`;

const DEFAULT_BEAT_FORMAT = `# Beat format (legacy/internal)

beats/ contains optional user-authored planning notes. Preserve existing files,
parent references, and frontmatter. Follow the user's requested structure.
`;

const DEFAULT_SHOT_FORMAT = `# Shot format (legacy/internal)

shots/ contains optional user-authored planning notes. Preserve existing files,
parent references, and frontmatter. Follow the user's requested structure.
`;

const DEFAULT_PROMPT_FORMAT = `# Prompt format

Prompts are stored in prompts/. Use create_prompt to create and number them.
Keep user-authored text, media references, and existing frontmatter intact.
Confirm the chosen provider's supported settings before generation.
This public example does not prescribe a private prompt recipe.
`;

const DEFAULT_CONVENTION_KINDS = ["script", "prompts"];

const KIND_SPECS = {
  script: {
    label: "Master Script format",
    file: path.join(".forge", "scene-format.md"),
    defaultText: DEFAULT_SCENE_FORMAT,
    promptHeader: "Master Script format conventions (.forge/scene-format.md):",
  },
  beats: {
    label: "Beat format (legacy)",
    file: path.join(".forge", "beat-format.md"),
    defaultText: DEFAULT_BEAT_FORMAT,
    promptHeader: "Legacy beat format conventions (.forge/beat-format.md):",
  },
  shots: {
    label: "Shot format (legacy)",
    file: path.join(".forge", "shot-format.md"),
    defaultText: DEFAULT_SHOT_FORMAT,
    promptHeader: "Legacy shot format conventions (.forge/shot-format.md):",
  },
  prompts: {
    label: "Prompt format",
    file: path.join(".forge", "prompt-format.md"),
    defaultText: DEFAULT_PROMPT_FORMAT,
    promptHeader: "Prompt format conventions (.forge/prompt-format.md):",
  },
};

function isSupported(kind) {
  return Boolean(KIND_SPECS[kind]);
}

function specFor(kind) {
  if (!isSupported(kind)) throw new Error(`Unknown convention kind: ${kind}`);
  return KIND_SPECS[kind];
}

function fullPath(projectDir, kind) {
  return path.join(projectDir, specFor(kind).file);
}

async function readSectionConvention(projectDir, kind) {
  try {
    return await fs.readFile(fullPath(projectDir, kind), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

async function ensureSectionConvention(projectDir, kind) {
  const existing = await readSectionConvention(projectDir, kind);
  if (existing) return existing;
  return writeSectionConvention(projectDir, kind, specFor(kind).defaultText);
}

async function writeSectionConvention(projectDir, kind, text) {
  const cleaned = String(text || "").slice(0, MAX_CONV_CHARS);
  const file = fullPath(projectDir, kind);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, cleaned, "utf8");
  return cleaned;
}

async function resetSectionConvention(projectDir, kind) {
  return writeSectionConvention(projectDir, kind, specFor(kind).defaultText);
}

async function ensureAll(projectDir) {
  const out = {};
  for (const kind of DEFAULT_CONVENTION_KINDS) {
    try {
      out[kind] = await ensureSectionConvention(projectDir, kind);
    } catch {
      out[kind] = "";
    }
  }
  return out;
}

function promptHeaderFor(kind) {
  return specFor(kind).promptHeader;
}

function labelFor(kind) {
  return specFor(kind).label;
}

function relativePathFor(kind) {
  return specFor(kind).file;
}

module.exports = {
  DEFAULT_CONVENTION_KINDS,
  KIND_SPECS,
  isSupported,
  readSectionConvention,
  ensureSectionConvention,
  writeSectionConvention,
  resetSectionConvention,
  ensureAll,
  promptHeaderFor,
  labelFor,
  relativePathFor,
};
