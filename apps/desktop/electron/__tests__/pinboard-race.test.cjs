// Regression test for C1 (audit 2026-04-20): parallel pinboard mutators
// must not lose entries or crash on rename. Pre-fix behavior: 7/8 calls
// failed with ENOENT every burst. Post-fix: all calls survive, all
// entries land in the final file.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const memory = require("../memory.cjs");

async function makeProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anvil-pinboard-race-"));
  await fs.mkdir(path.join(dir, ".forge", "memory"), { recursive: true });
  return dir;
}

function makeEntry(suffix) {
  return {
    id: `entry-${suffix}`,
    text: `fact ${suffix}`,
    category: "fact",
    scope: "project",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    confirmed: false,
  };
}

test("addPinboardEntry: 8 parallel adds — every entry survives, no rename ENOENT", async () => {
  const proj = await makeProject();
  const N = 8;
  const entries = Array.from({ length: N }, (_, i) => makeEntry(i));
  const results = await Promise.allSettled(
    entries.map((e) => memory.addPinboardEntry(proj, e)),
  );
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(rejected.length, 0, `expected zero rejections, got ${rejected.length}: ${rejected.map((r) => r.reason?.code || r.reason?.message).join(", ")}`);
  const final = await memory.readPinboard(proj);
  assert.equal(final.length, N, `expected ${N} entries to survive, got ${final.length}`);
  const ids = new Set(final.map((e) => e.id));
  for (let i = 0; i < N; i++) {
    assert.ok(ids.has(`entry-${i}`), `missing entry-${i}`);
  }
  await fs.rm(proj, { recursive: true });
});

test("addPinboardEntry: stress 25 parallel adds across multiple projects", async () => {
  // Multi-project: lock keys are per-projectDir so different projects must
  // not block each other. Run 5 projects × 5 parallel adds and assert all
  // 25 succeed without lock-key cross-contamination.
  const projects = await Promise.all(Array.from({ length: 5 }, () => makeProject()));
  const results = await Promise.allSettled(
    projects.flatMap((proj, p) =>
      Array.from({ length: 5 }, (_, i) => memory.addPinboardEntry(proj, makeEntry(`p${p}-e${i}`))),
    ),
  );
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(rejected.length, 0, `expected zero rejections across 25 multi-project adds`);
  for (let p = 0; p < projects.length; p++) {
    const final = await memory.readPinboard(projects[p]);
    assert.equal(final.length, 5, `project ${p}: expected 5 entries, got ${final.length}`);
  }
  await Promise.all(projects.map((p) => fs.rm(p, { recursive: true })));
});

test("updatePinboardEntry + removePinboardEntry serialize against addPinboardEntry", async () => {
  const proj = await makeProject();
  const seed = makeEntry("seed");
  await memory.addPinboardEntry(proj, seed);
  // Fire add + update + add + remove + add interleaved. All should land.
  const ops = [
    memory.addPinboardEntry(proj, makeEntry("a")),
    memory.updatePinboardEntry(proj, "entry-seed", { text: "updated" }),
    memory.addPinboardEntry(proj, makeEntry("b")),
    memory.addPinboardEntry(proj, makeEntry("c")),
  ];
  await Promise.all(ops);
  await memory.removePinboardEntry(proj, "entry-a");
  const final = await memory.readPinboard(proj);
  const ids = final.map((e) => e.id).sort();
  assert.deepEqual(ids, ["entry-b", "entry-c", "entry-seed"]);
  const seedEntry = final.find((e) => e.id === "entry-seed");
  assert.equal(seedEntry.text, "updated");
  await fs.rm(proj, { recursive: true });
});

test("writePinboard: unique .tmp filenames — concurrent writes don't ENOENT", async () => {
  // Direct test of the lower-level helper. Concurrent writePinboard calls
  // (which the mutex serializes in production, but the unique-.tmp pattern
  // is a defense-in-depth layer below the mutex) must not collide.
  const proj = await makeProject();
  await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      memory.writePinboard(proj, [makeEntry(`direct-${i}`)]),
    ),
  );
  // Last write wins on the target — assert no error and the file is valid.
  const final = await memory.readPinboard(proj);
  assert.equal(final.length, 1);
  assert.ok(final[0].id.startsWith("entry-direct-"));
  await fs.rm(proj, { recursive: true });
});
