"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PROMPT_FIELDS,
  resolvePromptFields,
  resolveSingleField,
  isMeaningful,
} = require("../resolve-prompt-fields.cjs");

// -----------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------

function makePrompt(overrides = {}) {
  return {
    id: "prompt-001",
    title: "01.01.01 — Crow on the gate",
    path: "prompts/scene-01/shot-01/prompt-01.md",
    content: "A crow lands on the gate.",
    sceneId: "scene-001",
    shotId: "shot-001",
    ...overrides,
  };
}

function makeShot(overrides = {}) {
  return {
    id: "shot-001",
    title: "01.01 — Crow perch wide",
    path: "shots/scene-01/shot-01.md",
    content: "Wide on the gate. Crow lands.",
    sceneId: "scene-001",
    scenePath: "scenes/scene-01.md",
    ...overrides,
  };
}

function makeScene(overrides = {}) {
  return {
    id: "scene-001",
    title: "01 — Threshold",
    path: "scenes/scene-01.md",
    content: "Opening at the threshold stone.",
    kind: "scene",
    ...overrides,
  };
}

function makeProjectDefaults(overrides = {}) {
  return {
    prompt: {
      model: "seedance-1.5",
      durationSec: 8,
      aspectRatio: "16:9",
      resolution: "1080p",
      fps: 24,
    },
    ...overrides,
  };
}

function makeModelSpec(overrides = {}) {
  return {
    id: "seedance-1.5",
    fields: {
      durationSec: { type: "number", default: 8 },
      lens: { type: "enum", options: ["24mm", "35mm", "50mm", "85mm"], default: null },
      motionIntensity: { type: "enum", options: ["subtle", "moderate", "high"], default: "moderate" },
    },
    ...overrides,
  };
}

// -----------------------------------------------------------------------
// Tier 1 — locked-prompt
// -----------------------------------------------------------------------

test("locked-prompt: prompt-level value beats every other tier", () => {
  const ctx = {
    prompt: makePrompt({ model: "veo-2", lens: "85mm" }),
    shot: makeShot({ model: "seedance-1.5", lens: "50mm" }),
    scene: makeScene({ model: "kling-1.6" }),
    projectDefaults: makeProjectDefaults({ prompt: { model: "seedance-1.5" } }),
    modelSpec: makeModelSpec({ id: "veo-2" }),
  };
  const r = resolvePromptFields(ctx);
  assert.equal(r.model.value, "veo-2");
  assert.equal(r.model.source.kind, "locked-prompt");
  assert.equal(r.lens.value, "85mm");
  assert.equal(r.lens.source.kind, "locked-prompt");
  assert.match(r.model.tooltip, /Locked on this prompt/);
});

// -----------------------------------------------------------------------
// Tier 2 — locked-shot
// -----------------------------------------------------------------------

test("locked-shot: shot value used when prompt has nothing", () => {
  const shot = makeShot({ lens: "50mm", durationSec: 12 });
  const r = resolvePromptFields({
    prompt: makePrompt(),
    shot,
    scene: makeScene(),
    projectDefaults: makeProjectDefaults(),
  });
  assert.equal(r.lens.value, "50mm");
  assert.equal(r.lens.source.kind, "locked-shot");
  assert.equal(r.lens.source.ownerId, "shot-001");
  assert.equal(r.lens.source.ownerTitle, "01.01 — Crow perch wide");
  assert.match(r.lens.tooltip, /shot.*Crow perch/);
  // Shot duration also wins — both are shot-inheritable.
  assert.equal(r.durationSec.value, 12);
  assert.equal(r.durationSec.source.kind, "locked-shot");
});

test("locked-shot: lensHint resolves prompt's `lens` field as fallback", () => {
  const r = resolvePromptFields({
    prompt: makePrompt(),
    shot: makeShot({ lensHint: "85mm" }),
    scene: makeScene(),
    projectDefaults: makeProjectDefaults(),
  });
  assert.equal(r.lens.value, "85mm");
  assert.equal(r.lens.source.kind, "locked-shot");
});

test("locked-shot: explicit shot.lens beats shot.lensHint", () => {
  const r = resolvePromptFields({
    prompt: makePrompt(),
    shot: makeShot({ lens: "50mm", lensHint: "85mm" }),
    scene: makeScene(),
    projectDefaults: makeProjectDefaults(),
  });
  assert.equal(r.lens.value, "50mm");
});

test("locked-shot: shot value does NOT propagate for non-inheritable fields", () => {
  // seed never inherits from shot — too prompt-specific.
  const r = resolvePromptFields({
    prompt: makePrompt(),
    shot: makeShot({ seed: 42 }),
    scene: makeScene(),
    projectDefaults: makeProjectDefaults(),
  });
  // No project default, no library default → agent-decides.
  assert.equal(r.seed.value, null);
  assert.equal(r.seed.source.kind, "agent-decides");
});

// -----------------------------------------------------------------------
// Tier 3 — locked-scene
// -----------------------------------------------------------------------

test("locked-scene: scene value used when prompt + shot empty (inheritable fields only)", () => {
  const r = resolvePromptFields({
    prompt: makePrompt(),
    shot: makeShot(),
    scene: makeScene({ aspectRatio: "9:16", mood: "ledger" }),
    projectDefaults: makeProjectDefaults({ prompt: {} }),
  });
  assert.equal(r.aspectRatio.value, "9:16");
  assert.equal(r.aspectRatio.source.kind, "locked-scene");
  assert.equal(r.mood.value, "ledger");
  assert.equal(r.mood.source.kind, "locked-scene");
});

test("locked-scene: scene value does NOT propagate for non-scene-inheritable fields", () => {
  // lens never inherits from scene — only model/aspectRatio/resolution/fps/mood/soundFlag do.
  const r = resolvePromptFields({
    prompt: makePrompt(),
    shot: makeShot(),
    scene: makeScene({ lens: "85mm" }),
    projectDefaults: makeProjectDefaults({ prompt: {} }),
  });
  // Should fall through to project (empty) → library (no lens default) →
  // agent-decides.
  assert.equal(r.lens.value, null);
  assert.equal(r.lens.source.kind, "agent-decides");
});

// -----------------------------------------------------------------------
// Tier 4 — project-default
// -----------------------------------------------------------------------

test("project-default: used when prompt + shot + scene all empty", () => {
  const r = resolvePromptFields({
    prompt: makePrompt(),
    shot: makeShot(),
    scene: makeScene(),
    projectDefaults: makeProjectDefaults(),
  });
  assert.equal(r.model.value, "seedance-1.5");
  assert.equal(r.model.source.kind, "project-default");
  assert.equal(r.durationSec.value, 8);
  assert.equal(r.durationSec.source.kind, "project-default");
  assert.match(r.model.tooltip, /project-defaults\.md/);
});

// -----------------------------------------------------------------------
// Tier 5 — library-default
// -----------------------------------------------------------------------

test("library-default: used when nothing locked above", () => {
  const r = resolvePromptFields({
    prompt: makePrompt(),
    shot: makeShot(),
    scene: makeScene(),
    projectDefaults: { prompt: {} },  // no project-level value for motionIntensity
    modelSpec: makeModelSpec(),
  });
  assert.equal(r.motionIntensity.value, "moderate");
  assert.equal(r.motionIntensity.source.kind, "library-default");
  assert.equal(r.motionIntensity.source.modelId, "seedance-1.5");
  assert.match(r.motionIntensity.tooltip, /seedance-1\.5/);
});

// -----------------------------------------------------------------------
// Tier 6 — agent-decides
// -----------------------------------------------------------------------

test("agent-decides: cascade exits with null when no tier has a value", () => {
  const r = resolvePromptFields({
    prompt: makePrompt(),
    shot: makeShot(),
    scene: makeScene(),
    projectDefaults: { prompt: {} },
    modelSpec: makeModelSpec({ fields: { lens: { type: "enum", options: ["24mm"], default: null } } }),
  });
  assert.equal(r.lens.value, null);
  assert.equal(r.lens.source.kind, "agent-decides");
  assert.match(r.lens.tooltip, /Agent will pick/);
});

test("agent-decides: missing modelSpec falls through cleanly", () => {
  const r = resolvePromptFields({
    prompt: makePrompt(),
    shot: makeShot(),
    scene: makeScene(),
    projectDefaults: { prompt: {} },
  });
  assert.equal(r.lens.source.kind, "agent-decides");
  assert.equal(r.cameraMovement.source.kind, "agent-decides");
});

// -----------------------------------------------------------------------
// Edge cases
// -----------------------------------------------------------------------

test("missing prompt parents (orphan prompt) doesn't crash, falls through", () => {
  const r = resolvePromptFields({
    prompt: makePrompt(),
    shot: null,
    scene: null,
    projectDefaults: makeProjectDefaults(),
  });
  // Project defaults still apply.
  assert.equal(r.model.value, "seedance-1.5");
  assert.equal(r.model.source.kind, "project-default");
});

test("empty string and empty object treated as 'not set'", () => {
  const r = resolvePromptFields({
    prompt: makePrompt({ model: "", modelParams: {} }),
    shot: makeShot(),
    scene: makeScene(),
    projectDefaults: makeProjectDefaults(),
  });
  // Empty string on model → cascade falls through to project default.
  assert.equal(r.model.value, "seedance-1.5");
  assert.equal(r.model.source.kind, "project-default");
  // Empty modelParams object → cascade falls through. No project default
  // for modelParams in our fixture, no library default → agent-decides.
  assert.equal(r.modelParams.source.kind, "agent-decides");
});

test("isMeaningful: nulls and zero values", () => {
  assert.equal(isMeaningful(null), false);
  assert.equal(isMeaningful(undefined), false);
  assert.equal(isMeaningful(""), false);
  assert.equal(isMeaningful("  "), false);
  assert.equal(isMeaningful({}), false);
  // Zero is meaningful — it's an explicit value (e.g. fps=0, soundFlag=false).
  assert.equal(isMeaningful(0), true);
  assert.equal(isMeaningful(false), true);
  assert.equal(isMeaningful("0"), true);
  assert.equal(isMeaningful({ key: "val" }), true);
});

test("resolveSingleField returns same as resolvePromptFields[field]", () => {
  const ctx = {
    prompt: makePrompt({ lens: "50mm" }),
    shot: makeShot(),
    scene: makeScene(),
    projectDefaults: makeProjectDefaults(),
  };
  const all = resolvePromptFields(ctx);
  const one = resolveSingleField(ctx, "lens");
  assert.deepEqual(one, all.lens);
});

test("resolveSingleField rejects unknown field name", () => {
  const ctx = {
    prompt: makePrompt(),
    shot: null,
    scene: null,
    projectDefaults: { prompt: {} },
  };
  assert.throws(() => resolveSingleField(ctx, "bogusField"), /unknown field/);
});

test("PROMPT_FIELDS exports the canonical ordered list", () => {
  // Used by the form to render chips in a consistent order. Locking
  // this contract means UI doesn't drift if the resolver is refactored.
  assert.deepEqual(PROMPT_FIELDS, [
    "model",
    "durationSec",
    "aspectRatio",
    "resolution",
    "fps",
    "lens",
    "cameraMovement",
    "motionIntensity",
    "mood",
    "soundFlag",
    "seed",
    "modelParams",
  ]);
});

// -----------------------------------------------------------------------
// Cascade interaction tests — multiple tiers in play
// -----------------------------------------------------------------------

test("cascade interaction: prompt locks model, shot locks lens, scene locks aspect, project provides resolution", () => {
  const r = resolvePromptFields({
    prompt: makePrompt({ model: "veo-2" }),
    shot: makeShot({ lens: "85mm" }),
    scene: makeScene({ aspectRatio: "9:16" }),
    projectDefaults: { prompt: { resolution: "1080p", fps: 24, model: "seedance-1.5" } },
    modelSpec: makeModelSpec(),
  });
  assert.equal(r.model.source.kind, "locked-prompt");
  assert.equal(r.model.value, "veo-2");
  assert.equal(r.lens.source.kind, "locked-shot");
  assert.equal(r.lens.value, "85mm");
  assert.equal(r.aspectRatio.source.kind, "locked-scene");
  assert.equal(r.aspectRatio.value, "9:16");
  assert.equal(r.resolution.source.kind, "project-default");
  assert.equal(r.resolution.value, "1080p");
});
