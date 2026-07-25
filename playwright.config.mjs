// SPDX-License-Identifier: MIT
import { defineConfig, devices } from "@playwright/test";

import { BROWSER_FIXTURE_PORT } from "./tests/browser/fixture-server.mjs";

const baseURL = `http://127.0.0.1:${String(BROWSER_FIXTURE_PORT)}/`;

// The browser lane. Every other test in this repository asserts against
// something that is not a browser -- a module boundary, a JSON response, a
// jsdom tree, or, at its worst, the source text of a component. That last one
// is why this lane exists: the guard protecting tool rendering asserted the
// text of `chat.tsx`, pinned a key assistant-ui never reads, and passed while
// every tool call rendered nothing. It would have failed if someone fixed the
// bug. Only a real browser can tell the difference.
export default defineConfig({
  testDir: "./tests/browser",
  outputDir: "./.playwright-results",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  // No retries anywhere. A render assertion that only passes on the second
  // attempt is reporting a real defect -- in the product, or in this lane. Both
  // are worth finding; neither is worth hiding behind a retry.
  retries: 0,
  // Serial. One fixture serves every test, and the web product's thread store is
  // one shared data directory, so parallel workers see each other's threads.
  // Three specs cost about ten seconds; a lane whose failures might be another
  // worker is worth much less than that.
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node ./tests/browser/fixture-server.mjs",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
