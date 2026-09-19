const fs = require("node:fs/promises");
const path = require("node:path");
const { atomicWriteFile } = require("./atomic-write.cjs");

// External-agent entrypoints scaffolded at project root so Codex and Claude
// Code pick up an Anvil project without app-side chat context. Content is
// identical to avoid drift. AGENTS.md is intentionally present because Codex
// discovers the plural filename; AGENT.md stays as a compatibility entrypoint
// for other local agents. The user-facing UI note lives separately in .forge/.

const AGENT_FILE = "AGENT.md";
const CODEX_FILE = "AGENTS.md";
const LOWER_AGENT_FILE = "agent.md";
const LEGACY_AGENTS_FILE = CODEX_FILE;
const CLAUDE_FILE = "CLAUDE.md";
const AGENT_NOTE_FILE = ".forge/agent-note.md";
const ENTRYPOINT_FILES = new Set([AGENT_FILE, CODEX_FILE, CLAUDE_FILE]);
const MAX_ENTRYPOINT_CHARS = 24_000;
const MAX_AGENT_NOTE_CHARS = 24_000;

const DEFAULT_AGENT_NOTE = `# Agent Note

`;

const DEFAULT_ENTRYPOINT = `# Project agent guide

<!-- anvil-public-agent-guide -->

You are an Anvil agent using a public workspace example. Codex, Claude Code,
and other local tools can read and edit this project. Private production
methods are not included.

## Authority order
Read the user's instructions, ANVIL.md, and relevant project files. Project Scope
is story/intake.md. Read .forge/agent-note.md for any user handoff notes.

## File and tool safety
Preserve user edits and use the existing directory layout. .forge/ is app state;
only .forge/agent-note.md is a general writing target. Use dedicated tools for
metadata and asset operations. assets/INDEX.md maps cards to media[].path.
Read .forge/integrations.md for provider settings. Unbound imports belong in
assets/library/. assets/inbox/ is a temporary trash/review lane with optional assets/inbox/.pending/ markers.

Write requested content to the appropriate story/, script/, scenes/, prompts/,
or user-created custom/ files. Report changed paths after saving. Do not store
credentials in project documents. Ask before paid generation, publication,
deleting files, or replacing substantial user work.
`;

function isGeneratedEntryPoint(content) {
  const value = String(content || "");
  if (!value.trim()) return false;
  if (!value.startsWith("# Project agent guide")) return false;
  if (!value.includes("ANVIL.md") || !value.includes(".forge/")) return false;
  return (
    value.includes("<!-- anvil-public-agent-guide -->") ||
    value.includes("For everything else, read `ANVIL.md`.") ||
    value.includes("The authoritative guide for this project is `ANVIL.md`") ||
    value.includes("You are now operating as an **Anvil agent**")
  );
}

async function readIfPresent(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function ensureOne(projectDir, fileName) {
  const target = path.join(projectDir, fileName);
  const existing = await readIfPresent(target);
  if (existing !== null) {
    if (existing !== DEFAULT_ENTRYPOINT && isGeneratedEntryPoint(existing)) {
      await atomicWriteFile(target, DEFAULT_ENTRYPOINT);
      return DEFAULT_ENTRYPOINT;
    }
    return existing;
  }
  await fs.mkdir(projectDir, { recursive: true });
  await atomicWriteFile(target, DEFAULT_ENTRYPOINT);
  return DEFAULT_ENTRYPOINT;
}

async function removeGeneratedFile(filePath) {
  const existing = await readIfPresent(filePath);
  if (existing !== null && isGeneratedEntryPoint(existing)) {
    await fs.rm(filePath, { force: true });
  }
}

async function migrateLegacyAgentFiles(projectDir) {
  await fs.mkdir(projectDir, { recursive: true });
  const lower = path.join(projectDir, LOWER_AGENT_FILE);
  const agent = path.join(projectDir, AGENT_FILE);
  const entries = await fs.readdir(projectDir).catch(() => []);
  const hasLower = entries.includes(LOWER_AGENT_FILE);
  const hasAgent = entries.includes(AGENT_FILE);

  if (hasLower && !hasAgent) {
    const temp = path.join(projectDir, `.agent-md-rename-${Date.now()}.tmp`);
    await fs.rename(lower, temp);
    await fs.rename(temp, agent);
  } else if (hasLower) {
    await removeGeneratedFile(lower);
  }

  // AGENTS.md used to be treated as a removable legacy file after the app
  // switched to AGENT.md. That broke Codex discovery. Keep it now; ensureOne()
  // below will refresh generated old content while preserving user edits.
}

async function ensureAgentEntrypoints(projectDir) {
  await migrateLegacyAgentFiles(projectDir).catch(() => {});
  const [agent, agents, claude] = await Promise.all([
    ensureOne(projectDir, AGENT_FILE),
    ensureOne(projectDir, CODEX_FILE),
    ensureOne(projectDir, CLAUDE_FILE),
  ]);
  return { agent, agents, claude };
}

function normalizeEntrypointFile(fileName) {
  const clean = String(fileName || "").trim();
  if (!ENTRYPOINT_FILES.has(clean)) {
    throw new Error(`Unsupported agent entrypoint: ${clean || "(empty)"}`);
  }
  return clean;
}

async function writeAgentEntrypoint(projectDir, fileName, text) {
  const targetFile = normalizeEntrypointFile(fileName);
  const original = String(text || "");
  const cleaned = original.slice(0, MAX_ENTRYPOINT_CHARS);
  await fs.mkdir(projectDir, { recursive: true });
  await atomicWriteFile(path.join(projectDir, targetFile), cleaned);
  return {
    path: targetFile,
    bytes: cleaned.length,
    originalBytes: original.length,
    truncated: original.length > MAX_ENTRYPOINT_CHARS,
    maxBytes: MAX_ENTRYPOINT_CHARS,
  };
}

async function ensureAgentNote(projectDir) {
  const target = path.join(projectDir, AGENT_NOTE_FILE);
  const existing = await readIfPresent(target);
  if (existing !== null) {
    return { path: AGENT_NOTE_FILE, content: existing };
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await atomicWriteFile(target, DEFAULT_AGENT_NOTE);
  return { path: AGENT_NOTE_FILE, content: DEFAULT_AGENT_NOTE };
}

async function writeAgentNote(projectDir, text) {
  const target = path.join(projectDir, AGENT_NOTE_FILE);
  const original = String(text || "");
  const cleaned = original.slice(0, MAX_AGENT_NOTE_CHARS);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await atomicWriteFile(target, cleaned);
  return {
    path: AGENT_NOTE_FILE,
    bytes: cleaned.length,
    originalBytes: original.length,
    truncated: original.length > MAX_AGENT_NOTE_CHARS,
    maxBytes: MAX_AGENT_NOTE_CHARS,
  };
}

module.exports = {
  AGENT_FILE,
  AGENT_NOTE_FILE,
  CODEX_FILE,
  LOWER_AGENT_FILE,
  LEGACY_AGENTS_FILE,
  CLAUDE_FILE,
  DEFAULT_AGENT_NOTE,
  DEFAULT_ENTRYPOINT,
  ensureAgentEntrypoints,
  ensureAgentNote,
  isGeneratedEntryPoint,
  writeAgentNote,
  writeAgentEntrypoint,
};
