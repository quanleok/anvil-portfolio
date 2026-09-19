const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs/promises");
const path = require("node:path");

const {
  STORY_DOC_SPECS,
  STORY_SYSTEM_FILE,
  DEFAULT_STORY_SYSTEM,
  ensureStoryScaffold,
  ensureStorySystem,
  readStorySystem,
} = require("../story-system.cjs");

async function tmpProject() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "anvil-story-"));
}

test("ensureStoryScaffold seeds canonical story docs", async () => {
  const dir = await tmpProject();
  await ensureStoryScaffold(dir);

  assert.equal(STORY_DOC_SPECS.length, 1);
  for (const spec of STORY_DOC_SPECS) {
    const text = await fs.readFile(path.join(dir, spec.path), "utf8");
    assert.equal(text, spec.defaultText);
    assert.ok(text.startsWith(`# ${spec.title}`));
  }
});

test("ensureStorySystem seeds the authority rules file", async () => {
  const dir = await tmpProject();
  const first = await ensureStorySystem(dir);
  assert.equal(first, DEFAULT_STORY_SYSTEM);

  const second = await readStorySystem(dir);
  assert.equal(second, DEFAULT_STORY_SYSTEM);

  const saved = await fs.readFile(path.join(dir, STORY_SYSTEM_FILE), "utf8");
  assert.ok(saved.includes("ANVIL.md"));
  assert.ok(saved.includes("project operating notes"));
  assert.ok(saved.includes("Project Scope"));
  assert.ok(!saved.includes("story/project-brief.md"));
  assert.ok(saved.includes("story/world-bible.md"));
  assert.ok(saved.includes("World Bible"));
  assert.ok(saved.includes("script/master-script.md"));
  assert.ok(saved.includes("Private production methods are not included"));
  assert.ok(saved.includes("preserve user edits"));  assert.ok(!saved.includes("story/major-beats.md"));
  assert.ok(!saved.includes("story/visual-storytelling-guide.md"));
});
