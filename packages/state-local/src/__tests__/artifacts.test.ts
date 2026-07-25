// SPDX-License-Identifier: MIT
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseStateLocalConfig,
  resolveStateLocalConfig,
  type ResolvedStateLocalConfig,
} from "../config.js";
import { readSecureFile } from "../secure-fs.js";
import { StateLocalStore } from "../store.js";

const roots: string[] = [];
const signal = new AbortController().signal;

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe("state-local artifacts", () => {
  it("atomically stores, deduplicates, reads, lists, and reopens content-addressed bytes", async () => {
    const config = await createConfig();
    const store = await open(config);
    const data = Buffer.from("artifact body", "utf8");
    const ref = await store.putArtifact({
      data,
      mediaType: "text/plain",
      fileName: "result.txt",
      signal,
    });

    expect(ref).toEqual({
      id: "artifact:sha256:9938be87d35f2a7a2b80237e8dc71806b209aaea8252f12c1b12949f61d40476",
      sha256: "sha256:9938be87d35f2a7a2b80237e8dc71806b209aaea8252f12c1b12949f61d40476",
      sizeBytes: data.byteLength,
      mediaType: "text/plain",
      fileName: "result.txt",
    });
    expect(JSON.stringify(ref)).not.toContain(config.root);
    expect(Buffer.from(await store.readArtifact({
      ref,
      maxBytes: data.byteLength,
      signal,
    }))).toEqual(data);
    await expect(store.readArtifact({
      ref,
      maxBytes: data.byteLength - 1,
      signal,
    })).rejects.toMatchObject({ code: "STATE_LIMIT_EXCEEDED" });

    const duplicate = await store.putArtifact({
      data,
      mediaType: "application/json",
      fileName: "same-bytes.json",
      signal,
    });
    expect(duplicate.id).toBe(ref.id);
    expect(duplicate.mediaType).toBe("application/json");
    expect((await store.listArtifacts({ limit: 10, signal })).artifacts).toEqual([{
      id: ref.id,
      sha256: ref.sha256,
      sizeBytes: data.byteLength,
      mediaType: "application/octet-stream",
    }]);

    const artifactsDirectory = join(config.root, "artifacts");
    const blobPath = await onlyArtifactBlob(artifactsDirectory);
    expect((await stat(artifactsDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(blobPath)).mode & 0o777).toBe(0o600);

    await store.close();
    const reopened = await open(config);
    expect(Buffer.from(await reopened.readArtifact({
      ref,
      maxBytes: data.byteLength,
      signal,
    }))).toEqual(data);
    expect(await reopened.deleteArtifact({ ref, signal })).toBe(false);
    expect(Buffer.from(await reopened.readArtifact({
      ref,
      maxBytes: data.byteLength,
      signal,
    }))).toEqual(data);
    await reopened.close();
  });

  it("retains a shared content-addressed blob when either duplicate reference requests deletion", async () => {
    const config = await createConfig();
    const store = await open(config);
    const data = bytes("shared artifact");
    const first = await store.putArtifact({
      data,
      mediaType: "text/plain",
      fileName: "first.txt",
      signal,
    });
    const second = await store.putArtifact({
      data,
      mediaType: "application/json",
      fileName: "second.json",
      signal,
    });
    expect(second.id).toBe(first.id);

    expect(await store.deleteArtifact({ ref: first, signal })).toBe(false);
    expect(Buffer.from(await store.readArtifact({
      ref: second,
      maxBytes: data.byteLength,
      signal,
    }))).toEqual(data);
    expect((await store.listArtifacts({ limit: 10, signal })).artifacts).toHaveLength(1);
    await store.close();
  });

  it("never exposes a durable orphan when publication crashes before the index commit", async () => {
    const config = await createConfig();
    let crash = true;
    const store = await StateLocalStore.open(config, {
      instanceId: "artifact-crash-test",
      signal,
      hooks: {
        artifacts: {
          beforeIndexCommit: () => {
            if (!crash) return;
            crash = false;
            throw new Error("simulated crash before artifact index commit");
          },
        },
      },
    });
    const data = bytes("durable but unpublished");
    await expect(store.putArtifact({ data, mediaType: "text/plain", signal }))
      .rejects.toThrow("simulated crash");
    expect((await store.listArtifacts({ limit: 10, signal })).artifacts).toEqual([]);
    const artifactDirectory = join(config.root, "artifacts");
    expect((await readdir(artifactDirectory)).filter((name) => /^artifact-.*\.blob$/u.test(name)))
      .toHaveLength(1);
    await store.close();

    const reopened = await open(config);
    expect((await reopened.listArtifacts({ limit: 10, signal })).artifacts).toEqual([]);
    const ref = await reopened.putArtifact({ data, mediaType: "text/plain", signal });
    expect(Buffer.from(await reopened.readArtifact({
      ref,
      maxBytes: data.byteLength,
      signal,
    }))).toEqual(data);
    expect((await reopened.listArtifacts({ limit: 10, signal })).artifacts).toHaveLength(1);
    await reopened.close();
  });

  it("never touches a rollback-journal hardlink injected before artifact index commit", async () => {
    const config = await createConfig();
    const external = join(config.root, "..", "operator-artifact-journal");
    const operatorBytes = bytes("external artifact journal bytes");
    await writeFile(external, operatorBytes, { mode: 0o600 });
    let sidecar = "";
    const store = await StateLocalStore.open(config, {
      instanceId: "artifact-journal-hardlink",
      signal,
      hooks: {
        artifacts: {
          beforeIndexCommit: async (target) => {
            sidecar = join(dirname(target), ".mono-agent-artifacts.lease.sqlite-journal");
            await link(external, sidecar);
          },
        },
      },
    });

    await expect(store.putArtifact({
      data: bytes("artifact whose index commit is attacked"),
      mediaType: "text/plain",
      signal,
    })).rejects.toMatchObject({ code: "STATE_PATH_INSECURE" });
    expect(await readFile(external)).toEqual(operatorBytes);
    expect(await readFile(sidecar)).toEqual(operatorBytes);
    await expect(store.close()).rejects.toMatchObject({ code: "STATE_PATH_INSECURE" });
    expect(await readFile(external)).toEqual(operatorBytes);
    expect(await readFile(sidecar)).toEqual(operatorBytes);
  });

  it("never clobbers a colliding immutable artifact target", async () => {
    const config = await createConfig();
    const operatorBytes = bytes("operator-owned collision");
    let collidedPath: string | undefined;
    const store = await StateLocalStore.open(config, {
      instanceId: "artifact-collision-test",
      signal,
      hooks: {
        artifacts: {
          beforePublish: async (target) => {
            collidedPath = target;
            await writeFile(target, operatorBytes, { mode: 0o600, flag: "wx" });
          },
        },
      },
    });

    await expect(store.putArtifact({
      data: bytes("requested artifact"),
      mediaType: "text/plain",
      signal,
    })).rejects.toMatchObject({ code: "STATE_CORRUPT" });
    expect(collidedPath).toEqual(expect.any(String));
    expect(await readFile(collidedPath!)).toEqual(operatorBytes);
    await store.close();
  });

  it("binds list cursors to the exact artifact snapshot", async () => {
    const store = await open(await createConfig());
    await store.putArtifact({ data: bytes("one"), mediaType: "text/plain", signal });
    await store.putArtifact({ data: bytes("two"), mediaType: "text/plain", signal });
    const first = await store.listArtifacts({ limit: 1, signal });
    expect(first.artifacts).toHaveLength(1);
    expect(first.cursor).toEqual(expect.any(String));
    const cursor = first.cursor;
    if (cursor === undefined) throw new Error("Expected an artifact cursor.");
    expect((await store.listArtifacts({ cursor, limit: 1, signal })).artifacts).toHaveLength(1);

    await store.putArtifact({ data: bytes("three"), mediaType: "text/plain", signal });
    await expect(store.listArtifacts({ cursor, limit: 1, signal }))
      .rejects.toMatchObject({ code: "STATE_INVALID_CURSOR" });
    await store.close();
  });

  it("resolves PRD-shaped run config and keeps retention separate from deletion authority", async () => {
    const parent = await temp();
    const parsed = parseStateLocalConfig({
      root: "./state",
      runs: {
        artifactsDirectory: "./run-artifacts",
        retentionDays: 14,
      },
    });
    const resolved = resolveStateLocalConfig(parsed, parent);
    expect(resolved.runs).toEqual({
      artifactsDirectory: join(parent, "run-artifacts"),
      retentionDays: 14,
    });
    const store = await open(resolved);
    expect(store.artifactRetentionDays).toBe(14);
    await store.close();

    const defaultResolved = resolveStateLocalConfig(parseStateLocalConfig({
      root: "./other-state",
    }), parent);
    expect(defaultResolved.runs?.artifactsDirectory).toBe(join(parent, "other-state", "artifacts"));
    expect(() => parseStateLocalConfig({
      runs: { artifactsDirectory: "./artifacts", retentionDays: 0 },
    })).toThrow(/retentionDays/u);
    expect(() => parseStateLocalConfig({
      runs: { artifactsDirectory: "./artifacts", retentionDays: 30, cleanup: true },
    })).toThrow(/unknown field/u);
  });

  it("detects artifact corruption, insecure links, and directory identity swaps", async () => {
    const config = await createConfig();
    const store = await open(config);
    const ref = await store.putArtifact({
      data: bytes("original"),
      mediaType: "text/plain",
      signal,
    });
    const directory = join(config.root, "artifacts");
    const path = await onlyArtifactBlob(directory);
    await writeFile(path, "tampered", { mode: 0o600 });
    await expect(store.readArtifact({ ref, maxBytes: 8, signal }))
      .rejects.toMatchObject({ code: "STATE_CORRUPT" });
    await store.close();

    await writeFile(path, "original", { mode: 0o600 });
    const moved = `${path}.real`;
    await rename(path, moved);
    await symlink(moved, path);
    await expect(open(config)).rejects.toMatchObject({ code: "STATE_PATH_INSECURE" });
    await rm(path);
    await link(moved, path);
    await expect(open(config)).rejects.toMatchObject({ code: "STATE_PATH_INSECURE" });

    await rm(path);
    await rename(moved, path);
    const swapping = await open(config);
    await rename(directory, `${directory}.moved`);
    await mkdir(directory, { mode: 0o700 });
    await expect(swapping.listArtifacts({ limit: 10, signal }))
      .rejects.toMatchObject({ code: "STATE_PATH_CHANGED" });
    await swapping.close();
  });

  it("retains recognizable interrupted writes and refuses unsafe cleanup or unrelated directories", async () => {
    const config = await createConfig();
    const store = await open(config);
    await store.close();
    const directory = join(config.root, "artifacts");
    const interrupted = join(
      directory,
      ".aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.blob.123.123e4567-e89b-12d3-a456-426614174000.tmp",
    );
    await writeFile(interrupted, "partial", { mode: 0o600 });
    await expect(open(config)).rejects.toMatchObject({ code: "STATE_CORRUPT" });
    expect(await readFile(interrupted, "utf8")).toBe("partial");

    const parent = await temp();
    const unrelated = join(parent, "unrelated");
    await mkdir(unrelated, { mode: 0o700 });
    const important = join(unrelated, "important");
    await writeFile(important, "keep", { mode: 0o600 });
    await expect(open({
      ...baseConfig(join(parent, "state")),
      runs: { artifactsDirectory: unrelated, retentionDays: 30 },
    })).rejects.toMatchObject({ code: "STATE_CORRUPT" });
    expect(await readFile(important, "utf8")).toBe("keep");
    await expect(lstat(join(unrelated, ".mono-agent-artifacts")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses bounded no-follow descriptor reads for exact, oversized, empty, and aborted files", async () => {
    const parent = await temp();
    const path = join(parent, "secure.bin");
    await writeFile(path, "12345", { mode: 0o600 });
    await chmod(path, 0o600);
    expect((await readSecureFile(path, 5)).bytes.toString("utf8")).toBe("12345");
    await expect(readSecureFile(path, 4)).rejects.toMatchObject({ code: "STATE_CORRUPT" });

    const empty = join(parent, "empty.bin");
    await writeFile(empty, new Uint8Array(), { mode: 0o600 });
    expect((await readSecureFile(empty, 0)).bytes).toHaveLength(0);

    const aborted = new AbortController();
    aborted.abort(new Error("stop"));
    await expect(readSecureFile(path, 5, aborted.signal))
      .rejects.toMatchObject({ code: "STATE_ABORTED" });

    const external = join(parent, "external.bin");
    await writeFile(external, "external", { mode: 0o600 });
    const linked = join(parent, "linked.bin");
    await symlink(external, linked);
    await expect(readSecureFile(linked, 100))
      .rejects.toMatchObject({ code: expect.stringMatching(/STATE_(?:CORRUPT|PATH_INSECURE)/u) });
  });
});

async function createConfig(): Promise<ResolvedStateLocalConfig> {
  const parent = await temp();
  return baseConfig(join(parent, "state"));
}

async function onlyArtifactBlob(directory: string): Promise<string> {
  const names = (await readdir(directory)).filter((name) => /^artifact-.*\.blob$/u.test(name));
  expect(names).toHaveLength(1);
  return join(directory, names[0]!);
}

function baseConfig(root: string): ResolvedStateLocalConfig {
  return {
    root,
    maxRecordBytes: 1_024,
    maxRecords: 100,
    maxTotalBytes: 10_000,
  };
}

function open(config: ResolvedStateLocalConfig): Promise<StateLocalStore> {
  return StateLocalStore.open(config, {
    instanceId: "artifact-test",
    signal,
    clock: () => new Date("2026-07-23T12:00:00.000Z"),
  });
}

async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-state-artifacts-"));
  roots.push(root);
  return root;
}

function bytes(value: string): Uint8Array {
  return Buffer.from(value, "utf8");
}
