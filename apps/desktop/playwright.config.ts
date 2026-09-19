import { defineConfig } from "@playwright/test";

// Headed Electron audits. Tests launch Anvil's main process directly,
// which loads the renderer from the Vite dev server at :5173. The
// `webServer` block here boots Vite first and waits for the port.
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 90_000,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npx vite",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: true,
    timeout: 60_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
