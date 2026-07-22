import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { pruneExplicitMemoryForgetBackups } from "../forget-backup-retention.js";

const NOW = Date.parse("2026-07-17T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("memory forget-backup retention", () => {
  it("keeps the three newest root-bound snapshots and expires old/stale residues", async () => {
    const root = await memoryFixture();
    const newestManaged = await writeManaged(root, "a", 1, "applied");
    const second = await writeOperator(root, "forget-second", 2);
    const thirdManaged = await writeManaged(root, "c", 3, "prepared");
    const overCount = await writeOperator(root, "forget-fourth", 4);
    const expired = await writeOperator(root, "forget-expired", 40);
    const recovered = await writeManaged(root, "f", 0, "recovered");
    const staging = await writeStaging(root, "e", 40);

    const result = await pruneExplicitMemoryForgetBackups({ root, clock: () => NOW });

    expect(result).toMatchObject({
      candidateCount: 7,
      retainedCount: 3,
      prunedCount: 4,
      skippedForActiveMaintenance: false,
    });
    expect(result.prunedPaths).toEqual(expect.arrayContaining([
      "operator/forget-fourth",
      "operator/forget-expired",
      basename(recovered),
      basename(staging),
    ]));
    expect(existsSync(newestManaged)).toBe(true);
    expect(existsSync(second)).toBe(true);
    expect(existsSync(thirdManaged)).toBe(true);
    expect(existsSync(overCount)).toBe(false);
    expect(existsSync(expired)).toBe(false);
    expect(existsSync(recovered)).toBe(false);
    expect(existsSync(staging)).toBe(false);
  });

  it("reports the complete plan without deleting in dry-run mode", async () => {
    const root = await memoryFixture();
    for (let day = 1; day <= 4; day += 1) {
      await writeOperator(root, `forget-${day}`, day);
    }

    const result = await pruneExplicitMemoryForgetBackups({ root, dryRun: true, clock: () => NOW });

    expect(result).toMatchObject({ dryRun: true, candidateCount: 4, retainedCount: 3, prunedCount: 1 });
    expect(result.prunedPaths).toEqual(["operator/forget-4"]);
    expect(existsSync(join(dirname(root), "operator", "forget-4"))).toBe(true);
  });

  it("defers during recovery and preserves applying, foreign, and symlink candidates", async () => {
    const root = await memoryFixture();
    const oldOperator = await writeOperator(root, "forget-old", 40);
    const applying = await writeManaged(root, "a", 40, "applying");
    const foreign = await writeManaged(root, "b", 40, "applied", "0".repeat(64));
    const outside = await mkdtemp(join(tmpdir(), "forget-backup-outside-"));
    roots.push(outside);
    const linked = join(dirname(root), `.memory-forget-backup-${"c".repeat(24)}`);
    await symlink(outside, linked, "dir");
    const transaction = join(dirname(root), ".memory.maintenance.json");
    await writeFile(transaction, "{}\n", { encoding: "utf8", mode: 0o600 });

    const deferred = await pruneExplicitMemoryForgetBackups({ root, clock: () => NOW });
    expect(deferred.skippedForActiveMaintenance).toBe(true);
    expect(existsSync(oldOperator)).toBe(true);

    await rm(transaction);
    const result = await pruneExplicitMemoryForgetBackups({ root, clock: () => NOW });

    expect(result.prunedPaths).toEqual(["operator/forget-old"]);
    expect(result.warnings.join("\n")).toMatch(/applying backup was preserved|foreign manifest|unsafe directory/iu);
    expect(existsSync(applying)).toBe(true);
    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(linked)).toBe(true);
  });

  it("preserves old managed candidates rejected by the authoritative backup reader invariants", async () => {
    const root = await memoryFixture();
    const incomplete = await writeManaged(root, "1", 40, "applied");
    const incompleteManifest = join(incomplete, "manifest.json");
    const incompleteValue = JSON.parse(await readFile(incompleteManifest, "utf8")) as Record<string, unknown>;
    delete incompleteValue["sourceFingerprint"];
    await writeFile(incompleteManifest, `${JSON.stringify(incompleteValue)}\n`, "utf8");

    const publicManifest = await writeManaged(root, "2", 40, "applied");
    await chmod(join(publicManifest, "manifest.json"), 0o644);

    const linkedManifest = await writeManaged(root, "3", 40, "applied");
    await link(join(linkedManifest, "manifest.json"), join(linkedManifest, "manifest-copy.json"));

    const publicBackup = await writeManaged(root, "4", 40, "applied");
    await chmod(publicBackup, 0o755);

    const result = await pruneExplicitMemoryForgetBackups({ root, clock: () => NOW });

    expect(result).toMatchObject({ candidateCount: 0, prunedCount: 0 });
    expect(result.warnings.join("\n")).toMatch(/backup manifest is invalid|private artifact is unsafe|backup directory is unsafe/iu);
    for (const backup of [incomplete, publicManifest, linkedManifest, publicBackup]) {
      expect(existsSync(backup)).toBe(true);
    }
  });

  it("atomically claims a candidate and restores a raced replacement instead of deleting it", async () => {
    const root = await memoryFixture();
    const candidate = await writeOperator(root, "forget-raced", 40);
    const original = `${candidate}-original`;

    const result = await pruneExplicitMemoryForgetBackups({
      root,
      clock: () => NOW,
      hooks: {
        beforeClaim: async () => {
          await rename(candidate, original);
          await mkdir(candidate, { mode: 0o755 });
          await writeFile(join(candidate, "replacement.txt"), "keep\n", "utf8");
        },
      },
    });

    expect(result.prunedCount).toBe(0);
    expect(result.warnings.join("\n")).toMatch(/claimed directory identity changed/iu);
    expect(await readFile(join(candidate, "replacement.txt"), "utf8")).toBe("keep\n");
    expect(existsSync(original)).toBe(true);
    expect((await readdir(dirname(candidate))).some((name) => name.startsWith("forget-retention-"))).toBe(false);
  });

  it("restores the claim when cancellation arrives during final identity revalidation", async () => {
    const root = await memoryFixture();
    const candidate = await writeOperator(root, "forget-cancelled", 40);
    let claimed = false;
    let postClaimChecks = 0;

    const result = await pruneExplicitMemoryForgetBackups({
      root,
      clock: () => NOW,
      shouldContinue: () => !claimed || ++postClaimChecks === 1,
      hooks: {
        afterClaim: () => { claimed = true; },
      },
    });

    expect(result.prunedCount).toBe(0);
    expect(postClaimChecks).toBe(2);
    expect(existsSync(candidate)).toBe(true);
    expect((await readdir(dirname(candidate))).some((name) => name.startsWith("forget-retention-"))).toBe(false);
  });

  it("rediscovers and removes managed and operator claims left by an interrupted sweep", async () => {
    const root = await memoryFixture();
    const managed = await writeManaged(root, "5", 40, "applied");
    const operator = await writeOperator(root, "forget-interrupted", 40);

    const interrupted = await pruneExplicitMemoryForgetBackups({
      root,
      clock: () => NOW,
      hooks: {
        afterClaim: () => { throw new Error("simulated process interruption"); },
      },
    });

    expect(interrupted.prunedCount).toBe(0);
    expect(existsSync(managed)).toBe(false);
    expect(existsSync(operator)).toBe(false);
    expect((await readdir(dirname(root))).some((name) => /^\.memory-forget-backup-[a-f0-9]{24}\.tmp-/u.test(name))).toBe(true);
    expect((await readdir(dirname(operator))).some((name) => name.startsWith("forget-retention-"))).toBe(true);

    const recovered = await pruneExplicitMemoryForgetBackups({ root, clock: () => NOW });

    expect(recovered.prunedCount).toBe(2);
    expect((await readdir(dirname(root))).some((name) => /^\.memory-forget-backup-[a-f0-9]{24}\.tmp-/u.test(name))).toBe(false);
    expect((await readdir(dirname(operator))).some((name) => name.startsWith("forget-retention-"))).toBe(false);
  });

  it("does not assign the conventional operator namespace to a custom root", async () => {
    const root = await memoryFixture("custom-memory");
    const operator = await writeOperator(root, "forget-old", 40);

    const result = await pruneExplicitMemoryForgetBackups({ root, clock: () => NOW });

    expect(result.candidateCount).toBe(0);
    expect(existsSync(operator)).toBe(true);
  });
});

async function memoryFixture(rootName = "memory"): Promise<string> {
  const fixture = await mkdtemp(join(tmpdir(), "forget-backup-retention-"));
  roots.push(fixture);
  const state = join(fixture, ".mono-agent");
  const root = join(state, rootName);
  await mkdir(root, { recursive: true, mode: 0o700 });
  return root;
}

async function writeManaged(
  root: string,
  digit: string,
  ageDays: number,
  status: "prepared" | "applying" | "applied" | "recovered",
  rootFingerprint = createHash("sha256").update(realpathSync(root)).digest("hex"),
): Promise<string> {
  const planDigest = digit.repeat(64);
  const backup = join(dirname(root), `.${basename(root)}-forget-backup-${planDigest.slice(0, 24)}`);
  await mkdir(backup, { mode: 0o700 });
  await writeFile(join(backup, "manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    operation: "memory-forget-backup",
    status,
    rootFingerprint,
    sourceFingerprint: "1".repeat(64),
    treeFingerprint: "2".repeat(64),
    activeDbRelativePath: ".index/generations/current/memory.db",
    dimension: 768,
    planDigest,
    createdAt: new Date(NOW - ageDays * DAY_MS).toISOString(),
  })}\n`, { encoding: "utf8", mode: 0o600 });
  const timestamp = new Date(NOW - ageDays * DAY_MS);
  await utimes(backup, timestamp, timestamp);
  return backup;
}

async function writeOperator(root: string, name: string, ageDays: number): Promise<string> {
  const operator = join(dirname(root), "operator");
  await mkdir(operator, { recursive: true, mode: 0o755 });
  const backup = join(operator, name);
  await mkdir(backup, { mode: 0o755 });
  const timestamp = new Date(NOW - ageDays * DAY_MS);
  await utimes(backup, timestamp, timestamp);
  return backup;
}

async function writeStaging(root: string, digit: string, ageDays: number): Promise<string> {
  const backup = join(
    dirname(root),
    `.${basename(root)}-forget-backup-${digit.repeat(24)}.tmp-1-00000000-0000-4000-8000-000000000000`,
  );
  await mkdir(backup, { mode: 0o700 });
  const timestamp = new Date(NOW - ageDays * DAY_MS);
  await utimes(backup, timestamp, timestamp);
  return backup;
}
