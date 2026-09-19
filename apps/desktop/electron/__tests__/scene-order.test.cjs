const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractMasterSceneOrderHints,
  sortPromptEntriesByStoryOrder,
  sortSceneEntriesByScriptOrder,
} = require("../scene-order.cjs");

test("extractMasterSceneOrderHints prefers explicit scene file order", () => {
  const hints = extractMasterSceneOrderHints(`
# Master Script

## Scene file order
1. \`scenes/forgotten-workshop.md\`
2. \`scenes/anvil-discovery.md\`
3. \`scenes/kingdom-mirror.md\`
`);

  assert.deepEqual(hints.paths, [
    "scenes/forgotten-workshop.md",
    "scenes/anvil-discovery.md",
    "scenes/kingdom-mirror.md",
  ]);
});

test("sortSceneEntriesByScriptOrder uses master-script scene path order before filenames", () => {
  const scenes = [
    { path: "scenes/anvil-discovery.md", title: "Anvil Discovery" },
    { path: "scenes/forgotten-workshop.md", title: "Forgotten Workshop" },
    { path: "scenes/kingdom-mirror.md", title: "Kingdom Mirror" },
  ];

  const sorted = sortSceneEntriesByScriptOrder(scenes, [
    {
      path: "script/master-script.md",
      content: [
        "# Master Script",
        "",
        "## Scene file order",
        "1. scenes/forgotten-workshop.md",
        "2. scenes/anvil-discovery.md",
        "3. scenes/kingdom-mirror.md",
      ].join("\n"),
    },
  ]);

  assert.deepEqual(sorted.map((scene) => scene.path), [
    "scenes/forgotten-workshop.md",
    "scenes/anvil-discovery.md",
    "scenes/kingdom-mirror.md",
  ]);
});

test("sortSceneEntriesByScriptOrder falls back to numbered master-script titles", () => {
  const scenes = [
    { path: "scenes/anvil-discovery.md", title: "Anvil Discovery" },
    { path: "scenes/crack-in-the-sky.md", title: "Crack In The Sky" },
    { path: "scenes/forgotten-workshop.md", title: "Forgotten Workshop" },
  ];

  const sorted = sortSceneEntriesByScriptOrder(scenes, [
    {
      path: "script/master-script.md",
      content: [
        "# Master Script",
        "",
        "## Runtime Allocation",
        "1. Forgotten Workshop - 1:00",
        "2. Anvil Discovery - 1:15",
        "3. Crack In The Sky - 1:30",
      ].join("\n"),
    },
  ]);

  assert.deepEqual(sorted.map((scene) => scene.title), [
    "Forgotten Workshop",
    "Anvil Discovery",
    "Crack In The Sky",
  ]);
});

test("sortSceneEntriesByScriptOrder follows plain screenplay scene headings", () => {
  const scenes = [
    { path: "scenes/anvil-discovery.md", title: "Anvil Discovery" },
    { path: "scenes/first-bird.md", title: "First Bird" },
    { path: "scenes/forgotten-workshop.md", title: "Forgotten Workshop" },
  ];

  const sorted = sortSceneEntriesByScriptOrder(scenes, [
    {
      path: "script/master-script.md",
      content: [
        "# Master Script",
        "",
        "SCENE 01 — Forgotten Workshop",
        "The kid discovers the room.",
        "",
        "Scene 02: First Bird",
        "The first creation flies.",
        "",
        "INT. ANVIL DISCOVERY - NIGHT",
        "The hammer answers.",
      ].join("\n"),
    },
  ]);

  assert.deepEqual(sorted.map((scene) => scene.title), [
    "Forgotten Workshop",
    "First Bird",
    "Anvil Discovery",
  ]);
});

test("sortSceneEntriesByScriptOrder uses first master-script title occurrence before filename order", () => {
  const scenes = [
    { path: "scenes/anvil-discovery.md", title: "Anvil Discovery" },
    { path: "scenes/first-bird.md", title: "First Bird" },
    { path: "scenes/forgotten-workshop.md", title: "Forgotten Workshop" },
  ];

  const sorted = sortSceneEntriesByScriptOrder(scenes, [
    {
      path: "script/master-script.md",
      content: [
        "# Master Script",
        "",
        "The film starts in Forgotten Workshop, moves into First Bird, then resolves at Anvil Discovery.",
      ].join("\n"),
    },
  ]);

  assert.deepEqual(sorted.map((scene) => scene.title), [
    "Forgotten Workshop",
    "First Bird",
    "Anvil Discovery",
  ]);
});

test("sortSceneEntriesByScriptOrder lets explicit sceneOrder override master-script order", () => {
  const scenes = [
    { path: "scenes/anvil-discovery.md", sceneOrder: 2, title: "Anvil Discovery" },
    { path: "scenes/forgotten-workshop.md", sceneOrder: 1, title: "Forgotten Workshop" },
    { path: "scenes/kingdom-mirror.md", sceneOrder: 3, title: "Kingdom Mirror" },
  ];

  const sorted = sortSceneEntriesByScriptOrder(scenes, [
    {
      path: "script/master-script.md",
      content: [
        "# Master Script",
        "",
        "## Scene file order",
        "1. scenes/anvil-discovery.md",
        "2. scenes/forgotten-workshop.md",
        "3. scenes/kingdom-mirror.md",
      ].join("\n"),
    },
  ]);

  assert.deepEqual(sorted.map((scene) => scene.title), [
    "Forgotten Workshop",
    "Anvil Discovery",
    "Kingdom Mirror",
  ]);
});

test("sortPromptEntriesByStoryOrder follows continuity chain before filename order", () => {
  const prompts = [
    { id: "c", path: "prompts/s1/prompt-01-third.md", prevPromptId: "b", sceneId: "s1", title: "Third" },
    { id: "a", path: "prompts/s1/prompt-03-first.md", prevPromptId: null, sceneId: "s1", title: "First" },
    { id: "b", path: "prompts/s1/prompt-02-second.md", prevPromptId: "a", sceneId: "s1", title: "Second" },
  ];

  const sorted = sortPromptEntriesByStoryOrder(prompts, {
    scenes: [{ id: "s1", path: "scenes/scene-01.md" }],
  });

  assert.deepEqual(sorted.map((prompt) => prompt.id), ["a", "b", "c"]);
});

test("sortPromptEntriesByStoryOrder uses scene text prompt order before filename order", () => {
  const prompts = [
    { id: "c", path: "prompts/s1/alpha-later.md", sceneId: "s1", title: "Gold Line" },
    { id: "a", path: "prompts/s1/zeta-first.md", sceneId: "s1", title: "Prompt 01 - Door Creak Reveal" },
    { id: "b", path: "prompts/s1/middle.md", sceneId: "s1", title: "Tactile Interior" },
  ];

  const sorted = sortPromptEntriesByStoryOrder(prompts, {
    scenes: [{
      id: "s1",
      path: "scenes/scene-01-forgotten-workshop.md",
      content: [
        "# Forgotten Workshop",
        "",
        "Prompt plan:",
        "Door Creak Reveal",
        "Tactile Interior",
        "Gold Line",
      ].join("\n"),
    }],
  });

  assert.deepEqual(sorted.map((prompt) => prompt.id), ["a", "b", "c"]);
});

test("sortPromptEntriesByStoryOrder keeps original order as final fallback", () => {
  const prompts = [
    { id: "b", path: "prompts/s1/beta.md", sceneId: "s1", title: "Beta" },
    { id: "a", path: "prompts/s1/alpha.md", sceneId: "s1", title: "Alpha" },
  ];

  const sorted = sortPromptEntriesByStoryOrder(prompts, {
    scenes: [{ id: "s1", path: "scenes/scene-01.md" }],
  });

  assert.deepEqual(sorted.map((prompt) => prompt.id), ["b", "a"]);
});
