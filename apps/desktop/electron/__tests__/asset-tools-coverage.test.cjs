// Coverage tests for review finding M2 (2026-05-04):
// find_duplicate_media, get_media_refs, and update_asset_entry were
// added in the 2026-04-27 wave with no dedicated test files. Backfilling.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");

const builtins = require("../system/tools/builtins.cjs");
const registerAssetTools = require("../system/tools/assets.cjs");
const registerMediaIndexTools = require("../system/tools/media-index.cjs");
const media = require("../media.cjs");

const ASSET_SECTIONS = ["characters", "locations", "props", "keyframes", "audio"];

// Shared test fixture builder — wires the real registrations against
// a temp project on disk plus the minimum dependency surface the tools
// expect via the api.
function buildToolApi(projectDir) {
  const tools = new Map();
  function normalizeAssetSection(s) {
    const v = String(s || "").trim();
    return ASSET_SECTIONS.includes(v) ? v : "";
  }
  function normalizeProjectMediaPath(_dir, p) {
    return String(p || "").replace(/\\/g, "/").replace(/^\.\/+/, "");
  }
  function absoluteProjectMediaPath(dir, rel) {
    if (!rel) return null;
    return path.resolve(dir, rel);
  }
  function ensureUniqueRelativePathExcept(_dir, desired) {
    return desired;
  }
  function resolveInside(dir, rel) {
    return path.resolve(dir, rel);
  }
  function slugifyName(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "asset";
  }
  function syncAssetDirectoryFiles() {
    return { changed: false, project: {}, imported: [] };
  }
  function truncateText(s, n) {
    return { content: String(s || "").slice(0, n), truncated: false };
  }
  function mediaKindForSection(section) {
    return section === "audio" ? "audio" : "image";
  }
  function makeAssetEntry(section, name) {
    const slug = slugifyName(name);
    return {
      id: `${section.slice(0, 3)}_${randomUUID()}`,
      name, title: name, content: "",
      path: `${section}/${slug}.md`,
      folder: null, media: [],
    };
  }
  function normalizeRelativePath(_dir, p) {
    return String(p || "").replace(/\\/g, "/").replace(/^\.\/+/, "");
  }

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
    normalizeRelativePath,
  };
  registerAssetTools(api);
  registerMediaIndexTools(api);
  return tools;
}

async function makeProject(seed = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anvil-asset-coverage-"));
  await fs.mkdir(path.join(dir, ".forge"), { recursive: true });
  const meta = {
    project: { id: "p", name: "test" },
    characters: [], locations: [], props: [], keyframes: [], audio: [], library: [],
    ...seed,
  };
  await fs.writeFile(path.join(dir, ".forge", "project.json"), JSON.stringify(meta));
  return dir;
}

async function readMeta(dir) {
  return JSON.parse(await fs.readFile(path.join(dir, ".forge", "project.json"), "utf8"));
}

// =============================================================================
// find_duplicate_media
// =============================================================================

async function seedMediaIndex(projectDir, records) {
  // records: [{ id, path, kind, sha256, sizeBytes, source? }]
  const index = {};
  for (const r of records) {
    index[r.id] = {
      id: r.id,
      path: r.path,
      kind: r.kind,
      sha256: r.sha256,
      sizeBytes: r.sizeBytes ?? 100,
      source: r.source || "asset",
      addedAt: new Date().toISOString(),
    };
  }
  await media.writeMediaIndex(projectDir, index);
}

test("find_duplicate_media: groups records that share a sha256", async () => {
  const dir = await makeProject();
  await seedMediaIndex(dir, [
    { id: "m1", path: "a.png", kind: "image", sha256: "abc", sizeBytes: 100 },
    { id: "m2", path: "b.png", kind: "image", sha256: "abc", sizeBytes: 100 },
    { id: "m3", path: "c.png", kind: "image", sha256: "def", sizeBytes: 50 },
  ]);
  const tools = buildToolApi(dir);
  const meta = await readMeta(dir);
  const result = await tools.get("find_duplicate_media").run({}, { projectDir: dir, metadata: meta });
  assert.equal(result.groupCount, 1, "one duplicate group");
  assert.equal(result.groups[0].sha256, "abc");
  assert.equal(result.groups[0].count, 2);
  assert.equal(result.duplicateFileCount, 2);
  await fs.rm(dir, { recursive: true });
});

test("find_duplicate_media: minGroupSize threshold filters small groups", async () => {
  const dir = await makeProject();
  await seedMediaIndex(dir, [
    { id: "m1", path: "a.png", kind: "image", sha256: "abc" },
    { id: "m2", path: "b.png", kind: "image", sha256: "abc" },
    { id: "m3", path: "c.png", kind: "image", sha256: "def" },
    { id: "m4", path: "d.png", kind: "image", sha256: "def" },
    { id: "m5", path: "e.png", kind: "image", sha256: "def" },
  ]);
  const tools = buildToolApi(dir);
  const meta = await readMeta(dir);
  const r = await tools.get("find_duplicate_media").run({ minGroupSize: 3 }, { projectDir: dir, metadata: meta });
  assert.equal(r.groupCount, 1, "only the 3-file group survives at minGroupSize=3");
  assert.equal(r.groups[0].sha256, "def");
  await fs.rm(dir, { recursive: true });
});

test("find_duplicate_media: minGroupSize floor is 2 even when caller passes lower", async () => {
  const dir = await makeProject();
  await seedMediaIndex(dir, [
    { id: "m1", path: "a.png", kind: "image", sha256: "abc" },
    { id: "m2", path: "b.png", kind: "image", sha256: "def" },
  ]);
  const tools = buildToolApi(dir);
  const meta = await readMeta(dir);
  // minGroupSize=1 should be clamped to 2 — "duplicates" with count<2 isn't
  // a duplicate by definition.
  const r = await tools.get("find_duplicate_media").run({ minGroupSize: 1 }, { projectDir: dir, metadata: meta });
  assert.equal(r.groupCount, 0);
  await fs.rm(dir, { recursive: true });
});

test("find_duplicate_media: kind filter restricts to one media kind", async () => {
  const dir = await makeProject();
  await seedMediaIndex(dir, [
    { id: "m1", path: "a.png", kind: "image", sha256: "abc" },
    { id: "m2", path: "b.png", kind: "image", sha256: "abc" },
    { id: "m3", path: "x.mp3", kind: "audio", sha256: "xyz" },
    { id: "m4", path: "y.mp3", kind: "audio", sha256: "xyz" },
  ]);
  const tools = buildToolApi(dir);
  const meta = await readMeta(dir);
  const r = await tools.get("find_duplicate_media").run({ kind: "image" }, { projectDir: dir, metadata: meta });
  assert.equal(r.groupCount, 1, "only image group surfaces with kind=image");
  assert.equal(r.groups[0].items.every((i) => i.kind === "image"), true);
  await fs.rm(dir, { recursive: true });
});

test("find_duplicate_media: groups sorted by ref count desc inside each group; group order largest-first", async () => {
  const dir = await makeProject({
    characters: [
      { id: "c1", name: "A", path: "characters/a.md", media: [
        { id: "m1", kind: "image", path: "a.png" },
      ] },
      { id: "c2", name: "B", path: "characters/b.md", media: [
        { id: "m1", kind: "image", path: "a.png" },  // shares m1
        { id: "m2", kind: "image", path: "b.png" },
      ] },
    ],
  });
  await seedMediaIndex(dir, [
    { id: "m1", path: "a.png", kind: "image", sha256: "shared" },
    { id: "m2", path: "b.png", kind: "image", sha256: "shared" },
    { id: "m3", path: "c.png", kind: "image", sha256: "other" },
    { id: "m4", path: "d.png", kind: "image", sha256: "other" },
    { id: "m5", path: "e.png", kind: "image", sha256: "other" },
  ]);
  const tools = buildToolApi(dir);
  const meta = await readMeta(dir);
  const r = await tools.get("find_duplicate_media").run({}, { projectDir: dir, metadata: meta });
  // Group "other" has 3 files, "shared" has 2 — "other" should sort first.
  assert.equal(r.groups[0].count, 3);
  assert.equal(r.groups[0].sha256, "other");
  assert.equal(r.groups[1].count, 2);
  assert.equal(r.groups[1].sha256, "shared");
  // Within "shared", m1 (referenced by 2 entities) should sort before m2 (1).
  const sharedGroup = r.groups[1];
  assert.equal(sharedGroup.items[0].id, "m1");
  assert.equal(sharedGroup.items[1].id, "m2");
  await fs.rm(dir, { recursive: true });
});

// =============================================================================
// get_media_refs
// =============================================================================

test("get_media_refs: returns all entities referencing the media id, with section + name", async () => {
  const dir = await makeProject({
    characters: [
      { id: "c1", name: "Alex", path: "characters/alex.md", media: [{ id: "m1", kind: "image", path: "a.png" }] },
    ],
    keyframes: [
      { id: "k1", name: "Hero shot", path: "keyframes/hero.md", media: [{ id: "m1", kind: "image", path: "a.png" }] },
    ],
  });
  await seedMediaIndex(dir, [
    { id: "m1", path: "a.png", kind: "image", sha256: "abc" },
  ]);
  const tools = buildToolApi(dir);
  const meta = await readMeta(dir);
  const r = await tools.get("get_media_refs").run({ mediaId: "m1" }, { projectDir: dir, metadata: meta });
  assert.equal(r.mediaId, "m1");
  assert.equal(r.path, "a.png");
  assert.equal(r.count, 2);
  const ids = r.referencedBy.map((e) => e.id).sort();
  assert.deepEqual(ids, ["c1", "k1"]);
  await fs.rm(dir, { recursive: true });
});

test("get_media_refs: throws when mediaId is missing or not in index", async () => {
  const dir = await makeProject();
  await seedMediaIndex(dir, [
    { id: "m1", path: "a.png", kind: "image", sha256: "abc" },
  ]);
  const tools = buildToolApi(dir);
  const meta = await readMeta(dir);

  await assert.rejects(
    () => tools.get("get_media_refs").run({}, { projectDir: dir, metadata: meta }),
    /mediaId.*required/i,
  );
  await assert.rejects(
    () => tools.get("get_media_refs").run({ mediaId: "missing" }, { projectDir: dir, metadata: meta }),
    /not found/i,
  );
  await fs.rm(dir, { recursive: true });
});

test("get_media_refs: returns empty referencedBy when no entity holds the media", async () => {
  const dir = await makeProject();
  await seedMediaIndex(dir, [
    { id: "m_orphan", path: "orphan.png", kind: "image", sha256: "abc" },
  ]);
  const tools = buildToolApi(dir);
  const meta = await readMeta(dir);
  const r = await tools.get("get_media_refs").run({ mediaId: "m_orphan" }, { projectDir: dir, metadata: meta });
  assert.equal(r.count, 0);
  assert.deepEqual(r.referencedBy, []);
  await fs.rm(dir, { recursive: true });
});

// =============================================================================
// update_asset_entry
// =============================================================================

test("update_asset_entry: rewrites name + title together; previous values surfaced", async () => {
  const dir = await makeProject({
    characters: [{ id: "c1", name: "Alex", title: "Alex", content: "old content", path: "characters/alex.md", media: [] }],
  });
  const tools = buildToolApi(dir);
  const r = await tools.get("update_asset_entry").run(
    { section: "characters", assetId: "c1", name: "Alexandra" },
    { projectDir: dir },
  );
  assert.equal(r.updated, true);
  assert.equal(r.asset.name, "Alexandra");
  assert.equal(r.previous.name, "Alex");
  const meta = await readMeta(dir);
  const entry = meta.characters[0];
  assert.equal(entry.name, "Alexandra");
  assert.equal(entry.title, "Alexandra", "title kept in sync with name");
  await fs.rm(dir, { recursive: true });
});

test("update_asset_entry: empty/no-op patch returns updated:false without touching disk", async () => {
  const dir = await makeProject({
    characters: [{ id: "c1", name: "Alex", title: "Alex", content: "x", path: "characters/alex.md", media: [] }],
  });
  const before = await readMeta(dir);
  const tools = buildToolApi(dir);
  const r = await tools.get("update_asset_entry").run(
    { section: "characters", assetId: "c1" },
    { projectDir: dir },
  );
  assert.equal(r.updated, false);
  assert.match(r.reason, /no changes/i);
  const after = await readMeta(dir);
  assert.deepEqual(before.characters, after.characters, "disk untouched on no-op");
  await fs.rm(dir, { recursive: true });
});

test("update_asset_entry: audioKind only valid on the audio section", async () => {
  const dir = await makeProject({
    characters: [{ id: "c1", name: "Alex", title: "Alex", path: "characters/alex.md", media: [] }],
    audio: [{ id: "a1", name: "Theme", title: "Theme", path: "audio/theme.md", audioKind: "music", media: [] }],
  });
  const tools = buildToolApi(dir);

  await assert.rejects(
    () => tools.get("update_asset_entry").run(
      { section: "characters", assetId: "c1", audioKind: "music" },
      { projectDir: dir },
    ),
    /only valid for the audio section/i,
  );

  const r = await tools.get("update_asset_entry").run(
    { section: "audio", assetId: "a1", audioKind: "sfx" },
    { projectDir: dir },
  );
  assert.equal(r.updated, true);
  assert.equal(r.asset.audioKind, "sfx");
  await fs.rm(dir, { recursive: true });
});

test("update_asset_entry: invalid audioKind rejected", async () => {
  const dir = await makeProject({
    audio: [{ id: "a1", name: "Theme", title: "Theme", path: "audio/theme.md", audioKind: "music", media: [] }],
  });
  const tools = buildToolApi(dir);
  await assert.rejects(
    () => tools.get("update_asset_entry").run(
      { section: "audio", assetId: "a1", audioKind: "bogus" },
      { projectDir: dir },
    ),
    /must be one of/i,
  );
  await fs.rm(dir, { recursive: true });
});

test("update_asset_entry: empty name string is rejected", async () => {
  const dir = await makeProject({
    characters: [{ id: "c1", name: "Alex", title: "Alex", path: "characters/alex.md", media: [] }],
  });
  const tools = buildToolApi(dir);
  await assert.rejects(
    () => tools.get("update_asset_entry").run(
      { section: "characters", assetId: "c1", name: "   " },
      { projectDir: dir },
    ),
    /cannot be empty/i,
  );
  await fs.rm(dir, { recursive: true });
});

test("update_asset_entry: throws when assetId not in section", async () => {
  const dir = await makeProject();
  const tools = buildToolApi(dir);
  await assert.rejects(
    () => tools.get("update_asset_entry").run(
      { section: "characters", assetId: "missing" },
      { projectDir: dir },
    ),
    /not found/i,
  );
  await fs.rm(dir, { recursive: true });
});
