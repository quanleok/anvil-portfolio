const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractEntityRefs,
  normalizeSuppressedRefs,
  serializeEntityRefsMeta,
  attachAssetUsages,
} = require("../entity-refs.cjs");

function makeProject() {
  return {
    characters: [
      { id: "char-khamzat", name: "Khamzat", title: "Khamzat", path: "characters/khamzat.md", media: [] },
      { id: "char-duelist", name: "Duelist", title: "Duelist", path: "characters/duelist.md", media: [] },
    ],
    locations: [
      { id: "loc-fortress", name: "Fortress", title: "Fortress", path: "locations/fortress.md", media: [] },
    ],
    props: [],
    keyframes: [],
    audio: [],
  };
}

test("extractEntityRefs reads explicit id-based refs from frontmatter", () => {
  const project = makeProject();
  const refs = extractEntityRefs(
    {
      entityRefs:
        '[{"entityId":"char-khamzat","section":"characters","role":"featured"},{"entityId":"loc-fortress","section":"locations","role":"background"}]',
    },
    project,
  );

  assert.deepEqual(refs, [
    { entityId: "char-khamzat", section: "characters", role: "featured" },
    { entityId: "loc-fortress", section: "locations", role: "background" },
  ]);
});

test("extractEntityRefs accepts common agent ref aliases", () => {
  const project = makeProject();
  const refs = extractEntityRefs(
    {
      entityRefs: JSON.stringify([
        { section: "character", id: "char-khamzat", role: "primary" },
        { kind: "location", assetId: "loc-fortress", role: "bg" },
        { assetType: "props", asset_id: "" },
      ]),
    },
    project,
  );

  assert.deepEqual(refs, [
    { entityId: "char-khamzat", section: "characters", role: "featured" },
    { entityId: "loc-fortress", section: "locations", role: "background" },
  ]);
});

test("normalizeSuppressedRefs accepts id and section aliases", () => {
  assert.deepEqual(
    normalizeSuppressedRefs([
      { type: "character", id: "char-khamzat" },
      { section: "locations", assetId: "loc-fortress" },
    ]),
    [
      { entityId: "char-khamzat", section: "characters" },
      { entityId: "loc-fortress", section: "locations" },
    ],
  );
});

test("extractEntityRefs migrates legacy token refs to explicit ids", () => {
  const project = makeProject();
  const refs = extractEntityRefs(
    {
      characters: "[Khamzat, Duelist]",
      locations: "fortress",
    },
    project,
  );

  assert.deepEqual(refs, [
    { entityId: "char-khamzat", section: "characters", role: "featured" },
    { entityId: "char-duelist", section: "characters", role: "featured" },
    { entityId: "loc-fortress", section: "locations", role: "featured" },
  ]);
});

test("extractEntityRefs merges explicit refs with legacy refs during dual-read migration", () => {
  const project = makeProject();
  const refs = extractEntityRefs(
    {
      entityRefs:
        '[{"entityId":"char-khamzat","section":"characters","role":"background"}]',
      characters: "[Khamzat, Duelist]",
      locations: "fortress",
    },
    project,
  );

  assert.deepEqual(refs, [
    { entityId: "char-khamzat", section: "characters", role: "background" },
    { entityId: "char-duelist", section: "characters", role: "featured" },
    { entityId: "loc-fortress", section: "locations", role: "featured" },
  ]);
});

test("serializeEntityRefsMeta dual-writes explicit refs and section id arrays", () => {
  const meta = serializeEntityRefsMeta([
    { entityId: "char-khamzat", section: "characters", role: "featured" },
    { entityId: "loc-fortress", section: "locations", role: "background" },
  ]);

  assert.equal(
    meta.entityRefs,
    '[{"entityId":"char-khamzat","section":"characters","role":"featured"},{"entityId":"loc-fortress","section":"locations","role":"background"}]',
  );
  assert.equal(meta.characters, '["char-khamzat"]');
  assert.equal(meta.locations, '["loc-fortress"]');
});

test("attachAssetUsages annotates referenced assets with reverse usage data", () => {
  const project = makeProject();
  const enriched = attachAssetUsages(project, [
    {
      id: "scene-1",
      title: "Fortress Approach",
      path: "scenes/scene-01-fortress-approach.md",
      entrySection: "script",
      entityRefs: [
        { entityId: "char-khamzat", section: "characters", role: "featured" },
        { entityId: "loc-fortress", section: "locations", role: "background" },
      ],
    },
    {
      id: "dialogue-1",
      title: "Door Creak Reveal Dialogue",
      path: "dialogue/scene-01-forgotten-workshop/shot-01-door-creak-reveal-dialogue.md",
      entrySection: "dialogue",
      sceneId: "scene-1",
      shotId: "shot-1",
      entityRefs: [{ entityId: "char-khamzat", section: "characters", role: "background" }],
    },
    {
      id: "prompt-1",
      title: "Wide Approach A",
      path: "prompts/scene-01/prompt-01-wide-approach-a.md",
      entrySection: "prompts",
      sceneId: "scene-1",
      shotId: "shot-1",
      entityRefs: [{ entityId: "char-khamzat", section: "characters", role: "mentioned" }],
    },
  ]);

  assert.equal(enriched.characters[0].usedIn.length, 3);
  assert.equal(enriched.characters[0].usedIn[0].entrySection, "script");
  assert.equal(enriched.characters[0].usedIn[1].entrySection, "dialogue");
  assert.equal(enriched.characters[0].usedIn[2].entrySection, "prompts");
  assert.equal(enriched.locations[0].usedIn.length, 1);
  assert.equal(enriched.locations[0].usedIn[0].entryTitle, "Fortress Approach");
});
