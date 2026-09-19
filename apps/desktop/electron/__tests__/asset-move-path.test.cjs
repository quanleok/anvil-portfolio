// Regression tests for review finding M3 (2026-05-04):
// move_asset_entry must NOT blank the entry's `path` field. Long-form
// prose lives in the backing markdown file (e.g. characters/alex.md);
// blanking the path silently detaches the entry from that file.
//
// Fix: re-derive path under the destination section's convention
// (e.g. locations/alex.md), and physically relocate the .md file on
// disk if it exists at the source path.

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

function buildAssetApi(projectDir) {
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
  };
  registerAssetTools(api);
  return tools;
}

async function makeProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anvil-asset-move-path-"));
  await fs.mkdir(path.join(dir, ".forge"), { recursive: true });
  await fs.writeFile(
    path.join(dir, ".forge", "project.json"),
    JSON.stringify({
      project: { id: "p", name: "test" },
      characters: [], locations: [], props: [], keyframes: [], audio: [], library: [],
    }),
  );
  return dir;
}

async function readMeta(dir) {
  return JSON.parse(await fs.readFile(path.join(dir, ".forge", "project.json"), "utf8"));
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

test("M3 — move_asset_entry rewrites path to destination section convention (does not blank it)", async () => {
  const proj = await makeProject();
  const tools = buildAssetApi(proj);
  const create = tools.get("create_asset_entry");
  const move = tools.get("move_asset_entry");
  const ctx = { projectDir: proj };

  const created = await create.run({ section: "characters", name: "Alex" }, ctx);

  const moved = await move.run({ fromSection: "characters", toSection: "locations", assetId: created.id }, ctx);

  assert.notEqual(moved.path, "", "moved entry path is non-empty");
  assert.match(moved.path, /^locations\//, "path is under destination section");

  const meta = await readMeta(proj);
  const movedEntry = meta.locations.find((e) => e.id === created.id);
  assert.ok(movedEntry, "moved entry persisted");
  assert.notEqual(movedEntry.path, "", "persisted path is non-empty");
  assert.match(movedEntry.path, /^locations\//, "persisted path under destination");

  await fs.rm(proj, { recursive: true });
});

test("M3 — move_asset_entry relocates the backing markdown file on disk", async () => {
  const proj = await makeProject();
  const tools = buildAssetApi(proj);
  const create = tools.get("create_asset_entry");
  const move = tools.get("move_asset_entry");
  const ctx = { projectDir: proj };

  const created = await create.run({ section: "characters", name: "Alex" }, ctx);

  // Simulate a user-authored markdown file at the source path.
  const sourceFile = path.join(proj, created.path);
  await fs.mkdir(path.dirname(sourceFile), { recursive: true });
  const userProse = "# Alex\n\nLong-form character notes that live in the .md file.\n";
  await fs.writeFile(sourceFile, userProse, "utf8");
  assert.equal(await fileExists(sourceFile), true, "precondition: source file exists");

  const moved = await move.run({ fromSection: "characters", toSection: "locations", assetId: created.id }, ctx);

  const destFile = path.join(proj, moved.path);
  assert.equal(await fileExists(destFile), true, "markdown file relocated to destination path");
  assert.equal(await fileExists(sourceFile), false, "markdown file no longer at source path");
  const destContent = await fs.readFile(destFile, "utf8");
  assert.equal(destContent, userProse, "file content survives the move byte-for-byte");

  await fs.rm(proj, { recursive: true });
});

test("M3 — move_asset_entry without a backing markdown file still computes a valid destination path", async () => {
  const proj = await makeProject();
  const tools = buildAssetApi(proj);
  const create = tools.get("create_asset_entry");
  const move = tools.get("move_asset_entry");
  const ctx = { projectDir: proj };

  const created = await create.run({ section: "props", name: "Sword" }, ctx);
  // Do not author any markdown file on disk — only metadata exists.

  const moved = await move.run({ fromSection: "props", toSection: "keyframes", assetId: created.id }, ctx);

  assert.notEqual(moved.path, "", "path computed even without backing file");
  assert.match(moved.path, /^keyframes\//, "destination convention applied");

  await fs.rm(proj, { recursive: true });
});

test("M3 — move_asset_entry preserves id and content fields (still passes after path-fix change)", async () => {
  const proj = await makeProject();
  const tools = buildAssetApi(proj);
  const create = tools.get("create_asset_entry");
  const move = tools.get("move_asset_entry");
  const ctx = { projectDir: proj };

  const created = await create.run({ section: "keyframes", name: "Kingdom Map", content: "wide shot of the realm" }, ctx);

  const moved = await move.run({ fromSection: "keyframes", toSection: "locations", assetId: created.id }, ctx);
  assert.equal(moved.assetId, created.id, "id preserved");

  const meta = await readMeta(proj);
  const entry = meta.locations.find((e) => e.id === created.id);
  assert.equal(entry.content, "wide shot of the realm", "content preserved");
  assert.equal(entry.id, created.id, "id preserved on disk");
});
