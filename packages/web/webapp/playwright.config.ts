import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { defineConfig, devices } from "@playwright/test";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: {
    timeout: 8_000,
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: 0.002,
      threshold: 0.2,
    },
  },
  reporter: [["list"]],
  outputDir: join(tmpdir(), "mono-agent-web-playwright-results"),
  snapshotPathTemplate:
    `{testDir}/snapshots/{testFilePath}/{arg}-{projectName}-${process.platform}{ext}`,
  use: {
    baseURL: "http://127.0.0.1:4173",
    colorScheme: "dark",
    contextOptions: { reducedMotion: "reduce" },
    locale: "en-US",
    serviceWorkers: "block",
    timezoneId: "UTC",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium-desktop",
      use: {
        ...devices["Desktop Chrome"],
        deviceScaleFactor: 1,
        viewport: { width: 1_440, height: 900 },
      },
    },
    {
      name: "chromium-mobile",
      use: {
        ...devices["Desktop Chrome"],
        deviceScaleFactor: 1,
        hasTouch: true,
        isMobile: true,
        viewport: { width: 390, height: 844 },
      },
    },
    {
      name: "chromium-compact-desktop",
      testMatch: /console\.behavior\.spec\.ts/u,
      use: {
        ...devices["Desktop Chrome"],
        deviceScaleFactor: 1,
        viewport: { width: 1_280, height: 720 },
      },
    },
    {
      name: "chromium-tablet",
      testMatch: /console\.behavior\.spec\.ts/u,
      use: {
        ...devices["Desktop Chrome"],
        deviceScaleFactor: 1,
        hasTouch: true,
        isMobile: true,
        viewport: { width: 768, height: 1_024 },
      },
    },
  ],
  webServer: {
    command:
      "pnpm exec vite --config webapp/vite.config.ts --host 127.0.0.1 --port 4173 --strictPort",
    cwd: packageRoot,
    url: "http://127.0.0.1:4173/",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
