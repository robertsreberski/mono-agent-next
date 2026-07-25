// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";
import { parseDocument } from "yaml";

const root = new URL("../../", import.meta.url);

function read(path) {
  return readFileSync(new URL(path, root), "utf8");
}

function parseYaml(path) {
  const document = parseDocument(read(path), {
    merge: false,
    strict: true,
    uniqueKeys: true,
    version: "1.2",
  });
  expect([...document.errors, ...document.warnings]).toEqual([]);
  return document.toJS({ mapAsMap: false });
}

describe("community files", () => {
  test("routes sensitive reports to an available private maintainer contact", () => {
    const maintainerUrl = "https://github.com/robertsreberski";
    const conduct = read("CODE_OF_CONDUCT.md");
    const config = parseYaml(".github/ISSUE_TEMPLATE/config.yml");

    expect(conduct).toContain(maintainerUrl);
    expect(conduct).toContain("private contact method");
    expect(conduct).toMatch(
      /Do not put\s+sensitive details in a public issue\./u,
    );
    expect(config).toEqual({
      blank_issues_enabled: false,
      contact_links: [
        {
          name: "Private security or conduct contact",
          url: maintainerUrl,
          about: "Use a private contact method on the maintainer profile for sensitive reports.",
        },
      ],
    });
  });

  test("keeps actionable bug and feature forms", () => {
    const bug = parseYaml(".github/ISSUE_TEMPLATE/bug_report.yml");
    const feature = parseYaml(".github/ISSUE_TEMPLATE/feature_request.yml");

    expect(bug.name).toBe("Bug report");
    expect(bug.labels).toEqual(["bug"]);
    expect(bug.body.map(({ id }) => id).filter(Boolean)).toEqual([
      "description",
      "reproduction",
      "environment",
      "evidence",
    ]);
    expect(
      bug.body
        .filter(({ validations }) => validations?.required)
        .map(({ id }) => id),
    ).toEqual(["description", "reproduction", "environment"]);

    expect(feature.name).toBe("Feature request");
    expect(feature.labels).toEqual(["enhancement"]);
    expect(feature.body.map(({ id }) => id)).toEqual([
      "problem",
      "proposal",
      "alternatives",
    ]);
    expect(
      feature.body
        .filter(({ validations }) => validations?.required)
        .map(({ id }) => id),
    ).toEqual(["problem", "proposal"]);
  });

  test("keeps one explicit repository owner and a review-ready pull request template", () => {
    expect(read(".github/CODEOWNERS")).toBe("* @robertsreberski\n");

    const template = read(".github/PULL_REQUEST_TEMPLATE.md");
    expect(template).toContain("## Summary");
    expect(template).toContain("Closes #");
    expect(template).toContain("## Verification");
    expect(template).toContain("## Checklist");
    expect(template).toContain("No secrets, credentials, private data");
    expect(template).toContain("External review findings are each fixed");
    expect(template).toContain("No release, publish, deploy, restart, or service cutover");
  });

  test("keeps weekly dependency updates scoped to both pnpm roots and actions", () => {
    expect(parseYaml(".github/dependabot.yml")).toEqual({
      version: 2,
      updates: [
        {
          "package-ecosystem": "npm",
          directory: "/",
          schedule: { interval: "weekly" },
        },
        {
          "package-ecosystem": "npm",
          directory: "/website",
          schedule: { interval: "weekly" },
        },
        {
          "package-ecosystem": "github-actions",
          directory: "/",
          schedule: { interval: "weekly" },
        },
      ],
    });
  });

  test("keeps the release workflow on the pinned cached pnpm toolchain", () => {
    const release = parseYaml(".github/workflows/npm-release.yml");
    const setupPnpm = release.jobs.publish.steps.find(
      ({ name }) => name === "Setup pnpm",
    );
    const setupNode = release.jobs.publish.steps.find(
      ({ name }) => name === "Setup Node",
    );

    expect(setupPnpm).toEqual({
      name: "Setup pnpm",
      uses: "pnpm/action-setup@v4",
      with: { version: "10.28.2" },
    });
    expect(setupNode).toEqual({
      name: "Setup Node",
      uses: "actions/setup-node@v4",
      with: {
        "node-version": "22.19.0",
        "registry-url": "https://registry.npmjs.org",
        cache: "pnpm",
        "cache-dependency-path": "pnpm-lock.yaml",
      },
    });
    expect(
      release.jobs.publish.steps.some(
        ({ run }) => typeof run === "string" && run.includes("corepack"),
      ),
    ).toBe(false);
  });
});
