// Scaffold a minimal Anvil project on disk that the Playwright suite
// boots into via `--project-dir=`. Fresh content every time so tests
// stay deterministic. Returns the absolute path.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

function seedFixtureProject() {
  const dir = path.join(os.tmpdir(), `anvil-fixture-${Date.now()}-${process.pid}`);
  fs.mkdirSync(path.join(dir, ".forge"), { recursive: true });
  fs.mkdirSync(path.join(dir, "scenes"), { recursive: true });
  fs.mkdirSync(path.join(dir, "shots", "scene-01-cold-open"), { recursive: true });
  fs.mkdirSync(path.join(dir, "prompts", "scene-01-cold-open"), { recursive: true });
  fs.mkdirSync(path.join(dir, "story"), { recursive: true });
  fs.mkdirSync(path.join(dir, "script"), { recursive: true });
  fs.mkdirSync(path.join(dir, "dialogue"), { recursive: true });
  fs.mkdirSync(path.join(dir, "assets", "characters"), { recursive: true });

  const now = new Date().toISOString();
  const project = {
    version: 2,
    project: {
      id: crypto.randomUUID(),
      name: "Audit Fixture",
      createdAt: now,
      updatedAt: now,
    },
    settings: {
      hookToken: "",
      hookUrl: "",
      sessionKey: "hook:shotforge:audit",
      agentProvider: "openclaw",
      agentBinPath: "",
      agentModel: "",
      customAgentEndpoint: "",
      apiKey: "",
      apiKeys: {},
      mediaKeys: {},
      mediaModels: {},
      mediaMode: "one",
      evolinkApiKey: "",
    },
    folders: [],
    audio: [],
    characters: [
      {
        id: "c1",
        title: "Audit Hero",
        name: "Audit Hero",
        path: "characters/audit-hero.md",
        folder: null,
        content: "Stoic. Salt-stained.",
        media: [],
      },
    ],
    locations: [],
    props: [],
    keyframes: [],
    library: [],
    story: [],
    script: [
      {
        id: "master",
        kind: "master",
        path: "script/master-script.md",
        title: "Master Script",
        content: "# Audit Master\n\n*A tiny project for the audit suite.*",
        durationSec: 60,
      },
      {
        id: "scene-1",
        kind: "scene",
        path: "scenes/scene-01-cold-open.md",
        title: "01 — Cold open",
        content: "The arena is empty.",
        durationSec: 30,
      },
    ],
    shots: [
      {
        id: "shot-1",
        path: "shots/scene-01-cold-open/shot-01-wide.md",
        title: "01.01 — Wide",
        content: "Crowd assembles.",
        sceneId: "scene-1",
        scenePath: "scenes/scene-01-cold-open.md",
        durationSec: 8,
      },
    ],
    prompts: [],
    dialogue: [],
    videos: [],
    timeline: [],
  };

  fs.writeFileSync(
    path.join(dir, ".forge", "project.json"),
    JSON.stringify(project, null, 2),
  );

  fs.writeFileSync(
    path.join(dir, "script", "master-script.md"),
    "---\nid: master\ntitle: Master Script\ndurationSec: 60\n---\n# Audit Master\n\n*A tiny project for the audit suite.*\n",
  );
  fs.writeFileSync(
    path.join(dir, "scenes", "scene-01-cold-open.md"),
    "---\nid: scene-1\ntitle: 01 — Cold open\ndurationSec: 30\n---\nThe arena is empty.\n",
  );
  fs.writeFileSync(
    path.join(dir, "shots", "scene-01-cold-open", "shot-01-wide.md"),
    "---\nid: shot-1\ntitle: 01.01 — Wide\nsceneId: scene-1\nscenePath: scenes/scene-01-cold-open.md\ndurationSec: 8\n---\nCrowd assembles.\n",
  );
  fs.writeFileSync(path.join(dir, "ANVIL.md"), "# Audit Fixture\n\nMinimal brief.\n");

  return dir;
}

module.exports = { seedFixtureProject };

if (require.main === module) {
  const dir = seedFixtureProject();
  process.stdout.write(dir);
}
