const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { computeIntakeStatus } = require("../agent-context.cjs");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "anvil-intake-status-"));
}

function writeIntake(dir, body) {
  fs.mkdirSync(path.join(dir, "story"), { recursive: true });
  fs.writeFileSync(path.join(dir, "story", "intake.md"), body, "utf8");
}

test("missing file → all sections none", () => {
  const dir = tmp();
  const status = computeIntakeStatus(dir);
  assert.deepEqual(status, { scope: "none", plot: "none", visuals: "none" });
});

test("empty markers → all sections none", () => {
  const dir = tmp();
  writeIntake(dir, `
<!-- intake:scope:start -->
## Core Brief

(empty - add your notes here)
<!-- intake:scope:end -->

<!-- intake:plot:start -->
## Story / Canon Seeds

(empty - add your notes here)
<!-- intake:plot:end -->

<!-- intake:visual:start -->
## Visual / Asset Seeds

(empty - add your notes here)
<!-- intake:visual:end -->
`);
  const status = computeIntakeStatus(dir);
  assert.deepEqual(status, { scope: "none", plot: "none", visuals: "none" });
});

test("scope filled with real content → scope=complete, others=none", () => {
  const dir = tmp();
  writeIntake(dir, `
<!-- intake:scope:start -->
## Core Brief

- Format: short film
- Runtime: 4 min
- Aspect & platform: 16:9
- Premise: A janitor sees her face in a dream recording.
- Tone & taste: contemplative · cinematic
- Recurring references: Mai (protagonist)
- Generation provider: EvoLink · image+video
<!-- intake:scope:end -->

<!-- intake:plot:start -->
## Story / Canon Seeds

(empty - add your notes here)
<!-- intake:plot:end -->

<!-- intake:visual:start -->
## Visual / Asset Seeds

(empty - add your notes here)
<!-- intake:visual:end -->
`);
  const status = computeIntakeStatus(dir);
  assert.equal(status.scope, "complete");
  assert.equal(status.plot, "none");
  assert.equal(status.visuals, "none");
});

test("partial section (one field, mostly empty) → partial", () => {
  const dir = tmp();
  writeIntake(dir, `
<!-- intake:scope:start -->
## Core Brief

- Format: short film
<!-- intake:scope:end -->

<!-- intake:plot:start -->
## Story / Canon Seeds

(empty - add your notes here)
<!-- intake:plot:end -->

<!-- intake:visual:start -->
## Visual / Asset Seeds

(empty - add your notes here)
<!-- intake:visual:end -->
`);
  const status = computeIntakeStatus(dir);
  assert.equal(status.scope, "partial");
});

test("skipped sections marked [skipped - best-guess defaults] count as complete", () => {
  const dir = tmp();
  writeIntake(dir, `
<!-- intake:scope:start -->
## Core Brief

[skipped - best-guess defaults]
<!-- intake:scope:end -->

<!-- intake:plot:start -->
## Story / Canon Seeds

[skipped - best-guess defaults]
<!-- intake:plot:end -->

<!-- intake:visual:start -->
## Visual / Asset Seeds

[skipped - best-guess defaults]
<!-- intake:visual:end -->
`);
  const status = computeIntakeStatus(dir);
  assert.deepEqual(status, { scope: "complete", plot: "complete", visuals: "complete" });
});

test("missing markers → none (defensive)", () => {
  const dir = tmp();
  writeIntake(dir, "# Project intake\n\nNo markers here.");
  const status = computeIntakeStatus(dir);
  assert.deepEqual(status, { scope: "none", plot: "none", visuals: "none" });
});

test("null/undefined projectDir → all sections none, no throw", () => {
  assert.deepEqual(computeIntakeStatus(null),      { scope: "none", plot: "none", visuals: "none" });
  assert.deepEqual(computeIntakeStatus(undefined), { scope: "none", plot: "none", visuals: "none" });
  assert.deepEqual(computeIntakeStatus(""),        { scope: "none", plot: "none", visuals: "none" });
});


test("user notes containing placeholder-like wording retain partial status", () => {
  for (const body of [
    "My draft note: (empty - this is a user-authored label).",
    "(empty - add your notes here)\nMy draft note.",
  ]) {
    const dir = tmp();
    writeIntake(dir, `<!-- intake:scope:start -->\n## Core Brief\n${body}\n<!-- intake:scope:end -->`);
    assert.equal(computeIntakeStatus(dir).scope, "partial");
  }
});
