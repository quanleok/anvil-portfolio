import { test } from "node:test";
import assert from "node:assert";
import { classifyIntent } from "../../src/lib/intent-classifier.ts";

// Shared base input; tests spread over it and override the fields they
// actually want to vary.
const base = {
  message: "",
  selection: { section: null, itemId: null },
  projectContextSelected: false,
  sectionFormatSelected: null,
  pinboardSelected: false,
  hammerLabel: null,
  focusScope: { kind: "none" },
  hasAttachment: false,
};

function classify(overrides) {
  return classifyIntent({ ...base, ...overrides });
}

// =======================================================================
// TIER 1 — ItemActionBar labels
// =======================================================================

test("hammer: Apply to script on ANVIL.md → sync-canon-down", () => {
  const r = classify({ projectContextSelected: true, hammerLabel: "Apply to script" });
  assert.strictEqual(r.intent, "sync-canon-down");
  assert.strictEqual(r.confidence, "high");
});

test("hammer: Check on ANVIL.md → full-audit", () => {
  const r = classify({ projectContextSelected: true, hammerLabel: "Check" });
  assert.strictEqual(r.intent, "full-audit");
});

test("hammer: Apply format on section-format doc → apply-format", () => {
  const r = classify({ sectionFormatSelected: "shots", hammerLabel: "Apply format" });
  assert.strictEqual(r.intent, "apply-format");
});

test("hammer: Audit on section-format doc → full-audit", () => {
  const r = classify({ sectionFormatSelected: "prompts", hammerLabel: "Audit" });
  assert.strictEqual(r.intent, "full-audit");
});

test("hammer: Apply to script on story → sync-canon-down", () => {
  const r = classify({ selection: { section: "story", itemId: "s1" }, hammerLabel: "Apply to script" });
  assert.strictEqual(r.intent, "sync-canon-down");
});

test("hammer: Regenerate from script on story → refine-story-doc", () => {
  const r = classify({ selection: { section: "story", itemId: "s1" }, hammerLabel: "Regenerate from script" });
  assert.strictEqual(r.intent, "refine-story-doc");
});

test("hammer: Build clips on scene → write-prompt", () => {
  const r = classify({
    selection: { section: "script", itemId: "sc1", scriptKind: "scene" },
    hammerLabel: "Build clips",
  });
  assert.strictEqual(r.intent, "write-prompt");
});

test("hammer: Gen prompts on scene → write-prompt", () => {
  const r = classify({
    selection: { section: "script", itemId: "sc1", scriptKind: "scene" },
    hammerLabel: "Gen prompts",
  });
  assert.strictEqual(r.intent, "write-prompt");
});

test("hammer: Check on scene → validate-scene", () => {
  const r = classify({
    selection: { section: "script", itemId: "sc1", scriptKind: "scene" },
    hammerLabel: "Check",
  });
  assert.strictEqual(r.intent, "validate-scene");
});

test("hammer: Update docs on master script → sync-canon-up", () => {
  const r = classify({
    selection: { section: "script", itemId: "master", scriptKind: "master" },
    hammerLabel: "Update docs",
  });
  assert.strictEqual(r.intent, "sync-canon-up");
});

test("hammer: Full check on master script → full-audit", () => {
  const r = classify({
    selection: { section: "script", itemId: "master", scriptKind: "master" },
    hammerLabel: "Full check",
  });
  assert.strictEqual(r.intent, "full-audit");
});

test("hammer: Refine on prompt → refine-prompt", () => {
  const r = classify({ selection: { section: "prompts", itemId: "p1" }, hammerLabel: "Refine" });
  assert.strictEqual(r.intent, "refine-prompt");
});

test("hammer: Continue on prompt → continue-prompt", () => {
  const r = classify({ selection: { section: "prompts", itemId: "p1" }, hammerLabel: "Continue" });
  assert.strictEqual(r.intent, "continue-prompt");
});

test("hammer: Check on prompt → validate-prompt", () => {
  const r = classify({ selection: { section: "prompts", itemId: "p1" }, hammerLabel: "Check" });
  assert.strictEqual(r.intent, "validate-prompt");
});

test("hammer: Link on character → link-asset-refs", () => {
  const r = classify({ selection: { section: "characters", itemId: "c1" }, hammerLabel: "Link" });
  assert.strictEqual(r.intent, "link-asset-refs");
});

test("hammer: Describe on location → describe-asset", () => {
  const r = classify({ selection: { section: "locations", itemId: "l1" }, hammerLabel: "Describe" });
  assert.strictEqual(r.intent, "describe-asset");
});

test("hammer: Scan refs on prop → find-asset-usage", () => {
  const r = classify({ selection: { section: "props", itemId: "p1" }, hammerLabel: "Scan refs" });
  assert.strictEqual(r.intent, "find-asset-usage");
});

test("hammer: Full check project-wide (no section) → full-audit", () => {
  const r = classify({ hammerLabel: "Full check" });
  assert.strictEqual(r.intent, "full-audit");
});

// =======================================================================
// TIER 2 — Attachment only
// =======================================================================

test("empty message with attachment → unclear", () => {
  const r = classify({ hasAttachment: true });
  assert.strictEqual(r.intent, "unclear");
  assert.strictEqual(r.confidence, "low");
});

// =======================================================================
// TIER 3 — Pinboard
// =======================================================================

test("pinboard + 'forget this' → forget", () => {
  const r = classify({ pinboardSelected: true, message: "forget this entry" });
  assert.strictEqual(r.intent, "forget");
});

test("pinboard + 'remember that X' → remember", () => {
  const r = classify({ pinboardSelected: true, message: "remember that the lighting is always warm" });
  assert.strictEqual(r.intent, "remember");
});

// =======================================================================
// TIER 4 — Explicit patterns
// =======================================================================

test("'remember that...' → remember", () => {
  const r = classify({ message: "remember that quan prefers terse replies" });
  assert.strictEqual(r.intent, "remember");
});

// =======================================================================
// TIER 5 — Selection-driven
// =======================================================================

test("ANVIL.md + 'refine this' → refine-project-context", () => {
  const r = classify({ projectContextSelected: true, message: "refine this" });
  assert.strictEqual(r.intent, "refine-project-context");
});

test("scene + 'audit this' → validate-scene", () => {
  const r = classify({
    selection: { section: "script", itemId: "sc1", scriptKind: "scene" },
    message: "audit this scene",
  });
  assert.strictEqual(r.intent, "validate-scene");
});

test("master + 'audit' → full-audit", () => {
  const r = classify({
    selection: { section: "script", itemId: "master", scriptKind: "master" },
    message: "audit everything",
  });
  assert.strictEqual(r.intent, "full-audit");
});

test("scene + 'break this into shots' → decompose-scene", () => {
  const r = classify({
    selection: { section: "script", itemId: "sc1", scriptKind: "scene" },
    message: "break this into shots",
  });
  assert.strictEqual(r.intent, "decompose-scene");
});

test("scene + 'fill in the shots' → write-prompt", () => {
  const r = classify({
    selection: { section: "script", itemId: "sc1", scriptKind: "scene" },
    message: "fill in the missing shots",
  });
  assert.strictEqual(r.intent, "write-prompt");
});

test("prompt + 'refine' → refine-prompt", () => {
  const r = classify({
    selection: { section: "prompts", itemId: "p1" },
    message: "refine this prompt",
  });
  assert.strictEqual(r.intent, "refine-prompt");
});

test("prompt + 'continue from this' → continue-prompt", () => {
  const r = classify({
    selection: { section: "prompts", itemId: "p1" },
    message: "continue from this ending frame",
  });
  assert.strictEqual(r.intent, "continue-prompt");
});

test("asset + 'where is this used' → find-asset-usage", () => {
  const r = classify({
    selection: { section: "characters", itemId: "c1" },
    message: "where is this character used?",
  });
  assert.strictEqual(r.intent, "find-asset-usage");
});

test("asset + 'link refs' → link-asset-refs", () => {
  const r = classify({
    selection: { section: "locations", itemId: "l1" },
    message: "link the refs across all shots",
  });
  assert.strictEqual(r.intent, "link-asset-refs");
});

test("asset + 'describe' → describe-asset", () => {
  const r = classify({
    selection: { section: "characters", itemId: "c1" },
    message: "describe this character in more detail",
  });
  assert.strictEqual(r.intent, "describe-asset");
});

test("story + 'sync down' → sync-canon-down", () => {
  const r = classify({
    selection: { section: "story", itemId: "s1" },
    message: "sync down to the scenes",
  });
  assert.strictEqual(r.intent, "sync-canon-down");
});

// =======================================================================
// TIER 6 — Global patterns
// =======================================================================

test("'full audit' no selection → full-audit", () => {
  const r = classify({ message: "run a full audit of the project" });
  assert.strictEqual(r.intent, "full-audit");
});

test("'audit durations' → audit-durations", () => {
  const r = classify({ message: "audit the durations" });
  assert.strictEqual(r.intent, "audit-durations");
});

test("'what is X?' → explain", () => {
  const r = classify({ message: "what is the story system?" });
  assert.strictEqual(r.intent, "explain");
});

test("'search for X' → search-project", () => {
  const r = classify({ message: "search for any scene with the lighthouse" });
  assert.strictEqual(r.intent, "search-project");
});

test("'show me scene 3' → navigate", () => {
  const r = classify({ message: "show me scene 3" });
  assert.strictEqual(r.intent, "navigate");
});

// =======================================================================
// FALLTHROUGH
// =======================================================================

test("ambiguous message with no selection → unclear", () => {
  const r = classify({ message: "the ending feels off" });
  assert.strictEqual(r.intent, "unclear");
  assert.strictEqual(r.confidence, "low");
});

test("random prose with no signal → unclear", () => {
  const r = classify({ message: "hmm i'm not sure" });
  assert.strictEqual(r.intent, "unclear");
});

// =======================================================================
// Filler-word tolerance
// =======================================================================

test("'please refine this prompt' skips 'please' when picking verb", () => {
  const r = classify({
    selection: { section: "prompts", itemId: "p1" },
    message: "please refine this prompt",
  });
  assert.strictEqual(r.intent, "refine-prompt");
});

test("'can you write a scene?' skips filler → write-scene", () => {
  const r = classify({
    selection: { section: "script", itemId: null },
    message: "can you write a scene about the lighthouse?",
  });
  assert.strictEqual(r.intent, "write-scene");
});
