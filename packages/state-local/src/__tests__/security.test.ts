import { chmod, link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ResolvedStateLocalConfig } from "../config.js";
import { StateLocalStore } from "../store.js";

const roots: string[] = [];
const signal = new AbortController().signal;

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe("state-local filesystem security", () => {
  it("rejects a symlink root without following it", async () => {
    const parent = await temp();
    const real = join(parent, "real");
    const root = join(parent, "state");
    await mkdir(real, { mode: 0o700 });
    await symlink(real, root);

    await expect(open(config(root))).rejects.toMatchObject({ code: "STATE_PATH_INSECURE" });
  });

  it("rejects symlink and hard-linked state files", async () => {
    const parent = await temp();
    const root = join(parent, "state");
    const first = await open(config(root));
    await first.close();

    const snapshot = join(root, "records.json");
    const moved = join(root, "records.real.json");
    await rename(snapshot, moved);
    await symlink(moved, snapshot);
    await expect(open(config(root))).rejects.toMatchObject({ code: "STATE_PATH_INSECURE" });

    await rm(snapshot);
    await link(moved, snapshot);
    await expect(open(config(root))).rejects.toMatchObject({ code: "STATE_PATH_INSECURE" });
  });

  it("rejects existing directories or files with group-visible modes", async () => {
    const parent = await temp();
    const root = join(parent, "state");
    await mkdir(root, { mode: 0o755 });
    await chmod(root, 0o755);
    await expect(open(config(root))).rejects.toMatchObject({ code: "STATE_PATH_INSECURE" });

    await chmod(root, 0o700);
    const store = await open(config(root));
    await store.close();
    await chmod(join(root, "records.json"), 0o644);
    await expect(open(config(root))).rejects.toMatchObject({ code: "STATE_PATH_INSECURE" });
  });

  it("rejects duplicate records in an otherwise well-formed snapshot", async () => {
    const parent = await temp();
    const root = join(parent, "state");
    const store = await open(config(root));
    await store.write({ key: "one", value: Buffer.from("1"), signal });
    await store.close();

    const path = join(root, "records.json");
    const snapshot = JSON.parse(await readFile(path, "utf8")) as { records: unknown[] };
    snapshot.records.push(snapshot.records[0]);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
    await expect(open(config(root))).rejects.toMatchObject({ code: "STATE_CORRUPT" });
  });

  it("rejects corrupt lease bytes instead of misreporting another live writer", async () => {
    const parent = await temp();
    const root = join(parent, "state");
    const store = await open(config(root));
    await store.close();
    await writeFile(join(root, "lease.sqlite"), "not a sqlite database", { mode: 0o600 });
    await expect(open(config(root))).rejects.toMatchObject({ code: "STATE_CORRUPT" });
  });

  it("rejects presence symlinks and registry path swaps", async () => {
    const parent = await temp();
    const root = join(parent, "state");
    const registry = join(parent, "registry");
    await mkdir(registry, { mode: 0o700 });
    const external = join(parent, "external.json");
    await writeFile(external, "external", { mode: 0o600 });
    await symlink(external, join(registry, "agent.json"));
    const withPresence = presenceConfig(root, registry);
    const linked = await open(withPresence);
    await expect(linked.start({ signal })).rejects.toMatchObject({ code: "STATE_PATH_INSECURE" });
    await linked.close();

    await rm(join(registry, "agent.json"));
    let swap = true;
    const swapping = await StateLocalStore.open(withPresence, {
      instanceId: "presence-swap-test",
      signal,
      hooks: {
        presence: {
          beforeRename: async () => {
            if (!swap) return;
            swap = false;
            await rename(registry, `${registry}.moved`);
            await mkdir(registry, { mode: 0o700 });
          },
        },
      },
    });
    await expect(swapping.start({ signal })).rejects.toMatchObject({ code: "STATE_PATH_CHANGED" });
    await swapping.close();
  });

  it("never overwrites an unrelated private file selected as a presence target", async () => {
    const parent = await temp();
    const root = join(parent, "state");
    const registry = join(parent, "registry");
    await mkdir(registry, { mode: 0o700 });
    const target = join(registry, "agent.json");
    const unrelated = Buffer.from('{"important":"data"}\n', "utf8");
    await writeFile(target, unrelated, { mode: 0o600 });
    const store = await open(presenceConfig(root, registry));
    await expect(store.start({ signal })).rejects.toMatchObject({ code: "STATE_CORRUPT" });
    expect(await readFile(target)).toEqual(unrelated);
    await store.close();

    const collision = await open({
      ...config(root),
      discovery: {
        registryDirectory: root,
        sourceId: "records",
        sourceLabel: "Collision",
        heartbeatMs: 60_000,
      },
    });
    await expect(collision.start({ signal })).rejects.toMatchObject({ code: "STATE_CORRUPT" });
    await collision.close();
    const reopened = await open(config(root));
    await reopened.close();
  });

  it("fails closed when an internal presence payload is corrupt", async () => {
    const parent = await temp();
    const root = join(parent, "state");
    const store = await open(config(root));
    await store.upsertPresence({
      presence: {
        presenceId: "corrupt-me",
        agentId: "agent",
        instanceId: "instance",
        updatedAt: "2026-07-23T12:00:00.000Z",
        expiresAt: "2026-07-23T12:01:00.000Z",
      },
      signal,
    });
    await store.close();

    const path = join(root, "records.json");
    const snapshot = JSON.parse(await readFile(path, "utf8")) as {
      records: Array<{ key: string; valueBase64: string }>;
    };
    const presence = snapshot.records.find((record) => record.key.includes("/presence/"));
    if (presence === undefined) throw new Error("Expected internal presence record.");
    presence.valueBase64 = Buffer.from("not presence json", "utf8").toString("base64");
    await writeFile(path, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
    await expect(open(config(root))).rejects.toMatchObject({ code: "STATE_CORRUPT" });
  });
});

async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-state-security-"));
  roots.push(root);
  return root;
}

function config(root: string): ResolvedStateLocalConfig {
  return {
    root,
    maxRecordBytes: 1024,
    maxRecords: 100,
    maxTotalBytes: 10_000,
  };
}

function presenceConfig(root: string, registryDirectory: string): ResolvedStateLocalConfig {
  return {
    ...config(root),
    discovery: {
      registryDirectory,
      sourceId: "agent",
      sourceLabel: "Agent",
      heartbeatMs: 60_000,
    },
  };
}

function open(value: ResolvedStateLocalConfig) {
  return StateLocalStore.open(value, {
    instanceId: "security-test",
    signal,
  });
}
