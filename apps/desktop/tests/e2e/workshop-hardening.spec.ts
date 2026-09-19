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

test("Workshop opens with malformed media and timeline records", async () => {
  const projectDir = seedFixtureProject();
  let app: ElectronApplication | null = null;

  try {
    const projectPath = path.join(projectDir, ".forge", "project.json");
    const project = JSON.parse(fs.readFileSync(projectPath, "utf8"));
    project.videos = [
      null,
      { id: "video-missing-path" },
      {
        id: "video-1",
        path: "assets/videos/missing.mp4",
        sceneId: null,
        shotId: null,
        promptId: null,
        takeIndex: 1,
        durationSec: 4,
        generator: "upload",
        generatedAt: new Date().toISOString(),
        note: "Missing media file",
      },
    ];
    project.audio = [
      { id: "audio-no-media", name: "No Media" },
      {
        id: "audio-1",
        name: "Broken Audio",
        media: [null, { id: "audio-media-1", kind: "audio", path: "assets/audio/missing.mp3", label: "Missing" }],
      },
    ];
    project.timeline = [
      null,
      "not-a-clip",
      { id: "clip-1", videoId: "video-1", track: "V9", startSec: 0, orderIndex: 0, enabled: true },
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
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForSelector(".workspace-grid", { timeout: 30_000 });
    await page.locator(".primary-rail .rail-btn[aria-label='Workshop']").first().click();

    await expect(page.locator(".workshop-nle")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".workshop-error-panel")).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  } finally {
    if (app) await app.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
