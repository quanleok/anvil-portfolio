const fs = require("node:fs/promises");
const path = require("node:path");

const STORY_SYSTEM_FILE = path.join(".forge", "story-system.md");
const MAX_STORY_SYSTEM_CHARS = 12_000;
const STORY_DOC_SPECS = [
  {
    key: "world-bible",
    path: "story/world-bible.md",
    title: "World Bible",
    contextGroup: "canon",
    purpose: "User-maintained story notes and references.",
    usedFor: ["Master Script", "Prompts", "Assets", "Workshop"],
    defaultText: `# World Bible

Optional notes and references for this project. Use the organization that fits
your work. The assistant should preserve your content and follow your requests.

## Notes

## References
`,
  },
];

const LEGACY_STORY_DOC_PATHS = new Set([
  "story/project-brief.md",
  "story/logline.md",
  "story/synopsis.md",
  "story/structure.md",
  "story/major-beats.md",
  "story/visual-storytelling-guide.md",
  "story/workshop-procedures.md",
]);

const DEFAULT_STORY_SYSTEM = `# Story system

Public file conventions. Private production methods are not included.

ANVIL.md holds project operating notes. Project Scope is in story/intake.md.
The World Bible is story/world-bible.md. Master Script is script/master-script.md.
The user's scene and prompt documents live in scenes/** and prompts/**.
Optional supporting material lives in shots/** or custom/**; custom/drafts/** is scratch space.
Use existing file structure and preserve user edits. Store media through the app's asset tools.
Ask before destructive changes, publication, or paid generation.
`;

function storySystemPath(projectDir) {
  return path.join(projectDir, STORY_SYSTEM_FILE);
}

async function readStorySystem(projectDir) {
  try {
    return await fs.readFile(storySystemPath(projectDir), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

async function writeStorySystem(projectDir, text) {
  const cleaned = String(text || "").slice(0, MAX_STORY_SYSTEM_CHARS);
  const file = storySystemPath(projectDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, cleaned, "utf8");
  return { path: STORY_SYSTEM_FILE, bytes: cleaned.length };
}

async function ensureStorySystem(projectDir) {
  const existing = await readStorySystem(projectDir);
  if (existing) return existing;
  await writeStorySystem(projectDir, DEFAULT_STORY_SYSTEM);
  return DEFAULT_STORY_SYSTEM;
}

async function ensureStoryScaffold(projectDir) {
  for (const spec of STORY_DOC_SPECS) {
    const file = path.join(projectDir, spec.path);
    try {
      await fs.access(file);
    } catch {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, spec.defaultText, "utf8");
    }
  }
}

module.exports = {
  LEGACY_STORY_DOC_PATHS,
  STORY_SYSTEM_FILE,
  STORY_DOC_SPECS,
  DEFAULT_STORY_SYSTEM,
  ensureStoryScaffold,
  ensureStorySystem,
  readStorySystem,
  writeStorySystem,
};
