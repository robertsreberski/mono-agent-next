import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ResolvedStateLocalConfig } from "../config.js";
import { acquireProcessLease } from "../secure-fs.js";
import { StateLocalStore } from "../store.js";

const roots: string[] = [];
const signal = new AbortController().signal;
const OLD = "2026-07-20T12:00:00.000Z";
const NOW = "2026-07-23T12:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) =>
    rm(root, { recursive: true, force: true })));
});

describe("state-local maintenance", () => {
  it("dry-runs then reclaims only a durable unpublished artifact reservation", async () => {
    const config = await createConfig();
    const data = Buffer.from("abandoned unpublished artifact", "utf8");
    const staging = await open(config, OLD, {
      beforeIndexCommit: () => {
        throw new Error("crash after durable staging");
      },
    });
    await expect(staging.putArtifact({
      data,
      mediaType: "text/plain",
      signal,
    })).rejects.toThrow("crash after durable staging");
    await staging.close();

    const store = await open(config, NOW);
    const dryRun = await store.maintain({ dryRun: true, limit: 10, signal });
    expect(dryRun).toMatchObject({
      artifactCutoffAt: "2026-07-22T12:00:00.000Z",
      dryRun: true,
      unpublishedArtifactCandidates: 1,
      unpublishedArtifactRemoved: 0,
      reclaimedArtifactBytes: 0,
    });
    expect(await artifactBlobNames(config)).toHaveLength(1);

    const applied = await store.maintain({ limit: 10, signal });
    expect(applied).toMatchObject({
      dryRun: false,
      unpublishedArtifactCandidates: 1,
      unpublishedArtifactRemoved: 1,
      reclaimedArtifactBytes: data.byteLength,
    });
    expect(await artifactBlobNames(config)).toEqual([]);
    expect((await store.listArtifacts({ limit: 10, signal })).artifacts).toEqual([]);
    await store.close();

    const reopened = await open(config, NOW);
    expect(await reopened.maintain({ limit: 10, signal })).toMatchObject({
      unpublishedArtifactCandidates: 0,
      unpublishedArtifactRemoved: 0,
      reclaimedArtifactBytes: 0,
    });
    await reopened.close();
  });

  it("recovers a crash after the owner-proved removal claim without losing bytes", async () => {
    const config = await createConfig();
    const data = Buffer.from("recoverable retention claim", "utf8");
    const staging = await open(config, OLD, {
      beforeIndexCommit: () => {
        throw new Error("crash after durable staging");
      },
    });
    await expect(staging.putArtifact({
      data,
      mediaType: "text/plain",
      signal,
    })).rejects.toThrow("crash after durable staging");
    await staging.close();

    let crash = true;
    const interrupted = await open(config, NOW, {
      afterOrphanClaim: () => {
        if (!crash) return;
        crash = false;
        throw new Error("crash after retention claim");
      },
    });
    await expect(interrupted.maintain({ limit: 10, signal }))
      .rejects.toThrow("crash after retention claim");
    const claimed = (await readdir(artifactDirectory(config)))
      .filter((name) => /^\.retention-.*\.claim$/u.test(name));
    expect(claimed).toHaveLength(1);
    expect(await readFile(join(artifactDirectory(config), claimed[0]!))).toEqual(data);
    await interrupted.close();

    const recovered = await open(config, NOW);
    expect(await recovered.maintain({ limit: 10, signal })).toMatchObject({
      unpublishedArtifactCandidates: 1,
      unpublishedArtifactRemoved: 1,
      reclaimedArtifactBytes: data.byteLength,
    });
    expect((await readdir(artifactDirectory(config)))
      .filter((name) => /^\.retention-.*\.claim$/u.test(name))).toEqual([]);
    await recovered.close();
  });

  it("never retention-deletes published or legacy unindexed artifact bytes", async () => {
    const config = await createConfig();
    const publishedData = Buffer.from("published", "utf8");
    const old = await open(config, OLD);
    const ref = await old.putArtifact({
      data: publishedData,
      mediaType: "text/plain",
      signal,
    });
    await old.close();

    const legacyName = "artifact-123e4567-e89b-12d3-a456-426614174000.blob";
    const legacyPath = join(artifactDirectory(config), legacyName);
    await writeFile(legacyPath, "legacy unindexed bytes", {
      mode: 0o600,
      flag: "wx",
    });

    const store = await open(config, NOW);
    expect(await store.maintain({ limit: 10, signal })).toMatchObject({
      unpublishedArtifactCandidates: 0,
      unpublishedArtifactRemoved: 0,
      reclaimedArtifactBytes: 0,
    });
    expect(Buffer.from(await store.readArtifact({
      ref,
      maxBytes: publishedData.byteLength,
      signal,
    }))).toEqual(publishedData);
    expect(await readFile(legacyPath, "utf8")).toBe("legacy unindexed bytes");
    await store.close();
  });

  it("reopens the legacy published artifact index schema without granting deletion authority", async () => {
    const config = await createConfig();
    const data = Buffer.from("legacy indexed artifact", "utf8");
    const writer = await open(config, OLD);
    const ref = await writer.putArtifact({
      data,
      mediaType: "text/plain",
      signal,
    });
    await writer.close();

    const storageName = (await artifactBlobNames(config))[0];
    if (storageName === undefined) throw new Error("Expected one artifact blob.");
    const digest = ref.sha256.slice("sha256:".length);
    const lease = await acquireProcessLease(
      join(artifactDirectory(config), ".mono-agent-artifacts.lease.sqlite"),
    );
    try {
      lease.writeIndex(
        `artifact:${digest}`,
        Buffer.from(`${JSON.stringify({
          digest,
          sizeBytes: data.byteLength,
          storageName,
        })}\n`, "utf8"),
      );
    } finally {
      await lease.release();
    }

    const reader = await open(config, NOW);
    expect(Buffer.from(await reader.readArtifact({
      ref,
      maxBytes: data.byteLength,
      signal,
    }))).toEqual(data);
    expect(await reader.maintain({ limit: 10, signal })).toMatchObject({
      unpublishedArtifactCandidates: 0,
      unpublishedArtifactRemoved: 0,
      reclaimedArtifactBytes: 0,
    });
    expect(await readFile(join(artifactDirectory(config), storageName))).toEqual(data);
    await reader.close();
  });

  it("fails closed before claiming a swapped orphan path and preserves replacement bytes", async () => {
    const config = await createConfig();
    const data = Buffer.from("reserved artifact", "utf8");
    const staging = await open(config, OLD, {
      beforeIndexCommit: () => {
        throw new Error("crash after durable staging");
      },
    });
    await expect(staging.putArtifact({
      data,
      mediaType: "text/plain",
      signal,
    })).rejects.toThrow("crash after durable staging");
    await staging.close();

    const original = join(artifactDirectory(config), (await artifactBlobNames(config))[0]!);
    const replacement = join(config.root, "..", "operator-replacement");
    const replacementBytes = Buffer.from("operator bytes must survive", "utf8");
    await writeFile(replacement, replacementBytes, { mode: 0o600 });
    let swapped = false;
    const store = await open(config, NOW, {
      beforeOrphanDelete: async () => {
        if (swapped) return;
        swapped = true;
        await rename(original, `${original}.owned`);
        await rename(replacement, original);
      },
    });
    await expect(store.maintain({ limit: 10, signal }))
      .rejects.toMatchObject({ code: "STATE_PATH_CHANGED" });
    expect(await readFile(original)).toEqual(replacementBytes);
    await store.close();
  });

  it("prunes expired hidden presence through the bounded method and command surface", async () => {
    const config = await createConfig();
    const store = await open(config, NOW);
    await store.upsertPresence({
      presence: {
        presenceId: "expired",
        agentId: "agent",
        instanceId: "old-instance",
        updatedAt: "2026-07-23T10:00:00.000Z",
        expiresAt: "2026-07-23T11:00:00.000Z",
      },
      signal,
    });
    await store.upsertPresence({
      presence: {
        presenceId: "active",
        agentId: "agent",
        instanceId: "live-instance",
        updatedAt: "2026-07-23T11:59:00.000Z",
        expiresAt: "2026-07-23T12:01:00.000Z",
      },
      signal,
    });

    const command = store.commands.find((candidate) =>
      candidate.name === "state-local:maintain");
    if (command === undefined) throw new Error("Expected state maintenance command.");
    let getterInvoked = false;
    const hostile = {};
    Object.defineProperty(hostile, "dryRun", {
      enumerable: true,
      get() {
        getterInvoked = true;
        return true;
      },
    });
    await expect(command.run(hostile, {
      signal,
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
      },
    })).rejects.toMatchObject({ code: "STATE_INVALID_CONFIG" });
    expect(getterInvoked).toBe(false);

    await expect(command.run({ dryRun: true, limit: 1 }, {
      signal,
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
      },
    })).resolves.toMatchObject({
      dryRun: true,
      expiredPresenceCandidates: 1,
      expiredPresenceRemoved: 0,
    });

    expect(await store.maintain({ limit: 1, signal })).toMatchObject({
      expiredPresenceCandidates: 1,
      expiredPresenceRemoved: 1,
    });
    expect((await store.listPresence({ includeExpired: true, signal }))
      .map((presence) => presence.presenceId)).toEqual(["active"]);
    await store.close();
  });
});

async function createConfig(): Promise<ResolvedStateLocalConfig> {
  const parent = await mkdtemp(join(tmpdir(), "mono-agent-state-maintenance-"));
  roots.push(parent);
  const root = join(parent, "state");
  return {
    root,
    maxRecordBytes: 1_024,
    maxRecords: 100,
    maxTotalBytes: 10_000,
    runs: {
      artifactsDirectory: join(root, "artifacts"),
      retentionDays: 1,
    },
  };
}

function open(
  config: ResolvedStateLocalConfig,
  timestamp: string,
  artifacts?: {
    readonly beforeIndexCommit?: (target: string) => void | Promise<void>;
    readonly beforeOrphanDelete?: (target: string) => void | Promise<void>;
    readonly afterOrphanClaim?: (claim: string) => void | Promise<void>;
  },
): Promise<StateLocalStore> {
  return StateLocalStore.open(config, {
    instanceId: "maintenance-test",
    signal,
    clock: () => new Date(timestamp),
    ...(artifacts === undefined ? {} : { hooks: { artifacts } }),
  });
}

function artifactDirectory(config: ResolvedStateLocalConfig): string {
  const directory = config.runs?.artifactsDirectory;
  if (directory === undefined) throw new Error("Expected configured artifact directory.");
  return directory;
}

async function artifactBlobNames(
  config: ResolvedStateLocalConfig,
): Promise<readonly string[]> {
  return (await readdir(artifactDirectory(config)))
    .filter((name) => /^artifact-.*\.blob$/u.test(name));
}
