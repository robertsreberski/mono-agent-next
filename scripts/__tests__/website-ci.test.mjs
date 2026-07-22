import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";
import { parseDocument } from "yaml";

describe("website CI contract", () => {
  test("keeps the isolated build and rendered accessibility lane exact", () => {
    const source = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
    const document = parseDocument(source, { merge: false, strict: true, uniqueKeys: true, version: "1.2" });
    expect([...document.errors, ...document.warnings]).toEqual([]);
    const workflow = document.toJS({ mapAsMap: false });
    const website = workflow.jobs.website;

    expect(website).toEqual({
      name: "Website",
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 20,
      defaults: { run: { "working-directory": "website" } },
      steps: [
        { name: "Checkout", uses: "actions/checkout@v4" },
        {
          name: "Setup Node",
          uses: "actions/setup-node@v4",
          with: { "node-version": "24" },
        },
        { name: "Enable Corepack", run: "corepack enable" },
        { name: "Install website dependencies", run: "pnpm install --frozen-lockfile" },
        { name: "Test website transforms", run: "pnpm run test:unit" },
        { name: "Install Chromium", run: "pnpm exec playwright install --with-deps chromium" },
        {
          name: "Build docs site (check-asides -> sync-content -> astro build -> check-links)",
          run: "pnpm run build",
        },
        { name: "Audit every built page for accessibility", run: "pnpm run test:a11y" },
      ],
    });
  });
});
