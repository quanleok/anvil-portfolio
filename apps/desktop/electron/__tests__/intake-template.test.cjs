"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { ensureIntakeDoc } = require("../intake-doc.cjs");
const { computeIntakeStatus } = require("../agent-context.cjs");

function tempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anvil-intake-"));
  return dir;
}

test("ensureIntakeDoc creates story/intake.md with the three section markers", async () => {
  const dir = tempProject();
  await ensureIntakeDoc(dir);
  const intakePath = path.join(dir, "story", "intake.md");
  assert.ok(fs.existsSync(intakePath), "story/intake.md must exist");
  const body = fs.readFileSync(intakePath, "utf8");
  assert.match(body, /title: Project Scope/);
  assert.match(body, /contextGroup: project/);
  assert.match(body, /# Project Scope/);
  assert.match(body, /User-editable project notes/);
  assert.match(body, /<!-- intake:scope:start -->/);
  assert.match(body, /<!-- intake:scope:end -->/);
  assert.match(body, /<!-- intake:plot:start -->/);
  assert.match(body, /<!-- intake:plot:end -->/);
  assert.match(body, /<!-- intake:visual:start -->/);
  assert.match(body, /<!-- intake:visual:end -->/);
  assert.match(body, /## Core Brief/);
  assert.match(body, /## Story \/ Canon Seeds/);
  assert.match(body, /## Visual \/ Asset Seeds/);
});

test("ensureIntakeDoc does not overwrite an existing story/intake.md", async () => {
  const dir = tempProject();
  fs.mkdirSync(path.join(dir, "story"), { recursive: true });
  const intakePath = path.join(dir, "story", "intake.md");
  fs.writeFileSync(intakePath, "USER CONTENT — DO NOT OVERWRITE\n");
  await ensureIntakeDoc(dir);
  const body = fs.readFileSync(intakePath, "utf8");
  assert.equal(body, "USER CONTENT — DO NOT OVERWRITE\n");
});

test("ensureIntakeDoc migrates generated intake docs to Project Scope metadata", async () => {
  const dir = tempProject();
  fs.mkdirSync(path.join(dir, "story"), { recursive: true });
  const intakePath = path.join(dir, "story", "intake.md");
  fs.writeFileSync(
    intakePath,
    `# Project intake

<!-- intake:scope:start -->
## Scope
Existing answer
<!-- intake:scope:end -->
`,
  );
  await ensureIntakeDoc(dir);
  const body = fs.readFileSync(intakePath, "utf8");
  assert.match(body, /title: Project Scope/);
  assert.match(body, /contextGroup: project/);
  assert.match(body, /# Project Scope/);
  assert.match(body, /## Core Brief/);
  assert.match(body, /Existing answer/);
});


test("ensureIntakeDoc preserves user notes through repeated normalization", async () => {
  const dir = tempProject();
  await ensureIntakeDoc(dir);
  const intakePath = path.join(dir, "story", "intake.md");
  const note = "My draft note: (empty - this is a user-authored label).";
  const draft = fs.readFileSync(intakePath, "utf8").replace("(empty - add your notes here)", note);
  fs.writeFileSync(intakePath, draft);
  await ensureIntakeDoc(dir);
  const first = fs.readFileSync(intakePath, "utf8");
  await ensureIntakeDoc(dir);
  assert.match(first, /My draft note/);
  assert.ok(first.includes(note));
  assert.equal(computeIntakeStatus(dir).scope, "partial");
  assert.equal(fs.readFileSync(intakePath, "utf8"), first);
});
