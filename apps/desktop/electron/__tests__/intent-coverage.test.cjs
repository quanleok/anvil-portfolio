const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { INTENT_HINT_SKIP } = require("../agent-loop.cjs");
const prefetch = require("../system/tools/prefetch.cjs");

// Mirror of ALL_INTENT_IDS in src/lib/intent-classifier.ts. The TS file
// is consumed by the renderer and can't be require()d here, so this test
// duplicates the list with a doc pointer. A second test below parses the
// TS source and enforces the two stay in sync.
const CLASSIFIER_INTENT_IDS = [
  "write-prompt",
  "refine-prompt",
  "continue-prompt",
  "write-scene",
  "refine-scene",
  "write-dialogue",
  "refine-dialogue",
  "decompose-scene",
  "refine-story-doc",
  "sync-canon-down",
  "sync-canon-up",
  "refine-project-context",
  "apply-format",
  "describe-asset",
  "link-asset-refs",
  "find-asset-usage",
  "find-asset-duplicates",
  "organize-media",
  "generate-image",
  "generate-video",
  "generate-music",
  "generate-voice",
  "validate-prompt",
  "validate-scene",
  "audit-durations",
  "full-audit",
  "read-file",
  "search-project",
  "explain",
  "navigate",
  "remember",
  "forget",
  "unclear",
  "open",
];

test("every classifier IntentId has a prefetch bundle OR is in INTENT_HINT_SKIP", () => {
  const bundleIds = new Set(prefetch.BUNDLE_INTENT_IDS);
  const missing = CLASSIFIER_INTENT_IDS.filter(
    (id) => !bundleIds.has(id) && !INTENT_HINT_SKIP.has(id),
  );
  assert.deepEqual(
    missing,
    [],
    `Intent(s) classified without bundle or skip — the agent will get a dead 'Recommended first tool: prefetch_context(...)' hint and waste a tool call each turn: ${missing.join(", ")}`,
  );
});

test("no intent appears in both BUNDLES and INTENT_HINT_SKIP", () => {
  const bundleIds = new Set(prefetch.BUNDLE_INTENT_IDS);
  const overlap = [...INTENT_HINT_SKIP].filter((id) => bundleIds.has(id));
  assert.deepEqual(
    overlap,
    [],
    `Intents in both sets — the bundle will never be used: ${overlap.join(", ")}`,
  );
});

test("CLASSIFIER_INTENT_IDS mirror matches the TS source ALL_INTENT_IDS", () => {
  const tsPath = path.resolve(__dirname, "..", "..", "src", "lib", "intent-classifier.ts");
  const raw = fs.readFileSync(tsPath, "utf8");
  const match = raw.match(/export const ALL_INTENT_IDS = \[([\s\S]*?)\] as const/);
  assert.ok(match, "ALL_INTENT_IDS export not found in intent-classifier.ts");
  const ids = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    ids.sort(),
    [...CLASSIFIER_INTENT_IDS].sort(),
    "Drift: CLASSIFIER_INTENT_IDS in this test vs ALL_INTENT_IDS in intent-classifier.ts",
  );
});
