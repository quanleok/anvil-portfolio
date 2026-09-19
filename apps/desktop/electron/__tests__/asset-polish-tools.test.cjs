// Regression tests for the asset-sections POLISH bundle (2026-04-20):
// R1 — create_asset_entries / delete_asset_entries (bulk variants)
// R2 — move_asset_entry (cross-section move preserving id + media)
// R3 — create_asset_entry returns warning on duplicate name in section
//
// Tests exercise the registered tools through a minimal in-process api
// shape that matches what builtins.cjs builds for the real registry.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");

const builtins = require("../system/tools/builtins.cjs");
const registerAssetTools = require("../system/tools/assets.cjs");

// Build a minimal toolApi mirroring what builtins does for asset tools.
// Reuses real writeProjectMetadata so we hit the C1 atomic+lock path.
function buildAssetApi(projectDir) {
  const tools = new Map();
  const ASSET_SECTIONS = ["characters", "locations", "props", "keyframes", "audio"];
  function makeAssetEntry(section, name) {
    const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "asset";
    return {
      id: `${section.slice(0, 3)}_${randomUUID()}`,
      name, title: name, content: "",
      path: `${section}/${slug}.md`,
      folder: null, media: [],
    };
  }
  function mediaKindForSection(section) { return section === "audio" ? "audio" : "image"; }
  function normalizeAssetSection(section) {
    const v = String(section || "").trim();
    return ASSET_SECTIONS.includes(v) ? v : "";
  }
  function normalizeProjectMediaPath(_dir, p) {
    return String(p || "").replace(/\\/g, "/").replace(/^\.\/+/, "");
  }
  function absoluteProjectMediaPath(dir, rel) {
    if (!rel) return null;
    return path.resolve(dir, rel);
  }
  function ensureUniqueRelativePathExcept(_dir, desired) { return desired; }
  function resolveInside(dir, rel) { return path.resolve(dir, rel); }
  function slugifyName(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "asset";
  }
  function syncAssetDirectoryFiles() { return { changed: false, project: {}, imported: [] }; }
  function truncateText(s, n) { return { content: String(s || "").slice(0, n), truncated: false }; }

  const api = {
    registerTool: (name, def) => tools.set(name, def),
    readProjectMetadata: async () => {
      const raw = await fs.readFile(path.join(projectDir, ".forge", "project.json"), "utf8");
      return JSON.parse(raw);
    },
    writeProjectMetadata: builtins.writeProjectMetadata,
    refreshProjectIndex: async () => ({}),
    syncAssetDirectoryFiles,
    truncateText,
    normalizeAssetSection,
    assetSections: () => ASSET_SECTIONS,
    normalizeProjectMediaPath,
    absoluteProjectMediaPath,
    ensureUniqueRelativePathExcept,
    resolveInside,
    slugifyName,
    makeAssetEntry,
    mediaKindForSection,
  };
  registerAssetTools(api);
  return tools;
}

async function makeProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anvil-asset-polish-tools-"));
  await fs.mkdir(path.join(dir, ".forge"), { recursive: true });
  await fs.writeFile(
    path.join(dir, ".forge", "project.json"),
    JSON.stringify({ project: { id: "p", name: "test" }, characters: [], locations: [], props: [], keyframes: [], audio: [], library: [] }),
  );
  return dir;
}

async function readMeta(dir) {
  return JSON.parse(await fs.readFile(path.join(dir, ".forge", "project.json"), "utf8"));
}

test("R3 — create_asset_entry surfaces duplicate-name warning when the section already has the same name", async () => {
  const proj = await makeProject();
  const tools = buildAssetApi(proj);
  const create = tools.get("create_asset_entry");
  const ctx = { projectDir: proj };

  const first = await create.run({ section: "characters", name: "Alex" }, ctx);
  assert.equal(first.warning, undefined, "first create has no duplicates");

  const second = await create.run({ section: "characters", name: "Alex" }, ctx);
  assert.ok(second.warning, "second create with same name should produce a warning");
  assert.equal(second.warning.code, "duplicate_name");
  assert.equal(second.warning.existing.length, 1);
  assert.equal(second.warning.existing[0].id, first.id);

  // Case-insensitive match — "alex" also triggers the warning.
  const third = await create.run({ section: "characters", name: "alex" }, ctx);
  assert.ok(third.warning, "case-insensitive duplicate detected");
  assert.equal(third.warning.existing.length, 2);
  await fs.rm(proj, { recursive: true });
});

test("R2 — move_asset_entry preserves id, content, media", async () => {
  const proj = await makeProject();
  const tools = buildAssetApi(proj);
  const create = tools.get("create_asset_entry");
  const move = tools.get("move_asset_entry");
  const ctx = { projectDir: proj };

  const created = await create.run({ section: "keyframes", name: "Kingdom Map", content: "wide shot of the realm" }, ctx);
  // Manually attach a (fake) image media item so we can verify preservation.
  const meta1 = await readMeta(proj);
  const kf = meta1.keyframes.find((e) => e.id === created.id);
  kf.media = [{ id: "media-1", kind: "image", label: "map.png", path: "assets/keyframes/map.png" }];
  await fs.writeFile(path.join(proj, ".forge", "project.json"), JSON.stringify(meta1));

  const moved = await move.run({ fromSection: "keyframes", toSection: "locations", assetId: created.id }, ctx);
  assert.equal(moved.fromSection, "keyframes");
  assert.equal(moved.toSection, "locations");
  assert.equal(moved.assetId, created.id);
  assert.equal(moved.mediaPreserved, 1);

  const meta2 = await readMeta(proj);
  assert.equal(meta2.keyframes.length, 0, "source section emptied");
  assert.equal(meta2.locations.length, 1, "destination section gained the entry");
  const movedEntry = meta2.locations[0];
  assert.equal(movedEntry.id, created.id, "id preserved");
  assert.equal(movedEntry.content, "wide shot of the realm", "content preserved");
  assert.equal(movedEntry.media.length, 1, "media preserved");
  assert.equal(movedEntry.media[0].path, "assets/keyframes/map.png");
  await fs.rm(proj, { recursive: true });
});

test("R2 — move_asset_entry refuses kind-mismatched media unless detach policy", async () => {
  const proj = await makeProject();
  const tools = buildAssetApi(proj);
  const create = tools.get("create_asset_entry");
  const move = tools.get("move_asset_entry");
  const ctx = { projectDir: proj };

  const created = await create.run({ section: "props", name: "soundtrack-album" }, ctx);
  const meta1 = await readMeta(proj);
  meta1.props.find((e) => e.id === created.id).media = [
    { id: "m1", kind: "image", label: "cover.png", path: "assets/props/cover.png" },
    { id: "m2", kind: "audio", label: "track.mp3", path: "assets/props/track.mp3" },
  ];
  await fs.writeFile(path.join(proj, ".forge", "project.json"), JSON.stringify(meta1));

  // Refuse policy (default) — image media incompatible with audio section.
  let err;
  try { await move.run({ fromSection: "props", toSection: "audio", assetId: created.id }, ctx); }
  catch (e) { err = e; }
  assert.ok(err, "expected refusal");
  assert.match(err.message, /incompatible/i);

  // Detach policy succeeds and drops the image media.
  const moved = await move.run({ fromSection: "props", toSection: "audio", assetId: created.id, mediaMismatchPolicy: "detach" }, ctx);
  assert.equal(moved.mediaPreserved, 1, "audio media survives");
  assert.equal(moved.mediaDetached.length, 1, "image media detached");
  await fs.rm(proj, { recursive: true });
});

test("R2 — move to same section is a no-op", async () => {
  const proj = await makeProject();
  const tools = buildAssetApi(proj);
  const create = tools.get("create_asset_entry");
  const move = tools.get("move_asset_entry");
  const ctx = { projectDir: proj };
  const c = await create.run({ section: "characters", name: "Same" }, ctx);
  const r = await move.run({ fromSection: "characters", toSection: "characters", assetId: c.id }, ctx);
  assert.equal(r.noop, true);
  await fs.rm(proj, { recursive: true });
});

test("R1 — create_asset_entries: 5 entries in one call land atomically with per-entry results", async () => {
  const proj = await makeProject();
  const tools = buildAssetApi(proj);
  const createBulk = tools.get("create_asset_entries");
  const ctx = { projectDir: proj };

  const result = await createBulk.run({
    section: "characters",
    entries: [
      { name: "Alex" }, { name: "Bob" }, { name: "Cora" }, { name: "Dana" }, { name: "Eve" },
    ],
  }, ctx);

  assert.equal(result.section, "characters");
  assert.equal(result.count, 5);
  assert.equal(result.created.length, 5);
  for (let i = 0; i < 5; i++) {
    assert.ok(result.created[i].ok, `entry ${i} should succeed`);
    assert.ok(result.created[i].id);
  }
  // Verify all 5 actually landed in project.json (atomic batch write).
  const meta = await readMeta(proj);
  assert.equal(meta.characters.length, 5);
  await fs.rm(proj, { recursive: true });
});

test("R1 — create_asset_entries surfaces per-entry duplicate warnings (R3 carries through)", async () => {
  const proj = await makeProject();
  const tools = buildAssetApi(proj);
  const create = tools.get("create_asset_entry");
  const createBulk = tools.get("create_asset_entries");
  const ctx = { projectDir: proj };

  await create.run({ section: "characters", name: "Alex" }, ctx);
  const result = await createBulk.run({
    section: "characters",
    entries: [{ name: "Alex" }, { name: "Bob" }, { name: "Alex" }],
  }, ctx);
  assert.equal(result.created[0].warning?.code, "duplicate_name");
  assert.equal(result.created[1].warning, undefined);
  assert.equal(result.created[2].warning?.code, "duplicate_name");
  await fs.rm(proj, { recursive: true });
});

test("R1 — create_asset_entries: failed entries don't sink the batch", async () => {
  const proj = await makeProject();
  const tools = buildAssetApi(proj);
  const createBulk = tools.get("create_asset_entries");
  const ctx = { projectDir: proj };

  const result = await createBulk.run({
    section: "characters",
    entries: [
      { name: "Valid" },
      { name: "" },                  // missing name
      { name: "AlsoValid", mediaPath: "does/not/exist.png" }, // missing file
    ],
  }, ctx);
  assert.equal(result.count, 1, "only 1 entry actually created");
  assert.equal(result.created[0].ok, true);
  assert.equal(result.created[1].ok, false);
  assert.equal(result.created[2].ok, false);
  const meta = await readMeta(proj);
  assert.equal(meta.characters.length, 1);
  await fs.rm(proj, { recursive: true });
});

test("R1 — delete_asset_entries: 3 entries deleted in one call, shared media refcount handled within batch", async () => {
  const proj = await makeProject();
  const tools = buildAssetApi(proj);
  const create = tools.get("create_asset_entry");
  const deleteBulk = tools.get("delete_asset_entries");
  const ctx = { projectDir: proj };

  const a = await create.run({ section: "characters", name: "A" }, ctx);
  const b = await create.run({ section: "characters", name: "B" }, ctx);
  const c = await create.run({ section: "characters", name: "C" }, ctx);

  // Manually give A and B a shared media path; C has its own.
  const meta1 = await readMeta(proj);
  meta1.characters.find((e) => e.id === a.id).media = [
    { id: "m1", kind: "image", label: "shared.png", path: "assets/characters/shared.png" },
  ];
  meta1.characters.find((e) => e.id === b.id).media = [
    { id: "m2", kind: "image", label: "shared.png", path: "assets/characters/shared.png" },
  ];
  meta1.characters.find((e) => e.id === c.id).media = [
    { id: "m3", kind: "image", label: "solo.png", path: "assets/characters/solo.png" },
  ];
  await fs.writeFile(path.join(proj, ".forge", "project.json"), JSON.stringify(meta1));
  // Place files on disk so temporary-trash moves succeed.
  await fs.mkdir(path.join(proj, "assets", "characters"), { recursive: true });
  await fs.writeFile(path.join(proj, "assets", "characters", "shared.png"), "shared");
  await fs.writeFile(path.join(proj, "assets", "characters", "solo.png"), "solo");

  // Delete A and B in one call. shared.png starts with refcount 2 — A's
  // delete decrements to 1 (detach), B's delete decrements to 0 (trash move).
  const result = await deleteBulk.run({ section: "characters", ids: [a.id, b.id] }, ctx);
  assert.equal(result.count, 2);
  assert.deepEqual(result.detachedFiles, ["assets/characters/shared.png"]);
  assert.deepEqual(result.deletedFiles, ["assets/characters/shared.png"]);
  assert.deepEqual(result.trashedFiles, [
    { from: "assets/characters/shared.png", to: "assets/inbox/shared.png" },
  ]);
  // C still present, solo.png untouched.
  const meta2 = await readMeta(proj);
  assert.equal(meta2.characters.length, 1);
  assert.equal(meta2.characters[0].id, c.id);
  await fs.access(path.join(proj, "assets", "characters", "solo.png")); // still there
  await assert.rejects(fs.access(path.join(proj, "assets", "characters", "shared.png")), /ENOENT/);
  await fs.access(path.join(proj, "assets", "inbox", "shared.png"));
  await fs.rm(proj, { recursive: true });
});

test("R1 — delete_asset_entries: dedupes duplicate media on the same entry", async () => {
  // Pre-fix this test also asserted assetGroup membership cleanup;
  // AssetGroup feature was deleted on 2026-05-04. The dedup-on-delete
  // half is still load-bearing and stays.
  const proj = await makeProject();
  const tools = buildAssetApi(proj);
  const create = tools.get("create_asset_entry");
  const deleteBulk = tools.get("delete_asset_entries");
  const ctx = { projectDir: proj };

  const a = await create.run({ section: "characters", name: "A" }, ctx);
  const meta1 = await readMeta(proj);
  meta1.characters.find((e) => e.id === a.id).media = [
    { id: "m1", kind: "image", label: "solo.png", path: "assets/characters/solo.png" },
    { id: "m2", kind: "image", label: "solo.png", path: "assets/characters/solo.png" },
  ];
  await fs.writeFile(path.join(proj, ".forge", "project.json"), JSON.stringify(meta1));
  await fs.mkdir(path.join(proj, "assets", "characters"), { recursive: true });
  await fs.writeFile(path.join(proj, "assets", "characters", "solo.png"), "solo");

  const result = await deleteBulk.run({ section: "characters", ids: [a.id] }, ctx);
  assert.equal(result.count, 1);
  assert.deepEqual(result.detachedFiles, []);
  assert.deepEqual(result.deletedFiles, ["assets/characters/solo.png"]);
  assert.deepEqual(result.trashedFiles, [
    { from: "assets/characters/solo.png", to: "assets/inbox/solo.png" },
  ]);
  await assert.rejects(fs.access(path.join(proj, "assets", "characters", "solo.png")), /ENOENT/);
  await fs.access(path.join(proj, "assets", "inbox", "solo.png"));
  await fs.rm(proj, { recursive: true });
});

test("R1 — delete_asset_entries: missing ids reported per-entry without sinking the batch", async () => {
  const proj = await makeProject();
  const tools = buildAssetApi(proj);
  const create = tools.get("create_asset_entry");
  const deleteBulk = tools.get("delete_asset_entries");
  const ctx = { projectDir: proj };

  const a = await create.run({ section: "characters", name: "A" }, ctx);
  const result = await deleteBulk.run({ section: "characters", ids: [a.id, "does-not-exist"] }, ctx);
  assert.equal(result.count, 1);
  assert.equal(result.deleted[0].ok, true);
  assert.equal(result.deleted[1].ok, false);
  assert.match(result.deleted[1].error, /not found/i);
  await fs.rm(proj, { recursive: true });
});

// Post-merge audit fixes (2026-04-21)

test("R1 — create_asset_entries: within-batch duplicate names get warned about each other", async () => {
  const proj = await makeProject();
  const tools = buildAssetApi(proj);
  const createBulk = tools.get("create_asset_entries");
  const ctx = { projectDir: proj };
  const result = await createBulk.run({
    section: "characters",
    entries: [{ name: "Alex" }, { name: "Bob" }, { name: "Alex" }, { name: "alex" }],
  }, ctx);
  assert.equal(result.count, 4);
  // First Alex has no duplicates (no pre-existing, no batch-mate yet).
  assert.equal(result.created[0].warning, undefined);
  // Second Alex sees the first one as a batch dupe.
  assert.equal(result.created[2].warning?.code, "duplicate_name");
  assert.equal(result.created[2].warning.existing.length, 1);
  assert.equal(result.created[2].warning.existing[0].id, result.created[0].id);
  // Lowercase "alex" sees BOTH prior Alex entries.
  assert.equal(result.created[3].warning?.code, "duplicate_name");
  assert.equal(result.created[3].warning.existing.length, 2);
  await fs.rm(proj, { recursive: true });
});

test("R1 — delete_asset_entries: duplicate id in input batch reported as duplicate, not 'not found'", async () => {
  const proj = await makeProject();
  const tools = buildAssetApi(proj);
  const create = tools.get("create_asset_entry");
  const deleteBulk = tools.get("delete_asset_entries");
  const ctx = { projectDir: proj };
  const a = await create.run({ section: "characters", name: "A" }, ctx);
  const result = await deleteBulk.run({ section: "characters", ids: [a.id, a.id, a.id] }, ctx);
  assert.equal(result.count, 1, "only one delete actually executes");
  assert.equal(result.deleted[0].ok, true);
  assert.equal(result.deleted[1].ok, false);
  assert.match(result.deleted[1].error, /duplicate id/i);
  assert.equal(result.deleted[2].ok, false);
  assert.match(result.deleted[2].error, /duplicate id/i);
  await fs.rm(proj, { recursive: true });
});

test("R2 — move_asset_entry: 'videos' refusal directs the agent to videos-tools.cjs", async () => {
  const proj = await makeProject();
  const tools = buildAssetApi(proj);
  const create = tools.get("create_asset_entry");
  const move = tools.get("move_asset_entry");
  const ctx = { projectDir: proj };
  const c = await create.run({ section: "keyframes", name: "Take" }, ctx);
  for (const args of [
    { fromSection: "videos", toSection: "characters", assetId: "x" },
    { fromSection: "keyframes", toSection: "videos", assetId: c.id },
    { fromSection: "VIDEOS", toSection: "props", assetId: "x" },
  ]) {
    let err;
    try { await move.run(args, ctx); } catch (e) { err = e; }
    assert.ok(err, `expected refusal for ${JSON.stringify(args)}`);
    assert.match(err.message, /videos-tools\.cjs/);
    assert.match(err.message, /VideoEntry/);
  }
  await fs.rm(proj, { recursive: true });
});
