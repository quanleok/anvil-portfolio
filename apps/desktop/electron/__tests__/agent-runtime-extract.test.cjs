const test = require("node:test");
const assert = require("node:assert/strict");

const { extractOpenClawInferResponse } = require("../agent-runtime.cjs");

// Regression: gateway envelope with outputs[{text}] used to fall through
// to JSON.stringify(parsed) and leak into the chat as raw envelope JSON.
test("extractOpenClawInferResponse unwraps the gateway outputs[] envelope", () => {
  const envelope = JSON.stringify({
    ok: true,
    capability: "model.run",
    transport: "gateway",
    provider: "openai-codex",
    model: "gpt-5.4",
    attempts: [],
    outputs: [
      {
        text: '{ "reply": "Hi. What do you want to work on?", "done": true }',
        mediaUrl: null,
      },
    ],
  });
  const out = extractOpenClawInferResponse(envelope);
  assert.equal(
    out.text,
    '{ "reply": "Hi. What do you want to work on?", "done": true }',
  );
});

test("extractOpenClawInferResponse joins multi-output text with blank line", () => {
  const envelope = JSON.stringify({
    ok: true,
    outputs: [{ text: "first" }, { text: "second" }],
  });
  assert.equal(extractOpenClawInferResponse(envelope).text, "first\n\nsecond");
});

test("extractOpenClawInferResponse handles legacy top-level text field", () => {
  const envelope = JSON.stringify({ text: "legacy reply" });
  assert.equal(extractOpenClawInferResponse(envelope).text, "legacy reply");
});

test("extractOpenClawInferResponse handles openai-style choices[0].message.content", () => {
  const envelope = JSON.stringify({
    choices: [{ message: { content: "chat reply" } }],
  });
  assert.equal(extractOpenClawInferResponse(envelope).text, "chat reply");
});

test("extractOpenClawInferResponse returns raw string when input isn't JSON", () => {
  assert.equal(extractOpenClawInferResponse("plain text\n").text, "plain text");
});

test("extractOpenClawInferResponse falls back to stringified parse when nothing matches", () => {
  const envelope = JSON.stringify({ weirdShape: true });
  assert.equal(extractOpenClawInferResponse(envelope).text, '{"weirdShape":true}');
});

test("extractOpenClawInferResponse skips empty outputs[].text entries", () => {
  const envelope = JSON.stringify({
    ok: true,
    outputs: [{ text: "" }, { text: "real reply" }],
  });
  assert.equal(extractOpenClawInferResponse(envelope).text, "real reply");
});
