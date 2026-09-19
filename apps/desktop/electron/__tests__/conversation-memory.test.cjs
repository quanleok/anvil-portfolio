const test = require("node:test");
const assert = require("node:assert/strict");

const runtime = require("../agent-runtime.cjs");

test("listProviders only exposes supported local agent runtimes", () => {
  const providers = runtime.listProviders();
  assert.deepEqual(
    providers.map((provider) => provider.id),
    ["openclaw", "hermes"],
  );
  assert.equal(providers[0].label, "OpenClaw gateway");
  assert.equal(providers[1].label, "Hermes local agent");
});

test("testAgentConnection rejects hosted agent providers", async () => {
  const result = await runtime.testAgentConnection({
    provider: "anthropic",
    apiKey: "sk-ant-test",
  });
  assert.equal(result.ok, false);
  assert.match(result.error || "", /no longer supported/i);
});

test("callAgentModel rejects hosted agent providers", async () => {
  await assert.rejects(
    runtime.callAgentModel({
      provider: "openai",
      apiKey: "sk-test",
      prompt: "hi",
    }),
    /no longer supported/i,
  );
});

test("OpenClaw gateway infer parser preserves routed provider/model metadata", () => {
  const parsed = runtime.extractOpenClawInferResponse(JSON.stringify({
    ok: true,
    transport: "gateway",
    provider: "claude-cli",
    model: "claude-opus-4-7",
    capability: "forge",
    attempts: 2,
    outputs: [{ text: "{\"reply\":\"done\",\"done\":true}" }],
  }));
  assert.equal(parsed.text, "{\"reply\":\"done\",\"done\":true}");
  assert.deepEqual(parsed.meta, {
    transport: "cli",
    provider: "claude-cli",
    model: "claude-opus-4-7",
    routeTransport: "gateway",
    capability: "forge",
    attempts: 2,
  });
});

test("OpenClaw models status parser extracts default route", () => {
  const parsed = runtime.parseOpenClawModelsStatus(JSON.stringify({
    defaultModel: "claude-cli/claude-opus-4-7",
    resolvedDefault: "openai-codex/gpt-5.4",
  }));
  assert.deepEqual(parsed, {
    defaultModel: "claude-cli/claude-opus-4-7",
    resolvedDefault: "openai-codex/gpt-5.4",
    provider: "openai-codex",
    model: "gpt-5.4",
  });
});
