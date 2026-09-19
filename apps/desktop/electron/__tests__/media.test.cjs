const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs/promises");
const path = require("node:path");

const {
  hashFile,
  classifyMediaFile,
  buildMediaIndex,
  readMediaIndex,
  writeMediaIndex,
  reconcileMedia,
  computeReferences,
  SUPPORTED_EXTENSIONS,
} = require("../media.cjs");

async function makeTempProject() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "forge-media-"));
}

async function seedAssets(projectDir, fileMap) {
  for (const [relativePath, content] of Object.entries(fileMap)) {
    const fullPath = path.join(projectDir, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content);
  }
}

// ---------------------------------------------------------------------------
// hashFile
// ---------------------------------------------------------------------------

test("hashFile produces consistent SHA-256 for known content", async () => {
  const dir = await makeTempProject();
  const filePath = path.join(dir, "sample.bin");
  await fs.writeFile(filePath, "hello world");
  const hash = await hashFile(filePath);
  // SHA-256 of "hello world" is well-known
  assert.equal(hash, "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
  // Hash again — must be identical
  const hash2 = await hashFile(filePath);
  assert.equal(hash, hash2);
});

// ---------------------------------------------------------------------------
// classifyMediaFile
// ---------------------------------------------------------------------------

test("classifyMediaFile correctly classifies by extension", () => {
  assert.equal(classifyMediaFile("photo.png"), "image");
  assert.equal(classifyMediaFile("photo.JPG"), "image");
  assert.equal(classifyMediaFile("photo.jpeg"), "image");
  assert.equal(classifyMediaFile("photo.gif"), "image");
  assert.equal(classifyMediaFile("photo.webp"), "image");
  assert.equal(classifyMediaFile("photo.svg"), "image");
  assert.equal(classifyMediaFile("photo.bmp"), "image");
  assert.equal(classifyMediaFile("photo.tiff"), "image");
  assert.equal(classifyMediaFile("photo.avif"), "image");
  assert.equal(classifyMediaFile("photo.heic"), "image");

  assert.equal(classifyMediaFile("track.mp3"), "audio");
  assert.equal(classifyMediaFile("track.wav"), "audio");
  assert.equal(classifyMediaFile("track.aac"), "audio");
  assert.equal(classifyMediaFile("track.ogg"), "audio");
  assert.equal(classifyMediaFile("track.flac"), "audio");
  assert.equal(classifyMediaFile("track.m4a"), "audio");
  assert.equal(classifyMediaFile("track.opus"), "audio");

  assert.equal(classifyMediaFile("clip.mp4"), "video");
  assert.equal(classifyMediaFile("clip.mov"), "video");
  assert.equal(classifyMediaFile("clip.webm"), "video");
  assert.equal(classifyMediaFile("clip.avi"), "video");
  assert.equal(classifyMediaFile("clip.mkv"), "video");
  assert.equal(classifyMediaFile("clip.m4v"), "video");

  assert.equal(classifyMediaFile("doc.pdf"), "document");

  assert.equal(classifyMediaFile("readme.txt"), null);
  assert.equal(classifyMediaFile("data.json"), null);
  assert.equal(classifyMediaFile("script.js"), null);
  assert.equal(classifyMediaFile(""), null);
});

// ---------------------------------------------------------------------------
// buildMediaIndex
// ---------------------------------------------------------------------------

test("buildMediaIndex returns records for files under assets/", async () => {
  const dir = await makeTempProject();
  await seedAssets(dir, {
    "assets/characters/hero.png": "hero-image-data",
    "assets/audio/theme.mp3": "audio-data",
    "assets/_pool/raw.jpg": "pool-image",
    "assets/library/ref.wav": "lib-audio",
  });

  const index = await buildMediaIndex(dir);
  const records = Object.values(index);
  assert.equal(records.length, 4);

  const paths = records.map((r) => r.path).sort();
  assert.deepEqual(paths, [
    "assets/_pool/raw.jpg",
    "assets/audio/theme.mp3",
    "assets/characters/hero.png",
    "assets/library/ref.wav",
  ]);

  // Check sources. assets/_pool/ is now classified as "library" (Pool
  // was retired — existing pool files surface as regular library media).
  const byPath = Object.fromEntries(records.map((r) => [r.path, r]));
  assert.equal(byPath["assets/_pool/raw.jpg"].source, "library");
  assert.equal(byPath["assets/library/ref.wav"].source, "library");
  assert.equal(byPath["assets/characters/hero.png"].source, "asset");
  assert.equal(byPath["assets/audio/theme.mp3"].source, "asset");

  // Check kinds
  assert.equal(byPath["assets/characters/hero.png"].kind, "image");
  assert.equal(byPath["assets/audio/theme.mp3"].kind, "audio");
});

test("buildMediaIndex skips hidden files and unsupported extensions", async () => {
  const dir = await makeTempProject();
  await seedAssets(dir, {
    "assets/.hidden.png": "hidden",
    "assets/notes.txt": "text",
    "assets/valid.png": "valid",
  });

  const index = await buildMediaIndex(dir);
  const records = Object.values(index);
  assert.equal(records.length, 1);
  assert.equal(records[0].path, "assets/valid.png");
});

test("buildMediaIndex handles missing assets/ directory gracefully", async () => {
  const dir = await makeTempProject();
  const index = await buildMediaIndex(dir);
  assert.deepEqual(index, {});
});

// ---------------------------------------------------------------------------
// Deterministic IDs
// ---------------------------------------------------------------------------

test("buildMediaIndex produces deterministic IDs across repeated scans", async () => {
  const dir = await makeTempProject();
  await seedAssets(dir, {
    "assets/characters/hero.png": "hero-data",
    "assets/audio/theme.mp3": "audio-data",
  });

  const index1 = await buildMediaIndex(dir);
  const index2 = await buildMediaIndex(dir);

  const ids1 = Object.keys(index1).sort();
  const ids2 = Object.keys(index2).sort();
  assert.deepEqual(ids1, ids2);

  // Same paths produce same IDs
  for (const id of ids1) {
    assert.equal(index1[id].path, index2[id].path);
    assert.equal(index1[id].sha256, index2[id].sha256);
  }
});

// ---------------------------------------------------------------------------
// readMediaIndex / writeMediaIndex
// ---------------------------------------------------------------------------

test("writeMediaIndex + readMediaIndex round-trips the index", async () => {
  const dir = await makeTempProject();
  const index = {
    abc123: {
      id: "abc123",
      path: "assets/characters/hero.png",
      sha256: "deadbeef",
      sizeBytes: 1024,
      kind: "image",
      source: "asset",
      addedAt: "2026-01-01T00:00:00.000Z",
    },
  };

  await writeMediaIndex(dir, index);
  const loaded = await readMediaIndex(dir);
  assert.deepEqual(loaded, index);
});

test("readMediaIndex returns empty object when index does not exist", async () => {
  const dir = await makeTempProject();
  const loaded = await readMediaIndex(dir);
  assert.deepEqual(loaded, {});
});

// ---------------------------------------------------------------------------
// reconcileMedia
// ---------------------------------------------------------------------------

test("reconcileMedia detects added files", async () => {
  const dir = await makeTempProject();
  // Write an empty stored index
  await writeMediaIndex(dir, {});
  // Add files on disk
  await seedAssets(dir, {
    "assets/characters/hero.png": "hero-data",
  });

  const result = await reconcileMedia(dir);
  assert.equal(result.added.length, 1);
  assert.equal(result.removed.length, 0);
  assert.equal(result.moved.length, 0);
  assert.equal(result.total, 1);
});

test("reconcileMedia detects removed files", async () => {
  const dir = await makeTempProject();
  // Seed files and build an index
  await seedAssets(dir, {
    "assets/characters/hero.png": "hero-data",
  });
  const index = await buildMediaIndex(dir);
  await writeMediaIndex(dir, index);

  // Remove the file
  await fs.rm(path.join(dir, "assets/characters/hero.png"));

  const result = await reconcileMedia(dir);
  assert.equal(result.added.length, 0);
  assert.equal(result.removed.length, 1);
  assert.equal(result.total, 0);
});

test("reconcileMedia detects moved files (same hash, different path)", async () => {
  const dir = await makeTempProject();
  await seedAssets(dir, {
    "assets/characters/hero.png": "hero-data",
  });
  const index = await buildMediaIndex(dir);
  await writeMediaIndex(dir, index);

  // Move the file
  await fs.mkdir(path.join(dir, "assets/props"), { recursive: true });
  await fs.rename(
    path.join(dir, "assets/characters/hero.png"),
    path.join(dir, "assets/props/hero.png"),
  );

  const result = await reconcileMedia(dir);
  assert.equal(result.moved.length, 1);
  assert.equal(result.moved[0].path, "assets/props/hero.png");
  assert.equal(result.added.length, 0);
  assert.equal(result.removed.length, 0);
});

// ---------------------------------------------------------------------------
// computeReferences
// ---------------------------------------------------------------------------

test("computeReferences populates referencedBy from metadata entity media arrays", () => {
  const mediaIndex = {
    aaa: {
      id: "aaa",
      path: "assets/characters/hero.png",
      sha256: "h1",
      sizeBytes: 100,
      kind: "image",
      source: "asset",
      addedAt: "2026-01-01T00:00:00.000Z",
    },
    bbb: {
      id: "bbb",
      path: "assets/audio/theme.mp3",
      sha256: "h2",
      sizeBytes: 200,
      kind: "audio",
      source: "asset",
      addedAt: "2026-01-01T00:00:00.000Z",
    },
    ccc: {
      id: "ccc",
      path: "assets/library/bg.png",
      sha256: "h3",
      sizeBytes: 300,
      kind: "image",
      source: "library",
      addedAt: "2026-01-01T00:00:00.000Z",
    },
  };

  const metadata = {
    characters: [
      {
        id: "char-1",
        media: [{ path: "assets/characters/hero.png" }],
      },
    ],
    audio: [
      {
        id: "audio-1",
        media: [{ path: "assets/audio/theme.mp3" }],
      },
    ],
    library: [
      {
        id: "lib-1",
        media: [{ path: "assets/library/bg.png" }],
      },
    ],
    locations: [],
    props: [],
    keyframes: [],
  };

  const updated = computeReferences(metadata, mediaIndex);
  assert.deepEqual(updated.aaa.referencedBy, ["char-1"]);
  assert.deepEqual(updated.bbb.referencedBy, ["audio-1"]);
  assert.deepEqual(updated.ccc.referencedBy, ["lib-1"]);
});

test("computeReferences handles multiple references to same media", () => {
  const mediaIndex = {
    aaa: {
      id: "aaa",
      path: "assets/library/shared.png",
      sha256: "h1",
      sizeBytes: 100,
      kind: "image",
      source: "library",
      addedAt: "2026-01-01T00:00:00.000Z",
    },
  };

  const metadata = {
    characters: [
      { id: "char-1", media: [{ path: "assets/library/shared.png" }] },
      { id: "char-2", media: [{ path: "assets/library/shared.png" }] },
    ],
    locations: [
      { id: "loc-1", media: [{ path: "assets/library/shared.png" }] },
    ],
    props: [],
    keyframes: [],
    audio: [],
    library: [],
  };

  const updated = computeReferences(metadata, mediaIndex);
  assert.deepEqual(updated.aaa.referencedBy, ["char-1", "char-2", "loc-1"]);
});

test("computeReferences: record referenced by an entity has referencedBy.length > 0", () => {
  const mediaIndex = {
    aaa: {
      id: "aaa",
      path: "assets/characters/hero.png",
      sha256: "h1",
      sizeBytes: 100,
      kind: "image",
      source: "asset",
      addedAt: "2026-01-01T00:00:00.000Z",
    },
    bbb: {
      id: "bbb",
      path: "assets/characters/extra.png",
      sha256: "h2",
      sizeBytes: 50,
      kind: "image",
      source: "asset",
      addedAt: "2026-01-01T00:00:00.000Z",
    },
  };

  const metadata = {
    characters: [
      { id: "char-1", media: [{ path: "assets/characters/hero.png" }] },
    ],
    locations: [],
    props: [],
    keyframes: [],
    audio: [],
    library: [],
  };

  const updated = computeReferences(metadata, mediaIndex);
  // aaa is referenced — length must be > 0
  assert.ok(updated.aaa.referencedBy.length > 0, "referenced media should have referencedBy.length > 0");
  assert.deepEqual(updated.aaa.referencedBy, ["char-1"]);
  // bbb is not referenced — length must be 0
  assert.equal(updated.bbb.referencedBy.length, 0);
});

test("computeReferences handles empty/null metadata gracefully", () => {
  const mediaIndex = {
    aaa: { id: "aaa", path: "assets/x.png", sha256: "h", sizeBytes: 0, kind: "image", source: "asset", addedAt: "" },
  };
  const updated = computeReferences(null, mediaIndex);
  assert.deepEqual(updated.aaa.referencedBy, []);
});

// ---------------------------------------------------------------------------
// SUPPORTED_EXTENSIONS
// ---------------------------------------------------------------------------

test("SUPPORTED_EXTENSIONS contains all expected extensions", () => {
  assert.ok(SUPPORTED_EXTENSIONS.has(".png"));
  assert.ok(SUPPORTED_EXTENSIONS.has(".mp3"));
  assert.ok(SUPPORTED_EXTENSIONS.has(".mp4"));
  assert.ok(SUPPORTED_EXTENSIONS.has(".m4v"));
  assert.ok(SUPPORTED_EXTENSIONS.has(".pdf"));
  assert.ok(!SUPPORTED_EXTENSIONS.has(".txt"));
  assert.ok(!SUPPORTED_EXTENSIONS.has(".json"));
});
