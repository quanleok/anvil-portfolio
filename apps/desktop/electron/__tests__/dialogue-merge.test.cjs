const test = require("node:test");
const assert = require("node:assert/strict");

const { mergeLegacyDialogueContent } = require("../dialogue-merge.cjs");

test("mergeLegacyDialogueContent fills an empty scaffold section instead of appending duplicate headings", () => {
  const canonical = [
    "## 01 — Forgotten Workshop",
    "",
    "### 01.01 — Door Creak Reveal",
    "",
    "### 01.02 — Tactile Interior Drift",
  ].join("\n");

  const merged = mergeLegacyDialogueContent(canonical, [{
    sceneTitle: "01 — Forgotten Workshop",
    shotTitle: "01.01 — Door Creak Reveal",
    content: "- Kid (whisper): \"Hello?\"",
  }]);

  assert.equal((merged.match(/## 01 — Forgotten Workshop/g) || []).length, 1);
  assert.equal((merged.match(/### 01\.01 — Door Creak Reveal/g) || []).length, 1);
  assert.match(merged, /### 01\.01 — Door Creak Reveal\n\n- Kid \(whisper\): "Hello\?"/);
});

test("mergeLegacyDialogueContent skips empty legacy dialogue blocks", () => {
  const canonical = [
    "## 01 — Forgotten Workshop",
    "",
    "### 01.01 — Door Creak Reveal",
  ].join("\n");

  const merged = mergeLegacyDialogueContent(canonical, [{
    sceneTitle: "02 — First Strike",
    shotTitle: "02.01 — Hand On Hammer",
    content: "",
  }]);

  assert.doesNotMatch(merged, /02 — First Strike/);
  assert.doesNotMatch(merged, /02\.01 — Hand On Hammer/);
});

test("mergeLegacyDialogueContent does not append partial legacy content when the canonical shot already has written lines", () => {
  const canonical = [
    "## 01 — Forgotten Workshop",
    "",
    "### 01.01 — Door Creak Reveal",
    "",
    "- Kid (whisper): \"Hello?\"",
    "- Hammer (hum): \"...\"",
  ].join("\n");

  const merged = mergeLegacyDialogueContent(canonical, [{
    sceneTitle: "01 — Forgotten Workshop",
    shotTitle: "01.01 — Door Creak Reveal",
    content: "- Kid (whisper): \"Hello?\"",
  }]);

  assert.equal((merged.match(/### 01\.01 — Door Creak Reveal/g) || []).length, 1);
  assert.equal((merged.match(/Kid \(whisper\)/g) || []).length, 1);
});

test("mergeLegacyDialogueContent appends missing legacy shot sections with written dialogue", () => {
  const canonical = [
    "## 01 — Forgotten Workshop",
    "",
    "### 01.01 — Door Creak Reveal",
    "",
    "- Kid (whisper): \"Hello?\"",
  ].join("\n");

  const merged = mergeLegacyDialogueContent(canonical, [{
    sceneTitle: "02 — First Strike",
    shotTitle: "02.01 — Hand On Hammer",
    content: "- Hammer (hum): \"...\"",
  }]);

  assert.match(merged, /## 02 — First Strike/);
  assert.match(merged, /### 02\.01 — Hand On Hammer/);
  assert.match(merged, /Hammer \(hum\)/);
});
