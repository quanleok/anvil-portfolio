const fs = require("node:fs/promises");
const path = require("node:path");

const CONVENTIONS_FILE = path.join(".forge", "conventions.md");
const MAX_CONVENTIONS_CHARS = 12_000;

const DEFAULT_CONVENTIONS = `# Anvil project conventions

These rules are injected into every agent turn. Edit this file to change
how the agent names items, structures content, and writes to disk.

## Titles (most important — keep them short)
- 2 to 6 words. Never a full sentence. Never a paragraph.
- Title Case (capitalize main words). No trailing punctuation.
- Evocative > descriptive. "Bone Pile Detail" > "wide shot of a pile of bones in the cave".
- The user's prompt text is INPUT, not the title. Distill the title from the intent.
- For scenes: use the location/event, not a full plot sentence — e.g. "Forgotten Workshop", "First Strike".
- For clips: use the visual/action unit, not the whole scene — e.g. "Door Opens", "Strike And Bloom".
- For legacy shot files only: prefer "<camera/movement> <subject>" — e.g. "Wide Approach", "Tracking Battle".
- For asset entries (characters, locations, props, etc.): just the entity name. "Duelist", not "duelist warrior fighter character".

## Body content
- First line of any scene / clip body: a one-line summary.
- Then markdown sections with H2 headings as needed (e.g. "## Beats", "## Camera", "## Sound").
- Keep paragraphs tight — no walls of text.
- Preserve user-authored prompt text and confirm provider-supported settings when generation is requested.
- Do not put generated-take notes, video-bin decisions, or terminal transcript content in context/canon docs.

## File names
- Auto-generated from the title via slugify: lowercase, hyphens, no spaces. Don't try to override.
- Path conventions are enforced by the create_* tools — don't hand-craft paths.

## When in doubt
- Prefer the shortest correct option.
- Match patterns already established in the project (read the Master Script, scenes, and clips before adding new ones).
- The user's preference always wins over these defaults — if they ask for something specific, do that.
`;

function conventionsPath(projectDir) {
  return path.join(projectDir, CONVENTIONS_FILE);
}

async function readConventions(projectDir) {
  try {
    const raw = await fs.readFile(conventionsPath(projectDir), "utf8");
    return raw;
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

async function ensureConventions(projectDir) {
  const existing = await readConventions(projectDir);
  if (existing) return existing;
  await writeConventions(projectDir, DEFAULT_CONVENTIONS);
  return DEFAULT_CONVENTIONS;
}

async function writeConventions(projectDir, text) {
  const cleaned = String(text || "").slice(0, MAX_CONVENTIONS_CHARS);
  const file = conventionsPath(projectDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, cleaned, "utf8");
  return { path: CONVENTIONS_FILE, bytes: cleaned.length };
}

async function resetConventions(projectDir) {
  return writeConventions(projectDir, DEFAULT_CONVENTIONS);
}

module.exports = {
  CONVENTIONS_FILE,
  DEFAULT_CONVENTIONS,
  readConventions,
  ensureConventions,
  writeConventions,
  resetConventions,
};
