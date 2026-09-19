const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const reviewDesk = require("../review-desk.cjs");

async function withTempRoot(fn) {
  const previousRoot = process.env.ANVIL_REVIEW_ROOT;
  const previousDataRoot = process.env.ANVIL_REVIEW_DATA_ROOT;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anvil-review-desk-"));
  process.env.ANVIL_REVIEW_ROOT = root;
  process.env.ANVIL_REVIEW_DATA_ROOT = path.join(root, ".standalone-review");
  try {
    await fn(root);
  } finally {
    if (previousRoot === undefined) {
      delete process.env.ANVIL_REVIEW_ROOT;
    } else {
      process.env.ANVIL_REVIEW_ROOT = previousRoot;
    }
    if (previousDataRoot === undefined) {
      delete process.env.ANVIL_REVIEW_DATA_ROOT;
    } else {
      process.env.ANVIL_REVIEW_DATA_ROOT = previousDataRoot;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("Review Desk lists safe repo files and keeps project docs out of the review surface", async () => {
  await withTempRoot(async (root) => {
    const projectDir = path.join(root, "sample-project");
    await fs.mkdir(path.join(root, "docs"), { recursive: true });
    await fs.mkdir(path.join(root, "apps/desktop/src"), { recursive: true });
    await fs.mkdir(path.join(projectDir, "story"), { recursive: true });
    await fs.writeFile(path.join(root, "docs/launch-plan.md"), "# Launch\n");
    await fs.writeFile(path.join(root, "apps/desktop/src/App.tsx"), "export const app = true;\n");
    await fs.writeFile(path.join(root, ".env"), "SECRET=1\n");
    await fs.writeFile(path.join(projectDir, "story/world-bible.md"), "# World\n");

    const result = await reviewDesk.listReviewFiles(projectDir);
    const productDocs = result.groups.find((group) => group.id === "product-docs");
    const desktopCore = result.groups.find((group) => group.id === "desktop-core");
    const projectContext = result.groups.find((group) => group.id === "project-context");

    assert.ok(productDocs.files.some((file) => file.path === "docs/launch-plan.md"));
    assert.ok(desktopCore.files.some((file) => file.path === "apps/desktop/src/App.tsx"));
    assert.equal(projectContext, undefined);
    assert.ok(!result.groups.flatMap((group) => group.files).some((file) => file.path === "story/world-bible.md"));
    assert.ok(!result.groups.flatMap((group) => group.files).some((file) => file.path === ".env"));
  });
});

test("Review Desk reads and writes allowed files only", async () => {
  await withTempRoot(async (root) => {
    const targetPath = path.join(root, "docs/review.md");
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, "old\n");

    const initial = await reviewDesk.readReviewFile("", { scope: "repo", path: "docs/review.md" });
    assert.equal(initial.content, "old\n");

    await reviewDesk.writeReviewFile("", { scope: "repo", path: "docs/review.md" }, "new\n");
    assert.equal(await fs.readFile(targetPath, "utf8"), "new\n");

    await assert.rejects(
      () => reviewDesk.readReviewFile("", { scope: "repo", path: ".env" }),
      /allowed text files/,
    );
  });
});

test("Review Desk appends project review notes", async () => {
  await withTempRoot(async (root) => {
    const projectDir = path.join(root, "sample-project");
    const result = await reviewDesk.appendReviewNote(projectDir, "Keep magic docs internal.");

    assert.equal(result.target.scope, "review");
    assert.ok(!result.target.path.startsWith("../"));
    await assert.rejects(() => fs.stat(path.join(projectDir, ".forge/review-notes.md")));
    const notes = await fs.readFile(path.join(process.env.ANVIL_REVIEW_DATA_ROOT, result.target.path), "utf8");
    assert.match(notes, /## \d{4}-\d{2}-\d{2}T/);
    assert.match(notes, /Keep magic docs internal\./);
  });
});

test("Review Desk blocks path traversal and sensitive names", () => {
  assert.equal(reviewDesk.isAllowedReviewPath("docs/plan.md"), true);
  assert.equal(reviewDesk.isAllowedReviewPath("../docs/plan.md"), false);
  assert.equal(reviewDesk.isAllowedReviewPath("docs/token.md"), false);
  assert.equal(reviewDesk.isAllowedReviewPath("node_modules/pkg/index.js"), false);
  assert.equal(reviewDesk.isAllowedReviewPath("assets/reference.png"), false);
});
