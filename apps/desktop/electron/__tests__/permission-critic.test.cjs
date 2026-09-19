const test = require("node:test");
const assert = require("node:assert/strict");

const { classifyToolCall } = require("../permission-critic.cjs");

test("read-only tools classify as safe", () => {
  for (const name of ["read_file", "list_dir", "search", "read_scene_bundle", "run_heartbeat"]) {
    const verdict = classifyToolCall(name, {});
    assert.equal(verdict.risk, "safe", `${name} should be safe`);
  }
});

test("run_command is always confirm", () => {
  const verdict = classifyToolCall("run_command", { command: "ls" });
  assert.equal(verdict.risk, "confirm");
});

test("write_file on ANVIL.md is confirm", () => {
  const verdict = classifyToolCall("write_file", { path: "ANVIL.md", content: "x" });
  assert.equal(verdict.risk, "confirm");
  assert.ok(verdict.reason.includes("ANVIL.md"));
});

test("write_file on a normal scene path is safe", () => {
  const verdict = classifyToolCall("write_file", { path: "scenes/scene-01-foo.md", content: "x" });
  assert.equal(verdict.risk, "safe");
});

test("write_file on .forge/agent-note.md is safe", () => {
  const verdict = classifyToolCall("write_file", { path: ".forge/agent-note.md", content: "x" });
  assert.equal(verdict.risk, "safe");
});

test("write_file on reserved .forge app state is blocked", () => {
  const verdict = classifyToolCall("write_file", { path: ".forge/project.json", content: "{}" });
  assert.equal(verdict.risk, "blocked");
  assert.ok(verdict.reason.includes(".forge"));
});

test("write_file on a path escaping the project is blocked", () => {
  const verdict = classifyToolCall("write_file", { path: "../escape.md", content: "x" });
  assert.equal(verdict.risk, "blocked");
});

test("rename_paths with >10 items is confirm", () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ from: `a/${i}.png`, to: `b/${i}.png` }));
  const verdict = classifyToolCall("rename_paths", { items });
  assert.equal(verdict.risk, "confirm");
  assert.ok(verdict.reason.includes("bulk"));
});

test("rename_paths escaping the project is blocked", () => {
  const verdict = classifyToolCall("rename_paths", { items: [{ from: "a.png", to: "../b.png" }] });
  assert.equal(verdict.risk, "blocked");
});

test("rename_paths touching .forge app state is blocked", () => {
  const verdict = classifyToolCall("rename_paths", {
    items: [{ from: ".forge/frames/take-1/last.png", to: "assets/library/last.png" }],
  });
  assert.equal(verdict.risk, "blocked");
});

test("create_scene is safe", () => {
  const verdict = classifyToolCall("create_scene", { title: "Rain" });
  assert.equal(verdict.risk, "safe");
});

test("edit_file on .forge/conventions.md is blocked", () => {
  const verdict = classifyToolCall("edit_file", {
    path: ".forge/conventions.md",
    find: "x",
    replace: "y",
  });
  assert.equal(verdict.risk, "blocked");
});

test("unknown tool defaults to confirm", () => {
  const verdict = classifyToolCall("unknown_tool_xyz", {});
  assert.equal(verdict.risk, "confirm");
});

test("missing tool name is blocked", () => {
  const verdict = classifyToolCall("", {});
  assert.equal(verdict.risk, "blocked");
});

test("every registered tool has an explicit classifier verdict (no silent confirm-drift)", () => {
  const { listTools } = require("../tools.cjs");
  const unknown = listTools()
    .map((tool) => tool.name)
    .filter((name) => classifyToolCall(name, {}).reason.includes("not in the classifier"));
  assert.deepEqual(unknown, [], `classifier is missing verdicts for: ${unknown.join(", ")}`);
});

test("every registered tool resolves to a phase verb", () => {
  // Pre-fix: a hand-curated TOOL_TO_PHASE map; this test caught any
  // newly-registered tool that forgot an entry. Post-fix: phases are
  // derived from the tool name's verb prefix with a fallback to
  // "thinking", so every tool resolves to *something*. The test now
  // verifies that nothing falls through to a missing PHASES entry
  // (e.g., a typo in phaseForTool's id assignment).
  const { listTools } = require("../tools.cjs");
  const { phaseForTool, PHASES } = require("../agent-phases.cjs");
  const broken = listTools()
    .map((tool) => tool.name)
    .filter((name) => {
      const phase = phaseForTool(name);
      return !phase || !phase.id || !(phase.id in PHASES);
    });
  assert.deepEqual(broken, [], `phaseForTool returned bad phase for: ${broken.join(", ")}`);
});

// Worker-forbidden test removed — worker-agent.cjs deleted in the
// 2026-05-04 bloat-cuts pass (spawn_worker / spawn_workers_batch
// tools removed). The destructive-tool list is now enforced by the
// permission-critic risk classifier directly; the test's intent
// (these tools must require confirmation) lives in
// "destructive tools classify as confirm or blocked" above.
