// Simulates ~10 minutes of an AI filmmaker exploring Anvil for the
// first time. Captures one screenshot per discrete action so we can
// review the journey end-to-end and write honest UX feedback.

import { test, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import * as path from "node:path";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const requireCJS = createRequire(import.meta.url);
const { seedFixtureProject } = requireCJS("../fixtures/seed-project.cjs") as {
  seedFixtureProject: () => string;
};

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCREENSHOT_DIR = path.resolve(__dirname, "..", "screenshots", "journey");
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

let app: ElectronApplication;
let page: Page;
let projectDir: string;

test.beforeAll(async () => {
  projectDir = seedFixtureProject();
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
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector(".workspace-grid", { timeout: 30_000 });
  await page.waitForSelector(".launch-screen", { state: "detached", timeout: 15_000 }).catch(() => {});
  await page.waitForSelector(".item-list-section", { timeout: 15_000 });
});

test.afterAll(async () => {
  if (app) await app.close();
  if (projectDir && fs.existsSync(projectDir)) {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

async function shot(step: string) {
  const file = path.join(SCREENSHOT_DIR, `${step}.png`);
  await page.screenshot({ path: file, fullPage: false });
}

async function pause(ms = 300) {
  await page.waitForTimeout(ms);
}

test("first impression — what does the app look like on open?", async () => {
  await shot("01-first-impression");
});

test("read the welcome / ANVIL.md context doc", async () => {
  // Click the "Project context" row in the items list (default Context primary).
  const projectCtx = page.locator(".item-list .item-row").filter({ hasText: /Project context/i }).first();
  if (await projectCtx.count()) {
    await projectCtx.click();
    await pause();
    await shot("02-project-context-doc");
  }
});

test("explore the Canon (script) tree", async () => {
  await page.locator(".primary-rail .rail-btn[aria-label='Canon']").first().click();
  await pause();
  await shot("03-canon-overview");
  // Click into the master script.
  const master = page.locator(".item-list .item-row").filter({ hasText: /Master Script/ }).first();
  await master.click();
  await pause();
  await shot("04-master-script-view");
  // Click into the scene.
  const scene = page.locator(".item-list .item-row").filter({ hasText: /Cold open/ }).first();
  await scene.click();
  await pause();
  await shot("05-scene-view");
  // Click into the shot.
  const shot1 = page.locator(".item-list .item-row").filter({ hasText: /Wide/ }).first();
  if (await shot1.count()) {
    await shot1.click();
    await pause();
    await shot("06-shot-view");
  }
});

test("try to type a scene description", async () => {
  // Already on the scene from previous test.
  const scene = page.locator(".item-list .item-row").filter({ hasText: /Cold open/ }).first();
  await scene.click();
  await pause();
  // Find the editor textarea.
  const editor = page.locator(".editor-pane textarea, .editor-pane .cm-content").first();
  if (await editor.count()) {
    await editor.click();
    await page.keyboard.type("\nThe lights go down. A figure approaches the centre of the empty arena.");
    await pause();
    await shot("07-typed-scene-content");
  }
});

test("explore Assets — characters", async () => {
  await page.locator(".primary-rail .rail-btn[aria-label='Assets']").first().click();
  await pause();
  await shot("08-assets-overview");
  // Click into the character.
  const character = page.locator(".item-list .item-row").filter({ hasText: /Audit Hero/ }).first();
  if (await character.count()) {
    await character.click();
    await pause();
    await shot("09-character-detail");
  }
});

test("attempt to generate something — what does the user see?", async () => {
  // Look for an "Add Media" or similar generate button.
  const addMedia = page.locator(".editor-pane button").filter({ hasText: /Add Media|Import|Generate/i }).first();
  if (await addMedia.count()) {
    await shot("10-generate-button-visible");
  }
});

test("explore the Workshop — what's a creator supposed to do here?", async () => {
  await page.locator(".primary-rail .rail-btn[aria-label='Workshop']").first().click();
  await pause();
  await shot("11-workshop-empty");
});

test("agent chat — what happens when I send a message?", async () => {
  // Find the chat input (xterm or text input).
  await page.locator(".primary-rail .rail-btn[aria-label='Canon']").first().click();
  await pause();
  await shot("12-back-to-canon");
});

test("settings — what's configurable?", async () => {
  await page.locator(".rail-btn-settings").first().click();
  await page.waitForSelector(".modal-backdrop", { timeout: 3_000 });
  await pause();
  await shot("13-settings-open");
  await page.keyboard.press("Escape");
});

test("project menu — what other actions are available?", async () => {
  await page.locator(".project-title-trigger").first().click();
  await page.waitForSelector(".header-menu-popover", { timeout: 3_000 });
  await pause();
  await shot("14-project-menu");
  await page.keyboard.press("Escape");
});

test("hover over each rail icon — does the tooltip explain what it does?", async () => {
  for (const label of ["Context", "Canon", "Assets", "Workshop"]) {
    const btn = page.locator(`.primary-rail .rail-btn[aria-label='${label}']`).first();
    if (await btn.count()) {
      await btn.hover();
      await pause(180);
      await shot(`16-hover-${label.toLowerCase()}`);
    }
  }
});

test("try resizing rail divider — does the layout adapt?", async () => {
  // Find a column divider.
  const divider = page.locator(".col-divider").first();
  if (await divider.count()) {
    const box = await divider.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 200, box.y + box.height / 2, { steps: 10 });
      await page.mouse.up();
      await pause();
      await shot("17-after-divider-drag");
    }
  }
});

test("final state — what's a creator left with?", async () => {
  await shot("18-final");
});
