"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const evolink = require("../evolink.cjs");
const { runAgentLoop } = require("../agent-loop.cjs");

// ---------------------------------------------------------------------------
// classifyHttpStatus — coarse status → error-kind buckets the UI uses to
// pick a CTA. Boundary cases matter: 401/403 vs 402 vs 429 must NOT all
// collapse into "auth", because the user remediation differs.
// ---------------------------------------------------------------------------

test("classifyHttpStatus buckets each status family correctly", () => {
  assert.equal(evolink.classifyHttpStatus(401), "auth");
  assert.equal(evolink.classifyHttpStatus(403), "auth");
  assert.equal(evolink.classifyHttpStatus(402), "quota");
  assert.equal(evolink.classifyHttpStatus(429), "rate-limit");
  assert.equal(evolink.classifyHttpStatus(400), "payload");
  assert.equal(evolink.classifyHttpStatus(404), "payload");
  assert.equal(evolink.classifyHttpStatus(500), "server");
  assert.equal(evolink.classifyHttpStatus(502), "server");
  assert.equal(evolink.classifyHttpStatus(0), "server");
});

// ---------------------------------------------------------------------------
// attachErrorMeta — decorates an Error in place with kind/status/provider
// without clobbering already-set fields. The "don't clobber" rule lets a
// throw-site classify first and the wrapper add provider info second.
// ---------------------------------------------------------------------------

test("attachErrorMeta sets kind/status/provider once", () => {
  const err = new Error("boom");
  evolink.attachErrorMeta(err, { kind: "timeout", status: 0, provider: "evolink" });
  assert.equal(err.kind, "timeout");
  assert.equal(err.status, 0);
  assert.equal(err.provider, "evolink");
});

test("attachErrorMeta does not clobber preset fields", () => {
  const err = new Error("boom");
  err.kind = "auth";
  err.status = 401;
  err.provider = "evolink";
  evolink.attachErrorMeta(err, { kind: "server", status: 500, provider: "openai" });
  assert.equal(err.kind, "auth", "kind preserved");
  assert.equal(err.status, 401, "status preserved");
  assert.equal(err.provider, "evolink", "provider preserved");
});

test("attachErrorMeta tolerates non-Error inputs", () => {
  assert.doesNotThrow(() => evolink.attachErrorMeta(null, { kind: "auth" }));
  assert.doesNotThrow(() => evolink.attachErrorMeta(undefined, { kind: "auth" }));
});

// ---------------------------------------------------------------------------
// agent-loop preserves errorType / status / provider from a thrown Error
// onto the tool:result envelope so ActivityFeed can render the right CTA.
// Without this, the envelope only carries `error: <message>` and the UI
// can't classify failures (regression history: silent ".catch(()=>{})"
// that hid generation errors entirely).
// ---------------------------------------------------------------------------

test("agent-loop preserves errorType through tool failure envelope", async () => {
  const events = [];
  let toolCallCount = 0;

  const fakeRunTool = async (name) => {
    if (name !== "generate_image") throw new Error(`unexpected tool: ${name}`);
    toolCallCount += 1;
    const err = new Error("EvoLink POST /v1/images/generations failed (401): unauthorized");
    err.kind = "auth";
    err.status = 401;
    err.provider = "evolink";
    throw err;
  };

  // Two-turn fake LLM: turn 1 calls generate_image, turn 2 emits done with
  // a reply (terminal). agent-loop's parseAgentResponse expects JSON in
  // either ```json fences or raw, with `tool_calls` or `done`.
  let llmTurn = 0;
  const fakeSendToModel = async () => {
    llmTurn += 1;
    if (llmTurn === 1) {
      return {
        text: JSON.stringify({
          tool_calls: [{ id: "tc1", name: "generate_image", args: { prompt: "x" } }],
        }),
        usage: null,
        meta: null,
      };
    }
    return {
      text: JSON.stringify({ reply: "Done.", done: true }),
      usage: null,
      meta: null,
    };
  };

  const result = await runAgentLoop({
    sendToModel: fakeSendToModel,
    runTool: fakeRunTool,
    userMessage: "make an image",
    projectDir: "/tmp/anvil-test",
    maxTurns: 4,
    onEvent: (event) => events.push(event),
  });

  assert.equal(toolCallCount, 1);
  assert.equal(result.terminated, "done");

  const failureEvent = events.find(
    (e) => e.type === "tool:result" && e.result && e.result.ok === false,
  );
  assert.ok(failureEvent, "expected a failed tool:result event");
  assert.equal(failureEvent.result.errorType, "auth", "errorType preserved");
  assert.equal(failureEvent.result.errorStatus, 401, "errorStatus preserved");
  assert.equal(failureEvent.result.errorProvider, "evolink", "errorProvider preserved");
  assert.match(failureEvent.result.error, /401/);
});

test("agent-loop falls back gracefully when error has no kind", async () => {
  const events = [];
  const fakeRunTool = async () => {
    throw new Error("plain error");
  };
  let llmTurn = 0;
  const fakeSendToModel = async () => {
    llmTurn += 1;
    if (llmTurn === 1) {
      return {
        text: JSON.stringify({
          tool_calls: [{ id: "tc1", name: "generate_video", args: {} }],
        }),
        usage: null,
        meta: null,
      };
    }
    return { text: JSON.stringify({ reply: "ok", done: true }), usage: null, meta: null };
  };

  await runAgentLoop({
    sendToModel: fakeSendToModel,
    runTool: fakeRunTool,
    userMessage: "x",
    projectDir: "/tmp/anvil-test",
    maxTurns: 4,
    onEvent: (event) => events.push(event),
  });

  const failureEvent = events.find(
    (e) => e.type === "tool:result" && e.result && e.result.ok === false,
  );
  assert.ok(failureEvent);
  assert.equal(failureEvent.result.errorType, undefined, "errorType absent on unclassified throws");
  assert.equal(failureEvent.result.error, "plain error");
});
