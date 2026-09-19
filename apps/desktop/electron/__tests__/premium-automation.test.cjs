"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const premiumAutomation = require("../premium-automation.cjs");
const { runTool } = require("../system/tools/builtins.cjs");

async function makeProject() {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "anvil-premium-"));
  await fs.mkdir(path.join(projectDir, ".forge"), { recursive: true });
  return projectDir;
}

async function rmProject(projectDir) {
  await fs.rm(projectDir, { recursive: true, force: true });
}

test("premium automation stays locked by default", async () => {
  const projectDir = await makeProject();
  try {
    delete process.env[premiumAutomation.PREMIUM_AUTOMATION_ENV];
    const scaffold = await premiumAutomation.ensurePremiumAutomationScaffold(projectDir);
    assert.equal(scaffold.enabled, false);

    const listed = await premiumAutomation.listPremiumAutomationSkills(projectDir);
    assert.equal(listed.locked, true);
    assert.equal(listed.count, 0);

    await assert.rejects(
      () => fs.access(path.join(projectDir, premiumAutomation.PREMIUM_SKILLS_DIR)),
      /ENOENT/,
    );
  } finally {
    await rmProject(projectDir);
  }
});

test("premium automation stays server-side when enabled by env", async () => {
  const projectDir = await makeProject();
  const prior = process.env[premiumAutomation.PREMIUM_AUTOMATION_ENV];
  try {
    process.env[premiumAutomation.PREMIUM_AUTOMATION_ENV] = "1";
    const scaffold = await premiumAutomation.ensurePremiumAutomationScaffold(projectDir);
    assert.equal(scaffold.enabled, true);
    assert.equal(scaffold.seeded, false);
    assert.equal(scaffold.serverSide, true);

    const listed = await premiumAutomation.listPremiumAutomationSkills(projectDir);
    assert.equal(listed.locked, true);
    assert.equal(listed.enabled, true);
    assert.equal(listed.serverSide, true);
    assert.equal(listed.count, 0);
    assert.deepEqual(listed.skills, []);

    const visual = await premiumAutomation.readPremiumAutomationSkill(projectDir, "visual-continuity-lab");
    assert.equal(visual.locked, true);
    assert.equal(visual.enabled, true);
    assert.equal(visual.serverSide, true);
    assert.equal(visual.name, "visual-continuity-lab");
    assert.equal(Object.hasOwn(visual, "content"), false);

    await assert.rejects(
      () => fs.access(path.join(projectDir, premiumAutomation.PREMIUM_SKILLS_DIR)),
      /ENOENT/,
    );
  } finally {
    if (prior === undefined) delete process.env[premiumAutomation.PREMIUM_AUTOMATION_ENV];
    else process.env[premiumAutomation.PREMIUM_AUTOMATION_ENV] = prior;
    await rmProject(projectDir);
  }
});

test("premium automation entitlement reports server-side lock through tools", async () => {
  const projectDir = await makeProject();
  try {
    delete process.env[premiumAutomation.PREMIUM_AUTOMATION_ENV];
    await fs.writeFile(
      path.join(projectDir, ".forge", "project.json"),
      JSON.stringify({ settings: { entitlements: { premiumAutomation: true } } }),
      "utf8",
    );

    const listed = await runTool(
      "list_premium_automation_skills",
      {},
      { projectDir },
    );
    assert.equal(listed.locked, true);
    assert.equal(listed.enabled, true);
    assert.equal(listed.serverSide, true);
    assert.equal(listed.requires, "protectedAnvilServer");
    assert.deepEqual(listed.skills, []);

    const doc = await runTool(
      "read_premium_automation_skill",
      { name: "film-render-runner" },
      { projectDir },
    );
    assert.equal(doc.locked, true);
    assert.equal(doc.enabled, true);
    assert.equal(doc.serverSide, true);
    assert.equal(doc.requires, "protectedAnvilServer");
    assert.equal(doc.name, "film-render-runner");
    assert.equal(Object.hasOwn(doc, "content"), false);
  } finally {
    await rmProject(projectDir);
  }
});
