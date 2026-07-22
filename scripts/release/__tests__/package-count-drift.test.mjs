import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import { packageCatalog } from "../../package-catalog.mjs";

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

const releaseLockstepSkillPath = "skills/release-lockstep/SKILL.md";
const releaseLockstepPackageCountReferences = [
  {
    filePath: releaseLockstepSkillPath,
    description: "the release lockstep total",
    pattern: /all \*\*(?<count>\d+) `publishable: true` packages\*\*/u,
    tier: "total",
  },
  {
    filePath: releaseLockstepSkillPath,
    description: "the release lockstep core count",
    pattern: /release together: (?<count>\d+) core packages/u,
    tier: "core",
  },
  {
    filePath: releaseLockstepSkillPath,
    description: "the release lockstep alias count",
    pattern: /(?<count>\d+) `tier: "alias"` package/u,
    tier: "alias",
  },
  {
    filePath: releaseLockstepSkillPath,
    description: "the release lockstep plugin-tier count",
    pattern: /(?<count>\d+) `tier: "plugin"` extras/u,
    tier: "plugin",
  },
];

// The total and all three tier counts are guarded so prose that splits
// "N core + M plugin-tier extras + K unscoped alias" cannot silently drift
// from the catalog when the tiers change.
const guardedPackageCountReferences = [
  ...releaseLockstepPackageCountReferences,
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

  test("the release-lockstep package-set prose has no unguarded numeric count", () => {
    const contents = readRepositoryFile(releaseLockstepSkillPath);
    const paragraph = /\*\*Lockstep set:\*\*(?<prose>[\s\S]*?published alongside core\.)/u.exec(contents)?.groups?.prose;
    if (paragraph === undefined) {
      throw new Error(`${releaseLockstepSkillPath} must retain the guarded Lockstep set paragraph.`);
    }

    const proseCounts = [...paragraph.matchAll(/\b\d+\b/gu)].map((match) => Number(match[0]));
    const guardedCounts = releaseLockstepPackageCountReferences.map(
      (reference) => readGuardedPackageCount(reference, contents),
    );

    if (proseCounts.length !== guardedCounts.length
      || proseCounts.some((count, index) => count !== guardedCounts[index])) {
      throw new Error(
        `${releaseLockstepSkillPath} has an unguarded or reordered numeric package count in the Lockstep set paragraph.`,
      );
    }
  });

  test.each(releaseLockstepPackageCountReferences)(
    "a discriminating $tier package-count mutation fails and the restored release-lockstep prose passes",
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
      `${reference.filePath} has stale ${reference.tier} package count ${foundCount}; expected ${expected} from scripts/package-catalog.mjs`,
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
