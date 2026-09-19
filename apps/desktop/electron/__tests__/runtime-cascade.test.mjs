import { test } from "node:test";
import assert from "node:assert/strict";
import { cascadeMasterToScenes } from "../../src/lib/runtime-cascade.ts";

// Cut #1 retired the shot tier — the cascade now only handles
// master → scenes. Tests for cascadeSceneToShots / cascadeBeatToShots /
// conserveShotDuration were dropped along with the helpers.

const baseEntry = (id, kind, durationSec) => ({
  id,
  content: "",
  path: `${kind === "master" ? "script/master" : "scenes/scene"}-${id}.md`,
  title: id,
  kind,
  durationSec: durationSec ?? null,
});

function makeProject({ script = [] } = {}) {
  return {
    audio: [],
    characters: [],
    folders: [],
    keyframes: [],
    library: [],
    locations: [],
    project: { createdAt: "", id: "p", name: "t", updatedAt: "" },
    prompts: [],
    props: [],
    script,
    story: [],
  };
}

test("cascadeMasterToScenes: no scenes → null", () => {
  const project = makeProject({ script: [baseEntry("m", "master")] });
  assert.equal(cascadeMasterToScenes(project, "m", { durationSec: 60 }), null);
});

test("cascadeMasterToScenes: NaN target → null", () => {
  const project = makeProject({
    script: [baseEntry("m", "master"), baseEntry("s1", "scene")],
  });
  assert.equal(cascadeMasterToScenes(project, "m", { durationSec: "abc" }), null);
});

test("cascadeMasterToScenes: zero/negative target → null", () => {
  const project = makeProject({
    script: [baseEntry("m", "master"), baseEntry("s1", "scene")],
  });
  assert.equal(cascadeMasterToScenes(project, "m", { durationSec: 0 }), null);
  assert.equal(cascadeMasterToScenes(project, "m", { durationSec: -5 }), null);
});

test("cascadeMasterToScenes: all scenes already set, sum meets target → null", () => {
  const project = makeProject({
    script: [
      baseEntry("m", "master"),
      baseEntry("s1", "scene", 30),
      baseEntry("s2", "scene", 30),
    ],
  });
  assert.equal(cascadeMasterToScenes(project, "m", { durationSec: 60 }), null);
});

test("cascadeMasterToScenes: all scenes already set, sum exceeds target → null", () => {
  const project = makeProject({
    script: [
      baseEntry("m", "master"),
      baseEntry("s1", "scene", 45),
      baseEntry("s2", "scene", 45),
    ],
  });
  assert.equal(cascadeMasterToScenes(project, "m", { durationSec: 60 }), null);
});

test("cascadeMasterToScenes: all scenes empty → distribute evenly", () => {
  const project = makeProject({
    script: [
      baseEntry("m", "master"),
      baseEntry("s1", "scene"),
      baseEntry("s2", "scene"),
      baseEntry("s3", "scene"),
    ],
  });
  const result = cascadeMasterToScenes(project, "m", { durationSec: 100 });
  assert.ok(result);
  const scenes = result.script.filter((e) => e.kind === "scene");
  assert.deepEqual(
    scenes.map((s) => s.durationSec),
    [34, 33, 33],
  );
  // Master row gets patched with the target
  const master = result.script.find((e) => e.id === "m");
  assert.equal(master?.durationSec, 100);
});

test("cascadeMasterToScenes: mixed empty/set → only empties get the remainder", () => {
  const project = makeProject({
    script: [
      baseEntry("m", "master"),
      baseEntry("s1", "scene", 20), // pinned
      baseEntry("s2", "scene"),
      baseEntry("s3", "scene"),
    ],
  });
  const result = cascadeMasterToScenes(project, "m", { durationSec: 100 });
  assert.ok(result);
  const byId = new Map(result.script.map((e) => [e.id, e]));
  assert.equal(byId.get("s1")?.durationSec, 20, "pinned scene unchanged");
  // Remaining 80 split across s2 + s3 → [40, 40]
  assert.equal(byId.get("s2")?.durationSec, 40);
  assert.equal(byId.get("s3")?.durationSec, 40);
});
