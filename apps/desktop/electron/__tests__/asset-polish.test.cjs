// Regression tests for the asset-sections polish bundle (2026-04-20):
// M1 — read_asset_bundle name disambiguation
// L6 — walkMedia symlink cycle guard
// M3 — buildMediaIndex bounded parallel hash (functional, not perf)

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const media = require("../media.cjs");

async function makeProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anvil-asset-polish-"));
  await fs.mkdir(path.join(dir, ".forge"), { recursive: true });
  await fs.mkdir(path.join(dir, "assets", "characters"), { recursive: true });
  return dir;
}

test("L6 — walkMedia survives a symlink cycle without infinite recursion", async () => {
  const proj = await makeProject();
  await fs.writeFile(path.join(proj, "assets", "characters", "real.png"), "data");
  // Create a circular symlink: assets/characters/loop -> assets/characters/
  try {
    fsSync.symlinkSync(path.join(proj, "assets", "characters"), path.join(proj, "assets", "characters", "loop"), "dir");
  } catch (err) {
    // Some sandbox setups disallow symlinks; skip rather than fail.
    if (err.code === "EPERM" || err.code === "EACCES") {
      console.log("(skipping symlink cycle test — symlinks not permitted in this environment)");
      await fs.rm(proj, { recursive: true });
      return;
    }
    throw err;
  }
  const index = await media.buildMediaIndex(proj);
  // Should resolve in normal time (not infinite-loop), and find the one
  // real file. The cycle is visited once via realpath, then skipped.
  assert.equal(Object.keys(index).length, 1);
  await fs.rm(proj, { recursive: true });
});

test("M3 — buildMediaIndex with 25 files completes and returns correct shape", async () => {
  const proj = await makeProject();
  // 25 files exercises the bounded-parallel batch loop multiple times.
  for (let i = 0; i < 25; i++) {
    await fs.writeFile(path.join(proj, "assets", "characters", `c${i}.png`), `payload-${i}`);
  }
  const index = await media.buildMediaIndex(proj);
  assert.equal(Object.keys(index).length, 25);
  for (const rec of Object.values(index)) {
    assert.ok(rec.id && rec.path && rec.sha256 && rec.kind === "image" && rec.sizeBytes > 0);
  }
  // Hashes must remain deterministic — same content, same hash, even
  // across the parallel batches.
  const a = await media.buildMediaIndex(proj);
  const b = await media.buildMediaIndex(proj);
  for (const id of Object.keys(a)) {
    assert.equal(a[id].sha256, b[id].sha256);
  }
  await fs.rm(proj, { recursive: true });
});
