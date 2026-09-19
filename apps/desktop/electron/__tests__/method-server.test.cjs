"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const methodServer = require("../method-server.cjs");

test("method server URL resolver appends directive path to site root", () => {
  const prior = process.env.ANVIL_METHOD_DIRECTIVE_URL;
  try {
    delete process.env.ANVIL_METHOD_DIRECTIVE_URL;
    assert.equal(
      methodServer.resolveMethodDirectiveUrl({ methodServerUrl: "https://anvil.example" }),
      "https://anvil.example/api/methods/directive",
    );
  } finally {
    if (prior === undefined) delete process.env.ANVIL_METHOD_DIRECTIVE_URL;
    else process.env.ANVIL_METHOD_DIRECTIVE_URL = prior;
  }
});

test("method server falls back locally when not configured", async () => {
  const priorUrl = process.env.ANVIL_METHOD_DIRECTIVE_URL;
  const priorBase = process.env.ANVIL_METHOD_SERVER_URL;
  const priorServer = process.env.ANVIL_SERVER_URL;
  try {
    delete process.env.ANVIL_METHOD_DIRECTIVE_URL;
    delete process.env.ANVIL_METHOD_SERVER_URL;
    delete process.env.ANVIL_SERVER_URL;
    const result = await methodServer.callMethodDirectiveServer({
      payload: { methodId: "video_sequence" },
    });
    assert.equal(result.access, "basic");
    assert.equal(result.methodId, "video_sequence");
    assert.equal(result.meta.source, "offline");
    assert.match(result.directive, /ANVIL OFFLINE METHOD DIRECTIVE/);
    assert.match(result.directive, /Private production methods are not included/);
    assert.match(result.directive, /Ask before paid operations or publication/);
  } finally {
    if (priorUrl === undefined) delete process.env.ANVIL_METHOD_DIRECTIVE_URL;
    else process.env.ANVIL_METHOD_DIRECTIVE_URL = priorUrl;
    if (priorBase === undefined) delete process.env.ANVIL_METHOD_SERVER_URL;
    else process.env.ANVIL_METHOD_SERVER_URL = priorBase;
    if (priorServer === undefined) delete process.env.ANVIL_SERVER_URL;
    else process.env.ANVIL_SERVER_URL = priorServer;
  }
});

test("method server client sends sanitized request and returns server directive", async () => {
  const priorFetch = global.fetch;
  const priorDirectiveUrl = process.env.ANVIL_METHOD_DIRECTIVE_URL;
  try {
    delete process.env.ANVIL_METHOD_DIRECTIVE_URL;
    let seenUrl = "";
    let seenBody = null;
    global.fetch = async (url, init) => {
      seenUrl = String(url);
      seenBody = JSON.parse(String(init.body || "{}"));
      return new Response(
        JSON.stringify({
          methodId: "scene_prompt_plan",
          version: "test",
          access: "granted",
          tier: "creator",
          phase: "script_prompts",
          directive: "server directive",
          checkpoint: "review_script_prompts",
          expiresAt: new Date().toISOString(),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const result = await methodServer.callMethodDirectiveServer({
      settings: { methodServerUrl: "https://anvil.example", methodServerToken: "secret" },
      payload: {
        methodId: "scene_prompt_plan",
        projectId: "local-project",
        phase: "script_prompts",
      },
    });

    assert.equal(seenUrl, "https://anvil.example/api/methods/directive");
    assert.equal(seenBody.methodId, "scene_prompt_plan");
    assert.equal(seenBody.projectId, "local-project");
    assert.equal(result.meta.source, "server");
    assert.equal(result.directive, "server directive");
  } finally {
    global.fetch = priorFetch;
    if (priorDirectiveUrl === undefined) delete process.env.ANVIL_METHOD_DIRECTIVE_URL;
    else process.env.ANVIL_METHOD_DIRECTIVE_URL = priorDirectiveUrl;
  }
});
