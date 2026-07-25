// SPDX-License-Identifier: MIT
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SHIPPED_CHANNEL_IDS,
  packageCatalog,
  shippedChannelIdsFromCatalog,
} from "../package-catalog.mjs";
import {
  ADAPTER_NEUTRAL_SOURCE_DIRS,
  findAdapterNeutralityErrors,
  hardcodedChannelPrefixes,
} from "../lib/adapter-neutrality.mjs";

const SYNTHETIC_CHANNEL_ID = "synthetic-channel";
const TEST_CHANNEL_IDS = shippedChannelIdsFromCatalog([
  ...packageCatalog,
  { category: "communication", channelIds: [SYNTHETIC_CHANNEL_ID] },
]);
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("package architecture adapter-neutrality guard", () => {
  it("catalogs the always-on web console as a publishable operator surface", () => {
    expect(packageCatalog.find((entry) => entry.name === "@mono-agent/web")).toMatchObject({
      dir: "web",
      category: "operator-surface",
      allowedDependencyCategories: ["operator-surface"],
      publishable: true,
    });
  });

  it("exports shipped channel ids from communication-package catalog metadata", () => {
    const declaredIds = packageCatalog
      .filter((entry) => entry.category === "communication")
      .flatMap((entry) => entry.channelIds ?? []);
    expect(SHIPPED_CHANNEL_IDS).toEqual([...new Set(declaredIds)]);
    expect(TEST_CHANNEL_IDS).toEqual([...SHIPPED_CHANNEL_IDS, SYNTHETIC_CHANNEL_ID]);
  });

  it("contains exactly the 23-package v1 roster and no compatibility webhook package", () => {
    expect(packageCatalog).toHaveLength(23);
    expect(packageCatalog.find((entry) => entry.name === "@mono-agent/webhook-adapter")).toBeUndefined();
    expect(packageCatalog.find((entry) => entry.name === "@mono-agent/channel-webhook")).toMatchObject({
      category: "communication",
      channelIds: ["webhook"],
    });
  });

  it.each(TEST_CHANNEL_IDS)("detects %s prefix literals and patterns but not the bare id", (channelId) => {
    const escapedForRegex = channelId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const coupledSources = [
      `const id = "${channelId}:target";`,
      `const id = \`${channelId}:\${target}\`;`,
      `const prefix = /^${escapedForRegex}:/u;`,
    ];
    for (const source of coupledSources) {
      expect(hardcodedChannelPrefixes(source, TEST_CHANNEL_IDS)).toEqual([channelId]);
    }
    expect(hardcodedChannelPrefixes(`const channel = "${channelId}";`, TEST_CHANNEL_IDS)).toEqual([]);
  });

  it("does not mistake a shipped id inside a longer identifier for a channel prefix", () => {
    expect(hardcodedChannelPrefixes("const options = { sessionKeepAlive: true };", TEST_CHANNEL_IDS)).toEqual([]);
  });

  for (const sourceDir of ADAPTER_NEUTRAL_SOURCE_DIRS) {
    it.each(TEST_CHANNEL_IDS)(`rejects a %s prefix reintroduced in ${sourceDir}`, async (channelId) => {
      const root = await createNeutralSourceRoot();
      const file = join(root, sourceDir, "prefix.ts");
      await writeFile(file, `export const conversationId = "${channelId}:target";\n`);

      expect(findAdapterNeutralityErrors({ root, channelIds: TEST_CHANNEL_IDS })).toEqual([
        `${sourceDir}/prefix.ts must stay adapter-neutral; hardcodes shipped channel prefix "${channelId}:".`,
      ]);
    });

    it(`excludes tests and fixtures under ${sourceDir}`, async () => {
      const root = await createNeutralSourceRoot();
      const ignoredFiles = [
        join(root, sourceDir, "__tests__", "prefix.ts"),
        join(root, sourceDir, "__fixtures__", "prefix.ts"),
        join(root, sourceDir, "fixtures", "prefix.ts"),
        join(root, sourceDir, "prefix.test.ts"),
        join(root, sourceDir, "prefix.spec.ts"),
      ];
      for (const file of ignoredFiles) {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, `export const conversationId = "${SYNTHETIC_CHANNEL_ID}:target";\n`);
      }

      expect(findAdapterNeutralityErrors({ root, channelIds: TEST_CHANNEL_IDS })).toEqual([]);
    });
  }
});

async function createNeutralSourceRoot() {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-architecture-"));
  temporaryRoots.push(root);
  await Promise.all(
    ADAPTER_NEUTRAL_SOURCE_DIRS.map((sourceDir) => mkdir(join(root, sourceDir), { recursive: true })),
  );
  return root;
}
