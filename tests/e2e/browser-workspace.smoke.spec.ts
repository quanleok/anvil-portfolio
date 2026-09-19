import { expect, test } from "@playwright/test";

test("opens the browser workspace login surface", async ({ page }) => {
  await page.goto("/app/login");

  await expect(page.getByRole("heading", { name: "Sign in to Anvil Cloud" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Continue with local dev session" })).toBeVisible();
});
