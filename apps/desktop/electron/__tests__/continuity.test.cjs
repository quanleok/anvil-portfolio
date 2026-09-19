const test = require("node:test");
const assert = require("node:assert/strict");

const { readPromptPrevId, prevIdToMeta } = require("../continuity.cjs");

test("readPromptPrevId returns prevPromptId when set", () => {
  assert.equal(readPromptPrevId({ prevPromptId: "p1" }), "p1");
  assert.equal(readPromptPrevId({ prevPromptId: "  p2  " }), "p2");
});

test("readPromptPrevId falls back to legacy continuousFrom for older projects", () => {
  assert.equal(readPromptPrevId({ continuousFrom: "p-old" }), "p-old");
});

test("readPromptPrevId tolerates common agent aliases", () => {
  assert.equal(readPromptPrevId({ previousPrompt: "p-prev" }), "p-prev");
  assert.equal(readPromptPrevId({ prevPrompt: "p-prev-2" }), "p-prev-2");
  assert.equal(readPromptPrevId({ continuesFrom: "p-prev-3" }), "p-prev-3");
});

test("readPromptPrevId falls back to structured continuity.prevId from older projects", () => {
  assert.equal(
    readPromptPrevId({ continuity: { prevId: "p-struct", kind: "motion" } }),
    "p-struct",
  );
});

test("readPromptPrevId returns null when no predecessor is encoded", () => {
  assert.equal(readPromptPrevId({}), null);
  assert.equal(readPromptPrevId(null), null);
  assert.equal(readPromptPrevId({ prevPromptId: "" }), null);
});

test("prevIdToMeta clears legacy continuousFrom alongside writing prevPromptId", () => {
  assert.deepEqual(prevIdToMeta("p1"), { prevPromptId: "p1", continuousFrom: "" });
  assert.deepEqual(prevIdToMeta(null), { prevPromptId: "", continuousFrom: "" });
  assert.deepEqual(prevIdToMeta(""), { prevPromptId: "", continuousFrom: "" });
});
