const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  ASSET_MANIFEST_PATH,
  buildAssetManifest,
  writeAssetManifest,
} = require("../asset-manifest.cjs");

async function makeProject() {
  return fs.mkdtemp(path.join(os.tmpdir(), "anvil-asset-manifest-"));
}

test("asset manifest maps card names to bound media paths", async () => {
  const projectDir = await makeProject();
  try {
    await fs.mkdir(path.join(projectDir, "assets", "characters"), { recursive: true });
    await fs.writeFile(path.join(projectDir, "assets", "characters", "brute.png"), "image");

    const manifest = await buildAssetManifest(projectDir, {
      characters: [
        {
          id: "char-brute",
          name: "Brute",
          media: [
            { id: "m1", label: "hero", kind: "image", path: "assets/characters/brute.png" },
            { id: "m2", label: "alt", kind: "image", path: "assets/characters/brute-alt.png" },
          ],
        },
      ],
      locations: [],
      props: [],
      keyframes: [],
      audio: [],
      library: [],
    });

    assert.ok(manifest.includes("# Anvil Asset Index"));
    assert.ok(manifest.includes("Do not pick media by guessing"));
    assert.ok(manifest.includes("| Brute | char-brute | hero: assets/characters/brute.png | MISSING alt: assets/characters/brute-alt.png |"));
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

test("writeAssetManifest is idempotent when content is unchanged", async () => {
  const projectDir = await makeProject();
  try {
    const project = {
      characters: [],
      locations: [],
      props: [],
      keyframes: [],
      audio: [],
      library: [],
    };
    const first = await writeAssetManifest(projectDir, project);
    const second = await writeAssetManifest(projectDir, project);

    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.ok(await fs.readFile(path.join(projectDir, ASSET_MANIFEST_PATH), "utf8"));
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});
