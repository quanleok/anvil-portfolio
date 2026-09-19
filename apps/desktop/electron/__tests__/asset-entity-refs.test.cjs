// Regression tests for review finding H1 (2026-05-04):
// delete_asset_entry / delete_asset_entries must strip entityRefs in
// script / shots / prompts / dialogue that point at the deleted asset id.
// Pre-fix: stale ids accumulated in doc meta after every asset deletion.

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

async function makeProject(seed) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anvil-asset-entity-refs-"));
  await fs.mkdir(path.join(dir, ".forge"), { recursive: true });
  const base = {
    project: { id: "p", name: "test" },
    characters: [],
    locations: [],
    props: [],
    keyframes: [],
    audio: [],
    library: [],
    script: [],
    shots: [],
    prompts: [],
    dialogue: [],
    ...seed,
  };
  await fs.writeFile(path.join(dir, ".forge", "project.json"), JSON.stringify(base));
  return dir;
}

async function readMeta(dir) {
  return JSON.parse(await fs.readFile(path.join(dir, ".forge", "project.json"), "utf8"));
}

function makeDocEntry({ id, title, refs }) {
  // entityRefs as the runtime top-level array. The fix must strip these
  // even when meta is absent — many runtime paths persist the array.
  return {
    id,
    title,
    path: `prompts/${id}.md`,
    entityRefs: refs.map((ref) => ({ entityId: ref.entityId, section: ref.section, role: ref.role || "featured" })),
  };
}

function makeDocEntryWithMeta({ id, title, refs }) {
  // Persisted serialized form — entityRefs is a JSON string under meta,
  // mirrored into per-section JSON arrays. Both produced by serializeEntityRefsMeta.
  const explicit = refs.map((r) => ({ entityId: r.entityId, section: r.section, role: r.role || "featured" }));
  const meta = { entityRefs: JSON.stringify(explicit) };
  for (const section of ["characters", "locations", "props", "keyframes", "audio"]) {
    const ids = explicit.filter((r) => r.section === section).map((r) => r.entityId);
    if (ids.length) meta[section] = JSON.stringify(ids);
  }
  return {
    id,
    title,
    path: `prompts/${id}.md`,
    meta,
  };
}

test("H1 — delete_asset_entry strips entityRefs from prompts (runtime array form)", async () => {
  const alex = { id: "char_alex_id", name: "Alex", title: "Alex", content: "", path: "characters/alex.md", folder: null, media: [] };
  const bob = { id: "char_bob_id", name: "Bob", title: "Bob", content: "", path: "characters/bob.md", folder: null, media: [] };
  const proj = await makeProject({
    characters: [alex, bob],
    prompts: [
      makeDocEntry({ id: "prompt_1", title: "p1", refs: [{ entityId: "char_alex_id", section: "characters" }, { entityId: "char_bob_id", section: "characters" }] }),
      makeDocEntry({ id: "prompt_2", title: "p2", refs: [{ entityId: "char_alex_id", section: "characters" }] }),
      makeDocEntry({ id: "prompt_3", title: "p3", refs: [{ entityId: "char_bob_id", section: "characters" }] }),
    ],
  });
  const tools = buildAssetApi(proj);
  const del = tools.get("delete_asset_entry");

  await del.run({ section: "characters", assetId: "char_alex_id" }, { projectDir: proj });

  const meta = await readMeta(proj);
  assert.equal(meta.characters.length, 1, "alex removed");
  assert.equal(meta.characters[0].id, "char_bob_id");

  // prompt_1 had alex + bob; alex should be gone, bob should remain.
  const p1 = meta.prompts.find((p) => p.id === "prompt_1");
  assert.ok(p1, "prompt_1 still exists");
  assert.equal(Array.isArray(p1.entityRefs) ? p1.entityRefs.length : -1, 1, "prompt_1 has one ref left");
  assert.equal(p1.entityRefs[0].entityId, "char_bob_id");

  // prompt_2 had only alex; entityRefs should now be empty.
  const p2 = meta.prompts.find((p) => p.id === "prompt_2");
  assert.deepEqual(p2.entityRefs, [], "prompt_2 has no refs left");

  // prompt_3 only had bob; should be untouched.
  const p3 = meta.prompts.find((p) => p.id === "prompt_3");
  assert.equal(p3.entityRefs.length, 1);
  assert.equal(p3.entityRefs[0].entityId, "char_bob_id");

  await fs.rm(proj, { recursive: true });
});

test("H1 — delete_asset_entry strips entityRefs from script/shots/dialogue (all four sections)", async () => {
  const loc = { id: "loc_kingdom_id", name: "Kingdom", title: "Kingdom", content: "", path: "locations/kingdom.md", folder: null, media: [] };
  const proj = await makeProject({
    locations: [loc],
    script: [makeDocEntry({ id: "scene_1", title: "s1", refs: [{ entityId: "loc_kingdom_id", section: "locations" }] })],
    shots: [makeDocEntry({ id: "shot_1", title: "sh1", refs: [{ entityId: "loc_kingdom_id", section: "locations" }] })],
    prompts: [makeDocEntry({ id: "prompt_1", title: "p1", refs: [{ entityId: "loc_kingdom_id", section: "locations" }] })],
    dialogue: [makeDocEntry({ id: "dlg_1", title: "d1", refs: [{ entityId: "loc_kingdom_id", section: "locations" }] })],
  });
  const tools = buildAssetApi(proj);
  const del = tools.get("delete_asset_entry");

  await del.run({ section: "locations", assetId: "loc_kingdom_id" }, { projectDir: proj });

  const meta = await readMeta(proj);
  assert.equal(meta.locations.length, 0, "kingdom deleted");
  assert.deepEqual(meta.script[0].entityRefs, [], "script entry refs cleared");
  assert.deepEqual(meta.shots[0].entityRefs, [], "shot entry refs cleared");
  assert.deepEqual(meta.prompts[0].entityRefs, [], "prompt entry refs cleared");
  assert.deepEqual(meta.dialogue[0].entityRefs, [], "dialogue entry refs cleared");

  await fs.rm(proj, { recursive: true });
});

test("H1 — delete_asset_entry strips entityRefs from persisted meta form (string + section keys)", async () => {
  const alex = { id: "char_alex_id", name: "Alex", title: "Alex", content: "", path: "characters/alex.md", folder: null, media: [] };
  const proj = await makeProject({
    characters: [alex],
    prompts: [makeDocEntryWithMeta({ id: "prompt_meta", title: "pm", refs: [{ entityId: "char_alex_id", section: "characters" }] })],
  });
  const tools = buildAssetApi(proj);
  const del = tools.get("delete_asset_entry");

  await del.run({ section: "characters", assetId: "char_alex_id" }, { projectDir: proj });

  const meta = await readMeta(proj);
  const prompt = meta.prompts.find((p) => p.id === "prompt_meta");
  assert.ok(prompt, "prompt entry still present");

  // After cleanup the serialized meta.entityRefs should either be absent or
  // an empty array; the per-section key (meta.characters) should be gone.
  const refsStr = prompt.meta?.entityRefs;
  if (refsStr) {
    const parsed = JSON.parse(refsStr);
    assert.deepEqual(parsed, [], "meta.entityRefs is empty after cleanup");
  }
  assert.equal(prompt.meta?.characters, undefined, "meta.characters legacy key removed");

  await fs.rm(proj, { recursive: true });
});

test("H1 — delete_asset_entries (bulk) strips entityRefs for every deleted id", async () => {
  const alex = { id: "char_alex_id", name: "Alex", title: "Alex", content: "", path: "characters/alex.md", folder: null, media: [] };
  const bob = { id: "char_bob_id", name: "Bob", title: "Bob", content: "", path: "characters/bob.md", folder: null, media: [] };
  const cora = { id: "char_cora_id", name: "Cora", title: "Cora", content: "", path: "characters/cora.md", folder: null, media: [] };
  const proj = await makeProject({
    characters: [alex, bob, cora],
    prompts: [
      makeDocEntry({ id: "p1", title: "p1", refs: [
        { entityId: "char_alex_id", section: "characters" },
        { entityId: "char_bob_id", section: "characters" },
        { entityId: "char_cora_id", section: "characters" },
      ] }),
    ],
  });
  const tools = buildAssetApi(proj);
  const delBulk = tools.get("delete_asset_entries");

  await delBulk.run({ section: "characters", ids: ["char_alex_id", "char_bob_id"] }, { projectDir: proj });

  const meta = await readMeta(proj);
  assert.equal(meta.characters.length, 1);
  assert.equal(meta.characters[0].id, "char_cora_id");

  const p1 = meta.prompts[0];
  assert.equal(p1.entityRefs.length, 1, "only cora ref remains");
  assert.equal(p1.entityRefs[0].entityId, "char_cora_id");

  await fs.rm(proj, { recursive: true });
});

test("H1 — delete_asset_entry leaves unrelated entries' refs untouched", async () => {
  const alex = { id: "char_alex_id", name: "Alex", title: "Alex", content: "", path: "characters/alex.md", folder: null, media: [] };
  const bob = { id: "char_bob_id", name: "Bob", title: "Bob", content: "", path: "characters/bob.md", folder: null, media: [] };
  const proj = await makeProject({
    characters: [alex, bob],
    prompts: [
      makeDocEntry({ id: "p1", title: "p1", refs: [{ entityId: "char_bob_id", section: "characters" }] }),
    ],
  });
  const tools = buildAssetApi(proj);
  const del = tools.get("delete_asset_entry");

  await del.run({ section: "characters", assetId: "char_alex_id" }, { projectDir: proj });

  const meta = await readMeta(proj);
  // bob's ref must survive untouched.
  assert.equal(meta.prompts[0].entityRefs.length, 1);
  assert.equal(meta.prompts[0].entityRefs[0].entityId, "char_bob_id");

  await fs.rm(proj, { recursive: true });
});
