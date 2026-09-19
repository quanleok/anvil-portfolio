import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDialogueScaffold,
  dialogueHasWrittenLines,
  syncEmptyDialogueScaffold,
} from "../../src/lib/dialogue.ts";

const scene = (id, title) => ({
  id,
  kind: "scene",
  title,
});

test("dialogueHasWrittenLines treats heading-only scaffold as empty", () => {
  const scaffold = [
    "## 01 — Forgotten Workshop",
    "",
    "## 02 — Tactile Interior Drift",
  ].join("\n");

  assert.equal(dialogueHasWrittenLines(scaffold), false);
});

test("dialogueHasWrittenLines treats actual dialogue lines as written content", () => {
  const content = [
    "## 01 — Forgotten Workshop",
    "- Kid (whisper): \"Hello?\"",
  ].join("\n");

  assert.equal(dialogueHasWrittenLines(content), true);
});

test("syncEmptyDialogueScaffold refreshes heading-only dialogue when scenes change", () => {
  const initialScenes = [scene("scene-1", "01 — Forgotten Workshop")];
  const expandedScenes = [
    scene("scene-1", "01 — Forgotten Workshop"),
    scene("scene-2", "02 — Tactile Interior Drift"),
  ];

  const scaffold = buildDialogueScaffold(initialScenes);
  const refreshed = syncEmptyDialogueScaffold(scaffold, expandedScenes);

  assert.match(refreshed, /02 — Tactile Interior Drift/);
});

test("syncEmptyDialogueScaffold preserves authored dialogue even when scenes change", () => {
  const expandedScenes = [
    scene("scene-1", "01 — Forgotten Workshop"),
    scene("scene-2", "02 — Tactile Interior Drift"),
  ];
  const authored = [
    "## 01 — Forgotten Workshop",
    "- Kid (whisper): \"Hello?\"",
  ].join("\n");

  const preserved = syncEmptyDialogueScaffold(authored, expandedScenes);

  assert.equal(preserved, authored);
  assert.doesNotMatch(preserved, /02 — Tactile Interior Drift/);
});
