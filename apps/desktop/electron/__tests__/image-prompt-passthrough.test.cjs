const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const evolink = require("../evolink.cjs");
const registerEvolinkGenTools = require("../system/tools/evolink-gen.cjs");

// Exercise the tool with an offline provider. Destination selection must not
// rewrite the user's prompt or choose a different image size.
test("generate_image preserves user prompt and size for every image destination", async (t) => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "anvil-image-public-"));
  t.after(() => fs.rm(projectDir, { recursive: true, force: true }));
  const tools = new Map();
  registerEvolinkGenTools({
    registerTool: (name, tool) => tools.set(name, tool),
    resolveInside: (root, relative) => path.join(root, relative),
    slugifyName: () => "sample",
    readProjectMetadata: async () => ({}),
    writeProjectMetadata: async () => {},
  });
  let captured;
  t.mock.method(evolink, "createImageTask", async (payload) => {
    captured = payload;
    return { id: "offline-task" };
  });
  t.mock.method(evolink, "waitForTask", async () => ({}));
  t.mock.method(evolink, "extractResultUrls", () => ["https://example.invalid/sample.png"]);
  t.mock.method(evolink, "downloadResult", async (_url, destination) => {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, "offline image fixture");
    return { bytes: 21 };
  });

  for (const assetSection of ["characters", "locations", "props", "keyframes", "library", "inbox"]) {
    for (const size of ["auto", "4:5"]) {
      const prompt = "A colorful paper kite above a grassy field.";
      const result = await tools.get("generate_image").run(
        { prompt, assetSection, size, quality: "1K" },
        { projectDir, settings: { evolinkApiKey: "offline-test-placeholder" } },
      );
      assert.equal(captured.prompt, prompt, assetSection);
      assert.equal(captured.size, size, assetSection);
      assert.equal(captured.quality, "1K");
      assert.equal(result.ok, true);
      assert.equal(result.intentSection, assetSection);
      assert.equal(result.isolationEnforced, null);
      assert.equal(result.saved.length, 1);
      await fs.access(path.join(projectDir, result.saved[0].path));
    }
  }
});
