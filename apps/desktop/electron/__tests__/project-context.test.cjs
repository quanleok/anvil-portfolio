const test = require("node:test");
const assert = require("node:assert/strict");

const { defaultContext } = require("../project-context.cjs");

test("default project context carries compact SOP without separate brief", () => {
  const text = defaultContext("Context Lab Demo");
  assert.ok(text.startsWith("# Anvil Agent Protocol"));
  assert.ok(text.includes('"Context Lab Demo"'));
  assert.ok(text.includes("## Workflow Preferences"));
  assert.ok(text.includes("## Priority Rules"));
  assert.ok(text.includes("## Hard Constraints"));
  assert.ok(text.includes("## Directory Rules"));
  assert.ok(text.includes("## SOP"));
  assert.ok(!text.includes("story/project-brief.md"));
  assert.ok(!text.includes(".forge/agent-log.md"));
  assert.ok(text.includes("story/intake.md"));
  assert.ok(text.includes("story/world-bible.md"));
  assert.ok(text.includes("script/master-script.md"));
  assert.ok(text.includes("prompts/**"));
  assert.ok(text.includes("assets/INDEX.md"));
  assert.ok(text.includes("assets/library/"));
  assert.ok(text.includes("assets/inbox/"));
  assert.ok(text.includes(".forge/integrations.md"));
  assert.ok(text.includes("Private production methods are not included"));
  assert.ok(text.includes("Ask before destructive operations"));

  assert.ok(!text.includes("## Cast bible"));
  assert.ok(!text.includes("## Locations"));
  assert.ok(!text.includes("## Tone & references"));
  assert.ok(!text.includes("## What this is"));
  assert.ok(!text.includes("## Project Direction"));
  assert.ok(!text.includes("## Taste And Constraints"));
});
