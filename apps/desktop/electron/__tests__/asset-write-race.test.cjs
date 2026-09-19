// Regression test for asset-C1 (audit 2026-04-20): every asset CRUD tool
// writes project.json via the writeProjectMetadata helper. Pre-fix that
// helper was a direct fs.writeFile that bypassed both the per-project
// write queue AND the atomic write — so parallel tool calls in one agent
// turn (Promise.all dispatch) raced and lost entries OR crashed with
// ENOENT on shared .tmp.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

// We import writeProjectMetadata via the module's exports object (it's
// hoisted onto module.exports in builtins.cjs). The helper takes
// (projectDir, metadata) and is the same function exposed to every
// asset CRUD tool via the api shape.
const builtins = require("../system/tools/builtins.cjs");

async function makeProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anvil-asset-race-"));
  await fs.mkdir(path.join(dir, ".forge"), { recursive: true });
  // Seed a minimal project.json so the rotate-to-bak path exercises.
  await fs.writeFile(
    path.join(dir, ".forge", "project.json"),
    JSON.stringify({ project: { id: "p", name: "test" }, characters: [], locations: [], props: [], keyframes: [], audio: [], library: [] }),
  );
  return dir;
}

async function readProjectJson(projectDir) {
  const raw = await fs.readFile(path.join(projectDir, ".forge", "project.json"), "utf8");
  return JSON.parse(raw);
}

function makeChar(id) {
  return { id, name: `char-${id}`, content: "", path: `characters/${id}.md`, media: [] };
}

test("writeProjectMetadata: 8 parallel writes — all serialize, last write is intact", async () => {
  const proj = await makeProject();
  // Each writer simulates a different create_asset_entry by reading
  // project.json, pushing one character, writing back.
  const N = 8;
  await Promise.all(
    Array.from({ length: N }, async (_, i) => {
      const current = await readProjectJson(proj);
      const next = {
        ...current,
        characters: [...(current.characters || []), makeChar(i)],
      };
      await builtins.writeProjectMetadata(proj, next);
    }),
  );
  // With the lock + atomic write in place, every write completes without
  // ENOENT; the last writer wins on content. The "lost-update" symptom
  // (last writer's character is the only one that survived because each
  // writer started from the same read) is the EXPECTED post-fix behavior
  // for this test shape — the per-call mutex serializes the writes,
  // but each call still does its own read→modify→write. The agent-side
  // fix is to NOT batch parallel writes that depend on the same read;
  // the dispatcher-level serializeWith plan absorbs that.
  //
  // What we explicitly test here:
  // 1. ZERO ENOENT crashes (the C1 symptom that broke pinboard).
  // 2. project.json ends up valid JSON (atomic write succeeded).
  // 3. .bak rotation produced a recoverable backup.
  const final = await readProjectJson(proj);
  assert.ok(Array.isArray(final.characters), "characters survived as array");
  assert.ok(final.characters.length >= 1, "at least one character landed");
  // .bak should exist after the second write (first write rotates nothing).
  const bakStat = await fs.stat(path.join(proj, ".forge", "project.json.bak"));
  assert.ok(bakStat.isFile(), "project.json.bak created during writes");
  await fs.rm(proj, { recursive: true });
});

test("writeProjectMetadata: serialized writes — each sees the previous write's effect", async () => {
  // Sequential awaits inside each step — proves the lock makes a chain.
  const proj = await makeProject();
  const N = 5;
  for (let i = 0; i < N; i++) {
    const current = await readProjectJson(proj);
    const next = { ...current, characters: [...(current.characters || []), makeChar(i)] };
    await builtins.writeProjectMetadata(proj, next);
  }
  const final = await readProjectJson(proj);
  assert.equal(final.characters.length, N, `expected ${N} characters, got ${final.characters.length}`);
  await fs.rm(proj, { recursive: true });
});

test("writeProjectMetadata: refuses to write unparseable JSON", async () => {
  const proj = await makeProject();
  // Inject a circular reference — JSON.stringify throws TypeError, which
  // happens before our validate-after-stringify guard. The validate guard
  // catches the case where stringify SUCCEEDS but produces non-JSON output.
  // Here we verify we don't silently corrupt the file.
  const circular = { project: {} };
  circular.project.self = circular;
  let err;
  try { await builtins.writeProjectMetadata(proj, circular); }
  catch (e) { err = e; }
  assert.ok(err, "expected throw on circular ref");
  // project.json should be untouched
  const final = await readProjectJson(proj);
  assert.deepEqual(final.characters, []);
  await fs.rm(proj, { recursive: true });
});

test("writeProjectMetadata: 12 parallel writes from different projects do not block each other", async () => {
  const projects = await Promise.all(Array.from({ length: 4 }, () => makeProject()));
  // 4 projects × 3 writes each, all parallel. Different lock keys must let them proceed.
  await Promise.all(
    projects.flatMap((proj, p) =>
      Array.from({ length: 3 }, async (_, i) => {
        const current = await readProjectJson(proj);
        const next = { ...current, characters: [...current.characters, makeChar(`p${p}-${i}`)] };
        await builtins.writeProjectMetadata(proj, next);
      }),
    ),
  );
  for (const proj of projects) {
    const final = await readProjectJson(proj);
    assert.ok(final.characters.length >= 1, `project ${proj} has no characters`);
  }
  await Promise.all(projects.map((p) => fs.rm(p, { recursive: true })));
});
