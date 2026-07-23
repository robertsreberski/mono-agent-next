import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { ServiceMacosDriftError } from "./errors.js";
import type { ServiceMacosTarget } from "./plist.js";
import type { ServiceFileObservation } from "./reconciler.js";
import {
  isSimulatedServiceMacosCrash,
  runServiceMacosTransactionTestHook,
} from "./transaction-test-hooks.js";
const TRANSACTION_SCHEMA_VERSION = 1;
const TRANSACTION_DIRECTORY_SUFFIX = ".mono-agent-transaction";
const TRANSACTION_MAX_BYTES = 65_536;
type TransactionOperation = "apply" | "remove";
type TransactionPhase = "prepared" | "prior-quarantined" | "desired-linked" | "desired-published" | "committed";
interface TransactionJournal {
  readonly schemaVersion: 1; readonly transactionId: string; readonly serviceId: string;
  readonly operation: TransactionOperation; readonly phase: TransactionPhase;
  readonly expectedFile: ServiceFileObservation; readonly expectedLoaded: boolean;
  readonly desired?: {
    readonly digest: string; readonly bytes: number; readonly readinessToken: string;
  };
  readonly published?: ServiceFileObservation;
}
interface TransactionPaths {
  readonly root: string; readonly lock: string; readonly journal: string; readonly nextJournal: string;
  readonly previousJournal: string; readonly prior: string; readonly desired: string;
  readonly displaced: string; readonly parent: string;
}
interface TransactionGuard {
  readonly parent: string; readonly expectedUid: number; readonly expectedIdentity: string;
  root: { readonly path: string; readonly identity: string } | undefined;
}
const journalFiles = new WeakMap<TransactionJournal, ServiceFileObservation>();
export interface ServiceMacosTransactionLifecycle {
  readonly preflight: () => Promise<void>;
  readonly inspectLoaded: () => Promise<boolean>; readonly bootoutRequired: () => Promise<void>;
  readonly bootoutIfPresent: () => Promise<void>; readonly bootstrap: () => Promise<void>;
  readonly bootstrapRestored: () => Promise<void>;
  readonly proveReady: (readinessToken: string) => Promise<void>; readonly proveInstalledReady: () => Promise<void>;
}
export interface ReplaceServicePlistTransaction {
  readonly target: ServiceMacosTarget; readonly expectedUid: number; readonly expectedFile: ServiceFileObservation;
  readonly expectedLoaded: boolean; readonly desiredPlist: string; readonly desiredDigest: string;
  readonly readinessToken: string; readonly expectedParentIdentity: string;
  readonly lifecycle: ServiceMacosTransactionLifecycle;
}
export interface RemoveServicePlistTransaction {
  readonly target: ServiceMacosTarget; readonly expectedUid: number; readonly expectedFile: ServiceFileObservation;
  readonly expectedLoaded: boolean; readonly expectedParentIdentity: string;
  readonly lifecycle: ServiceMacosTransactionLifecycle;
}
class NoClobberOccupiedError extends ServiceMacosDriftError {}
export async function observeOwnerPrivatePlist(path: string, expectedUid: number, options: { readonly allowTwoLinks?: boolean } = {}): Promise<ServiceFileObservation> {
  let before;
  try {
    before = await lstat(path, { bigint: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) return Object.freeze({ exists: false });
    throw error;
  }
  const maximumLinks = options.allowTwoLinks === true ? 2n : 1n;
  assertOwnerPrivateStats(path, before, expectedUid, maximumLinks);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    assertOwnerPrivateStats(path, opened, expectedUid, maximumLinks);
    assertSameIdentity(path, before, opened);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    assertOwnerPrivateStats(path, after, expectedUid, maximumLinks);
    assertSameIdentity(path, opened, after);
    if (after.size !== BigInt(bytes.byteLength)) throw new Error(`${path} changed size while it was read.`);
    const finalPath = await lstat(path, { bigint: true }); assertOwnerPrivateStats(path, finalPath, expectedUid, maximumLinks); assertSameIdentity(path, after, finalPath);
    return Object.freeze({
      exists: true, digest: digest(bytes), bytes: bytes.byteLength,
      identity: Object.freeze({
        device: after.dev.toString(), inode: after.ino.toString(), ctimeNanoseconds: after.ctimeNs.toString(),
        uid: Number(after.uid), mode: Number(after.mode & 0o777n),
        links: Number(after.nlink), size: Number(after.size),
      }),
    });
  } finally {
    await handle.close();
  }
}
export async function assertNoPendingServiceMacosTransaction(
  target: ServiceMacosTarget, expectedUid: number, expectedParentIdentity: string,
): Promise<void> {
  const paths = transactionPaths(target);
  const guard = transactionGuard(paths, expectedUid, expectedParentIdentity);
  await assertTransactionParent(guard);
  if (await pathExists(paths.root) || await pathExists(paths.lock)) {
    if (await pathExists(paths.root)) await assertOwnedTransactionDirectory(paths.root, expectedUid);
    if (await pathExists(paths.lock)) await observeOwnerPrivatePlist(paths.lock, expectedUid, { allowTwoLinks: true });
    throw new ServiceMacosDriftError(`Unresolved service transaction exists for ${target.serviceId}; rerun apply or remove with explicit mutation authorization to recover it.`);
  }
  await assertTransactionParent(guard);
}
export async function recoverPendingServiceMacosTransaction(
  target: ServiceMacosTarget, expectedUid: number, expectedParentIdentity: string,
  lifecycle: ServiceMacosTransactionLifecycle,
): Promise<void> {
  const paths = transactionPaths(target);
  const guard = transactionGuard(paths, expectedUid, expectedParentIdentity);
  await assertTransactionParent(guard);
  if (!await pathExists(paths.root) && !await pathExists(paths.lock)) {
    await assertTransactionParent(guard);
    return;
  }
  const release = await acquireTransactionLock(paths, guard);
  try {
    if (!await pathExists(paths.root)) return;
    await assertOwnedTransactionDirectory(paths.root, expectedUid);
    await bindTransactionRoot(guard, paths.root);
    if ((await readdir(paths.root)).length === 0) {
      await mutateWithStableParent(guard, async () => await rmdir(paths.root), true);
      await fsyncDirectory(paths.parent);
      return;
    }
    const journal = await readRecoverableJournal(paths, target, guard);
    if (journal.phase === "committed") {
      try {
        await finishCommittedTransaction(paths, journal, guard, lifecycle);
      } catch (error) {
        try {
          await rollbackTransaction(paths, journal, target, guard, lifecycle);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `Committed transaction cleanup and rollback both failed for ${target.serviceId}.`,
          );
        }
        throw error;
      }
      return;
    }
    await rollbackTransaction(paths, journal, target, guard, lifecycle);
  } finally {
    await release();
  }
}
export async function replaceServicePlistTransaction(input: ReplaceServicePlistTransaction): Promise<void> {
  const paths = transactionPaths(input.target);
  const guard = transactionGuard(paths, input.expectedUid, input.expectedParentIdentity);
  const release = await acquireTransactionLock(paths, guard);
  let journal: TransactionJournal | undefined;
  try {
    if (await pathExists(paths.root)) {
      throw new ServiceMacosDriftError(`Unresolved service transaction exists for ${input.target.serviceId}.`);
    }
    journal = await createTransaction(paths, {
      schemaVersion: TRANSACTION_SCHEMA_VERSION,
      transactionId: randomUUID(),
      serviceId: input.target.serviceId,
      operation: "apply",
      phase: "prepared",
      expectedFile: input.expectedFile,
      expectedLoaded: input.expectedLoaded,
      desired: Object.freeze({
        digest: input.desiredDigest,
        bytes: Buffer.byteLength(input.desiredPlist),
        readinessToken: input.readinessToken,
      }),
    }, guard);
    await runServiceMacosTransactionTestHook("after-journal-prepared");
    await writeDesiredStage(paths, input.desiredPlist, journal.desired!, guard);
    if (input.expectedFile.exists) {
      journal = await quarantineExpectedPrior(paths, journal, input.target, guard);
    }
    journal = await publishDesired(paths, journal, input.target, guard);
    if (input.expectedLoaded) await input.lifecycle.bootoutRequired();
    await input.lifecycle.bootstrap();
    const activated = await observeOwnerPrivatePlist(input.target.plistPath, input.expectedUid);
    if (!isKnownDesired(journal, activated, Object.freeze({ exists: false }))) {
      throw new ServiceMacosDriftError(
        `Activation did not retain the published plist for ${input.target.serviceId}.`,
      );
    }
    await input.lifecycle.proveReady(input.readinessToken);
    journal = await updateJournal(paths, journal, Object.freeze({ ...journal, phase: "committed" }), guard);
    await runServiceMacosTransactionTestHook("after-transaction-committed");
    await finishCommittedTransaction(paths, journal, guard, input.lifecycle);
  } catch (error) {
    if (isSimulatedServiceMacosCrash(error)) throw error;
    const rollbackFailures: unknown[] = [];
    if (journal !== undefined && await pathExists(paths.root)) {
      try {
        await runServiceMacosTransactionTestHook("before-rollback");
        await rollbackTransaction(
          paths,
          await readRecoverableJournal(paths, input.target, guard),
          input.target,
          guard,
          input.lifecycle,
        );
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
      }
    }
    if (rollbackFailures.length > 0) {
      throw new AggregateError(
        [error, ...rollbackFailures],
        `Activation and transaction rollback both failed for ${input.target.serviceId}.`,
      );
    }
    throw error;
  } finally {
    await release();
  }
}
export async function removeServicePlistTransaction(input: RemoveServicePlistTransaction): Promise<void> {
  const paths = transactionPaths(input.target);
  const guard = transactionGuard(paths, input.expectedUid, input.expectedParentIdentity);
  const release = await acquireTransactionLock(paths, guard);
  let journal: TransactionJournal | undefined;
  try {
    if (await pathExists(paths.root)) {
      throw new ServiceMacosDriftError(`Unresolved service transaction exists for ${input.target.serviceId}.`);
    }
    journal = await createTransaction(paths, {
      schemaVersion: TRANSACTION_SCHEMA_VERSION,
      transactionId: randomUUID(),
      serviceId: input.target.serviceId,
      operation: "remove",
      phase: "prepared",
      expectedFile: input.expectedFile,
      expectedLoaded: input.expectedLoaded,
    }, guard);
    await runServiceMacosTransactionTestHook("after-journal-prepared");
    if (input.expectedFile.exists) {
      journal = await quarantineExpectedPrior(paths, journal, input.target, guard);
    }
    if (input.expectedLoaded) await input.lifecycle.bootoutRequired();
    if (await input.lifecycle.inspectLoaded()) {
      throw new ServiceMacosDriftError(`launchd still reports ${input.target.serviceId} loaded after bootout.`);
    }
    const canonical = await observeOwnerPrivatePlist(input.target.plistPath, input.expectedUid);
    if (canonical.exists) {
      throw new ServiceMacosDriftError(
        `A concurrent plist appeared while removing ${input.target.serviceId}; it was preserved.`,
      );
    }
    journal = await updateJournal(paths, journal, Object.freeze({ ...journal, phase: "committed" }), guard);
    await runServiceMacosTransactionTestHook("after-transaction-committed");
    await finishCommittedTransaction(paths, journal, guard, input.lifecycle);
  } catch (error) {
    if (isSimulatedServiceMacosCrash(error)) throw error;
    const rollbackFailures: unknown[] = [];
    if (journal !== undefined && await pathExists(paths.root)) {
      try {
        await runServiceMacosTransactionTestHook("before-rollback");
        await rollbackTransaction(
          paths,
          await readRecoverableJournal(paths, input.target, guard),
          input.target,
          guard,
          input.lifecycle,
        );
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
      }
    }
    if (rollbackFailures.length > 0) {
      throw new AggregateError(
        [error, ...rollbackFailures],
        `Removal and transaction rollback both failed for ${input.target.serviceId}.`,
      );
    }
    throw error;
  } finally {
    await release();
  }
}
async function createTransaction(
  paths: TransactionPaths, journal: TransactionJournal, guard: TransactionGuard,
): Promise<TransactionJournal> {
  const expectedUid = guard.expectedUid;
  await mutateWithStableParent(guard, async () => await mkdir(paths.root, { mode: 0o700 }));
  await assertOwnedTransactionDirectory(paths.root, expectedUid);
  await bindTransactionRoot(guard, paths.root);
  await fsyncDirectory(paths.parent);
  await writeExclusiveFile(paths.journal, `${JSON.stringify(journal)}\n`, guard);
  await fsyncDirectory(paths.root);
  journalFiles.set(journal, await observeOwnerPrivatePlist(paths.journal, expectedUid));
  return Object.freeze(journal);
}
async function writeDesiredStage(
  paths: TransactionPaths, value: string, expected: NonNullable<TransactionJournal["desired"]>, guard: TransactionGuard,
): Promise<void> {
  await writeExclusiveFile(paths.desired, value, guard);
  const observed = await observeOwnerPrivatePlist(paths.desired, guard.expectedUid);
  if (!matchesDesired(expected, observed)) {
    throw new ServiceMacosDriftError("The staged service plist did not match its journaled digest.");
  }
  await fsyncDirectory(paths.root);
}
async function quarantineExpectedPrior(
  paths: TransactionPaths, journal: TransactionJournal, target: ServiceMacosTarget, guard: TransactionGuard,
): Promise<TransactionJournal> {
  const expectedUid = guard.expectedUid;
  try {
    await mutateWithStableParent(guard, async () => await rename(target.plistPath, paths.prior));
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      throw new ServiceMacosDriftError(`Managed plist disappeared before mutation for ${target.serviceId}.`);
    }
    throw error;
  }
  await fsyncDirectory(paths.parent);
  await fsyncDirectory(paths.root);
  const quarantined = await observeOwnerPrivatePlist(paths.prior, expectedUid);
  if (!sameRenamedFile(journal.expectedFile, quarantined)) {
    const restored = await restoreNoClobber(paths.prior, target.plistPath, quarantined, guard);
    if (restored) {
      await discardPreparedTransaction(paths, journal, guard);
    }
    throw new ServiceMacosDriftError(
      `The plist moved to quarantine was not the fingerprinted inode for ${target.serviceId}; concurrent bytes were preserved.`,
    );
  }
  const next = await updateJournal(
    paths, journal, Object.freeze({ ...journal, phase: "prior-quarantined" }), guard,
  );
  await runServiceMacosTransactionTestHook("after-prior-quarantined");
  return next;
}
async function publishDesired(
  paths: TransactionPaths, journal: TransactionJournal, target: ServiceMacosTarget, guard: TransactionGuard,
): Promise<TransactionJournal> {
  const expectedUid = guard.expectedUid;
  const stagedBefore = await observeOwnerPrivatePlist(paths.desired, expectedUid);
  if (journal.desired === undefined || !matchesDesired(journal.desired, stagedBefore)) {
    throw new ServiceMacosDriftError(`Desired transaction artifact changed for ${target.serviceId}.`);
  }
  try {
    await mutateWithStableParent(guard, async () => await link(paths.desired, target.plistPath));
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      if (!journal.expectedFile.exists && journal.phase === "prepared") {
        await discardPreparedTransaction(paths, journal, guard);
      }
      throw new NoClobberOccupiedError(
        `A concurrent plist appeared before publishing ${target.serviceId}; it was not overwritten.`,
      );
    }
    throw error;
  }
  await fsyncDirectory(paths.parent);
  const stagedLinked = await observeOwnerPrivatePlist(paths.desired, expectedUid, { allowTwoLinks: true });
  const canonicalLinked = await observeOwnerPrivatePlist(target.plistPath, expectedUid, { allowTwoLinks: true });
  if (
    !matchesDesired(journal.desired, stagedLinked)
    || !sameFileObject(stagedLinked, canonicalLinked)
    || stagedLinked.identity?.links !== 2
    || canonicalLinked.identity?.links !== 2
  ) {
    throw new ServiceMacosDriftError(`Desired plist publication identity changed for ${target.serviceId}.`);
  }
  let next = await updateJournal(paths, journal, Object.freeze({
    ...journal,
    phase: "desired-linked",
    published: canonicalLinked,
  }), guard);
  await runServiceMacosTransactionTestHook("after-desired-linked");
  await unlinkInternal(paths.desired, stagedLinked, guard, true);
  await fsyncDirectory(paths.root);
  await fsyncDirectory(paths.parent);
  const canonical = await observeOwnerPrivatePlist(target.plistPath, expectedUid);
  if (!matchesDesired(journal.desired, canonical) || !sameFileObject(canonicalLinked, canonical)) {
    throw new ServiceMacosDriftError(`Published plist changed before activation for ${target.serviceId}.`);
  }
  next = await updateJournal(paths, next, Object.freeze({
    ...next,
    phase: "desired-published",
    published: canonical,
  }), guard);
  await runServiceMacosTransactionTestHook("after-desired-published");
  return next;
}
async function rollbackTransaction(
  paths: TransactionPaths, journal: TransactionJournal, target: ServiceMacosTarget,
  guard: TransactionGuard, lifecycle: ServiceMacosTransactionLifecycle,
): Promise<void> {
  const expectedUid = guard.expectedUid;
  const prior = await observeOwnerPrivatePlist(paths.prior, expectedUid, { allowTwoLinks: true });
  const desiredStage = await observeOwnerPrivatePlist(paths.desired, expectedUid, { allowTwoLinks: true });
  let canonical = await observeOwnerPrivatePlist(target.plistPath, expectedUid, { allowTwoLinks: true });
  let displaced = await observeOwnerPrivatePlist(paths.displaced, expectedUid, { allowTwoLinks: true });
  const priorIsPartiallyRestored = prior.exists
    && canonical.exists
    && prior.identity?.links === 2
    && canonical.identity?.links === 2
    && sameFileObject(journal.expectedFile, prior)
    && sameFileObject(prior, canonical);
  if (prior.exists && !sameRenamedFile(journal.expectedFile, prior) && !priorIsPartiallyRestored) {
    throw new ServiceMacosDriftError(
      `Quarantined prior plist for ${target.serviceId} no longer matches the fingerprinted inode; all artifacts were retained.`,
    );
  }
  if (displaced.exists && !isKnownDesired(journal, displaced, desiredStage)) {
    throw new ServiceMacosDriftError(
      `Rollback quarantine for ${target.serviceId} contains unknown bytes; all artifacts were retained.`,
    );
  }
  const priorWasMoved = prior.exists;
  const canonicalIsPrior = journal.expectedFile.exists
    && canonical.exists
    && sameFileObject(journal.expectedFile, canonical);
  const canonicalIsDesired = canonical.exists && isKnownDesired(journal, canonical, desiredStage);
  if (!priorWasMoved) {
    if (journal.expectedFile.exists) {
      if (!canonicalIsPrior) {
        throw new ServiceMacosDriftError(
          `The fingerprinted prior plist for ${target.serviceId} cannot be recovered; unknown bytes were retained.`,
        );
      }
      await cleanupTransactionDirectory(paths, journal, guard);
      return;
    }
    if (!canonical.exists) {
      await cleanupTransactionDirectory(paths, journal, guard);
      return;
    }
    if (!canonicalIsDesired) {
      if (journal.phase === "prepared" && desiredStage.exists && desiredStage.identity?.links === 1) {
        await cleanupTransactionDirectory(paths, journal, guard);
        return;
      }
      throw new ServiceMacosDriftError(
        `Canonical plist for ${target.serviceId} is not the transaction-published inode; it was retained.`,
      );
    }
  }
  await lifecycle.bootoutIfPresent();

  if (canonical.exists && !canonicalIsPrior) {
    if (!canonicalIsDesired) {
      throw new ServiceMacosDriftError(
        `Canonical plist for ${target.serviceId} changed during rollback; it and the prior quarantine were retained.`,
      );
    }
    if (displaced.exists) {
      if (!sameFileObject(displaced, canonical)) {
        throw new ServiceMacosDriftError(
          `Rollback quarantine for ${target.serviceId} is occupied; all artifacts were retained.`,
        );
      }
    } else {
      await mutateWithStableParent(guard, async () => await rename(target.plistPath, paths.displaced));
      await fsyncDirectory(paths.parent);
      await fsyncDirectory(paths.root);
      displaced = await observeOwnerPrivatePlist(paths.displaced, expectedUid, { allowTwoLinks: true });
      if (!sameRenamedFile(canonical, displaced)) {
        const restored = await restoreNoClobber(paths.displaced, target.plistPath, displaced, guard);
        throw new ServiceMacosDriftError(
          `A concurrent plist raced rollback for ${target.serviceId}; moved bytes were ${restored ? "restored" : "retained in quarantine"}.`,
        );
      }
      canonical = Object.freeze({ exists: false });
    }
  }
  if (journal.expectedFile.exists) {
    const refreshedPrior = await observeOwnerPrivatePlist(paths.prior, expectedUid, { allowTwoLinks: true });
    if (!refreshedPrior.exists || !sameFileObject(journal.expectedFile, refreshedPrior)) {
      throw new ServiceMacosDriftError(`Prior plist recovery artifact changed for ${target.serviceId}.`);
    }
    const current = await observeOwnerPrivatePlist(target.plistPath, expectedUid, { allowTwoLinks: true });
    if (!current.exists) {
      const restored = await restoreNoClobber(paths.prior, target.plistPath, refreshedPrior, guard);
      if (!restored) {
        throw new ServiceMacosDriftError(
          `Canonical plist for ${target.serviceId} became occupied during restore; both files were preserved.`,
        );
      }
    } else if (!sameFileObject(journal.expectedFile, current)) {
      throw new ServiceMacosDriftError(
        `Canonical plist for ${target.serviceId} is occupied during restore; both files were preserved.`,
      );
    } else if (refreshedPrior.exists) {
      await unlinkInternal(paths.prior, refreshedPrior, guard, true);
    }
    const restoredCanonical = await observeOwnerPrivatePlist(target.plistPath, expectedUid);
    if (!sameFileObject(journal.expectedFile, restoredCanonical)) {
      throw new ServiceMacosDriftError(`Restored plist identity proof failed for ${target.serviceId}.`);
    }
    if (journal.expectedLoaded) {
      await lifecycle.bootstrapRestored();
      await lifecycle.proveInstalledReady();
    }
    const verifiedCanonical = await observeOwnerPrivatePlist(target.plistPath, expectedUid);
    if (!sameExactFile(restoredCanonical, verifiedCanonical)) {
      throw new ServiceMacosDriftError(
        `Restored plist changed before rollback cleanup for ${target.serviceId}; recovery artifacts were retained.`,
      );
    }
  } else {
    const verifiedAbsent = await observeOwnerPrivatePlist(target.plistPath, expectedUid);
    if (verifiedAbsent.exists) {
      throw new ServiceMacosDriftError(
        `A concurrent plist appeared before rollback cleanup for ${target.serviceId}; recovery artifacts were retained.`,
      );
    }
  }
  await cleanupTransactionDirectory(paths, journal, guard);
}
async function finishCommittedTransaction(
  paths: TransactionPaths,
  journal: TransactionJournal,
  guard: TransactionGuard,
  lifecycle: ServiceMacosTransactionLifecycle,
): Promise<void> {
  const expectedUid = guard.expectedUid;
  const targetPath = join(paths.parent, `${journalTargetLabel(journal)}.plist`);
  const canonical = await observeOwnerPrivatePlist(targetPath, expectedUid, { allowTwoLinks: true });
  if (journal.operation === "apply") {
    const desiredStage = await observeOwnerPrivatePlist(paths.desired, expectedUid, { allowTwoLinks: true });
    if (
      !canonical.exists
      || !isKnownDesired(journal, canonical, desiredStage)
      || journal.desired === undefined
    ) {
      throw new ServiceMacosDriftError(
        `Committed service ${journal.serviceId} changed or unloaded before transaction cleanup; recovery artifacts were retained.`,
      );
    }
    await lifecycle.proveReady(journal.desired.readinessToken);
    const verifiedCanonical = await observeOwnerPrivatePlist(targetPath, expectedUid, { allowTwoLinks: true });
    if (!sameExactFile(canonical, verifiedCanonical)) {
      throw new ServiceMacosDriftError(
        `Committed service ${journal.serviceId} changed during readiness proof; recovery artifacts were retained.`,
      );
    }
  } else {
    if (canonical.exists) {
      throw new ServiceMacosDriftError(
        `A concurrent plist appeared after removing ${journal.serviceId}; it and the planned quarantine were retained.`,
      );
    }
    if (await lifecycle.inspectLoaded()) {
      await lifecycle.bootoutIfPresent();
      if (await lifecycle.inspectLoaded()) {
        throw new ServiceMacosDriftError(`launchd resurrected ${journal.serviceId} during committed removal cleanup.`);
      }
    }
    const verifiedAbsent = await observeOwnerPrivatePlist(targetPath, expectedUid);
    if (verifiedAbsent.exists) {
      throw new ServiceMacosDriftError(
        `A concurrent plist appeared before committed removal cleanup for ${journal.serviceId}; recovery artifacts were retained.`,
      );
    }
  }
  await cleanupTransactionDirectory(paths, journal, guard);
}
async function discardPreparedTransaction(
  paths: TransactionPaths,
  journal: TransactionJournal,
  guard: TransactionGuard,
): Promise<void> {
  const expectedUid = guard.expectedUid;
  const prior = await observeOwnerPrivatePlist(paths.prior, expectedUid);
  const displaced = await observeOwnerPrivatePlist(paths.displaced, expectedUid);
  if (prior.exists || displaced.exists) {
    throw new ServiceMacosDriftError(`Cannot discard a service transaction that owns quarantined files.`);
  }
  await cleanupTransactionDirectory(paths, journal, guard);
}
async function cleanupTransactionDirectory(
  paths: TransactionPaths, journal: TransactionJournal, guard: TransactionGuard,
): Promise<void> {
  const expectedUid = guard.expectedUid;
  const prior = await observeOwnerPrivatePlist(paths.prior, expectedUid, { allowTwoLinks: true });
  const desired = await observeOwnerPrivatePlist(paths.desired, expectedUid, { allowTwoLinks: true });
  const displaced = await observeOwnerPrivatePlist(paths.displaced, expectedUid, { allowTwoLinks: true });
  const journalFile = await observeOwnerPrivatePlist(paths.journal, expectedUid);
  const names = (await readdir(paths.root)).sort();
  const expectedNames = [
    "journal.json",
    ...(prior.exists ? ["prior.plist"] : []),
    ...(desired.exists ? ["desired.plist"] : []),
    ...(displaced.exists ? ["displaced.plist"] : []),
  ].sort();
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
    throw new ServiceMacosDriftError(
      `Transaction directory for ${journal.serviceId} contains missing or unknown artifacts: ${names.join(", ")}.`,
    );
  }
  if (prior.exists && !sameRenamedFile(journal.expectedFile, prior)) {
    throw new ServiceMacosDriftError(`Refusing to delete an unknown prior transaction artifact for ${journal.serviceId}.`);
  }
  if (desired.exists && (journal.desired === undefined || !matchesDesired(journal.desired, desired))) {
    throw new ServiceMacosDriftError(`Refusing to delete an unknown desired transaction artifact for ${journal.serviceId}.`);
  }
  if (displaced.exists && !isKnownDesired(journal, displaced, desired)) {
    throw new ServiceMacosDriftError(`Refusing to delete an unknown rollback artifact for ${journal.serviceId}.`);
  }
  if (!sameExactFile(requireJournalFile(journal), journalFile)) {
    throw new ServiceMacosDriftError(`Refusing cleanup after journal identity drift for ${journal.serviceId}.`);
  }
  if (desired.exists) await unlinkInternal(paths.desired, desired, guard, true);
  if (displaced.exists) {
    const refreshed = await observeOwnerPrivatePlist(paths.displaced, expectedUid, { allowTwoLinks: true });
    if (!sameFileObject(displaced, refreshed)) {
      throw new ServiceMacosDriftError(`Rollback artifact changed during cleanup for ${journal.serviceId}.`);
    }
    await unlinkInternal(paths.displaced, refreshed, guard, true);
  }
  if (prior.exists) await unlinkInternal(paths.prior, prior, guard, true);
  await unlinkInternal(paths.journal, journalFile, guard, false);
  await fsyncDirectory(paths.root);
  await mutateWithStableParent(guard, async () => await rmdir(paths.root), true);
  await fsyncDirectory(paths.parent);
}
async function restoreNoClobber(
  source: string, target: string, sourceObservation: ServiceFileObservation, guard: TransactionGuard,
): Promise<boolean> {
  return await moveNoClobber(source, target, sourceObservation, guard, true) !== undefined;
}
async function moveNoClobber(
  source: string, target: string, sourceObservation: ServiceFileObservation,
  guard: TransactionGuard, runRestoreHook = false,
): Promise<ServiceFileObservation | undefined> {
  const expectedUid = guard.expectedUid;
  try {
    await mutateWithStableParent(guard, async () => await link(source, target));
  } catch (error) {
    if (isErrno(error, "EEXIST")) return undefined;
    throw error;
  }
  await fsyncDirectory(dirname(target));
  const sourceLinked = await observeOwnerPrivatePlist(source, expectedUid, { allowTwoLinks: true });
  const targetLinked = await observeOwnerPrivatePlist(target, expectedUid, { allowTwoLinks: true });
  if (
    !sameFileObject(sourceObservation, sourceLinked)
    || !sameFileObject(sourceLinked, targetLinked)
    || sourceLinked.identity?.links !== 2
    || targetLinked.identity?.links !== 2
  ) {
    throw new ServiceMacosDriftError(`No-clobber move identity proof failed for ${target}.`);
  }
  if (runRestoreHook) await runServiceMacosTransactionTestHook("after-restore-linked");
  await unlinkInternal(source, sourceLinked, guard, true);
  await fsyncDirectory(dirname(source));
  await fsyncDirectory(dirname(target));
  const moved = await observeOwnerPrivatePlist(target, expectedUid);
  if (!sameFileObject(sourceObservation, moved)) {
    throw new ServiceMacosDriftError(`No-clobber move final identity proof failed for ${target}.`);
  }
  return moved;
}
async function unlinkInternal(
  path: string, expected: ServiceFileObservation, guard: TransactionGuard, allowTwoLinks: boolean,
): Promise<void> {
  const expectedUid = guard.expectedUid;
  const current = await observeOwnerPrivatePlist(path, expectedUid, allowTwoLinks ? { allowTwoLinks: true } : {});
  if (!sameExactFile(expected, current)) {
    throw new ServiceMacosDriftError(`Refusing to delete transaction artifact whose identity changed: ${path}.`);
  }
  const quarantine = join(dirname(path), `.mono-agent-delete-${randomUUID()}`);
  await mutateWithStableParent(guard, async () => await rename(path, quarantine)); await fsyncDirectory(dirname(path));
  const moved = await observeOwnerPrivatePlist(quarantine, expectedUid, allowTwoLinks ? { allowTwoLinks: true } : {});
  if (!sameRenamedFile(current, moved)) {
    const restored = await restoreNoClobber(quarantine, path, moved, guard);
    throw new ServiceMacosDriftError(
      `Deletion target changed during quarantine for ${path}; moved bytes were ${restored ? "restored" : `retained at ${quarantine}`}.`,
    );
  }
  await mutateWithStableParent(guard, async () => await unlink(quarantine)); await fsyncDirectory(dirname(path));
}
async function updateJournal(
  paths: TransactionPaths, current: TransactionJournal, next: TransactionJournal, guard: TransactionGuard,
): Promise<TransactionJournal> {
  if (!isJournalSuccessor(current, next) || await pathExists(paths.previousJournal)) {
    throw new ServiceMacosDriftError(`Refusing an invalid or unresolved journal update for ${next.serviceId}.`);
  }
  const serialized = `${JSON.stringify(next)}\n`;
  await writeExclusiveFile(paths.nextJournal, serialized, guard);
  const staged = await observeOwnerPrivatePlist(paths.nextJournal, guard.expectedUid);
  if (staged.digest !== digest(serialized) || staged.bytes !== Buffer.byteLength(serialized)) {
    throw new ServiceMacosDriftError(`Staged journal bytes changed before publication for ${next.serviceId}.`);
  }
  journalFiles.set(next, staged);
  await fsyncDirectory(paths.root);
  return await completeJournalUpdate(paths, current, next, guard);
}
async function completeJournalUpdate(
  paths: TransactionPaths, current: TransactionJournal, next: TransactionJournal, guard: TransactionGuard,
): Promise<TransactionJournal> {
  if (!isJournalSuccessor(current, next)) {
    throw new ServiceMacosDriftError(`Journal successor validation failed for ${next.serviceId}.`);
  }
  const prior = await moveNoClobber(
    paths.journal, paths.previousJournal, requireJournalFile(current), guard,
  );
  if (prior === undefined) {
    throw new ServiceMacosDriftError(`Prior journal quarantine is occupied for ${next.serviceId}; all files were retained.`);
  }
  const published = await moveNoClobber(
    paths.nextJournal, paths.journal, requireJournalFile(next), guard,
  );
  if (published === undefined) {
    throw new ServiceMacosDriftError(`Journal publication is occupied for ${next.serviceId}; all files were retained.`);
  }
  journalFiles.set(next, published);
  const verified = await observeOwnerPrivatePlist(paths.journal, guard.expectedUid);
  if (!sameExactFile(published, verified)) {
    throw new ServiceMacosDriftError(`Published journal changed before prior cleanup for ${next.serviceId}.`);
  }
  await unlinkInternal(paths.previousJournal, prior, guard, false);
  await fsyncDirectory(paths.root);
  return next;
}
async function readRecoverableJournal(
  paths: TransactionPaths, target: ServiceMacosTarget, guard: TransactionGuard,
): Promise<TransactionJournal> {
  const expectedUid = guard.expectedUid;
  const hasPrevious = await pathExists(paths.previousJournal);
  const hasNext = await pathExists(paths.nextJournal);
  const hasCurrent = await pathExists(paths.journal);
  if (!hasPrevious && !hasNext) return await readJournalFile(paths.journal, target, expectedUid);
  if (!hasPrevious) {
    if (!hasCurrent || !hasNext) {
      throw new ServiceMacosDriftError(`Incomplete journal update for ${target.serviceId}; all files were retained.`);
    }
    const current = await readJournalFile(paths.journal, target, expectedUid, true);
    const next = await readJournalFile(paths.nextJournal, target, expectedUid, true);
    return await completeJournalUpdate(paths, current, next, guard);
  }
  let previous = await readJournalFile(paths.previousJournal, target, expectedUid, true);
  let current = hasCurrent ? await readJournalFile(paths.journal, target, expectedUid, true) : undefined;
  const next = hasNext ? await readJournalFile(paths.nextJournal, target, expectedUid, true) : undefined;
  if (current !== undefined && sameFileObject(requireJournalFile(previous), requireJournalFile(current))) {
    if (requireJournalFile(previous).identity?.links !== 2 || requireJournalFile(current).identity?.links !== 2) {
      throw new ServiceMacosDriftError(`Partially quarantined journal link count changed for ${target.serviceId}.`);
    }
    if (next === undefined) {
      await unlinkInternal(paths.previousJournal, requireJournalFile(previous), guard, true);
      return await readJournalFile(paths.journal, target, expectedUid);
    }
    if (!isJournalSuccessor(previous, next)) {
      throw new ServiceMacosDriftError(`Pending journal is not a valid successor for ${target.serviceId}.`);
    }
    await unlinkInternal(paths.journal, requireJournalFile(current), guard, true);
    previous = await readJournalFile(paths.previousJournal, target, expectedUid);
    current = undefined;
  }
  if (current !== undefined) {
    if (!isJournalSuccessor(previous, current)) {
      throw new ServiceMacosDriftError(`Published journal is not a valid successor for ${target.serviceId}.`);
    }
    if (next !== undefined) {
      const currentFile = requireJournalFile(current);
      const nextFile = requireJournalFile(next);
      if (!sameFileObject(currentFile, nextFile)
        || currentFile.identity?.links !== 2 || nextFile.identity?.links !== 2) {
        throw new ServiceMacosDriftError(`Partially published journal identity changed for ${target.serviceId}.`);
      }
      await unlinkInternal(paths.nextJournal, nextFile, guard, true);
      current = await readJournalFile(paths.journal, target, expectedUid);
    }
    const verified = await observeOwnerPrivatePlist(paths.journal, expectedUid);
    if (!sameExactFile(requireJournalFile(current), verified)) {
      throw new ServiceMacosDriftError(`Recovered journal changed before prior cleanup for ${target.serviceId}.`);
    }
    await unlinkInternal(paths.previousJournal, requireJournalFile(previous), guard, false);
    return current;
  }
  if (next !== undefined) {
    if (!isJournalSuccessor(previous, next)) {
      throw new ServiceMacosDriftError(`Pending journal is not a valid successor for ${target.serviceId}.`);
    }
    const published = await moveNoClobber(
      paths.nextJournal, paths.journal, requireJournalFile(next), guard,
    );
    if (published === undefined) {
      throw new ServiceMacosDriftError(`Journal recovery destination is occupied for ${target.serviceId}.`);
    }
    journalFiles.set(next, published);
    const verified = await observeOwnerPrivatePlist(paths.journal, expectedUid);
    if (!sameExactFile(published, verified)) {
      throw new ServiceMacosDriftError(`Recovered journal changed before prior cleanup for ${target.serviceId}.`);
    }
    await unlinkInternal(paths.previousJournal, requireJournalFile(previous), guard, false);
    return next;
  }
  const restored = await moveNoClobber(
    paths.previousJournal, paths.journal, requireJournalFile(previous), guard,
  );
  if (restored === undefined) {
    throw new ServiceMacosDriftError(`Journal rollback destination is occupied for ${target.serviceId}.`);
  }
  journalFiles.set(previous, restored);
  return previous;
}
async function readJournalFile(
  path: string, target: ServiceMacosTarget, expectedUid: number, allowTwoLinks = false,
): Promise<TransactionJournal> {
  const options = allowTwoLinks ? { allowTwoLinks: true } : {};
  const before = await observeOwnerPrivatePlist(path, expectedUid, options);
  if (!before.exists) throw new ServiceMacosDriftError(`Service transaction journal disappeared for ${target.serviceId}.`);
  const source = await readOwnerPrivateBounded(path, TRANSACTION_MAX_BYTES, expectedUid, allowTwoLinks);
  const after = await observeOwnerPrivatePlist(path, expectedUid, options);
  if (!sameExactFile(before, after) || digest(source) !== before.digest) {
    throw new ServiceMacosDriftError(`Service transaction journal changed while read for ${target.serviceId}.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(source.toString("utf8")) as unknown;
  } catch {
    throw new ServiceMacosDriftError(`Service transaction journal is corrupt for ${target.serviceId}; artifacts were retained.`);
  }
  if (!isRecord(value)) throw new ServiceMacosDriftError(`Invalid service transaction journal for ${target.serviceId}.`);
  const allowed = new Set([
    "schemaVersion", "transactionId", "serviceId", "operation", "phase",
    "expectedFile", "expectedLoaded", "desired", "published",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ServiceMacosDriftError(`Service transaction journal contains unknown fields for ${target.serviceId}.`);
  }
  if (
    value.schemaVersion !== TRANSACTION_SCHEMA_VERSION
    || typeof value.transactionId !== "string"
    || !/^[a-f0-9-]{36}$/u.test(value.transactionId)
    || value.serviceId !== target.serviceId
    || (value.operation !== "apply" && value.operation !== "remove")
    || !isTransactionPhase(value.phase)
    || typeof value.expectedLoaded !== "boolean"
    || !isFileObservation(value.expectedFile)
    || (value.desired !== undefined && !isDesiredDescriptor(value.desired))
    || (value.published !== undefined && !isFileObservation(value.published))
    || (value.operation === "apply" && !isDesiredDescriptor(value.desired))
    || (value.operation === "remove" && (value.desired !== undefined || value.published !== undefined))
  ) {
    throw new ServiceMacosDriftError(`Service transaction journal failed validation for ${target.serviceId}.`);
  }
  const journal = Object.freeze(value as unknown as TransactionJournal); journalFiles.set(journal, after);
  return journal;
}
async function acquireTransactionLock(paths: TransactionPaths, guard: TransactionGuard): Promise<() => Promise<void>> {
  const expectedUid = guard.expectedUid;
  for (;;) {
    const owner = Object.freeze({ schemaVersion: 1, pid: process.pid, token: randomUUID() });
    const temporary = `${paths.lock}.${owner.token}.tmp`;
    await writeExclusiveFile(temporary, `${JSON.stringify(owner)}\n`, guard);
    const temporaryObservation = await observeOwnerPrivatePlist(temporary, expectedUid);
    try {
      await mutateWithStableParent(guard, async () => await link(temporary, paths.lock));
      await fsyncDirectory(paths.parent);
      const linkedTemporary = await observeOwnerPrivatePlist(temporary, expectedUid, { allowTwoLinks: true });
      const linkedLock = await observeOwnerPrivatePlist(paths.lock, expectedUid, { allowTwoLinks: true });
      if (!sameFileObject(temporaryObservation, linkedTemporary) || !sameFileObject(linkedTemporary, linkedLock)) {
        throw new ServiceMacosDriftError(`Service transaction lock publication changed identity for ${paths.root}.`);
      }
      await unlinkInternal(temporary, linkedTemporary, guard, true);
      await fsyncDirectory(paths.parent);
      const acquiredLock = await observeOwnerPrivatePlist(paths.lock, expectedUid);
      return async () => {
        await assertTransactionParent(guard);
        const current = await readLockOwner(paths.lock, expectedUid);
        if (current.pid !== process.pid || current.token !== owner.token) {
          throw new ServiceMacosDriftError(`Service transaction lock ownership changed for ${paths.root}.`);
        }
        const released = `${paths.lock}.released-${owner.token}`;
        await mutateWithStableParent(guard, async () => await rename(paths.lock, released));
        await fsyncDirectory(paths.parent);
        const releasedObservation = await observeOwnerPrivatePlist(released, expectedUid, { allowTwoLinks: true });
        if (!sameRenamedFile(acquiredLock, releasedObservation)) {
          await restoreNoClobber(released, paths.lock, releasedObservation, guard);
          throw new ServiceMacosDriftError(`Service transaction lock changed before release for ${paths.root}.`);
        }
        await unlinkInternal(released, releasedObservation, guard, true);
        await fsyncDirectory(paths.parent);
      };
    } catch (error) {
      await unlinkInternal(temporary, temporaryObservation, guard, true).catch(() => undefined);
      if (!isErrno(error, "EEXIST")) throw error;
      const existing = await readLockOwner(paths.lock, expectedUid);
      if (processIsAlive(existing.pid)) {
        throw new ServiceMacosDriftError(`Another service-macos mutation is active for ${paths.root}.`);
      }
      await runServiceMacosTransactionTestHook("before-stale-lock-quarantine");
      const stale = `${paths.lock}.stale-${randomUUID()}`;
      await mutateWithStableParent(guard, async () => await rename(paths.lock, stale));
      await fsyncDirectory(paths.parent);
      const moved = await observeOwnerPrivatePlist(stale, expectedUid, { allowTwoLinks: true });
      if (!sameRenamedFile(existing.observation, moved)) {
        await restoreNoClobber(stale, paths.lock, moved, guard);
        throw new ServiceMacosDriftError(
          `Service transaction lock changed during stale-lock recovery for ${paths.root}.`,
        );
      }
      await unlinkInternal(stale, moved, guard, true);
      await fsyncDirectory(paths.parent);
    }
  }
}
async function readLockOwner(
  path: string,
  expectedUid: number,
): Promise<{
  readonly pid: number;
  readonly token: string;
  readonly observation: ServiceFileObservation;
}> {
  const before = await observeOwnerPrivatePlist(path, expectedUid, { allowTwoLinks: true });
  const source = await readOwnerPrivateBounded(path, 4_096, expectedUid, true);
  const after = await observeOwnerPrivatePlist(path, expectedUid, { allowTwoLinks: true });
  if (!sameExactFile(before, after) || digest(source) !== before.digest) {
    throw new ServiceMacosDriftError(`Transaction lock changed while it was read: ${path}.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(source.toString("utf8")) as unknown;
  } catch {
    throw new ServiceMacosDriftError(`Transaction lock owner record is corrupt: ${path}.`);
  }
  if (
    !isRecord(value)
    || value.schemaVersion !== 1
    || !Number.isSafeInteger(value.pid)
    || (value.pid as number) <= 0
    || typeof value.token !== "string"
    || !/^[a-f0-9-]{36}$/u.test(value.token)
  ) {
    throw new ServiceMacosDriftError(`Transaction lock owner record is invalid: ${path}.`);
  }
  return { pid: value.pid as number, token: value.token, observation: after };
}
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
}
async function writeExclusiveFile(
  path: string, value: string | Uint8Array, guard: TransactionGuard,
): Promise<void> {
  await mutateWithStableParent(guard, async () => {
    const handle = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(value);
      await handle.sync();
    } finally {
      await handle.close();
    }
  });
}
async function readOwnerPrivateBounded(
  path: string, maximumBytes: number, expectedUid: number, allowTwoLinks = false,
): Promise<Buffer> {
  const before = await lstat(path, { bigint: true });
  if (
    !before.isFile() || before.isSymbolicLink() || before.uid !== BigInt(expectedUid)
    || (before.mode & 0o777n) !== 0o600n || before.nlink < 1n
    || before.nlink > (allowTwoLinks ? 2n : 1n)
    || before.size > BigInt(maximumBytes)
  ) {
    throw new ServiceMacosDriftError(`${path} must be an owner-private single-linked bounded file.`);
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    assertSameIdentity(path, before, opened);
    const source = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    assertSameIdentity(path, opened, after);
    if (source.byteLength > maximumBytes || after.size !== BigInt(source.byteLength)) {
      throw new ServiceMacosDriftError(`${path} changed or exceeded its byte limit while read.`);
    }
    return source;
  } finally {
    await handle.close();
  }
}
async function assertOwnedTransactionDirectory(path: string, expectedUid: number): Promise<void> {
  const stats = await lstat(path, { bigint: true });
  if (
    !stats.isDirectory() || stats.isSymbolicLink() || stats.uid !== BigInt(expectedUid)
    || (stats.mode & 0o777n) !== 0o700n
  ) {
    throw new ServiceMacosDriftError(`${path} must be an owner-private transaction directory (mode 0700).`);
  }
}
function transactionGuard(
  paths: TransactionPaths, expectedUid: number, expectedIdentity: string,
): TransactionGuard {
  return { parent: paths.parent, expectedUid, expectedIdentity, root: undefined };
}
async function bindTransactionRoot(guard: TransactionGuard, path: string): Promise<void> {
  guard.root = { path, identity: await protectedDirectoryIdentity(path, guard.expectedUid, true) };
}
async function assertTransactionParent(guard: TransactionGuard): Promise<void> {
  const parentIdentity = await protectedDirectoryIdentity(guard.parent, guard.expectedUid, false);
  if (parentIdentity !== guard.expectedIdentity) {
    throw new ServiceMacosDriftError(`Transaction parent directory changed identity: ${guard.parent}.`);
  }
  if (guard.root !== undefined) {
    const rootIdentity = await protectedDirectoryIdentity(guard.root.path, guard.expectedUid, true);
    if (rootIdentity !== guard.root.identity) {
      throw new ServiceMacosDriftError(`Transaction root directory changed identity: ${guard.root.path}.`);
    }
  }
}
async function protectedDirectoryIdentity(path: string, expectedUid: number, exactPrivate: boolean): Promise<string> {
  const stats = await lstat(path, { bigint: true });
  if (
    !stats.isDirectory() || stats.isSymbolicLink() || stats.uid !== BigInt(expectedUid)
    || (exactPrivate ? (stats.mode & 0o777n) !== 0o700n : (stats.mode & 0o022n) !== 0n)
  ) {
    throw new ServiceMacosDriftError(`Transaction directory is unsafe or changed: ${path}.`);
  }
  return [stats.dev, stats.ino, stats.uid, stats.mode & 0o777n].join(":");
}
async function mutateWithStableParent<T>(
  guard: TransactionGuard, operation: () => Promise<T>, rootMayDisappear = false,
): Promise<T> {
  await assertTransactionParent(guard);
  try {
    const result = await operation();
    if (rootMayDisappear) guard.root = undefined;
    return result;
  } finally {
    await assertTransactionParent(guard);
  }
}
async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
function transactionPaths(target: ServiceMacosTarget): TransactionPaths {
  const parent = dirname(target.plistPath);
  const root = join(parent, `.${target.label}${TRANSACTION_DIRECTORY_SUFFIX}`);
  const lock = `${root}.lock`;
  return Object.freeze({
    root, lock, journal: join(root, "journal.json"), nextJournal: join(root, "journal.next"),
    previousJournal: join(root, "journal.previous"),
    prior: join(root, "prior.plist"), desired: join(root, "desired.plist"),
    displaced: join(root, "displaced.plist"), parent,
  });
}
function journalTargetLabel(journal: TransactionJournal): string {
  return `ai.mono-agent.${journal.serviceId}`;
}
function sameExactFile(left: ServiceFileObservation, right: ServiceFileObservation): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function sameRenamedFile(left: ServiceFileObservation, right: ServiceFileObservation): boolean {
  return sameFileObject(left, right)
    && left.identity?.links === right.identity?.links;
}
function sameFileObject(left: ServiceFileObservation, right: ServiceFileObservation): boolean {
  return left.exists
    && right.exists
    && left.digest === right.digest
    && left.bytes === right.bytes
    && left.identity !== undefined
    && right.identity !== undefined
    && left.identity.device === right.identity.device
    && left.identity.inode === right.identity.inode
    && left.identity.uid === right.identity.uid
    && left.identity.mode === right.identity.mode
    && left.identity.size === right.identity.size;
}
function requireJournalFile(journal: TransactionJournal): ServiceFileObservation {
  const file = journalFiles.get(journal);
  if (file === undefined) throw new ServiceMacosDriftError(`Journal identity is unavailable for ${journal.serviceId}.`);
  return file;
}
function isJournalSuccessor(current: TransactionJournal, next: TransactionJournal): boolean {
  const validPhase = (current.phase === "prepared"
      && (next.phase === "prior-quarantined" || next.phase === "desired-linked" || next.phase === "committed"))
    || (current.phase === "prior-quarantined"
      && (next.phase === "desired-linked" || next.phase === "committed"))
    || (current.phase === "desired-linked" && next.phase === "desired-published")
    || (current.phase === "desired-published" && next.phase === "committed");
  return validPhase
    && current.schemaVersion === next.schemaVersion
    && current.transactionId === next.transactionId
    && current.serviceId === next.serviceId
    && current.operation === next.operation
    && current.expectedLoaded === next.expectedLoaded
    && sameExactFile(current.expectedFile, next.expectedFile)
    && JSON.stringify(current.desired) === JSON.stringify(next.desired);
}
function matchesDesired(desired: NonNullable<TransactionJournal["desired"]>, observation: ServiceFileObservation): boolean {
  return observation.exists
    && observation.digest === desired.digest
    && observation.bytes === desired.bytes
    && observation.identity !== undefined;
}
function isKnownDesired(
  journal: TransactionJournal, observation: ServiceFileObservation, stage: ServiceFileObservation,
): boolean {
  if (journal.desired === undefined || !matchesDesired(journal.desired, observation)) return false;
  if (journal.published !== undefined && sameFileObject(journal.published, observation)) return true;
  return stage.exists && sameFileObject(stage, observation);
}
function assertOwnerPrivateStats(path: string, stats: BigIntStats, expectedUid: number, maximumLinks: bigint): void {
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || stats.uid !== BigInt(expectedUid)
    || (stats.mode & 0o777n) !== 0o600n
    || stats.nlink < 1n
    || stats.nlink > maximumLinks
    || stats.size > 1_048_576n
  ) {
    throw new Error(
      `${path} must be an owner-private regular plist (mode 0600, uid ${String(expectedUid)}, bounded links and size).`,
    );
  }
}
function assertSameIdentity(path: string, left: BigIntStats, right: BigIntStats): void {
  if (
    left.dev !== right.dev
    || left.ino !== right.ino
    || left.ctimeNs !== right.ctimeNs
    || left.uid !== right.uid
    || left.mode !== right.mode
    || left.nlink !== right.nlink
    || left.size !== right.size
  ) {
    throw new Error(`${path} changed identity or metadata while it was opened.`);
  }
}
function isFileObservation(value: unknown): value is ServiceFileObservation {
  if (!isRecord(value) || typeof value.exists !== "boolean") return false;
  const keys = Object.keys(value);
  if (!value.exists) return keys.length === 1;
  if (
    keys.some((key) => !["exists", "digest", "bytes", "identity"].includes(key))
    || typeof value.digest !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.digest)
    || !Number.isSafeInteger(value.bytes)
    || (value.bytes as number) < 0
    || !isRecord(value.identity)
  ) return false;
  const identity = value.identity;
  return Object.keys(identity).every((key) =>
    ["device", "inode", "ctimeNanoseconds", "uid", "mode", "links", "size"].includes(key))
    && typeof identity.device === "string"
    && /^\d+$/u.test(identity.device)
    && typeof identity.inode === "string"
    && /^\d+$/u.test(identity.inode)
    && typeof identity.ctimeNanoseconds === "string"
    && /^\d+$/u.test(identity.ctimeNanoseconds)
    && Number.isSafeInteger(identity.uid)
    && Number.isSafeInteger(identity.mode)
    && Number.isSafeInteger(identity.links)
    && Number.isSafeInteger(identity.size);
}
function isDesiredDescriptor(value: unknown): value is NonNullable<TransactionJournal["desired"]> {
  return isRecord(value)
    && Object.keys(value).every((key) => key === "digest" || key === "bytes" || key === "readinessToken")
    && typeof value.digest === "string"
    && /^[a-f0-9]{64}$/u.test(value.digest)
    && Number.isSafeInteger(value.bytes)
    && (value.bytes as number) >= 0
    && typeof value.readinessToken === "string"
    && /^[a-f0-9]{64}$/u.test(value.readinessToken);
}
function isTransactionPhase(value: unknown): value is TransactionPhase {
  return value === "prepared"
    || value === "prior-quarantined"
    || value === "desired-linked"
    || value === "desired-published"
    || value === "committed";
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}
function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}
