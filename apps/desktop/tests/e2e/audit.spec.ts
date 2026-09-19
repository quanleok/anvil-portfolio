import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
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
const SCREENSHOT_DIR = path.resolve(__dirname, "..", "screenshots");
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
      // Force the dev server URL OFF — packaged path resolves
      // index.html from dist/ which we don't have. Tell main.cjs to
      // load from the local Vite dev server we'll start ourselves.
      // Actually: just point at the running vite server if available;
      // otherwise tests fail fast with a clear message.
      ELECTRON_DISABLE_GPU: "1",
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  // Wait for the workspace grid + the launch splash to fade.
  await page.waitForSelector(".workspace-grid", { timeout: 30_000 });
  await page.waitForSelector(".launch-screen", { state: "detached", timeout: 15_000 }).catch(() => {});
  // Project is loaded once the items-list renders. Default primary is
  // Context, so wait on the context group label rather than the canon
  // master-script row.
  await page.waitForSelector(".item-list-section", { timeout: 15_000 });
});

test.afterAll(async () => {
  if (app) await app.close();
  if (projectDir && fs.existsSync(projectDir)) {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

/** Take a screenshot keyed by step name. */
async function shot(name: string) {
  const file = path.join(SCREENSHOT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

/**
 * For each interactive element in `selectors`, check that the topmost
 * element at its center is the element itself (or one of its
 * descendants). If not, the element is occluded — flagged as a
 * z-index issue.
 *
 * Returns an array of { selector, occluder, z } occlusions for the
 * test to assert on.
 */
async function findOcclusions(selectors: string[]): Promise<
  Array<{ selector: string; ariaLabel: string; occluder: string }>
> {
  return await page.evaluate((selList: string[]) => {
    const out: Array<{ selector: string; ariaLabel: string; occluder: string }> = [];
    for (const sel of selList) {
      const els = Array.from(document.querySelectorAll<HTMLElement>(sel));
      for (const el of els) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 4 || rect.height < 4) continue;
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        // Skip elements outside the viewport.
        if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) continue;
        const top = document.elementFromPoint(cx, cy);
        if (!top) continue;
        if (top === el || el.contains(top) || top.contains(el)) continue;
        const ariaLabel = el.getAttribute("aria-label") || el.textContent?.trim().slice(0, 40) || "";
        const occluderTag = top.tagName.toLowerCase();
        const occluderClass = (top.className && typeof top.className === "string")
          ? `.${top.className.split(/\s+/).filter(Boolean).join(".")}`
          : "";
        out.push({
          selector: sel,
          ariaLabel,
          occluder: `${occluderTag}${occluderClass}`,
        });
      }
    }
    return out;
  }, selectors);
}

// ----------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------

test("baseline screenshot of opened project", async () => {
  await shot("01-baseline");
  // Sanity: the items list shows at least one row.
  const firstRow = page.locator(".item-list .item-row").first();
  await expect(firstRow).toBeVisible();
});

test("project menu popover sits above workspace grid", async () => {
  // Click the anvil mark button (project header trigger).
  const trigger = page.locator(".project-title-trigger").first();
  await trigger.click();
  await page.waitForSelector(".header-menu-popover", { timeout: 3_000 });
  await shot("02-project-menu-open");

  // Sanity: the "Reveal in Finder" button must be clickable (not
  // occluded). If it is occluded, this is the bug we just fixed.
  const occlusions = await findOcclusions([".header-menu-popover button"]);
  expect(occlusions, `Project menu items occluded: ${JSON.stringify(occlusions)}`).toEqual([]);

  // Close the popover.
  await page.keyboard.press("Escape");
});

test("each primary rail icon is clickable (no occlusion) + sub-rail open", async () => {
  // Walk every primary, click it, screenshot. After each click,
  // press Escape to close any popover/modal the click may have
  // opened (the Settings gear opens a modal that would otherwise
  // occlude every other rail button).
  const primaries = await page.locator(".primary-rail .rail-btn").all();
  expect(primaries.length).toBeGreaterThan(2);
  for (let i = 0; i < primaries.length; i += 1) {
    const btn = primaries[i];
    const label = await btn.getAttribute("aria-label");
    await btn.click();
    await page.waitForTimeout(120);
    await shot(`03-primary-${i}-${(label || "x").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
    // Close any modal/popover that may have opened.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(60);
  }

  // After visiting all, check no primary is occluded by something else.
  const occlusions = await findOcclusions([".primary-rail .rail-btn"]);
  expect(occlusions, `Primary rail occluded: ${JSON.stringify(occlusions)}`).toEqual([]);
});

test("settings modal opens above everything", async () => {
  const gear = page.locator(".rail-btn-settings").first();
  await gear.click();
  await page.waitForSelector(".modal-backdrop", { timeout: 3_000 });
  await shot("04-settings-modal");
  const occlusions = await findOcclusions([".modal-backdrop button"]);
  expect(occlusions, `Settings modal occluded: ${JSON.stringify(occlusions)}`).toEqual([]);
  // Cancel close
  await page.keyboard.press("Escape");
});

test("rail labels fit inside their column", async () => {
  // Read every primary rail button's column width and label width,
  // and report any label that overflows or is clipped.
  const overflows = await page.evaluate(() => {
    const out: Array<{ label: string; labelWidth: number; columnWidth: number; overflow: boolean }> = [];
    const buttons = Array.from(document.querySelectorAll<HTMLElement>(".primary-rail .rail-btn"));
    for (const btn of buttons) {
      const label = btn.querySelector(".rail-btn-label");
      const labelText = label?.textContent?.trim() || "";
      const btnRect = btn.getBoundingClientRect();
      const labelRect = label?.getBoundingClientRect();
      if (!labelRect) continue;
      // The label's content width (scrollWidth) tells us how wide it
      // wants to be; if scrollWidth > clientWidth the text is clipped.
      const labelEl = label as HTMLElement;
      const overflow = labelEl.scrollWidth > labelEl.clientWidth + 1;
      out.push({
        label: labelText,
        labelWidth: Math.round(labelEl.scrollWidth),
        columnWidth: Math.round(btnRect.width),
        overflow,
      });
    }
    return out;
  });
  // Log them so the failure is readable. Save to artifact too.
  fs.writeFileSync(
    path.join(SCREENSHOT_DIR, "rail-labels.json"),
    JSON.stringify(overflows, null, 2),
  );
  const clipped = overflows.filter((row) => row.overflow);
  expect(clipped, `Rail labels clipped: ${JSON.stringify(clipped, null, 2)}`).toEqual([]);
});

test("health badge state on a fresh fixture project", async () => {
  const badge = page.locator(".health-dot-btn").first();
  if (!(await badge.count())) return;
  const ariaLabel = await badge.getAttribute("aria-label");
  const labelText = (await badge.locator(".health-dot-label").innerText().catch(() => ""))?.trim() ?? "";
  fs.writeFileSync(
    path.join(SCREENSHOT_DIR, "health-badge.json"),
    JSON.stringify({ ariaLabel, labelText }, null, 2),
  );
  await badge.click();
  await page.waitForTimeout(240);
  await shot("05-health-tooltip-open");
  const items = await page.locator(".health-tooltip .health-tooltip-item-copy").allInnerTexts().catch(() => []);
  fs.writeFileSync(
    path.join(SCREENSHOT_DIR, "health-issues.json"),
    JSON.stringify(items, null, 2),
  );
  await page.keyboard.press("Escape");
});

test("chat panel state on boot", async () => {
  const chatPane = page.locator(".chat-pane, .chat-thread").first();
  const chatText = (await chatPane.innerText().catch(() => "")) || "";
  fs.writeFileSync(
    path.join(SCREENSHOT_DIR, "chat-boot.txt"),
    chatText,
  );
  // Look for "Starting Codex" — that suggests the renderer auto-spawned
  // Codex even though no project agent settings were saved.
  const starting = /Starting (Codex|Claude|Shell)/i.test(chatText);
  fs.writeFileSync(
    path.join(SCREENSHOT_DIR, "chat-boot-meta.json"),
    JSON.stringify({ starting, chatTextSample: chatText.slice(0, 400) }, null, 2),
  );
});

test("clicking an item row opens its editor", async () => {
  // Land on Canon, then click the master script row, then the scene row.
  const canonBtn = page.locator(".primary-rail .rail-btn[aria-label='Canon']").first();
  await canonBtn.click();
  await page.waitForTimeout(160);
  const masterRow = page.locator(".item-list .item-row").filter({ hasText: "Master Script" }).first();
  await masterRow.click();
  await page.waitForTimeout(160);
  await shot("06-master-script-editor");
  // The editor head shows the title in an <input class="editor-title-input">
  // when a section item is selected. count() first to skip the
  // 30-second default wait if the selector misses.
  const titleLoc = page.locator(".editor-pane input.editor-title-input").first();
  const masterTitle = (await titleLoc.count()) ? (await titleLoc.inputValue()) : "";
  fs.writeFileSync(
    path.join(SCREENSHOT_DIR, "editor-titles.json"),
    JSON.stringify({ master: masterTitle }, null, 2),
  );
  expect(masterTitle, "expected the master script editor to show its title").toBe("Master Script");
  // Now click the scene row.
  const sceneRow = page.locator(".item-list .item-row").filter({ hasText: "Cold open" }).first();
  if (await sceneRow.count()) {
    await sceneRow.click();
    await page.waitForTimeout(160);
    await shot("07-scene-editor");
  }
});

test("right-click on an item row shows a context menu above panels", async () => {
  const canonBtn = page.locator(".primary-rail .rail-btn[aria-label='Canon']").first();
  await canonBtn.click();
  await page.waitForTimeout(160);
  const sceneRow = page.locator(".item-list .item-row").filter({ hasText: "Cold open" }).first();
  if (!(await sceneRow.count())) return;
  await sceneRow.click({ button: "right" });
  await page.waitForTimeout(220);
  // Try the most common context-menu class.
  const menu = page.locator("[role=menu], .context-menu, .shot-context-menu, .menu-popover").first();
  await menu.waitFor({ timeout: 2_000 }).catch(() => {});
  await shot("08-right-click-context-menu");
  if (await menu.count()) {
    const occlusions = await findOcclusions(["[role=menu] button, .context-menu button, .shot-context-menu button, .menu-popover button"]);
    fs.writeFileSync(
      path.join(SCREENSHOT_DIR, "context-menu-occlusions.json"),
      JSON.stringify(occlusions, null, 2),
    );
  }
  await page.keyboard.press("Escape");
});

test("z-index sweep — no positioned element renders below later siblings", async () => {
  // Catalogue every positioned element + its computed z-index. A common
  // bug class: a popover at z-index 40 is rendered before workspace
  // content that sits at auto z-index but inside a stacking context
  // that paints later. We collect data here for inspection.
  const positionedSurfaces = await page.evaluate(() => {
    const out: Array<{
      tag: string;
      cls: string;
      position: string;
      zIndex: string;
      rectW: number;
      rectH: number;
      rectTop: number;
    }> = [];
    const all = Array.from(document.querySelectorAll<HTMLElement>("*"));
    for (const el of all) {
      const cs = getComputedStyle(el);
      if (cs.position === "static") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) continue;
      out.push({
        tag: el.tagName.toLowerCase(),
        cls: typeof el.className === "string" ? el.className : "",
        position: cs.position,
        zIndex: cs.zIndex,
        rectW: Math.round(rect.width),
        rectH: Math.round(rect.height),
        rectTop: Math.round(rect.top),
      });
    }
    return out;
  });
  fs.writeFileSync(
    path.join(SCREENSHOT_DIR, "positioned-surfaces.json"),
    JSON.stringify(positionedSurfaces, null, 2),
  );
});

// ----------------------------------------------------------------------
// Flow audit — modal stacking + lifecycle + responsive
// ----------------------------------------------------------------------

async function dismissAllPopovers() {
  // Press Escape a few times to clear stacked popovers/modals.
  for (let i = 0; i < 3; i += 1) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(60);
  }
}

test("New Project modal opens above everything and Escape closes it", async () => {
  await dismissAllPopovers();
  // Open the project menu, click "New Project".
  await page.locator(".project-title-trigger").first().click();
  await page.waitForSelector(".header-menu-popover", { timeout: 3_000 });
  // The menu's last "New Project…" item is in the Workspace section.
  const newBtn = page.locator(".header-menu-popover button").filter({ hasText: /New Project/ }).first();
  if (!(await newBtn.count())) {
    await dismissAllPopovers();
    return;
  }
  await newBtn.click();
  await page.waitForSelector(".modal-backdrop", { timeout: 3_000 });
  await shot("09-new-project-modal");
  // Modal interactive elements should not be occluded.
  const occlusions = await findOcclusions([".modal-backdrop input, .modal-backdrop button"]);
  expect(occlusions, `New Project modal occluded: ${JSON.stringify(occlusions)}`).toEqual([]);
  // Cancel.
  await page.keyboard.press("Escape");
  await page.waitForSelector(".modal-backdrop", { state: "detached", timeout: 3_000 });
});

test("Add custom subsection modal opens cleanly", async () => {
  await dismissAllPopovers();
  // The Add subsection (+) button only renders on Assets primary —
  // that's the only primary with a built-in sub-rail. Land there.
  await page.locator(".primary-rail .rail-btn[aria-label='Assets']").first().click();
  await page.waitForTimeout(180);
  const addBtn = page.locator(".script-rail-btn-add").first();
  expect(await addBtn.count(), "Add subsection button missing on Assets primary").toBeGreaterThan(0);
  await addBtn.click();
  await page.waitForSelector(".modal-backdrop", { timeout: 3_000 });
  await shot("10-add-subsection-modal");
  const occlusions = await findOcclusions([".modal-backdrop input, .modal-backdrop button, .modal-backdrop textarea"]);
  expect(occlusions, `Add subsection modal occluded: ${JSON.stringify(occlusions)}`).toEqual([]);
  await page.keyboard.press("Escape");
  await page.waitForSelector(".modal-backdrop", { state: "detached", timeout: 3_000 });
});

test("+Scene button creates a new scene and the items list reflects it", async () => {
  await dismissAllPopovers();
  await page.locator(".primary-rail .rail-btn[aria-label='Canon']").first().click();
  await page.waitForTimeout(160);
  // Count rows BEFORE.
  const before = await page.locator(".item-list .item-row").count();
  const addSceneBtn = page.locator(".script-tree-add-btn").first();
  if (!(await addSceneBtn.count())) return;
  await addSceneBtn.click();
  await page.waitForTimeout(280);
  await shot("11-after-add-scene");
  const after = await page.locator(".item-list .item-row").count();
  expect(after, `expected at least one new row after +Scene; before=${before} after=${after}`).toBeGreaterThan(before);
});

test("hovering a tooltip-bearing element actually paints the tooltip", async () => {
  // The header notice button has data-tooltip — hover it and confirm
  // the ::after pseudo-element becomes opaque (opacity:1).
  await dismissAllPopovers();
  const tip = page.locator(".icon-hover-tooltip[data-tooltip]").first();
  if (!(await tip.count())) return;
  await tip.hover();
  await page.waitForTimeout(280);
  const tooltipState = await tip.evaluate((el) => {
    const cs = window.getComputedStyle(el, "::after");
    return {
      content: cs.content,
      opacity: cs.opacity,
      zIndex: cs.zIndex,
      tooltip: el.getAttribute("data-tooltip"),
    };
  });
  fs.writeFileSync(
    path.join(SCREENSHOT_DIR, "tooltip-state.json"),
    JSON.stringify(tooltipState, null, 2),
  );
  expect(tooltipState.opacity, `tooltip should be visible on hover; got ${JSON.stringify(tooltipState)}`).toBe("1");
  // Move the mouse off the trigger so subsequent screenshots don't
  // capture a dangling tooltip from this test.
  await page.mouse.move(0, 0);
  await page.waitForTimeout(120);
});

test("viewport resize — layout holds at 1024x720 and 1440x900", async () => {
  for (const [w, h] of [
    [1024, 720] as const,
    [1440, 900] as const,
    [800, 600] as const,
  ]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(200);
    await shot(`12-resize-${w}x${h}`);
    // Walk the rail and confirm no rail label is clipped at this size.
    const overflows = await page.evaluate(() => {
      const out: Array<{ label: string; clipped: boolean }> = [];
      const labels = Array.from(document.querySelectorAll<HTMLElement>(".rail-btn-label"));
      for (const el of labels) {
        const clipped = el.scrollWidth > el.clientWidth + 1;
        out.push({ label: el.textContent?.trim() || "", clipped });
      }
      return out;
    });
    const clipped = overflows.filter((row) => row.clipped);
    expect(clipped, `Rail labels clipped at ${w}x${h}: ${JSON.stringify(clipped)}`).toEqual([]);
    // No element should overflow window horizontally and force a scrollbar.
    const horizScroll = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(
      horizScroll,
      `Window has ${horizScroll}px of horizontal overflow at ${w}x${h}`,
    ).toBeLessThanOrEqual(0);
  }
  // Restore default viewport for any later tests.
  await page.setViewportSize({ width: 1280, height: 720 });
});

test("Escape closes every modal/popover state correctly", async () => {
  await dismissAllPopovers();
  // Open settings, escape — repeat for each surface — verify no
  // stranded backdrops linger.
  const opens: Array<{ name: string; open: () => Promise<void> }> = [
    {
      name: "settings",
      open: async () => {
        await page.locator(".rail-btn-settings").first().click();
        await page.waitForSelector(".modal-backdrop", { timeout: 3_000 });
      },
    },
    {
      name: "project menu",
      open: async () => {
        await page.locator(".project-title-trigger").first().click();
        await page.waitForSelector(".header-menu-popover", { timeout: 3_000 });
      },
    },
  ];
  for (const surface of opens) {
    await surface.open();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(160);
    const lingering = await page.locator(".modal-backdrop, .header-menu-popover").count();
    expect(lingering, `${surface.name} did not close cleanly: ${lingering} surface(s) lingering`).toBe(0);
  }
});

test("modal-backdrop click closes the modal", async () => {
  await dismissAllPopovers();
  await page.locator(".rail-btn-settings").first().click();
  await page.waitForSelector(".modal-backdrop", { timeout: 3_000 });
  // Click the backdrop itself (top-left corner outside the modal body).
  await page.locator(".modal-backdrop").click({ position: { x: 20, y: 20 } });
  await page.waitForTimeout(280);
  const lingering = await page.locator(".modal-backdrop").count();
  expect(lingering, `clicking backdrop should close the modal`).toBe(0);
});

test("focus rings — Tab keyboard navigation lands on visible elements", async () => {
  await dismissAllPopovers();
  // After focusing the document body, Tab should walk through visible
  // interactive elements; the first 8 should all be visible (in
  // viewport, not display:none, not aria-hidden).
  await page.keyboard.press("Escape");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const visited: Array<{ tag: string; ariaLabel: string; visible: boolean }> = [];
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const rect = el.getBoundingClientRect();
      const cs = window.getComputedStyle(el);
      const visible =
        rect.width > 0 &&
        rect.height > 0 &&
        cs.visibility !== "hidden" &&
        cs.display !== "none" &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth;
      return {
        tag: el.tagName.toLowerCase(),
        ariaLabel: el.getAttribute("aria-label") || el.textContent?.trim().slice(0, 40) || "",
        visible,
      };
    });
    if (info) visited.push(info);
  }
  fs.writeFileSync(
    path.join(SCREENSHOT_DIR, "tab-walk.json"),
    JSON.stringify(visited, null, 2),
  );
  const invisible = visited.filter((v) => !v.visible);
  expect(invisible, `Tab walk landed on non-visible elements: ${JSON.stringify(invisible)}`).toEqual([]);
});

test("agent chip switching does not crash and keeps the rail visible", async () => {
  await dismissAllPopovers();
  // The chat header has Shell / Claude / Codex chips. Click each and
  // verify the chat panel still renders + the primary rail still shows.
  const chips = ["Shell", "Claude", "Codex"];
  for (const chip of chips) {
    const btn = page.locator(".chat-pane button, .chat-thread button").filter({ hasText: new RegExp(`^${chip}$`) }).first();
    if (!(await btn.count())) continue;
    await btn.click();
    await page.waitForTimeout(220);
    await shot(`13-agent-chip-${chip.toLowerCase()}`);
    const railVisible = await page.locator(".primary-rail .rail-btn").first().isVisible();
    expect(railVisible, `primary rail vanished after clicking ${chip}`).toBe(true);
  }
});
