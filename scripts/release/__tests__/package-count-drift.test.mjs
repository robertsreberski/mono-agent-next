// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import { packageCatalog } from "../../lib/package-catalog.mjs";

const publishablePackages = packageCatalog.filter((entry) => entry.publishable === true);
const pluginTierCount = publishablePackages.filter((entry) => entry.tier === "plugin").length;
const aliasTierCount = publishablePackages.filter((entry) => entry.tier === "alias").length;
const coreTierCount = publishablePackages.length - pluginTierCount - aliasTierCount;

const expectedCounts = {
  total: publishablePackages.length,
  core: coreTierCount,
  plugin: pluginTierCount,
  alias: aliasTierCount,
};

// PACKAGES.md is generated from the package catalog and remains the source-beta
// package-count surface. Release procedure prose is updated only in the
// separately authorized release/cutover phase.
const guardedPackageCountReferences = [
  {
    filePath: "PACKAGES.md",
    description: "the generated catalog summary (core count)",
    pattern: /Current catalog: (?<count>\d+) core-tier packages/u,
    tier: "core",
  },
  {
    filePath: "PACKAGES.md",
    description: "the generated catalog summary (plugin-tier count)",
    pattern: /core-tier packages, (?<count>\d+) plugin-tier extras/u,
    tier: "plugin",
  },
  {
    filePath: "PACKAGES.md",
    description: "the generated catalog summary (unscoped alias count)",
    pattern: /plugin-tier extras, and (?<count>\d+) unscoped alias/u,
    tier: "alias",
  },
];

function readRepositoryFile(filePath) {
  return readFileSync(new URL(`../../../${filePath}`, import.meta.url), "utf8");
}

describe("package count drift guard", () => {
  test.each(guardedPackageCountReferences)(
    "$filePath keeps its $tier package count aligned with the package catalog",
    (reference) => {
      assertGuardedPackageCount(reference, readRepositoryFile(reference.filePath));
    },
  );

  test.each(guardedPackageCountReferences)(
    "a discriminating $tier package-count mutation fails and the restored generated summary passes",
    (reference) => {
      const contents = readRepositoryFile(reference.filePath);
      const expected = expectedCounts[reference.tier];
      const mutated = mutateGuardedPackageCount(reference, contents, expected + 1);

      expect(() => assertGuardedPackageCount(reference, mutated)).toThrow(
        `${reference.filePath} has stale ${reference.tier} package count ${expected + 1}`,
      );
      expect(() => assertGuardedPackageCount(reference, contents)).not.toThrow();
    },
  );
});

function assertGuardedPackageCount(reference, contents) {
  const foundCount = readGuardedPackageCount(reference, contents);
  const expected = expectedCounts[reference.tier];

  if (foundCount !== expected) {
    throw new Error(
      `${reference.filePath} has stale ${reference.tier} package count ${foundCount}; expected ${expected} from scripts/lib/package-catalog.mjs`,
    );
  }
}

function readGuardedPackageCount({ filePath, description, pattern }, contents) {
  const match = pattern.exec(contents);
  if (!match) {
    throw new Error(
      `${filePath} must include a package-count reference for ${description}; update the guard if the prose intentionally changed.`,
    );
  }
  return Number(match.groups?.count);
}

function mutateGuardedPackageCount(reference, contents, replacement) {
  const match = reference.pattern.exec(contents);
  if (!match || match.index === undefined || match.groups?.count === undefined) {
    throw new Error(`could not create a discriminating mutation for ${reference.description}.`);
  }
  const mutatedMatch = match[0].replace(match.groups.count, String(replacement));
  return `${contents.slice(0, match.index)}${mutatedMatch}${contents.slice(match.index + match[0].length)}`;
}
