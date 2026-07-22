import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { openMemoryDb, type MemoryRecord } from "../../store/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { appendBullet, dailyFilePath } from "../daily.js";
import {
  applyExplicitMemoryForget,
  ExplicitMemoryForgetError,
  resolveExplicitMemoryForgetRoot,
  restoreExplicitMemoryForget,
} from "../explicit-forget.js";
import { acquireMemoryWriterLease, resolveActiveMemoryDbPath } from "../generations.js";
import { parseDailyFile } from "../grammar.js";
import { safeRebuildMemoryIndex } from "../rebuild.js";
import {
  initializeReplayProjection,
  readBujoCanonicalSourceFingerprint,
} from "../replay-projection.js";
import type { Bullet } from "../types.js";
import { fakeEmbeddings } from "./helpers.js";

const DIM = 16;
const NOW = new Date("2026-07-14T10:00:00.000Z");
const CREATED = new Date("2026-05-01T10:00:00.000Z");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("explicit memory forget coordinator", { timeout: 15_000 }, () => {
  it("applies and atomically restores one content-free full-root backup", async () => {
    const fixture = await managedFixture();
    const originalTree = treeDigest(fixture.root);
    const applied = await applyExplicitMemoryForget(options(fixture));

    expect(applied).toMatchObject({ status: "applied", forgotten: 1 });
    expect(recordStatus(fixture.root, fixture.id)).toBe("dropped");
    expect(readFileSync(join(applied.backupPath, "manifest.json"), "utf8")).not.toContain(fixture.text);

    const restored = await restoreExplicitMemoryForget({
      root: fixture.root,
      backupPath: applied.backupPath,
      expectedRootFingerprint: fixture.rootFingerprint,
    });
    expect(restored.status).toBe("restored");
    expect(recordStatus(fixture.root, fixture.id)).toBe("open");
    expect(treeDigest(fixture.root)).toBe(originalTree);
    expect(existsSync(join(applied.backupPath, "snapshot"))).toBe(false);
  });

  it("restores the exact pre-apply tree when a post-mutation step fails", async () => {
    const fixture = await managedFixture();
    const before = treeDigest(fixture.root);
    await expect(applyExplicitMemoryForget({
      ...options(fixture),
      hooks: { afterMutation: () => { throw new Error("injected post-mutation failure"); } },
    })).rejects.toMatchObject({
      code: "apply_failed_recovered",
      backupPath: expect.any(String),
    });

    expect(treeDigest(fixture.root)).toBe(before);
    expect(recordStatus(fixture.root, fixture.id)).toBe("open");
    expect(existsSync(join(dirnameOf(fixture.root), ".memory.maintenance.json"))).toBe(false);
    const lease = acquireMemoryWriterLease(fixture.root);
    lease.release();
  });

  it("refuses arbitrary suffix files and tampered snapshots before replacing the root", async () => {
    const fixture = await managedFixture();
    const applied = await applyExplicitMemoryForget(options(fixture));
    const appliedTree = treeDigest(fixture.root);
    const durableSuffix = join(fixture.root, "operator-notes-shm");
    writeFileSync(durableSuffix, "operator data\n", "utf8");
    await expect(restoreExplicitMemoryForget({
      root: fixture.root,
      backupPath: applied.backupPath,
      expectedRootFingerprint: fixture.rootFingerprint,
    })).rejects.toMatchObject({ code: "restore_failed" });
    expect(readFileSync(durableSuffix, "utf8")).toBe("operator data\n");
    rmSync(durableSuffix);

    const snapshotDaily = firstDaily(join(applied.backupPath, "snapshot"));
    writeFileSync(snapshotDaily, `${readFileSync(snapshotDaily, "utf8")}\n`, "utf8");
    await expect(restoreExplicitMemoryForget({
      root: fixture.root,
      backupPath: applied.backupPath,
      expectedRootFingerprint: fixture.rootFingerprint,
    })).rejects.toMatchObject({ code: "restore_failed" });
    expect(treeDigest(fixture.root)).toBe(appliedTree);
    expect(recordStatus(fixture.root, fixture.id)).toBe("dropped");
  });

  it("rolls back an interrupted root swap and can retry restore", async () => {
    const fixture = await managedFixture();
    const applied = await applyExplicitMemoryForget(options(fixture));
    const appliedTree = treeDigest(fixture.root);
    await expect(restoreExplicitMemoryForget({
      root: fixture.root,
      backupPath: applied.backupPath,
      expectedRootFingerprint: fixture.rootFingerprint,
      hooks: { afterRootQuarantined: () => { throw new Error("injected activation failure"); } },
    })).rejects.toMatchObject({ code: "restore_failed" });
    expect(treeDigest(fixture.root)).toBe(appliedTree);
    expect(existsSync(join(applied.backupPath, "snapshot"))).toBe(true);

    await expect(restoreExplicitMemoryForget({
      root: fixture.root,
      backupPath: applied.backupPath,
      expectedRootFingerprint: fixture.rootFingerprint,
    })).resolves.toMatchObject({ status: "restored" });
    expect(recordStatus(fixture.root, fixture.id)).toBe("open");
  });

  it("rejects root symlinks and over-cap batches before provider work", async () => {
    const fixture = await managedFixture();
    const linked = join(dirnameOf(fixture.root), "linked-memory");
    symlinkSync(fixture.root, linked, "dir");
    expect(() => resolveExplicitMemoryForgetRoot(linked)).toThrow(/symlink/iu);

    const embed = vi.fn(async (texts: readonly string[]) => texts.map(() => new Array(DIM).fill(0)));
    await expect(applyExplicitMemoryForget({
      ...options(fixture),
      ids: Array.from({ length: 33 }, (_, index) => `MEM-${index}`),
      embeddings: { id: `fake-${DIM}`, embed },
    })).rejects.toBeInstanceOf(ExplicitMemoryForgetError);
    expect(embed).not.toHaveBeenCalled();
  });

  it("blocks every normal writer while a durable maintenance transaction exists", async () => {
    const fixture = await managedFixture();
    const transactionPath = join(dirnameOf(fixture.root), ".memory.maintenance.json");
    writeFileSync(transactionPath, "{}\n", { encoding: "utf8", mode: 0o600 });
    expect(() => acquireMemoryWriterLease(fixture.root)).toThrow(/requires recovery/iu);
    rmSync(transactionPath);
    const lease = acquireMemoryWriterLease(fixture.root);
    lease.release();
  });

  it("rechecks the maintenance marker after acquiring the root writer lease", async () => {
    const fixture = await managedFixture();
    const marker = join(dirnameOf(fixture.root), ".memory.maintenance.json");
    expect(() => acquireMemoryWriterLease(fixture.root, {
      afterCreate: () => writeFileSync(marker, "{}\n", { encoding: "utf8", mode: 0o600 }),
    })).toThrow(/requires recovery/iu);
    expect(existsSync(join(fixture.root, ".index", "writer.lock"))).toBe(false);
    rmSync(marker);
  });

  it("rejects mtime-only tampering of both the backup and current root", async () => {
    const snapshotFixture = await managedFixture();
    const snapshotApplied = await applyExplicitMemoryForget(options(snapshotFixture));
    const snapshotDaily = firstDaily(join(snapshotApplied.backupPath, "snapshot"));
    const snapshotMtime = statSync(snapshotDaily).mtime;
    utimesSync(snapshotDaily, snapshotMtime, new Date(snapshotMtime.valueOf() - 60_000));
    await expect(restoreExplicitMemoryForget({
      root: snapshotFixture.root,
      backupPath: snapshotApplied.backupPath,
      expectedRootFingerprint: snapshotFixture.rootFingerprint,
    })).rejects.toMatchObject({ code: "restore_failed" });

    const currentFixture = await managedFixture();
    const currentApplied = await applyExplicitMemoryForget(options(currentFixture));
    const currentDaily = firstDaily(currentFixture.root);
    const currentMtime = statSync(currentDaily).mtime;
    utimesSync(currentDaily, currentMtime, new Date(currentMtime.valueOf() - 60_000));
    await expect(restoreExplicitMemoryForget({
      root: currentFixture.root,
      backupPath: currentApplied.backupPath,
      expectedRootFingerprint: currentFixture.rootFingerprint,
    })).rejects.toMatchObject({ code: "restore_failed" });
  });

  it("reuses a verified prepared backup after the pre-marker crash window", async () => {
    const fixture = await managedFixture();
    await expect(applyExplicitMemoryForget({
      ...options(fixture),
      hooks: { afterBackupDurable: () => { throw new Error("simulated abrupt stop"); } },
    })).rejects.toMatchObject({ code: "apply_failed", backupPath: expect.any(String) });
    await expect(applyExplicitMemoryForget(options(fixture))).resolves.toMatchObject({
      status: "applied",
      forgotten: 1,
    });
  });

  it("reclaims an old incomplete stopped-store lease after an acquisition crash", async () => {
    const fixture = await managedFixture();
    const lock = join(dirnameOf(fixture.root), ".memory.maintenance.lock");
    writeFileSync(lock, "", { encoding: "utf8", mode: 0o600 });
    const stale = new Date(Date.now() - 5_000);
    utimesSync(lock, stale, stale);
    await expect(applyExplicitMemoryForget(options(fixture))).resolves.toMatchObject({ status: "applied" });
  });

  it("never age-reaps a complete stopped-store lease owned by a live process", async () => {
    const fixture = await managedFixture();
    const lock = join(dirnameOf(fixture.root), ".memory.maintenance.lock");
    const liveRecord = {
      schemaVersion: 1,
      pid: process.pid,
      ...(typeof process.getuid === "function" ? { uid: process.getuid() } : {}),
      token: "live-old-maintenance-lease",
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString(),
    };
    writeFileSync(lock, `${JSON.stringify(liveRecord)}\n`, { encoding: "utf8", mode: 0o600 });

    await expect(applyExplicitMemoryForget(options(fixture))).rejects.toThrow(/another stopped-store operator is active/iu);
    expect(JSON.parse(readFileSync(lock, "utf8"))).toEqual(liveRecord);
    expect(recordStatus(fixture.root, fixture.id)).toBe("open");
  });

  it("preserves exact modes and legacy-significant mtimes under a restrictive umask", async () => {
    const fixture = await managedFixture();
    const daily = firstDaily(fixture.root);
    const dailyDirectory = join(fixture.root, "daily");
    const timestamp = new Date("2020-02-03T04:05:06.000Z");
    chmodSync(daily, 0o644);
    chmodSync(dailyDirectory, 0o755);
    utimesSync(daily, timestamp, timestamp);
    utimesSync(dailyDirectory, timestamp, timestamp);

    const applied = await applyExplicitMemoryForget(options(fixture));
    const snapshotDaily = join(applied.backupPath, "snapshot", relative(fixture.root, daily));
    expect(statSync(snapshotDaily).mode & 0o777).toBe(0o644);
    expect(statSync(join(applied.backupPath, "snapshot", "daily")).mode & 0o777).toBe(0o755);
    expect(statSync(snapshotDaily).mtimeMs).toBe(timestamp.valueOf());

    await restoreExplicitMemoryForget({
      root: fixture.root,
      backupPath: applied.backupPath,
      expectedRootFingerprint: fixture.rootFingerprint,
    });
    expect(statSync(daily).mode & 0o777).toBe(0o644);
    expect(statSync(daily).mtimeMs).toBe(timestamp.valueOf());
  });

  it("rewinds failed automatic recovery and succeeds on the next recovery attempt", async () => {
    const fixture = await managedFixture();
    await expect(applyExplicitMemoryForget({
      ...options(fixture),
      hooks: {
        afterMutation: () => { throw new Error("force automatic recovery"); },
        afterRootQuarantined: () => { throw new Error("interrupt automatic recovery"); },
      },
    })).rejects.toMatchObject({ code: "apply_recovery_failed" });
    expect(JSON.parse(readFileSync(transactionPath(fixture.root), "utf8"))).toMatchObject({ phase: "applying" });

    await expect(applyExplicitMemoryForget(options(fixture))).rejects.toMatchObject({
      code: "apply_failed_recovered",
    });
    expect(recordStatus(fixture.root, fixture.id)).toBe("open");
    expect(existsSync(transactionPath(fixture.root))).toBe(false);
  });

  it("recovers both predecessor-phase root-rename crash layouts", async () => {
    const first = await managedFixture();
    const firstApplied = await applyExplicitMemoryForget(options(first));
    publishCrashTransaction(first, firstApplied.backupPath, "restore-prepared");
    renameSync(first.root, join(firstApplied.backupPath, "post-root"));
    expect(resolveExplicitMemoryForgetRoot(first.root)).toBe(join(realpathSync(dirnameOf(first.root)), "memory"));
    await expect(restoreExplicitMemoryForget({
      root: first.root,
      backupPath: firstApplied.backupPath,
      expectedRootFingerprint: first.rootFingerprint,
    })).resolves.toMatchObject({ status: "restored" });
    expect(recordStatus(first.root, first.id)).toBe("open");

    const second = await managedFixture();
    const secondApplied = await applyExplicitMemoryForget(options(second));
    publishCrashTransaction(second, secondApplied.backupPath, "root-quarantined");
    renameSync(second.root, join(secondApplied.backupPath, "post-root"));
    renameSync(join(secondApplied.backupPath, "snapshot"), second.root);
    await expect(restoreExplicitMemoryForget({
      root: second.root,
      backupPath: secondApplied.backupPath,
      expectedRootFingerprint: second.rootFingerprint,
    })).resolves.toMatchObject({ status: "restored" });
    expect(recordStatus(second.root, second.id)).toBe("open");
  });

  it("binds restore to the actual root instead of an identical cross-root clone", async () => {
    const fixture = await managedFixture();
    const applied = await applyExplicitMemoryForget(options(fixture));
    const cloneParent = mkdtempSync(join(tmpdir(), "explicit-forget-clone-"));
    roots.push(cloneParent);
    const cloneRoot = join(cloneParent, "memory");
    cpSync(fixture.root, cloneRoot, { recursive: true, preserveTimestamps: true });
    const cloneBefore = treeDigest(cloneRoot);

    await expect(restoreExplicitMemoryForget({
      root: cloneRoot,
      backupPath: applied.backupPath,
      expectedRootFingerprint: fixture.rootFingerprint,
    })).rejects.toMatchObject({ code: "restore_failed" });
    expect(treeDigest(cloneRoot)).toBe(cloneBefore);
    expect(recordStatus(cloneRoot, fixture.id)).toBe("dropped");
    expect(recordStatus(fixture.root, fixture.id)).toBe("dropped");

    publishCrashTransaction({ ...fixture, root: cloneRoot }, applied.backupPath, "restore-prepared");
    await expect(applyExplicitMemoryForget({
      ...options(fixture),
      root: cloneRoot,
    })).rejects.toMatchObject({ code: "apply_recovery_failed" });
    expect(treeDigest(cloneRoot)).toBe(cloneBefore);
  });

  it("rejects transaction markers that do not match the bound backup manifest", async () => {
    const fixture = await managedFixture();
    const applied = await applyExplicitMemoryForget(options(fixture));
    const marker = transactionPath(fixture.root);
    publishCrashTransaction(fixture, applied.backupPath, "restore-prepared");
    const valid = JSON.parse(readFileSync(marker, "utf8")) as Record<string, unknown>;
    const before = treeDigest(fixture.root);

    for (const [field, value] of [
      ["planDigest", "0".repeat(64)],
      ["originalTreeFingerprint", "1".repeat(64)],
    ] as const) {
      writeFileSync(marker, `${JSON.stringify({ ...valid, [field]: value })}\n`, { encoding: "utf8", mode: 0o600 });
      await expect(restoreExplicitMemoryForget({
        root: fixture.root,
        backupPath: applied.backupPath,
        expectedRootFingerprint: fixture.rootFingerprint,
      })).rejects.toMatchObject({ code: "restore_failed" });
      await expect(applyExplicitMemoryForget(options(fixture))).rejects.toMatchObject({
        code: "apply_recovery_failed",
      });
      expect(treeDigest(fixture.root)).toBe(before);
      expect(existsSync(join(applied.backupPath, "snapshot"))).toBe(true);
    }
  });

  it("ignores incomplete unpublished staging artifacts", async () => {
    const fixture = await managedFixture();
    const prefix = join(
      dirnameOf(fixture.root),
      `.memory-forget-backup-${fixture.planDigest.slice(0, 24)}`,
    );
    mkdirSync(`${prefix}.tmp-stale`, { mode: 0o700 });
    writeFileSync(`${transactionPath(fixture.root)}.publish-stale`, "{", { mode: 0o600 });
    await expect(applyExplicitMemoryForget(options(fixture))).resolves.toMatchObject({ status: "applied" });
  });

  it("validates rebuild options before acquiring the writer lease", async () => {
    const fixture = await managedFixture();
    await expect(safeRebuildMemoryIndex({
      root: fixture.root,
      tier: "lite",
      embeddings: fakeEmbeddings(DIM),
      dim: DIM,
    } as Parameters<typeof safeRebuildMemoryIndex>[0])).rejects.toThrow(/lite rebuild rejects/iu);
    const lease = acquireMemoryWriterLease(fixture.root);
    lease.release();
  });
});

async function managedFixture(): Promise<{
  root: string;
  id: string;
  text: string;
  rootFingerprint: string;
  sourceFingerprint: string;
  planDigest: string;
}> {
  const parent = mkdtempSync(join(tmpdir(), "explicit-forget-"));
  roots.push(parent);
  const root = join(parent, "memory");
  mkdirSync(root, { mode: 0o700 });
  initializeReplayProjection(root);
  const embeddings = fakeEmbeddings(DIM);
  const db = openMemoryDb({ path: join(root, "memory.db"), embeddings, dim: DIM });
  const id = "EXPLICIT-COORDINATOR";
  const text = "private explicit coordinator sentinel";
  const bullet: Bullet = {
    id,
    type: "note",
    status: "open",
    text,
    salience: 0.2,
    isInsight: false,
    createdAt: CREATED.toISOString(),
    refs: [],
  };
  appendBullet(root, bullet, CREATED);
  const record: MemoryRecord = {
    id,
    type: "note",
    status: "open",
    text,
    salience: 0.2,
    isInsight: false,
    createdAt: CREATED.toISOString(),
    accessCount: 0,
    tags: [],
    source: { file: relative(root, dailyFilePath(root, CREATED)) },
  };
  await db.upsert(record);
  db.checkpoint();
  db.close();
  await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings, dim: DIM });
  const canonical = realpathSync(root);
  return {
    root,
    id,
    text,
    rootFingerprint: createHash("sha256").update(canonical).digest("hex"),
    sourceFingerprint: readBujoCanonicalSourceFingerprint(root),
    planDigest: createHash("sha256").update(`plan:${id}`).digest("hex"),
  };
}

function options(fixture: Awaited<ReturnType<typeof managedFixture>>) {
  return {
    root: fixture.root,
    ids: [fixture.id],
    expectedRootFingerprint: fixture.rootFingerprint,
    expectedSourceFingerprint: fixture.sourceFingerprint,
    planDigest: fixture.planDigest,
    embeddings: fakeEmbeddings(DIM),
    dimension: DIM,
    now: () => NOW,
  };
}

function recordStatus(root: string, id: string): string | undefined {
  const db = openMemoryDb({ path: resolveActiveMemoryDbPath(root), readOnly: true, dim: DIM });
  try { return db.get(id)?.status; } finally { db.close(); }
}

function firstDaily(root: string): string {
  const name = readdirSync(join(root, "daily")).sort()[0]!;
  const path = join(root, "daily", name);
  expect(parseDailyFile(readFileSync(path, "utf8")).bullets.length).toBeGreaterThan(0);
  return path;
}

function treeDigest(root: string): string {
  const hash = createHash("sha256");
  const walk = (path: string, rel: string): void => {
    const info = lstatSync(path);
    if (info.isDirectory()) {
      hash.update(`d\0${rel}\0${info.mode & 0o777}\0`);
      for (const name of readdirSync(path).sort()) {
        const child = rel === "." ? name : join(rel, name);
        if (child === join(".index", "writer.lock") || child.endsWith("-shm") || child.endsWith("-wal")) continue;
        walk(join(path, name), child);
      }
      return;
    }
    hash.update(`f\0${rel}\0${info.mode & 0o777}\0`);
    hash.update(readFileSync(path));
  };
  walk(root, ".");
  return hash.digest("hex");
}

function dirnameOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

function transactionPath(root: string): string {
  return join(dirnameOf(root), `.${root.slice(root.lastIndexOf("/") + 1)}.maintenance.json`);
}

function publishCrashTransaction(
  fixture: Awaited<ReturnType<typeof managedFixture>>,
  backupPath: string,
  phase: "restore-prepared" | "root-quarantined",
): void {
  const manifest = JSON.parse(readFileSync(join(backupPath, "manifest.json"), "utf8")) as {
    readonly treeFingerprint: string;
    readonly planDigest: string;
    readonly postTreeFingerprint: string;
  };
  writeFileSync(transactionPath(fixture.root), `${JSON.stringify({
    schemaVersion: 1,
    operation: "memory-forget",
    phase,
    rootFingerprint: fixture.rootFingerprint,
    backupPath,
    planDigest: manifest.planDigest,
    originalTreeFingerprint: manifest.treeFingerprint,
    expectedCurrentTreeFingerprint: manifest.postTreeFingerprint,
  })}\n`, { encoding: "utf8", mode: 0o600 });
}
