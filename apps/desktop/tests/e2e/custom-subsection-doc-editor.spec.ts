import { expect, test, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const requireCJS = createRequire(import.meta.url);
const { seedFixtureProject } = requireCJS("../fixtures/seed-project.cjs") as {
  seedFixtureProject: () => string;
};

const REPO_ROOT = path.resolve(__dirname, "..", "..");

test("custom Canon markdown docs open in the middle editor pane", async () => {
  const projectDir = seedFixtureProject();
  const subsectionFolder = "custom/character";
  const docPath = `${subsectionFolder}/uit.md`;
  const secondDocPath = `${subsectionFolder}/second.md`;
  let app: ElectronApplication | null = null;

  try {
    fs.mkdirSync(path.join(projectDir, subsectionFolder), { recursive: true });
    fs.writeFileSync(path.join(projectDir, subsectionFolder, "INSTRUCTIONS.md"), "# character\n");
    fs.writeFileSync(path.join(projectDir, docPath), "# uit\n\nExisting canon note.\n");
    fs.writeFileSync(path.join(projectDir, secondDocPath), "# Second\n\nSecond note.\n");

    const projectPath = path.join(projectDir, ".forge", "project.json");
    const project = JSON.parse(fs.readFileSync(projectPath, "utf8"));
    project.customSubsections = [
      {
        id: "custom:character",
        primary: "script",
        name: "character",
        kind: "docs",
        folder: subsectionFolder,
        instructionsPath: `${subsectionFolder}/INSTRUCTIONS.md`,
        fileExtensions: [".md"],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
    fs.writeFileSync(projectPath, JSON.stringify(project, null, 2));

    app = await electron.launch({
      args: [
        path.join(REPO_ROOT, "electron", "main.cjs"),
        `--project-dir=${projectDir}`,
      ],
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ELECTRON_DISABLE_GPU: "1",
      },
    });

    const page: Page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForSelector(".workspace-grid", { timeout: 30_000 });

    await page.locator(".primary-rail .rail-btn[aria-label='Canon']").first().click();
    await page.locator(".script-subrail .script-rail-btn[aria-label='character']").first().click();

    const docRow = page.locator(".item-list-custom-subsection .custom-subsection-nav-row").filter({ hasText: "uit" }).first();
    await expect(docRow).toBeVisible();
    await docRow.click();

    await expect(page.locator(".custom-subsection-doc-markdown")).toBeVisible();
    await expect(page.locator(".custom-subsection-instructions")).toHaveCount(0);
    await expect(page.locator(".editor-pane-custom-subsection .editor-head-actions button")).toHaveCount(0);
    await expect(page.locator(".custom-subsection-doc-markdown .cm-content")).toContainText("Existing canon note");

    await page.locator(".custom-subsection-doc-markdown .cm-content").click();
    await page.keyboard.type("\nMore detail.");
    await expect
      .poll(() => fs.readFileSync(path.join(projectDir, docPath), "utf8"))
      .toContain("More detail.");

    await page.locator(".custom-subsection-doc-markdown .cm-content").click();
    await page.keyboard.type("\nSaved before switching.");
    const secondDocRow = page.locator(".item-list-custom-subsection .custom-subsection-nav-row").filter({ hasText: "second" }).first();
    await secondDocRow.click();
    await expect(page.locator(".custom-subsection-doc-markdown .cm-content")).toContainText("Second note");
    await expect
      .poll(() => fs.readFileSync(path.join(projectDir, docPath), "utf8"))
      .toContain("Saved before switching.");

    const titleInput = page.locator("input[name='custom-doc-title']").first();
    await titleInput.fill("renamed second");
    await titleInput.press("Enter");
    await expect
      .poll(() => fs.existsSync(path.join(projectDir, subsectionFolder, "renamed-second.md")))
      .toBeTruthy();

    await page.locator(".custom-subsection-name-add").click();
    await expect(titleInput).toHaveValue("Untitled", { timeout: 5_000 });
    await expect
      .poll(() => fs.existsSync(path.join(projectDir, subsectionFolder, "untitled.md")))
      .toBeTruthy();
  } finally {
    if (app) await app.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
