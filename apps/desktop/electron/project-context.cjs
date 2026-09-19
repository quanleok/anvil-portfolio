const fs = require("node:fs/promises");
const path = require("node:path");
const { atomicWriteFile } = require("./atomic-write.cjs");

const CONTEXT_FILE = "ANVIL.md";
const MAX_CONTEXT_CHARS = 24_000;

function defaultContext(projectName = "Untitled project") {
  return `# Anvil Agent Protocol

Public workspace notes for "${projectName}". Private production methods are not included.

## Workflow Preferences
Follow the user's request. Preserve existing work and keep edits easy to review.

## Priority Rules
Read ANVIL.md and the user's selected files before making changes. Ask when instructions conflict.

## Hard Constraints
Use the application's tools for metadata and bound media. Do not change credentials.
.forge/ is application state; generic file edits are limited to .forge/agent-note.md.
Ask before destructive operations, publication, or paid generation.

## Directory Rules
story/intake.md contains Project Scope. story/world-bible.md contains the World Bible.
script/master-script.md, scenes/**, and prompts/** contain the user's writing.
shots/** and custom/** are optional user files. custom/drafts/** is scratch space.
assets/INDEX.md maps assets to media[].path. assets/library/ holds imported media.
assets/inbox/ is temporary recovery space. Read .forge/integrations.md for provider settings.

## SOP
Read relevant files, make the requested changes with appropriate tools, then report changed paths.
The public example supplies file conventions only, not a prescribed creative production method.
`;
}

function contextPath(projectDir) {
  return path.join(projectDir, CONTEXT_FILE);
}

async function readProjectContext(projectDir) {
  try {
    return await fs.readFile(contextPath(projectDir), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

async function ensureProjectContext(projectDir, projectName) {
  const existing = await readProjectContext(projectDir);
  if (existing) return existing;
  const seed = defaultContext(projectName);
  await fs.mkdir(projectDir, { recursive: true });
  await atomicWriteFile(contextPath(projectDir), seed);
  return seed;
}

async function writeProjectContext(projectDir, text) {
  const original = String(text || "");
  const cleaned = original.slice(0, MAX_CONTEXT_CHARS);
  await fs.mkdir(projectDir, { recursive: true });
  await atomicWriteFile(contextPath(projectDir), cleaned);
  // Surface whether the cap silently dropped content so the renderer can
  // warn the user instead of losing 6 KB of pasted project context.
  // Audit H5 (2026-04-20).
  return {
    path: CONTEXT_FILE,
    bytes: cleaned.length,
    originalBytes: original.length,
    truncated: original.length > MAX_CONTEXT_CHARS,
    maxBytes: MAX_CONTEXT_CHARS,
  };
}

module.exports = {
  CONTEXT_FILE,
  defaultContext,
  readProjectContext,
  ensureProjectContext,
  writeProjectContext,
};
