const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../../../..");

test("public source excludes private recipe and hidden protocol documents", () => {
  const privatePaths = [
    "docs/archive",
    "docs/agent-handoffs",
    "archive",
    "CLAUDE.md",
    "docs/archive/superpowers/specs/2026-05-04-scope-intake-design.md",
    "src/server/anvil/method-library/premium-skills",
    "apps/desktop/electron/defaults/premium-skills",
    "docs/archive/superpowers/plans/2026-05-04-scope-intake.md",
    "docs/archive/feedback-2026-04-25",
    "docs/prompt-knowledge-roadmap.md",
    "docs/archive/free-local-release-standby-2026-05-05/premium-automation.md",
    ...["agent-manual.md", "intake-protocol.md", "prompt-protocol.md"].map(
      (name) => `apps/desktop/electron/defaults/skills/${name}`,
    ),
  ];
  for (const relative of privatePaths) {
    const absolute = path.join(root, relative);
    assert.equal(fs.existsSync(absolute), false, `Private content present: ${relative}`);
  }
});
