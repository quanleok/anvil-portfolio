const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs/promises");
const path = require("node:path");

const magicDocs = require("../magic-docs.cjs");

async function makeTempProject() {
  return fs.mkdtemp(path.join(os.tmpdir(), "forge-magic-"));
}

test("ensureDefaultMagicDocs seeds the standard distilled docs", async () => {
  const projectDir = await makeTempProject();
  await magicDocs.ensureDefaultMagicDocs(projectDir);
  const docs = await magicDocs.listMagicDocs(projectDir);
	  assert.deepEqual(
	    docs.map((doc) => doc.name),
	    ["Asset Library"],
	  );
  assert.ok(docs.every((doc) => doc.neverSynthesized));
});

test("describeMagicDoc marks unsupported scope patterns as broken", async () => {
  const projectDir = await makeTempProject();
  await magicDocs.writeMagicDocFile(projectDir, {
    name: "Broken Doc",
    description: "x",
    kind: "custom",
    scope: ["scenes/*/beats.md"],
    instruction: "y",
    updatedAt: "",
    sourcesHash: "",
    synthesizedBodyHash: "",
    allowEmptyScope: false,
    body: "",
  });
  const doc = await magicDocs.describeMagicDoc(projectDir, "Broken Doc");
  assert.equal(doc.status, "broken");
  assert.ok(doc.scopeErrors[0].includes("Unsupported scope pattern"));
});

test("readAssetContextGuide creates a stable shared guide and writeAssetContextGuide persists content", async () => {
  const projectDir = await makeTempProject();
  await magicDocs.ensureDefaultMagicDocs(projectDir);

  const initial = await magicDocs.readAssetContextGuide(projectDir);
  assert.equal(initial?.path, ".forge/asset-context/guide.md");
  assert.equal(initial?.name, "Asset Context");
  assert.equal(initial?.content, "");
  assert.deepEqual(initial?.references, []);

  await magicDocs.writeAssetContextGuide(projectDir, "# Style Rules\nKeep silhouettes readable.");
  const updated = await magicDocs.readAssetContextGuide(projectDir);
  assert.match(updated?.content || "", /Style Rules/);
});

test("readAssetContextGuide lists reference images from the shared guide folder", async () => {
  const projectDir = await makeTempProject();
  await magicDocs.ensureDefaultMagicDocs(projectDir);
  const refDir = magicDocs.assetContextReferenceDir(projectDir);
  await fs.mkdir(refDir, { recursive: true });
  await fs.writeFile(path.join(refDir, "moodboard.png"), "fake");
  await fs.writeFile(path.join(refDir, "notes.txt"), "ignore");

  const guide = await magicDocs.readAssetContextGuide(projectDir);
  assert.deepEqual(
    guide?.references.map((entry) => entry.path),
    [".forge/asset-context/references/moodboard.png"],
  );
});

test("readAssetContextGuide migrates legacy per-doc asset guides once", async () => {
  const projectDir = await makeTempProject();
  await magicDocs.ensureDefaultMagicDocs(projectDir);
  const legacyDir = path.join(projectDir, ".forge", "magic-guides");
  await fs.mkdir(path.join(legacyDir, "character-bible"), { recursive: true });
  await fs.writeFile(path.join(legacyDir, "character-bible.md"), "Keep silhouettes readable.");
  await fs.writeFile(path.join(legacyDir, "location-atlas.md"), "Use stone and bronze.");
  await fs.writeFile(path.join(legacyDir, "character-bible", "portrait.png"), "fake");

  const guide = await magicDocs.readAssetContextGuide(projectDir);
  assert.match(guide.content, /Character Bible Guide/);
  assert.match(guide.content, /Location Atlas Guide/);
  assert.match(guide.content, /silhouettes/);
  assert.deepEqual(
    guide.references.map((entry) => entry.path),
    [".forge/asset-context/references/character-bible-portrait.png"],
  );
});
