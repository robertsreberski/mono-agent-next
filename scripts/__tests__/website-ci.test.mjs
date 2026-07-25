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
          name: "Setup Node",
          uses: "actions/setup-node@v4",
          with: { "node-version": "22.19.0" },
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

    expect(verify.steps[0]).toEqual({
      name: "Checkout",
      uses: "actions/checkout@v4",
      with: { "fetch-depth": 0 },
    });

    const verifyRuns = verify.steps
      .map((step) => step.run)
      .filter((run) => typeof run === "string");
    expect(verifyRuns.some((run) => run.includes("pnpm run check:apache-provenance"))).toBe(true);
    expect(verifyRuns.some((run) => run.includes("pnpm run check:source-beta-budgets"))).toBe(true);
    expect(verifyRuns.some((run) => run.includes("pnpm run scripts:test"))).toBe(true);

    const minimalProof = {
      name: "Prove packed minimal v1 consumer",
      if: "${{ matrix.node-version == '22.19.0' }}",
      run: "pnpm run verify:v1-minimal",
    };
    const minimalProofSteps = verify.steps.filter((step) =>
      step.run === "pnpm run verify:v1-minimal");
    expect(minimalProofSteps).toEqual([minimalProof]);
    expect(verify.steps.indexOf(minimalProofSteps[0])).toBeLessThan(
      verify.steps.findIndex((step) => step.run === "pnpm run verify:v1-system"),
    );

    const verdict = workflow.jobs.verdict;
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
