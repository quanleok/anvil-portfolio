const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs/promises");
const path = require("node:path");

const { runTool, listTools } = require("../tools.cjs");

async function makeTempProject() {
  return fs.mkdtemp(path.join(os.tmpdir(), "forge-prefetch-"));
}

test("prefetch_context is registered as a core-tier tool", () => {
  const tools = listTools();
  const entry = tools.find((t) => t.name === "prefetch_context");
  assert.ok(entry, "prefetch_context should be registered");
  assert.equal(entry.tier, "core");
  assert.ok(entry.description.toLowerCase().includes("intent"));
});

test("prefetch_context fallback: unknown intent lists available intents", async () => {
  const projectDir = await makeTempProject();
  const result = await runTool(
    "prefetch_context",
    { intent: "not-a-real-intent" },
    { projectDir },
  );
  assert.equal(result.intent, "not-a-real-intent");
  assert.ok(result.note.includes("No prefetch bundle"));
  assert.ok(Array.isArray(result.availableIntents));
  // Should at least include the common ones we shipped.
  assert.ok(result.availableIntents.includes("write-prompt"));
  assert.ok(result.availableIntents.includes("refine-prompt"));
  assert.ok(result.availableIntents.includes("full-audit"));
});

test("prefetch_context full-audit runs on a minimal project without throwing", async () => {
  const projectDir = await makeTempProject();
  // Seed bare project so read_story_bundle has
  // something to look at; they should degrade gracefully either way.
  await fs.mkdir(path.join(projectDir, ".forge"), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, ".forge", "project.json"),
    JSON.stringify({
      version: 2,
      project: { id: "p", name: "T", createdAt: "", updatedAt: "" },
      settings: { sessionKey: "t" },
      folders: [],
      characters: [],
      locations: [],
      props: [],
      keyframes: [],
      audio: [],
    }),
    "utf8",
  );
  const result = await runTool("prefetch_context", { intent: "full-audit" }, { projectDir });
  assert.equal(result.intent, "full-audit");
  assert.equal(result.scope, "project-wide");
  assert.ok(typeof result.guidance === "string");
});

test("prefetch_context skill-miss is reported as placeholder, not thrown", async () => {
  const projectDir = await makeTempProject();
  // No .forge/skills/ present — read_skill should throw, prefetch should
  // catch and substitute a placeholder so the envelope still returns.
  const result = await runTool(
    "prefetch_context",
    { intent: "refine-prompt" },
    { projectDir },
  );
  assert.equal(result.intent, "refine-prompt");
  assert.ok(Array.isArray(result.skills));
  // Every skill entry should be either a real doc OR a { missing: true } stub.
  for (const s of result.skills) {
    assert.ok(s && typeof s === "object");
    assert.ok("missing" in s || "content" in s || "name" in s);
  }
  // Looks likewise.
  for (const l of result.looks || []) {
    assert.ok(l && typeof l === "object");
  }
});

test("prefetch_context write-dialogue works without a hidden protocol", async () => {
  const projectDir = await makeTempProject();
  const result = await runTool(
    "prefetch_context",
    { intent: "write-dialogue" },
    { projectDir },
  );
  assert.equal(result.intent, "write-dialogue");
  assert.deepEqual(result.skills, []);
  assert.equal(typeof result.guidance, "string");
  assert.ok(result.guidance.length > 0);
});

test("every skill referenced by prefetch bundles ships as a default skill", async () => {
  const prefetchSource = await fs.readFile(
    path.join(__dirname, "..", "system", "tools", "prefetch.cjs"),
    "utf8",
  );
  const defaultSkillFiles = await fs.readdir(path.join(__dirname, "..", "defaults", "skills"));
  const defaultSkills = new Set(
    defaultSkillFiles
      .filter((file) => file.endsWith(".md"))
      .map((file) => file.replace(/\.md$/, "")),
  );
  const referenced = new Set();
  for (const bundleMatch of prefetchSource.matchAll(/loadSkills\(\[([^\]]+)\]/g)) {
    for (const nameMatch of bundleMatch[1].matchAll(/["']([^"']+)["']/g)) {
      referenced.add(nameMatch[1]);
    }
  }

  const missing = [...referenced].filter((name) => !defaultSkills.has(name)).sort();
  assert.deepEqual(missing, []);
});
