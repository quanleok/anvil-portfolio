"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  FALLBACK_TEMPLATE,
  buildTechnicalSidecar,
  applyTemplate,
  assemblePromptText,
} = require("../prompt-assembly.cjs");

// Build a minimal ResolvedPromptFields-shaped object for tests. Each
// field is `{ value, source, tooltip }` — only `value` is read by the
// assembler.
function rf(value) {
  return { value, source: { kind: "locked-prompt" }, tooltip: "" };
}

function makeResolved(overrides = {}) {
  return {
    model: rf("seedance-1.5"),
    durationSec: rf(8),
    aspectRatio: rf("16:9"),
    resolution: rf("1080p"),
    fps: rf(24),
    lens: rf("50mm"),
    cameraMovement: rf("tracking"),
    motionIntensity: rf("moderate"),
    mood: rf("melancholy"),
    soundFlag: rf(false),
    seed: rf(null),
    modelParams: rf(null),
    ...overrides,
  };
}

// -----------------------------------------------------------------------
// buildTechnicalSidecar
// -----------------------------------------------------------------------

test("technical sidecar bracket-list assembles in lens / movement / motion / mood order", () => {
  const sidecar = buildTechnicalSidecar(makeResolved());
  assert.equal(sidecar, "[50mm, tracking, moderate motion, melancholy]");
});

test("technical sidecar omits null fields cleanly", () => {
  const sidecar = buildTechnicalSidecar(
    makeResolved({ lens: rf(null), motionIntensity: rf(null) }),
  );
  assert.equal(sidecar, "[tracking, melancholy]");
});

test("technical sidecar returns empty string when ALL fields null", () => {
  const sidecar = buildTechnicalSidecar(
    makeResolved({
      lens: rf(null),
      cameraMovement: rf(null),
      motionIntensity: rf(null),
      mood: rf(null),
    }),
  );
  assert.equal(sidecar, "");
});

// -----------------------------------------------------------------------
// applyTemplate
// -----------------------------------------------------------------------

test("applyTemplate substitutes {{ promptBody }} with the prose", () => {
  const out = applyTemplate("{{ promptBody }}", makeResolved(), "A crow lands on the gate.");
  assert.equal(out, "A crow lands on the gate.");
});

test("applyTemplate substitutes individual field tokens", () => {
  const out = applyTemplate(
    "Lens: {{ lens }}, fps: {{ fps }}, mood: {{ mood }}.",
    makeResolved(),
    "",
  );
  assert.equal(out, "Lens: 50mm, fps: 24, mood: melancholy.");
});

test("applyTemplate handles {{ technicalSidecar }} aggregate token", () => {
  const out = applyTemplate(
    "{{ promptBody }}\n\n{{ technicalSidecar }}",
    makeResolved(),
    "Wide shot of the gate.",
  );
  assert.equal(out, "Wide shot of the gate.\n\n[50mm, tracking, moderate motion, melancholy]");
});

test("applyTemplate leaves unknown tokens literal so authors can debug", () => {
  const out = applyTemplate("{{ promptBody }} :: {{ totallyMadeUp }}", makeResolved(), "Body");
  assert.match(out, /\{\{\s*totallyMadeUp\s*\}\}/);
});

test("applyTemplate tolerates whitespace inside braces", () => {
  const out = applyTemplate("{{promptBody}} | {{   lens   }}", makeResolved(), "Body");
  assert.equal(out, "Body | 50mm");
});

test("applyTemplate substitutes booleans as on/off strings", () => {
  const out = applyTemplate(
    "sound={{ soundFlag }}",
    makeResolved({ soundFlag: rf(true) }),
    "",
  );
  assert.equal(out, "sound=on");
});

// -----------------------------------------------------------------------
// assemblePromptText — full pipeline
// -----------------------------------------------------------------------

test("assemblePromptText with no model spec uses fallback template + sidecar", () => {
  const text = assemblePromptText(makeResolved(), null, "A crow lands on the gate.");
  assert.equal(
    text,
    "A crow lands on the gate.\n\n[50mm, tracking, moderate motion, melancholy]",
  );
});

test("assemblePromptText with empty sidecar collapses trailing brackets", () => {
  const resolved = makeResolved({
    lens: rf(null),
    cameraMovement: rf(null),
    motionIntensity: rf(null),
    mood: rf(null),
  });
  const text = assemblePromptText(resolved, null, "A crow lands on the gate.");
  // No "[]" tail; clean prose only.
  assert.equal(text, "A crow lands on the gate.");
});

test("assemblePromptText with custom model template uses it instead of fallback", () => {
  const modelSpec = {
    id: "veo-2",
    promptAssembly: {
      template: "{{ promptBody }} -- shot at {{ lens }} on {{ model }}",
    },
  };
  const text = assemblePromptText(makeResolved(), modelSpec, "A crow lands.");
  assert.equal(text, "A crow lands. -- shot at 50mm on seedance-1.5");
});

test("assemblePromptText trims, collapses redundant blank lines", () => {
  const modelSpec = {
    id: "x",
    promptAssembly: { template: "{{ promptBody }}\n\n\n\n{{ technicalSidecar }}" },
  };
  const text = assemblePromptText(makeResolved(), modelSpec, "Body");
  assert.equal(text, "Body\n\n[50mm, tracking, moderate motion, melancholy]");
});

test("assemblePromptText handles missing prompt body", () => {
  const text = assemblePromptText(makeResolved(), null, "");
  // Body empty, sidecar still rendered.
  assert.equal(text, "[50mm, tracking, moderate motion, melancholy]");
});

test("FALLBACK_TEMPLATE is the documented {{ promptBody }} + {{ technicalSidecar }} pair", () => {
  assert.equal(FALLBACK_TEMPLATE, "{{ promptBody }}\n\n{{ technicalSidecar }}");
});
