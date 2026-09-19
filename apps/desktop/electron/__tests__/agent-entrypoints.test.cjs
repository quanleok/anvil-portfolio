const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const {
  AGENT_FILE,
  AGENT_NOTE_FILE,
  CODEX_FILE,
  CLAUDE_FILE,
  DEFAULT_AGENT_NOTE,
  DEFAULT_ENTRYPOINT,
  ensureAgentEntrypoints,
  ensureAgentNote,
  LEGACY_AGENTS_FILE,
  LOWER_AGENT_FILE,
  writeAgentNote,
  writeAgentEntrypoint,
} = require("../agent-entrypoints.cjs");

async function makeProject() {
  return fs.mkdtemp(path.join(os.tmpdir(), "anvil-agent-entrypoints-"));
}

test("fresh project: ensureAgentEntrypoints writes AGENT.md, AGENTS.md, and CLAUDE.md with default content", async () => {
  const proj = await makeProject();
  try {
    const result = await ensureAgentEntrypoints(proj);
    assert.equal(result.agent, DEFAULT_ENTRYPOINT);
    assert.equal(result.agents, DEFAULT_ENTRYPOINT);
    assert.equal(result.claude, DEFAULT_ENTRYPOINT);

    const agentOnDisk = await fs.readFile(path.join(proj, AGENT_FILE), "utf8");
    const agentsOnDisk = await fs.readFile(path.join(proj, CODEX_FILE), "utf8");
    const claudeOnDisk = await fs.readFile(path.join(proj, CLAUDE_FILE), "utf8");
    assert.equal(agentOnDisk, DEFAULT_ENTRYPOINT);
    assert.equal(agentsOnDisk, DEFAULT_ENTRYPOINT);
    assert.equal(claudeOnDisk, DEFAULT_ENTRYPOINT);
    const entries = await fs.readdir(proj);
    assert.ok(!entries.includes(LOWER_AGENT_FILE));
    assert.ok(entries.includes(CODEX_FILE));
  } finally {
    await fs.rm(proj, { recursive: true, force: true });
  }
});

test("both present: ensureAgentEntrypoints preserves user-edited content", async () => {
  const proj = await makeProject();
  try {
    const edited = "# my edited entrypoint\n\nhand-written\n";
    await fs.writeFile(path.join(proj, AGENT_FILE), edited, "utf8");
    await fs.writeFile(path.join(proj, CODEX_FILE), edited, "utf8");
    await fs.writeFile(path.join(proj, CLAUDE_FILE), edited, "utf8");

    const result = await ensureAgentEntrypoints(proj);
    assert.equal(result.agent, edited);
    assert.equal(result.agents, edited);
    assert.equal(result.claude, edited);

    const agentOnDisk = await fs.readFile(path.join(proj, AGENT_FILE), "utf8");
    const agentsOnDisk = await fs.readFile(path.join(proj, CODEX_FILE), "utf8");
    const claudeOnDisk = await fs.readFile(path.join(proj, CLAUDE_FILE), "utf8");
    assert.equal(agentOnDisk, edited);
    assert.equal(agentsOnDisk, edited);
    assert.equal(claudeOnDisk, edited);
  } finally {
    await fs.rm(proj, { recursive: true, force: true });
  }
});

test("generated old defaults are refreshed to the current Anvil agent preamble", async () => {
  const proj = await makeProject();
  try {
    const oldGenerated = `# Project agent guide

You are assisting on an **Anvil** film project — a local-first filmmaking
workspace. The authoritative guide for this project is \`ANVIL.md\`. Read it
before editing anything.

## Hard constraints

- \`.forge/\` is app state.

For everything else, read \`ANVIL.md\`.
`;
    await fs.writeFile(path.join(proj, AGENT_FILE), oldGenerated, "utf8");
    await fs.writeFile(path.join(proj, CODEX_FILE), oldGenerated, "utf8");
    await fs.writeFile(path.join(proj, CLAUDE_FILE), oldGenerated, "utf8");

    const result = await ensureAgentEntrypoints(proj);
    assert.equal(result.agent, DEFAULT_ENTRYPOINT);
    assert.equal(result.agents, DEFAULT_ENTRYPOINT);
    assert.equal(result.claude, DEFAULT_ENTRYPOINT);
  } finally {
    await fs.rm(proj, { recursive: true, force: true });
  }
});

test("generated public guide refreshes while custom content remains intact", async () => {
  const proj = await makeProject();
  try {
    const oldPublic = "# Project agent guide\n\n<!-- anvil-public-agent-guide -->\nANVIL.md and .forge/ notes from an older example.\n";
    const custom = "# Project agent guide\n\nMy own instructions for ANVIL.md and .forge/.\n";
    await fs.writeFile(path.join(proj, AGENT_FILE), oldPublic);
    await fs.writeFile(path.join(proj, CLAUDE_FILE), custom);
    const result = await ensureAgentEntrypoints(proj);
    assert.equal(result.agent, DEFAULT_ENTRYPOINT);
    assert.equal(result.claude, custom);
  } finally {
    await fs.rm(proj, { recursive: true, force: true });
  }
});

test("lowercase agent.md is migrated to AGENT.md without losing edits", async () => {
  const proj = await makeProject();
  try {
    const edited = "# Project agent guide\n\ncustom local edits with ANVIL.md and .forge/ notes\n";
    await fs.writeFile(path.join(proj, LOWER_AGENT_FILE), edited, "utf8");

    const result = await ensureAgentEntrypoints(proj);
    assert.equal(result.agent, edited);

    const agentOnDisk = await fs.readFile(path.join(proj, AGENT_FILE), "utf8");
    assert.equal(agentOnDisk, edited);

    const entries = await fs.readdir(proj);
    assert.ok(entries.includes(AGENT_FILE));
    assert.ok(!entries.includes(LOWER_AGENT_FILE));
  } finally {
    await fs.rm(proj, { recursive: true, force: true });
  }
});

test("generated lowercase agent doc is removed but AGENTS.md is kept for Codex discovery", async () => {
  const proj = await makeProject();
  try {
    await fs.writeFile(path.join(proj, LOWER_AGENT_FILE), DEFAULT_ENTRYPOINT, "utf8");
    await fs.writeFile(path.join(proj, LEGACY_AGENTS_FILE), DEFAULT_ENTRYPOINT, "utf8");
    await ensureAgentEntrypoints(proj);

    const entries = await fs.readdir(proj);
    assert.ok(entries.includes(AGENT_FILE));
    assert.ok(entries.includes(CODEX_FILE));
    assert.ok(entries.includes(CLAUDE_FILE));
    assert.ok(!entries.includes(LOWER_AGENT_FILE));
  } finally {
    await fs.rm(proj, { recursive: true, force: true });
  }
});

test("partial presence: ensureAgentEntrypoints writes only the missing file", async () => {
  const proj = await makeProject();
  try {
    const edited = "# only claude edited\n";
    await fs.writeFile(path.join(proj, CLAUDE_FILE), edited, "utf8");

    const result = await ensureAgentEntrypoints(proj);
    assert.equal(result.agent, DEFAULT_ENTRYPOINT);
    assert.equal(result.claude, edited);

    const agentOnDisk = await fs.readFile(path.join(proj, AGENT_FILE), "utf8");
    const claudeOnDisk = await fs.readFile(path.join(proj, CLAUDE_FILE), "utf8");
    assert.equal(agentOnDisk, DEFAULT_ENTRYPOINT);
    assert.equal(claudeOnDisk, edited);
  } finally {
    await fs.rm(proj, { recursive: true, force: true });
  }
});

test("writeAgentEntrypoint only writes supported root preamble files", async () => {
  const proj = await makeProject();
  try {
    const result = await writeAgentEntrypoint(proj, AGENT_FILE, "# custom\n");
    assert.equal(result.path, AGENT_FILE);
    assert.equal(await fs.readFile(path.join(proj, AGENT_FILE), "utf8"), "# custom\n");
    const codexResult = await writeAgentEntrypoint(proj, CODEX_FILE, "# codex custom\n");
    assert.equal(codexResult.path, CODEX_FILE);
    assert.equal(await fs.readFile(path.join(proj, CODEX_FILE), "utf8"), "# codex custom\n");
    await assert.rejects(() => writeAgentEntrypoint(proj, "README.md", "bad"));
  } finally {
    await fs.rm(proj, { recursive: true, force: true });
  }
});

test("agent note is a separate user-facing .forge markdown file", async () => {
  const proj = await makeProject();
  try {
    const created = await ensureAgentNote(proj);
    assert.equal(created.path, AGENT_NOTE_FILE);
    assert.equal(created.content, DEFAULT_AGENT_NOTE);
    assert.equal(await fs.readFile(path.join(proj, AGENT_NOTE_FILE), "utf8"), DEFAULT_AGENT_NOTE);

    const updated = await writeAgentNote(proj, "# Agent Note\n\nKeep the cut quiet.\n");
    assert.equal(updated.path, AGENT_NOTE_FILE);
    assert.equal(
      await fs.readFile(path.join(proj, AGENT_NOTE_FILE), "utf8"),
      "# Agent Note\n\nKeep the cut quiet.\n",
    );

    const reread = await ensureAgentNote(proj);
    assert.equal(reread.content, "# Agent Note\n\nKeep the cut quiet.\n");
  } finally {
    await fs.rm(proj, { recursive: true, force: true });
  }
});

test("DEFAULT_ENTRYPOINT includes identity, authority order, ANVIL.md, and Project Scope pointers", () => {
  assert.ok(DEFAULT_ENTRYPOINT.includes("Anvil"), "should mention Anvil");
  assert.ok(DEFAULT_ENTRYPOINT.includes("Anvil agent"), "should define Anvil agent identity");
  assert.ok(DEFAULT_ENTRYPOINT.includes("ANVIL.md"), "should point at ANVIL.md");
  assert.ok(DEFAULT_ENTRYPOINT.includes("story/intake.md"), "should point at Project Scope");
  assert.ok(DEFAULT_ENTRYPOINT.includes("Project Scope"), "should name Project Scope");
  assert.ok(DEFAULT_ENTRYPOINT.includes(".forge/agent-note.md"), "should point agents at Agent Note");
  assert.ok(!DEFAULT_ENTRYPOINT.includes("project-brief"), "should not point agents at removed Project Brief");
  assert.ok(DEFAULT_ENTRYPOINT.includes("Codex"), "should mention Codex");
  assert.ok(DEFAULT_ENTRYPOINT.includes("Claude Code"), "should mention Claude Code");
  assert.ok(/authority order/i.test(DEFAULT_ENTRYPOINT), "should include authority order");
  assert.ok(DEFAULT_ENTRYPOINT.includes(".forge/"), "should mention .forge/ as app state");
  assert.ok(DEFAULT_ENTRYPOINT.includes("assets/INDEX.md"), "should point agents at generated asset bindings");
  assert.ok(DEFAULT_ENTRYPOINT.includes("media[].path"), "should explain card-bound media paths");
  assert.ok(DEFAULT_ENTRYPOINT.includes(".forge/integrations.md"), "should point agents at provider routing");
  assert.ok(DEFAULT_ENTRYPOINT.includes("assets/library/"), "should tell agents to put untargeted generated media in All media");
  assert.ok(DEFAULT_ENTRYPOINT.includes("temporary trash/review"), "should explain inbox is only a temporary review/trash lane");
  assert.ok(DEFAULT_ENTRYPOINT.includes("assets/inbox/.pending/"), "should document optional inbox pending markers");
  assert.ok(DEFAULT_ENTRYPOINT.includes("Private production\nmethods are not included"), "should disclose the public example boundary");
});
