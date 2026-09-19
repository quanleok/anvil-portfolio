// Regression test for review finding M1 (2026-05-04):
// normalize_asset_media_names previously called fs.rename inside the
// per-entry loop and writeProjectMetadata once at the end. A crash or
// write failure mid-batch left files renamed on disk while project.json
// still referenced the old paths.
//
// Fix: write metadata FIRST (atomic), THEN do the renames. Test proves
// the ordering by making writeProjectMetadata throw and asserting that
// no fs.rename happened.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");

const builtins = require("../system/tools/builtins.cjs");
const registerAssetTools = require("../system/tools/assets.cjs");

const ASSET_SECTIONS = ["characters", "locations", "props", "keyframes", "audio"];

function makeAssetEntry(section, name) {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "asset";
  return {
    id: `${section.slice(0, 3)}_${randomUUID()}`,
    name,
    title: name,
    content: "",
    path: `${section}/${slug}.md`,
    folder: null,
    media: [],
  };
}

function buildAssetApi(projectDir, overrides = {}) {
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
    ...overrides,
  };
  registerAssetTools(api);
  return tools;
}

async function makeProjectWithMedia() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anvil-asset-normalize-order-"));
  await fs.mkdir(path.join(dir, ".forge"), { recursive: true });
  await fs.mkdir(path.join(dir, "assets/characters"), { recursive: true });
  // Two media files at non-canonical names; the entry has the canonical name
  // "Alex" — normalizer will want to rename them to alex.png / alex-2.png.
  await fs.writeFile(path.join(dir, "assets/characters/messy_name.png"), "img1-bytes");
  await fs.writeFile(path.join(dir, "assets/characters/another_messy.png"), "img2-bytes");
  const charId = "char_alex_id";
  const meta = {
    project: { id: "p", name: "test" },
    characters: [{
      id: charId,
      name: "Alex",
      title: "Alex",
      content: "",
      path: "characters/alex.md",
      folder: null,
      media: [
        { id: "m1", kind: "image", label: "messy_name.png", path: "assets/characters/messy_name.png" },
        { id: "m2", kind: "image", label: "another_messy.png", path: "assets/characters/another_messy.png" },
      ],
    }],
    locations: [], props: [], keyframes: [], audio: [], library: [],
  };
  await fs.writeFile(path.join(dir, ".forge", "project.json"), JSON.stringify(meta));
  return { dir, charId };
}

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

test("M1 — when writeProjectMetadata throws, no fs.rename has happened (write-first ordering)", async () => {
  const { dir } = await makeProjectWithMedia();
  // Inject a failing writeProjectMetadata. If the implementation reorders
  // metadata-write BEFORE rename, this throw aborts before any disk move.
  const tools = buildAssetApi(dir, {
    writeProjectMetadata: async () => { throw new Error("simulated metadata write failure"); },
  });

  const oldPath1 = path.join(dir, "assets/characters/messy_name.png");
  const oldPath2 = path.join(dir, "assets/characters/another_messy.png");
  assert.equal(await fileExists(oldPath1), true, "precondition: source file 1 exists");
  assert.equal(await fileExists(oldPath2), true, "precondition: source file 2 exists");

  let err;
  try {
    await tools.get("normalize_asset_media_names").run({ section: "characters" }, { projectDir: dir });
  } catch (e) {
    err = e;
  }
  assert.ok(err, "metadata write failure surfaces as a thrown error");

  // The smoking gun: source files MUST still be at their old paths.
  // Pre-fix this assertion failed — fs.rename ran before writeProjectMetadata.
  assert.equal(await fileExists(oldPath1), true, "no rename happened for file 1 (write-first proven)");
  assert.equal(await fileExists(oldPath2), true, "no rename happened for file 2 (write-first proven)");

  await fs.rm(dir, { recursive: true });
});

test("M1 — normalize_asset_media_names happy path: metadata + disk both reflect new names", async () => {
  const { dir, charId } = await makeProjectWithMedia();
  const tools = buildAssetApi(dir);

  const result = await tools.get("normalize_asset_media_names").run({ section: "characters" }, { projectDir: dir });
  assert.equal(result.dryRun, false);
  assert.ok(result.count >= 1, "at least one rename happened");

  const meta = JSON.parse(await fs.readFile(path.join(dir, ".forge", "project.json"), "utf8"));
  const entry = meta.characters.find((e) => e.id === charId);
  assert.ok(entry, "entry persisted");
  // Each media path should be in the canonical alex* form.
  for (const m of entry.media) {
    assert.match(m.path, /\/alex(-\d+)?\.png$/, `media path ${m.path} normalized`);
    // And the file must actually exist at that path on disk.
    assert.equal(await fileExists(path.join(dir, m.path)), true, `media file at new path on disk: ${m.path}`);
  }
  await fs.rm(dir, { recursive: true });
});

test("M1 — dryRun does not write metadata or rename files", async () => {
  const { dir } = await makeProjectWithMedia();
  const tools = buildAssetApi(dir);

  const before = JSON.parse(await fs.readFile(path.join(dir, ".forge", "project.json"), "utf8"));
  const result = await tools.get("normalize_asset_media_names").run({ section: "characters", dryRun: true }, { projectDir: dir });
  assert.equal(result.dryRun, true);
  assert.ok(result.renames.length >= 1, "renames computed even in dryRun");
  const after = JSON.parse(await fs.readFile(path.join(dir, ".forge", "project.json"), "utf8"));
  assert.deepEqual(before, after, "project.json untouched in dryRun");
  // Original files still at their original paths.
  assert.equal(await fileExists(path.join(dir, "assets/characters/messy_name.png")), true);
  assert.equal(await fileExists(path.join(dir, "assets/characters/another_messy.png")), true);
  await fs.rm(dir, { recursive: true });
});
