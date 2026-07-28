// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";
import { parseDocument } from "yaml";

describe("website CI contract", () => {
  test("keeps the isolated Node 22 frozen-install and build lane exact", () => {
    const source = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
    const document = parseDocument(source, { merge: false, strict: true, uniqueKeys: true, version: "1.2" });
    expect([...document.errors, ...document.warnings]).toEqual([]);
    const workflow = document.toJS({ mapAsMap: false });
    const website = workflow.jobs.website;
    const verify = workflow.jobs.verify;

    expect(website).toEqual({
      name: "Website (Node 22)",
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 20,
      defaults: { run: { "working-directory": "website" } },
      steps: [
        { name: "Checkout", uses: "actions/checkout@v4" },
        {
          name: "Setup pnpm",
          uses: "pnpm/action-setup@v4",
          with: { version: "10.28.2" },
        },
        {
          name: "Setup Node",
          uses: "actions/setup-node@v4",
          with: {
            "node-version": "22.19.0",
            cache: "pnpm",
            "cache-dependency-path": "website/pnpm-lock.yaml",
          },
        },
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

    expect(verify.steps[0]).toEqual({
      name: "Checkout",
      uses: "actions/checkout@v4",
      with: { "fetch-depth": 0 },
    });
    expect(verify.steps.slice(1, 3)).toEqual([
      {
        name: "Setup pnpm",
        uses: "pnpm/action-setup@v4",
        with: { version: "10.28.2" },
      },
      {
        name: "Setup Node",
        uses: "actions/setup-node@v4",
        with: {
          "node-version": "${{ matrix.node-version }}",
          cache: "pnpm",
          "cache-dependency-path": "pnpm-lock.yaml",
        },
      },
    ]);

    const verifyRuns = verify.steps
      .map((step) => step.run)
      .filter((run) => typeof run === "string");
    const websiteRuns = website.steps
      .map((step) => step.run)
      .filter((run) => typeof run === "string");
    expect([...verifyRuns, ...websiteRuns].some((run) => run.includes("corepack"))).toBe(false);
    expect(verifyRuns.some((run) => run.includes("pnpm run check:licenses"))).toBe(true);
    expect(verifyRuns.some((run) => run.includes("pnpm run check:source-line-length"))).toBe(true);
    expect(verifyRuns.some((run) => run.includes("pnpm run check:source-beta-budgets"))).toBe(true);
    expect(verifyRuns.some((run) => run.includes("pnpm run scripts:test"))).toBe(true);

    const minimalProof = {
      name: "Prove packed minimal consumer",
      if: "${{ matrix.node-version == '22.19.0' }}",
      run: "pnpm run verify:minimal",
    };
    const minimalProofSteps = verify.steps.filter((step) =>
      step.run === "pnpm run verify:minimal");
    expect(minimalProofSteps).toEqual([minimalProof]);
    expect(verify.steps.indexOf(minimalProofSteps[0])).toBeLessThan(
      verify.steps.findIndex((step) => step.run === "pnpm run verify:personal-successor"),
    );

    const verdict = workflow.jobs.verdict;
    // The branch ruleset requires a status check by this exact name. Renaming
    // the job would silently un-require it, leaving `main` unguarded while CI
    // still looks green, so the name is pinned here alongside the wiring.
    expect(verdict.name).toBe("Required verdict");
    expect(verdict.needs).toEqual(["verify", "website"]);
    expect(verdict.steps[0].env).toEqual({
      VERIFY_RESULT: "${{ needs.verify.result }}",
      WEBSITE_RESULT: "${{ needs.website.result }}",
    });
    expect(verdict.steps[0].run).toContain(
      '[[ "$VERIFY_RESULT" != "success" || "$WEBSITE_RESULT" != "success" ]]',
    );
  });
});
