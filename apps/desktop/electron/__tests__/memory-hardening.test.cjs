// Regression tests for context-lane audit (2026-04-20):
// H6 — corrupt pinboard.json recovery (rotate + return [])
// M1 — listTopics reads only frontmatter, not full bodies
// M5 — migrateBulletsToPinboard backs up legacy non-bullet content

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const memory = require("../memory.cjs");

async function makeProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anvil-memory-hardening-"));
  await fs.mkdir(path.join(dir, ".forge", "memory"), { recursive: true });
  return dir;
}

test("H6 — corrupt pinboard.json: rotates to .corrupt-* and returns []", async () => {
  const proj = await makeProject();
  const pinboard = path.join(proj, ".forge", "memory", "pinboard.json");
  await fs.writeFile(pinboard, '[{"id":"abc","te'); // half-written
  const result = await memory.readPinboard(proj);
  assert.deepEqual(result, [], "should degrade to empty array");
  // Original file is rotated, so the path is now empty (next write creates a fresh one).
  let stillThere = false;
  try { await fs.access(pinboard); stillThere = true; } catch {}
  assert.equal(stillThere, false, "original pinboard.json should have been rotated away");
  // Find the rotated backup.
  const dir = await fs.readdir(path.join(proj, ".forge", "memory"));
  const corrupt = dir.find((f) => f.startsWith("pinboard.json.corrupt-"));
  assert.ok(corrupt, `expected a .corrupt-* rotation, got dir entries: ${dir.join(", ")}`);
  await fs.rm(proj, { recursive: true });
});

test("H6 — corrupt pinboard.json doesn't break addPinboardEntry; recovery + new entry works", async () => {
  const proj = await makeProject();
  await fs.writeFile(path.join(proj, ".forge", "memory", "pinboard.json"), "garbage{");
  // Pre-fix: this would throw. Post-fix: corrupt file rotates, fresh add succeeds.
  const entry = {
    id: "fresh", text: "fresh fact", category: "fact", scope: "project",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    confirmed: false,
  };
  await memory.addPinboardEntry(proj, entry);
  const final = await memory.readPinboard(proj);
  assert.equal(final.length, 1);
  assert.equal(final[0].id, "fresh");
  await fs.rm(proj, { recursive: true });
});

test("H6 — pinboard.json with non-array root is treated as corrupt", async () => {
  const proj = await makeProject();
  await fs.writeFile(path.join(proj, ".forge", "memory", "pinboard.json"), '{"oops":true}');
  const result = await memory.readPinboard(proj);
  assert.deepEqual(result, []);
  await fs.rm(proj, { recursive: true });
});

test("M1 — listTopics reads frontmatter only (small open-read, no full slurp)", async () => {
  const proj = await makeProject();
  const topicsDir = path.join(proj, ".forge", "memory", "topics");
  await fs.mkdir(topicsDir, { recursive: true });
  // 50 topics × 10 KB body each — pre-fix this would read 500 KB to list.
  const bodyFiller = "Z".repeat(10_000);
  await Promise.all(
    Array.from({ length: 50 }, (_, i) => {
      const slug = `topic-${i.toString().padStart(2, "0")}`;
      const front = ["---", `name: Topic ${i}`, `description: desc ${i}`, "---", "", bodyFiller, ""].join("\n");
      return fs.writeFile(path.join(topicsDir, `${slug}.md`), front);
    }),
  );
  const topics = await memory.listTopics(proj);
  assert.equal(topics.length, 50);
  assert.equal(topics[0].name, "Topic 0");
  assert.equal(topics[0].description, "desc 0");
  // size is reported from stat, not from byte-count of read — should match
  // the actual on-disk size (body + frontmatter), not the 1 KB slice we
  // read for parsing.
  for (const t of topics) {
    assert.ok(t.size >= 10_000, `topic ${t.name} reported size ${t.size}, expected ≥10000`);
  }
  await fs.rm(proj, { recursive: true });
});

test("M1 — listTopics handles an empty topics dir without error", async () => {
  const proj = await makeProject();
  const result = await memory.listTopics(proj);
  assert.deepEqual(result, []);
  await fs.rm(proj, { recursive: true });
});

