const test = require("node:test");
const assert = require("node:assert/strict");

// Coverage for the prompt-slim follow-up — verifies:
//   - media tier tools are ABSENT from the preamble body but PRESENT
//     in the lazy "More tools available on demand" pointer
//   - section-format conventions are filtered by classified intent
//     (write-prompt → prompts only; write-scene → script only;
  //     full-audit → current script+prompt docs; describe-asset / explain → none;
//     unclear intent → one-line pointer)
//   - redundant "— 15s hard cap" qualifiers in format headers are gone
//   - narrow-intent frames are meaningfully smaller than wide-intent

const agentLoop = require("../agent-loop.cjs");

// Stand-in toolCatalog — mimic real tool shapes just enough for the
// preamble builder. Names and tiers are what matter.
const FAKE_CATALOG = [
  { name: "read_file", tier: "core", description: "Read a file", args: { path: "str" } },
  { name: "write_file", tier: "edit", description: "Write a file", args: { path: "str", content: "str" } },
  { name: "list_scenes", tier: "domain", description: "List scenes", args: {} },
  { name: "run_command", tier: "shell", description: "Run allowlisted cmd", args: { cmd: "str" } },
  { name: "remember", tier: "meta", description: "Remember a fact", args: { text: "str" } },
  { name: "generate_image", tier: "media", description: "Make an image", args: { prompt: "str" } },
  { name: "generate_video", tier: "media", description: "Make a video", args: { prompt: "str" } },
];

const FULL_SECTION_CONV = {
  script: "Master Script format rules: scenes, beat coverage, shot coverage, clip plan.",
  beats: "Legacy beat format rules.",
  shots: "Legacy shot format rules.",
  prompts: "Prompt format rules: SS.NN — <title>, model-ready, 5-15s.",
};

test("preamble body has no media-tier tool descriptions", () => {
  const preamble = agentLoop.buildStablePreamble(FAKE_CATALOG);
  // Full multi-line description text should not appear anywhere in the
  // body when the tool is lazy-tiered.
  assert.ok(!/- generate_image\(prompt: str\) — Make an image/.test(preamble));
  assert.ok(!/- generate_video\(prompt: str\) — Make a video/.test(preamble));
});

test("preamble includes the lazy-tier pointer line with media tools listed", () => {
  const preamble = agentLoop.buildStablePreamble(FAKE_CATALOG);
  assert.ok(
    /More tools available on demand/.test(preamble),
    "lazy pointer line present",
  );
  assert.ok(/generate_image/.test(preamble), "generate_image listed in pointer");
  assert.ok(/generate_video/.test(preamble), "generate_video listed in pointer");
});

function dynamicFrame(intent) {
  return agentLoop.buildDynamicFrame({
    projectName: "test",
    projectDir: "/tmp/test",
    sectionConventions: FULL_SECTION_CONV,
    intent,
  });
}

test("write-prompt injects prompt-format only", () => {
  const frame = dynamicFrame("write-prompt");
  assert.ok(/Prompt format conventions/.test(frame));
  assert.ok(!/Master Script format conventions/.test(frame));
  assert.ok(!/Legacy shot format conventions/.test(frame));
});

test("write-scene injects scene-format only", () => {
  const frame = dynamicFrame("write-scene");
  assert.ok(/Master Script format conventions/.test(frame));
  assert.ok(!/Legacy shot format conventions/.test(frame));
  assert.ok(!/Prompt format conventions/.test(frame));
});

test("decompose-scene injects script + prompt docs", () => {
  const frame = dynamicFrame("decompose-scene");
  assert.ok(/Master Script format conventions/.test(frame));
  assert.ok(/Prompt format conventions/.test(frame));
  assert.ok(!/Legacy shot format conventions/.test(frame));
});

test("full-audit injects current script + prompt docs only", () => {
  const frame = dynamicFrame("full-audit");
  assert.ok(/Master Script format conventions/.test(frame));
  assert.ok(/Prompt format conventions/.test(frame));
  assert.ok(!/Legacy beat format conventions/.test(frame));
  assert.ok(!/Legacy shot format conventions/.test(frame));
});

test("describe-asset injects zero format docs and no pointer", () => {
  const frame = dynamicFrame("describe-asset");
  assert.ok(!/Master Script format conventions/.test(frame));
  assert.ok(!/Legacy shot format conventions/.test(frame));
  assert.ok(!/Prompt format conventions/.test(frame));
  assert.ok(!/Section format docs on disk/.test(frame));
});

test("explain / navigate / read-file inject zero format docs", () => {
  for (const intent of ["explain", "navigate", "read-file", "search-project"]) {
    const frame = dynamicFrame(intent);
    assert.ok(
      !/Prompt format conventions/.test(frame),
      `${intent} should not include prompt-format`,
    );
    assert.ok(
      !/Master Script format conventions/.test(frame),
      `${intent} should not include scene-format`,
    );
    assert.ok(
      !/Legacy shot format conventions/.test(frame),
      `${intent} should not include shot-format`,
    );
  }
});

test("unclear / null intent gets a one-line pointer instead of blocks", () => {
  const frameNull = dynamicFrame(null);
  const frameUnclear = dynamicFrame("unclear");
  for (const frame of [frameNull, frameUnclear]) {
    assert.ok(/Section format docs on disk/.test(frame), "pointer present");
    assert.ok(!/Master Script format conventions \(\.forge\/scene-format\.md\):/.test(frame));
    assert.ok(!/Prompt format conventions \(\.forge\/prompt-format\.md\):/.test(frame));
  }
});

test("media-generation intents inject zero format docs", () => {
  for (const intent of ["generate-image", "generate-video", "generate-music", "generate-voice"]) {
    const frame = dynamicFrame(intent);
    assert.ok(
      !/Prompt format conventions/.test(frame),
      `${intent} should not include prompt-format`,
    );
    assert.ok(!/Section format docs on disk/.test(frame), `${intent} should not emit pointer`);
  }
});

test("format-conv headers no longer include the '15s hard cap' qualifier", () => {
  const frame = dynamicFrame("full-audit");
  assert.ok(!/15s hard cap/.test(frame), "redundant '15s hard cap' header noise removed");
  // But the classic header prefix is still there so the agent knows
  // which file each block came from.
  assert.ok(/Master Script format conventions \(\.forge\/scene-format\.md\):/.test(frame));
  assert.ok(/Prompt format conventions \(\.forge\/prompt-format\.md\):/.test(frame));
});

test("narrow-intent frame is meaningfully smaller than wide-intent frame", () => {
  const narrow = dynamicFrame("describe-asset").length;
  const wide = dynamicFrame("full-audit").length;
  // Current workflow injects only Master Script + Prompt docs, so the wide
  // frame should still be meaningfully bigger without carrying legacy
  // beat/shot bloat.
  assert.ok(wide - narrow > 180, `wide (${wide}) should be >180 bigger than narrow (${narrow})`);
});

test("empty sectionConventions produces no format blocks regardless of intent", () => {
  const frame = agentLoop.buildDynamicFrame({
    projectName: "test",
    projectDir: "/tmp/test",
    sectionConventions: {},
    intent: "full-audit",
  });
  assert.ok(!/Master Script format conventions/.test(frame));
  assert.ok(!/Section format docs on disk/.test(frame));
});
