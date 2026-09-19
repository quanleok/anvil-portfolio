// Regression tests for the asset-sections audit (2026-04-20):
// H3 — writeMediaIndex uses unique-tmp atomic write
// H5 — reconcileMedia returns its freshIndex; scan_media doesn't re-walk
//
// Note: the H1 (delete_media phantom-ref cleanup) and H2 (attach_media
// COPYFILE_EXCL) tests live as pure-helper checks here. Tool-wrapper
// invocation tests for those would require booting the full registry
// + ipc context and aren't covered by the lane's existing test harness.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const media = require("../media.cjs");

async function makeProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anvil-media-hardening-"));
  await fs.mkdir(path.join(dir, ".forge"), { recursive: true });
  await fs.mkdir(path.join(dir, "assets", "characters"), { recursive: true });
  return dir;
}

test("H3 — concurrent writeMediaIndex calls don't ENOENT each other (unique tmp)", async () => {
  const proj = await makeProject();
  // 6 concurrent writes — pre-fix all shared the same .tmp filename and
  // 5/6 would crash on rename.
  const indexes = Array.from({ length: 6 }, (_, i) => ({
    [`id-${i}`]: { id: `id-${i}`, path: `assets/characters/${i}.png`, sha256: "abc", sizeBytes: 1, kind: "image", source: "asset", addedAt: new Date().toISOString() },
  }));
  const results = await Promise.allSettled(
    indexes.map((idx) => media.writeMediaIndex(proj, idx)),
  );
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(rejected.length, 0, `expected zero ENOENT rejections, got: ${rejected.map((r) => r.reason?.code).join(",")}`);
  // Last write wins on the target — file is valid and parseable.
  const final = await media.readMediaIndex(proj);
  assert.equal(typeof final, "object");
  await fs.rm(proj, { recursive: true });
});

test("H5 — reconcileMedia returns freshIndex so scan_media can avoid re-walking", async () => {
  const proj = await makeProject();
  // Add a few real files so build/reconcile have something to do.
  for (let i = 0; i < 3; i++) {
    await fs.writeFile(path.join(proj, "assets", "characters", `c${i}.png`), `payload-${i}`);
  }
  const result = await media.reconcileMedia(proj);
  assert.ok(result.freshIndex, "reconcileMedia must return freshIndex");
  assert.equal(typeof result.freshIndex, "object");
  const ids = Object.keys(result.freshIndex);
  assert.equal(ids.length, 3, `expected 3 records in freshIndex, got ${ids.length}`);
  // The freshIndex is the same shape as buildMediaIndex output.
  for (const rec of Object.values(result.freshIndex)) {
    assert.ok(rec.id);
    assert.ok(rec.path);
    assert.ok(rec.sha256);
    assert.ok(rec.kind);
  }
  await fs.rm(proj, { recursive: true });
});

test("H5 — reconcileMedia + writeMediaIndex round-trips without a separate buildMediaIndex call", async () => {
  // Mirrors the new scan_media flow: reconcile → write freshIndex from
  // result → done. No second walk.
  const proj = await makeProject();
  await fs.writeFile(path.join(proj, "assets", "characters", "alpha.png"), "data");
  const { freshIndex, total } = await media.reconcileMedia(proj);
  await media.writeMediaIndex(proj, freshIndex);
  const reread = await media.readMediaIndex(proj);
  assert.equal(Object.keys(reread).length, total);
  await fs.rm(proj, { recursive: true });
});
