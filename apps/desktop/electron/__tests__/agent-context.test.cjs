const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs/promises");
const path = require("node:path");

const { buildAgentContext, applyPostToolInvalidation } = require("../agent-context.cjs");

async function makeProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-agentctx-"));
  await fs.mkdir(path.join(dir, ".forge"), { recursive: true });
  await fs.writeFile(path.join(dir, ".forge", "project.json"), "{}");
  await fs.writeFile(path.join(dir, ".forge", "agent-note.md"), "# Agent Note\n\n");
  await fs.mkdir(path.join(dir, "scenes"), { recursive: true });
  await fs.writeFile(path.join(dir, "scenes", "scene-01.md"), "# Scene 1");
  await fs.mkdir(path.join(dir, "assets", "characters"), { recursive: true });
  await fs.writeFile(path.join(dir, "assets", "characters", "duelist.jpg"), "");
  return dir;
}

test("autoCorrect maps bare project.json to .forge/project.json", async () => {
  const dir = await makeProject();
  const ctx = await buildAgentContext(dir);
  const result = ctx.snapshot.autoCorrect("project.json", "file");
  assert.ok(result);
  assert.equal(result.path, ".forge/project.json");
  assert.equal(result.reason, "alias");
});

test("autoCorrect maps agent note aliases to .forge/agent-note.md", async () => {
  const dir = await makeProject();
  const ctx = await buildAgentContext(dir);
  const result = ctx.snapshot.autoCorrect("agent note", "file");
  assert.ok(result);
  assert.equal(result.path, ".forge/agent-note.md");
  assert.equal(result.reason, "alias");
});

test("autoCorrect adds .md extension for scene names", async () => {
  const dir = await makeProject();
  const ctx = await buildAgentContext(dir);
  const result = ctx.snapshot.autoCorrect("scenes/scene-01", "file");
  assert.ok(result);
  assert.equal(result.path, "scenes/scene-01.md");
  assert.equal(result.reason, "added .md");
});

test("autoCorrect finds same basename in a different directory", async () => {
  const dir = await makeProject();
  const ctx = await buildAgentContext(dir);
  const result = ctx.snapshot.autoCorrect("duelist.jpg", "file");
  assert.ok(result);
  assert.equal(result.path, "assets/characters/duelist.jpg");
});

test("autoCorrect returns null for a genuinely unknown path", async () => {
  const dir = await makeProject();
  const ctx = await buildAgentContext(dir);
  const result = ctx.snapshot.autoCorrect("this/does/not/exist.txt", "file");
  assert.equal(result, null);
});

test("suggest returns ranked nearest paths", async () => {
  const dir = await makeProject();
  const ctx = await buildAgentContext(dir);
  const suggestions = ctx.snapshot.suggest("scenes/scene", { kind: "file" });
  assert.ok(suggestions.includes("scenes/scene-01.md"));
});

test("cache returns cached value and invalidatePath clears it", async () => {
  const dir = await makeProject();
  const ctx = await buildAgentContext(dir);
  ctx.cache.set("read_file", { path: "scenes/scene-01.md" }, { content: "hello" });
  const cached = ctx.cache.get("read_file", { path: "scenes/scene-01.md" });
  assert.deepEqual(cached, { content: "hello" });

  applyPostToolInvalidation(ctx, "write_file", { path: "scenes/scene-01.md" }, { ok: true });
  const after = ctx.cache.get("read_file", { path: "scenes/scene-01.md" });
  assert.equal(after, undefined);
});

test("rename_paths invalidation clears both from and to", async () => {
  const dir = await makeProject();
  const ctx = await buildAgentContext(dir);
  ctx.cache.set("read_file", { path: "old.md" }, { content: "a" });
  ctx.cache.set("read_file", { path: "new.md" }, { content: "b" });
  applyPostToolInvalidation(ctx, "rename_paths", { items: [{ from: "old.md", to: "new.md" }] }, {});
  assert.equal(ctx.cache.get("read_file", { path: "old.md" }), undefined);
  assert.equal(ctx.cache.get("read_file", { path: "new.md" }), undefined);
});

test("outline lists top-level directories with file counts", async () => {
  const dir = await makeProject();
  const ctx = await buildAgentContext(dir);
  assert.ok(ctx.snapshot.outline.includes("scenes/"));
  assert.ok(ctx.snapshot.outline.includes("assets/"));
});
