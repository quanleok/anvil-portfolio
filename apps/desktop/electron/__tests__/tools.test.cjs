const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs/promises");
const path = require("node:path");

const { runTool } = require("../tools.cjs");
const skillLibrary = require("../skill-library.cjs");
require("../tools.cjs"); // ensures builtin tools register (see Task 1.3)

async function makeTempProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "forge-tools-"));
  return dir;
}

async function installFakeFfprobe(projectDir, durationSec = 9.87) {
  const scriptPath = path.join(projectDir, "fake-ffprobe.sh");
  await fs.writeFile(scriptPath, `#!/bin/sh\nprintf '${durationSec}\\n'\n`, "utf8");
  await fs.chmod(scriptPath, 0o755);
  process.env.FFPROBE_BIN = scriptPath;
  return durationSec;
}

async function writeDummyAudio(projectDir, relativePath = "assets/audio/music.mp3") {
  const absolutePath = path.join(projectDir, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, "dummy audio bytes");
}

async function seedProjectMetadata(projectDir, overrides = {}) {
  await fs.mkdir(path.join(projectDir, ".forge"), { recursive: true });
  const base = {
    version: 2,
    project: {
      id: "proj-test",
      name: "Test Project",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
    settings: {
      sessionKey: "hook:shotforge:test",
    },
    folders: [],
    characters: [],
    locations: [],
    props: [],
    keyframes: [],
    audio: [],
  };
  const payload = { ...base, ...overrides };
  await fs.writeFile(path.join(projectDir, ".forge", "project.json"), JSON.stringify(payload, null, 2), "utf8");
}

test("read_asset_bundle reports missing media files without file URLs", async () => {
  const projectDir = await makeTempProject();
  await seedProjectMetadata(projectDir, {
    characters: [
      {
        id: "c1",
        title: "Ash",
        name: "Ash",
        content: "hero",
        path: "characters/ash.md",
        folder: null,
        media: [
          { id: "m1", label: "present.png", kind: "image", path: "assets/characters/present.png" },
          { id: "m2", label: "missing.png", kind: "image", path: "assets/characters/missing.png" },
        ],
      },
    ],
  });
  await fs.mkdir(path.join(projectDir, "assets", "characters"), { recursive: true });
  await fs.writeFile(path.join(projectDir, "assets", "characters", "present.png"), "bytes");

  const result = await runTool(
    "read_asset_bundle",
    { section: "characters", assetId: "c1" },
    { projectDir },
  );

  const present = result.asset.media.find((item) => item.id === "m1");
  const missing = result.asset.media.find((item) => item.id === "m2");
  assert.equal(present.exists, true);
  assert.ok(present.fileUrl.endsWith("/assets/characters/present.png"));
  assert.equal(missing.exists, false);
  assert.equal(missing.fileUrl, "");
});

test("read_asset_bundle returns encoded file URLs for media paths with spaces", async () => {
  const projectDir = await makeTempProject();
  await seedProjectMetadata(projectDir, {
    characters: [
      {
        id: "c1",
        title: "Ash",
        name: "Ash",
        content: "",
        path: "characters/ash.md",
        folder: null,
        media: [
          { id: "m1", label: "present pic.png", kind: "image", path: "assets/characters/present pic.png" },
        ],
      },
    ],
  });
  await fs.mkdir(path.join(projectDir, "assets", "characters"), { recursive: true });
  await fs.writeFile(path.join(projectDir, "assets", "characters", "present pic.png"), "bytes");

  const result = await runTool(
    "read_asset_bundle",
    { section: "characters", assetId: "c1" },
    { projectDir },
  );

  assert.equal(result.asset.media[0].exists, true);
  assert.ok(result.asset.media[0].fileUrl.includes("present%20pic.png"));
});

test("read_file returns the content of an existing project file", async () => {
  const projectDir = await makeTempProject();
  await fs.writeFile(path.join(projectDir, "hello.md"), "# Hello\n");
  const result = await runTool("read_file", { path: "hello.md" }, { projectDir });
  assert.equal(result.content, "# Hello\n");
  assert.equal(result.path, "hello.md");
});

test("read_file rejects absolute paths", async () => {
  const projectDir = await makeTempProject();
  await assert.rejects(
    () => runTool("read_file", { path: "/etc/passwd" }, { projectDir }),
    /Absolute paths are not allowed/,
  );
});

test("read_file rejects paths that escape the project", async () => {
  const projectDir = await makeTempProject();
  await assert.rejects(
    () => runTool("read_file", { path: "../outside.txt" }, { projectDir }),
    /escapes the current project/,
  );
});

test("list_dir returns files and directories with kinds", async () => {
  const projectDir = await makeTempProject();
  await fs.mkdir(path.join(projectDir, "scenes"));
  await fs.writeFile(path.join(projectDir, "scenes", "a.md"), "");
  await fs.writeFile(path.join(projectDir, "scenes", "b.md"), "");
  const result = await runTool("list_dir", { path: "scenes" }, { projectDir });
  assert.equal(result.entries.length, 2);
  assert.deepEqual(
    result.entries.map((entry) => entry.name).sort(),
    ["a.md", "b.md"],
  );
  assert.ok(result.entries.every((entry) => entry.kind === "file"));
});

test("search finds literal text across project files", async () => {
  const projectDir = await makeTempProject();
  await fs.mkdir(path.join(projectDir, "scenes"));
  await fs.writeFile(path.join(projectDir, "scenes", "a.md"), "The fortress gate groans open.");
  await fs.writeFile(path.join(projectDir, "scenes", "b.md"), "Ash covers the plain.");
  const result = await runTool(
    "search",
    { query: "fortress", glob: "scenes/*.md" },
    { projectDir },
  );
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].path, "scenes/a.md");
  assert.ok(result.matches[0].line.includes("fortress"));
});

test("write_file creates a file, overwrites existing, and returns bytes", async () => {
  const projectDir = await makeTempProject();
  const first = await runTool(
    "write_file",
    { path: "story/logline.md", content: "One line." },
    { projectDir },
  );
  assert.equal(first.path, "story/logline.md");
  const saved = await fs.readFile(path.join(projectDir, "story/logline.md"), "utf8");
  assert.equal(saved, "One line.");

  const second = await runTool(
    "write_file",
    { path: "story/logline.md", content: "Updated." },
    { projectDir },
  );
  assert.equal(second.bytesWritten, "Updated.".length);
});

test("write_file allows Agent Note but rejects other .forge app-state paths", async () => {
  const projectDir = await makeTempProject();

  const note = await runTool(
    "write_file",
    { path: ".forge/agent-note.md", content: "# Agent Note\n\nhandoff" },
    { projectDir },
  );
  assert.equal(note.path, ".forge/agent-note.md");
  assert.equal(
    await fs.readFile(path.join(projectDir, ".forge", "agent-note.md"), "utf8"),
    "# Agent Note\n\nhandoff",
  );

  await assert.rejects(
    () =>
      runTool(
        "write_file",
        { path: ".forge/asset-context/guide.md", content: "hidden asset notes" },
        { projectDir },
      ),
    /Reserved app state/,
  );
  await assert.rejects(
    () =>
      runTool(
        "write_file",
        { path: ".forge/project.json", content: "{}" },
        { projectDir },
      ),
    /Reserved app state/,
  );
});

test("edit_file replaces the first occurrence and returns preview", async () => {
  const projectDir = await makeTempProject();
  await fs.writeFile(path.join(projectDir, "scene.md"), "Ash and iron.\nAsh everywhere.\n");
  const result = await runTool(
    "edit_file",
    { path: "scene.md", find: "Ash", replace: "Smoke" },
    { projectDir },
  );
  assert.equal(result.replacements, 1);
  const saved = await fs.readFile(path.join(projectDir, "scene.md"), "utf8");
  assert.equal(saved, "Smoke and iron.\nAsh everywhere.\n");
});

test("edit_file with replaceAll replaces every occurrence", async () => {
  const projectDir = await makeTempProject();
  await fs.writeFile(path.join(projectDir, "scene.md"), "Ash and Ash.\n");
  const result = await runTool(
    "edit_file",
    { path: "scene.md", find: "Ash", replace: "Smoke", replaceAll: true },
    { projectDir },
  );
  assert.equal(result.replacements, 2);
  const saved = await fs.readFile(path.join(projectDir, "scene.md"), "utf8");
  assert.equal(saved, "Smoke and Smoke.\n");
});

test("edit_file rejects reserved .forge app-state paths", async () => {
  const projectDir = await makeTempProject();
  await fs.mkdir(path.join(projectDir, ".forge"), { recursive: true });
  await fs.writeFile(path.join(projectDir, ".forge", "project.json"), "{\"project\":{}}\n");

  await assert.rejects(
    () =>
      runTool(
        "edit_file",
        { path: ".forge/project.json", find: "project", replace: "story" },
        { projectDir },
      ),
    /Reserved app state/,
  );
});

test("edit_file throws when find string is not present", async () => {
  const projectDir = await makeTempProject();
  await fs.writeFile(path.join(projectDir, "scene.md"), "Nothing.");
  await assert.rejects(
    () =>
      runTool(
        "edit_file",
        { path: "scene.md", find: "missing", replace: "x" },
        { projectDir },
      ),
    /not found/,
  );
});

async function fakeProjectWithScenes() {
  const dir = await makeTempProject();
  await fs.mkdir(path.join(dir, "scenes"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "scenes", "scene-01-gate.md"),
    "---\nid: s1\ntitle: Scene 1\n---\nGate scene.\n",
  );
  await fs.writeFile(
    path.join(dir, "scenes", "scene-02-battle.md"),
    "---\nid: s2\ntitle: Scene 2\n---\nBattle scene.\n",
  );
  await fs.mkdir(path.join(dir, "shots"), { recursive: true });
  await fs.mkdir(path.join(dir, "shots", "scene-01-gate"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "shots", "scene-01-gate", "shot-01-wide.md"),
    "---\nid: sh1\ntitle: Wide\nsceneId: s1\n---\nShot.\n",
  );
  return dir;
}

test("list_scenes returns each scene with id, path, title", async () => {
  const projectDir = await fakeProjectWithScenes();
  const result = await runTool("list_scenes", {}, { projectDir });
  assert.equal(result.scenes.length, 2);
  assert.equal(result.scenes[0].id, "s1");
  assert.equal(result.scenes[0].title, "Scene 1");
});

test("list_scenes follows master-script scene order instead of filename order", async () => {
  const projectDir = await makeTempProject();
  await fs.mkdir(path.join(projectDir, "script"), { recursive: true });
  await fs.mkdir(path.join(projectDir, "scenes"), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, "script", "master-script.md"),
    [
      "# Master Script",
      "",
      "## Scene file order",
      "1. scenes/forgotten-workshop.md",
      "2. scenes/anvil-discovery.md",
      "3. scenes/kingdom-mirror.md",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(projectDir, "scenes", "anvil-discovery.md"),
    "---\nid: s2\ntitle: Anvil Discovery\n---\nDiscovery.\n",
  );
  await fs.writeFile(
    path.join(projectDir, "scenes", "forgotten-workshop.md"),
    "---\nid: s1\ntitle: Forgotten Workshop\n---\nWorkshop.\n",
  );
  await fs.writeFile(
    path.join(projectDir, "scenes", "kingdom-mirror.md"),
    "---\nid: s3\ntitle: Kingdom Mirror\n---\nMirror.\n",
  );

  const result = await runTool("list_scenes", {}, { projectDir });

  assert.deepEqual(result.scenes.map((scene) => scene.path), [
    "scenes/forgotten-workshop.md",
    "scenes/anvil-discovery.md",
    "scenes/kingdom-mirror.md",
  ]);
});

test("inspect_images returns metadata for project image files", async () => {
  const projectDir = await makeTempProject();
  await seedProjectMetadata(projectDir);
  await fs.mkdir(path.join(projectDir, "assets", "characters"), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, "assets", "characters", "duelist.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5p8AAAAASUVORK5CYII=",
      "base64",
    ),
  );

  const result = await runTool(
    "inspect_images",
    { section: "characters", limit: 5 },
    { projectDir },
  );

  assert.equal(result.count, 1);
  assert.equal(result.images[0].path, "assets/characters/duelist.png");
  assert.equal(result.images[0].width, 1);
  assert.equal(result.images[0].height, 1);
  assert.equal(result.images[0].readable, true);
});

test("sync_assets_from_disk imports manually dropped asset files into metadata", async () => {
  const projectDir = await makeTempProject();
  await seedProjectMetadata(projectDir);
  await fs.mkdir(path.join(projectDir, "assets", "locations"), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, "assets", "locations", "waste-land.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5p8AAAAASUVORK5CYII=",
      "base64",
    ),
  );
  await fs.mkdir(path.join(projectDir, "story"), { recursive: true });
  await fs.mkdir(path.join(projectDir, "script"), { recursive: true });
  await fs.writeFile(path.join(projectDir, "story", "logline.md"), "# Logline\n");
  await fs.writeFile(path.join(projectDir, "script", "master-script.md"), "# Master Script\n");

  const result = await runTool("sync_assets_from_disk", { section: "locations" }, { projectDir });

  assert.equal(result.count, 1);
  const metadata = JSON.parse(await fs.readFile(path.join(projectDir, ".forge", "project.json"), "utf8"));
  assert.equal(metadata.locations.length, 1);
  assert.equal(metadata.locations[0].media[0].path, "assets/locations/waste-land.png");
});

test("read_scene_bundle returns scene with linked prompts", async () => {
  const projectDir = await fakeProjectWithScenes();
  await seedProjectMetadata(projectDir);
  await fs.mkdir(path.join(projectDir, "prompts", "scene-01-gate"), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, "prompts", "scene-01-gate", "prompt-01-wide.md"),
    "---\nid: p1\ntitle: Wide Prompt\nsceneId: s1\n---\nPrompt text.\n",
  );
  await runTool("refresh_project_index", {}, { projectDir });

  const result = await runTool("read_scene_bundle", { sceneId: "s1" }, { projectDir });

  assert.equal(result.scene.id, "s1");
  assert.equal(result.prompts.length, 1);
});

test("read scene and prompt bundles recover prompts linked by folder when sceneId is missing", async () => {
  const projectDir = await fakeProjectWithScenes();
  await seedProjectMetadata(projectDir);
  await fs.mkdir(path.join(projectDir, "prompts", "scene-01-gate"), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, "prompts", "scene-01-gate", "prompt-01-wide.md"),
    "---\nid: p-folder\ntitle: Folder Linked Prompt\n---\nPrompt text.\n",
  );
  await fs.writeFile(
    path.join(projectDir, ".forge", "index.json"),
    JSON.stringify(
      {
        scenes: [{ id: "s1", path: "scenes/scene-01-gate.md", title: "Scene 1" }],
        prompts: [
          {
            id: "p-folder",
            path: "prompts/scene-01-gate/prompt-01-wide.md",
            title: "Folder Linked Prompt",
            sceneId: null,
            scenePath: null,
          },
        ],
        dialogue: [],
      },
      null,
      2,
    ),
  );

  const sceneBundle = await runTool("read_scene_bundle", { sceneId: "s1" }, { projectDir });
  const promptBundle = await runTool("read_prompt_bundle", { promptId: "p-folder" }, { projectDir });

  assert.deepEqual(sceneBundle.prompts.map((prompt) => prompt.id), ["p-folder"]);
  assert.equal(promptBundle.scene.id, "s1");
});

test("read_prompt_bundle traces up to scene", async () => {
  const projectDir = await fakeProjectWithScenes();
  await seedProjectMetadata(projectDir);
  await fs.mkdir(path.join(projectDir, "prompts", "scene-01-gate"), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, "prompts", "scene-01-gate", "prompt-01-wide.md"),
    "---\nid: p1\ntitle: Wide Prompt\nsceneId: s1\nscenePath: scenes/scene-01-gate.md\nshotId: sh1\nshotPath: shots/scene-01-gate/shot-01-wide.md\n---\nPrompt.\n",
  );
  await runTool("refresh_project_index", {}, { projectDir });

  const result = await runTool("read_prompt_bundle", { promptId: "p1" }, { projectDir });

  assert.equal(result.prompt.id, "p1");
  assert.equal(result.scene.id, "s1");
});

test("read_prompt_bundle works for a scene-only prompt", async () => {
  const projectDir = await fakeProjectWithScenes();
  await seedProjectMetadata(projectDir);
  await fs.mkdir(path.join(projectDir, "prompts", "scene-02-battle"), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, "prompts", "scene-02-battle", "prompt-01-wide.md"),
    "---\nid: p2\ntitle: Scene Prompt\nsceneId: s2\nscenePath: scenes/scene-02-battle.md\n---\nPrompt.\n",
  );
  await runTool("refresh_project_index", {}, { projectDir });

  const result = await runTool("read_prompt_bundle", { promptId: "p2" }, { projectDir });

  assert.equal(result.prompt.id, "p2");
  assert.equal(result.scene.id, "s2");
});

test("read_story_bundle returns story + master script docs", async () => {
  const projectDir = await makeTempProject();
  await seedProjectMetadata(projectDir);
  await fs.mkdir(path.join(projectDir, "story"), { recursive: true });
  await fs.writeFile(path.join(projectDir, "story", "world-bible.md"), "---\nid: w1\ntitle: World Bible\n---\nCanon.\n");
  await fs.writeFile(path.join(projectDir, "story", "major-beats.md"), "---\nid: b1\ntitle: Major Beats\n---\nLegacy beat split.\n");
  await fs.writeFile(path.join(projectDir, "story", "project-rules.md"), "---\nid: pctx1\ntitle: Project Rules\ncontextGroup: project\n---\nOperational rules.\n");
  await fs.mkdir(path.join(projectDir, "script"), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, "script", "master-script.md"),
    "---\nid: m1\ntitle: Master Script\n---\nAct I.\n",
  );

  const result = await runTool("read_story_bundle", {}, { projectDir });

  assert.equal(result.story.length, 2);
  assert.equal(result.script.length, 1);
  assert.ok(result.story.find((d) => d.id === "w1"));
  assert.equal(result.story.find((d) => d.id === "b1"), undefined);
  assert.equal(result.story.find((d) => d.id === "pctx1")?.meta?.contextGroup, "project");
  assert.ok(result.script.find((d) => d.id === "m1"));
});

test("custom Canon sections appear in index and story bundle", async () => {
  const projectDir = await makeTempProject();
  await seedProjectMetadata(projectDir, {
    customSubsections: [
      {
        id: "custom:characters",
        primary: "script",
        name: "Characters",
        kind: "docs",
        folder: "custom/characters",
        instructionsPath: "custom/characters/INSTRUCTIONS.md",
        fileExtensions: [".md"],
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
    ],
  });
  await fs.mkdir(path.join(projectDir, "story"), { recursive: true });
  await fs.writeFile(path.join(projectDir, "story", "world-bible.md"), "---\nid: w1\ntitle: World Bible\n---\nCanon.\n");
  await fs.mkdir(path.join(projectDir, "script"), { recursive: true });
  await fs.writeFile(path.join(projectDir, "script", "master-script.md"), "---\nid: m1\ntitle: Master Script\n---\nAct I.\n");
  await fs.mkdir(path.join(projectDir, "custom", "characters"), { recursive: true });
  await fs.writeFile(path.join(projectDir, "custom", "characters", "INSTRUCTIONS.md"), "# Characters\n\n## What it is\n\nCast reference.\n");
  await fs.writeFile(path.join(projectDir, "custom", "characters", "hero.md"), "---\nid: hero\ntitle: Hero\n---\nHero notes.\n");

  const refreshed = await runTool("refresh_project_index", {}, { projectDir });
  const bundle = await runTool("read_story_bundle", {}, { projectDir });

  assert.equal(refreshed.summary.customSections.length, 1);
  assert.equal(refreshed.summary.customSections[0].folder, "custom/characters");
  assert.equal(bundle.canonSections.length, 1);
  assert.equal(bundle.canonSections[0].name, "Characters");
  assert.equal(bundle.canonSections[0].guide, undefined);
  assert.equal(bundle.canonSections[0].docs[0].id, "hero");
});

test("rename_paths renames asset media files and updates metadata", async () => {
  const projectDir = await makeTempProject();
  await seedProjectMetadata(projectDir, {
    characters: [
      {
        id: "c1",
        title: "Duelist",
        name: "Duelist",
        content: "",
        path: "characters/duelist.md",
        folder: null,
        media: [
          {
            id: "m1",
            label: "character-1.png",
            kind: "image",
            path: "assets/characters/character-1.png",
          },
        ],
      },
    ],
  });
  await fs.mkdir(path.join(projectDir, "assets", "characters"), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, "assets", "characters", "character-1.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5p8AAAAASUVORK5CYII=",
      "base64",
    ),
  );
  await fs.mkdir(path.join(projectDir, "story"), { recursive: true });
  await fs.mkdir(path.join(projectDir, "script"), { recursive: true });
  await fs.writeFile(path.join(projectDir, "story", "logline.md"), "# Logline\n");
  await fs.writeFile(path.join(projectDir, "script", "master-script.md"), "# Master Script\n");

  const result = await runTool(
    "rename_paths",
    {
      items: [
        {
          from: "assets/characters/character-1.png",
          to: "assets/characters/duelist.png",
        },
      ],
    },
    { projectDir },
  );

  assert.equal(result.count, 1);
  const metadata = JSON.parse(await fs.readFile(path.join(projectDir, ".forge", "project.json"), "utf8"));
  assert.equal(metadata.characters[0].media[0].path, "assets/characters/duelist.png");
  await fs.access(path.join(projectDir, "assets", "characters", "duelist.png"));
});

test("rename_paths rejects reserved .forge app-state paths", async () => {
  const projectDir = await makeTempProject();
  await seedProjectMetadata(projectDir);
  await fs.mkdir(path.join(projectDir, ".forge", "frames", "take-1"), { recursive: true });
  await fs.writeFile(path.join(projectDir, ".forge", "frames", "take-1", "last.png"), "frame");
  await fs.mkdir(path.join(projectDir, "assets", "library"), { recursive: true });
  await fs.writeFile(path.join(projectDir, "assets", "library", "foo.png"), "asset");

  await assert.rejects(
    () =>
      runTool(
        "rename_paths",
        { items: [{ from: ".forge/frames/take-1/last.png", to: "assets/library/last.png" }] },
        { projectDir },
      ),
    /Reserved app state/,
  );
  await assert.rejects(
    () =>
      runTool(
        "rename_paths",
        { items: [{ from: "assets/library/foo.png", to: ".forge/frames/foo.png" }] },
        { projectDir },
      ),
    /Reserved app state/,
  );
});

test("rename_paths prevalidates the batch before moving any file", async () => {
  const projectDir = await makeTempProject();
  await seedProjectMetadata(projectDir);
  await fs.mkdir(path.join(projectDir, "assets", "library"), { recursive: true });
  await fs.writeFile(path.join(projectDir, "assets", "library", "safe.png"), "asset");
  await fs.mkdir(path.join(projectDir, ".forge", "frames", "take-1"), { recursive: true });
  await fs.writeFile(path.join(projectDir, ".forge", "frames", "take-1", "last.png"), "frame");

  await assert.rejects(
    () =>
      runTool(
        "rename_paths",
        {
          items: [
            { from: "assets/library/safe.png", to: "assets/library/moved.png" },
            { from: ".forge/frames/take-1/last.png", to: "assets/library/last.png" },
          ],
        },
        { projectDir },
      ),
    /Reserved app state/,
  );

  await fs.access(path.join(projectDir, "assets", "library", "safe.png"));
  await assert.rejects(
    () => fs.access(path.join(projectDir, "assets", "library", "moved.png")),
    /ENOENT/,
  );
});

test("run_command runs an allowlisted binary and returns exit code + stdout", async () => {
  const projectDir = await makeTempProject();
  const result = await runTool(
    "run_command",
    { command: "echo", args: ["forge-ok"] },
    { projectDir },
  );
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.includes("forge-ok"));
});

test("run_command blocks destructive git invocations at the argv classifier", async () => {
  const projectDir = await makeTempProject();
  for (const argv of [
    ["reset", "--hard"],
    ["push", "--force"],
    ["push", "-f"],
    ["branch", "-D", "main"],
    ["clean", "-fd"],
    ["clean", "-xdf"],
    ["checkout", "--", "file"],
  ]) {
    await assert.rejects(
      () => runTool("run_command", { command: "git", args: argv }, { projectDir }),
      /destructive git/,
      `git ${argv.join(" ")} should be blocked`,
    );
  }
});

test("run_command blocks npm publish / yarn publish / pnpm publish", async () => {
  const projectDir = await makeTempProject();
  for (const command of ["npm", "pnpm", "yarn"]) {
    await assert.rejects(
      () => runTool("run_command", { command, args: ["publish"] }, { projectDir }),
      /publishing is blocked/,
      `${command} publish should be blocked`,
    );
  }
});

test("run_command attaches a risk envelope on successful invocations", async () => {
  const projectDir = await makeTempProject();
  const result = await runTool(
    "run_command",
    { command: "echo", args: ["hi"] },
    { projectDir },
  );
  assert.ok(result.risk);
  assert.ok(["safe", "warn"].includes(result.risk.level));
});

test("classifyCommandRisk marks read-only binaries as safe and unknown as warn", () => {
  const { classifyCommandRisk } = require("../system/tools/shell.cjs");
  assert.equal(classifyCommandRisk("rg", ["pattern"]).level, "safe");
  assert.equal(classifyCommandRisk("tsc", ["--noEmit"]).level, "safe");
  assert.equal(classifyCommandRisk("ffprobe", ["x.wav"]).level, "safe");
  assert.equal(classifyCommandRisk("git", ["status"]).level, "safe");
  assert.equal(classifyCommandRisk("git", ["commit", "-m", "x"]).level, "warn");
  assert.equal(classifyCommandRisk("npm", ["install"]).level, "warn");
  assert.equal(classifyCommandRisk("some-weird-bin", []).level, "warn");
});

test("run_command rejects non-allowlisted commands", async () => {
  const projectDir = await makeTempProject();
  await assert.rejects(
    () => runTool("run_command", { command: "rm" }, { projectDir }),
    /not in the allowlist/,
  );
});

test("delete_asset_entry removes a library entry and moves its unshared file to temporary trash", async () => {
  const projectDir = await makeTempProject();
  await seedProjectMetadata(projectDir, {
    library: [
      {
        id: "lib1",
        title: "Waste Land",
        name: "Waste Land",
        content: "",
        path: "library/waste-land.md",
        folder: null,
        media: [{ id: "m1", label: "waste-land.png", kind: "image", path: "assets/library/waste-land.png" }],
      },
    ],
  });
  await fs.mkdir(path.join(projectDir, "assets", "library"), { recursive: true });
  await fs.writeFile(path.join(projectDir, "assets", "library", "waste-land.png"), "bytes");

  const result = await runTool("delete_asset_entry", { section: "library", assetId: "lib1" }, { projectDir });

  assert.equal(result.deleted, true);
  assert.deepEqual(result.deletedFiles, ["assets/library/waste-land.png"]);
  assert.deepEqual(result.trashedFiles, [
    { from: "assets/library/waste-land.png", to: "assets/inbox/waste-land.png" },
  ]);
  const metadata = JSON.parse(await fs.readFile(path.join(projectDir, ".forge", "project.json"), "utf8"));
  assert.equal(metadata.library.length, 0);
  await assert.rejects(() => fs.stat(path.join(projectDir, "assets", "library", "waste-land.png")), /ENOENT/);
  const trashStats = await fs.stat(path.join(projectDir, "assets", "inbox", "waste-land.png"));
  assert.equal(trashStats.isFile(), true);
});

test("delete_asset_entry removes an asset entry but preserves shared library files", async () => {
  const projectDir = await makeTempProject();
  await seedProjectMetadata(projectDir, {
    library: [
      {
        id: "lib1",
        title: "Waste Land",
        name: "Waste Land",
        content: "",
        path: "library/waste-land.md",
        folder: null,
        media: [{ id: "m1", label: "waste-land.png", kind: "image", path: "assets/library/waste-land.png" }],
      },
    ],
    locations: [
      {
        id: "loc1",
        title: "Waste Land",
        name: "Waste Land",
        content: "",
        path: "locations/waste-land.md",
        folder: null,
        media: [{ id: "m2", label: "waste-land.png", kind: "image", path: "assets/library/waste-land.png" }],
      },
    ],
  });
  await fs.mkdir(path.join(projectDir, "assets", "library"), { recursive: true });
  await fs.writeFile(path.join(projectDir, "assets", "library", "waste-land.png"), "bytes");

  const result = await runTool("delete_asset_entry", { section: "locations", assetId: "loc1" }, { projectDir });

  assert.equal(result.deleted, true);
  assert.deepEqual(result.deletedFiles, []);
  assert.deepEqual(result.detachedFiles, ["assets/library/waste-land.png"]);
  const metadata = JSON.parse(await fs.readFile(path.join(projectDir, ".forge", "project.json"), "utf8"));
  assert.equal(metadata.locations.length, 0);
  const stats = await fs.stat(path.join(projectDir, "assets", "library", "waste-land.png"));
  assert.equal(stats.isFile(), true);
});

// Helper for media-index tool tests: seed project.json + media-index.json
// + an on-disk file so the tool has something to attach/detach/delete.
async function seedMediaIndexProject(projectDir, { entities = [], mediaPath = "assets/characters/ash.png", mediaId = "pid_ash" } = {}) {
  const metaBase = {
    version: 2,
    project: {
      id: "proj-media-test",
      name: "Media Test",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
    settings: { sessionKey: "hook:shotforge:media-test" },
    folders: [],
    characters: [],
    locations: [],
    props: [],
    keyframes: [],
    audio: [],
    library: [],
  };
  for (const { section, entry } of entities) {
    metaBase[section] = [...(Array.isArray(metaBase[section]) ? metaBase[section] : []), entry];
  }
  await fs.mkdir(path.join(projectDir, ".forge"), { recursive: true });
  await fs.writeFile(path.join(projectDir, ".forge", "project.json"), JSON.stringify(metaBase, null, 2));
  await fs.writeFile(path.join(projectDir, ".forge", "index.json"), "{}");
  const indexEntry = {
    [mediaId]: { id: mediaId, path: mediaPath, kind: "image", source: "asset", sha256: "x", size: 0 },
  };
  await fs.writeFile(path.join(projectDir, ".forge", "media-index.json"), JSON.stringify(indexEntry, null, 2));
  const absolutePath = path.join(projectDir, mediaPath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, "bytes");
  return { metadata: metaBase, mediaId, mediaPath };
}

// Regression: attach_media used to append a new entry even when the entity
// already had that path attached, producing duplicates that later tripped
// delete_asset_entry's refcount. Fix: idempotent — return the existing
// entry with alreadyAttached: true.
test("attach_media is idempotent — double-attach does not duplicate", async () => {
  const projectDir = await makeTempProject();
  const { mediaId } = await seedMediaIndexProject(projectDir, {
    entities: [
      {
        section: "characters",
        entry: { id: "c1", name: "Ash", title: "Ash", content: "", path: "characters/ash.md", folder: null, media: [] },
      },
    ],
  });
  const first = await runTool("attach_media", { mediaId, section: "characters", entityId: "c1" }, { projectDir });
  assert.equal(first.updated, true);
  const second = await runTool("attach_media", { mediaId, section: "characters", entityId: "c1" }, { projectDir });
  assert.equal(second.updated, false);
  assert.equal(second.alreadyAttached, true);
  const metadata = JSON.parse(await fs.readFile(path.join(projectDir, ".forge", "project.json"), "utf8"));
  assert.equal(metadata.characters[0].media.length, 1);
});

// Regression: detach_media returned {updated: true} even when the filter
// matched nothing (wrong entityId or media not actually attached). Agents
// trusted the response and orphaned references accumulated. Fix: honest
// {updated: false, notAttached: true} response.
test("detach_media reports notAttached when media was not on the entity", async () => {
  const projectDir = await makeTempProject();
  const { mediaId } = await seedMediaIndexProject(projectDir, {
    entities: [
      {
        section: "characters",
        entry: { id: "c1", name: "Ash", title: "Ash", content: "", path: "characters/ash.md", folder: null, media: [] },
      },
    ],
  });
  const result = await runTool(
    "detach_media",
    { mediaId, section: "characters", entityId: "c1" },
    { projectDir },
  );
  assert.equal(result.updated, false);
  assert.equal(result.notAttached, true);
});

// Regression: delete_media with force: true used to delete the file + index
// entry but leave dangling { path, kind, label } references inside every
// entity's media[] array. Fix: strip the stale references from project.json
// too and report the cleanup in the response.
test("delete_media force=true strips dangling entity references", async () => {
  const projectDir = await makeTempProject();
  const { mediaId, mediaPath } = await seedMediaIndexProject(projectDir, {
    entities: [
      {
        section: "characters",
        entry: {
          id: "c1",
          name: "Ash",
          title: "Ash",
          content: "",
          path: "characters/ash.md",
          folder: null,
          media: [{ id: "m1", label: "ash.png", kind: "image", path: "assets/characters/ash.png" }],
        },
      },
      {
        section: "locations",
        entry: {
          id: "l1",
          name: "Tower",
          title: "Tower",
          content: "",
          path: "locations/tower.md",
          folder: null,
          media: [{ id: "m2", label: "ash.png", kind: "image", path: "assets/characters/ash.png" }],
        },
      },
    ],
  });

  const result = await runTool(
    "delete_media",
    { mediaId, force: true },
    { projectDir },
  );
  assert.equal(result.ok, true);
  assert.equal(result.deleted, true);
  assert.equal(result.strippedRefs, 2);
  assert.equal(result.strippedEntities.length, 2);
  assert.equal(result.trashedPath, "assets/inbox/ash.png");
  // File moved to temporary trash
  await assert.rejects(() => fs.stat(path.join(projectDir, mediaPath)), /ENOENT/);
  const trashStats = await fs.stat(path.join(projectDir, "assets", "inbox", "ash.png"));
  assert.equal(trashStats.isFile(), true);
  // Metadata no longer references it
  const metadata = JSON.parse(await fs.readFile(path.join(projectDir, ".forge", "project.json"), "utf8"));
  assert.equal(metadata.characters[0].media.length, 0);
  assert.equal(metadata.locations[0].media.length, 0);
  // Index entry gone
  const index = JSON.parse(await fs.readFile(path.join(projectDir, ".forge", "media-index.json"), "utf8"));
  assert.equal(index[mediaId], undefined);
});

// Regression: delete_asset_entry used to count raw media-list occurrences,
// so an entity that held the same media twice (legacy double-attach) had
// refCount=2 with no other owners, and the file was orphaned on delete.
// Fix: count distinct owning-entity IDs, not raw occurrences. sole owner
// with duplicate entries should still see the file deleted.
test("delete_asset_entry removes file when sole owner has duplicate media entries", async () => {
  const projectDir = await makeTempProject();
  await seedProjectMetadata(projectDir, {
    characters: [
      {
        id: "c1",
        title: "Ash",
        name: "Ash",
        content: "",
        path: "characters/ash.md",
        folder: null,
        media: [
          { id: "m1", label: "ash.png", kind: "image", path: "assets/characters/ash.png" },
          { id: "m2", label: "ash.png", kind: "image", path: "assets/characters/ash.png" },
        ],
      },
    ],
  });
  await fs.mkdir(path.join(projectDir, "assets", "characters"), { recursive: true });
  await fs.writeFile(path.join(projectDir, "assets", "characters", "ash.png"), "bytes");

  const result = await runTool(
    "delete_asset_entry",
    { section: "characters", assetId: "c1" },
    { projectDir },
  );

  assert.equal(result.deleted, true);
  assert.deepEqual(result.deletedFiles, ["assets/characters/ash.png"]);
  assert.deepEqual(result.trashedFiles, [
    { from: "assets/characters/ash.png", to: "assets/inbox/ash.png" },
  ]);
  assert.deepEqual(result.detachedFiles, []);
  await assert.rejects(
    () => fs.stat(path.join(projectDir, "assets", "characters", "ash.png")),
    /ENOENT/,
  );
  const trashStats = await fs.stat(path.join(projectDir, "assets", "inbox", "ash.png"));
  assert.equal(trashStats.isFile(), true);
});

// AssetGroup tests removed — feature deleted in the 2026-05-04
// bloat-cuts pass. Stale-membership cleanup is moot when the field
// no longer persists.

test("find_duplicate_media groups files with identical SHA-256 content", async () => {
  const projectDir = await makeTempProject();
  // Write three files: A and C are bit-identical, B is different.
  // After scan_media indexes them, find_duplicate_media should report
  // exactly one group containing A and C.
  await fs.mkdir(path.join(projectDir, "assets", "library"), { recursive: true });
  await fs.mkdir(path.join(projectDir, "assets", "characters"), { recursive: true });
  await fs.writeFile(path.join(projectDir, "assets", "library", "a.png"), "PNG-CONTENT-X");
  await fs.writeFile(path.join(projectDir, "assets", "library", "b.png"), "PNG-CONTENT-Y");
  await fs.writeFile(path.join(projectDir, "assets", "characters", "c.png"), "PNG-CONTENT-X");
  await seedProjectMetadata(projectDir, {});

  await runTool("scan_media", {}, { projectDir });
  const result = await runTool("find_duplicate_media", { kind: "image" }, { projectDir });

  assert.equal(result.groupCount, 1);
  assert.equal(result.duplicateFileCount, 2);
  const group = result.groups[0];
  assert.equal(group.count, 2);
  const paths = group.items.map((item) => item.path).sort();
  assert.deepEqual(paths, [
    "assets/characters/c.png",
    "assets/library/a.png",
  ]);
});

test("find_duplicate_media returns an empty result when nothing duplicates", async () => {
  const projectDir = await makeTempProject();
  await fs.mkdir(path.join(projectDir, "assets", "library"), { recursive: true });
  await fs.writeFile(path.join(projectDir, "assets", "library", "a.png"), "X");
  await fs.writeFile(path.join(projectDir, "assets", "library", "b.png"), "Y");
  await seedProjectMetadata(projectDir, {});
  await runTool("scan_media", {}, { projectDir });
  const result = await runTool("find_duplicate_media", { kind: "image" }, { projectDir });
  assert.equal(result.groupCount, 0);
  assert.deepEqual(result.groups, []);
});

test("read_asset_bundle surfaces usedBy[] for entityRef pointers", async () => {
  const projectDir = await makeTempProject();
  await seedProjectMetadata(projectDir, {
    characters: [
      {
        id: "char1",
        title: "Aki",
        name: "Aki",
        content: "Lead protagonist.",
        path: "characters/aki.md",
        folder: null,
        media: [],
      },
    ],
    shots: [
      {
        id: "shot1",
        title: "01.01 — Aki opens door",
        path: "shots/scene-01-foo/shot-01-aki-opens-door.md",
        sceneId: "scene1",
        scenePath: "scenes/scene-01-foo.md",
        entityRefs: [{ section: "characters", entityId: "char1", role: "featured" }],
        content: "Aki opens the door.",
      },
    ],
  });

  const result = await runTool(
    "read_asset_bundle",
    { section: "characters", assetId: "char1" },
    { projectDir },
  );
  assert.equal(result.usedBy.length, 1);
  assert.equal(result.usedBy[0].section, "shots");
  assert.equal(result.usedBy[0].id, "shot1");
  assert.equal(result.usedBy[0].role, "featured");
  assert.equal(result.usageRoleCounts.featured, 1);
});

test("read_asset_bundle accepts agent-style entityRef aliases in usage data", async () => {
  const projectDir = await makeTempProject();
  await seedProjectMetadata(projectDir, {
    characters: [
      {
        id: "char1",
        title: "Aki",
        name: "Aki",
        content: "Lead protagonist.",
        path: "characters/aki.md",
        folder: null,
        media: [],
      },
    ],
    prompts: [
      {
        id: "prompt1",
        title: "Aki enters",
        path: "prompts/scene-01/shot-01/prompt-01.md",
        sceneId: "scene1",
        shotId: "shot1",
        entityRefs: [{ type: "character", id: "char1", role: "primary" }],
        content: "Aki enters the room.",
      },
    ],
  });

  const result = await runTool(
    "read_asset_bundle",
    { section: "characters", assetId: "char1" },
    { projectDir },
  );
  assert.equal(result.usedBy.length, 1);
  assert.equal(result.usedBy[0].section, "prompts");
  assert.equal(result.usedBy[0].role, "featured");
  assert.equal(result.usageRoleCounts.featured, 1);
});

test("list_more_tools returns the tools in a requested tier", async () => {
  const projectDir = await makeTempProject();
  const result = await runTool("list_more_tools", { tier: "edit" }, { projectDir });
  assert.equal(result.tier, "edit");
  const names = result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "apply_timeline_batch",
    "attach_media",
    "clear_keeper",
    "create_asset_entries",
    "create_asset_entry",
    "create_prompt",
    "create_scene",
    "delete_asset_entries",
    "delete_asset_entry",
    "delete_media",
    "delete_prompt",
    "delete_scene",
    "detach_media",
    "edit_file",
    "move_asset_entry",
    "normalize_asset_media_names",
    "reassign_orphan_video",
    "rename_paths",
    "scan_media",
    "set_audio_kind",
    "set_keeper",
    "set_prompt_continuity",
    "set_title",
    "sync_assets_from_disk",
    "tighten_scene",
    "timeline_add_clip",
    "timeline_move_clip",
    "timeline_remove_clip",
    "timeline_set_enabled",
    "timeline_set_fade",
    "timeline_set_label",
    "timeline_set_trim",
    "timeline_set_volume",
    "timeline_split_clip",
    "update_asset_entry",
    "write_file",
  ]);
});

test("list_more_tools reports unknown tier gracefully", async () => {
  const projectDir = await makeTempProject();
  const result = await runTool("list_more_tools", { tier: "bogus" }, { projectDir });
  assert.ok(result.error);
  assert.ok(Array.isArray(result.available));
});

test("list_more_tools exposes the full meta tier including memory topic tools", async () => {
  const projectDir = await makeTempProject();
  const result = await runTool("list_more_tools", { tier: "meta" }, { projectDir });
  assert.equal(result.tier, "meta");
  const names = result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "add_memory_topic",
    "announce_intent",
    "build_render_bundle",
    "build_timeline",
    "check_action_risk",
    "delete_memory_topic",
    "export_timeline",
    "extract_frame",
    "list_magic_docs",
    "list_memory_topics",
    "list_more_tools",
    "list_pinboard",
    "list_providers",
    "list_skills",
    "read_magic_doc",
    "read_memory_topic",
    "read_project_context",
    "read_provider_docs",
    "read_skill",
    "remember",
    "remove_pinboard",
    "run_heartbeat",
    "run_safe_maintenance",
    "search_chats",
    "update_pinboard",
  ]);
});

test("skill discovery returns stable metadata for lean agent loading", async () => {
  const projectDir = await makeTempProject();
  await seedProjectMetadata(projectDir, {
    settings: {
      sessionKey: "hook:shotforge:test",
      enabledSkillAddons: ["custom"],
    },
  });
  await fs.mkdir(path.join(projectDir, ".forge", "skills"), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, ".forge", "skills", "zeta-skill.md"),
    [
      "---",
      "name: zeta-skill",
      "version: 3",
      'triggers: ["late"]',
      'crossRefs: ["alpha-skill", "camera"]',
      "summary: Last skill for ordering.",
      "---",
      "# Zeta",
      "",
      "Use this only when a late skill is needed.",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(projectDir, ".forge", "skills", "alpha-skill.md"),
    [
      "---",
      "name: alpha-skill",
      "summary: First skill for ordering.",
      "triggers: alpha, first",
      "crossRefs: zeta-skill, lighting",
      "---",
      "# Alpha",
      "",
      "Small focused reference.",
      "",
    ].join("\n"),
    "utf8",
  );

  const listed = await runTool("list_skills", {}, { projectDir });
  assert.equal(listed.count, 2);
  assert.deepEqual(
    listed.skills.map((skill) => skill.path),
    [".forge/skills/alpha-skill.md", ".forge/skills/zeta-skill.md"],
  );
  assert.deepEqual(listed.skills[0].triggers, ["alpha", "first"]);
  assert.deepEqual(listed.skills[0].crossRefs, ["zeta-skill", "lighting"]);
  assert.ok(listed.skills[0].words > 0);

  const zeta = await runTool("read_skill", { name: "zeta-skill" }, { projectDir });
  assert.equal(zeta.version, "3");
  assert.deepEqual(zeta.triggers, ["late"]);
  assert.deepEqual(zeta.crossRefs, ["alpha-skill", "camera"]);
  assert.ok(zeta.words > 0);
});

test("anvil skills are default-on and individual skill disables are honored", async () => {
  const projectDir = await makeTempProject();
  await seedProjectMetadata(projectDir, {
    settings: {
      sessionKey: "hook:shotforge:test",
      enabledSkillAddons: [],
      disabledSkills: ["camera"],
    },
  });
  await fs.mkdir(path.join(projectDir, ".forge", "skills"), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, ".forge", "skills", "image-generation.md"),
    [
      "---",
      "name: image-generation",
      "summary: Core character image recipe.",
      "---",
      "# Character Image Generation",
      "",
      "Core character reference guidance.",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(projectDir, ".forge", "skills", "camera.md"),
    [
      "---",
      "name: camera",
      "summary: Optional camera craft.",
      "---",
      "# Camera",
      "",
      "Optional camera guidance.",
    ].join("\n"),
    "utf8",
  );

  const enabled = await runTool("list_skills", {}, { projectDir });
  assert.deepEqual(enabled.skills.map((skill) => skill.slug), ["image-generation"]);
  await assert.rejects(
    () => runTool("read_skill", { name: "camera" }, { projectDir }),
    /disabled in Anvil Skills/,
  );

  await seedProjectMetadata(projectDir, {
    settings: {
      sessionKey: "hook:shotforge:test",
      enabledSkillAddons: ["cinematic"],
      disabledSkills: [],
    },
  });
  const withAnvilSkills = await runTool("list_skills", {}, { projectDir });
  assert.deepEqual(
    withAnvilSkills.skills.map((skill) => skill.slug),
    ["camera", "image-generation"],
  );
  const camera = await runTool("read_skill", { name: "camera" }, { projectDir });
  assert.equal(camera.groupLabel, "Anvil Skills");
});

test("system protocol skills are hidden from user-visible skill library", async () => {
  const projectDir = await makeTempProject();
  await seedProjectMetadata(projectDir, {
    settings: {
      sessionKey: "hook:shotforge:test",
      enabledSkillAddons: [],
    },
  });
  await fs.mkdir(path.join(projectDir, ".forge", "skills"), { recursive: true });
  for (const slug of ["prompt-protocol", "intake-protocol"]) {
    await fs.writeFile(
      path.join(projectDir, ".forge", "skills", `${slug}.md`),
      [
        "---",
        `name: ${slug}`,
        "summary: Hidden protocol.",
        "---",
        `# ${slug}`,
        "",
        "Sensitive protocol text.",
      ].join("\n"),
      "utf8",
    );
  }
  await fs.writeFile(
    path.join(projectDir, ".forge", "skills", "image-generation.md"),
    [
      "---",
      "name: image-generation",
      "summary: Core location image recipe.",
      "---",
      "# Location Image Generation",
      "",
      "Core location reference guidance.",
    ].join("\n"),
    "utf8",
  );

  const listed = await runTool("list_skills", {}, { projectDir });
  assert.deepEqual(listed.skills.map((skill) => skill.slug), ["image-generation"]);
  await assert.rejects(
    () => runTool("read_skill", { name: "prompt-protocol" }, { projectDir }),
    /internal Anvil protocol/,
  );

  const library = await skillLibrary.listSkillLibrary(projectDir);
  assert.equal(library.skills.some((skill) => skill.slug === "prompt-protocol"), false);
  assert.equal(library.skills.some((skill) => skill.slug === "intake-protocol"), false);
  await assert.rejects(
    () => skillLibrary.readSkillMarkdown(projectDir, "intake-protocol"),
    /internal Anvil protocol/,
  );
});

test("custom skill docs can be created/imported and gated as a Custom add-on", async () => {
  const projectDir = await makeTempProject();
  await seedProjectMetadata(projectDir, {
    settings: {
      sessionKey: "hook:shotforge:test",
      enabledSkillAddons: [],
    },
  });

  const created = await skillLibrary.createCustomSkill(projectDir, "Trailer Voice");
  assert.equal(created.slug, "trailer-voice");
  assert.ok(created.content.includes("group: custom"));

  const disabled = await skillLibrary.listSkillLibrary(projectDir);
  const customGroup = disabled.groups.find((group) => group.id === "custom");
  assert.equal(customGroup.skillCount, 1);
  assert.equal(customGroup.enabled, false);
  await assert.rejects(
    () => runTool("read_skill", { name: "trailer-voice" }, { projectDir }),
    /disabled in the Custom add-on group/,
  );

  await seedProjectMetadata(projectDir, {
    settings: {
      sessionKey: "hook:shotforge:test",
      enabledSkillAddons: ["custom"],
    },
  });
  const enabled = await runTool("read_skill", { name: "trailer-voice" }, { projectDir });
  assert.equal(enabled.groupLabel, "Custom");

  const sourcePath = path.join(projectDir, "outside-style.md");
  await fs.writeFile(sourcePath, "# Outside Style\n\nUse plain language.", "utf8");
  const imported = await skillLibrary.importSkillMarkdown(projectDir, sourcePath);
  assert.equal(imported.slug, "outside-style");
  const importedRaw = await fs.readFile(path.join(projectDir, imported.path), "utf8");
  assert.ok(importedRaw.includes("group: custom"));

  const reserved = await skillLibrary.createCustomSkill(projectDir, "prompt-protocol");
  assert.equal(reserved.slug, "prompt-protocol-custom");
  assert.ok(reserved.content.includes("name: prompt-protocol Custom"));
});

test("legacy premium/provider skills under .forge/skills are hidden from the lean skill lane", async () => {
  const projectDir = await makeTempProject();
  await seedProjectMetadata(projectDir, {
    settings: {
      sessionKey: "hook:shotforge:test",
      enabledSkillAddons: ["cinematic"],
    },
  });
  await fs.mkdir(path.join(projectDir, ".forge", "skills"), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, ".forge", "skills", "seedance-prompting.md"),
    [
      "---",
      "name: seedance-prompting",
      "summary: Legacy provider recipe.",
      "---",
      "# Seedance",
      "",
      "Provider-specific guidance.",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(
    path.join(projectDir, ".forge", "skills", "image-generation.md"),
    [
      "---",
      "name: image-generation",
      "summary: Core asset reference recipe.",
      "---",
      "# Character Image Generation",
      "",
      "Core asset reference guidance.",
    ].join("\n"),
    "utf8",
  );

  const listed = await runTool("list_skills", {}, { projectDir });
  assert.deepEqual(listed.skills.map((skill) => skill.slug), ["image-generation"]);
  const character = await runTool("read_skill", { name: "image-generation" }, { projectDir });
  assert.equal(character.groupLabel, "Anvil Skills");
  await assert.rejects(
    () => runTool("read_skill", { name: "seedance-prompting" }, { projectDir }),
    /protected Anvil server methods/,
  );
});

test("build_timeline honors persisted order, explicit takes, and trim runtime", async () => {
  const projectDir = await makeTempProject();
  await seedProjectMetadata(projectDir, {
    script: [{ id: "s1", kind: "scene", title: "Scene 1", path: "scenes/scene-01.md" }],
    shots: [
      { id: "sh1", sceneId: "s1", title: "Wide", path: "shots/scene-01/shot-01-wide.md" },
      { id: "sh2", sceneId: "s1", title: "Close", path: "shots/scene-01/shot-02-close.md" },
    ],
    prompts: [
      { id: "p1", shotId: "sh1", title: "Wide Prompt", durationSec: 10, segmentIndex: 1 },
      { id: "p2", shotId: "sh2", title: "Close Prompt", durationSec: 8, segmentIndex: 1 },
    ],
    videos: [
      {
        id: "v1-keeper",
        promptId: "p1",
        shotId: "sh1",
        sceneId: "s1",
        path: "assets/videos/keeper.mp4",
        durationSec: 10,
        takeIndex: 1,
        isKeeper: true,
      },
      {
        id: "v1-alt",
        promptId: "p1",
        shotId: "sh1",
        sceneId: "s1",
        path: "assets/videos/alt.mp4",
        durationSec: 12,
        trimInSec: 2,
        trimOutSec: 7,
        takeIndex: 2,
        isKeeper: false,
      },
      {
        id: "v2",
        promptId: "p2",
        shotId: "sh2",
        sceneId: "s1",
        path: "assets/videos/close.mp4",
        durationSec: 8,
        takeIndex: 1,
        isKeeper: true,
      },
    ],
    timeline: [
      { id: "tl-p1", promptId: "p1", videoId: "v1-alt", inSec: null, outSec: null, orderIndex: 1 },
      { id: "tl-p2", promptId: "p2", videoId: "v2", inSec: null, outSec: null, orderIndex: 0 },
    ],
  });

  const result = await runTool("build_timeline", {}, { projectDir });

  assert.deepEqual(result.clips.map((clip) => clip.promptId), ["p2", "p1"]);
  assert.equal(result.clips[1].videoId, "v1-alt");
  assert.equal(result.clips[1].playableDurationSec, 5);
  assert.equal(result.totalDurationSec, 13);
});

test("build_timeline includes prompts linked by scenePath when sceneId is missing", async () => {
  const projectDir = await makeTempProject();
  await seedProjectMetadata(projectDir, {
    script: [{ id: "s1", kind: "scene", title: "Scene 1", path: "scenes/scene-01.md" }],
    prompts: [
      {
        id: "p1",
        sceneId: null,
        scenePath: "scenes/scene-01.md",
        shotId: null,
        title: "Door Creak",
        durationSec: 15,
        path: "prompts/scene-01/door-creak.md",
      },
    ],
    videos: [
      {
        id: "v1",
        promptId: "p1",
        sceneId: null,
        shotId: null,
        path: "assets/videos/door-creak.mp4",
        durationSec: 15,
        takeIndex: 1,
        isKeeper: true,
      },
    ],
  });

  const result = await runTool("build_timeline", {}, { projectDir });

  assert.deepEqual(result.clips.map((clip) => clip.promptId), ["p1"]);
  assert.equal(result.totalDurationSec, 15);
});

test("query_takes orders by story prompt order and filters scenePath-linked takes", async () => {
  const projectDir = await makeTempProject();
  await seedProjectMetadata(projectDir, {
    script: [
      {
        id: "master",
        kind: "master",
        title: "Master Script",
        path: "script/master-script.md",
        content: "Scene 01 - Workshop",
      },
      {
        id: "s1",
        kind: "scene",
        title: "Workshop",
        path: "scenes/scene-01-workshop.md",
        content: [
          "# Workshop",
          "",
          "Prompt plan:",
          "Door Creak",
          "Gold Line",
        ].join("\n"),
      },
    ],
    prompts: [
      {
        id: "p2",
        sceneId: null,
        scenePath: "scenes/scene-01-workshop.md",
        shotId: null,
        title: "Gold Line",
        durationSec: 15,
        path: "prompts/scene-01-workshop/alpha-gold-line.md",
      },
      {
        id: "p1",
        sceneId: null,
        scenePath: "scenes/scene-01-workshop.md",
        shotId: null,
        title: "Door Creak",
        durationSec: 15,
        path: "prompts/scene-01-workshop/zeta-door-creak.md",
      },
    ],
    videos: [
      {
        id: "v2",
        promptId: "p2",
        sceneId: null,
        shotId: null,
        path: "assets/videos/gold-line.mp4",
        durationSec: 15,
        takeIndex: 1,
      },
      {
        id: "v1",
        promptId: "p1",
        sceneId: null,
        shotId: null,
        path: "assets/videos/door-creak.mp4",
        durationSec: 15,
        takeIndex: 1,
      },
    ],
  });

  const result = await runTool("query_takes", { sceneId: "s1" }, { projectDir });

  assert.deepEqual(result.takes.map((take) => take.id), ["v1", "v2"]);
});

test("build_render_bundle uses the predecessor keeper for continuity frames", async () => {
  const projectDir = await makeTempProject();
  await seedProjectMetadata(projectDir, {
    videos: [
      {
        id: "v-old-keeper",
        promptId: "p1",
        shotId: "sh1",
        sceneId: "s1",
        path: "assets/videos/scene/shot/prompt/take-01.mp4",
        durationSec: 4,
        takeIndex: 1,
        isKeeper: true,
      },
      {
        id: "v-new-rejected",
        promptId: "p1",
        shotId: "sh1",
        sceneId: "s1",
        path: "assets/videos/scene/shot/prompt/take-02.mp4",
        durationSec: 4,
        takeIndex: 2,
        isKeeper: false,
      },
    ],
  });
  await fs.mkdir(path.join(projectDir, "prompts", "scene", "shot"), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, "prompts", "scene", "shot", "prompt-01.md"),
    "---\nid: p1\nsceneId: s1\nshotId: sh1\ndurationSec: 4\n---\nPrevious prompt.\n",
  );
  await fs.writeFile(
    path.join(projectDir, "prompts", "scene", "shot", "prompt-02.md"),
    "---\nid: p2\nsceneId: s1\nshotId: sh2\ndurationSec: 4\ncontinuousFrom: p1\n---\nNext prompt.\n",
  );
  await fs.mkdir(path.join(projectDir, ".forge", "frames", "v-old-keeper"), { recursive: true });
  await fs.writeFile(path.join(projectDir, ".forge", "frames", "v-old-keeper", "last.png"), "png");

  const result = await runTool("build_render_bundle", { promptId: "p2" }, { projectDir });

  assert.equal(result.ok, true);
  assert.equal(result.startFrame, ".forge/frames/v-old-keeper/last.png");
  assert.equal(result.startFrameSource.videoId, "v-old-keeper");
  assert.equal(result.startFrameSource.takeIndex, 1);
});

test("build_render_bundle resolves entityRef-linked asset references", async () => {
  const projectDir = await makeTempProject();
  await seedProjectMetadata(projectDir, {
    characters: [
      {
        id: "char1",
        title: "Aki",
        name: "Aki",
        content: "Lead protagonist.",
        path: "characters/aki.md",
        folder: null,
        media: [
          { id: "media1", label: "aki.png", kind: "image", path: "assets/characters/aki.png" },
        ],
      },
    ],
  });
  await fs.mkdir(path.join(projectDir, "prompts", "scene", "shot"), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, "prompts", "scene", "shot", "prompt-01.md"),
    [
      "---",
      "id: p1",
      "sceneId: s1",
      "shotId: sh1",
      "durationSec: 15",
      'entityRefs: [{"entityId":"char1","section":"characters","role":"featured"}]',
      "---",
      "",
      "Aki crosses the room.",
      "",
    ].join("\n"),
  );

  const result = await runTool("build_render_bundle", { promptId: "p1" }, { projectDir });

  assert.equal(result.ok, true);
  assert.equal(result.text, "Aki crosses the room.");
  assert.deepEqual(result.references, [
    {
      section: "characters",
      id: "char1",
      name: "Aki",
      role: "featured",
      mediaPath: "assets/characters/aki.png",
    },
  ]);
});

test("tighten_scene trims split timeline clips and leaves skipped clips untouched", async () => {
  const projectDir = await makeTempProject();
  await seedProjectMetadata(projectDir, {
    script: [{ id: "s1", kind: "scene", title: "Scene 1", path: "scenes/scene-01.md" }],
    shots: [
      { id: "sh1", sceneId: "s1", title: "Wide", path: "shots/scene-01/shot-01-wide.md" },
      { id: "sh2", sceneId: "s1", title: "Close", path: "shots/scene-01/shot-02-close.md" },
    ],
    prompts: [
      { id: "p1", shotId: "sh1", title: "Wide Prompt", durationSec: 10, segmentIndex: 1 },
      { id: "p2", shotId: "sh2", title: "Close Prompt", durationSec: 8, segmentIndex: 1 },
    ],
    videos: [
      {
        id: "v1",
        promptId: "p1",
        shotId: "sh1",
        sceneId: "s1",
        path: "assets/videos/wide.mp4",
        durationSec: 10,
        takeIndex: 1,
        isKeeper: true,
      },
      {
        id: "v2",
        promptId: "p2",
        shotId: "sh2",
        sceneId: "s1",
        path: "assets/videos/close.mp4",
        durationSec: 8,
        takeIndex: 1,
        isKeeper: true,
      },
    ],
    timeline: [
      { id: "tl-a", promptId: "p1", videoId: "v1", inSec: 0, outSec: 6, enabled: true, orderIndex: 0 },
      { id: "tl-b", promptId: "p1", videoId: "v1", inSec: 6, outSec: 10, enabled: true, orderIndex: 1 },
      { id: "tl-c", promptId: "p2", videoId: "v2", inSec: 1, outSec: 7, enabled: false, orderIndex: 2 },
    ],
  });

  const result = await runTool("tighten_scene", { sceneId: "s1", targetSec: 5 }, { projectDir });
  assert.equal(result.ok, true);
  assert.equal(result.plan.length, 2);

  const saved = JSON.parse(
    await fs.readFile(path.join(projectDir, ".forge", "project.json"), "utf8"),
  );
  const timelineById = new Map((saved.timeline || []).map((entry) => [entry.id, entry]));

  assert.deepEqual(
    {
      inSec: timelineById.get("tl-a").inSec,
      outSec: timelineById.get("tl-a").outSec,
      enabled: timelineById.get("tl-a").enabled,
    },
    { inSec: 1.5, outSec: 4.5, enabled: true },
  );
  assert.deepEqual(
    {
      inSec: timelineById.get("tl-b").inSec,
      outSec: timelineById.get("tl-b").outSec,
      enabled: timelineById.get("tl-b").enabled,
    },
    { inSec: 7, outSec: 9, enabled: true },
  );
  assert.deepEqual(
    {
      inSec: timelineById.get("tl-c").inSec,
      outSec: timelineById.get("tl-c").outSec,
      enabled: timelineById.get("tl-c").enabled,
    },
    { inSec: 1, outSec: 7, enabled: false },
  );
});

test("timeline_add_clip appends to V1 with explicit start; rejects videoId on audio track", async () => {
  const projectDir = await makeTempProject();
  const audioDurationSec = await installFakeFfprobe(projectDir);
  await writeDummyAudio(projectDir);
  await seedProjectMetadata(projectDir, {
    videos: [
      {
        id: "v1",
        promptId: null,
        sceneId: null,
        shotId: null,
        path: "assets/videos/take-01.mp4",
        durationSec: 6,
        takeIndex: 1,
        generator: "upload",
        generatedAt: "2026-04-26T00:00:00Z",
        note: "",
      },
    ],
    audio: [
      {
        id: "asset-music",
        title: "Music",
        name: "Music",
        path: "",
        content: "",
        media: [
          { id: "m1", kind: "audio", label: "music.mp3", path: "assets/audio/music.mp3", fileUrl: "" },
        ],
      },
    ],
  });

  const added = await runTool(
    "timeline_add_clip",
    { track: "V1", videoId: "v1" },
    { projectDir },
  );
  assert.equal(added.ok, true);
  assert.equal(added.track, "V1");
  assert.equal(added.startSec, 0);

  const audioAdd = await runTool(
    "timeline_add_clip",
    { track: "A1", mediaPath: "assets/audio/music.mp3", startSec: 2 },
    { projectDir },
  );
  assert.equal(audioAdd.ok, true);
  assert.equal(audioAdd.track, "A1");
  assert.equal(audioAdd.startSec, 2);
  assert.equal(audioAdd.outSec, audioDurationSec);
  assert.equal(audioAdd.sourceDurationSec, audioDurationSec);
  assert.equal(audioAdd.outSecDefaulted, true);

  const audioList = await runTool("list_timeline", {}, { projectDir });
  const audioClip = audioList.clips.find((clip) => clip.id === audioAdd.clipId);
  assert.ok(audioClip);
  assert.equal(audioClip.outSec, audioDurationSec);

  await assert.rejects(
    () =>
      runTool(
        "timeline_add_clip",
        { track: "A1", videoId: "v1" },
        { projectDir },
      ),
    /videoId only allowed on V1 \/ V2/,
  );
});

test("apply_timeline_batch defaults added audio clips to source duration", async () => {
  const projectDir = await makeTempProject();
  const audioDurationSec = await installFakeFfprobe(projectDir);
  await writeDummyAudio(projectDir);
  await seedProjectMetadata(projectDir, {
    audio: [
      {
        id: "asset-music",
        title: "Music",
        name: "Music",
        path: "",
        content: "",
        media: [
          { id: "m1", kind: "audio", label: "music.mp3", path: "assets/audio/music.mp3", fileUrl: "" },
        ],
      },
    ],
  });

  const result = await runTool(
    "apply_timeline_batch",
    {
      ops: [
        { kind: "add", track: "A1", mediaPath: "assets/audio/music.mp3", startSec: 1 },
      ],
    },
    { projectDir },
  );

  assert.equal(result.ok, true);
  assert.equal(result.results[0].outSec, audioDurationSec);
  assert.equal(result.results[0].sourceDurationSec, audioDurationSec);
  assert.equal(result.results[0].outSecDefaulted, true);

  const list = await runTool("list_timeline", {}, { projectDir });
  assert.equal(list.clips[0].outSec, audioDurationSec);
});

test("timeline_split_clip splits at midpoint, two halves cover original window", async () => {
  const projectDir = await makeTempProject();
  await seedProjectMetadata(projectDir, {
    videos: [
      {
        id: "v1",
        promptId: null,
        sceneId: null,
        shotId: null,
        path: "assets/videos/take-01.mp4",
        durationSec: 10,
        takeIndex: 1,
        generator: "upload",
        generatedAt: "2026-04-26T00:00:00Z",
        note: "",
      },
    ],
    timeline: [
      {
        id: "clip-a",
        track: "V1",
        videoId: "v1",
        promptId: null,
        startSec: 0,
        inSec: null,
        outSec: null,
        enabled: true,
        orderIndex: 0,
      },
    ],
  });

  const splitResult = await runTool(
    "timeline_split_clip",
    { clipId: "clip-a", atSec: 4 },
    { projectDir },
  );
  assert.equal(splitResult.ok, true);
  assert.equal(splitResult.leftId, "clip-a");
  assert.ok(splitResult.rightId);
  assert.notEqual(splitResult.leftId, splitResult.rightId);

  const list = await runTool("list_timeline", {}, { projectDir });
  assert.equal(list.count, 2);
  const left = list.clips.find((c) => c.id === "clip-a");
  const right = list.clips.find((c) => c.id === splitResult.rightId);
  assert.ok(left && right);
  assert.equal(left.startSec, 0);
  assert.equal(left.outSec, 4);
  assert.equal(right.startSec, 4);
  assert.equal(right.inSec, 4);
});

test("apply_timeline_batch split returns and emits the original clip id", async () => {
  const projectDir = await makeTempProject();
  const events = [];
  await seedProjectMetadata(projectDir, {
    videos: [
      {
        id: "v1",
        promptId: null,
        sceneId: null,
        shotId: null,
        path: "assets/videos/take-01.mp4",
        durationSec: 10,
        takeIndex: 1,
        generator: "upload",
        generatedAt: "2026-04-26T00:00:00Z",
        note: "",
      },
    ],
    timeline: [
      {
        id: "clip-a",
        track: "V1",
        videoId: "v1",
        mediaPath: null,
        promptId: null,
        startSec: 0,
        inSec: null,
        outSec: 10,
        enabled: true,
        orderIndex: 0,
      },
    ],
  });

  const result = await runTool(
    "apply_timeline_batch",
    { ops: [{ kind: "split", clipId: "clip-a", atSec: 4 }] },
    { projectDir, emitTimelineEvent: (event) => events.push(event) },
  );

  const split = result.results.find((entry) => entry.kind === "split");
  assert.ok(split);
  assert.equal(split.originalId, "clip-a");
  assert.equal(events[0].kind, "clip-split");
  assert.equal(events[0].originalId, "clip-a");
});

test("timeline_set_volume + timeline_set_fade write back to clip metadata", async () => {
  const projectDir = await makeTempProject();
  await seedProjectMetadata(projectDir, {
    audio: [
      {
        id: "asset-music",
        title: "Music",
        name: "Music",
        path: "",
        content: "",
        media: [
          { id: "m1", kind: "audio", label: "music.mp3", path: "assets/audio/music.mp3", fileUrl: "" },
        ],
      },
    ],
    timeline: [
      {
        id: "clip-music",
        track: "A1",
        videoId: null,
        mediaPath: "assets/audio/music.mp3",
        promptId: null,
        startSec: 0,
        inSec: null,
        outSec: 10,
        enabled: true,
        orderIndex: 0,
      },
    ],
  });

  await runTool("timeline_set_volume", { clipId: "clip-music", volume: 0.4 }, { projectDir });
  await runTool(
    "timeline_set_fade",
    { clipId: "clip-music", fadeInSec: 0.5, fadeOutSec: 1.5 },
    { projectDir },
  );

  const list = await runTool("list_timeline", {}, { projectDir });
  const clip = list.clips.find((c) => c.id === "clip-music");
  assert.ok(clip);
  assert.equal(clip.volume, 0.4);
  assert.equal(clip.fadeInSec, 0.5);
  assert.equal(clip.fadeOutSec, 1.5);
});

test("create_asset_entry on audio infers audioKind from name heuristically", async () => {
  const projectDir = await makeTempProject();
  await seedProjectMetadata(projectDir, { audio: [] });

  const sfx = await runTool(
    "create_asset_entry",
    { section: "audio", name: "thunder_clap_sfx" },
    { projectDir },
  );
  const ambient = await runTool(
    "create_asset_entry",
    { section: "audio", name: "Forest Ambience" },
    { projectDir },
  );
  const voice = await runTool(
    "create_asset_entry",
    { section: "audio", name: "Hero VO Take 02" },
    { projectDir },
  );
  const music = await runTool(
    "create_asset_entry",
    { section: "audio", name: "Opening Score" },
    { projectDir },
  );

  const list = await runTool("list_assets", { section: "audio" }, { projectDir });
  const byId = new Map(list.audio.map((e) => [e.id, e]));
  assert.equal(byId.get(sfx.id).audioKind, "sfx");
  assert.equal(byId.get(ambient.id).audioKind, "ambient");
  assert.equal(byId.get(voice.id).audioKind, "voiceover");
  assert.equal(byId.get(music.id).audioKind, "music");
});

test("set_audio_kind tags audio AssetEntry and rejects non-audio assets / bad kinds", async () => {
  const projectDir = await makeTempProject();
  await seedProjectMetadata(projectDir, {
    audio: [
      {
        id: "asset-music",
        title: "Music",
        name: "Music",
        path: "",
        content: "",
        media: [],
      },
    ],
    characters: [
      {
        id: "asset-hero",
        title: "Hero",
        name: "Hero",
        path: "",
        content: "",
        media: [],
      },
    ],
  });

  // Default — entry with no audioKind.
  let list = await runTool("list_assets", { section: "audio" }, { projectDir });
  let entry = list.audio.find((e) => e.id === "asset-music");
  assert.equal(entry.audioKind, undefined);

  // Tag as sfx.
  const ok = await runTool("set_audio_kind", { assetId: "asset-music", kind: "sfx" }, { projectDir });
  assert.equal(ok.ok, true);
  assert.equal(ok.kind, "sfx");
  assert.equal(ok.changed, true);

  list = await runTool("list_assets", { section: "audio" }, { projectDir });
  entry = list.audio.find((e) => e.id === "asset-music");
  assert.equal(entry.audioKind, "sfx");

  // Re-set to same value reports no change.
  const noop = await runTool("set_audio_kind", { assetId: "asset-music", kind: "sfx" }, { projectDir });
  assert.equal(noop.changed, false);

  // Unknown kind rejected.
  await assert.rejects(
    runTool("set_audio_kind", { assetId: "asset-music", kind: "loud" }, { projectDir }),
    /kind must be music \| sfx \| voiceover \| ambient/,
  );

  // Non-audio asset id rejected.
  await assert.rejects(
    runTool("set_audio_kind", { assetId: "asset-hero", kind: "music" }, { projectDir }),
    /no audio asset with id/,
  );
});

test("timeline_set_enabled + timeline_set_label write back to clip metadata", async () => {
  const projectDir = await makeTempProject();
  await seedProjectMetadata(projectDir, {
    audio: [
      {
        id: "asset-music",
        title: "Music",
        name: "Music",
        path: "",
        content: "",
        media: [
          { id: "m1", kind: "audio", label: "music.mp3", path: "assets/audio/music.mp3", fileUrl: "" },
        ],
      },
    ],
    timeline: [
      {
        id: "clip-music",
        track: "A1",
        videoId: null,
        mediaPath: "assets/audio/music.mp3",
        promptId: null,
        startSec: 0,
        inSec: null,
        outSec: 10,
        enabled: true,
        orderIndex: 0,
      },
    ],
  });

  await runTool("timeline_set_enabled", { clipId: "clip-music", enabled: false }, { projectDir });
  await runTool(
    "timeline_set_label",
    { clipId: "clip-music", label: "opening hook" },
    { projectDir },
  );

  let list = await runTool("list_timeline", {}, { projectDir });
  let clip = list.clips.find((c) => c.id === "clip-music");
  assert.ok(clip);
  assert.equal(clip.enabled, false);
  assert.equal(clip.label, "opening hook");

  // Clearing the label with null reverts to no override.
  await runTool("timeline_set_label", { clipId: "clip-music", label: null }, { projectDir });
  list = await runTool("list_timeline", {}, { projectDir });
  clip = list.clips.find((c) => c.id === "clip-music");
  assert.equal(clip.label, null);

  // Non-boolean enabled is rejected.
  await assert.rejects(
    runTool("timeline_set_enabled", { clipId: "clip-music", enabled: "yes" }, { projectDir }),
    /enabled must be true or false/,
  );
});

test("list_providers returns sanitized providers (boolean hasKey, no apiKey value leaked)", async () => {
  const projectDir = await makeTempProject();
  const result = await runTool(
    "list_providers",
    {},
    {
      projectDir,
      settings: {
        apiProviders: [
          {
            id: "evolink",
            label: "EvoLink",
            capability: "image",
            capabilities: ["image", "video"],
            endpoint: "https://api.evolink.ai",
            apiKey: "sk-secret-shouldnt-leak-1234",
            envVar: "EVOLINK_API_KEY",
            defaultModel: "gemini-3-pro-image-preview",
            docs: "POST /v1/images …",
            notes: "Auto-migrated.",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          {
            id: "suno",
            label: "Suno",
            capability: "music",
            apiKey: "",
            envVar: "",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.count, 2);
  const evolink = result.providers.find((p) => p.id === "evolink");
  const suno = result.providers.find((p) => p.id === "suno");
  assert.ok(evolink && suno);
  assert.equal(evolink.hasKey, true);
  assert.deepEqual(evolink.capabilities, ["image", "video"]);
  assert.equal(evolink.docsLength > 0, true);
  assert.equal(evolink.envVar, "EVOLINK_API_KEY");
  assert.equal(suno.hasKey, false);
  // Boolean-only — no apiKey field on the response object.
  assert.equal(Object.prototype.hasOwnProperty.call(evolink, "apiKey"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(suno, "apiKey"), false);
});

test("read_provider_docs returns docs+notes for a known id; throws on unknown", async () => {
  const projectDir = await makeTempProject();
  const ctx = {
    projectDir,
    settings: {
      apiProviders: [
        {
          id: "elevenlabs",
          label: "ElevenLabs",
          capability: "voice",
          endpoint: "https://api.elevenlabs.io",
          apiKey: "secret",
          docs: "POST /v1/text-to-speech/{voice_id} …",
          notes: "Use eleven_multilingual_v2 for non-English.",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    },
  };
  const result = await runTool("read_provider_docs", { providerId: "elevenlabs" }, ctx);
  assert.equal(result.ok, true);
  assert.equal(result.id, "elevenlabs");
  assert.deepEqual(result.capabilities, ["voice"]);
  assert.match(result.docs, /text-to-speech/);
  assert.match(result.notes, /multilingual/);
  assert.equal(result.empty, false);

  await assert.rejects(
    () => runTool("read_provider_docs", { providerId: "ghost" }, ctx),
    /no provider with id 'ghost'/,
  );
});

test("generate_image honors provider capability routing before using a key", async () => {
  const projectDir = await makeTempProject();
  await assert.rejects(
    () => runTool(
      "generate_image",
      { prompt: "blacksmith reference" },
      {
        projectDir,
        settings: {
          apiProviders: [
            {
              id: "evolink",
              label: "EvoLink",
              capabilities: ["video", "music"],
              apiKey: "sk-test-not-used",
              envVar: "EVOLINK_API_KEY",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
        },
      },
    ),
    /image is unchecked/,
  );
});

test("stage_reference_media returns local upload paths for upload-capable providers", async () => {
  const projectDir = await makeTempProject();
  const framePath = path.join(projectDir, ".forge", "frames", "take-1", "last.png");
  await fs.mkdir(path.dirname(framePath), { recursive: true });
  await fs.writeFile(framePath, "png-bytes");

  const result = await runTool(
    "stage_reference_media",
    { path: ".forge/frames/take-1/last.png", provider: "topview", mode: "upload" },
    { projectDir },
  );

  assert.equal(result.ok, true);
  assert.equal(result.delivery, "upload");
  assert.equal(result.path, ".forge/frames/take-1/last.png");
  assert.equal(result.localPath, framePath);
  assert.equal(result.mediaKind, "image");
});

test("stage_reference_media can publish URL references through a configured public mirror", async () => {
  const projectDir = await makeTempProject();
  const publicDir = await fs.mkdtemp(path.join(os.tmpdir(), "anvil-public-"));
  const previousPublicDir = process.env.ANVIL_REFERENCE_PUBLIC_DIR;
  const previousBaseUrl = process.env.ANVIL_REFERENCE_BASE_URL;
  const previousPrefix = process.env.ANVIL_REFERENCE_PATH_PREFIX;
  process.env.ANVIL_REFERENCE_PUBLIC_DIR = publicDir;
  process.env.ANVIL_REFERENCE_BASE_URL = "https://cdn.example.test";
  process.env.ANVIL_REFERENCE_PATH_PREFIX = "handoffs";
  try {
    const framePath = path.join(projectDir, ".forge", "frames", "take-2", "last.png");
    await fs.mkdir(path.dirname(framePath), { recursive: true });
    await fs.writeFile(framePath, "png-bytes");

    const result = await runTool(
      "stage_reference_media",
      { path: ".forge/frames/take-2/last.png", provider: "evolink", mode: "url" },
      { projectDir },
    );

    assert.equal(result.ok, true);
    assert.equal(result.delivery, "url");
    assert.equal(result.backend, "public-mirror");
    assert.match(result.publicUrl, /^https:\/\/cdn\.example\.test\/handoffs\//);
    const copied = await fs.readFile(path.join(publicDir, result.remotePath), "utf8");
    assert.equal(copied, "png-bytes");
  } finally {
    if (previousPublicDir === undefined) {
      delete process.env.ANVIL_REFERENCE_PUBLIC_DIR;
    } else {
      process.env.ANVIL_REFERENCE_PUBLIC_DIR = previousPublicDir;
    }
    if (previousBaseUrl === undefined) {
      delete process.env.ANVIL_REFERENCE_BASE_URL;
    } else {
      process.env.ANVIL_REFERENCE_BASE_URL = previousBaseUrl;
    }
    if (previousPrefix === undefined) {
      delete process.env.ANVIL_REFERENCE_PATH_PREFIX;
    } else {
      process.env.ANVIL_REFERENCE_PATH_PREFIX = previousPrefix;
    }
  }
});

test("check_action_risk returns the classifier verdict as a tool", async () => {
  const projectDir = await makeTempProject();
  const safe = await runTool("check_action_risk", { tool: "read_file", args: {} }, { projectDir });
  assert.equal(safe.risk, "safe");
  const confirm = await runTool(
    "check_action_risk",
    { tool: "write_file", args: { path: "ANVIL.md", content: "x" } },
    { projectDir },
  );
  assert.equal(confirm.risk, "confirm");
});

test("set_title updates the YAML frontmatter title of a scene", async () => {
  const projectDir = await makeTempProject();
  await fs.mkdir(path.join(projectDir, "scenes"), { recursive: true });
  await fs.mkdir(path.join(projectDir, ".forge"), { recursive: true });
  await fs.writeFile(path.join(projectDir, ".forge", "index.json"), "{}");
  await fs.writeFile(path.join(projectDir, ".forge", "project.json"), JSON.stringify({ project: { id: "p1", name: "t" } }));
  await fs.writeFile(
    path.join(projectDir, "scenes", "scene-01.md"),
    "---\nid: s1\ntitle: Old Scene\n---\nBody content.\n",
  );
  const result = await runTool(
    "set_title",
    { path: "scenes/scene-01.md", title: "Bone Pile Detail" },
    { projectDir },
  );
  assert.equal(result.title, "Bone Pile Detail");
  assert.equal(result.previousTitle, "Old Scene");
  const saved = await fs.readFile(path.join(projectDir, "scenes", "scene-01.md"), "utf8");
  assert.ok(saved.includes("title: Bone Pile Detail"));
  assert.ok(saved.includes("Body content."));
});

test("set_title adds frontmatter when a file has none", async () => {
  const projectDir = await makeTempProject();
  await fs.mkdir(path.join(projectDir, "scenes"), { recursive: true });
  await fs.mkdir(path.join(projectDir, ".forge"), { recursive: true });
  await fs.writeFile(path.join(projectDir, ".forge", "index.json"), "{}");
  await fs.writeFile(path.join(projectDir, ".forge", "project.json"), JSON.stringify({ project: { id: "p1", name: "t" } }));
  await fs.writeFile(path.join(projectDir, "scenes", "plain.md"), "Just a body.\n");
  const result = await runTool(
    "set_title",
    { path: "scenes/plain.md", title: "New" },
    { projectDir },
  );
  assert.equal(result.title, "New");
  const saved = await fs.readFile(path.join(projectDir, "scenes", "plain.md"), "utf8");
  assert.ok(saved.startsWith("---\ntitle: New\n---\n"));
  assert.ok(saved.includes("Just a body."));
});

async function makeProjectForCreate() {
  const projectDir = await makeTempProject();
  await fs.mkdir(path.join(projectDir, ".forge"), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, ".forge", "project.json"),
    JSON.stringify({ project: { id: "p1", name: "t" } }),
  );
  await fs.writeFile(path.join(projectDir, ".forge", "index.json"), "{}");
  return projectDir;
}

test("create_scene writes scenes/scene-NN-<slug>.md with numbered frontmatter title", async () => {
  const projectDir = await makeProjectForCreate();
  const result = await runTool(
    "create_scene",
    { title: "Bone Pile Detail", content: "Ash and bones.", durationSec: 42 },
    { projectDir },
  );
  assert.match(result.path, /^scenes\/scene-01-bone-pile-detail\.md$/);
  assert.equal(result.title, "01 — Bone Pile Detail");
  assert.equal(result.durationSec, 42);
  assert.ok(result.id);
  const saved = await fs.readFile(path.join(projectDir, result.path), "utf8");
  assert.ok(saved.includes(`id: ${result.id}`));
  assert.ok(saved.includes("title: 01 — Bone Pile Detail"));
  assert.ok(saved.includes("durationSec: 42"));
  assert.ok(saved.includes("Ash and bones."));
});

test("create_scene persists placeholder asset entityRefs", async () => {
  const projectDir = await makeProjectForCreate();
  const location = await runTool(
    "create_asset_entry",
    {
      section: "locations",
      name: "Workshop",
      content: "Placeholder location card created during script planning.",
    },
    { projectDir },
  );

  const scene = await runTool(
    "create_scene",
    {
      title: "Workshop Reveal",
      entityRefs: [{ section: "locations", entityId: location.id, role: "featured" }],
    },
    { projectDir },
  );
  const saved = await fs.readFile(path.join(projectDir, scene.path), "utf8");

  assert.deepEqual(scene.entityRefs, [
    { section: "locations", entityId: location.id, role: "featured" },
  ]);
  assert.ok(saved.includes(`"entityId":"${location.id}"`));
  assert.ok(saved.includes("locations:"));
});

test("create_scene strips an existing numeric prefix instead of double-numbering", async () => {
  const projectDir = await makeProjectForCreate();
  const result = await runTool(
    "create_scene",
    { title: "99 — Already Numbered" },
    { projectDir },
  );
  assert.equal(result.title, "01 — Already Numbered");
});

test("list_scenes returns stored durationSec values", async () => {
  const projectDir = await makeProjectForCreate();
  await runTool("create_scene", { title: "Gate", durationSec: 90 }, { projectDir });

  const scenes = await runTool("list_scenes", {}, { projectDir });

  assert.equal(scenes.scenes[0].durationSec, 90);
});

test("refresh_project_index preserves scene and prompt timing metadata", async () => {
  const projectDir = await makeProjectForCreate();
  const scene = await runTool("create_scene", { title: "Gate", durationSec: 90 }, { projectDir });
  const prompt = await runTool(
    "create_prompt",
    { scene: scene.id, title: "Gate Clip", durationSec: 12 },
    { projectDir },
  );

  await runTool("refresh_project_index", {}, { projectDir });
  const index = JSON.parse(await fs.readFile(path.join(projectDir, ".forge", "index.json"), "utf8"));

  assert.equal(index.scenes[0].durationSec, 90);
  assert.equal(index.prompts[0].durationSec, 12);
  assert.equal(index.prompts[0].id, prompt.id);
  assert.equal(index.prompts[0].sceneId, scene.id);
  assert.equal(index.prompts[0].prevPromptId, null);
});

test("refresh_project_index resolves agent-written prompt aliases", async () => {
  const projectDir = await makeProjectForCreate();
  const scene = await runTool("create_scene", { title: "City Alley" }, { projectDir });

  await fs.mkdir(path.join(projectDir, "prompts", "city-alley"), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, "prompts", "city-alley", "alley-wander.md"),
    [
      "---",
      "id: prompt-alley-wander",
      "title: Alley Wander",
      "scene: City Alley",
      "durationSeconds: 12",
      "previousPrompt: prompt-city-alley",
      "---",
      "A quiet 12-second walk deeper into the alley.",
      "",
    ].join("\n"),
    "utf8",
  );

  await runTool("refresh_project_index", {}, { projectDir });
  const index = JSON.parse(await fs.readFile(path.join(projectDir, ".forge", "index.json"), "utf8"));
  const prompt = index.prompts.find((entry) => entry.id === "prompt-alley-wander");

  assert.ok(prompt);
  assert.equal(prompt.sceneId, scene.id);
  assert.equal(prompt.scenePath, scene.path);
  assert.equal(prompt.durationSec, 12);
  assert.equal(prompt.prevPromptId, "prompt-city-alley");

  const listed = await runTool("list_prompts", { sceneId: scene.id }, { projectDir });
  assert.deepEqual(listed.prompts.map((entry) => entry.id), ["prompt-alley-wander"]);
});

test("create_prompt links to a scene with SS.PP numbered title", async () => {
  const projectDir = await makeProjectForCreate();
  const scene = await runTool("create_scene", { title: "Battle" }, { projectDir });
  const prompt = await runTool(
    "create_prompt",
    { scene: scene.id, title: "Seedance prompt" },
    { projectDir },
  );
  assert.match(prompt.path, /^prompts\/scene-01-battle\/prompt-01-seedance-prompt\.md$/);
  assert.equal(prompt.title, "01.01 — Seedance prompt");
  assert.equal(prompt.sceneId, scene.id);
  assert.equal(prompt.count, 1);
  assert.equal(prompt.split, false);
});

test("create_prompt persists placeholder asset entityRefs", async () => {
  const projectDir = await makeProjectForCreate();
  const scene = await runTool("create_scene", { title: "Gate" }, { projectDir });
  const character = await runTool(
    "create_asset_entry",
    {
      section: "characters",
      name: "Runner",
      content: "Placeholder character card created before image generation.",
    },
    { projectDir },
  );
  const location = await runTool(
    "create_asset_entry",
    {
      section: "locations",
      name: "Gate Interior",
      content: "Placeholder location card created before image generation.",
    },
    { projectDir },
  );

  const prompt = await runTool(
    "create_prompt",
    {
      scene: scene.id,
      title: "Runner Enters Gate",
      entityRefs: [
        { section: "characters", entityId: character.id, role: "featured" },
        { section: "locations", entityId: location.id, role: "background" },
      ],
    },
    { projectDir },
  );
  const bundle = await runTool("read_prompt_bundle", { promptId: prompt.id }, { projectDir });
  const saved = await fs.readFile(path.join(projectDir, prompt.path), "utf8");

  assert.deepEqual(prompt.entityRefs, [
    { section: "characters", entityId: character.id, role: "featured" },
    { section: "locations", entityId: location.id, role: "background" },
  ]);
  assert.deepEqual(bundle.prompt.entityRefs, prompt.entityRefs);
  assert.ok(saved.includes(`"entityId":"${character.id}"`));
  assert.ok(saved.includes(`"entityId":"${location.id}"`));
});

test("create_prompt chains after existing scenePath-linked prompts", async () => {
  const projectDir = await makeProjectForCreate();
  const scene = await runTool("create_scene", { title: "Gate" }, { projectDir });
  await fs.mkdir(path.join(projectDir, "prompts", "scene-01-gate"), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, "prompts", "scene-01-gate", "prompt-01-old.md"),
    "---\nid: p-old\ntitle: 01.01 — Old\nscenePath: scenes/scene-01-gate.md\ndurationSec: 15\n---\nOld prompt.\n",
  );
  await fs.writeFile(
    path.join(projectDir, ".forge", "index.json"),
    JSON.stringify(
      {
        scenes: [{ id: scene.id, path: scene.path, title: scene.title }],
        prompts: [
          {
            id: "p-old",
            path: "prompts/scene-01-gate/prompt-01-old.md",
            title: "01.01 — Old",
            sceneId: null,
            scenePath: scene.path,
            durationSec: 15,
          },
        ],
      },
      null,
      2,
    ),
  );

  const prompt = await runTool("create_prompt", { scene: scene.id, title: "Next" }, { projectDir });
  const saved = await fs.readFile(path.join(projectDir, prompt.path), "utf8");

  assert.equal(prompt.prevPromptId, "p-old");
  assert.match(saved, /prevPromptId: p-old/);
});

test("set_prompt_continuity sets and clears prevPromptId", async () => {
  const projectDir = await makeProjectForCreate();
  const scene = await runTool("create_scene", { title: "Bridge" }, { projectDir });
  const promptA = await runTool(
    "create_prompt",
    { scene: scene.id, title: "Prompt A" },
    { projectDir },
  );
  const promptB = await runTool(
    "create_prompt",
    { scene: scene.id, title: "Prompt B" },
    { projectDir },
  );

  // create_prompt auto-links sequential scene prompts; clear and re-link
  // explicitly to exercise the tool both ways.
  const cleared = await runTool(
    "set_prompt_continuity",
    { prompt: promptB.id },
    { projectDir },
  );
  assert.equal(cleared.ok, true);
  assert.equal(cleared.prevPromptId, null);

  const linked = await runTool(
    "set_prompt_continuity",
    { prompt: promptB.id, prev: promptA.id },
    { projectDir },
  );
  assert.equal(linked.ok, true);
  assert.equal(linked.prevPromptId, promptA.id);

  const bundle = await runTool("read_prompt_bundle", { promptId: promptB.id }, { projectDir });
  assert.equal(bundle.prompt.prevPromptId, promptA.id);

  await assert.rejects(
    () =>
      runTool(
        "set_prompt_continuity",
        { prompt: promptB.id, prev: promptB.id },
        { projectDir },
      ),
    /cannot continue from itself/,
  );
});

test("create_prompt with scene creates a 15s prompt title", async () => {
  const projectDir = await makeProjectForCreate();
  const scene = await runTool("create_scene", { title: "Arrival" }, { projectDir });
  const prompt = await runTool(
    "create_prompt",
    { scene: scene.id, title: "Opening beat" },
    { projectDir },
  );
  assert.equal(prompt.title, "01.01 — Opening beat");
  assert.equal(prompt.durationSec, 15);
  assert.equal(prompt.sceneId, scene.id);
  const nextPrompt = await runTool(
    "create_prompt",
    { scene: scene.id, title: "Door opens" },
    { projectDir },
  );
  assert.equal(nextPrompt.title, "01.02 — Door opens");
  assert.equal(nextPrompt.prevPromptId, prompt.id);
});

// Frontmatter round-trip safety: an agent-sourced title with embedded
// newlines / tabs / control chars silently broke parseFrontmatter (which
// splits on \n line-by-line) — second line of title was dropped on next
// read. H2 fix: flatten these to a single-line title before serializing.
test("create_scene flattens embedded newlines in title", async () => {
  const projectDir = await makeProjectForCreate();
  const result = await runTool(
    "create_scene",
    { title: "Line one\nLine two" },
    { projectDir },
  );
  assert.equal(result.title, "01 — Line one Line two");
  const saved = await fs.readFile(
    path.join(projectDir, result.path),
    "utf8",
  );
  assert.ok(saved.includes("title: 01 — Line one Line two"));
  assert.ok(!/title: 01 — Line one\nLine two/.test(saved));
});

test("create_scene collapses CRLF, tabs, and multi-space in title", async () => {
  const projectDir = await makeProjectForCreate();
  const result = await runTool(
    "create_scene",
    { title: "  A\r\n\tB  \u0000 C  " },
    { projectDir },
  );
  assert.equal(result.title, "01 — A B C");
});

test("create_scene rejects whitespace-only title", async () => {
  const projectDir = await makeProjectForCreate();
  await assert.rejects(
    () => runTool("create_scene", { title: "\n\n\t  " }, { projectDir }),
    /'title' is required/,
  );
});

test("create_prompt flattens embedded newlines in title", async () => {
  const projectDir = await makeProjectForCreate();
  const scene = await runTool("create_scene", { title: "Arrival" }, { projectDir });
  const prompt = await runTool(
    "create_prompt",
    { scene: scene.id, title: "Beat\none" },
    { projectDir },
  );
  assert.equal(prompt.title, "01.01 — Beat one");
});

// Sub-prompt nesting — used when a beat needs more than 15s and is
// split into multiple chunks. The renderer + runtime calc assume:
//   1. parentPromptId is persisted on the child entry
//   2. scene is inherited from parent if not passed
//   3. Single-level only — passing a sub-prompt as parent must hoist
//      to its root parent (children of children are forbidden)
//   4. Unknown parentPromptId throws — no silent orphan creation
test("create_prompt with parentPromptId persists the link and inherits scene", async () => {
  const projectDir = await makeProjectForCreate();
  const scene = await runTool("create_scene", { title: "Crossing" }, { projectDir });
  const parent = await runTool(
    "create_prompt",
    { scene: scene.id, title: "Long beat" },
    { projectDir },
  );
  const child = await runTool(
    "create_prompt",
    { title: "Long beat — chunk 1", parentPromptId: parent.id },
    { projectDir },
  );
  assert.equal(child.parentPromptId, parent.id);
  // Inherited scene from parent — no `scene` arg was passed.
  assert.equal(child.sceneId, scene.id);
  // Frontmatter persists too.
  const childPath = path.join(projectDir, child.path);
  const raw = await fs.readFile(childPath, "utf8");
  assert.match(raw, new RegExp(`parentPromptId: ${parent.id}`));
});

test("create_prompt hoists nested-of-nested back to the root parent", async () => {
  const projectDir = await makeProjectForCreate();
  const scene = await runTool("create_scene", { title: "Charge" }, { projectDir });
  const root = await runTool(
    "create_prompt",
    { scene: scene.id, title: "Root beat" },
    { projectDir },
  );
  const sub = await runTool(
    "create_prompt",
    { title: "Sub of root", parentPromptId: root.id },
    { projectDir },
  );
  // Asking the tool to nest UNDER a sub-prompt should produce a
  // sibling, not a depth-2 grandchild.
  const grandchildAttempt = await runTool(
    "create_prompt",
    { title: "Would-be grandchild", parentPromptId: sub.id },
    { projectDir },
  );
  assert.equal(grandchildAttempt.parentPromptId, root.id);
});

test("create_prompt rejects an unknown parentPromptId", async () => {
  const projectDir = await makeProjectForCreate();
  await runTool("create_scene", { title: "Ghost" }, { projectDir });
  await assert.rejects(
    () =>
      runTool(
        "create_prompt",
        { title: "Orphan", parentPromptId: "does-not-exist" },
        { projectDir },
      ),
    /parentPromptId/,
  );
});

// L1: a pathological title (user pastes a paragraph) used to crash
// fs.writeFile with ENAMETOOLONG because slugifyName returned a 5000-char
// slug. slugifyName now caps slugs at 80 chars with a word-boundary trim.
test("create_scene caps slug length for pathological titles", async () => {
  const projectDir = await makeProjectForCreate();
  const longTitle = "Opening " + "word ".repeat(200); // ~1000 chars
  const result = await runTool(
    "create_scene",
    { title: longTitle },
    { projectDir },
  );
  const base = path.posix.basename(result.path, ".md");
  // Filename shape: scene-01-<slug>. Slug portion ≤ 80.
  const slug = base.replace(/^scene-\d+-/, "");
  assert.ok(slug.length > 0);
  assert.ok(slug.length <= 80, `slug is ${slug.length} chars, expected ≤80`);
  // No trailing hyphen from the trim
  assert.ok(!slug.endsWith("-"), `slug ends with dash: "${slug}"`);
  // Numbered title kept the full title (only the filename is truncated)
  assert.ok(result.title.startsWith("01 — Opening"));
});

test("delete_prompt removes the file and survives a missing target", async () => {
  const projectDir = await makeProjectForCreate();
  const scene = await runTool("create_scene", { title: "Gate" }, { projectDir });
  const prompt = await runTool(
    "create_prompt",
    { scene: scene.id, title: "Push in" },
    { projectDir },
  );
  const result = await runTool(
    "delete_prompt",
    { promptId: prompt.id },
    { projectDir },
  );
  assert.equal(result.deletedPath, prompt.path);
  await assert.rejects(() => fs.stat(path.join(projectDir, prompt.path)), /ENOENT/);
  // Idempotent: deleting again returns null with a reason, not an error.
  const second = await runTool(
    "delete_prompt",
    { promptId: prompt.id },
    { projectDir },
  );
  assert.equal(second.deletedPath, null);
  assert.match(second.reason || "", /not found/);
});

test("delete_scene cascades to prompts", async () => {
  const projectDir = await makeProjectForCreate();
  const scene = await runTool("create_scene", { title: "Gate" }, { projectDir });
  const promptA = await runTool(
    "create_prompt",
    { scene: scene.id, title: "Push in" },
    { projectDir },
  );
  const result = await runTool(
    "delete_scene",
    { sceneId: scene.id },
    { projectDir },
  );
  assert.equal(result.deletedPath, scene.path);
  assert.deepEqual(result.deletedPrompts, [promptA.path]);
  await assert.rejects(() => fs.stat(path.join(projectDir, scene.path)), /ENOENT/);
  await assert.rejects(() => fs.stat(path.join(projectDir, promptA.path)), /ENOENT/);
});

test("delete_scene cascades to folder-linked prompts without sceneId", async () => {
  const projectDir = await makeProjectForCreate();
  const scene = await runTool("create_scene", { title: "Gate" }, { projectDir });
  const promptPath = "prompts/scene-01-gate/prompt-01-wide.md";
  await fs.mkdir(path.join(projectDir, "prompts", "scene-01-gate"), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, promptPath),
    "---\nid: p-folder\ntitle: Folder Prompt\ndurationSec: 15\n---\nPrompt.\n",
  );
  await fs.writeFile(
    path.join(projectDir, ".forge", "index.json"),
    JSON.stringify(
      {
        scenes: [{ id: scene.id, path: scene.path, title: scene.title }],
        prompts: [
          {
            id: "p-folder",
            path: promptPath,
            title: "Folder Prompt",
            sceneId: null,
            scenePath: null,
          },
        ],
        beats: [],
        shots: [],
        dialogue: [],
      },
      null,
      2,
    ),
  );

  const result = await runTool("delete_scene", { sceneId: scene.id }, { projectDir });

  assert.deepEqual(result.deletedPrompts, [promptPath]);
  await assert.rejects(() => fs.stat(path.join(projectDir, promptPath)), /ENOENT/);
});

test("delete_scene returns a 'not found' envelope for unknown ids", async () => {
  const projectDir = await makeProjectForCreate();
  const result = await runTool(
    "delete_scene",
    { sceneId: "does-not-exist" },
    { projectDir },
  );
  assert.equal(result.deletedPath, null);
  assert.match(result.reason || "", /not found/);
});

test("set_title flattens embedded newlines", async () => {
  const projectDir = await makeTempProject();
  await fs.mkdir(path.join(projectDir, "scenes"), { recursive: true });
  await fs.mkdir(path.join(projectDir, ".forge"), { recursive: true });
  await fs.writeFile(path.join(projectDir, ".forge", "index.json"), "{}");
  await fs.writeFile(
    path.join(projectDir, ".forge", "project.json"),
    JSON.stringify({ project: { id: "p1", name: "t" } }),
  );
  await fs.writeFile(
    path.join(projectDir, "scenes", "scene-01.md"),
    "---\nid: s1\ntitle: Old\n---\nBody.\n",
  );
  const result = await runTool(
    "set_title",
    { path: "scenes/scene-01.md", title: "New\nName" },
    { projectDir },
  );
  assert.equal(result.title, "New Name");
  const saved = await fs.readFile(
    path.join(projectDir, "scenes", "scene-01.md"),
    "utf8",
  );
  assert.ok(saved.includes("title: New Name"));
  assert.ok(!/title: New\nName/.test(saved));
});

test("create_asset_entry appends an entry to project.json", async () => {
  const projectDir = await makeProjectForCreate();
  const result = await runTool(
    "create_asset_entry",
    { section: "characters", name: "Duelist", content: "Fast, precise fighter." },
    { projectDir },
  );
  assert.equal(result.section, "characters");
  assert.equal(result.name, "Duelist");
  assert.ok(result.id);
  const metadata = JSON.parse(
    await fs.readFile(path.join(projectDir, ".forge", "project.json"), "utf8"),
  );
  assert.equal(metadata.characters.length, 1);
  assert.equal(metadata.characters[0].id, result.id);
  assert.equal(metadata.characters[0].content, "Fast, precise fighter.");
});

test("create_asset_entry attaches an existing project mediaPath", async () => {
  const projectDir = await makeProjectForCreate();
  await fs.mkdir(path.join(projectDir, "assets", "characters"), { recursive: true });
  await fs.writeFile(path.join(projectDir, "assets", "characters", "duelist.png"), "bytes");

  const result = await runTool(
    "create_asset_entry",
    {
      section: "characters",
      name: "Duelist",
      mediaPath: "assets/characters/duelist.png",
    },
    { projectDir },
  );

  assert.equal(result.media.length, 1);
  assert.equal(result.media[0].path, "assets/characters/duelist.png");
  assert.equal(result.media[0].kind, "image");
});

test("create_asset_entry persists kind for sheet-capable asset sections", async () => {
  const projectDir = await makeProjectForCreate();
  const result = await runTool(
    "create_asset_entry",
    {
      section: "characters",
      name: "Aki Sheet",
      kind: "sheet",
    },
    { projectDir },
  );

  assert.equal(result.kind, "sheet");
  const metadata = JSON.parse(
    await fs.readFile(path.join(projectDir, ".forge", "project.json"), "utf8"),
  );
  assert.equal(metadata.characters[0].kind, "sheet");
});

test("update_asset_entry rewrites name and content while keeping the id stable", async () => {
  const projectDir = await makeProjectForCreate();
  const created = await runTool(
    "create_asset_entry",
    { section: "characters", name: "Aki v1", content: "Old description." },
    { projectDir },
  );
  const result = await runTool(
    "update_asset_entry",
    {
      section: "characters",
      assetId: created.id,
      name: "Aki",
      content: "Refined description with more detail.",
    },
    { projectDir },
  );
  assert.equal(result.updated, true);
  assert.equal(result.id, created.id);
  assert.equal(result.asset.name, "Aki");
  assert.equal(result.asset.content, "Refined description with more detail.");
  assert.equal(result.previous.name, "Aki v1");
  // Verify on disk.
  const metadata = JSON.parse(
    await fs.readFile(path.join(projectDir, ".forge", "project.json"), "utf8"),
  );
  assert.equal(metadata.characters[0].id, created.id);
  assert.equal(metadata.characters[0].name, "Aki");
});

test("update_asset_entry can switch a sheet-capable asset between single and sheet", async () => {
  const projectDir = await makeProjectForCreate();
  const created = await runTool(
    "create_asset_entry",
    { section: "characters", name: "Lior", kind: "single" },
    { projectDir },
  );
  const result = await runTool(
    "update_asset_entry",
    {
      section: "characters",
      assetId: created.id,
      kind: "sheet",
    },
    { projectDir },
  );
  assert.equal(result.updated, true);
  assert.equal(result.asset.kind, "sheet");
  assert.equal(result.previous.kind, "single");
  const metadata = JSON.parse(
    await fs.readFile(path.join(projectDir, ".forge", "project.json"), "utf8"),
  );
  assert.equal(metadata.characters[0].kind, "sheet");
});

test("update_asset_entry returns updated:false when nothing changed", async () => {
  const projectDir = await makeProjectForCreate();
  const created = await runTool(
    "create_asset_entry",
    { section: "props", name: "Lantern", content: "Iron lantern." },
    { projectDir },
  );
  const result = await runTool(
    "update_asset_entry",
    { section: "props", assetId: created.id, name: "Lantern" },
    { projectDir },
  );
  assert.equal(result.updated, false);
  assert.match(result.reason || "", /no changes/);
});

test("update_asset_entry rejects audioKind on non-audio sections", async () => {
  const projectDir = await makeProjectForCreate();
  const created = await runTool(
    "create_asset_entry",
    { section: "characters", name: "Lior" },
    { projectDir },
  );
  await assert.rejects(
    () =>
      runTool(
        "update_asset_entry",
        { section: "characters", assetId: created.id, audioKind: "music" },
        { projectDir },
      ),
    /audioKind/,
  );
});

test("update_asset_entry returns 404-style error for unknown asset", async () => {
  const projectDir = await makeProjectForCreate();
  await assert.rejects(
    () =>
      runTool(
        "update_asset_entry",
        { section: "characters", assetId: "missing", name: "X" },
        { projectDir },
      ),
    /not found/,
  );
});

test("create_asset_entry rejects unknown section", async () => {
  const projectDir = await makeProjectForCreate();
  await assert.rejects(
    () => runTool("create_asset_entry", { section: "nope", name: "X" }, { projectDir }),
    /section/,
  );
});

test("create_asset_entry rejects non-existent mediaPath", async () => {
  const projectDir = await makeProjectForCreate();
  await assert.rejects(
    () =>
      runTool(
        "create_asset_entry",
        { section: "characters", name: "Ghost", mediaPath: "assets/characters/missing.png" },
        { projectDir },
      ),
    /does not exist|did not resolve/,
  );
});

test("remember creates unconfirmed pinboard entries; only confirmed entries flow into MEMORY.md", async () => {
  const projectDir = await makeTempProject();
  await runTool("remember", { text: "Protagonist name: Aki" }, { projectDir });
  await runTool("remember", { text: "Setting: neon Tokyo, 2077" }, { projectDir });

  // Agent calls to `remember` create proposals visible to list_pinboard
  // but they must NOT leak into MEMORY.md (which is injected as
  // authoritative context) until the user confirms them.
  const fs = require("node:fs/promises");
  const path = require("node:path");
  const memoryPath = path.join(projectDir, ".forge", "memory", "MEMORY.md");
  const beforeConfirm = await fs.readFile(memoryPath, "utf8").catch(() => "");
  assert.ok(!beforeConfirm.includes("Protagonist name: Aki"));
  assert.ok(beforeConfirm.includes("pending"));

  const listed = await runTool("list_pinboard", { confirmed: false }, { projectDir });
  assert.equal(listed.count, 2);
  const texts = listed.entries.map((e) => e.text);
  assert.ok(texts.includes("Protagonist name: Aki"));
  assert.ok(texts.includes("Setting: neon Tokyo, 2077"));

  // Once confirmed (by the user via UI — simulated here by the underlying
  // memory API, since agent tools deliberately don't expose a confirm path),
  // entries flow into MEMORY.md.
  const memoryModule = require("../memory.cjs");
  await memoryModule.updatePinboardEntry(projectDir, listed.entries[0].id, { confirmed: true });
  const afterConfirm = await fs.readFile(memoryPath, "utf8");
  assert.ok(afterConfirm.includes(listed.entries[0].text));
});

test("add_memory_topic + list_memory_topics + read_memory_topic", async () => {
  const projectDir = await makeTempProject();
  await runTool(
    "add_memory_topic",
    { name: "Character Bible", description: "Canon cast notes", content: "# Aki\nHacker, 27." },
    { projectDir },
  );
  const list = await runTool("list_memory_topics", {}, { projectDir });
  assert.equal(list.count, 1);
  assert.equal(list.topics[0].name, "Character Bible");
  const read = await runTool("read_memory_topic", { name: "Character Bible" }, { projectDir });
  assert.ok(read.text.includes("Hacker, 27."));
  assert.ok(read.text.startsWith("---"));
});

test("delete_memory_topic removes a topic file", async () => {
  const projectDir = await makeTempProject();
  await runTool("add_memory_topic", { name: "Throwaway", content: "x" }, { projectDir });
  const del = await runTool("delete_memory_topic", { name: "Throwaway" }, { projectDir });
  assert.equal(del.deleted, true);
  const list = await runTool("list_memory_topics", {}, { projectDir });
  assert.equal(list.count, 0);
});

test("search_chats finds literal substrings in .forge/chats/*.json", async () => {
  const projectDir = await makeTempProject();
  const chatsDir = path.join(projectDir, ".forge", "chats");
  await fs.mkdir(chatsDir, { recursive: true });
  const messages = [
    { role: "user", text: "Let's add a scene in the rain-soaked Tokyo alley.", timestamp: "2026-04-14T10:00:00Z" },
    { role: "assistant", text: "Okay, I'll draft the alley scene.", timestamp: "2026-04-14T10:00:10Z" },
  ];
  await fs.writeFile(path.join(chatsDir, "session-a.json"), JSON.stringify(messages), "utf8");
  const res = await runTool("search_chats", { query: "alley" }, { projectDir });
  assert.equal(res.query, "alley");
  assert.ok(res.hits.length >= 2);
  assert.ok(res.hits[0].snippet.toLowerCase().includes("alley"));
});

test("describe_images validates inputs before calling the model", async () => {
  const projectDir = await makeTempProject();
  await assert.rejects(
    () => runTool("describe_images", { paths: [] }, { projectDir }),
    /must be a non-empty array/,
  );
  await fs.mkdir(path.join(projectDir, "assets", "characters"), { recursive: true });
  await fs.writeFile(path.join(projectDir, "assets", "characters", "notes.txt"), "not an image");
  await assert.rejects(
    () => runTool("describe_images", { paths: ["assets/characters/notes.txt"] }, { projectDir }),
    /not a supported image/,
  );
});

test("compare_images rejects missing files with a clear error", async () => {
  const projectDir = await makeTempProject();
  await assert.rejects(
    () => runTool("compare_images", { pathA: "a.png", pathB: "b.png" }, { projectDir }),
    /ENOENT|no such file|not a supported/,
  );
});

test("pick_best_reference requires at least two candidates and a goal", async () => {
  const projectDir = await makeTempProject();
  await assert.rejects(
    () => runTool("pick_best_reference", { paths: ["a.png"], goal: "x" }, { projectDir }),
    /at least 2/,
  );
  await fs.mkdir(path.join(projectDir, "assets", "keyframes"), { recursive: true });
  await fs.writeFile(path.join(projectDir, "assets", "keyframes", "a.png"), "a");
  await fs.writeFile(path.join(projectDir, "assets", "keyframes", "b.png"), "b");
  await assert.rejects(
    () =>
      runTool(
        "pick_best_reference",
        { paths: ["assets/keyframes/a.png", "assets/keyframes/b.png"], goal: "" },
        { projectDir },
      ),
    /'goal' is required/,
  );
});

test("create_magic_doc + list_magic_docs + read_magic_doc round-trip", async () => {
  const projectDir = await makeTempProject();
  await fs.mkdir(path.join(projectDir, "characters"), { recursive: true });
  await fs.writeFile(path.join(projectDir, "characters", "duelist.md"), "# Duelist\n");
  const created = await runTool(
    "create_magic_doc",
    {
      name: "Character Bible",
      description: "Canon cast notes",
      kind: "bible",
      scope: ["characters/**"],
      instruction: "Summarize each character's role, look, and voice.",
    },
    { projectDir },
  );
  assert.equal(created.path, ".forge/magic/character-bible.md");

  const list = await runTool("list_magic_docs", {}, { projectDir });
  assert.equal(list.count, 1);
  assert.equal(list.docs[0].name, "Character Bible");
  assert.deepEqual(list.docs[0].scope, ["characters/**"]);
  assert.equal(list.docs[0].status, "never-synced");
  assert.equal(list.docs[0].scopeResolvedCount, 1);

  const read = await runTool("read_magic_doc", { name: "Character Bible" }, { projectDir });
  assert.equal(read.name, "Character Bible");
  assert.equal(read.neverSynthesized, true);
  assert.equal(read.body, "");
  assert.equal(read.scope[0], "characters/**");
  assert.equal(read.scopeResolvedCount, 1);
});

test("create_magic_doc rejects missing scope or instruction", async () => {
  const projectDir = await makeTempProject();
  await assert.rejects(
    () =>
      runTool(
        "create_magic_doc",
        { name: "Bad", description: "x", scope: [], instruction: "y" },
        { projectDir },
      ),
    /'scope'/,
  );
  await assert.rejects(
    () =>
      runTool(
        "create_magic_doc",
        { name: "Bad", description: "x", scope: ["ANVIL.md"], instruction: "" },
        { projectDir },
      ),
    /'instruction'/,
  );
});

test("delete_magic_doc removes the file; read_magic_doc then throws", async () => {
  const projectDir = await makeTempProject();
  await runTool(
    "create_magic_doc",
    {
      name: "Temp Bible",
      description: "x",
      scope: ["ANVIL.md"],
      instruction: "y",
    },
    { projectDir },
  );
  const del = await runTool("delete_magic_doc", { name: "Temp Bible" }, { projectDir });
  assert.equal(del.deleted, true);
  await assert.rejects(
    () => runTool("read_magic_doc", { name: "Temp Bible" }, { projectDir }),
    /not found/,
  );
});

test("read_magic_doc throws for unknown names", async () => {
  const projectDir = await makeTempProject();
  await assert.rejects(
    () => runTool("read_magic_doc", { name: "ghost" }, { projectDir }),
    /not found/,
  );
});

test("update_magic_doc refuses to overwrite hand-edited docs without force", async () => {
  const projectDir = await makeTempProject();
  await fs.mkdir(path.join(projectDir, "characters"), { recursive: true });
  await fs.writeFile(path.join(projectDir, "characters", "duelist.md"), "# Duelist\n");
  await fs.mkdir(path.join(projectDir, ".forge", "magic"), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, ".forge", "magic", "character-bible.md"),
    [
      "---",
      "name: Character Bible",
      "description: Canon cast notes",
      "kind: bible",
      'scope: ["characters/**"]',
      "instruction: Summarize each character's role, look, and voice.",
      "updatedAt: 2026-04-16T00:00:00.000Z",
      "sourcesHash: oldhashvalue1234",
      "synthesizedBodyHash: differenthash5678",
      "allowEmptyScope: false",
      "---",
      "",
      "Manual rewrite that should be preserved.",
      "",
    ].join("\n"),
    "utf8",
  );

  await assert.rejects(
    () => runTool("update_magic_doc", { name: "Character Bible" }, { projectDir }),
    /hand-edited content/,
  );
});

test("run_heartbeat reports unsynced magic docs", async () => {
  const projectDir = await makeTempProject();
  await fs.mkdir(path.join(projectDir, "characters"), { recursive: true });
  await fs.writeFile(path.join(projectDir, "characters", "duelist.md"), "# Duelist\n");
  await runTool(
    "create_magic_doc",
    {
      name: "Character Bible",
      description: "Quick cast lookup",
      kind: "bible",
      scope: ["characters/**"],
      instruction: "Summarize characters.",
    },
    { projectDir },
  );
  const result = await runTool("run_heartbeat", {}, { projectDir });
  const kinds = result.suggestions.map((s) => s.kind);
  assert.ok(kinds.includes("unsynced_magic_docs"));
  assert.equal(result.docs.magicDocs.count, 1);
  assert.equal(result.docs.magicDocs.neverSynthesized, 1);
});

test("run_heartbeat reports suggestions for a fresh project (missing docs + stale index)", async () => {
  const projectDir = await makeTempProject();
  const result = await runTool("run_heartbeat", {}, { projectDir });
  assert.ok(Array.isArray(result.suggestions));
  const kinds = result.suggestions.map((s) => s.kind);
  assert.ok(kinds.includes("missing_anvil_md"));
  assert.ok(kinds.includes("stale_index"));
});

test("run_safe_maintenance scans media and refreshes the project index", async () => {
  const projectDir = await makeTempProject();
  await seedProjectMetadata(projectDir);

  const result = await runTool("run_safe_maintenance", {}, { projectDir });
  assert.equal(result.count, 2);
  const toolNames = result.actions.map((a) => a.tool);
  assert.ok(toolNames.includes("scan_media"));
  assert.ok(toolNames.includes("refresh_project_index"));
  assert.ok(result.actions.every((a) => a.ok));
});

// spawn_worker / spawn_workers_batch tests removed — both tools were
// deleted on 2026-05-04 in the bloat-cuts pass. Parallel sub-process
// workers added complexity without clear user value for a single-user
// desktop app where the bottleneck is the LLM, not Anvil's code.

test("summarize_audio rejects non-audio paths", async () => {
  const projectDir = await makeTempProject();
  await fs.mkdir(path.join(projectDir, "assets", "audio"), { recursive: true });
  await fs.writeFile(path.join(projectDir, "assets", "audio", "readme.txt"), "notes");
  await assert.rejects(
    () => runTool("summarize_audio", { path: "assets/audio/readme.txt" }, { projectDir }),
    /not a supported audio/,
  );
});

test("listMutatingToolNames derives from tier=edit + mutation field — no hand-coded list (bug #4)", () => {
  const { listMutatingToolNames } = require("../system/tools/builtins.cjs");
  const names = listMutatingToolNames();

  // The mutating meta tools must all be picked up via their mutation:true flag.
  // Any new mutating meta tool only needs the flag, not an entry in some
  // external write-tools list.
  assert.ok(names.has("remember"));
  assert.ok(names.has("update_pinboard"));
  assert.ok(names.has("remove_pinboard"));
  assert.ok(names.has("add_memory_topic"));
  assert.ok(names.has("delete_memory_topic"));
  assert.ok(names.has("run_safe_maintenance"));

  // Edit-tier tools are covered without per-tool flagging.
  assert.ok(names.has("write_file"));
  assert.ok(names.has("edit_file"));

  // Read-only tools must NOT be classified as mutating.
  assert.ok(!names.has("read_file"));
  assert.ok(!names.has("list_dir"));
  assert.ok(!names.has("list_pinboard"));
  assert.ok(!names.has("check_project_health"));
});
