"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const {
  readProjectDefaults,
  writeProjectDefaults,
  setProjectDefault,
  PROJECT_DEFAULTS_FILE,
} = require("../project-defaults.cjs");

async function tempProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-defaults-"));
  await fs.mkdir(path.join(dir, ".forge"), { recursive: true });
  return dir;
}

test("readProjectDefaults: missing file returns empty sections", async () => {
  const dir = await tempProject();
  const out = await readProjectDefaults(dir);
  assert.deepEqual(out, { scene: {}, shot: {}, prompt: {} });
});

test("readProjectDefaults: round-trips a written defaults blob", async () => {
  const dir = await tempProject();
  const original = {
    scene: { durationTargetSec: 30 },
    shot: { durationSec: 8, shotType: "medium" },
    prompt: { model: "seedance-1.5", aspectRatio: "16:9" },
  };
  await writeProjectDefaults(dir, original);
  const out = await readProjectDefaults(dir);
  assert.deepEqual(out, original);
});

test("readProjectDefaults: corrupt JSON falls back to empty without throwing", async () => {
  const dir = await tempProject();
  await fs.writeFile(
    path.join(dir, PROJECT_DEFAULTS_FILE),
    "{ this is not valid json",
  );
  const out = await readProjectDefaults(dir);
  assert.deepEqual(out, { scene: {}, shot: {}, prompt: {} });
});

test("readProjectDefaults: oversized file falls back to empty", async () => {
  const dir = await tempProject();
  // 64 KB of JSON-ish text — over the MAX_BYTES limit.
  const big = `{"scene":{}, "shot":{}, "prompt":{"_pad":"${"x".repeat(64 * 1024)}"}}`;
  await fs.writeFile(path.join(dir, PROJECT_DEFAULTS_FILE), big);
  const out = await readProjectDefaults(dir);
  assert.deepEqual(out, { scene: {}, shot: {}, prompt: {} });
});

test("normalize: drops unknown top-level keys", async () => {
  const dir = await tempProject();
  await fs.writeFile(
    path.join(dir, PROJECT_DEFAULTS_FILE),
    JSON.stringify({
      scene: { durationTargetSec: 30 },
      bogus: "ignore me",
      "agent-field": { stuff: 1 },
    }),
  );
  const out = await readProjectDefaults(dir);
  assert.deepEqual(out, { scene: { durationTargetSec: 30 }, shot: {}, prompt: {} });
});

test("normalize: array or primitive top-level coerces to empty", async () => {
  const dir = await tempProject();
  await fs.writeFile(path.join(dir, PROJECT_DEFAULTS_FILE), JSON.stringify([1, 2, 3]));
  const out = await readProjectDefaults(dir);
  assert.deepEqual(out, { scene: {}, shot: {}, prompt: {} });
});

test("normalize: a section that's not a plain object is replaced with {}", async () => {
  const dir = await tempProject();
  await fs.writeFile(
    path.join(dir, PROJECT_DEFAULTS_FILE),
    JSON.stringify({ scene: "wrong", shot: [1, 2], prompt: { model: "seedance" } }),
  );
  const out = await readProjectDefaults(dir);
  assert.deepEqual(out, { scene: {}, shot: {}, prompt: { model: "seedance" } });
});

test("setProjectDefault: writes a value and persists across reads", async () => {
  const dir = await tempProject();
  const out = await setProjectDefault(dir, "prompt", "model", "veo-2");
  assert.equal(out.prompt.model, "veo-2");
  const reread = await readProjectDefaults(dir);
  assert.equal(reread.prompt.model, "veo-2");
});

test("setProjectDefault: null deletes the field (restores cascade fallthrough)", async () => {
  const dir = await tempProject();
  await setProjectDefault(dir, "prompt", "model", "veo-2");
  await setProjectDefault(dir, "prompt", "model", null);
  const out = await readProjectDefaults(dir);
  assert.equal("model" in out.prompt, false);
});

test("setProjectDefault: rejects bad scope", async () => {
  const dir = await tempProject();
  await assert.rejects(
    () => setProjectDefault(dir, "bogus", "model", "veo-2"),
    /scope must be scene\/shot\/prompt/,
  );
});

test("setProjectDefault: rejects empty field name", async () => {
  const dir = await tempProject();
  await assert.rejects(
    () => setProjectDefault(dir, "prompt", "", "x"),
    /field name is required/,
  );
});

test("setProjectDefault: preserves OTHER fields and sections when patching one", async () => {
  const dir = await tempProject();
  await writeProjectDefaults(dir, {
    scene: { durationTargetSec: 30 },
    shot: { durationSec: 8 },
    prompt: { model: "seedance-1.5", aspectRatio: "16:9" },
  });
  await setProjectDefault(dir, "prompt", "model", "veo-2");
  const out = await readProjectDefaults(dir);
  assert.deepEqual(out, {
    scene: { durationTargetSec: 30 },
    shot: { durationSec: 8 },
    prompt: { model: "veo-2", aspectRatio: "16:9" },
  });
});

test("writeProjectDefaults: creates .forge directory if missing", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-defaults-"));
  // Note: .forge dir does NOT exist.
  await writeProjectDefaults(dir, { scene: {}, shot: {}, prompt: { fps: 24 } });
  const stat = await fs.stat(path.join(dir, ".forge"));
  assert.ok(stat.isDirectory());
  const out = await readProjectDefaults(dir);
  assert.equal(out.prompt.fps, 24);
});
