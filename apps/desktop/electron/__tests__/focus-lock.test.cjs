const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizePath,
  sceneStemFromPath,
  buildScopePredicate,
  describeScope,
} = require("../focus-lock.cjs");

// ---------------------------------------------------------------------------
// normalizePath / sceneStemFromPath
// ---------------------------------------------------------------------------

test("normalizePath strips leading ./ and /, normalizes slashes", () => {
  assert.equal(normalizePath("scenes/scene-01.md"), "scenes/scene-01.md");
  assert.equal(normalizePath("./scenes/scene-01.md"), "scenes/scene-01.md");
  assert.equal(normalizePath("/scenes/scene-01.md"), "scenes/scene-01.md");
  assert.equal(normalizePath("scenes\\scene-01.md"), "scenes/scene-01.md");
  assert.equal(normalizePath(null), "");
  assert.equal(normalizePath(undefined), "");
});

test("sceneStemFromPath extracts the basename without .md", () => {
  assert.equal(sceneStemFromPath("scenes/scene-01-intro.md"), "scene-01-intro");
  assert.equal(sceneStemFromPath("scenes/scene-03-crow.MD"), "scene-03-crow");
  assert.equal(sceneStemFromPath(""), "");
  assert.equal(sceneStemFromPath(null), "");
});

// ---------------------------------------------------------------------------
// buildScopePredicate — file scope
// ---------------------------------------------------------------------------

test("file scope permits only the exact path", () => {
  const pred = buildScopePredicate({ kind: "file", path: "scenes/scene-01.md" });
  assert.equal(pred("scenes/scene-01.md"), true);
  assert.equal(pred("./scenes/scene-01.md"), true, "normalized comparison");
  assert.equal(pred("scenes/scene-02.md"), false);
  assert.equal(pred("shots/scene-01/shot-01.md"), false);
});

// ---------------------------------------------------------------------------
// buildScopePredicate — scene scope (the headline bug #2 fix)
// ---------------------------------------------------------------------------

test("scene scope permits the scene file + any child under its shots/ or prompts/ folders", () => {
  const pred = buildScopePredicate({
    kind: "scene",
    sceneId: "scene-1",
    scenePath: "scenes/scene-01-intro.md",
  });
  // The scene file itself
  assert.equal(pred("scenes/scene-01-intro.md"), true);
  // Existing shots/prompts
  assert.equal(pred("shots/scene-01-intro/shot-01-door.md"), true);
  assert.equal(pred("prompts/scene-01-intro/prompt-01-opening.md"), true);
});

test("scene scope permits NEWLY CREATED children that didn't exist at lock-set time (bug #2 regression)", () => {
  const pred = buildScopePredicate({
    kind: "scene",
    sceneId: "scene-3",
    scenePath: "scenes/scene-03-crow.md",
  });
  // This is the exact scenario that the old frozen-paths implementation broke:
  // user locks to scene 3, agent is asked to "add a shot", agent writes to
  // shots/scene-03-crow/shot-04.md — a path that did NOT exist when the lock
  // was set. The predicate must permit it.
  assert.equal(pred("shots/scene-03-crow/shot-04-newly-created.md"), true);
  assert.equal(pred("prompts/scene-03-crow/prompt-99-brand-new.md"), true);
  // Nested folders within the scope are also fine.
  assert.equal(pred("shots/scene-03-crow/variants/shot-04-alt.md"), true);
});

test("scene scope refuses paths outside the scene subtree", () => {
  const pred = buildScopePredicate({
    kind: "scene",
    sceneId: "scene-1",
    scenePath: "scenes/scene-01-intro.md",
  });
  // Other scenes
  assert.equal(pred("scenes/scene-02-alley.md"), false);
  assert.equal(pred("shots/scene-02-alley/shot-01.md"), false);
  // Sibling directories entirely
  assert.equal(pred("assets/characters/hero.md"), false);
  assert.equal(pred("story/world-bible.md"), false);
  // Must-not-false-match on name prefix — the trailing slash anchors it
  assert.equal(
    pred("shots/scene-01-intro-v2/shot-01.md"),
    false,
    "prefix must not bleed into a similarly-named sibling",
  );
});

// ---------------------------------------------------------------------------
// buildScopePredicate — shot scope
// ---------------------------------------------------------------------------

test("shot scope permits the shot file + prompts folder of its parent scene", () => {
  const pred = buildScopePredicate({
    kind: "shot",
    shotId: "shot-1",
    shotPath: "shots/scene-01-intro/shot-01-door.md",
    scenePath: "scenes/scene-01-intro.md",
  });
  assert.equal(pred("shots/scene-01-intro/shot-01-door.md"), true);
  assert.equal(pred("prompts/scene-01-intro/prompt-01-opening.md"), true);
  // New prompt for this shot — the bug-2 regression case at shot level
  assert.equal(pred("prompts/scene-01-intro/prompt-04-brand-new.md"), true);
});

test("shot scope refuses writes to sibling shots and other scenes", () => {
  const pred = buildScopePredicate({
    kind: "shot",
    shotId: "shot-1",
    shotPath: "shots/scene-01-intro/shot-01-door.md",
    scenePath: "scenes/scene-01-intro.md",
  });
  assert.equal(pred("shots/scene-01-intro/shot-02-other.md"), false);
  assert.equal(pred("scenes/scene-01-intro.md"), false, "shot lock ≠ scene lock");
  assert.equal(pred("prompts/scene-02-alley/prompt-01.md"), false);
});

// ---------------------------------------------------------------------------
// buildScopePredicate — readonly + none
// ---------------------------------------------------------------------------

test("readonly scope refuses every path", () => {
  const pred = buildScopePredicate({ kind: "readonly" });
  assert.equal(pred("scenes/scene-01.md"), false);
  assert.equal(pred("anything"), false);
});

test("none / null / undefined scope permits every path (no lock)", () => {
  assert.equal(buildScopePredicate(null)("anywhere.md"), true);
  assert.equal(buildScopePredicate(undefined)("anywhere.md"), true);
  assert.equal(buildScopePredicate({ kind: "none" })("anywhere.md"), true);
});

// ---------------------------------------------------------------------------
// describeScope — human-readable label used in lock-violation errors
// ---------------------------------------------------------------------------

test("describeScope returns readable labels for each kind", () => {
  // Human-readable basename (M3 from 2026-04-21 focus-lock audit) — agent
  // errors surface short names like 'scene "scene-01"' rather than the raw
  // project-relative paths that leak internal layout into chat.
  assert.equal(describeScope({ kind: "file", path: "foo.md" }), "file: foo");
  assert.equal(
    describeScope({ kind: "scene", scenePath: "scenes/scene-01.md" }),
    "scene \"scene-01\" (+ its beats + shots + prompts)",
  );
  assert.equal(
    describeScope({ kind: "shot", shotPath: "shots/s-01/shot-01.md", scenePath: "scenes/s-01.md" }),
    "shot \"shot-01\" (+ its prompts)",
  );
  assert.equal(describeScope({ kind: "readonly" }), "read-only mode");
  assert.equal(describeScope({ kind: "none" }), null);
  assert.equal(describeScope(null), null);
});

// ---------------------------------------------------------------------------
// Hardening — malformed scope must not accidentally permit all writes
// ---------------------------------------------------------------------------

test("sceneStemFromPath normalizes Windows-style paths before splitting", () => {
  // This is the bug Opus caught: .split("/") on a Windows path returns
  // the full string, so .pop() gave the wrong stem and predicates never
  // matched. Now we normalize first.
  assert.equal(sceneStemFromPath("scenes\\scene-01-intro.md"), "scene-01-intro");
  assert.equal(sceneStemFromPath("C:\\path\\scenes\\scene-02.md"), "scene-02");
});

test("scene scope with empty scenePath denies all writes (fails closed)", () => {
  // If the renderer hands us a lock with empty/missing scenePath, stem
  // extraction returns "". Pre-fix, the prefix became "shots/" which
  // matched ALL shot paths across ALL scenes — a privilege-escalation bug.
  // We now fail closed.
  const pred = buildScopePredicate({ kind: "scene", sceneId: "s", scenePath: "" });
  assert.equal(pred("shots/scene-01/shot-01.md"), false);
  assert.equal(pred("prompts/scene-99/prompt-01.md"), false);
  assert.equal(pred("scenes/scene-01.md"), false);
});

test("shot scope with empty scenePath denies all writes (fails closed)", () => {
  const pred = buildScopePredicate({
    kind: "shot",
    shotId: "sh",
    shotPath: "shots/s/shot-01.md",
    scenePath: "",
  });
  assert.equal(pred("prompts/s/prompt-01.md"), false);
});

test("file scope with empty path denies all writes (fails closed)", () => {
  const pred = buildScopePredicate({ kind: "file", path: "" });
  assert.equal(pred("anywhere.md"), false);
});

test("scene scope matches paths even when called with Windows-style args", () => {
  const pred = buildScopePredicate({
    kind: "scene",
    sceneId: "s",
    scenePath: "scenes\\scene-01-intro.md",
  });
  assert.equal(pred("shots/scene-01-intro/shot-01.md"), true);
  assert.equal(pred("shots\\scene-01-intro\\shot-01.md"), true, "caller path also normalized");
});
